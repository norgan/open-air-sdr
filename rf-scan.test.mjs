import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createRfScanner, validateRfScanRange } from './rf-scan.mjs';

const immediate = async () => {};
const spacing = 12_000;

function snapshot(centre, {peaks = [], linear = false, updated, background = () => -95} = {}) {
  const startFrequency = centre - 1_200_000;
  const stopFrequency = centre + 1_200_000;
  const power = Array.from({length:201}, (_, index) => {
    const frequency = startFrequency + index * spacing;
    const peak = peaks.find(({frequency:signal}) => Math.abs(frequency - signal) <= spacing / 2);
    const level = peak?.power ?? background(frequency);
    return linear ? 10 ** (level / 10) : level;
  });
  return {centre, connected:true, running:true, spectrum:{centerFrequency:centre, startFrequency,
    stopFrequency, bandwidth:2_400_000, linear:Number(linear), updated, power}};
}

async function until(predicate) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await delay(2);
  }
  assert.fail('The scan did not reach its expected state.');
}

test('range validation keeps Hz bounds exact and uses a positive dB threshold', () => {
  assert.deepEqual(validateRfScanRange({startFrequency:1_000_000, stopFrequency:2_000_000_000}),
    {startFrequency:1_000_000, stopFrequency:2_000_000_000, threshold:12, survey:false});
  assert.throws(() => validateRfScanRange({startFrequency:999_999, stopFrequency:2_000_000_000}), /scan range/);
  assert.throws(() => validateRfScanRange({startFrequency:90e6, stopFrequency:89e6}), /scan range/);
  assert.throws(() => validateRfScanRange({startFrequency:89e6, stopFrequency:90e6, threshold:0}), /threshold/);
  assert.throws(() => validateRfScanRange({startFrequency:89e6, stopFrequency:90e6, survey:1}), /survey/);
});

test('range scan reports peaks once across overlapping windows and ignores DC and out-of-range carriers', async () => {
  const tunes = [];
  const signal = 476_485_000;
  const scanner = createRfScanner({
    tune:async centre => { tunes.push(centre); },
    read:async centre => snapshot(centre, {peaks:[
      {frequency:signal,power:-65}, {frequency:centre,power:-1},
      {frequency:474_950_000,power:-6}, {frequency:478_080_000,power:-8}
    ]}),
    wait:immediate
  });
  scanner.start({startFrequency:475e6, stopFrequency:478e6});
  await until(() => scanner.status().status === 'complete');
  const result = scanner.status();
  assert.ok(tunes.length > 2);
  assert.equal(result.visited, result.total);
  assert.equal(result.hits.length, 1);
  assert.ok(Math.abs(result.hits[0].frequency - signal) <= spacing);
  assert.equal(result.hits[0].aboveNoise, 30);
  assert.equal(result.levels,undefined);
});

test('narrow scan avoids its DC bin and converts linear powers after the FFT updates', async () => {
  let reads = 0;
  const scanner = createRfScanner({
    tune:async centre => snapshot(centre,{updated:'old'}),
    read:async centre => snapshot(centre,{updated:++reads === 1 ? 'old' : 'new', linear:true,
      peaks:[{frequency:100_000_000,power:-70}]}),
    wait:immediate
  });
  scanner.start({startFrequency:99_970_000, stopFrequency:100_030_000, threshold:20});
  await until(() => scanner.status().status === 'complete');
  const result = scanner.status();
  assert.equal(reads,2);
  assert.equal(result.total,1);
  assert.ok(result.centre < result.startFrequency);
  assert.equal(result.hits.length, 1);
  assert.equal(result.hits[0].power, -70);
});

test('stop drains a retune and keeps hits already collected', async () => {
  let unblock;
  const inFlight = new Promise(resolve => { unblock = resolve; });
  let tunes = 0;
  const scanner = createRfScanner({
    tune:async () => { if (++tunes > 1) await inFlight; },
    read:async centre => snapshot(centre, {peaks:[{frequency:centre + 240_000,power:-65}]}),
    wait:immediate
  });
  const range = {startFrequency:475e6, stopFrequency:478e6};
  scanner.start(range);
  await until(() => tunes === 2);
  assert.throws(() => scanner.start(range), /already running/);
  let finished = false;
  const stopping = scanner.stop().then(() => { finished = true; });
  assert.equal(scanner.status().status,'stopped');
  await delay(2);
  assert.equal(finished,false);
  unblock();
  await stopping;
  assert.equal(scanner.status().visited,1);
  assert.equal(scanner.status().hits.length,1);
});

test('range scan rejects stale receiver centres and records a readable failure', async () => {
  const scanner = createRfScanner({
    tune:immediate,
    read:async centre => snapshot(centre - 1_000_000),
    wait:immediate
  });
  scanner.start({startFrequency:90e6, stopFrequency:91e6});
  await until(() => scanner.status().status === 'error');
  assert.equal(scanner.status().visited,0);
  assert.match(scanner.status().error,/No live spectrum/);
});

test('survey reports raised median power across a wide signal and gives actual sampled centres', async () => {
  const scanner = createRfScanner({
    tune:immediate,
    read:async centre => snapshot(centre, {background: frequency => Math.abs(frequency - 529.5e6) < 3.5e6 ? -70 : -95}),
    wait:immediate
  });
  const startFrequency = 524e6, stopFrequency = 535e6;
  scanner.start({startFrequency, stopFrequency, survey:true, threshold:30});
  await until(() => scanner.status().status === 'complete');
  const {levels, visited, hits} = scanner.status();
  assert.equal(levels.length,visited);
  assert.deepEqual(levels[0],{frequency:startFrequency,power:-95});
  assert.deepEqual(levels.at(-1),{frequency:stopFrequency,power:-95});
  assert.ok(levels.filter(level => level.power === -70).length > 7);
  assert.equal(hits.length,0);
  levels[0].power = 0;
  assert.equal(scanner.status().levels[0].power,-95);
});

test('wide survey limits work and output to 160 evenly spaced observations', async () => {
  const scanner = createRfScanner({tune:immediate, read:async centre => snapshot(centre), wait:immediate});
  const startFrequency = 1e6, stopFrequency = 2e9;
  const initial = scanner.start({startFrequency, stopFrequency, survey:true});
  assert.equal(initial.total,160);
  await until(() => scanner.status().status === 'complete');
  const {levels} = scanner.status();
  assert.equal(levels.length,160);
  assert.equal(levels[0].frequency,startFrequency);
  assert.equal(levels.at(-1).frequency,stopFrequency);
  const intervals = levels.slice(1).map((point,index) => point.frequency - levels[index].frequency);
  assert.ok(Math.max(...intervals) - Math.min(...intervals) <= 1);
});
