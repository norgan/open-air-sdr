import { aircraftDetailFields } from './detail-fields.mjs';
import { rememberAircraftIdentity } from './aircraft-selection.mjs';

const identityStates = new Set(['ready','partial','unavailable','not-found']);
const aircraftInfoCache = new Map();
const failedAircraftPhotos = new Set();
const cardStates = new WeakMap();
const maximumCacheEntries = 256;
const cacheTtl = {ready:6*60*60_000,'not-found':15*60_000,partial:60_000,unavailable:60_000};

function text(value, limit = 180) {
  if (value === undefined || value === null) return '';
  return String(value).trim().slice(0,limit);
}

function hexAddress(value) {
  const hex=text(value,32).toUpperCase();
  return /^[0-9A-F]{6}$/.test(hex) ? hex : '';
}

function callsignFor(item = {}) {
  const hex=hexAddress(item.hex);
  const registration=keyPart(item.registration);
  const explicit=text(item.callsign,32).toUpperCase();
  if (/^[A-Z0-9]{2,8}$/.test(explicit) && explicit!==hex && explicit!==registration) return explicit;
  const legacy=text(item.title,32).toUpperCase();
  return /^[A-Z0-9]{2,8}$/.test(legacy) && legacy!==hex && legacy!==registration ? legacy : '';
}

function keyPart(value) {
  return text(value,80).toUpperCase().replace(/\s+/g,' ');
}

export function aircraftRecordKey(item = {}) {
  const hex=hexAddress(item.hex);
  const registration=keyPart(item.registration);
  const callsign=keyPart(callsignFor(item));
  const identity=hex ? `hex:${hex}` : registration ? `registration:${registration}` : `track:${callsign || 'unknown'}`;
  return JSON.stringify([identity,keyPart(item.source)]);
}

function lookupFor(item = {}) {
  const hex=hexAddress(item.hex);
  const callsign=callsignFor(item);
  if (!hex) return null;
  return {hex,callsign,key:`${hex}|${keyPart(callsign) || '-'}`};
}

function safeUrl(value) {
  const candidate=text(value,2048);
  if (!candidate) return '';
  try {
    const url=new URL(candidate,document.baseURI);
    return url.protocol==='https:' || url.origin===location.origin ? url.href : '';
  } catch { return ''; }
}

function positiveDimension(value) {
  const number=Number(value);
  return Number.isFinite(number) && number>0 && number<=10_000 ? Math.round(number) : undefined;
}

function normalisePhoto(value) {
  if (!value || typeof value!=='object' || Array.isArray(value)) return null;
  return {
    url:text(value.url,2048),link:text(value.link,2048),photographer:text(value.photographer),source:text(value.source),
    width:positiveDimension(value.width),height:positiveDimension(value.height),
  };
}

function normaliseInfo(value, request) {
  const source=value && typeof value==='object' && !Array.isArray(value) ? value : {};
  const returnedHex=text(source.hex,32);
  const returnedCallsign=text(source.callsign,32).toUpperCase();
  if (returnedHex && hexAddress(returnedHex)!==request.hex) throw Error('Aircraft identity mismatch');
  if (returnedCallsign && returnedCallsign!==request.callsign.toUpperCase()) throw Error('Aircraft callsign mismatch');
  const identityStatus=identityStates.has(source.identityStatus) ? source.identityStatus : 'unavailable';
  return {
    identityStatus,metadataSource:text(source.metadataSource),hex:hexAddress(source.hex) || request.hex,
    callsign:text(source.callsign,32) || request.callsign,airline:text(source.airline),
    flightNumber:text(source.flightNumber,32),registration:text(source.registration,32),
    aircraftType:text(source.aircraftType,80),manufacturer:text(source.manufacturer,80),model:text(source.model,100),
    registeredOwner:text(source.registeredOwner,120),photo:normalisePhoto(source.photo),
  };
}

function updateMountedCards(lookupKey) {
  for (const card of document.querySelectorAll('.aircraft-card')) {
    const state=cardStates.get(card);
    if (state?.lookupKey===lookupKey) renderCard(state,aircraftInfoCache.get(lookupKey));
  }
}

function cacheEntry(key,entry) {
  aircraftInfoCache.delete(key);
  aircraftInfoCache.set(key,entry);
  while (aircraftInfoCache.size>maximumCacheEntries) {
    const removable=Array.from(aircraftInfoCache).find(([candidateKey,candidate])=>candidateKey!==key&&!candidate.promise);
    if (!removable) break;
    aircraftInfoCache.delete(removable[0]);
  }
  return entry;
}

function rememberFailedPhoto(url) {
  failedAircraftPhotos.delete(url);
  failedAircraftPhotos.add(url);
  while (failedAircraftPhotos.size>maximumCacheEntries) {
    failedAircraftPhotos.delete(failedAircraftPhotos.values().next().value);
  }
}

function ensureAircraftInfo(request) {
  let entry=aircraftInfoCache.get(request.key);
  if (entry?.promise) return entry;
  if (entry && Date.now()<entry.expiresAt) return cacheEntry(request.key,entry);
  entry=cacheEntry(request.key,{status:'loading',data:null,promise:null,expiresAt:0});
  const query=new URLSearchParams({hex:request.hex,callsign:request.callsign});
  entry.promise=fetch('/api/aircraft-info?'+query,{headers:{Accept:'application/json'}}).then(async response => {
    if (response.status===404) return {identityStatus:'not-found'};
    if (!response.ok) throw Error('Aircraft details unavailable');
    return response.json();
  }).then(value => {
    entry.data=normaliseInfo(value,request);
    entry.status=entry.data.identityStatus;
    entry.expiresAt=Date.now()+(cacheTtl[entry.status] || cacheTtl.unavailable);
  }).catch(() => {
    entry.data=normaliseInfo({identityStatus:'unavailable'},request);
    entry.status='unavailable';
    entry.expiresAt=Date.now()+cacheTtl.unavailable;
  }).finally(() => {
    entry.promise=null;
    cacheEntry(request.key,entry);
    updateMountedCards(request.key);
  });
  updateMountedCards(request.key);
  return entry;
}

function element(tag,className,textContent) {
  const node=document.createElement(tag);
  node.className=className;
  if (textContent!==undefined) node.textContent=textContent;
  return node;
}

function mergedDetails(item, info) {
  if (!info) return item;
  return {...item,callsign:info.callsign || item.callsign,airline:info.airline || item.airline,
    flightNumber:info.flightNumber || item.flightNumber,registration:info.registration || item.registration,
    aircraftType:info.aircraftType || item.aircraftType,manufacturer:info.manufacturer || item.manufacturer,
    model:info.model || item.model,registeredOwner:info.registeredOwner || item.registeredOwner};
}

function renderFacts(state,info) {
  const fields=document.createDocumentFragment();
  for (const {label,value} of aircraftDetailFields(mergedDetails(state.item,info))) {
    const field=document.createElement('div');
    const term=document.createElement('dt');
    const description=document.createElement('dd');
    term.textContent=label;
    description.textContent=value;
    field.append(term,description);
    fields.append(field);
  }
  state.facts.replaceChildren(fields);
}

function renderIdentity(state,info = {}) {
  info=info??{};
  const item=state.item;
  const callsign=info.callsign || callsignFor(item);
  const registration=info.registration || text(item.registration,32);
  const aircraftType=info.aircraftType || text(item.aircraftType || item.type,80);
  const model=[info.manufacturer,info.model].filter(Boolean).join(' ');
  const type=[model,aircraftType && !model.toUpperCase().includes(aircraftType.toUpperCase()) ? aircraftType : '']
    .filter(Boolean).join(' · ');
  const airline=info.airline;
  const flight=info.flightNumber || callsign || registration || hexAddress(item.hex) || 'Aircraft';
  state.airline.textContent=airline;
  state.airline.hidden=!airline;
  state.airline.dataset.identity=info.airline ? 'airline' : '';
  state.flight.textContent=flight;
  state.callsign.textContent=info.flightNumber && callsign ? `Callsign ${callsign}` : '';
  state.callsign.hidden=!state.callsign.textContent;
  state.airframe.textContent=[registration,type].filter(Boolean).join(' · ');
  state.airframe.hidden=!state.airframe.textContent;
  state.metadataSource.textContent=info.metadataSource ? `Identity data: ${info.metadataSource}` : '';
  state.metadataSource.hidden=!state.metadataSource.textContent;
}

function photoFallback(state,photoState = 'missing') {
  state.photoUrl='';
  state.photoFrame.dataset.photoState=photoState;
  state.photoFrame.replaceChildren(element('div','aircraft-photo-fallback','No aircraft photo available.'));
}

function photoAttribution(photo,link) {
  const caption=element('figcaption','aircraft-photo-attribution');
  const words=[photo.photographer ? `Photo © ${photo.photographer}` : 'Photo',photo.source].filter(Boolean).join(' · ');
  if (link) {
    const credit=element('a','aircraft-photo-credit-link',words);
    credit.href=link;
    credit.target='_blank';
    credit.rel='noopener noreferrer';
    caption.append(credit);
  } else caption.textContent=words;
  return caption;
}

function renderPhoto(state,photo) {
  const url=safeUrl(photo?.url);
  const link=safeUrl(photo?.link);
  if (!url || failedAircraftPhotos.has(url)) {
    photoFallback(state,url ? 'error' : 'missing');
    return;
  }
  if (state.photoUrl===url && state.photoFrame.dataset.photoState==='ready') return;
  state.photoUrl=url;
  state.photoFrame.dataset.photoState='ready';
  const image=element('img','aircraft-photo');
  image.src=url;
  image.alt=`Photo of ${state.item.registration || callsignFor(state.item) || hexAddress(state.item.hex) || 'aircraft'}`;
  image.loading='lazy';
  image.decoding='async';
  image.referrerPolicy='no-referrer';
  if (photo.width) image.width=photo.width;
  if (photo.height) image.height=photo.height;
  image.addEventListener('error',() => {
    rememberFailedPhoto(url);
    updateMountedCards(state.lookupKey);
  },{once:true});
  let visual=image;
  if (link) {
    const anchor=element('a','aircraft-photo-link');
    anchor.href=link;
    anchor.target='_blank';
    anchor.rel='noopener noreferrer';
    anchor.setAttribute('aria-label',`View aircraft photo on ${photo.source || 'the photo source'}`);
    anchor.append(image);
    visual=anchor;
  }
  state.photoFrame.replaceChildren(visual,photoAttribution(photo,link));
}

function renderCard(state,entry) {
  const info=entry?.data;
  const status=entry?.status || 'not-found';
  const displayState=status==='loading' ? 'loading' : ['ready','partial'].includes(status) ? 'ready' :
    status==='not-found' ? 'empty' : 'error';
  state.profile.dataset.state=displayState;
  state.card.setAttribute('aria-busy',String(displayState==='loading'));
  if (info && ['ready','partial'].includes(status)) {
    rememberAircraftIdentity({hex:info.hex || state.item.hex,callsign:info.callsign || callsignFor(state.item),
      registration:info.registration || state.item.registration,
      flightNumber:info.flightNumber || state.item.flightNumber});
  }
  renderIdentity(state,info);
  renderFacts(state,info);
  if (displayState==='loading') {
    state.status.textContent='Looking up aircraft…';
    state.status.hidden=false;
    state.photoUrl='';
    state.photoFrame.dataset.photoState='loading';
    state.photoFrame.hidden=true;
    state.photoFrame.replaceChildren();
    return;
  }
  state.photoFrame.hidden=false;
  if (displayState==='empty') {
    state.status.textContent='No additional aircraft details found.';
    state.status.hidden=false;
    photoFallback(state);
    return;
  }
  if (displayState==='error') {
    state.status.textContent='Aircraft details are temporarily unavailable.';
    state.status.hidden=false;
    photoFallback(state);
    return;
  }
  state.status.textContent=status==='partial' ? 'Limited aircraft details found.' : '';
  state.status.hidden=status!=='partial';
  renderPhoto(state,info?.photo);
}

export function updateAircraftCard(card,item = {},options = {}) {
  const state=cardStates.get(card);
  if (!state) throw new TypeError('Expected an aircraft card created by createAircraftCard().');
  state.item=item;
  state.lookupEnabled=options.lookup ?? state.lookupEnabled;
  const lookup=state.lookupEnabled ? lookupFor(item) : null;
  state.lookupKey=lookup?.key || '';
  card.dataset.aircraftLookup=state.lookupKey;
  renderCard(state,lookup ? ensureAircraftInfo(lookup) : {status:'not-found',data:null});
  return card;
}

export function createAircraftCard(item = {},options = {}) {
  const card=element('div','aircraft-card');
  const profile=element('section','aircraft-profile');
  const identity=element('div','aircraft-profile-identity');
  const airline=element('p','aircraft-profile-airline');
  const flight=element('strong','aircraft-profile-flight');
  const callsign=element('span','aircraft-profile-callsign');
  const airframe=element('span','aircraft-profile-airframe');
  const metadataSource=element('small','aircraft-profile-source');
  const status=element('p','aircraft-profile-status');
  const photoFrame=element('figure','aircraft-photo-frame');
  const facts=document.createElement('dl');
  profile.setAttribute('aria-label','Aircraft identity');
  status.setAttribute('role','status');
  status.setAttribute('aria-live','polite');
  facts.className='aircraft-fields';
  identity.append(airline,flight,callsign,airframe,metadataSource);
  profile.append(identity,status,photoFrame);
  card.append(profile,facts);
  cardStates.set(card,{card,profile,identity,airline,flight,callsign,airframe,metadataSource,status,photoFrame,facts,
    item:{},lookupEnabled:options.lookup!==false,lookupKey:'',photoUrl:''});
  return updateAircraftCard(card,item,options);
}
