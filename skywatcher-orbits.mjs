import {eciToEcf, ecfToLookAngles, gstime, propagate, twoline2satrec} from './satellite-vendor.mjs';

export const weatherSatellites = [
  {id:57166, name:'Meteor-M N2-3', satdump:'M2-3', defaultFrequency:137900000,
    reference:'https://db.satnogs.org/satellite/57166/'},
  {id:59051, name:'Meteor-M N2-4', satdump:'M2-4', defaultFrequency:137100000,
    reference:'https://db.satnogs.org/satellite/59051/'},
];
export const lrptFrequencies = [137100000, 137900000, 137912500];
const hour = 3_600_000;
const day = 24 * hour;
const radians = Math.PI / 180;

export function parseWeatherElements(data, id, now) {
  const lines = data.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const line1 = lines.find(line => line.startsWith('1 ' + id + 'U '));
  const line2 = lines.find(line => line.startsWith('2 ' + id + ' '));
  if (line1?.length !== 69 || line2?.length !== 69) throw Error('No matching orbital elements.');
  const satrec = twoline2satrec(line1, line2);
  const epoch = (satrec.jdsatepoch - 2440587.5) * day;
  if (!Number.isFinite(epoch) || epoch > now + day || epoch < now - 14 * day) {
    throw Error('Orbital elements are too old or have an invalid epoch.');
  }
  return {satrec, epoch};
}

function observerFor(centre) {
  return {latitude:centre.latitude * radians, longitude:centre.longitude * radians, height:0};
}

function lookAt(satrec, observer, time) {
  const date = new Date(time);
  const state = propagate(satrec, date);
  if (!state?.position) return null;
  const look = ecfToLookAngles(observer, eciToEcf(state.position, gstime(date)));
  if (!Number.isFinite(look.elevation)) return null;
  return {az:look.azimuth / radians, el:look.elevation / radians, range:look.rangeSat};
}

export function predictWeatherPasses(satrec, centre, now, span = 36 * hour) {
  const observer = observerFor(centre);
  const look = time => lookAt(satrec, observer, time);
  const elevation = time => look(time)?.el ?? -90;
  function crossing(low, high, rising) {
    while (high - low > 1000) {
      const mid = Math.floor((low + high) / 2);
      if ((elevation(mid) >= 0) === rising) high = mid;
      else low = mid;
    }
    return high;
  }
  const passes = [];
  const step = 45_000;
  const begin = now - 25 * 60_000;
  let rise = null, peak = null, previous = -90;
  for (let t = begin; t <= now + span + 25 * 60_000; t += step) {
    const el = elevation(t);
    if (previous < 0 && el >= 0) {
      rise = crossing(t - step, t, true);
      peak = {t, el};
    }
    if (rise !== null && el > peak.el) peak = {t, el};
    if (previous >= 0 && el < 0 && rise !== null) {
      const set = crossing(t - step, t, false);
      if (set > now && rise <= now + span && peak.el >= 9) {
        for (let at = peak.t - step; at <= peak.t + step; at += 1000) {
          const height = elevation(at);
          if (height > peak.el) peak = {t:at, el:height};
        }
        if (peak.el >= 10) {
          const path = Array.from({length:25}, (_,i) => look(rise + (set - rise) * i / 24))
            .filter(Boolean).map(p => ({az:Math.round(p.az * 10) / 10, el:Math.max(0, Math.round(p.el * 10) / 10)}));
          passes.push({rise, set, peak:peak.t, maxElevation:Math.round(peak.el), path});
        }
      }
      rise = null;
    }
    previous = el;
  }
  return passes;
}

export function weatherLook(satrec, centre, time) {
  const observer = observerFor(centre);
  const point = lookAt(satrec, observer, time);
  const past = lookAt(satrec, observer, time - 1000);
  const future = lookAt(satrec, observer, time + 1000);
  if (!point || !past || !future) return null;
  return {az:Math.round(point.az) % 360, el:Math.round(point.el * 10) / 10,
    rangeKm:Math.round(point.range), dopplerHz:Math.round(-(future.range - past.range) / 2 * 137900000 / 299792.458)};
}

export function createWeatherPlanner({request = fetch, now = Date.now} = {}) {
  const elements = new Map();
  const predictions = new Map();
  async function update(satellite) {
    const time = now();
    let entry = elements.get(satellite.id);
    if (!entry) {
      entry = {next:0};
      elements.set(satellite.id, entry);
    }
    if (!entry.pending && time >= entry.next) {
      entry.pending = (async () => {
        try {
          const url = 'https://celestrak.org/NORAD/elements/gp.php?CATNR=' + satellite.id + '&FORMAT=TLE';
          const response = await request(url, {redirect:'error', signal:AbortSignal.timeout(5500)});
          if (!response.ok) throw Error('Orbit feed unavailable.');
          const data = await response.text();
          if (data.length > 4096) throw Error('Orbit feed returned unexpected data.');
          entry.orbit = parseWeatherElements(data, satellite.id, now());
          entry.next = now() + 2 * hour;
          entry.cached = false;
        } catch {
          entry.next = now() + 15 * 60_000;
          entry.cached = true;
        } finally {
          entry.pending = null;
        }
      })();
    }
    if (entry.pending) await entry.pending;
    return entry;
  }
  return async function plan(centre) {
    const time = now();
    const satellites = await Promise.all(weatherSatellites.map(async satellite => {
      if (!centre) return {...satellite, orbit:'setup', passes:[]};
      const {orbit, cached} = await update(satellite);
      if (!orbit || orbit.epoch < time - 14 * day) return {...satellite, orbit:'unavailable', passes:[]};
      const key = JSON.stringify([centre.latitude, centre.longitude, orbit.epoch]);
      let prediction = predictions.get(satellite.id);
      if (prediction?.key !== key || time - prediction.at > 15 * 60_000) {
        prediction = {key, at:time, passes:predictWeatherPasses(orbit.satrec, centre, time)};
        predictions.set(satellite.id, prediction);
      }
      return {...satellite, orbit:cached ? 'cached' : 'current', epoch:orbit.epoch,
        look:weatherLook(orbit.satrec, centre, time), passes:prediction.passes.filter(pass => pass.set > time)};
    }));
    return {centre, time, satellites};
  };
}
