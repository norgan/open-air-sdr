import { createHash, timingSafeEqual } from 'node:crypto';

const controlCharacters = /[\x00-\x1f\x7f]/u;
const invalidTokenCharacters = /[^\x21-\x7e]|,/u;

function digest(value) {
  return createHash('sha256').update(value).digest();
}

function singleHeader(headers, name) {
  const value = headers?.[name];
  if (Array.isArray(value)) {
    return value.length === 1 && typeof value[0] === 'string' ? value[0] : '';
  }
  return typeof value === 'string' ? value : '';
}

function webCredentials(username, password) {
  if (username === '' && password === '') return undefined;
  if (typeof username !== 'string' || !username.trim() ||
      typeof password !== 'string' || !password.trim()) {
    throw new Error('Set both the Open Air web username and password to enable sign-in.');
  }
  if (username.includes(':') || controlCharacters.test(username) || controlCharacters.test(password)) {
    throw new Error('Open Air web credentials cannot contain control characters or a colon in the username.');
  }
  return digest(`${username}:${password}`.normalize('NFC'));
}

export function createAccess({ username = '', password = '', haToken = '' } = {}) {
  const expectedWeb = webCredentials(username, password);
  if (typeof haToken !== 'string' || invalidTokenCharacters.test(haToken)) {
    throw new Error('The Open Air Home Assistant token must use printable ASCII without spaces or commas.');
  }
  const expectedHa = haToken ? digest(haToken) : undefined;

  return {
    webEnabled: Boolean(expectedWeb),
    haEnabled: Boolean(expectedHa),
    checkWeb(headers) {
      if (!expectedWeb) return true;
      const authorization = singleHeader(headers, 'authorization');
      const scheme = /^Basic +/i.exec(authorization);
      if (!scheme) return false;
      const encoded = authorization.slice(scheme[0].length);
      const bytes = Buffer.from(encoded, 'base64');
      if (bytes.toString('base64') !== encoded) return false;
      return timingSafeEqual(expectedWeb, digest(bytes));
    },
    checkHa(headers) {
      if (!expectedHa) return false;
      const token = singleHeader(headers, 'x-open-air-token');
      return timingSafeEqual(expectedHa, digest(token));
    }
  };
}
