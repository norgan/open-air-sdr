import assert from 'node:assert/strict';
import { setImmediate as tick } from 'node:timers/promises';
import test from 'node:test';
import { createCbScanner, createVoiceScanner } from './cb-scan.mjs';

function clock() {
  const pending = new Set();
  let time = 0;
  return {
    pending,
    now: () => time,
    wait: (ms, signal) => new Promise((resolve, reject) => {
      signal.throwIfAborted();
      const elapsed = () => {
        signal.removeEventListener('abort', abort);
        pending.delete(elapsed);
        time += ms;
        resolve();
      };
      const abort = () => {
        pending.delete(elapsed);
        reject(signal.reason);
      };
      pending.add(elapsed);
      signal.addEventListener('abort', abort, {once:true});
    }),
    async advance() {
      assert.equal(pending.size, 1);
      pending.values().next().value();
      await tick();
    }
  };
}

function radio(source, squelch = false) {
  return {source, connected:true, running:true, squelch};
}

function harness(options = {}) {
  const time = clock();
  const tunes = [];
  const scanner = createCbScanner({
    wait:time.wait,
    now:time.now,
    async tune(id) { tunes.push(id); return radio(id); },
    async read(id) { return radio(id); },
    ...options
  });
  return {scanner,time,tunes};
}

test('scan skips data and reserved channels and wraps to channel 1', async () => {
  const {scanner,time,tunes} = harness();
  for (const [current, expected] of [['cb21','cb24'], ['cb60','cb64'], ['cb80','cb1']]) {
    const started = scanner.start(current);
    assert.equal(started.status, 'scanning');
    assert.equal(started.source, current);
    await tick();
    assert.equal(tunes.at(-1), expected);
    assert.equal(scanner.status().source, expected);
    assert.equal((await scanner.stop()).status, 'idle');
    assert.equal(time.pending.size, 0);
  }
  assert.deepEqual(tunes, ['cb24','cb64','cb1']);
});

test('airband scan listens to the current channel first, holds and advances to the next preset', async t => {
  const time=clock();
  const channels=[{id:'tower',name:'Tower'},{id:'approach',name:'Approach'}];
  const activity=[true,false,false];
  const tunes=[];
  const scanner=createVoiceScanner({wait:time.wait,now:time.now,releaseMs:250,
    tune:async id=>{tunes.push(id);return radio(id);},
    read:async id=>radio(id,activity.shift()??false),
  });
  t.after(scanner.stop);
  assert.equal(scanner.start('tower',channels).source,'tower');
  await tick();
  await time.advance();
  assert.equal(scanner.status().status,'holding');
  assert.deepEqual(tunes,['tower']);
  await time.advance();
  await time.advance();
  assert.equal(scanner.status().status,'scanning');
  assert.deepEqual(tunes,['tower','approach']);
  assert.equal((await scanner.stop()).source,'approach');
});

test('scan holds while squelch is open and resumes after continuous silence', async (t) => {
  const activity = [true,false,true,false,false,false];
  const {scanner,time,tunes} = harness({releaseMs:500, async read(id) { return radio(id, activity.shift()); }});
  t.after(scanner.stop);
  scanner.start('cb39');
  await tick();
  await time.advance();
  assert.equal(scanner.status().status, 'holding');
  assert.equal(scanner.status().squelch, true);
  assert.deepEqual(tunes, ['cb40']);

  await time.advance();
  assert.equal(scanner.status().squelch, false);
  await time.advance();
  assert.equal(scanner.status().squelch, true);
  for (let sample = 0; sample < 2; sample++) await time.advance();
  assert.equal(scanner.status().status, 'holding');
  assert.deepEqual(tunes, ['cb40']);

  await time.advance();
  assert.equal(scanner.status().status, 'scanning');
  assert.deepEqual(tunes, ['cb40','cb41']);
});

test('scan tolerates settling snapshots and preserves the last tuned channel', async (t) => {
  const reads = [radio('cb40'), {connected:true,running:false}, radio('cb41',true)];
  const {scanner,time,tunes} = harness({async read() {return reads.shift();}});
  t.after(scanner.stop);
  scanner.start('cb40');
  await tick();
  await time.advance();
  assert.equal(scanner.status().source, 'cb41');
  assert.equal(scanner.status().squelch, null);
  await time.advance();
  await time.advance();
  assert.deepEqual(tunes, ['cb41']);
  assert.equal(scanner.status().status, 'holding');
});

test('stop drains an in-flight retune before releasing manual receiver control', async () => {
  let finishTune;
  const tune = new Promise(resolve => {finishTune = resolve;});
  const {scanner,time} = harness({tune:() => tune});
  scanner.start('cb40');
  let stopped = false;
  const drain = scanner.stop().then(() => {stopped = true;});
  await tick();
  assert.equal(stopped, false);
  assert.equal(scanner.start('cb50').status, 'idle');
  finishTune(radio('cb41'));
  await drain;
  assert.equal(scanner.status().status, 'idle');
  assert.equal(scanner.status().source, 'cb41');
  assert.equal(time.pending.size, 0);
});

test('an unavailable tuner produces an error and can be restarted', async (t) => {
  let first = true;
  const {scanner} = harness({async tune(id) {
    if (first) {
      first = false;
      throw Error('RTL-SDR unavailable');
    }
    return radio(id);
  }});
  t.after(scanner.stop);
  scanner.start('cb80');
  await tick();
  assert.equal(scanner.status().status, 'error');
  assert.equal(scanner.status().error, 'RTL-SDR unavailable');
  assert.equal(scanner.status().source, 'cb80');
  scanner.start('cb80');
  await tick();
  assert.equal(scanner.status().status, 'scanning');
  assert.equal(scanner.status().error, null);
  assert.equal(scanner.status().source, 'cb1');
});
