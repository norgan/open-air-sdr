import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createWeatherSchedule} from './skywatcher-schedule.mjs';

const epoch = Date.parse('2026-11-28T04:00:00Z');
const minute = 60_000;
const weather = (rise, elevation) => ({rise,peak:rise+6*minute,set:rise+12*minute,maxElevation:elevation});
const target = {satellite:57166,frequency:137900000,symbolRate:80000};
const other = {satellite:59051,frequency:137100000,symbolRate:72000};

async function fixture(t) {
  const root=await mkdtemp(join(tmpdir(),'open-air-schedule-test-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  let time=epoch, observer={latitude:-33.87,longitude:151.21}, blocked='';
  const passes = new Map([[target.satellite,[weather(epoch+minute,44)]],[other.satellite,[]]]);
  const launches=[];
  const make=()=>createWeatherSchedule({
    file:join(root,'schedule.json'),now:()=>time,site:async()=>observer,
    plan:async()=>({satellites:[...passes].map(([id,passes])=>({id,passes}))}),
    busy:()=>blocked,ready:async()=>true,
    launch:async(target,ends,complete)=>{
      const id='capture-'+(launches.length+1);
      launches.push({id,target,ends,complete});
      return {id,phase:'recording'};
    },
  });
  return {make,passes,launches,setTime:value=>{time=value;},block:reason=>{blocked=reason;},move:centre=>{observer=centre;}};
}

test('a queued pass survives a server restart and starts only as the pass approaches',async t=>{
  const f=await fixture(t);
  const before=f.make();
  const rise=epoch+minute;
  const queued=await before.request({action:'queue',...target,rise});
  assert.equal(queued.jobs[0].phase,'queued');
  const restarted=f.make();
  await restarted.tick();
  assert.equal(f.launches.length,0,'clicking Schedule does not retune early');
  f.setTime(rise-19_000);
  await restarted.tick();
  assert.equal(f.launches.length,1);
  assert.equal(f.launches[0].target.satellite.id,target.satellite);
  assert.equal(f.launches[0].target.symbolRate,80000);
  assert.equal(f.launches[0].ends,rise+12*minute+15000);
  assert.equal((await restarted.status()).jobs[0].captureId,'capture-1');
  await f.launches[0].complete({phase:'complete'});
  assert.equal((await restarted.status()).jobs[0].phase,'complete');
  await restarted.tick();
  assert.equal(f.launches.length,1);
});

test('automatic captures prefer higher peaks and give a manually queued pass priority',async t=>{
  const f=await fixture(t);
  const service=f.make();
  const rise=epoch+minute;
  f.passes.get(other.satellite).push(weather(rise+minute,82));
  await service.request({action:'settings',settings:{enabled:true,minElevation:30,targets:[
    {...target,enabled:true},{...other,enabled:true},
  ]}});
  await service.tick();
  assert.deepEqual((await service.status()).upcoming.map(p=>p.satellite),[other.satellite]);
  await service.request({action:'queue',...target,rise});
  f.setTime(rise);
  await service.tick();
  assert.equal(f.launches[0].target.satellite.id,target.satellite);
  assert.deepEqual((await service.status()).upcoming,[]);
  await f.launches[0].complete({phase:'failed',message:'No weather image decoded.'});
  f.passes.get(target.satellite)[0]=weather(rise+5000,45);
  await service.tick();
  assert.equal(f.launches.length,1,'the same pass is not queued again when its prediction shifts');
});

test('queued captures wait for active scans, and stale or cancelled jobs do not retune',async t=>{
  const f=await fixture(t);
  const service=f.make();
  const rise=epoch+minute;
  const queued=await service.request({action:'queue',...target,rise});
  f.block('Waiting for the active radio scan to finish.');
  f.setTime(rise);
  await service.tick();
  assert.equal(f.launches.length,0);
  assert.match((await service.status()).note,/scan/);
  f.setTime(rise+7*minute);
  f.block('');
  await service.tick();
  assert.equal(f.launches.length,0);
  assert.equal((await service.status()).jobs.find(item=>item.id===queued.jobs[0].id).phase,'missed');

  const next=rise+100*minute;
  f.passes.get(target.satellite).push(weather(next,54));
  const pending=await service.request({action:'queue',...target,rise:next});
  await service.request({action:'cancel',id:pending.jobs.find(job=>job.phase==='queued').id});
  f.setTime(next);
  await service.tick();
  assert.equal(f.launches.length,0);
  const later=next+100*minute;
  f.passes.get(target.satellite).push(weather(later,57));
  await service.request({action:'queue',...target,rise:later});
  f.move({latitude:-27.47,longitude:153.02});
  f.setTime(later);
  await service.tick();
  assert.match((await service.status()).jobs.find(job=>job.rise===later).message,/location changed/);
  assert.equal(f.launches.length,0);
});
