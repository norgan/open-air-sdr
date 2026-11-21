import { setTimeout as delay } from 'node:timers/promises';

const minFrequency = 1_000_000;
const maxFrequency = 2_000_000_000;
const step = 750_000;
const offset = 270_000;
const maxHits = 32;
const maxSurveyWindows = 160;

export function validateRfScanRange(input) {
  const {startFrequency, stopFrequency, threshold = 12, survey = false} = input ?? {};
  if (!Number.isInteger(startFrequency) || !Number.isInteger(stopFrequency) ||
      startFrequency < minFrequency || stopFrequency > maxFrequency || startFrequency >= stopFrequency) {
    throw Error('Enter an increasing scan range between 1 and 2000 MHz.');
  }
  if (!Number.isFinite(threshold) || threshold <= 0) throw Error('Enter a positive signal threshold in dB.');
  if (typeof survey !== 'boolean') throw Error('The RF survey setting must be true or false.');
  return {startFrequency, stopFrequency, threshold, survey};
}

function tuningCentres({startFrequency, stopFrequency, survey}) {
  if (survey) {
    const span = stopFrequency - startFrequency;
    const count = Math.min(maxSurveyWindows, Math.ceil(span / step) + 1);
    return Array.from({length:count}, (_, index) => Math.round(startFrequency + index * span / (count - 1)));
  }
  // Put a narrow search to one side of the receiver's DC bin. Overlapping wider
  // windows give each interior DC notch a second view under a different centre.
  if (stopFrequency - startFrequency <= 630_000) {
    return [startFrequency - offset >= minFrequency ? startFrequency - offset : stopFrequency + offset];
  }
  const first = startFrequency + offset;
  const intervals = Math.max(1, Math.ceil((stopFrequency - first - 600_000) / step));
  return Array.from({length:intervals + 1}, (_, index) => Math.min(maxFrequency, first + index * step));
}

function spectrumWindow(snapshot, centre) {
  const {spectrum} = snapshot || {};
  if (snapshot?.connected === false || snapshot?.running === false || !Array.isArray(spectrum?.power) ||
      (snapshot?.centre ?? spectrum.centerFrequency) !== centre ||
      (spectrum.centerFrequency != null && spectrum.centerFrequency !== centre)) return null;
  const {startFrequency, stopFrequency, power, linear, bandwidth} = spectrum;
  if (!Number.isFinite(startFrequency) || !Number.isFinite(stopFrequency)) return null;
  const spacing = (stopFrequency - startFrequency) / (power.length - 1);
  const span = bandwidth ?? spacing * power.length;
  if (!Number.isFinite(spacing) || spacing <= 0 || spacing > 50_000 || !(span >= 2_000_000) ||
      startFrequency >= centre || stopFrequency <= centre) return null;
  const usableHalf = Math.min(1_000_000, span * 0.45);
  const dc = Math.max(10_000, spacing * 2);
  const bins = power.map((value, index) => {
    const frequency = Math.round(startFrequency + index * spacing);
    const distance = Math.abs(frequency - centre);
    if (!Number.isFinite(value) || distance < dc || distance > usableHalf) return null;
    if (Number(linear) !== 1) return {frequency, power:value};
    return value >= 0 ? {frequency, power:10 * Math.log10(Math.max(value, 1e-20))} : null;
  });
  const levels = bins.filter(Boolean).map(bin => bin.power).sort((a, b) => a - b);
  if (levels.length < 8) return null;
  return {bins, spacing, floor:levels[Math.floor(levels.length / 2)]};
}

function candidates(window, range) {
  const hits = [];
  let peak = null;
  for (const bin of window.bins) {
    if (bin && bin.frequency >= range.startFrequency && bin.frequency <= range.stopFrequency &&
        bin.power - window.floor >= range.threshold) {
      if (!peak || bin.power > peak.power) peak = bin;
    } else if (peak) {
      hits.push(peak);
      peak = null;
    }
  }
  if (peak) hits.push(peak);
  return hits.map(bin => ({...bin, aboveNoise:bin.power - window.floor, spacing:window.spacing}));
}

function compareHits(first, second) {
  return second.aboveNoise - first.aboveNoise || second.power - first.power || first.frequency - second.frequency;
}

function mergeHits(previous, next) {
  const kept = [];
  for (const hit of [...previous, ...next].sort(compareHits)) {
    if (kept.some(candidate => Math.abs(candidate.frequency - hit.frequency) <=
        Math.max(candidate.spacing, hit.spacing))) continue;
    kept.push(hit);
    if (kept.length === maxHits) break;
  }
  return kept;
}

export function createRfScanner({tune, read, wait = delay}) {
  let active;
  let state = {status:'idle', startFrequency:null, stopFrequency:null, threshold:12, survey:false,
    centre:null, visited:0, total:0, hits:[], error:null};

  function status() {
    const hits = state.hits.map(({frequency, power, aboveNoise}) => ({
      frequency, power:Math.round(power * 10) / 10, aboveNoise:Math.round(aboveNoise * 10) / 10
    }));
    return {...state, hits, ...(state.survey ? {levels:state.levels.map(level => ({...level}))} : {})};
  }

  async function settle(centre, previousFrame, signal) {
    for (let attempt = 0; attempt < 5; attempt++) {
      await wait(160, undefined, {signal});
      signal.throwIfAborted();
      let snapshot;
      try { snapshot = await read(centre); } catch {}
      signal.throwIfAborted();
      if (previousFrame && snapshot?.spectrum?.updated === previousFrame) continue;
      const window = spectrumWindow(snapshot, centre);
      if (window) return window;
    }
    throw Error('No live spectrum received at ' + (centre / 1e6).toFixed(3) + ' MHz.');
  }

  async function scan(range, centres, signal) {
    try {
      for (const centre of centres) {
        signal.throwIfAborted();
        const tuned = await tune(centre);
        signal.throwIfAborted();
        const window = await settle(centre, tuned?.spectrum?.updated, signal);
        state.centre = centre;
        state.visited++;
        state.hits = mergeHits(state.hits, candidates(window, range));
        if (range.survey) state.levels.push({frequency:centre, power:Math.round(window.floor * 10) / 10});
      }
      state.status = 'complete';
    } catch (error) {
      if (signal.aborted) return;
      state.status = 'error';
      state.error = String(error?.message || error).slice(0, 240);
    }
  }

  function start(input) {
    const range = validateRfScanRange(input);
    if (active) throw Error('An RF scan is already running.');
    const centres = tuningCentres(range);
    const session = {controller:new AbortController()};
    active = session;
    state = {status:'scanning', ...range, centre:null, visited:0, total:centres.length, hits:[], error:null,
      ...(range.survey ? {levels:[]} : {})};
    session.done = scan(range, centres, session.controller.signal).finally(() => { active = undefined; });
    return status();
  }

  async function stop() {
    const session = active;
    if (session) {
      if (state.status === 'scanning') {
        state.status = 'stopped';
        session.controller.abort();
      }
      await session.done;
    }
    return status();
  }

  return {start, stop, status};
}
