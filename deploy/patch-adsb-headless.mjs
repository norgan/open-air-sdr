import { constants, chmod, chown, copyFile, readFile, stat, utimes, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const trackerRelativePath=join('plugins','channelrx','demodadsb','adsbdemodtracker.cpp');
const backupSuffix='.open-air.orig';
const constructorMarker='Open Air headless ADS-B: initialise the station position without the GUI.';
const updateMarker='Open Air headless ADS-B: follow changes to Preferences > My Position.';

function count(source,needle) {
  return source.split(needle).length-1;
}

function unsupported(reason) {
  throw Error(`Unsupported SDRangel ADS-B tracker source: ${reason}. Expected the v8.1.0 tracker structure.`);
}

function patchText(source) {
  const eol=source.includes('\r\n')?'\r\n':'\n';
  const constructorAnchor=[
    '    m_frameRateTime = QDateTime::currentDateTime();',
    '    m_statsTime = m_frameRateTime;',
    '',
    '    initCoverageMap();'
  ].join(eol);
  const constructorReplacement=[
    '    m_frameRateTime = QDateTime::currentDateTime();',
    '    m_statsTime = m_frameRateTime;',
    '',
    `    // ${constructorMarker}`,
    '    const MainSettings& mainSettings = MainCore::instance()->getSettings();',
    '    m_azEl.setLocation(mainSettings.getLatitude(), mainSettings.getLongitude(), mainSettings.getAltitude());',
    '',
    '    initCoverageMap();'
  ].join(eol);
  const updateAnchor=[
    'void ADSBDemodTracker::startWork()',
    '{',
    '    // Build the shared 3D model tables now rather than letting the first aircraft report'
  ].join(eol);
  const updateReplacement=[
    'void ADSBDemodTracker::startWork()',
    '{',
    `    // ${updateMarker}`,
    '    const MainSettings& mainSettings = MainCore::instance()->getSettings();',
    '    setPosition(mainSettings.getLatitude(), mainSettings.getLongitude(), mainSettings.getAltitude());',
    '    connect(&MainCore::instance()->getSettings(), &MainSettings::preferenceChanged,',
    '            this,',
    '            [this](int elementType)',
    '            {',
    '                const Preferences::ElementType preference = static_cast<Preferences::ElementType>(elementType);',
    '                if (   (preference == Preferences::Latitude)',
    '                    || (preference == Preferences::Longitude)',
    '                    || (preference == Preferences::Altitude))',
    '                {',
    '                    const MainSettings& settings = MainCore::instance()->getSettings();',
    '                    setPosition(settings.getLatitude(), settings.getLongitude(), settings.getAltitude());',
    '                }',
    '            },',
    '            Qt::QueuedConnection);',
    '',
    '    // Build the shared 3D model tables now rather than letting the first aircraft report'
  ].join(eol);

  const constructorMarkers=count(source,constructorMarker);
  const updateMarkers=count(source,updateMarker);
  if(constructorMarkers||updateMarkers){
    if(constructorMarkers!==1||updateMarkers!==1||
       count(source,constructorReplacement)!==1||count(source,updateReplacement)!==1){
      unsupported('an incomplete or altered Open Air patch is present');
    }
    return {changed:false,content:source};
  }

  if(!source.includes('#include "maincore.h"')||
     !source.includes('ADSBDemodTracker::ADSBDemodTracker(ADSBDemod *adsbDemod) :')||
     !source.includes('void ADSBDemodTracker::setPosition(float latitude, float longitude, float altitude)')){
    unsupported('the required v8.1.0 declarations are missing');
  }
  if(count(source,constructorAnchor)!==1)unsupported('the constructor anchor is missing or ambiguous');
  if(count(source,updateAnchor)!==1)unsupported('the startWork anchor is missing or ambiguous');

  return {
    changed:true,
    content:source.replace(constructorAnchor,constructorReplacement).replace(updateAnchor,updateReplacement)
  };
}

async function preserveBackup(sourcePath,backupPath,source,metadata) {
  try{
    await copyFile(sourcePath,backupPath,constants.COPYFILE_EXCL);
    await chown(backupPath,metadata.uid,metadata.gid);
    await chmod(backupPath,metadata.mode&0o7777);
    await utimes(backupPath,metadata.atime,metadata.mtime);
  }catch(error){
    if(error.code!=='EEXIST')throw error;
    if(await readFile(backupPath,'utf8')!==source){
      throw Error(`Refusing to overwrite mismatched backup ${backupPath}`);
    }
  }
}

export async function patchAdsbHeadless(sourceRoot) {
  if(typeof sourceRoot!=='string'||!sourceRoot.trim())throw Error('Specify the SDRangel source root.');
  const root=resolve(sourceRoot);
  const sourcePath=resolve(root,trackerRelativePath);
  const backupPath=sourcePath+backupSuffix;
  const source=await readFile(sourcePath,'utf8');
  const patch=patchText(source);
  if(!patch.changed)return {changed:false,sourcePath,backupPath};

  const metadata=await stat(sourcePath);
  await preserveBackup(sourcePath,backupPath,source,metadata);
  await writeFile(sourcePath,patch.content,'utf8');
  await chmod(sourcePath,metadata.mode&0o7777);
  return {changed:true,sourcePath,backupPath};
}

if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  try{
    const result=await patchAdsbHeadless(process.argv[2]);
    console.log(result.changed?'Patched SDRangel ADS-B for headless station positioning.':'SDRangel ADS-B headless positioning patch is already applied.');
  }catch(error){
    console.error(error.message);
    process.exitCode=1;
  }
}
