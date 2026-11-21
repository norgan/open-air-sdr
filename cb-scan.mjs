import { setTimeout as sleep } from 'node:timers/promises';
import { availableSources } from './sources.mjs';

const channelSources = availableSources.filter(source => Number.isInteger(source.channel));
const voiceSources = channelSources.filter(({channel}) => channel !== 22 && channel !== 23)
  .sort((left, right) => left.channel - right.channel);
const channelsById = new Map(channelSources.map(source => [source.id, source]));

function matches(radio, source) {
  return radio?.source === source.id && radio.connected && radio.running;
}

export function createCbScanner(options) {
  return createVoiceScanner({ ...options, defaultChannels:voiceSources, nextCbChannel:true });
}

export function createVoiceScanner({
  tune,
  read,
  defaultChannels = [],
  nextCbChannel = false,
  settleMs = 300,
  sampleMs = 250,
  releaseMs = 1500,
  now = Date.now,
  wait = (ms, signal) => sleep(ms, undefined, {signal})
}) {
  let state = {status:'idle', channel:null, source:null, squelch:null, error:null};
  let controller;
  let active;

  function status() {
    return {...state};
  }

  async function observe(source, signal) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const radio = await read(source.id);
      if (signal.aborted) return null;
      if (matches(radio, source) && typeof radio.squelch === 'boolean') return radio;
      if (attempt < 2) await wait(sampleMs, signal);
    }
    throw Error(`SDRangel did not report squelch on ${source.name}.`);
  }

  async function scan(channels, index, signal) {
    while (!signal.aborted) {
      const source = channels[index];
      state = {...state, status:'scanning', squelch:null};
      const tuned = await tune(source.id, source);
      if (matches(tuned, source)) state = {...state, channel:source.channel??null, source:source.id};
      if (signal.aborted) return;

      await wait(settleMs, signal);
      let radio = await observe(source, signal);
      if (!radio) return;
      state = {...state, channel:source.channel??null, source:source.id, squelch:radio.squelch};
      if (radio.squelch) {
        let quietSince;
        state = {...state, status:'holding'};
        while (!signal.aborted) {
          await wait(sampleMs, signal);
          radio = await observe(source, signal);
          if (!radio) return;
          state = {...state, squelch:radio.squelch};
          if (radio.squelch) quietSince = undefined;
          else {
            const time = now();
            quietSince ??= time;
            if (time - quietSince >= releaseMs) break;
          }
        }
      }
      index = (index + 1) % channels.length;
    }
  }

  function start(currentSource, channels = defaultChannels) {
    if (active) return status();
    if (!channels.length) throw Error('Add an airband voice preset in Setup to scan this area.');
    const current = nextCbChannel ? channelsById.get(currentSource) : channels.find(source => source.id===currentSource);
    const next = current ? channels.findIndex(source => nextCbChannel ? source.channel>current.channel : source===current) : 0;
    state = {status:'scanning', channel:current?.channel ?? null, source:current?.id ?? null, squelch:null, error:null};
    controller = new AbortController();
    const {signal} = controller;
    active = scan(channels, Math.max(0, next), signal).catch(error => {
      if (!signal.aborted) state = {...state, status:'error', squelch:null, error:String(error?.message ?? error)};
    }).finally(() => {
      active = undefined;
      controller = undefined;
    });
    return status();
  }

  async function stop() {
    controller?.abort();
    state = {...state, status:'idle', squelch:null, error:null};
    await active;
    return status();
  }

  return {start, stop, status};
}
