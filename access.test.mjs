import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAccess } from './access.mjs';

function basic(username, password) {
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}

test('web sign-in is optional and the Home Assistant route requires a configured token', () => {
  const access = createAccess();
  assert.equal(access.webEnabled, false);
  assert.equal(access.checkWeb({}), true);
  assert.equal(access.haEnabled, false);
  assert.equal(access.checkHa({ 'x-open-air-token': 'anything' }), false);
});

test('invalid or incomplete credential configuration fails at startup', () => {
  assert.throws(() => createAccess({ username: 'radio' }), /both.*username and password/);
  assert.throws(() => createAccess({ password: 'password' }), /both.*username and password/);
  assert.throws(() => createAccess({ username: ' ', password: 'password' }), /both.*username and password/);
  assert.throws(() => createAccess({ username: 'radio:operator', password: 'password' }), /colon/);
  assert.throws(() => createAccess({ username: 'radio', password: 'pass\nword' }), /control characters/);
  assert.throws(() => createAccess({ haToken: 'token\n' }), /printable ASCII/);
  assert.throws(() => createAccess({ haToken: 'token,token' }), /commas/);
});

test('web sign-in checks Basic credentials including UTF-8 and a colon in the password', () => {
  const access = createAccess({ username: 'Frequência', password: 'listen:only' });
  const authorization = basic('Frequência', 'listen:only');
  assert.equal(access.webEnabled, true);
  assert.equal(access.checkWeb({ authorization }), true);
  assert.equal(access.checkWeb({ authorization: [authorization.replace('Basic ', 'bAsIc ')] }), true);
  assert.equal(access.checkWeb({ authorization: basic('Frequência', 'other') }), false);
  assert.equal(access.checkWeb({ authorization: basic('Frequencia', 'listen:only') }), false);
  assert.equal(access.checkWeb({}), false);
});

test('malformed and duplicate Basic headers are rejected', () => {
  const access = createAccess({ username: 'radio', password: 'secrets' });
  const authorization = basic('radio', 'secrets');
  assert.equal(access.checkWeb({ authorization: [authorization, authorization] }), false);
  assert.equal(access.checkWeb({ authorization: `${authorization}, ${authorization}` }), false);
  assert.equal(access.checkWeb({ authorization: `${authorization}\n` }), false);
  assert.equal(access.checkWeb({ authorization: authorization.replace(/=+$/, '') }), false);
  assert.equal(access.checkWeb({ authorization: authorization.replace('Basic ', 'Bearer ') }), false);
});

test('the Home Assistant token is checked independently of browser or proxy credentials', () => {
  const access = createAccess({ username: 'radio', password: 'secret', haToken: 'radio-api-secret' });
  assert.equal(access.haEnabled, true);
  const authorization = basic('radio', 'secret');
  assert.equal(access.checkHa({ 'x-open-air-token': 'radio-api-secret', authorization }), true);
  assert.equal(access.checkHa({ 'x-open-air-token': ['radio-api-secret'] }), true);
  assert.equal(access.checkHa({ 'x-open-air-token': ['radio-api-secret', 'radio-api-secret'] }), false);
  assert.equal(access.checkHa({ 'x-open-air-token': 'radio-api-secret, radio-api-secret' }), false);
  assert.equal(access.checkHa({ 'x-open-air-token': 'radio-api-secret ' }), false);
  assert.equal(access.checkHa({ authorization }), false);
  assert.equal(access.checkWeb({ 'x-open-air-token': 'radio-api-secret' }), false);
});
