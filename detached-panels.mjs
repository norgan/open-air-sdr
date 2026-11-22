const channel='open-air-detached-panel';
const kinds=new Set(['aircraft','waterfall']);
const text=(value,limit=200)=>typeof value==='string'?value.slice(0,limit):'';
const finite=value=>typeof value==='number'&&Number.isFinite(value);
function selectionIdentity(value) {
  if(!value||typeof value!=='object')return null;
  const hex=/^[0-9a-f]{6}$/i.test(value.hex||'')?String(value.hex).toLowerCase():'';
  const callsign=text(value.callsign,12).trim().toUpperCase();
  const registration=text(value.registration,16).trim().toUpperCase();
  const flightNumber=text(value.flightNumber,16).trim().toUpperCase();
  return hex||callsign||registration||flightNumber?{hex,callsign,registration,flightNumber}:null;
}

export function aircraftPanelState(input={}) {
  const items=(Array.isArray(input.items)?input.items:[]).filter(item=>item&&typeof item==='object').slice(0,1500).map(item=>({
    hex:text(item.hex,12),title:text(item.title,100),tag:text(item.tag,80),detail:text(item.detail,400),
    callsign:text(item.callsign,12),atcCallsign:text(item.atcCallsign,40),source:text(item.source,80),registration:text(item.registration,16),
    aircraftType:text(item.aircraftType,80),category:text(item.category,40),squawk:text(item.squawk,8),emergency:text(item.emergency,60),
    onSurface:typeof item.onSurface==='boolean'?item.onSurface:undefined,
    alt:finite(item.alt)?item.alt:null,altGeom:finite(item.altGeom)?item.altGeom:null,
    speed:finite(item.speed)?item.speed:null,verticalRate:finite(item.verticalRate)?item.verticalRate:null,
    navigationHeading:finite(item.navigationHeading)?item.navigationHeading:null,
    lat:finite(item.lat)?item.lat:null,lon:finite(item.lon)?item.lon:null,
    heading:finite(item.heading)?item.heading:null,distanceKm:finite(item.distanceKm)?item.distanceKm:null,
    bearing:finite(item.bearing)?item.bearing:null,
  }));
  const centre=input.centre&&finite(input.centre.latitude)&&finite(input.centre.longitude)
    ?{latitude:input.centre.latitude,longitude:input.centre.longitude}:null;
  return {items,centre,display:input.display==='radar'?'radar':'map',title:text(input.title),caption:text(input.caption,400),
    tag:text(input.tag,40),appearance:input.appearance?{colour:input.appearance.colour,outline:input.appearance.outline,
      size:input.appearance.size,mapOpacity:input.appearance.mapOpacity}:null,
    selectedAircraft:selectionIdentity(input.selectedAircraft),radarSvg:text(input.radarSvg,500000),
    active:input.active!==false,status:text(input.status,300),updated:finite(input.updated)?input.updated:Date.now()};
}

export function initialiseDetachedPanels({document:doc=globalThis.document,window:win=globalThis.window,
  onAircraftView=()=>{},onAircraftSelect=()=>{},onPanelsChanged=()=>{},now=()=>Date.now()}={}) {
  if(!doc||!win)return null;
  const origin=win.location.origin;
  const token=win.crypto?.randomUUID?.()??Array.from(win.crypto?.getRandomValues?.(new Uint32Array(4))??[],n=>n.toString(16).padStart(8,'0')).join('');
  if(!token)return null;
  const children=new Map();
  let aircraft;
  let waterfall;
  let sentFrameAt=-Infinity;
  let sequence=0;
  let monitor;
  const listeners=[];
  const notice=message=>{
    const node=doc.getElementById('detached-panel-notice');
    if(node){node.textContent=message;node.hidden=!message;}
  };
  const on=(target,event,handler)=>{
    target.addEventListener(event,handler);listeners.push(()=>target.removeEventListener(event,handler));
  };
  const hasOpenPanels=kind=>[...children].some(([key,entry])=>(!kind||kind===key)&&!entry.window.closed);
  const changed=()=>{try{onPanelsChanged();}catch{}};
  const send=(kind,type,payload)=>{
    const entry=children.get(kind);
    if(!entry||entry.window.closed||!entry.ready)return false;
    try{entry.window.postMessage({channel,token,panel:kind,type,payload},origin);return true;}catch{return false;}
  };
  function sendAircraft() {
    if(!aircraft)return send('aircraft','inactive',{message:'Select an aircraft view in Open Air.'});
    return send('aircraft','state',aircraft);
  }
  function sendWaterfall(force=false) {
    const entry=children.get('waterfall');
    if(!waterfall||!entry?.ready||entry.window.closed)return;
    const time=now();
    if(!force&&time-sentFrameAt<250)return;
    const {canvas,caption='',title='Waterfall',active=true,status=''}=waterfall;
    if(!canvas?.width||!canvas?.height)return send('waterfall','inactive',{message:'Waiting for waterfall samples.'});
    let image;
    try{image=canvas.toDataURL('image/png');}catch{return send('waterfall','inactive',{message:'Waterfall preview is unavailable.'});}
    if(image.length>5*1024*1024)return send('waterfall','inactive',{message:'Waterfall preview is too large.'});
    sentFrameAt=time;
    send('waterfall','state',{image,width:canvas.width,height:canvas.height,caption:text(caption,400),title:text(title),
      active:Boolean(active),status:text(status,200),sequence:++sequence,updated:time});
  }
  function startMonitor() {
    if(monitor)return;
    monitor=win.setInterval(()=>{
      let removed=false;
      for(const [kind,entry]of children){
        if(entry.window.closed){children.delete(kind);removed=true;}
        else if(entry.ready)send(kind,'heartbeat',{time:now()});
      }
      if(removed)changed();
      if(!children.size){win.clearInterval(monitor);monitor=undefined;}
    },1000);
  }
  function open(kind) {
    if(!kinds.has(kind))return null;
    const previous=children.get(kind);
    if(previous&&!previous.window.closed){previous.window.focus();return previous.window;}
    const url=new URL('/detached-panel.html',origin);
    url.searchParams.set('panel',kind);url.searchParams.set('token',token);
    const child=win.open(url.href,'open-air-'+kind+'-'+token,'popup=yes,width=1100,height=760,resizable=yes,scrollbars=yes');
    if(!child){notice('Allow pop-ups for Open Air to open a separate display window.');return null;}
    notice('');
    children.set(kind,{window:child,ready:false});
    changed();startMonitor();
    return child;
  }
  function receive(event) {
    if(event.origin!==origin||!event.data||event.data.channel!==channel||event.data.token!==token||!kinds.has(event.data.panel))return;
    const kind=event.data.panel;
    const entry=children.get(kind);
    if(!entry||event.source!==entry.window)return;
    const {type,payload}=event.data;
    if(type==='ready'){
      entry.ready=true;
      if(kind==='aircraft')sendAircraft();else sendWaterfall(true);
    }else if(type==='view'&&kind==='aircraft'&&['map','radar'].includes(payload?.display)){
      onAircraftView(payload.display);
    }else if(type==='select'&&kind==='aircraft'){
      const identity=selectionIdentity(payload?.identity);
      if(identity)onAircraftSelect(identity);
    }else if(type==='closing'){
      children.delete(kind);changed();
    }
  }
  on(win,'message',receive);
  on(win,'pagehide',()=>{for(const kind of children.keys())send(kind,'parent-closed',{message:'Open Air was closed. Reopen it to resume live updates.'});});
  const aircraftButton=doc.getElementById('aircraft-popout');
  const waterfallButton=doc.getElementById('waterfall-popout');
  if(aircraftButton)on(aircraftButton,'click',()=>open('aircraft'));
  if(waterfallButton)on(waterfallButton,'click',()=>open('waterfall'));
  return {open,hasOpenPanels,
    updateAircraft(input){aircraft=aircraftPanelState(input);if(hasOpenPanels('aircraft'))sendAircraft();},
    updateWaterfall(input){
      const changed=waterfall?.active!==input?.active||waterfall?.caption!==input?.caption||waterfall?.status!==input?.status;
      waterfall=input;if(hasOpenPanels('waterfall'))sendWaterfall(changed);
    },
    close(){
      for(const entry of children.values())if(!entry.window.closed)entry.window.close();
      children.clear();
      if(monitor)win.clearInterval(monitor);
      monitor=undefined;
      for(const stop of listeners)stop();
      changed();
    },
  };
}
