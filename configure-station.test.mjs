import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureStation } from './deploy/configure-station.mjs';

async function fixture(t,contents='OPEN_AIR_PORT=8877\nOPEN_AIR_HA_TOKEN="keep-me"\n') {
  const directory=await mkdtemp(join(tmpdir(),'open-air-station-test-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const envFile=join(directory,'open-air.env');
  await writeFile(envFile,contents,{mode:0o600});
  return {envFile,contents};
}

function radioFetch({profile,current}) {
  let applied;
  const calls=[];
  return {
    calls,
    get applied(){return applied;},
    fetch:async(url,options={})=>{
      const method=options.method||'GET';
      calls.push(method+' '+url);
      if (url==='http://127.0.0.1:8877/api/profile'&&method==='GET') return Response.json(profile);
      if (url==='http://127.0.0.1:8091/sdrangel/location'&&method==='PUT') {
        applied=JSON.parse(options.body);
        return Response.json(applied);
      }
      if (url==='http://127.0.0.1:8091/sdrangel/location'&&method==='GET') {
        return Response.json(applied??current);
      }
      throw Error('Unexpected request '+method+' '+url);
    }
  };
}

test('a distant receiver location falls back to the saved profile centre and preserves the env file',async t=>{
  const {envFile,contents}=await fixture(t);
  const mock=radioFetch({profile:{aircraftCentre:{latitude:-33.8,longitude:151.0}},current:{latitude:0,longitude:0}});
  const result=await configureStation({envFile,fetch:mock.fetch});
  assert.deepEqual(result.station,{latitude:-33.8,longitude:151});
  assert.equal(result.source,'profile');
  assert.equal(result.approximate,true);
  assert.match(result.message,/approximate CPR reference.*not a confirmed antenna position/);
  assert.deepEqual(mock.applied,result.station);
  assert.equal(await readFile(envFile,'utf8'),contents+'OPEN_AIR_STATION_LATITUDE=-33.8\nOPEN_AIR_STATION_LONGITUDE=151\n');
  assert.equal(await readFile(envFile+'.before-station-reference','utf8'),contents);
  assert.equal((await stat(envFile)).mode&0o777,0o600);
});

test('a valid nearby SDRangel location is retained as the actual antenna reference',async t=>{
  const {envFile}=await fixture(t);
  const current={latitude:-33.75,longitude:151.04};
  const mock=radioFetch({profile:{aircraftCentre:{latitude:-33.8,longitude:151}},current});
  const result=await configureStation({envFile,fetch:mock.fetch});
  assert.deepEqual(result.station,current);
  assert.equal(result.source,'receiver');
  assert.equal(result.approximate,false);
  assert.ok(result.profileDistanceKm<100);
  assert.match(result.message,/existing receiver location as the antenna reference/);
  assert.match(await readFile(envFile,'utf8'),/OPEN_AIR_STATION_LATITUDE=-33\.75\nOPEN_AIR_STATION_LONGITUDE=151\.04/);
});

test('an existing explicit reference wins and its one-time backup is not replaced',async t=>{
  const original='OPEN_AIR_HA_TOKEN="keep-me"\nOPEN_AIR_STATION_LATITUDE="-34.25"\nOPEN_AIR_STATION_LONGITUDE=150.75\n';
  const {envFile}=await fixture(t,original);
  const backup='older env backup\n';
  await writeFile(envFile+'.before-station-reference',backup,{mode:0o600});
  let applied;
  const fetch=async(url,options={})=>{
    assert.equal(url,'http://127.0.0.1:8091/sdrangel/location');
    if (options.method==='PUT') {applied=JSON.parse(options.body);return Response.json(applied);}
    return Response.json(applied);
  };
  const result=await configureStation({envFile,fetch});
  assert.equal(result.source,'environment');
  assert.deepEqual(result.station,{latitude:-34.25,longitude:150.75});
  assert.deepEqual(applied,result.station);
  assert.equal(await readFile(envFile,'utf8'),original);
  assert.equal(await readFile(envFile+'.before-station-reference','utf8'),backup);
});

test('partial, duplicate and malformed explicit references fail before requests or writes',async t=>{
  const {envFile}=await fixture(t);
  const invalid=[
    'OPEN_AIR_HA_TOKEN=keep\nOPEN_AIR_STATION_LATITUDE=10\n',
    'OPEN_AIR_STATION_LATITUDE=10\nOPEN_AIR_STATION_LONGITUDE=181\n',
    'OPEN_AIR_STATION_LATITUDE=NaN\nOPEN_AIR_STATION_LONGITUDE=20\n',
    'OPEN_AIR_STATION_LATITUDE=10\nOPEN_AIR_STATION_LATITUDE=11\nOPEN_AIR_STATION_LONGITUDE=20\n'
  ];
  for (const contents of invalid) {
    await writeFile(envFile,contents,{mode:0o600});
    let requests=0;
    await assert.rejects(configureStation({envFile,fetch:async()=>{requests++;throw Error('Unexpected request');}}),/Set both valid/);
    assert.equal(requests,0);
    assert.equal(await readFile(envFile,'utf8'),contents);
    await unlink(envFile+'.before-station-reference').catch(error=>{if(error.code!=='ENOENT')throw error;});
  }
});
