import test from 'node:test';
import assert from 'node:assert/strict';
import { configureReceiver } from './deploy/bootstrap.mjs';

test('station reference is validated before any receiver requests',async()=>{
  for(const env of [
    {OPEN_AIR_STATION_LATITUDE:'10'},
    {OPEN_AIR_STATION_LATITUDE:'',OPEN_AIR_STATION_LONGITUDE:'20'},
    {OPEN_AIR_STATION_LATITUDE:'91',OPEN_AIR_STATION_LONGITUDE:'20'},
    {OPEN_AIR_STATION_LATITUDE:'10',OPEN_AIR_STATION_LONGITUDE:'181'},
    {OPEN_AIR_STATION_LATITUDE:'NaN',OPEN_AIR_STATION_LONGITUDE:'20'},
  ]){
    let requests=0;
    await assert.rejects(configureReceiver({env,request:async()=>{requests++;throw Error('Unexpected request');}}),/Set both valid/);
    assert.equal(requests,0);
  }
});

test('bootstrap confirms the station before constructing any receiver channels',async()=>{
  const seen=[];
  let location;
  const request=async(url,options)=>{
    const path=new URL(url).pathname.slice('/sdrangel'.length);
    seen.push(options.method+' '+path);
    if(path==='')return Response.json({});
    if(path==='/location'&&options.method==='PUT'){
      location=JSON.parse(options.body);return Response.json(location);
    }
    if(path==='/location')return Response.json(location);
    if(path==='/devices')throw Error('End of station ordering test');
    throw Error('Unexpected request');
  };
  await assert.rejects(configureReceiver({request,delay:async()=>{},env:{
    OPEN_AIR_STATION_LATITUDE:'10.25',OPEN_AIR_STATION_LONGITUDE:'20.5'
  }}),/End of station/);
  assert.deepEqual(location,{latitude:10.25,longitude:20.5});
  assert.deepEqual(seen,['GET ','PUT /location','GET /location','GET /devices']);
});
