import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createAircraftNetwork} from './aircraft-network.mjs';
import {createMessageArchive, messageLimit} from './message-archive.mjs';
import {explainMessage} from './message-help.mjs';
import {appServer, Receiver} from './server.mjs';
import {sources} from './sources.mjs';

const centre={latitude:10,longitude:20};
const aircraft={hex:'abc123',flight:' TEST123 ',lat:10.01,lon:20.02,seen_pos:1,alt_baro:2500,
  alt_geom:2580,track:95,nav_heading:96,t:'A320',r:'VH-ABC',category:'A3',gs:238.5,
  baro_rate:-640,squawk:'1200',emergency:'none'};

test('network positions are shared, scoped to the map centre and expire after a quota response',async()=>{
  let time=Date.parse('2026-11-21T08:00:00Z');
  let requests=0;
  const load=createAircraftNetwork({now:()=>time,request:async(url,options)=>{
    assert.equal(url,'https://api.adsb.lol/v2/lat/10/lon/20/dist/80');
    assert.equal(options.redirect,'error');
    requests++;
    if(requests>1)return new Response(null,{status:429,headers:{'Retry-After':'120'}});
    return Response.json({ac:[aircraft,{...aircraft,flight:'STALE',seen_pos:65},
      {...aircraft,hex:'abc123',lat:49.8}, {...aircraft,hex:'abc124',lon:454}]});
  }});
  const [first,shared] = await Promise.all([load(centre),load(centre)]);
  assert.equal(requests,1);
  assert.deepEqual(first,shared);
  assert.equal(first.aircraft.length,1);
  assert.equal(first.aircraft[0].title,'TEST123');
  assert.equal(first.aircraft[0].source,'adsb.lol');
  assert.equal(first.aircraft[0].registration,'VH-ABC');
  assert.equal(first.aircraft[0].aircraftType,'A320');
  assert.equal(first.aircraft[0].alt,2500);
  assert.equal(first.aircraft[0].altGeom,2580);
  assert.equal(first.aircraft[0].speed,238.5);
  assert.equal(first.aircraft[0].verticalRate,-640);
  assert.equal(first.aircraft[0].squawk,'1200');
  assert.equal(first.aircraft[0].seen,1);
  assert.ok(first.aircraft[0].distanceKm>2 && first.aircraft[0].distanceKm<3);
  time+=16_000;
  assert.equal((await load(centre)).status,'rate-limited');
  time+=35_000;
  assert.deepEqual((await load(centre)).aircraft,[]);
  assert.equal(requests,2);
  assert.equal((await load(null)).status,'setup');
});

test('the archive retains the latest 500 frames across process instances and deduplicates rereads',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'open-air-messages-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const path=join(dir,'messages.json');
  const archive=createMessageArchive(path);
  const next={title:'Test aircraft',tag:'H1',detail:'Frame 0',mode:'acars',frequency:131_554_000,time:'2026-11-21T08:00:00Z'};
  const received=Array.from({length:messageLimit+1},(_,n)=>({...next,detail:`Frame ${n}`}));
  await archive.append(received);
  await archive.append([next]);
  const result=await createMessageArchive(path).read();
  assert.equal(result.messages.length,messageLimit);
  assert.match(result.messages[0].id,/^[0-9a-f]{24}$/);
  assert.deepEqual({...result.messages[0],id:undefined},{...next,id:undefined});
  assert.deepEqual({...result.messages[1],id:undefined},{...received[1],id:undefined});
  assert.equal(result.messages[0].id,(await archive.read()).messages[0].id);
  assert.equal(result.warning,'');
});

test('legacy message archives gain stable identities without requiring raw frames',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'open-air-legacy-messages-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const path=join(dir,'messages.json');
  const legacy={title:'Legacy aircraft',tag:'Q0',detail:'ACK',mode:'acars',frequency:131_550_000,time:'2026-11-20T08:00:00Z'};
  await writeFile(path,JSON.stringify([legacy]));
  const first=await createMessageArchive(path).read();
  const second=await createMessageArchive(path).read();
  assert.deepEqual({...first.messages[0],id:undefined},{...legacy,id:undefined});
  assert.equal(first.messages[0].raw,undefined);
  assert.match(first.messages[0].id,/^[0-9a-f]{24}$/);
  assert.equal(second.messages[0].id,first.messages[0].id);
});

test('leaving an ACARS channel archives the unflushed capture before removing its log',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'open-air-capture-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const capture=join(dir,'capture.csv');
  const time='2026-11-21T08:00:00Z';
  const frame=Buffer.from([1,0x32,...Buffer.from('.VH-XYZ'),0x15,0x48,0x31,0x32,2,...Buffer.from('TEST AIRFRAME'),3,0,0]);
  await writeFile(capture,`Time,Data\n${time},${frame.toString('hex')}\n`);
  let settings={logEnabled:1,logFilename:capture};
  const archive=createMessageArchive(join(dir,'messages.json'));
  const receiver=new Receiver({async call(name,args){
    if(name==='get_channel_settings')return {acarsDemodSettings:settings};
    assert.equal(name,'set_channel_settings');
    settings={...settings,...args.settings};
  }},0,capture,archive);
  receiver.captureOwner={channelIndex:1,before:{logEnabled:0,logFilename:'acars_log.csv'}};
  receiver.captureMode=0;
  receiver.captureFrequency=131_554_000;
  await receiver.releaseCapture();
  const result=await archive.read();
  assert.equal(result.messages.length,1);
  assert.match(result.messages[0].id,/^[0-9a-f]{24}$/);
  assert.deepEqual({...result.messages[0],id:undefined},{
    mode:'acars',frequency:131_554_000,time,title:'VH-XYZ',tag:'H1',detail:'TEST AIRFRAME',raw:frame.toString('hex'),id:undefined
  });
  assert.equal(settings.logEnabled,0);
  await assert.rejects(stat(capture),{code:'ENOENT'});
});

test('message help expands verified codes and recognises coordinates without guessing numeric fields',()=>{
  assert.match(explainMessage({tag:'QQ',detail:'SYNTHETIC DEPARTURE'}).summary,/Departure report/);
  assert.match(explainMessage({tag:'49',detail:'TEST YMMLYBBN'}).fields[0],/Melbourne and Brisbane/);
  const position=explainMessage({tag:'16',detail:'M98AQR000K-,S 21.500,E 120.750,999,999'});
  assert.match(position.summary,/position report/);
  assert.ok(position.fields.some(line=>line.includes('21.500° S, 120.750° E')));
  assert.ok(position.fields.every(line=>!line.includes('999')));
  assert.match(explainMessage({tag:'H1',detail:'D14AQR000K#DFB123'}).fields.at(-1),/data acquisition/);
  assert.match(explainMessage({tag:'B6',detail:'TEST.ADS.VH-XYZ'}).summary,/ADS-C/);
});

test('authenticated Tower positions, scanners and message history share the receiver without retuning for the map',async t=>{
  const root='http://127.0.0.1:18898';
  const tower=sources.find(source=>source.id==='tower');
  const tunes=[];
  const archive=createMessageArchive();
  await archive.append([{mode:'acars',frequency:131_554_000,title:'Test',tag:'QQ',detail:'Test',time:'2026-11-21T08:00:00Z'}]);
  const radio={selectedSource:tower,archive,
    async snapshot(){return {connected:true,running:true,source:this.selectedSource.id,sourceName:this.selectedSource.name,
      frequency:this.selectedSource.centre+this.selectedSource.offset,mode:'am',squelch:true};},
    async tune(id,custom,squelch,options){
      this.selectedSource=options?.recall??sources.find(source=>source.id===id);
      tunes.push(this.selectedSource);
      return this.snapshot();
    }
  };
  const server=appServer(radio,18898,{origin:'https://radio.example.test',
    access:{username:'test',password:'browser-pass',haToken:'integration-token'},
    aircraftRequest:async()=>Response.json({ac:[aircraft]}),
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(18898,'127.0.0.1',resolve);});
  t.after(()=>{server.closeAllConnections();server.close();});
  const auth={Authorization:'Basic '+Buffer.from('test:browser-pass').toString('base64')};
  const ha={'X-Open-Air-Token':'integration-token'};
  assert.equal((await fetch(root+'/api/messages')).status,401);
  assert.equal((await fetch(root+'/api/ha/state',{headers:auth})).status,401);
  const messages=await fetch(root+'/api/messages',{headers:auth});
  assert.equal((await messages.json()).messages.length,1);
  assert.equal((await fetch(root+'/api/messages',{headers:{...auth,'If-None-Match':messages.headers.get('etag')}})).status,304);
  await fetch(root+'/api/state',{headers:auth});
  const control=async(path,body,headers=auth)=>{
    const response=await fetch(root+path,{method:'POST',headers:{...headers,Origin:root,'Content-Type':'application/json'},body:JSON.stringify(body)});
    assert.equal(response.status,200);
    return response.json();
  };
  await control('/api/profile',{name:'Test locality',includeSydney:true,aircraftCentre:centre,
    scan:{startFrequency:118_000_000,stopFrequency:118_010_000,threshold:13},presets:[]});
  const sweep=await control('/api/tower-scan',{running:true,squelch:-78});
  assert.equal(sweep.towerScan.status,'scanning');
  assert.equal(tunes[0].settings.squelch,-78);
  const map=await fetch(root+'/api/tower/aircraft',{headers:auth});
  assert.equal((await map.json()).aircraft.length,1);
  assert.deepEqual(tunes.map(source=>source.id),['tower']);
  const stop=await control('/api/ha/tower-scan',{running:false},ha);
  assert.equal(stop.towerScan.status,'idle');
  const profile={name:'Test locality',includeSydney:false,aircraftCentre:centre,
    scan:{startFrequency:118_000_000,stopFrequency:118_010_000,threshold:13},
    presets:[{frequency:118_080_000,name:'Local tower',mode:'am'}]};
  const catalog=await control('/api/profile',profile);
  assert.ok(catalog.revision);
  const sourcesResponse=await (await fetch(root+'/api/ha/sources',{headers:ha})).json();
  assert.ok(sourcesResponse.sources.some(source=>source.name==='Local tower'));
  assert.ok(sourcesResponse.sources.some(source=>source.id==='cb40'));
  assert.ok(!sourcesResponse.sources.some(source=>source.id==='tower'));
});
