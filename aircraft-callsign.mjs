// Common telephony designators from FAA JO 7340.2, chapter 3, section 3:
// https://www.faa.gov/air_traffic/publications/atpubs/cnt_html/chap3_section_3.html
const commonDesignators = new Map(Object.entries({
  ANZ:'New Zealand', CPA:'Cathay', CSN:'China Southern', JST:'Jetstar',
  QFA:'Qantas', QJE:'Kanga', QLK:'Q Link', QTR:'Qatari', SIA:'Singapore',
  UAE:'Emirates', VOZ:'Velocity', VRA:'Rapid',
}));

function flightIdentifier(callsign) {
  return typeof callsign === 'string' && /^([A-Z]{3})(\d[A-Z0-9]{0,3})$/.exec(callsign.trim().toUpperCase());
}

export function radioCallsign(aircraft) {
  const flight = flightIdentifier(aircraft.callsign);
  if (!flight) return '';
  const [, prefix, suffix] = flight;
  const common = commonDesignators.get(prefix);
  if (common) return `${common} ${suffix}`;
  return typeof aircraft.atcCallsign === 'string' && aircraft.atcCallsign.endsWith(' ' + suffix)
    ? aircraft.atcCallsign : '';
}

export function aircraftLabel(aircraft) {
  return radioCallsign(aircraft) || aircraft.callsign || aircraft.title || aircraft.registration ||
    aircraft.hex?.toUpperCase() || 'Aircraft';
}

function telephonyName(value) {
  const name = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  if (!/^[A-Za-z][A-Za-z0-9 '-]{1,31}$/.test(name) || /^(NONE|NULL|UNKNOWN|NIL)$/i.test(name)) return '';
  return name.toLowerCase().replace(/\b[a-z]/g, letter => letter.toUpperCase());
}

// The server learns the remaining operators by prefix, in the background.
// Position requests return immediately, even when the lookup service is down.
export function createCallsignLabels({request = fetch, now = Date.now} = {}) {
  const designators = new Map();
  const pending = new Set();
  let rateLimitedUntil = 0;

  async function load(prefix) {
    pending.add(prefix);
    let name = '';
    let ttl = 60_000;
    try {
      const response = await request('https://api.adsbdb.com/v0/airline/' + prefix, {
        redirect:'error', signal:AbortSignal.timeout(4000),
        headers:{Accept:'application/json'},
      });
      if (response.status === 429) {
        const retryAfter = response.headers.get('retry-after');
        const delay = /^\d+$/.test(retryAfter || '') ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - now();
        rateLimitedUntil = now() + Math.max(60_000, Math.min(delay || 0, 3_600_000));
      } else if (response.status === 404) {
        ttl = 900_000;
      } else if (response.ok) {
        const {response: airlines} = await response.json();
        const airline = Array.isArray(airlines) && airlines.find(item => item?.icao === prefix);
        name = telephonyName(airline?.callsign);
        ttl = name ? 86_400_000 : 900_000;
      }
    } catch {
      // Keep the received identifier and retry after the short cache expires.
    } finally {
      designators.set(prefix, {name, expires:now() + ttl});
      if (designators.size > 256) designators.delete(designators.keys().next().value);
      pending.delete(prefix);
    }
  }

  return function labelTracks(aircraft) {
    if (!Array.isArray(aircraft)) return aircraft;
    return aircraft.map(item => {
      const flight = flightIdentifier(item.callsign);
      if (!flight) return item;
      const [, prefix, suffix] = flight;
      const common = commonDesignators.get(prefix);
      if (common) return {...item, atcCallsign:`${common} ${suffix}`};
      const entry = designators.get(prefix);
      if (entry?.expires > now()) return entry.name ? {...item, atcCallsign:`${entry.name} ${suffix}`} : item;
      designators.delete(prefix);
      if (pending.size < 2 && !pending.has(prefix) && now() >= rateLimitedUntil) void load(prefix);
      return item;
    });
  };
}
