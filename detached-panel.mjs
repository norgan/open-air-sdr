import {createTowerMap} from './tower-map.mjs';
import {applyAircraftAppearance} from './aircraft-appearance.mjs';
import {createAircraftCard,updateAircraftCard} from './aircraft-card.mjs';
import {matchesAircraft,selectAircraft,subscribeAircraftSelection} from './aircraft-selection.mjs';

const channel='open-air-detached-panel';
const svgNamespace='http://www.w3.org/2000/svg';
const svgTags=new Set(['svg','g','path','circle','text','title','line','rect','polyline','polygon']);
const svgAttributes=new Set(['viewBox','role','aria-label','x','y','x1','y1','x2','y2','cx','cy','r','d','fill','stroke',
  'stroke-width','stroke-dasharray','stroke-linejoin','stroke-linecap','text-anchor','font-family','fontFamily','font-size',
  'transform','paint-order','vector-effect','class','tabindex','aria-pressed','data-aircraft-hex']);

export function sanitiseRadarSvg(source,doc=globalThis.document) {
  if(typeof source!=='string'||source.length>500000||/<!DOCTYPE|<!ENTITY/i.test(source))return null;
  const Parser=doc?.defaultView?.DOMParser??globalThis.DOMParser;
  if(!Parser)return null;
  const parsed=new Parser().parseFromString(source,'image/svg+xml');
  if(parsed.documentElement.localName!=='svg'||parsed.documentElement.namespaceURI!==svgNamespace||parsed.querySelector('parsererror'))return null;
  function copy(node) {
    if(node.nodeType===3)return doc.createTextNode(node.textContent.slice(0,4096));
    if(node.nodeType!==1||!svgTags.has(node.localName))return null;
    const clean=doc.createElementNS(svgNamespace,node.localName);
    for(const attribute of node.attributes) {
      if(!svgAttributes.has(attribute.name)||/url\s*\(|javascript:|data:/i.test(attribute.value))continue;
      clean.setAttribute(attribute.name,attribute.value.slice(0,20000));
    }
    for(const child of node.childNodes){const safe=copy(child);if(safe)clean.append(safe);}
    return clean;
  }
  return copy(parsed.documentElement);
}

export function initialiseDetachedPanel({document:doc=globalThis.document,window:win=globalThis.window}={}) {
  if(!doc||!win)return null;
  const $=id=>doc.getElementById(id);
  const query=new URL(win.location.href).searchParams;
  const kind=query.get('panel');
  const token=query.get('token');
  const parent=win.opener;
  const origin=win.location.origin;
  const map=$('detached-map'),radar=$('detached-radar'),canvas=$('detached-waterfall');
  const empty=$('detached-empty'),status=$('detached-status'),source=$('detached-source');
  const details=$('detached-aircraft-details'),detailsCard=$('detached-details-card');
  let latest;
  let lastParentMessage=Date.now();
  let lastPayload=0;
  let parentGone=false;
  let sequence=0;
  let selectedHex;
  let selectedCard;
  let renderedRadarSvg;
  let active=true;
  let received=false;
  const radarItems=new WeakMap();
  const send=(type,payload)=>{
    try{parent?.postMessage({channel,token,panel:kind,type,payload},origin);}catch{}
  };
  const setStatus=message=>{status.textContent=message;};
  function inactive(message) {
    active=false;
    source.textContent=latest?.tag?latest.tag.replace(/^LIVE /,'')+' · PAUSED':'PAUSED';
    setStatus(message||'Waiting for the main Open Air window.');
  }
  if(!['aircraft','waterfall'].includes(kind)||!parent||!/^[a-zA-Z0-9-]{16,128}$/.test(token||'')) {
    empty.textContent='Open this display using Pop out in Open Air.';
    inactive('No main Open Air window is connected.');
    return null;
  }
  $('detached-title').textContent=kind==='aircraft'?'Aircraft display':'Waterfall';
  doc.title='Open Air — '+(kind==='aircraft'?'Aircraft display':'Waterfall');
  $('detached-views').hidden=kind!=='aircraft';
  const showMap=createTowerMap(map,$('detached-map-status'),{createCard:createAircraftCard,updateCard:updateAircraftCard});
  function highlightRadar() {
    for(const group of radar.querySelectorAll('.radar-aircraft')){
      const selected=matchesAircraft(radarItems.get(group)||{});
      group.classList.toggle('aircraft-selected',selected);
      group.setAttribute('aria-pressed',String(selected));
    }
  }
  const stopSelection=subscribeAircraftSelection(detail=>{
    highlightRadar();
    if(detail.origin!=='parent'&&detail.origin!=='enrichment')send('select',{identity:detail.identity});
  });
  function showRadarCard(item) {
    selectAircraft(item,{origin:'detached-radar',reveal:true});
    selectedHex=item.hex;
    selectedCard=createAircraftCard(item);
    detailsCard.replaceChildren(selectedCard);
    details.hidden=false;
  }
  $('detached-details-close').addEventListener('click',()=>{details.hidden=true;selectedHex=undefined;selectedCard=undefined;});
  function renderAircraft(payload) {
    const items=Array.isArray(payload.items)?payload.items:[];
    const display=payload.display==='radar'?'radar':'map';
    applyAircraftAppearance(doc.documentElement,payload.appearance);
    selectAircraft(payload.selectedAircraft??null,{origin:'parent',reveal:false});
    $('detached-title').textContent=payload.title||'Aircraft display';
    $('detached-caption').textContent=payload.caption||'';
    source.textContent=payload.tag||'AIRCRAFT';
    $('detached-view-map').setAttribute('aria-pressed',String(display==='map'));
    $('detached-view-radar').setAttribute('aria-pressed',String(display==='radar'));
    map.hidden=display!=='map';radar.hidden=display!=='radar';canvas.hidden=true;
    const positioned=items.filter(item=>Number.isFinite(item.lat)&&Number.isFinite(item.lon)&&Math.abs(item.lat)<=90&&Math.abs(item.lon)<=180);
    let hasDisplay=true;
    if(display==='map') {
      const centre=payload.centre;
      hasDisplay=Boolean(centre&&Number.isFinite(centre.latitude)&&Number.isFinite(centre.longitude));
      if(hasDisplay)void showMap(centre,positioned);
      else map.hidden=true;
    } else {
      $('detached-map-status').hidden=true;
      const focusedHex=radar.contains(doc.activeElement)?doc.activeElement?.getAttribute('data-aircraft-hex'):null;
      let svg=radar.firstElementChild;
      if(renderedRadarSvg!==payload.radarSvg||!svg){
        svg=sanitiseRadarSvg(payload.radarSvg,doc);
        radar.replaceChildren(...(svg?[svg]:[]));
        renderedRadarSvg=payload.radarSvg;
      }
      hasDisplay=Boolean(svg);
      if(svg) {
        const tracked=items.filter(item=>Number.isFinite(item.distanceKm)&&Number.isFinite(item.bearing));
        const groups=[...svg.querySelectorAll('.radar-aircraft')];
        groups.forEach((group,index)=>{
          const hex=group.getAttribute('data-aircraft-hex');
          const item=(hex?items.find(item=>item.hex?.toLowerCase()===hex.toLowerCase()):null)||tracked[index];if(!item)return;
          const wired=radarItems.has(group);
          radarItems.set(group,item);
          group.setAttribute('role','button');group.setAttribute('tabindex','0');
          group.setAttribute('aria-label','Aircraft details for '+(item.title||item.hex));
          group.style.cursor='pointer';
          if(!wired){
            group.addEventListener('click',()=>showRadarCard(radarItems.get(group)));
            group.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();showRadarCard(radarItems.get(group));}});
          }
        });
        if(focusedHex){[...svg.querySelectorAll('[data-aircraft-hex]')].find(node=>node.getAttribute('data-aircraft-hex')===focusedHex)?.focus({preventScroll:true});}
      }
    }
    highlightRadar();
    if(selectedCard&&selectedHex){const item=items.find(item=>item.hex===selectedHex);if(item)updateAircraftCard(selectedCard,item);else{details.hidden=true;selectedHex=undefined;selectedCard=undefined;}}
    empty.hidden=hasDisplay;
    empty.textContent=payload.active===false?(payload.status||'No live aircraft positions are available.'):'Set a map centre or wait for aircraft positions in Open Air.';
    if(payload.active===false){source.textContent=(payload.tag||'AIRCRAFT').replace(/^LIVE /,'')+' · PAUSED';setStatus(payload.status||'Aircraft display paused.');}
    else setStatus(payload.status||'Linked to Open Air');
  }
  function renderWaterfall(payload) {
    map.hidden=true;radar.hidden=true;canvas.hidden=false;details.hidden=true;
    $('detached-title').textContent=payload.title||'Waterfall';
    $('detached-caption').textContent=payload.caption||'';
    source.textContent=payload.active===false?'WAITING':'LOCAL RF';
    if(typeof payload.image!=='string'||!payload.image.startsWith('data:image/png;base64,')||payload.image.length>5*1024*1024){empty.hidden=false;empty.textContent='Waiting for waterfall samples.';return;}
    const current=++sequence;
    const image=new win.Image();
    image.onload=()=>{
      if(current!==sequence)return;
      if(image.naturalWidth>8192||image.naturalHeight>8192)return;
      canvas.width=image.naturalWidth;canvas.height=image.naturalHeight;
      canvas.getContext('2d').drawImage(image,0,0);
      canvas.dataset.frame=String(payload.sequence??current);
      empty.hidden=true;
      setStatus(payload.status||(payload.active===false?'Waiting for waterfall samples.':'Live waterfall'));
    };
    image.onerror=()=>{if(current===sequence){empty.hidden=false;empty.textContent='Waterfall image unavailable.';setStatus('Waiting for a new waterfall frame.');}};
    image.src=payload.image;
  }
  function receive(event) {
    const message=event.data;
    if(event.origin!==origin||event.source!==parent||!message||message.channel!==channel||message.token!==token||message.panel!==kind)return;
    lastParentMessage=Date.now();
    if(message.type==='parent-closed'){parentGone=true;inactive(message.payload?.message);return;}
    parentGone=false;
    if(message.type==='heartbeat')return;
    if(message.type==='inactive'){received=true;inactive(message.payload?.message);return;}
    if(message.type!=='state'||!message.payload||typeof message.payload!=='object')return;
    received=true;lastPayload=Date.now();latest=message.payload;active=latest.active!==false;
    $('detached-updated').textContent='Updated '+new Date(latest.updated||lastPayload).toLocaleTimeString('en-AU');
    if(kind==='aircraft')renderAircraft(latest);else renderWaterfall(latest);
  }
  win.addEventListener('message',receive);
  for(const display of ['map','radar'])$('detached-view-'+display).addEventListener('click',()=>send('view',{display}));
  $('detached-return').addEventListener('click',()=>{send('closing');try{parent.focus();}catch{}win.close();});
  $('detached-fullscreen').addEventListener('click',async()=>{
    try {
      if(doc.fullscreenElement)await doc.exitFullscreen();
      else await doc.documentElement.requestFullscreen({navigationUI:'hide'});
    }catch{setStatus('Fullscreen is unavailable here. Maximise this window instead.');}
  });
  doc.addEventListener('fullscreenchange',()=>{
    const expanded=Boolean(doc.fullscreenElement);
    $('detached-fullscreen').textContent=expanded?'Exit fullscreen':'Fullscreen';
    $('detached-fullscreen').setAttribute('aria-pressed',String(expanded));
  });
  win.addEventListener('pagehide',()=>send('closing'));
  send('ready');
  const timer=win.setInterval(()=>{
    if(parent.closed||parentGone||Date.now()-lastParentMessage>7000){inactive('The main Open Air window is unavailable. Reopen it to resume live updates.');return;}
    if(!received){send('ready');return;}
    if(active&&lastPayload&&Date.now()-lastPayload>6000){
      source.textContent='WAITING';
      setStatus(kind==='aircraft'?'Waiting for updated aircraft positions.':'Waiting for waterfall samples.');
    }
  },1000);
  return {destroy(){stopSelection();win.clearInterval(timer);win.removeEventListener('message',receive);}};
}

if(typeof document!=='undefined')initialiseDetachedPanel();
