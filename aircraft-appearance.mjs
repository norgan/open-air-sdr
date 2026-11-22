export const defaultAircraftAppearance = Object.freeze({
  colour: '#ffd166',
  outline: '#101820',
  size: 28,
  mapOpacity: 75,
});

const storageKey = 'open-air-aircraft-appearance';
const colourPattern = /^#[0-9a-f]{6}$/i;

function validColour(value, fallback) {
  return typeof value === 'string' && colourPattern.test(value)
    ? value.toLowerCase()
    : fallback;
}

function boundedNumber(value, minimum, maximum, fallback) {
  const number = typeof value === 'number' ? value : Number.NaN;
  return Number.isFinite(number) && number >= minimum && number <= maximum
    ? number
    : fallback;
}

function validateAircraftAppearance(value) {
  const appearance = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    colour: validColour(appearance.colour, defaultAircraftAppearance.colour),
    outline: validColour(appearance.outline, defaultAircraftAppearance.outline),
    size: boundedNumber(appearance.size, 18, 44, defaultAircraftAppearance.size),
    mapOpacity: boundedNumber(appearance.mapOpacity, 30, 100, defaultAircraftAppearance.mapOpacity),
  };
}

export function loadAircraftAppearance(storage) {
  try {
    const saved = storage?.getItem(storageKey);
    return saved ? validateAircraftAppearance(JSON.parse(saved)) : {...defaultAircraftAppearance};
  } catch {
    return {...defaultAircraftAppearance};
  }
}

export function saveAircraftAppearance(storage, appearance) {
  const validated = validateAircraftAppearance(appearance);
  try {
    storage?.setItem(storageKey, JSON.stringify(validated));
  } catch {}
  return validated;
}

export function applyAircraftAppearance(root, appearance) {
  const validated = validateAircraftAppearance(appearance);
  const style = root?.style;
  if (style?.setProperty) {
    style.setProperty('--aircraft-colour', validated.colour);
    style.setProperty('--aircraft-outline', validated.outline);
    style.setProperty('--aircraft-size', `${validated.size}px`);
    style.setProperty('--map-opacity', String(validated.mapOpacity / 100));
  }
  return validated;
}
