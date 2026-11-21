const weakCarrier = 5;
const carrier = 9;
const likelyUsable = 14;

function median(values) {
  values.sort((a, b) => a - b);
  const middle = Math.floor(values.length / 2);
  return (values[middle] + values[Math.floor((values.length - 1) / 2)]) / 2;
}

function statusFor(contrast, enoughBandwidth, squelch, decoded) {
  if (decoded === true) return 'decode-activity';
  if (contrast !== null && contrast >= likelyUsable && enoughBandwidth && squelch !== false) return 'likely-usable';
  if (squelch === true) return 'audio-open';
  if (contrast === null) return 'no-reading';
  if (contrast >= carrier) return 'carrier-detected';
  if (contrast >= weakCarrier) return 'weak-carrier';
  return 'no-clear-carrier';
}

/** Estimate the tuned peak's contrast against nearby FFT bins in relative dB. */
export function estimateSignal(frame, {frequency = frame?.centre, bandwidth, squelch, decoded} = {}) {
  const unavailable = {level:null, noise:null, contrast:null, status:statusFor(null, false, squelch, decoded)};
  const {centre, span, power} = frame ?? {};
  if (!Number.isFinite(centre) || !Number.isFinite(frequency) || !Number.isFinite(span) || span <= 0 ||
      !Array.isArray(power) || power.length < 2) return unavailable;

  const binWidth = span / power.length;
  const halfWidth = Number.isFinite(bandwidth) && bandwidth > 0 ? Math.max(bandwidth / 2, binWidth / 2) : 2 * binWidth;
  const fromCentre = frequency - centre;
  const usableHalf = span * 0.45;
  if (Math.abs(fromCentre) > usableHalf) return unavailable;

  const guard = Math.max(2 * binWidth, halfWidth * 0.15);
  const noiseStart = halfWidth + guard;
  const noiseEnd = noiseStart + Math.max(halfWidth, 12 * binWidth);
  const signal = [];
  const reference = [];

  for (let index = 0; index < power.length; index++) {
    const offset = (index + 0.5 - power.length / 2) * binWidth;
    const value = power[index];
    // Central bins can contain a receiver DC spur. Discard the roll-off at either edge, too.
    if (!Number.isFinite(value) || Math.abs(offset) < binWidth || Math.abs(offset) > usableHalf) continue;
    const distance = Math.abs(offset - fromCentre);
    if (distance <= halfWidth) signal.push(value);
    else if (distance >= noiseStart && distance <= noiseEnd) reference.push(value);
  }

  if (!signal.length) return unavailable;
  const peak = Math.max(...signal);
  const level = Math.round(peak * 10) / 10;
  if (reference.length < 6 || Math.abs(fromCentre) + halfWidth > usableHalf) return {...unavailable, level};

  const floor = median(reference);
  const contrast = Math.round((peak - floor) * 10) / 10;
  // A solitary spur within a wide channel is evidence of a carrier, but not a usable wide signal.
  const enoughBandwidth = halfWidth <= 12_500 || signal.length <= 6 ||
    signal.filter(value => value - floor >= carrier).length >= Math.max(2, Math.ceil(signal.length / 10));
  return {level, noise:Math.round(floor * 10) / 10, contrast, status:statusFor(contrast, enoughBandwidth, squelch, decoded)};
}
