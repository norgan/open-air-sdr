import assert from 'node:assert/strict';
import {test} from 'node:test';
import {aircraftLabel, createCallsignLabels, radioCallsign} from './aircraft-callsign.mjs';

test('radio labels preserve the broadcast suffix and keep other identifiers separate', () => {
  assert.equal(aircraftLabel({callsign:' VOZ832 ',flightNumber:'VA830'}),'Velocity 832');
  assert.equal(aircraftLabel({callsign:'QTR69K'}),'Qatari 69K');
  assert.equal(aircraftLabel({callsign:'QFA007'}),'Qantas 007');
  assert.equal(aircraftLabel({callsign:'QLK17D'}),'Q Link 17D');
  assert.equal(aircraftLabel({callsign:'XGN',registration:'VH-XGN'}),'XGN');
  assert.equal(aircraftLabel({callsign:'CAR 5'}),'CAR 5');
  assert.equal(aircraftLabel({callsign:'ZZZ777'}),'ZZZ777');
  assert.equal(aircraftLabel({registration:'VH-XGN'}),'VH-XGN');
  assert.equal(radioCallsign({flightNumber:'QF790'}),'');
  assert.equal(radioCallsign({callsign:'ZZZ777',atcCallsign:'Example Air 778'}),'');
});

test('unknown radio designators use a shared background lookup keyed by exact prefix', async () => {
  const requested=[];
  const labelTracks=createCallsignLabels({request:async url=>{
    requested.push(url);
    return {ok:true,json:async()=>({response:[
      {icao:'OTHER',name:'Other Airline',callsign:'OTHER CALL'},
      {icao:'ZZZ',name:'Example International',callsign:'EXAMPLE AIR'},
    ]})};
  }});
  const tracks=[{hex:'abc123',callsign:'ZZZ777',lat:10},{hex:'abc124',callsign:'ZZZ78A',lat:11}];
  assert.deepEqual(labelTracks(tracks),tracks,'cold lookup must return the received tracks immediately');
  assert.deepEqual(labelTracks(tracks),tracks);
  assert.deepEqual(requested,['https://api.adsbdb.com/v0/airline/ZZZ']);
  await new Promise(setImmediate);
  const labelled=labelTracks(tracks);
  assert.deepEqual(labelled,[
    {...tracks[0],atcCallsign:'Example Air 777'},
    {...tracks[1],atcCallsign:'Example Air 78A'},
  ]);
  assert.equal(aircraftLabel(labelled[1]),'Example Air 78A');
  assert.equal(tracks[0].atcCallsign,undefined);
  assert.equal(requested.length,1);
});
