import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { writeStateFile } from './state-file.mjs';

export const messageLimit = 500;

function isMessage(value) {
  return value && ['acars','vdl2'].includes(value.mode) && Number.isInteger(value.frequency) &&
    ['time','title','tag','detail'].every(key => typeof value[key] === 'string');
}

export function createMessageArchive(path) {
  const target = path && resolve(path);
  let messages;
  let loading;
  let warning = '';
  let pending = Promise.resolve();
  let readOnly = false;
  let revision = randomUUID();

  function load() {
    loading ??= (async () => {
      if (target) {
        try {
          const saved = JSON.parse(await readFile(target,'utf8'));
          if (!Array.isArray(saved) || !saved.every(isMessage)) throw Error('Invalid message archive.');
          return saved.slice(0,messageLimit);
        } catch (error) {
          if (error.code !== 'ENOENT') {
            warning = 'The saved message history could not be read. New messages are available for this session.';
            readOnly = true;
          }
        }
      }
      return [];
    })().then(saved => {messages=saved;});
    return loading;
  }

  function append(received) {
    if (!received.length) return pending;
    pending = pending.then(async () => {
      await load();
      const unique = new Set();
      messages = [...received,...messages].filter(message => {
        const key=JSON.stringify([message.mode,message.frequency,message.time,message.title,message.tag,message.detail]);
        if (unique.has(key)) return false;
        unique.add(key);
        return true;
      }).slice(0,messageLimit);
      revision = randomUUID();
      if (target && !readOnly) {
        try {
          await writeStateFile(target,messages);
          warning = '';
        } catch {
          warning = 'Message history could not be saved to disk. New messages are available for this session.';
        }
      }
    });
    return pending;
  }

  async function read() {
    await pending;
    await load();
    return {messages:structuredClone(messages),limit:messageLimit,warning,revision};
  }

  return {append,read};
}
