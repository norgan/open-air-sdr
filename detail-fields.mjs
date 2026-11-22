function finite(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function present(value) {
  return value !== undefined && value !== null && value !== '';
}

function field(label, value) {
  return present(value) ? {label, value:String(value)} : null;
}

function first(item, keys) {
  for (const key of keys) if (present(item[key])) return item[key];
  return null;
}

function isoTime(value) {
  if (!present(value)) return null;
  const instant = new Date(value);
  return Number.isFinite(instant.getTime()) ? instant.toISOString() : null;
}

function fixed(value, digits, suffix = '') {
  return finite(value) ? value.toFixed(digits) + suffix : null;
}

function measured(value, suffix) {
  return finite(value) ? value.toLocaleString('en-AU') + suffix : null;
}

export function aircraftDetailFields(item = {}) {
  const hex = /^[0-9a-f]{6}$/i.test(String(item.hex || '')) ? String(item.hex).toUpperCase() : null;
  const callsign = String(first(item,['callsign','flight','title']) || '').trim();
  const position = finite(item.lat) && finite(item.lon)
    ? `${item.lat.toFixed(6)}°, ${item.lon.toFixed(6)}°`
    : null;
  const speed = first(item,['groundSpeed','speed','gs']);
  const verticalRate = first(item,['verticalRate','baroRate']);
  const reportedAt = first(item,['reportedAt','position']);
  return [
    field('Callsign', callsign && callsign.toUpperCase() !== hex ? callsign : null),
    field('Airline', item.airline),
    field('Flight number', item.flightNumber),
    field('ICAO address', hex),
    field('Registration', item.registration),
    field('Aircraft type', first(item,['aircraftType','type'])),
    field('Model', item.model),
    field('Manufacturer', item.manufacturer),
    field('Registered owner', item.registeredOwner),
    field('Category', item.category),
    field('Source', item.source),
    field('Status', item.onSurface === true || item.tag === 'GROUND' ? 'On ground' : item.onSurface === false ? 'Airborne' : null),
    field('Emergency', typeof item.emergency === 'boolean' ? (item.emergency ? 'Yes' : 'No') : item.emergency),
    field('Position', position),
    field('Barometric altitude', measured(item.alt,' ft')),
    field('Geometric altitude', measured(item.altGeom,' ft')),
    field('Heading', fixed(first(item,['heading','navigationHeading']),0,'°')),
    field('Ground speed', measured(speed,' kt')),
    field('Vertical rate', measured(verticalRate,' ft/min')),
    field('Squawk', item.squawk),
    field('Range', fixed(item.distanceKm,1,' km')),
    field('Bearing', fixed(item.bearing,0,'°')),
    field('Last position', isoTime(reportedAt)),
    field('Position age', finite(item.seen) ? `${item.seen.toFixed(1)} s` : null),
  ].filter(Boolean);
}

function rawMessageLabel(item) {
  if (present(item.rawLabel)) return item.rawLabel;
  if (present(item.label)) return item.label;
  return String(item.tag || '').split(/\s*[·�]\s*/)[0] || null;
}

export function messageDetailFields(item = {}) {
  const mode = String(first(item,['link','mode']) || '').toLowerCase();
  const protocol = mode === 'vdl2' ? 'VDL Mode 2' : mode === 'acars' ? 'ACARS' : first(item,['link','mode']);
  return [
    field('Aircraft or source', item.title),
    field('Protocol', protocol),
    field('Message label', rawMessageLabel(item)),
    field('Frequency', finite(item.frequency) ? `${(item.frequency / 1e6).toFixed(3)} MHz` : null),
    field('Received', isoTime(item.time)),
  ].filter(Boolean);
}

export function messageDetailKey(item = {}) {
  return JSON.stringify([item.title || '',rawMessageLabel(item) || '',item.mode || item.link || '',item.frequency || '',item.time || '',item.detail || '']);
}
