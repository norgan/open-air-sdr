const maximumEntries=256;
export const aircraftSelectionEvent='open-air:aircraft-selected';

function clean(value) {
  return typeof value==='string'?value.trim().toUpperCase():'';
}
function hex(value) {
  const candidate=clean(value);
  return /^[0-9A-F]{6}$/.test(candidate)?candidate.toLowerCase():'';
}
function registration(value) {
  const candidate=clean(value).replace(/^[.]+/,'');
  const key=candidate.replace(/[-\s]/g,'');
  return /^[A-Z0-9]{2,9}$/.test(key)?candidate:'';
}
function registrationKey(value) {
  return registration(value).replace(/[-\s]/g,'');
}
function callsign(value) {
  const candidate=clean(value);
  return /^[A-Z0-9]{2,8}$/.test(candidate)?candidate:'';
}

export function aircraftIdentity(item={}) {
  if(!item||typeof item!=='object')return null;
  const address=hex(item.hex??item.icao??item.icaoAddress);
  let reg=registration(item.registration??item.tail??item.tailNumber);
  const title=clean(item.title);
  if(!reg&&(title.includes('-')||/^N[1-9][0-9]{0,4}[A-Z]{0,2}$/.test(title)))reg=registration(title);
  let flight=callsign(item.callsign??item.flight??item.flightId);
  if(!flight&&title&&!reg)flight=callsign(title);
  if(flight===address.toUpperCase()||registrationKey(flight)===registrationKey(reg))flight='';
  const number=callsign(item.flightNumber);
  if(!address&&!reg&&!flight&&!number)return null;
  return {hex:address,registration:reg,callsign:flight,flightNumber:number};
}

function aliases(identity) {
  const result=[];
  if(identity?.registration)result.push('registration:'+registrationKey(identity.registration));
  if(identity?.callsign)result.push('callsign:'+identity.callsign);
  if(identity?.flightNumber)result.push('callsign:'+identity.flightNumber);
  return [...new Set(result)];
}
const copy=identity=>identity?{...identity}:null;
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);

// Exact typed identifiers only. No route, position, fuzzy match or numeric flight suffix is used.
export function createAircraftSelection({maxEntries=maximumEntries,eventTarget=()=>globalThis.document}={}) {
  const limit=Math.max(1,Math.min(maximumEntries,Math.floor(maxEntries)||maximumEntries));
  const records=new Map();
  const listeners=new Set();
  let selected=null;

  function owners(alias) {
    return [...records.values()].filter(record=>aliases(record).includes(alias));
  }
  function resolve(identity) {
    if(!identity)return null;
    if(identity.hex)return {...(records.get(identity.hex)||{}),...Object.fromEntries(Object.entries(identity).filter(([,value])=>value))};
    let candidates;
    const keys=aliases(identity);
    for(const key of keys){
      const matches=owners(key);
      if(!matches.length)continue;
      if(matches.length!==1)return copy(identity);
      const match=matches[0];
      if(candidates&&candidates.hex!==match.hex)return copy(identity);
      candidates=match;
    }
    if(!candidates)return copy(identity);
    if(identity.registration&&candidates.registration&&registrationKey(identity.registration)!==registrationKey(candidates.registration))return copy(identity);
    return copy(candidates);
  }
  function emit(origin,reveal) {
    const detail={identity:copy(selected),origin,reveal:Boolean(reveal)};
    for(const listener of listeners)listener({...detail,identity:copy(selected)});
    const target=typeof eventTarget==='function'?eventTarget():eventTarget;
    const Event=target?.defaultView?.CustomEvent??globalThis.CustomEvent;
    if(target?.dispatchEvent&&Event)target.dispatchEvent(new Event(aircraftSelectionEvent,{detail}));
  }
  function rememberAircraftIdentity(item) {
    const identity=aircraftIdentity(item);
    if(!identity)return null;
    if(!identity.hex)return resolve(identity);
    const previous=records.get(identity.hex)||{};
    const current={...previous,...Object.fromEntries(Object.entries(identity).filter(([,value])=>value)),hex:identity.hex};
    if(identity.callsign&&previous.callsign&&identity.callsign!==previous.callsign&&!identity.flightNumber)current.flightNumber='';
    records.delete(identity.hex);
    records.set(identity.hex,current);
    while(records.size>limit)records.delete(records.keys().next().value);
    if(selected?.hex===identity.hex){
      const next={...selected,...current};
      if(!equal(next,selected)){selected=next;emit('enrichment',false);}
    }
    return copy(current);
  }
  function selectedAircraft() { return copy(selected); }
  function resolveAircraftIdentity(item) { return resolve(aircraftIdentity(item)); }
  function selectAircraft(item,{origin='list',reveal=true,notify=true}={}) {
    if(item==null)selected=null;
    else {
      const identity=aircraftIdentity(item);
      if(!identity)selected=null;
      else {
        if(identity.hex)rememberAircraftIdentity(identity);
        selected=resolve(identity);
      }
    }
    if(notify)emit(origin,reveal);
    return selectedAircraft();
  }
  function matchesAircraft(item,selection=selected) {
    const identity=aircraftIdentity(item);
    const chosen=aircraftIdentity(selection);
    if(!identity||!chosen)return false;
    if(identity.hex&&chosen.hex)return identity.hex===chosen.hex;
    const left=resolve(identity);
    const right=resolve(chosen);
    if(left.hex&&right.hex)return left.hex===right.hex;
    if(identity.registration&&chosen.registration){
      const key=registrationKey(identity.registration);
      if(key!==registrationKey(chosen.registration))return false;
      return owners('registration:'+key).length<=1;
    }
    if(identity.registration&&right.registration&&registrationKey(identity.registration)!==registrationKey(right.registration))return false;
    if(chosen.registration&&left.registration&&registrationKey(chosen.registration)!==registrationKey(left.registration))return false;
    for(const key of aliases(identity)){
      if(!aliases(chosen).includes(key))continue;
      const matches=owners(key);
      if(matches.length>1)return false;
      return true;
    }
    return false;
  }
  function subscribeAircraftSelection(listener) {
    listeners.add(listener);
    return ()=>listeners.delete(listener);
  }
  return {rememberAircraftIdentity,resolveAircraftIdentity,selectAircraft,selectedAircraft,matchesAircraft,subscribeAircraftSelection};
}
const selection=createAircraftSelection();
export const rememberAircraftIdentity=selection.rememberAircraftIdentity;
export const resolveAircraftIdentity=selection.resolveAircraftIdentity;
export const selectAircraft=selection.selectAircraft;
export const selectedAircraft=selection.selectedAircraft;
export const matchesAircraft=selection.matchesAircraft;
export const subscribeAircraftSelection=selection.subscribeAircraftSelection;
