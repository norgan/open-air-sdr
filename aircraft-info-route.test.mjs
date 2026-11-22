import assert from 'node:assert/strict';
import {test} from 'node:test';
import {appServer} from './server.mjs';

test('aircraft identity is on demand, validates input and returns no network positions or receiver changes',async t=>{
  const port=18904;
  const root='http://127.0.0.1:'+port;
  const requests=[];
  let reads=0,tunes=0;
  const service=appServer({
    async snapshot(){reads++;return {source:'adsb',connected:true,running:true,aircraft:[]};},
    async tune(){tunes++;throw Error('Identity lookup must not tune');},
  },port,{aircraftInfoRequest:async url=>{
    requests.push(String(url));
    if(String(url).startsWith('https://api.planespotters.net/')){
      return Response.json({photos:[{thumbnail:{src:'https://t.plnspttrs.net/12345/test_t.jpg',width:200,height:133},
        link:'https://www.planespotters.net/photo/12345/test',photographer:'Test photographer'}]});
    }
    if(String(url).includes('/aircraft/')){
      return Response.json({response:{aircraft:{mode_s:'7C6DDD',registration:'VH-TEST',icao_type:'B738',type:'737-838',manufacturer:'Boeing'},
        flightroute:{callsign:'QFA790',callsign_icao:'QFA790',callsign_iata:'QF790',
          airline:{name:'Qantas',icao:'QFA',iata:'QF'},origin:{latitude:10,longitude:20},destination:{latitude:30,longitude:40}}}});
    }
    return Response.json({response:[]});
  }});
  await new Promise((resolve,reject)=>{service.once('error',reject);service.listen(port,'127.0.0.1',resolve);});
  t.after(()=>{service.closeAllConnections();service.close();});
  assert.equal(requests.length,0);
  for(const path of ['/api/aircraft-info','/api/aircraft-info?hex=bad',
    '/api/aircraft-info?hex=7c6ddd&hex=abc123',
    '/api/aircraft-info?hex=7c6ddd&callsign=QFA790&callsign=AAL100',
    '/api/aircraft-info?hex=7c6ddd&callsign=https%3A%2F%2Fexample.com']){
    assert.equal((await fetch(root+path)).status,400,path);
  }
  assert.equal((await fetch(root+'/api/aircraft-info?hex=7c6ddd&callsign=QFA790',
    {headers:{Origin:'https://another.example'}})).status,403);
  assert.equal(requests.length,0);
  const response=await fetch(root+'/api/aircraft-info?hex=7c6ddd&callsign=QFA790');
  assert.equal(response.status,200);
  const info=await response.json();
  assert.equal(info.hex,'7c6ddd');
  assert.equal(info.callsign,'QFA790');
  assert.equal(info.airline,'Qantas');
  assert.equal(info.flightNumber,'QF790');
  assert.equal(info.registration,'VH-TEST');
  assert.equal(info.photo.photographer,'Test photographer');
  assert.doesNotMatch(JSON.stringify(info),/latitude|longitude|origin|destination/);
  assert.equal(reads,0);
  assert.equal(tunes,0);
  assert.equal(requests.length,2);
  await fetch(root+'/api/aircraft-info?hex=7c6ddd&callsign=QFA790');
  assert.equal(requests.length,2,'repeat card openings use the bounded metadata cache');
  assert.match(response.headers.get('content-security-policy'),/https:\/\/t\.plnspttrs\.net/);
});
