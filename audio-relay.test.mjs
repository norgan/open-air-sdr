import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { audioRelay } from './streams.mjs';

class FakeEncoder extends EventEmitter {
  stdout = new EventEmitter();
  kills = 0;

  kill() {
    this.kills++;
  }
}

class FakeResponse extends EventEmitter {
  chunks = [];
  ended = false;
  writableLength = 0;

  writeHead(status) {
    this.status = status;
    return this;
  }

  flushHeaders() {}

  write(chunk) {
    this.chunks.push(chunk);
  }

  end() {
    this.ended = true;
  }
}

function fixture() {
  const encoders = [];
  const listen = audioRelay(9998, () => {
    const encoder = new FakeEncoder();
    encoders.push(encoder);
    return encoder;
  });
  return { listen, encoders };
}

test('audio relay transfers a returning listener after the old encoder releases its input', () => {
  const { listen, encoders } = fixture();
  const first = new FakeResponse();
  listen(first);
  assert.equal(first.status, 200);
  const old = encoders[0];
  old.stdout.emit('data', 'first stream');
  assert.deepEqual(first.chunks, ['first stream']);
  first.emit('close');
  assert.equal(old.kills, 1);

  const returning = new FakeResponse();
  listen(returning);
  assert.equal(returning.status, 200);
  old.stdout.emit('data', 'old encoder tail');
  assert.equal(encoders.length, 1);
  assert.deepEqual(returning.chunks, []);

  old.emit('close');
  assert.equal(encoders.length, 2);
  assert.equal(returning.ended, false);
  const replacement = encoders[1];
  replacement.stdout.emit('data', 'new stream');
  assert.deepEqual(returning.chunks, ['new stream']);
  returning.emit('close');
  assert.equal(replacement.kills, 1);
  replacement.emit('close');
  assert.equal(encoders.length, 2);
});

test('audio relay ends dead streams after an unexpected encoder exit and cleans up old clients', () => {
  const { listen, encoders } = fixture();
  const first = new FakeResponse();
  const second = new FakeResponse();
  listen(first);
  listen(second);
  assert.equal(encoders.length, 1);
  encoders[0].emit('close');
  assert.equal(first.ended, true);
  assert.equal(second.ended, true);

  const recovering = new FakeResponse();
  listen(recovering);
  assert.equal(encoders.length, 2);
  first.emit('close');
  second.emit('close');
  const replacement = encoders[1];
  replacement.stdout.emit('data', 'recovered stream');
  assert.equal(replacement.kills, 0);
  assert.deepEqual(first.chunks, []);
  assert.deepEqual(second.chunks, []);
  assert.deepEqual(recovering.chunks, ['recovered stream']);
});
