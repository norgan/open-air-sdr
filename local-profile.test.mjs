import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, rmdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { createLocalProfileStore, validateLocalProfile } from './local-profile.mjs';

const profile = {
  name: 'Local airband',
  includeSydney: false,
  scan: { startFrequency: 118_000_000, stopFrequency: 137_000_000, threshold: 9, survey: true },
  presets: [
    { frequency: 118_300_000, mode: 'am', name: 'Tower', bandwidth: 12_500, squelch: -70 },
    { frequency: 121_800_000, mode: 'spectrum' },
  ],
};

async function fixture(t) {
  const folder = await mkdtemp(join(tmpdir(), 'open-air-profile-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const path = join(folder, 'settings', 'profile.json');
  return { path, store: createLocalProfileStore(path) };
}

test('a new installation has independent copies of the Sydney default profile', async t => {
  const { store } = await fixture(t);
  const initial = await store.read();
  assert.deepEqual(initial, {
    name: 'Sydney, NSW', includeSydney: true,
    aircraftCentre: { latitude: -33.95, longitude: 151.18 },
    scan: { startFrequency: 118_000_000, stopFrequency: 137_000_000, threshold: 12 },
    presets: [],
  });
  initial.scan.threshold = 1;
  assert.equal((await store.read()).scan.threshold, 12);
});

test('stores without a file path keep independently validated settings in memory', async () => {
  const store = createLocalProfileStore();
  const defaults = await store.read();
  const saved = await store.save(profile);
  saved.name = 'changed by caller';
  await assert.rejects(store.save(null), /Enter a local-area profile/);
  assert.deepEqual(await store.read(), profile);
  assert.deepEqual(await createLocalProfileStore().read(), defaults);
});

test('profiles persist canonical scan and preset settings across independent store instances', async t => {
  const { path, store } = await fixture(t);
  const saved = await store.save({
    ...profile,
    name: ' Local airband ',
    privateValue: 'not persisted',
    presets: [{ ...profile.presets[0], name: ' Tower ', id: 'ignored' }, profile.presets[1]],
  });
  assert.deepEqual(saved, profile);
  assert.deepEqual(await createLocalProfileStore(path).read(), profile);
  saved.presets[0].name = 'changed by caller';
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), profile);
  assert.deepEqual(await readdir(dirname(path)), ['profile.json']);
});

test('invalid tuning settings and scan parameters do not overwrite a valid profile', async t => {
  const { path, store } = await fixture(t);
  await store.save(profile);
  const bytes = await readFile(path, 'utf8');
  await assert.rejects(store.save({ ...profile, scan: { ...profile.scan, threshold: 0 } }), /positive signal threshold/);
  await assert.rejects(store.save({ ...profile, presets: [{ ...profile.presets[0], bandwidth: 50_000 }] }), /Preset 1/);
  await assert.rejects(store.save({ ...profile, presets: [null] }), /Preset 1/);
  await assert.rejects(store.save({ ...profile, includeSydney: 'false' }), /include the Sydney presets/);
  assert.throws(() => validateLocalProfile({ ...profile, presets: [profile.presets[0], { ...profile.presets[0], squelch: -60 }] }), /repeats the frequency and mode/);
  assert.deepEqual(await readFile(path, 'utf8'), bytes);
});

test('concurrent writes are serialised and a failed write leaves the store reusable', async t => {
  const { path, store } = await fixture(t);
  await mkdir(path, { recursive: true });
  await assert.rejects(store.save(profile));
  assert.deepEqual(await readdir(dirname(path)), ['profile.json']);
  await rmdir(path);
  const updated = { ...profile, name: 'New area' };
  const first = store.save(profile);
  const second = store.save(updated);
  assert.deepEqual(await store.read(), updated);
  assert.deepEqual(await Promise.all([first, second]), [profile, updated]);
});

test('a corrupt saved profile is reported and can be replaced with a valid one', async t => {
  const { path, store } = await fixture(t);
  await mkdir(dirname(path));
  await writeFile(path, '{missing data', 'utf8');
  await assert.rejects(store.read(), /saved local-area profile is invalid/);
  assert.deepEqual(await store.save(profile), profile);
  assert.deepEqual(await store.read(), profile);
});
