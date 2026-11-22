const adsbdbOrigin = 'https://api.adsbdb.com';
const photoOrigin = 'https://api.planespotters.net';
const userAgent = 'OpenAir/1.0 (+https://github.com/norgan/open-air-sdr)';
const minute = 60_000;
const hour = 60 * minute;

export function normaliseAircraftIdentity(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('Enter an aircraft identity.');
  const hex = typeof input.hex === 'string' ? input.hex.trim().toLowerCase() : '';
  if (!/^[0-9a-f]{6}$/.test(hex)) throw new TypeError('Enter a six-character ICAO address.');
  const callsign = input.callsign == null ? '' : typeof input.callsign === 'string' ? input.callsign.trim().toUpperCase() : null;
  if (callsign === null || (callsign && !/^[A-Z0-9]{2,8}$/.test(callsign))) throw new TypeError('Enter a valid aircraft callsign.');
  return {hex, callsign};
}

function text(value, limit = 160) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, limit) : '';
}

function safePhotoURL(value, image) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
    if (image) {
      if (url.hostname !== 't.plnspttrs.net' || !/\.(?:jpe?g|png|webp)$/i.test(url.pathname)) return null;
    } else if (!['planespotters.net', 'www.planespotters.net'].includes(url.hostname) || !/^\/photo\/\d+(?:\/|$)/.test(url.pathname)) return null;
    return value;
  } catch { return null; }
}

function photoFrom(body) {
  if (!Array.isArray(body?.photos)) return null;
  for (const photo of body.photos) {
    const link = safePhotoURL(photo?.link, false);
    const photographer = text(photo?.photographer);
    if (!link || !photographer) continue;
    for (const thumbnail of [photo?.thumbnail_large, photo?.thumbnail]) {
      const url = safePhotoURL(thumbnail?.src, true);
      if (!url) continue;
      const size = thumbnail.size;
      return {url, link, photographer, source:'Planespotters.net',
        ...(Number.isInteger(size?.width) && size.width > 0 && size.width <= 2000 && {width:size.width}),
        ...(Number.isInteger(size?.height) && size.height > 0 && size.height <= 2000 && {height:size.height})};
    }
  }
  return null;
}

function emptyInfo(identity) {
  return {...identity, airline:'', flightNumber:'', registration:'', aircraftType:'',
    manufacturer:'', model:'', registeredOwner:'', metadataSource:'adsbdb', photo:null, identityStatus:'unavailable'};
}

function routeMatches(route, callsign) {
  return callsign && route && ['callsign', 'callsign_icao', 'callsign_iata']
    .some(key => text(route[key], 12).toUpperCase() === callsign);
}

function airlineName(airline) {
  return text(airline?.name);
}

// Static identity enrichment only: no provider position, altitude, speed or route is returned.
export function createAircraftInfo({request = fetch, now = Date.now, maxEntries = 256,
  concurrency = 2, queueLimit = 16, timeoutMs = 8000, successTtlMs = 6 * hour,
  missingTtlMs = 15 * minute, failureTtlMs = minute, photoTtlMs = 24 * hour} = {}) {
  const limit = Math.max(1, Math.min(256, Math.floor(maxEntries) || 256));
  const parallel = Math.max(1, Math.min(2, Math.floor(concurrency) || 2));
  const waitingLimit = Math.max(0, Math.min(16, Math.floor(queueLimit) || 0));
  const cache = new Map();
  const photos = new Map();
  const inFlight = new Map();
  const photoInFlight = new Map();
  const blockedUntil = new Map();
  const queue = [];
  let active = 0;

  function cached(store, key) {
    const entry = store.get(key);
    if (!entry) return null;
    if (entry.expires <= now()) { store.delete(key); return null; }
    store.delete(key);
    store.set(key, entry);
    return entry.value;
  }
  function remember(store, key, value, ttl) {
    store.delete(key);
    store.set(key, {value, expires:now() + Math.max(0, ttl)});
    while (store.size > limit) store.delete(store.keys().next().value);
    return value;
  }
  function schedule(action) {
    return new Promise((resolve, reject) => {
      const run = () => {
        active++;
        Promise.resolve().then(action).then(resolve, reject).finally(() => {
          active--;
          queue.shift()?.();
        });
      };
      if (active < parallel) run();
      else if (queue.length < waitingLimit) queue.push(run);
      else reject(new Error('Aircraft lookup queue is full.'));
    });
  }
  async function json(url) {
    const origin = new URL(url).origin;
    if ((blockedUntil.get(origin) || 0) > now()) return {status:'unavailable'};
    try {
      return await schedule(async () => {
        if ((blockedUntil.get(origin) || 0) > now()) return {status:'unavailable'};
        const response = await request(url, {redirect:'error', signal:AbortSignal.timeout(timeoutMs),
          headers:{Accept:'application/json', 'User-Agent':userAgent}});
        if (response.status === 429) {
          const retry = response.headers?.get?.('retry-after');
          const seconds = retry && /^\d+$/.test(retry) ? Number(retry) : Math.max(0, (Date.parse(retry) - now()) / 1000);
          blockedUntil.set(origin, now() + Math.min(15 * minute, Math.max(minute, Number.isFinite(seconds) ? seconds * 1000 : minute)));
          return {status:'unavailable'};
        }
        if (response.status === 404) return {status:'not-found'};
        if (!response.ok) return {status:'unavailable'};
        return {status:'ok', body:await response.json()};
      });
    } catch { return {status:'unavailable'}; }
  }
  function loadPhoto(hex) {
    const previous = cached(photos, hex);
    if (previous) return Promise.resolve(previous);
    if (photoInFlight.has(hex)) return photoInFlight.get(hex);
    const pending = json(photoOrigin + '/pub/photos/hex/' + hex).then(result => {
      const photo = result.status === 'ok' ? photoFrom(result.body) : null;
      const value = {photo, status:result.status};
      return remember(photos, hex, value, photo ? Math.min(photoTtlMs, 24 * hour) : result.status === 'unavailable' ? failureTtlMs : missingTtlMs);
    }).finally(() => photoInFlight.delete(hex));
    photoInFlight.set(hex, pending);
    return pending;
  }
  async function loadMetadata(identity) {
    const {hex, callsign} = identity;
    const results = [];
    const combined = await json(adsbdbOrigin + '/v0/aircraft/' + hex + (callsign ? '?callsign=' + encodeURIComponent(callsign) : ''));
    results.push(combined);
    let aircraft = combined.body?.response?.aircraft;
    let route = combined.body?.response?.flightroute;
    if (callsign && combined.status === 'not-found') {
      const fallback = await Promise.all([
        json(adsbdbOrigin + '/v0/aircraft/' + hex),
        json(adsbdbOrigin + '/v0/callsign/' + encodeURIComponent(callsign)),
      ]);
      results.push(...fallback);
      aircraft = fallback[0].body?.response?.aircraft;
      route = fallback[1].body?.response?.flightroute;
    }
    if (!aircraft || text(aircraft.mode_s).toLowerCase() !== hex) aircraft = null;
    if (!routeMatches(route, callsign)) route = null;
    let airline = route?.airline;
    if (!airlineName(airline)) {
      const prefix = callsign.match(/^[A-Z]{3}(?=\d)/)?.[0] || text(aircraft?.registered_owner_operator_flag_code).toUpperCase();
      if (/^[A-Z]{3}$/.test(prefix)) {
        const lookup = await json(adsbdbOrigin + '/v0/airline/' + prefix);
        results.push(lookup);
        airline = Array.isArray(lookup.body?.response) ? lookup.body.response.find(item => item?.icao === prefix) : null;
      }
    }
    const flightNumber = text(route?.callsign_iata, 12).toUpperCase();
    const flight = /^(?!\d{2})([A-Z0-9]{2})(\d{1,4})$/.exec(flightNumber);
    const iata = text(airline?.iata).toUpperCase();
    return {fields:{airline:airlineName(airline),
      flightNumber:flight && (!iata || flight[1] === iata) ? flightNumber : '',
      registration:text(aircraft?.registration, 16), aircraftType:text(aircraft?.icao_type, 12),
      manufacturer:text(aircraft?.manufacturer), model:text(aircraft?.type),
      registeredOwner:text(aircraft?.registered_owner)},
      failed:results.some(result => result.status === 'unavailable')};
  }

  return function aircraftInfo(input) {
    const identity = normaliseAircraftIdentity(input);
    const key = identity.hex + '/' + identity.callsign;
    const previous = cached(cache, key);
    if (previous) return Promise.resolve(structuredClone(previous));
    if (inFlight.has(key)) return inFlight.get(key).then(value => structuredClone(value));
    if (inFlight.size >= parallel + waitingLimit) return Promise.resolve(emptyInfo(identity));
    const pending = Promise.all([loadMetadata(identity), loadPhoto(identity.hex)]).then(([metadata, photo]) => {
      const result = {...emptyInfo(identity), ...metadata.fields, photo:photo.photo};
      const found = result.photo || Object.values(metadata.fields).some(Boolean);
      const failed = metadata.failed || photo.status === 'unavailable';
      result.identityStatus = found ? result.airline && result.flightNumber && result.photo ? 'ready' : 'partial' : failed ? 'unavailable' : 'not-found';
      const ttl = failed ? failureTtlMs : result.identityStatus === 'ready' ? successTtlMs : missingTtlMs;
      return remember(cache, key, result, ttl);
    }).catch(() => remember(cache, key, emptyInfo(identity), failureTtlMs)).finally(() => inFlight.delete(key));
    inFlight.set(key, pending);
    return pending.then(value => structuredClone(value));
  };
}
