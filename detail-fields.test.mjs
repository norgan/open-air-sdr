import test from 'node:test';
import assert from 'node:assert/strict';
import { aircraftDetailFields, messageDetailFields, messageDetailKey } from './detail-fields.mjs';

const asObject = fields => Object.fromEntries(fields.map(({label,value}) => [label,value]));

test('aircraft details expose current and enriched receiver fields in a stable order', () => {
  const fields = asObject(aircraftDetailFields({
    hex:'abc123', title:'TEST12', registration:'TEST-ABC', aircraftType:'A359', category:'A5', source:'SDRangel',
    onSurface:false, emergency:false, lat:12.345678, lon:98.765432, alt:12050, altGeom:12200,
    heading:291.4, distanceKm:18.27, bearing:104.8, groundSpeed:438, verticalRate:-640,
    squawk:'4021', position:'2026-11-21T12:34:56Z', seen:4.25,
  }));
  assert.deepEqual(fields, {
    Callsign:'TEST12', 'ICAO address':'ABC123', Registration:'TEST-ABC', 'Aircraft type':'A359', Category:'A5',
    Source:'SDRangel', Status:'Airborne', Emergency:'No', Position:'12.345678°, 98.765432°',
    'Barometric altitude':'12,050 ft', 'Geometric altitude':'12,200 ft', Heading:'291°',
    'Ground speed':'438 kt', 'Vertical rate':'-640 ft/min', Squawk:'4021', Range:'18.3 km', Bearing:'105°',
    'Last position':'2026-11-21T12:34:56.000Z', 'Position age':'4.3 s',
  });
});

test('aircraft details accept provider aliases and omit absent data', () => {
  assert.deepEqual(asObject(aircraftDetailFields({hex:'abc123',title:'ABC123',tag:'GROUND',type:'B738',navigationHeading:92,speed:410,baroRate:512})), {
    'ICAO address':'ABC123', 'Aircraft type':'B738', Status:'On ground', Heading:'92°', 'Ground speed':'410 kt', 'Vertical rate':'512 ft/min',
  });
});

test('message details keep raw metadata while the payload remains a separate body', () => {
  const item={title:'TEST-01',rawLabel:'49',tag:'49 · ACARS · 131.550 MHz',mode:'acars',frequency:131_550_000,
    time:'2026-11-21T10:42:00Z',detail:'SYNTHETIC TEST PAYLOAD'};
  assert.deepEqual(asObject(messageDetailFields(item)), {
    'Aircraft or source':'TEST-01', Protocol:'ACARS', 'Message label':'49', Frequency:'131.550 MHz',
    Received:'2026-11-21T10:42:00.000Z',
  });
  assert.equal(messageDetailKey(item),messageDetailKey({...item}));
  assert.notEqual(messageDetailKey(item),messageDetailKey({...item,detail:item.detail+'1'}));
});

test('message details tolerate partial live rows and infer a display label from the compact tag', () => {
  assert.deepEqual(messageDetailFields({title:'VDL Mode 2 frame',tag:'VDL2',detail:'128 bytes received by the decoder.'}), [
    {label:'Aircraft or source',value:'VDL Mode 2 frame'},
    {label:'Message label',value:'VDL2'},
  ]);
});
