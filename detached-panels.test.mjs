import test from 'node:test';
import assert from 'node:assert/strict';
import {aircraftPanelState,initialiseDetachedPanels} from './detached-panels.mjs';

function fixture({blocked=false}={}) {
  const origin='http://127.0.0.1:18896';
  const events=new Map();
  const elements=new Map(['aircraft-popout','waterfall-popout','detached-panel-notice'].map(id=>[id,{hidden:true,textContent:'',addEventListener(){},removeEventListener(){}}]));
  const opened=[],views=[],selections=[],changes=[];
  let clock=1000,interval;
  const win={location:{origin},crypto:{randomUUID:()=> '01234567-89ab-cdef-0123-456789abcdef'},
    addEventListener:(event,handler)=>events.set(event,handler),removeEventListener:event=>events.delete(event),
    setInterval:handler=>{interval=handler;return 1;},clearInterval:()=>{interval=undefined;},
    open(url,name,features){
      if(blocked)return null;
      const messages=[];
      const child={closed:false,messages,focused:0,focus(){child.focused++;},close(){child.closed=true;},
        postMessage(data,targetOrigin){messages.push({data,targetOrigin});}};
      opened.push({child,url,name,features});return child;
    },
  };
  const doc={getElementById:id=>elements.get(id)};
  const api=initialiseDetachedPanels({document:doc,window:win,now:()=>clock,
    onAircraftView:view=>views.push(view),onAircraftSelect:identity=>selections.push(identity),onPanelsChanged:()=>changes.push(api?.hasOpenPanels())});
  function receive(kind,type,payload,{source,origin:messageOrigin=origin,token='01234567-89ab-cdef-0123-456789abcdef'}={}) {
    const child=opened.find(item=>item.url.includes('panel='+kind))?.child;
    events.get('message')({source:source??child,origin:messageOrigin,
      data:{channel:'open-air-detached-panel',token,panel:kind,type,payload}});
  }
  return {api,opened,elements,views,selections,changes,receive,setTime:value=>{clock=value;},tick:()=>interval?.(),emit:event=>events.get(event)?.()};
}

test('aircraft snapshots retain source facts while excluding arbitrary payload fields',()=>{
  const state=aircraftPanelState({display:'radar',tag:'LOCAL RF',active:false,status:'Select ADS-B',updated:100,
    centre:{latitude:10,longitude:20},items:[{hex:'abc123',title:'TEST1',source:'Local receiver',lat:10,lon:20,
      callsign:'TEST1',registration:'VH-ABC',aircraftType:'A320',alt:4200,speed:140,password:'secret'}],
    appearance:{colour:'#ffd166',outline:'#101820',size:28,mapOpacity:75},unknown:'discard'});
  assert.equal(state.display,'radar');assert.equal(state.tag,'LOCAL RF');assert.equal(state.active,false);
  assert.equal(state.status,'Select ADS-B');assert.equal(state.updated,100);
  assert.equal(state.items[0].source,'Local receiver');assert.equal(state.items[0].alt,4200);
  assert.equal(state.items[0].password,undefined);assert.equal(state.unknown,undefined);
});

test('opening a panel is opt-in, resizable and reuses the existing child window',()=>{
  const f=fixture();
  assert.equal(f.opened.length,0);assert.equal(f.api.hasOpenPanels(),false);
  const child=f.api.open('aircraft');
  assert.equal(f.api.hasOpenPanels('aircraft'),true,'live receiver can stay active before the ready handshake');
  assert.equal(f.opened.length,1);assert.match(f.opened[0].features,/resizable=yes/);
  const url=new URL(f.opened[0].url);
  assert.equal(url.origin,'http://127.0.0.1:18896');assert.equal(url.pathname,'/detached-panel.html');
  assert.equal(url.searchParams.get('panel'),'aircraft');
  assert.equal(f.api.open('aircraft'),child);assert.equal(f.opened.length,1);assert.equal(child.focused,1);
  child.closed=true;f.tick();
  assert.equal(f.api.hasOpenPanels(),false);assert.deepEqual(f.changes,[true,false]);
  f.api.open('aircraft');assert.equal(f.opened.length,2);
  f.api.close();
});

test('only the correct same-origin child and nonce can subscribe or change the display',()=>{
  const f=fixture();
  f.api.updateAircraft({items:[{hex:'abc123',title:'LOCAL1',lat:10,lon:20}],centre:{latitude:10,longitude:20},tag:'LOCAL RF'});
  const child=f.api.open('aircraft');
  f.receive('aircraft','ready',null,{origin:'https://unrelated.example'});
  f.receive('aircraft','ready',null,{source:{}});
  f.receive('aircraft','ready',null,{token:'incorrect'});
  assert.equal(child.messages.length,0);
  f.receive('aircraft','ready');
  assert.equal(child.messages.length,1);
  assert.equal(child.messages[0].targetOrigin,'http://127.0.0.1:18896');
  assert.equal(child.messages[0].data.payload.tag,'LOCAL RF');
  f.receive('aircraft','view',{display:'radar'});
  f.receive('aircraft','view',{display:'tune'});
  f.receive('waterfall','view',{display:'map'});
  assert.deepEqual(f.views,['radar']);
  f.receive('aircraft','select',{identity:{hex:'ABC123',callsign:'LOCAL1',lat:10,lon:20}});
  f.receive('aircraft','select',{identity:{}});
  assert.deepEqual(f.selections,[{hex:'abc123',callsign:'LOCAL1',registration:'',flightNumber:''}]);
  f.api.close();
});

test('waterfall frames are captured only for an open subscribed child and limited to four per second',()=>{
  const f=fixture();let captures=0;
  const canvas={width:512,height:192,toDataURL(){captures++;return 'data:image/png;base64,AAAA';}};
  f.api.updateWaterfall({canvas,caption:'1090 MHz',active:true});
  assert.equal(captures,0);
  const child=f.api.open('waterfall');assert.equal(captures,0);
  f.receive('waterfall','ready');assert.equal(captures,1);
  for(let n=0;n<10;n++)f.api.updateWaterfall({canvas,caption:'1090 MHz',active:true});
  assert.equal(captures,1);
  f.setTime(1250);f.api.updateWaterfall({canvas,caption:'1090 MHz',active:true});assert.equal(captures,2);
  f.setTime(1260);f.api.updateWaterfall({canvas,caption:'1090 MHz',active:false,status:'Waiting for samples'});
  assert.equal(captures,3,'stopped reception is published immediately instead of waiting for another RF frame');
  assert.equal(child.messages.at(-1).data.payload.active,false);
  assert.equal(child.messages.at(-1).data.payload.sequence,3);
  f.api.close();
});

test('parent closure and blocked popups are reported without opening another receiver session',()=>{
  const f=fixture();const child=f.api.open('aircraft');f.receive('aircraft','ready');f.emit('pagehide');
  assert.equal(child.messages.at(-1).data.type,'parent-closed');
  f.api.close();
  const blocked=fixture({blocked:true});assert.equal(blocked.api.open('aircraft'),null);
  assert.match(blocked.elements.get('detached-panel-notice').textContent,/Allow pop-ups/);
  assert.equal(blocked.api.hasOpenPanels(),false);
  blocked.api.close();
});
