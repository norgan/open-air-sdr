import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp, readFile, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {crc32} from 'node:zlib';
import {createWeatherPlanner, parseWeatherElements} from './skywatcher-orbits.mjs';
import {createWeatherCapture, satDumpArguments, validateWeatherTarget} from './skywatcher-capture.mjs';
import {appServer} from './server.mjs';

const time = Date.parse('2026-11-27T11:00:00Z');
const tle = new Map([
  [57166, '1 57166U 23091A   26331.31714885 -.00000022  00000-0  92708-5 0  9998\n2 57166  98.5878  22.7748 0004890  64.4614 295.7070 14.24057327177738'],
  [59051, '1 59051U 24039A   26331.30564656 -.00000016  00000-0  12518-4 0  9997\n2 59051  98.7262 288.7334 0008057  61.7948 298.4043 14.22444521142451'],
]);
const centre = {latitude:-33.87,longitude:151.21};

test('Meteor predictions use fresh matched elements, resolve both horizon crossings, and reuse the orbit feed', async () => {
  const requests = [];
  const planner = createWeatherPlanner({now:()=>time,request:async url=>{
    const id = Number(new URL(url).searchParams.get('CATNR'));
    requests.push(id);
    return new Response(tle.get(id));
  }});
  const setup = await planner(null);
  assert.ok(setup.satellites.every(item=>item.orbit==='setup'));
  assert.deepEqual(requests,[]);
  const plan = await planner(centre);
  assert.deepEqual(requests,[57166,59051]);
  assert.ok(plan.satellites.every(item=>item.orbit==='current' && item.passes.length>=3));
  for(const {look,passes} of plan.satellites){
    assert.ok(look.az>=0 && look.az<360);
    assert.ok(Math.abs(look.dopplerHz)<4200);
    for(const pass of passes){
      assert.ok(pass.rise<pass.peak && pass.peak<pass.set && pass.set>time);
      assert.ok(pass.maxElevation>=10);
      assert.ok(pass.path[0].el<1 && pass.path.at(-1).el<1);
    }
  }
  await planner(centre);
  assert.equal(requests.length,2);
  assert.throws(()=>parseWeatherElements(tle.get(57166),59051,time),/matching/);
  assert.throws(()=>parseWeatherElements(tle.get(57166),57166,time+16*86400000),/too old/);
});

test('SDRangel capture converts 24-bit samples, selects the SatDump pipeline and saves an image', async t => {
  const folder = await mkdtemp(join(tmpdir(),'open-air-sky-test-'));
  t.after(()=>rm(folder,{recursive:true,force:true}));
  const root = join(folder,'gallery');
  const frequency = 137100000;
  const target = validateWeatherTarget({satellite:59051,frequency,symbolRate:80000});
  let base, path, decoding = false, restored = false, completed;
  const calls = [];
  const receiver = {device:0,inspect(){},
    async channelSettings(){return {fileRecordName:base+'.sdriq'};},
    async call(method,args){
      calls.push([method,args]);
      if(method==='start_iq_recording'){
        base=join(folder,args.fileName);
        path=base+'.2026-11-27T11_00_00_000.sdriq';
        const iq=Buffer.alloc(40);
        iq.writeUInt32LE(300000,0);
        iq.writeBigUInt64LE(BigInt(frequency),4);
        iq.writeUInt32LE(24,20);
        iq.writeUInt32LE(crc32(iq.subarray(0,28)),28);
        iq.writeInt32LE(8388352,32);
        iq.writeInt32LE(-8388608,36);
        await writeFile(path,iq);
        return {channelIndex:4,fileBase:base};
      }
      if(method==='get_server_status')return {capture:{activeRecordings:[{fileBase:base,deviceSetIndex:0,channelIndex:4}]}};
      if(method==='stop_iq_recording')return {channelDeleted:true,files:[{path,sizeBytes:40}]};
      throw Error('Unexpected recorder command');
    }};
  const capture=createWeatherCapture({receiver,directory:root,now:()=>time,executable:async()=>'/fixture/satdump',
    prepare:async()=>({frequency,centre:frequency+100000}),
    decode:async (command,args)=>{
      decoding=true;
      assert.equal(command,'/fixture/satdump');
      assert.equal(capture.holdsTuner(),false,'the radio is free while SatDump processes the IQ');
      assert.equal(restored,true,'the receiver is restored before decoding');
      assert.equal(args[0],'meteor_m2-x_lrpt_80k');
      assert.equal(args[1],'baseband');
      assert.deepEqual(args.slice(4,10),['--samplerate','300000','--baseband_format','cs16','--satellite_number','M2-4']);
      assert.deepEqual(await readFile(args[2]),Buffer.from('ff7f0080','hex'));
      await writeFile(join(args[3],'weather.png'),Buffer.alloc(1024));
    }});
  const started=await capture.start(target,time+180000,{
    afterRecording(){
      assert.equal(capture.holdsTuner(),true,'the tuner stays reserved while restoring the channel');
      restored=true;
    },
    onFinish(result){completed=result;},
  });
  assert.equal(started.phase,'recording');
  assert.equal(started.ends,time+180000);
  assert.equal(capture.holdsTuner(),true);
  assert.equal(calls[0][1].frequencyOffset,-100000);
  assert.equal(calls[0][1].log2Decim,3);
  assert.equal((await capture.stop()).phase,'complete');
  assert.equal(completed.phase,'complete');
  assert.equal(completed.id,started.id);
  assert.equal(decoding,true);
  assert.equal(calls.at(-1)[1].deleteChannel,true);
  const gallery=await capture.gallery();
  assert.equal(gallery.length,1);
  assert.equal(gallery[0].images[0].name,'weather.png');
  assert.equal((await capture.image(started.id,0)).type,'image/png');
  assert.equal(await capture.image('..',0),null);
  await assert.rejects(readFile(path),{code:'ENOENT'});
  assert.equal(satDumpArguments({...target,symbolRate:72000},{sampleRate:300000,format:'cs16'},'in','out','pipeline')[1],'meteor_m2-x_lrpt');
});

test('receiver controls cannot interrupt a Skywatcher recording and the stop route uses same-origin controls', async t => {
  let stops=0, tunes=0;
  const skyCapture={holdsTuner:()=>true,status:()=>({phase:'recording'}),stop(){stops++;}};
  const server=appServer({async tune(){tunes++;}},19047,{skyCapture});
  await new Promise((ready,reject)=>{server.once('error',reject);server.listen(19047,'127.0.0.1',ready);});
  t.after(()=>{server.closeAllConnections();server.close();});
  const root='http://127.0.0.1:19047';
  const post=(path,origin)=>fetch(root+path,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:'{}'});
  assert.equal((await post('/api/tune',root)).status,409);
  assert.equal((await post('/api/skywatcher/stop','https://other.example')).status,403);
  assert.equal((await post('/api/skywatcher/stop',root)).status,202);
  assert.equal(stops,1);
  assert.equal(tunes,0);
});
