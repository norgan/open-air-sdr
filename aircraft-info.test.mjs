import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createAircraftInfo, normaliseAircraftIdentity} from './aircraft-info.mjs';

const identity={hex:'7c6ddd',callsign:'QFA790'};
const airline={name:'Qantas',icao:'QFA',iata:'QF'};
const aircraft={mode_s:'7C6DDD',registration:'VH-VZJ',type:'Boeing 737-838',icao_type:'B738',
  manufacturer:'Boeing',registered_owner:'Qantas Airways',registered_owner_operator_flag_code:'QFA'};
const route={callsign:'QFA790',callsign_icao:'QFA790',callsign_iata:'QF790',airline,
  origin:{latitude:20,longitude:30},destination:{latitude:40,longitude:50}};
const photo={thumbnail:{src:'https://t.plnspttrs.net/test/123_t.jpg',size:{width:200,height:133}},
  thumbnail_large:{src:'https://t.plnspttrs.net/test/123_280.jpg',size:{width:420,height:280}},
  link:'https://www.planespotters.net/photo/123/vh-vzj?utm_source=api',photographer:'Test Photographer'};

function providers({metadata={aircraft,flightroute:route},photos=[photo],handler}={}) {
  const calls=[];
  const request=async(url,options)=>{
    calls.push({url,options});
    const override=await handler?.(url,options);
    if(override)return override;
    if(url.startsWith('https://api.planespotters.net/'))return Response.json({photos});
    if(url.includes('/airline/'))return Response.json({response:[airline]});
    return Response.json({response:metadata});
  };
  return {calls,request};
}

test('aircraft lookup validates identifiers before making any provider request',async()=>{
  assert.deepEqual(normaliseAircraftIdentity({hex:' 7C6DDD ',callsign:' qfa790 '}),identity);
  assert.deepEqual(normaliseAircraftIdentity({hex:'7c6ddd'}),{hex:'7c6ddd',callsign:''});
  const {calls,request}=providers();
  const load=createAircraftInfo({request});
  for(const input of [null,{}, {hex:'https://evil.test'}, {hex:'7c6ddd',callsign:'QFA/790'},
    {hex:'7c6ddd',callsign:'QFA790123'}, {hex:123456}, {hex:'7c6ddd',callsign:790}]) {
    assert.throws(()=>load(input),TypeError);
  }
  assert.equal(calls.length,0);
});

test('combines matching flight identity and an attributed thumbnail without network positions',async()=>{
  const {calls,request}=providers();
  const result=await createAircraftInfo({request})(identity);
  assert.equal(result.airline,'Qantas');
  assert.equal(result.flightNumber,'QF790');
  assert.equal(result.registration,'VH-VZJ');
  assert.equal(result.aircraftType,'B738');
  assert.equal(result.model,'Boeing 737-838');
  assert.equal(result.registeredOwner,'Qantas Airways');
  assert.equal('operator' in result,false);
  assert.equal(result.photo.url,photo.thumbnail_large.src);
  assert.equal(result.photo.photographer,'Test Photographer');
  assert.equal(result.photo.link,photo.link);
  assert.equal(result.photo.width,420);
  assert.equal(result.identityStatus,'ready');
  for(const key of ['origin','destination','lat','lon','latitude','longitude','altitude','speed'])assert.equal(key in result,false);
  assert.equal(calls.length,2);
  assert.ok(calls.some(call=>call.url==='https://api.adsbdb.com/v0/aircraft/7c6ddd?callsign=QFA790'));
  for(const {options} of calls){
    assert.equal(options.redirect,'error');
    assert.ok(options.signal instanceof AbortSignal);
    assert.match(options.headers['User-Agent'],/https:\/\/github.com\/norgan\/open-air-sdr/);
  }
});

test('airline lookup falls back to the exact callsign prefix and preserves operational callsigns',async()=>{
  const {calls,request}=providers({metadata:{aircraft,flightroute:{...route,callsign:'QTR69K',callsign_icao:'QTR69K',callsign_iata:'QR69K',airline:null}},
    handler:url=>url.endsWith('/airline/QTR')?Response.json({response:[{name:'Qatar Airways',icao:'QTR',iata:'QR'}]}):null});
  const result=await createAircraftInfo({request})({hex:'7c6ddd',callsign:'QTR69K'});
  assert.equal(result.airline,'Qatar Airways');
  assert.equal(result.callsign,'QTR69K');
  assert.equal(result.flightNumber,'');
  assert.ok(calls.some(call=>call.url.endsWith('/airline/QTR')));
});

test('unmatched callsigns and mismatched aircraft cannot supply another flight identity',async()=>{
  const {request}=providers({metadata:{aircraft:{...aircraft,mode_s:'ABC123'},flightroute:{...route,callsign:'QFA999',callsign_icao:'QFA999',callsign_iata:'QF999'}}});
  const result=await createAircraftInfo({request})(identity);
  assert.equal(result.registration,'');
  assert.equal(result.flightNumber,'');
  assert.equal(result.airline,'Qantas');
});

test('404 combined lookups salvage independent aircraft and callsign records',async()=>{
  const {calls,request}=providers({handler:url=>{
    if(url.includes('?callsign='))return new Response(null,{status:404});
    if(url.includes('/callsign/'))return Response.json({response:{flightroute:route}});
    if(url.startsWith('https://api.adsbdb.com/v0/aircraft/'))return Response.json({response:{aircraft}});
  }});
  const result=await createAircraftInfo({request})(identity);
  assert.equal(result.registration,'VH-VZJ');
  assert.equal(result.flightNumber,'QF790');
  assert.ok(calls.some(call=>call.url.endsWith('/aircraft/7c6ddd')));
  assert.ok(calls.some(call=>call.url.endsWith('/callsign/QFA790')));
});

test('provider failure leaves available identity or photo usable',async()=>{
  const first=providers({handler:url=>url.startsWith('https://api.planespotters.net/')?new Response(null,{status:503}):null});
  const result=await createAircraftInfo({request:first.request})(identity);
  assert.equal(result.flightNumber,'QF790');
  assert.equal(result.photo,null);
  assert.equal(result.identityStatus,'partial');
  const second=providers({handler:url=>url.startsWith('https://api.adsbdb.com/')?new Response(null,{status:502}):null});
  const image=await createAircraftInfo({request:second.request})(identity);
  assert.equal(image.photo.photographer,'Test Photographer');
  assert.equal(image.flightNumber,'');
  assert.equal(image.identityStatus,'partial');
});

test('photos require safe provider URLs and visible attribution, with thumbnail fallback',async()=>{
  const unsafe=[{...photo,photographer:''}, {...photo,link:'https://www.planespotters.net.evil.test/photo/123'},
    {...photo,link:'javascript:alert(1)'}, {...photo,thumbnail_large:{src:'https://evil.test/a.jpg'},thumbnail:{src:'http://t.plnspttrs.net/a.jpg'}}];
  const {request}=providers({photos:unsafe});
  assert.equal((await createAircraftInfo({request})(identity)).photo,null);
  const fallback=providers({photos:[{...photo,thumbnail_large:{src:'https://evil.test/a.jpg'}}]});
  assert.equal((await createAircraftInfo({request:fallback.request})(identity)).photo.url,photo.thumbnail.src);
});

test('flight number requires an explicit numeric IATA identifier for the matched route',async()=>{
  for(const callsign_iata of ['QR69K','999999','QF12345','BA790',null]){
    const {request}=providers({metadata:{aircraft,flightroute:{...route,callsign_iata}}});
    assert.equal((await createAircraftInfo({request})(identity)).flightNumber,'');
  }
});

test('shared lookups are deduplicated, cached and protected against callers mutating results',async()=>{
  let clock=0;
  const {calls,request}=providers();
  const load=createAircraftInfo({request,now:()=>clock,successTtlMs:100,photoTtlMs:200});
  const [first,second]=await Promise.all([load(identity),load(identity)]);
  assert.equal(calls.length,2);
  first.photo.photographer='mutated';
  assert.equal(second.photo.photographer,'Test Photographer');
  assert.equal((await load(identity)).photo.photographer,'Test Photographer');
  clock=101;
  await load(identity);
  assert.equal(calls.filter(call=>call.url.startsWith('https://api.planespotters.net/')).length,1);
  assert.equal(calls.filter(call=>call.url.startsWith('https://api.adsbdb.com/')).length,2);
  clock=302;
  await load(identity);
  assert.equal(calls.filter(call=>call.url.startsWith('https://api.planespotters.net/')).length,2);
});

test('not-found and unavailable answers retry only after their short cache expires',async()=>{
  let clock=0, calls=0;
  const request=async()=>{calls++;return new Response(null,{status:404});};
  const load=createAircraftInfo({request,now:()=>clock,missingTtlMs:10});
  const input={hex:'abcdef'};
  assert.equal((await load(input)).identityStatus,'not-found');
  assert.equal(calls,2);
  await load(input);
  assert.equal(calls,2);
  clock=11;
  await load(input);
  assert.equal(calls,4);
  let failures=0;
  const fail=createAircraftInfo({now:()=>clock,failureTtlMs:10,request:async()=>{failures++;throw Error('offline');}});
  assert.equal((await fail(input)).identityStatus,'unavailable');
  await fail(input);
  assert.equal(failures,2);
  clock=22;
  await fail(input);
  assert.equal(failures,4);
});

test('cache is bounded and requests share the two-request concurrency limit',async()=>{
  let active=0, peak=0, calls=0;
  const request=async()=>{
    calls++;active++;peak=Math.max(peak,active);
    await new Promise(resolve=>setImmediate(resolve));
    active--;return new Response(null,{status:404});
  };
  const load=createAircraftInfo({request,maxEntries:1});
  await Promise.all([load({hex:'abcdef'}),load({hex:'abcdef',callsign:'XGN'})]);
  assert.ok(peak<=2);
  const before=calls;
  await load({hex:'abcdef'});
  assert.ok(calls>before,'the evicted identity is fetched again');
});

test('rate-limit responses pause that provider and excessive queues fail softly',async()=>{
  let clock=0, metadataCalls=0;
  const request=async url=>{
    if(url.startsWith('https://api.adsbdb.com/')){
      metadataCalls++;
      return new Response(null,{status:429,headers:{'Retry-After':'120'}});
    }
    return Response.json({photos:[]});
  };
  const load=createAircraftInfo({request,now:()=>clock,failureTtlMs:10});
  await load(identity);
  clock=20;
  await load({...identity,callsign:'QFA791'});
  assert.equal(metadataCalls,1);
  clock=120001;
  await load({...identity,callsign:'QFA792'});
  assert.equal(metadataCalls,2);
  let release;
  const blocking=new Promise(resolve=>{release=resolve;});
  const limited=createAircraftInfo({queueLimit:0,request:async()=>{await blocking;return new Response(null,{status:404});}});
  const first=limited({hex:'aaaaaa'});
  const second=limited({hex:'bbbbbb'});
  const overflow=await limited({hex:'cccccc'});
  assert.equal(overflow.identityStatus,'unavailable');
  release();
  await Promise.all([first,second]);
});
