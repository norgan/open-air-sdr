import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { validateRfScanRange } from './rf-scan.mjs';
import { customSource } from './sources.mjs';
import { writeStateFile } from './state-file.mjs';

const defaultProfile = {
  name: 'Local area',
  includeSydney: false,
  scan: { startFrequency: 118_000_000, stopFrequency: 137_000_000, threshold: 12 },
  presets: [],
};

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function validateLocalProfile(input) {
  if (!isRecord(input)) throw Error('Enter a local-area profile.');
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name || name.length > 80) throw Error('Enter an area name of up to 80 characters.');
  if (typeof input.includeSydney !== 'boolean') throw Error('Choose whether to include the Sydney presets.');
  if (!isRecord(input.scan)) throw Error('Enter an RF scan range for this area.');
  if (!Array.isArray(input.presets)) throw Error('Enter a list of local presets.');

  const { startFrequency, stopFrequency, threshold, survey } = validateRfScanRange(input.scan);
  const channels = new Set();
  const presets = Array.from(input.presets, (preset, index) => {
    if (!isRecord(preset) || !customSource(preset)) {
      throw Error(`Preset ${index + 1} needs a supported mode, frequency and settings.`);
    }
    const { frequency, mode, bandwidth, squelch } = preset;
    const key = `${mode}:${frequency}`;
    if (channels.has(key)) throw Error(`Preset ${index + 1} repeats the frequency and mode of another preset.`);
    channels.add(key);
    const presetName = preset.name?.trim();
    return {
      frequency, mode,
      ...(presetName && { name: presetName }),
      ...(bandwidth != null && { bandwidth }),
      ...(squelch != null && { squelch }),
    };
  });

  const scan = { startFrequency, stopFrequency, threshold, ...(survey && { survey }) };
  let aircraftCentre;
  if (input.aircraftCentre != null) {
    const {latitude, longitude} = input.aircraftCentre;
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 85 || Math.abs(longitude) > 180) {
      throw Error('Enter both map coordinates, with latitude from -85 to 85 and longitude from -180 to 180.');
    }
    aircraftCentre = {latitude, longitude};
  }
  return { name, includeSydney: input.includeSydney, ...(aircraftCentre && {aircraftCentre}), scan, presets };
}

export function createLocalProfileStore(path) {
  if (path == null) {
    let profile = defaultProfile;
    return {
      async read() {
        return structuredClone(profile);
      },
      async save(input) {
        profile = validateLocalProfile(input);
        return structuredClone(profile);
      },
    };
  }
  const target = resolve(path);
  let pending = Promise.resolve();

  async function read() {
    await pending;
    let stored;
    try {
      stored = await readFile(target, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return structuredClone(defaultProfile);
      throw error;
    }
    try {
      return validateLocalProfile(JSON.parse(stored));
    } catch (error) {
      throw Error(`The saved local-area profile is invalid. ${error.message}`, { cause: error });
    }
  }

  async function save(input) {
    const profile = validateLocalProfile(input);
    const write = pending.then(() => writeStateFile(target, profile));
    pending = write.catch(() => {});
    await write;
    return profile;
  }

  return { read, save };
}
