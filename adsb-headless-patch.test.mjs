import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { patchAdsbHeadless } from './deploy/patch-adsb-headless.mjs';

const relative=join('plugins','channelrx','demodadsb','adsbdemodtracker.cpp');
const fixture=`#include <QDebug>
#include "maincore.h"

ADSBDemodTracker::ADSBDemodTracker(ADSBDemod *adsbDemod) :
    m_adsbDemod(adsbDemod)
{
    qRegisterMetaType<ADSBAircraftUpdate>("ADSBAircraftUpdate");

    m_frameRateTime = QDateTime::currentDateTime();
    m_statsTime = m_frameRateTime;

    initCoverageMap();
}

void ADSBDemodTracker::setPosition(float latitude, float longitude, float altitude)
{
    m_azEl.setLocation(latitude, longitude, altitude);
}

void ADSBDemodTracker::startWork()
{
    // Build the shared 3D model tables now rather than letting the first aircraft report
    // pay for it. Cheap when another plugin has already done it.
    Aircraft3DModels::instance();
}

void ADSBDemodTracker::tick()
{
    QDateTime now = QDateTime::currentDateTime();
    sendAircraftReport();
}
`;

async function sourceTree(content=fixture) {
  const root=await mkdtemp(join(tmpdir(),'open-air-adsb-patch-'));
  const source=join(root,relative);
  await mkdir(join(source,'..'),{recursive:true});
  await writeFile(source,content,'utf8');
  return {root,source,backup:source+'.open-air.orig'};
}

test('patches the v8.1 tracker once, preserves its backup and follows position changes',async()=>{
  const tree=await sourceTree();
  await chmod(tree.source,0o640);
  const before=await stat(tree.source);

  const first=await patchAdsbHeadless(tree.root);
  assert.equal(first.changed,true);
  assert.equal(await readFile(tree.backup,'utf8'),fixture);
  assert.equal((await stat(tree.source)).mode&0o777,0o640);
  const backupMetadata=await stat(tree.backup);
  assert.equal(backupMetadata.mode&0o777,0o640);
  assert.ok(Math.abs(backupMetadata.mtimeMs-before.mtimeMs)<2);

  const patched=await readFile(tree.source,'utf8');
  const initialise=patched.indexOf('m_azEl.setLocation(mainSettings.getLatitude(), mainSettings.getLongitude(), mainSettings.getAltitude());');
  assert.ok(initialise>patched.indexOf('m_statsTime = m_frameRateTime;'));
  assert.ok(initialise<patched.indexOf('initCoverageMap();'));
  assert.match(patched,/connect\(&MainCore::instance\(\)->getSettings\(\), &MainSettings::preferenceChanged,[\s\S]*\[this\]\(int elementType\)[\s\S]*Preferences::Latitude[\s\S]*Preferences::Longitude[\s\S]*Preferences::Altitude[\s\S]*Qt::QueuedConnection\);/);
  assert.ok(patched.indexOf('setPosition(mainSettings.getLatitude(), mainSettings.getLongitude(), mainSettings.getAltitude());')<patched.indexOf('Aircraft3DModels::instance();'));

  const second=await patchAdsbHeadless(tree.root);
  assert.equal(second.changed,false);
  assert.equal(await readFile(tree.source,'utf8'),patched);
  assert.equal(await readFile(tree.backup,'utf8'),fixture);
  assert.equal(before.uid,backupMetadata.uid);
  assert.equal(before.gid,backupMetadata.gid);
});

test('rejects an unknown tracker without creating a backup',async()=>{
  const unknown=fixture.replace('    initCoverageMap();','    initialiseCoverage();');
  const tree=await sourceTree(unknown);
  await assert.rejects(patchAdsbHeadless(tree.root),/Unsupported SDRangel ADS-B tracker source.*constructor anchor/);
  assert.equal(await readFile(tree.source,'utf8'),unknown);
  await assert.rejects(readFile(tree.backup,'utf8'),error=>error.code==='ENOENT');
});

test('rejects a partial patch instead of compounding it',async()=>{
  const partial=fixture.replace('    initCoverageMap();','    // Open Air headless ADS-B: initialise the station position without the GUI.\n    initCoverageMap();');
  const tree=await sourceTree(partial);
  await assert.rejects(patchAdsbHeadless(tree.root),/incomplete or altered Open Air patch/);
  assert.equal(await readFile(tree.source,'utf8'),partial);
});
