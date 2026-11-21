import assert from 'node:assert/strict';
import { test } from 'node:test';
import { estimateSignal } from './signal-meter.mjs';

const centre = 130e6;
const tuned = centre + 99_000;
const span = 1_024_000;
const bandwidth = 12_500;

function frameWith(peaks = [], floor = -102) {
  const power = Array(512).fill(floor);
  for (const [frequency, value] of peaks) {
    const index = Math.floor((frequency - centre) * power.length / span + power.length / 2);
    power[index] = value;
  }
  return {centre, span, power};
}

test('uses the tuned peak and nearby noise floor, excluding nearby transmitters and the guard', () => {
  const frame = frameWith([[tuned, -82], [tuned + 8000, -30], [tuned + 30_000, -45]]);
  assert.deepEqual(estimateSignal(frame, {frequency:tuned, bandwidth}), {
    level:-82, noise:-102, contrast:20, status:'likely-usable'
  });
  assert.equal(estimateSignal(frame, {frequency:tuned, bandwidth, squelch:false}).status, 'carrier-detected');
});

test('distinguishes small contrast, a weak carrier and an observed open squelch', () => {
  assert.equal(estimateSignal(frameWith(), {frequency:tuned, bandwidth}).status, 'no-clear-carrier');
  const frame = frameWith([[tuned, -95]]);
  assert.equal(estimateSignal(frame, {frequency:tuned, bandwidth}).status, 'weak-carrier');
  assert.equal(estimateSignal(frame, {frequency:tuned, bandwidth, squelch:true}).status, 'audio-open');
  assert.equal(estimateSignal(frame, {frequency:tuned, bandwidth, decoded:true}).status, 'decode-activity');
});

test('measures channels as narrow as a bin at the selected frequency', () => {
  const frame = frameWith([[tuned, -83]]);
  assert.equal(estimateSignal(frame, {frequency:tuned, bandwidth:800}).contrast, 19);
});

test('suppresses central DC and can read adjacent bins in spectrum-only view', () => {
  const dc = frameWith([[centre - 1000, -15], [centre + 1000, -20]]);
  assert.deepEqual(estimateSignal(dc), {level:-102, noise:-102, contrast:0, status:'no-clear-carrier'});
  assert.equal(estimateSignal(dc, {frequency:centre, bandwidth:1000}).status, 'no-reading');
});

test('requires more than an isolated high bin for strong usability in a wide filter', () => {
  const narrowSpur = frameWith([[tuned, -42]]);
  assert.equal(estimateSignal(narrowSpur, {frequency:tuned, bandwidth:180_000}).status, 'carrier-detected');
  const spread = frameWith(Array.from({length:20}, (_, index) => [tuned + (index - 10) * 2000, -68]));
  assert.equal(estimateSignal(spread, {frequency:tuned, bandwidth:180_000}).status, 'likely-usable');
});

test('does not estimate contrast for a clipped channel or missing reference', () => {
  const frame = frameWith([[tuned, -82]]);
  assert.deepEqual(estimateSignal(frame, {frequency:tuned, bandwidth:1_500_000}), {
    level:-82, noise:null, contrast:null, status:'no-reading'
  });
  assert.equal(estimateSignal(frame, {frequency:centre + span / 2, bandwidth}).level, null);
  const sparse = {...frame, power:frame.power.map(value => value === -82 ? value : NaN)};
  assert.equal(estimateSignal(sparse, {frequency:tuned, bandwidth}).contrast, null);
});

test('preserves observed evidence when no valid FFT reading is available', () => {
  assert.deepEqual(estimateSignal(null), {level:null, noise:null, contrast:null, status:'no-reading'});
  assert.equal(estimateSignal(null, {squelch:true}).status, 'audio-open');
  assert.equal(estimateSignal(null, {decoded:true}).status, 'decode-activity');
  assert.equal(estimateSignal(frameWith(), {frequency:NaN}).status, 'no-reading');
});
