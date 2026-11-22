import test from 'node:test';
import assert from 'node:assert/strict';
import {initialiseAircraftScreen} from './aircraft-screen.mjs';

function fixture({native=true,reject=false,hidden=false}={}) {
  const listeners=new WeakMap();
  const make=()=>{
    const attributes=new Map(), classes=new Set();
    const node={hidden:false,isConnected:true,textContent:'',
      classList:{add:name=>classes.add(name),remove:name=>classes.delete(name),contains:name=>classes.has(name),
        toggle(name,value){if(value)classes.add(name);else classes.delete(name);}},
      setAttribute:(name,value)=>attributes.set(name,String(value)),getAttribute:name=>attributes.get(name)??null,
      addEventListener(event,handler){const events=listeners.get(node)||new Map();events.set(event,[...(events.get(event)||[]),handler]);listeners.set(node,events);},
      removeEventListener(event,handler){const events=listeners.get(node);if(events)events.set(event,(events.get(event)||[]).filter(item=>item!==handler));},
      dispatch(event,data={}){for(const handler of listeners.get(node)?.get(event)||[])handler(data);},
      click(){node.dispatch('click');},focus(){doc.activeElement=node;},
      getClientRects(){return node.hidden?[]:[{}];},closest(){return null;},
    };
    return node;
  };
  const doc=make();
  const panel=make();
  const ids=new Map();
  for(const id of ['aircraft-display-settings','aircraft-screen-actions','aircraft-fullscreen','aircraft-screen-switch',
    'aircraft-screen-map','aircraft-screen-radar','aircraft-screen-hint','local-aircraft-layout',
    'local-show-map','local-show-radar','tower-show-map','tower-show-radar'])ids.set(id,make());
  doc.body=make();
  doc.querySelector=selector=>selector==='.panel.stage'?panel:null;
  doc.getElementById=id=>ids.get(id);
  doc.fullscreenElement=null;
  doc.fullscreenEnabled=native;
  const focusBefore=make();
  doc.activeElement=focusBefore;
  let requests=0,exits=0;
  let requestOptions;
  if(native)panel.requestFullscreen=async options=>{
    requests++;requestOptions=options;
    if(reject)throw Error('Fullscreen denied');
    doc.fullscreenElement=panel;doc.dispatch('fullscreenchange');
  };
  doc.exitFullscreen=async()=>{exits++;doc.fullscreenElement=null;doc.dispatch('fullscreenchange');};
  const scrolled=[];
  const win={scrollX:12,scrollY:350,scrollTo:(x,y)=>scrolled.push([x,y])};
  ids.get('aircraft-display-settings').hidden=hidden;
  ids.get('local-show-map').setAttribute('aria-pressed','true');
  ids.get('local-show-radar').setAttribute('aria-pressed','false');
  ids.get('tower-show-map').setAttribute('aria-pressed','false');
  ids.get('tower-show-radar').setAttribute('aria-pressed','true');
  const api=initialiseAircraftScreen({document:doc,window:win});
  return {api,doc,panel,ids,focusBefore,scrolled,counts:()=>({requests,exits,requestOptions})};
}

test('aircraft fullscreen is opt-in and available only on aircraft views',async()=>{
  const f=fixture({hidden:true});
  assert.equal(f.ids.get('aircraft-screen-actions').hidden,true);
  assert.equal(f.counts().requests,0);
  await f.api.enter();
  assert.equal(f.counts().requests,0);
  f.ids.get('aircraft-display-settings').hidden=false;
  f.api.sync();
  assert.equal(f.ids.get('aircraft-screen-actions').hidden,false);
  assert.equal(f.doc.fullscreenElement,null);
  await f.api.enter();
  assert.equal(f.doc.fullscreenElement,f.panel);
  assert.deepEqual(f.counts().requestOptions,{navigationUI:'hide'});
  assert.equal(f.ids.get('aircraft-fullscreen').textContent,'Exit fullscreen');
  assert.equal(f.ids.get('aircraft-screen-switch').hidden,false);
  await f.api.exit();
});

test('native fullscreen exit restores scroll and focus without replacing the stage',async()=>{
  const f=fixture();
  const originalPanel=f.panel;
  await f.api.enter();
  assert.equal(f.doc.activeElement,f.ids.get('aircraft-fullscreen'));
  f.doc.fullscreenElement=null;
  f.doc.dispatch('fullscreenchange');
  assert.equal(f.panel,originalPanel);
  assert.equal(f.doc.activeElement,f.focusBefore);
  assert.deepEqual(f.scrolled,[[12,350]]);
  assert.equal(f.ids.get('aircraft-fullscreen').textContent,'Fullscreen');
  assert.equal(f.ids.get('aircraft-screen-switch').hidden,true);
  assert.equal(f.doc.body.classList.contains('aircraft-screen-active'),false);
});

test('Escape explicitly exits native fullscreen once and restores the previous view',async()=>{
  const f=fixture();
  await f.api.enter();
  let prevented=0;
  f.doc.dispatch('keydown',{key:'Escape',preventDefault(){prevented++;}});
  await Promise.resolve();
  assert.equal(prevented,1);
  assert.equal(f.counts().exits,1);
  assert.equal(f.doc.fullscreenElement,null);
  assert.equal(f.ids.get('aircraft-fullscreen').getAttribute('aria-pressed'),'false');
  assert.equal(f.ids.get('aircraft-screen-switch').hidden,true);
  assert.equal(f.doc.activeElement,f.focusBefore);
  assert.deepEqual(f.scrolled,[[12,350]]);

  // A late native notification or another Escape must not restore or exit a second time.
  f.doc.dispatch('fullscreenchange');
  f.doc.dispatch('keydown',{key:'Escape',preventDefault(){prevented++;}});
  assert.equal(f.counts().exits,1);
  assert.equal(prevented,1);
  assert.deepEqual(f.scrolled,[[12,350]]);
});

test('rejected browser fullscreen falls back to an expanded screen and Esc returns',async()=>{
  const f=fixture({reject:true});
  await f.api.enter();
  assert.equal(f.panel.classList.contains('aircraft-screen-focus'),true);
  assert.equal(f.ids.get('aircraft-fullscreen').getAttribute('aria-pressed'),'true');
  let prevented=false;
  f.doc.dispatch('keydown',{key:'Escape',preventDefault(){prevented=true;}});
  assert.equal(prevented,true);
  assert.equal(f.panel.classList.contains('aircraft-screen-focus'),false);
  assert.equal(f.doc.body.classList.contains('aircraft-screen-active'),false);
  assert.equal(f.doc.activeElement,f.focusBefore);
  assert.deepEqual(f.scrolled,[[12,350]]);
  assert.equal(f.counts().requests,1);
});

test('fullscreen switches the current local or Tower display through its existing controls',async()=>{
  const f=fixture({native:false});
  const clicked=[];
  for(const prefix of ['local','tower'])for(const view of ['map','radar']){
    f.ids.get(prefix+'-show-'+view).addEventListener('click',()=>{
      clicked.push(prefix+'-'+view);
      for(const selected of ['map','radar'])f.ids.get(prefix+'-show-'+selected).setAttribute('aria-pressed',String(selected===view));
    });
  }
  await f.api.enter();
  f.ids.get('aircraft-screen-radar').click();
  assert.deepEqual(clicked,['local-radar']);
  assert.equal(f.ids.get('aircraft-screen-radar').getAttribute('aria-pressed'),'true');
  f.ids.get('local-aircraft-layout').hidden=true;
  f.api.sync();
  f.ids.get('aircraft-screen-map').click();
  assert.deepEqual(clicked,['local-radar','tower-map']);
  assert.equal(f.ids.get('aircraft-screen-map').getAttribute('aria-pressed'),'true');
  await f.api.exit();
  assert.equal(f.counts().requests,0);
});

test('leaving an aircraft view closes expanded mode and hides its control',async()=>{
  const f=fixture({native:false});
  await f.api.enter();
  f.ids.get('aircraft-display-settings').hidden=true;
  f.api.sync();
  assert.equal(f.panel.classList.contains('aircraft-screen-focus'),false);
  assert.equal(f.ids.get('aircraft-screen-actions').hidden,true);
  assert.equal(f.doc.activeElement,f.focusBefore);
});
