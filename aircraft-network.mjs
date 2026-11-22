const updateInterval = 15_000;
const positionLifetime = 45_000;
const radiusNm = 80;
const radians = Math.PI / 180;

export function aircraftGeometry(centre, latitude, longitude) {
  if (!Number.isFinite(centre?.latitude) || !Number.isFinite(centre?.longitude)) return {};
  const from = centre.latitude * radians;
  const to = latitude * radians;
  const longitudeDelta = (longitude - centre.longitude) * radians;
  const haversine = Math.sin((to - from) / 2) ** 2 + Math.cos(from) * Math.cos(to) * Math.sin(longitudeDelta / 2) ** 2;
  const bearing = Math.atan2(Math.sin(longitudeDelta) * Math.cos(to),
    Math.cos(from) * Math.sin(to) - Math.sin(from) * Math.cos(to) * Math.cos(longitudeDelta));
  return { distanceKm: 12742 * Math.asin(Math.sqrt(Math.min(1, haversine))), bearing: (bearing / radians + 360) % 360 };
}

function position(record, centre, time) {
  const {hex, lat, lon, seen_pos: age, flight, alt_baro: altitude, alt_geom: geometricAltitude,
    track, nav_heading: navigationHeading, t: type, r: registration, category, gs: groundSpeed,
    baro_rate: barometricRate, geom_rate: geometricRate, squawk, emergency} = record ?? {};
  if (typeof hex !== 'string' || !/^~?[0-9a-f]{6}$/i.test(hex) ||
      !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180 ||
      (lat === 0 && lon === 0) || !Number.isFinite(age) || age < 0 || age * 1000 > positionLifetime) return null;
  const relative = aircraftGeometry(centre, lat, lon);
  if (relative.distanceKm > radiusNm * 1.852) return null;
  const text = (value, limit) => typeof value === 'string' && value.trim() ? value.trim().slice(0, limit) : undefined;
  const ident = text(flight, 12);
  const reg = text(registration, 12);
  const aircraftType = text(type, 12);
  const reportedAt = time - age * 1000;
  const rate = Number.isFinite(barometricRate) ? barometricRate : Number.isFinite(geometricRate) ? geometricRate : undefined;
  const code = typeof squawk === 'string' && /^[0-7]{4}$/.test(squawk) ? squawk :
    Number.isInteger(squawk) && squawk >= 0 && squawk <= 7777 ? String(squawk).padStart(4, '0') : undefined;
  return {
    hex:hex.toLowerCase(), lat, lon,
    title: ident || reg || hex.toUpperCase(), callsign:ident,
    tag: altitude === 'ground' ? 'GROUND' : Number.isFinite(altitude) ? altitude.toLocaleString('en-AU') + ' ft' : '',
    detail: [typeof type === 'string' && type.slice(0, 12), relative.distanceKm.toFixed(0) + ' km'].filter(Boolean).join(' · '),
    source:'adsb.lol', registration:reg, aircraftType, category:text(category, 12),
    onSurface:altitude === 'ground', alt:Number.isFinite(altitude) ? altitude : undefined,
    altGeom:Number.isFinite(geometricAltitude) ? geometricAltitude : undefined,
    heading: Number.isFinite(track) ? track : null,
    navigationHeading:Number.isFinite(navigationHeading) ? navigationHeading : undefined,
    speed:Number.isFinite(groundSpeed) && groundSpeed >= 0 ? groundSpeed : undefined,
    verticalRate:rate, squawk:code, emergency:text(emergency, 24), seen:age,
    reportedAt, position:reportedAt,
    ...relative,
  };
}

function retryTime(value, now) {
  if (value && /^\d+$/.test(value)) return now + Math.max(60_000, Number(value) * 1000);
  const date = Date.parse(value);
  if (date > now) return date;
  const tomorrow = new Date(now);
  return tomorrow.setUTCHours(24, 0, 0, 0);
}

export function createAircraftNetwork({request = fetch, now = Date.now, apiKey} = {}) {
  let current;
  let rateLimitedUntil = 0;

  async function update(entry) {
    entry.nextUpdate = now() + updateInterval;
    try {
      const headers = {Accept:'application/json'};
      if (apiKey) headers['x-api-key'] = apiKey;
      const {latitude, longitude} = entry.centre;
      const result = await request(`https://api.adsb.lol/v2/lat/${latitude}/lon/${longitude}/dist/${radiusNm}`, {
        headers, redirect:'error', signal:AbortSignal.timeout(5000),
      });
      if (result.status === 429) {
        rateLimitedUntil = retryTime(result.headers.get('retry-after'), now());
        return;
      }
      if (!result.ok) throw Error('Aircraft provider unavailable.');
      const data = await result.json();
      if (!Array.isArray(data.ac)) throw Error('Invalid aircraft data.');
      entry.updated = now();
      const positions = data.ac.map(record => position(record, entry.centre, entry.updated)).filter(Boolean);
      const unique = new Map();
      for (const aircraft of positions.sort((a,b) => a.reportedAt - b.reportedAt)) unique.set(aircraft.hex,aircraft);
      entry.aircraft = [...unique.values()].sort((a, b) => a.distanceKm - b.distanceKm).slice(0, 100);
      entry.unavailable = false;
    } catch {
      entry.unavailable = true;
    }
  }

  return async function load(centre) {
    if (!centre) return {status:'setup', aircraft:[]};
    const rounded = {latitude:Number(centre.latitude.toFixed(2)), longitude:Number(centre.longitude.toFixed(2))};
    const key = `${rounded.latitude}/${rounded.longitude}`;
    if (key !== current?.key) current = {key, centre:rounded, nextUpdate:0, aircraft:[], unavailable:false};
    const entry = current;
    if (!entry.pending && now() >= Math.max(rateLimitedUntil, entry.nextUpdate)) {
      entry.pending = update(entry).finally(() => { entry.pending = undefined; });
    }
    if (entry.pending) await entry.pending;
    const time = now();
    return {
      status: time < rateLimitedUntil ? 'rate-limited' : entry.unavailable ? 'unavailable' : 'live',
      updated: entry.updated == null ? null : new Date(entry.updated).toISOString(),
      centre: entry.centre,
      aircraft: entry.aircraft.filter(item => time - item.reportedAt <= positionLifetime),
    };
  };
}
