import assert from 'node:assert/strict';
import {test} from 'node:test';
import {aircraftIdentity,createAircraftSelection} from './aircraft-selection.mjs';

const plane={hex:'ABC123',callsign:'QFA790',registration:'VH-TEST',flightNumber:'QF790',lat:51,lon:-1};
test('selection identities contain only exact aircraft identifiers',()=>{
  assert.deepEqual(aircraftIdentity(plane),{hex:'abc123',callsign:'QFA790',registration:'VH-TEST',flightNumber:'QF790'});
  assert.equal(aircraftIdentity({hex:'abc123junk',title:'not an aircraft'}),null);
  assert.deepEqual(aircraftIdentity({title:'.A7-BAG'}),{hex:'',callsign:'',registration:'A7-BAG',flightNumber:''});
  assert.equal(aircraftIdentity({title:'NO POSITION'}),null);
});
test('hex identity wins and prevents matching different aircraft with the same callsign',()=>{
  const state=createAircraftSelection();
  state.selectAircraft(plane);
  assert.equal(state.matchesAircraft({...plane,hex:'abc124'}),false);
  assert.equal(state.matchesAircraft({hex:'abc123',callsign:'CHANGED'}),true);
  assert.equal(state.matchesAircraft({callsign:'790'}),false);
  assert.equal(state.matchesAircraft({callsign:'QFA79'}),false);
});
test('known registration links decoded messages to their aircraft without positions',()=>{
  const state=createAircraftSelection();
  state.rememberAircraftIdentity(plane);
  const selected=state.selectAircraft({title:'VH-TEST'},{origin:'message'});
  assert.equal(selected.hex,'abc123');
  assert.equal(state.matchesAircraft({hex:'abc123'}),true);
  assert.equal(state.matchesAircraft({title:'VH-OTHER'}),false);
  assert.equal(state.matchesAircraft({registration:'VHTEST'}),true);
  assert.equal(state.matchesAircraft({registration:'VH-OTHER',callsign:'QFA790'}),false);
});
test('confirmed flight-number alias matches whole identifiers and ambiguous callsigns do not match',()=>{
  const state=createAircraftSelection();
  state.rememberAircraftIdentity(plane);
  state.selectAircraft({callsign:'QF790'});
  assert.equal(state.selectedAircraft().hex,'abc123');
  state.rememberAircraftIdentity({hex:'abc124',callsign:'QFA790',registration:'VH-OTHER'});
  state.selectAircraft({hex:'abc123'});
  assert.equal(state.matchesAircraft({callsign:'QFA790'}),false);
});
test('changed callsign replaces the old flight alias for the same hex',()=>{
  const state=createAircraftSelection();
  state.rememberAircraftIdentity(plane);
  state.rememberAircraftIdentity({...plane,callsign:'QFA791',flightNumber:'QF791'});
  state.selectAircraft({hex:'abc123'});
  assert.equal(state.matchesAircraft({callsign:'QFA790'}),false);
  assert.equal(state.matchesAircraft({callsign:'QF791'}),true);
  state.rememberAircraftIdentity({hex:'abc123',callsign:'QFA792'});
  assert.equal(state.matchesAircraft({callsign:'QF791'}),false);
});
test('registry is bounded and does not retain aliases of evicted aircraft',()=>{
  const state=createAircraftSelection({maxEntries:1});
  state.rememberAircraftIdentity(plane);
  state.rememberAircraftIdentity({hex:'abc124',registration:'VH-OTHER'});
  state.selectAircraft({registration:'VH-TEST'});
  assert.equal(state.selectedAircraft().hex,'');
});

test('ambiguous registration-only messages never select two hex addresses',()=>{
  const state=createAircraftSelection();
  state.rememberAircraftIdentity(plane);
  const second={hex:'abc124',registration:'VH-TEST',callsign:'OTHER12'};
  state.rememberAircraftIdentity(second);
  state.selectAircraft({title:'VH-TEST'},{origin:'message'});
  assert.equal(state.selectedAircraft().hex,'');
  assert.equal(state.matchesAircraft(plane),false);
  assert.equal(state.matchesAircraft(second),false);
  state.selectAircraft({hex:'abc123'});
  assert.equal(state.matchesAircraft({title:'VH-TEST'}),false);
  assert.equal(state.matchesAircraft({...plane,callsign:'UPDATED'}),true,'an exact hex remains authoritative');
  assert.equal(state.matchesAircraft(second),false);
});
test('selection events preserve the origin, support silent parent updates and return copies',()=>{
  const state=createAircraftSelection();
  const events=[];
  const unsubscribe=state.subscribeAircraftSelection(event=>events.push(event));
  const first=state.selectAircraft(plane,{origin:'map',reveal:true});
  first.hex='ffffff';
  assert.equal(state.selectedAircraft().hex,'abc123');
  assert.deepEqual(events.at(-1),{identity:{hex:'abc123',registration:'VH-TEST',callsign:'QFA790',flightNumber:'QF790'},origin:'map',reveal:true});
  state.selectAircraft({hex:'abc124'},{origin:'parent',notify:false});
  assert.equal(events.length,1);
  state.selectAircraft(null,{origin:'parent',reveal:false});
  assert.equal(events.at(-1).identity,null);
  unsubscribe();
});
test('metadata alias enrichment updates selection without forcing an entry open',()=>{
  const state=createAircraftSelection();
  state.selectAircraft({hex:'abc123',callsign:'QFA790'});
  let event;
  state.subscribeAircraftSelection(value=>{event=value;});
  state.rememberAircraftIdentity(plane);
  assert.equal(event.origin,'enrichment');
  assert.equal(event.reveal,false);
  assert.equal(state.matchesAircraft({title:'VH-TEST'}),true);
});

test('resolving an alias is read-only and unrelated message selection clears stale highlights',()=>{
  const state=createAircraftSelection();
  state.rememberAircraftIdentity(plane);
  state.selectAircraft(plane);
  assert.equal(state.resolveAircraftIdentity({title:'VH-TEST'}).hex,'abc123');
  assert.equal(state.selectedAircraft().hex,'abc123');
  state.selectAircraft({title:'UNRELATED',detail:'mentions VH-TEST only in its payload'},{origin:'message'});
  assert.equal(state.selectedAircraft(),null);
  assert.equal(state.matchesAircraft(plane),false);
});
