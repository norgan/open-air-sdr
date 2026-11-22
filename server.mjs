import { createServer } from 'node:http';
import { readFile, unlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createAccess } from './access.mjs';
import { aircraftGeometry, createAircraftNetwork } from './aircraft-network.mjs';
import { createCbScanner, createVoiceScanner } from './cb-scan.mjs';
import { createLocalProfileStore } from './local-profile.mjs';
import { createMessageArchive, messageLimit } from './message-archive.mjs';
import { createRfScanner, validateRfScanRange } from './rf-scan.mjs';
import { availableSources, customSource, isAirbandScanChannel, isSydneyPreset, localSource, receiverModes } from './sources.mjs';
import { audioRelay, configureAudioForwarding, waterfallRelay } from './streams.mjs';

const host = '127.0.0.1';
const directory = fileURLToPath(new URL('.', import.meta.url));
const defaultAudio = new Set(['AMDemod','NFMDemod','BFMDemod','WFMDemod','SSBDemod','DSDDemod']);
const cbSources = new Set(availableSources.filter(source=>Number.isInteger(source.channel)).map(source=>source.id));
const sleep = ms => new Promise(done => setTimeout(done, ms));
function portOf(raw, fallback) {
  if (raw == null && fallback === null) return null;
  const port = raw == null ? fallback : Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('Port must be between 1 and 65535.');
  return port;
}

export class Mcp {
  constructor(port, transport = fetch) {
    this.url = 'http://' + host + ':' + port + '/mcp';
    this.fetch = transport;
    this.id = 0;
  }
  async rpc(method, params, { notification = false, timeout = 5000 } = {}) {
    const request = {jsonrpc:'2.0', method, params};
    if (!notification) request.id = ++this.id;
    const headers = {'Content-Type':'application/json', Accept:'application/json, text/event-stream'};
    if (this.session) headers['Mcp-Session-Id'] = this.session;
    if (this.protocol) headers['MCP-Protocol-Version'] = this.protocol;
    const response = await this.fetch(this.url, {
      method:'POST', body:JSON.stringify(request), headers, redirect:'error', signal:AbortSignal.timeout(timeout)
    });
    if (!response.ok) throw Object.assign(Error('SDRangel HTTP ' + response.status + ' during ' + method), {status:response.status});
    this.session = response.headers.get('mcp-session-id') || this.session;
    if (notification) return;
    let reply;
    if (response.headers.get('content-type')?.includes('text/event-stream')) {
      const stream = response.body.pipeThrough(new TextDecoderStream());
      let buffered = '';
      for await (const part of stream) {
        buffered += part;
        if (buffered.length > 2e6) throw Error('SDRangel response exceeded the display limit.');
        for (;;) {
          const divider = buffered.match(/\r?\n\r?\n/);
          if (!divider) break;
          const event = buffered.slice(0,divider.index);
          buffered = buffered.slice(divider.index+divider[0].length);
          const data = event.split(/\r?\n/).filter(row=>row.startsWith('data:')).map(row=>row.slice(5).trimStart()).join('\n');
          if (!data) continue;
          const candidate = JSON.parse(data);
          if (candidate.id===request.id) { reply=candidate; break; }
        }
        if(reply) break;
      }
    } else reply = await response.json();
    if (!reply || reply.id !== request.id) throw Error('SDRangel did not return a matching reply.');
    if (reply.error) throw Error(reply.error.message || 'SDRangel reported an error.');
    return reply.result;
  }
  connect() {
    if (!this.ready) {
      this.ready = (async()=>{
        const result=await this.rpc('initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'Open Air',version:'1.0.0'}});
        this.protocol=result.protocolVersion;
        await this.rpc('notifications/initialized',{}, {notification:true});
      })().catch(error=>{this.ready=null;this.session=null;this.protocol=null;throw error;});
    }
    return this.ready;
  }
  async call(name,args={},timeout=5000) {
    await this.connect();
    let result;
    try { result=await this.rpc('tools/call',{name,arguments:args},{timeout}); }
    catch(error) {
      if(error.status===404){this.ready=null;this.session=null;this.protocol=null;}
      throw error;
    }
    const raw=result.content?.find(item=>item.type==='text')?.text || '';
    if(result.isError) throw Error(raw || name + ' failed.');
    if (result.structuredContent != null) return result.structuredContent;
    if (raw.trimStart().startsWith('{')) return JSON.parse(raw);
    return raw;
  }
}

export function parseAcars(when, input, mode=0) {
  const raw = Buffer.isBuffer(input) ? input : Buffer.from(input);
  let data = raw;
  const plain = raw.toString('utf8').trim();
  const rawFrame = (/^[\x20-\x7e\r\n\t]*$/.test(plain) ? plain : raw.toString('hex')).slice(0,8192);
  if (/^(?:[0-9a-f]{2}){10,}$/i.test(plain)) data = Buffer.from(plain,'hex');
  if (plain.startsWith('{')) {
    try {
      const json=JSON.parse(plain);
      const title=json.flight || json.tail || json.registration || json.source || json.icao;
      const detail=json.text ?? json.message ?? json.msg;
      if (title || typeof detail==='string'){
        return {title:String(title||'Aircraft message').slice(0,40),tag:String(json.label||'DATA').slice(0,8),
          detail:String(detail||'Decoded message').slice(0,4096),raw:rawFrame,time:when};
      }
    } catch {}
  }
  const bytes = Array.from(data, value=>value&0x7f);
  const start=bytes.indexOf(1);
  if (start>=0 && bytes.length>=start+14) {
    const registration=String.fromCharCode(...bytes.slice(start+2,start+9)).replace(/^[. ]+/,'');
    const tag=String.fromCharCode(...bytes.slice(start+10,start+12)).replace(/[^\w?]/g,'');
    if (/^[A-Z0-9-]{3,7}$/.test(registration) && tag.length===2) {
      const textStart=bytes.indexOf(2,start+12);
      const textEnd=textStart<0?-1:bytes.findIndex((value,index)=>index>textStart&&(value===3||value===23));
      let detail=textStart<0?'':String.fromCharCode(...bytes.slice(textStart+1,textEnd<0?Math.min(bytes.length-3,textStart+4097):textEnd));
      detail=detail.replace(/[^\x20-\x7e\n\r\t]/g,'').trim();
      return {title:registration,tag,detail:detail||'Link acknowledgement or short data frame.',raw:rawFrame,time:when};
    }
  }
  if(data.length>0 && mode===1) return {title:'VDL Mode 2 frame',tag:'VDL2',detail:data.length+' bytes received by the decoder.',raw:rawFrame,time:when};
  return null;
}

function finite(value) { return typeof value==='number'&&Number.isFinite(value); }
function aircraftText(value, limit=24) {
  return typeof value==='string'&&value.trim() ? value.trim().slice(0,limit) : undefined;
}
function aircraftSquawk(value) {
  if(typeof value==='string'&&/^[0-7]{4}$/.test(value))return value;
  return Number.isInteger(value)&&value>=0&&value<=7777?String(value).padStart(4,'0'):undefined;
}
function aircraftPosition(record, station) {
  const a=record?.aircraftState||{};
  const lat=a.latitude??record?.latitude, lon=a.longitude??record?.longitude;
  const hex=String(a.icao??record?.name??'').toLowerCase();
  if(!/^[0-9a-f]{6}$/.test(hex)||!finite(lat)||!finite(lon)||Math.abs(lat)>90||Math.abs(lon)>180||
    (lat===0&&lon===0))return null;
  const registration=aircraftText(a.registration,12);
  const aircraftType=aircraftText(a.aircraftType??a.type,12);
  const title=aircraftText(a.callsign,12)||registration||hex.toUpperCase();
  const alt=a.altitude;
  const heading=finite(a.track)?a.track:finite(a.heading)?a.heading:record.heading;
  const relative=aircraftGeometry(station,lat,lon);
  Object.assign(relative,{source:'Local receiver',registration,aircraftType,
    category:aircraftText(a.emitterCategory??a.category),onSurface:typeof a.onSurface==='boolean'?a.onSurface:undefined,
    altGeom:finite(a.geometricAltitude)?a.geometricAltitude:finite(a.altGeom)?a.altGeom:undefined,
    navigationHeading:finite(a.navigationHeading)?a.navigationHeading:undefined,
    speed:finite(a.groundSpeed)&&a.groundSpeed>=0?a.groundSpeed:finite(a.speed)&&a.speed>=0?a.speed:undefined,
    verticalRate:finite(a.verticalRate)?a.verticalRate:undefined,
    squawk:aircraftSquawk(a.squawk),emergency:aircraftText(a.emergency??a.emergencyState)});
  return {hex,title,tag:a.onSurface?'GROUND':finite(alt)?alt.toLocaleString('en-AU')+' ft':'—',detail:[
    aircraftType,finite(relative.distanceKm)?relative.distanceKm.toFixed(0)+' km':null
  ].filter(Boolean).join(' · ')||'ADS-B position',lat,lon,alt,heading,...relative};
}
export function localAircraft(record, station, now=Date.now()) {
  const time=Date.parse(record?.positionDateTime || record?.aircraftState?.positionDateTime || record?.updated || '');
  if(!Number.isFinite(time)||now-time>60000||time-now>10000)return null;
  const position=aircraftPosition(record,station);
  return position&&{...position,position:time,seen:Math.max(0,(now-time)/1000)};
}
export function localAircraftPositions(mapItems, report, station, now=Date.now()) {
  const current=new Map();
  for(const record of Array.isArray(mapItems)?mapItems:[]){
    const position=localAircraft(record,station,now);
    if(position&&(!current.has(position.hex)||position.position>current.get(position.hex).position))current.set(position.hex,position);
  }
  // SDRangel's direct tracker report can carry positions before a map pipe delivers them.
  // Its positions have no individual timestamps, so keep those fields empty in the export.
  for(const aircraftState of Array.isArray(report)?report:[]){
    const position=aircraftPosition({aircraftState},station);
    if(position&&!current.has(position.hex))current.set(position.hex,position);
  }
  return [...current.values()].sort((a,b)=>(a.distanceKm??Infinity)-(b.distanceKm??Infinity));
}
function localAircraftTrack(aircraftState, station) {
  const positioned=aircraftPosition({aircraftState},station);
  if(positioned)return positioned;
  const a=aircraftState||{};
  const hex=String(a.icao??'').toLowerCase();
  if(!/^[0-9a-f]{6}$/.test(hex))return null;
  const registration=aircraftText(a.registration,12);
  const aircraftType=aircraftText(a.aircraftType??a.type,12);
  const title=aircraftText(a.callsign,12)||registration||hex.toUpperCase();
  const alt=finite(a.altitude)?a.altitude:undefined;
  const heading=finite(a.track)?a.track:finite(a.heading)?a.heading:undefined;
  return {hex,title,tag:'NO POSITION',detail:[aircraftType,finite(alt)?alt.toLocaleString('en-AU')+' ft':null,
    'Waiting for position frames'].filter(Boolean).join(' · '),source:'Local receiver',registration,aircraftType,
    category:aircraftText(a.emitterCategory??a.category),onSurface:typeof a.onSurface==='boolean'?a.onSurface:undefined,alt,heading,
    altGeom:finite(a.geometricAltitude)?a.geometricAltitude:finite(a.altGeom)?a.altGeom:undefined,
    navigationHeading:finite(a.navigationHeading)?a.navigationHeading:undefined,
    speed:finite(a.groundSpeed)&&a.groundSpeed>=0?a.groundSpeed:finite(a.speed)&&a.speed>=0?a.speed:undefined,
    verticalRate:finite(a.verticalRate)?a.verticalRate:undefined,squawk:aircraftSquawk(a.squawk),
    emergency:aircraftText(a.emergency??a.emergencyState)};
}
export function localAircraftReceived(positions, report, station) {
  const received=new Map((Array.isArray(positions)?positions:[]).map(position=>[position.hex,position]));
  for(const aircraftState of Array.isArray(report)?report:[]){
    const track=localAircraftTrack(aircraftState,station);
    if(track&&!received.has(track.hex))received.set(track.hex,track);
  }
  return [...received.values()].sort((a,b)=>{
    const aPosition=finite(a.lat)&&finite(a.lon), bPosition=finite(b.lat)&&finite(b.lon);
    if(aPosition!==bPosition)return aPosition?-1:1;
    return (a.distanceKm??Infinity)-(b.distanceKm??Infinity)||String(a.title).localeCompare(String(b.title));
  });
}
export function aircraftFeed(state) {
  return {now:Date.now()/1000,aircraft:state.aircraft.map(a=>({
    hex:a.hex,flight:a.title,lat:a.lat,lon:a.lon,alt_baro:a.onSurface?'ground':a.alt,alt_geom:a.altGeom,
    track:a.heading,nav_heading:a.navigationHeading,gs:a.speed,baro_rate:a.verticalRate,r:a.registration,
    t:a.aircraftType,category:a.category,squawk:a.squawk,emergency:a.emergency,seen:a.seen,seen_pos:a.seen
  }))};
}

function keyed(object,suffix) { return Object.entries(object||{}).find(([key])=>key.endsWith(suffix))?.[1]||{}; }
function errorText(error) { return String(error?.message||error).slice(0,250); }
function modeOf(source) {
  if(source.mode)return source.mode;
  if(source.decoder==='ACARSDemod')return source.settings.mode===1?'vdl2':'acars';
  return receiverModes.find(mode=>mode.decoder===source.decoder)?.id??null;
}

export function audioUpdate(mode, input, gains) {
  const definition=receiverModes.find(candidate=>candidate.id===mode);
  if(!definition?.bandwidth || !defaultAudio.has(definition.decoder))throw Error('Tune an AM, narrow FM or broadcast FM channel first.');
  const settings={};
  const values=[
    ['bandwidth','rfBandwidth',definition.bandwidth,1],
    ['squelch','squelch',definition.squelch,1],
    ['volume','volume',{min:0,max:100},100]
  ];
  for(const [field,key,limits,scale] of values){
    const value=input[field];
    if(value===undefined)continue;
    if(!limits || !Number.isInteger(value) || value<limits.min || value>limits.max)throw Error('Invalid '+field+' for this audio mode.');
    settings[key]=value/scale;
  }
  const gain=input.gain;
  if(gain!==undefined && !gains?.includes(gain))throw Error('Choose a gain reported by the receiver.');
  if(gain===undefined && !Object.keys(settings).length)throw Error('No audio setting supplied.');
  return {settings,gain};
}

export class Receiver {
  constructor(mcp, device=0, capture=join(tmpdir(),'open-air-'+randomBytes(6).toString('hex')+'.csv'), archive=createMessageArchive()){
    this.mcp=mcp;
    this.device=device;
    this.capture=capture;
    this.captureReadyAt=0;
    this.messageHistory=[];
    this.archive=archive;
    this.pending=null;
  }
  call(name,args={},timeout) {
    const global = ['get_instance_summary','get_map_items','get_location','list_channel_types'].includes(name);
    return this.mcp.call(name, global?args:{deviceSetIndex:this.device,...args}, timeout);
  }
  async inspect(){
    const summary=await this.call('get_instance_summary');
    const radio=summary.devicesetlist?.deviceSets?.[this.device];
    if(radio?.samplingDevice?.hwType!=='RTLSDR'||Number(radio.samplingDevice.direction)!==0) {
      throw Error('Open your RTL-SDR receiver in SDRangel.');
    }
    return radio;
  }
  async availableModes(){
    try {
      const {rx}=await this.call('list_channel_types',{direction:'rx'},1500);
      if(!Array.isArray(rx))return null;
      const decoders=new Set(rx.filter(type=>typeof type==='string').map(type=>type.split(' ',1)[0]));
      return receiverModes.filter(mode=>!mode.decoder||decoders.has(mode.decoder)).map(mode=>mode.id);
    }catch{
      return null;
    }
  }
  async availableGains(){
    try {
      const {rtlSdrReport}=await this.call('get_device_report',{},1500);
      if(!Array.isArray(rtlSdrReport?.gains))return null;
      return [...new Set(rtlSdrReport.gains.map(item=>item.gainCB).filter(Number.isInteger))];
    } catch { return null; }
  }
  channelSettings(channelIndex){
    return this.call('get_channel_settings',{channelIndex}).then(result=>keyed(result,'Settings'));
  }
  async captureMessages(channelIndex){
    if(this.captureOwner?.channelIndex===channelIndex)return;
    const before=await this.channelSettings(channelIndex);
    if (before.logEnabled && before.logFilename!==this.capture) {
      throw Error('SDRangel is already writing to another ACARS log. Stop that log to show new messages here.');
    }
    await this.call('set_channel_settings',{channelIndex,settings:{logFilename:this.capture,logEnabled:1}});
    this.captureReadyAt=Date.now()+9000;
    this.captureOwner={channelIndex,before:{logFilename:before.logFilename||'acars_log.csv',logEnabled:before.logEnabled||0}};
  }
  async releaseCapture(){
    if(!this.captureOwner)return;
    const {channelIndex,before}=this.captureOwner;
    const current=await this.channelSettings(channelIndex);
    if(current.logFilename===this.capture && current.logEnabled){
      await this.call('set_channel_settings',{channelIndex,settings:before});
      await this.waitForCaptureClose(channelIndex,this.capture);
    }
    await this.saveCaptureSegment(this.capture,this.captureMode,this.captureFrequency);
    await unlink(this.capture).catch(()=>{});
    this.captureOwner=null;
    this.captureReadyAt=0;
    this.capture=join(tmpdir(),'open-air-'+randomBytes(6).toString('hex')+'.csv');
  }
  async waitForCaptureClose(channelIndex, filename){
    for(let attempt=0;attempt<8;attempt++){
      const settings=await this.channelSettings(channelIndex);
      if(settings.logFilename!==filename || !settings.logEnabled)return;
      await sleep(60);
    }
    throw Error('SDRangel did not close the ACARS log.');
  }
  async saveCaptureSegment(filename,mode,frequency){
    let raw;
    try {raw=await readFile(filename,'utf8');}
    catch(error) {if(error.code==='ENOENT')return; throw error;}
    const received=raw.split(/\r?\n/).filter(row=>/^\d{4}-\d\d-\d\dT/.test(row)).slice(-messageLimit).reverse()
      .map(row=>{
        const comma=row.indexOf(',');
        if(comma<0)return null;
        return parseAcars(row.slice(0,comma),row.slice(comma+1).replace(/^"|"$/g,''),mode);
      }).filter(Boolean);
    this.messageHistory=[...received,...this.messageHistory].slice(0,24);
    if(Number.isInteger(frequency)){
      await this.archive.append(received.map(message=>({...message,frequency,mode:mode===1?'vdl2':'acars'})));
    }
  }
  async readMessages(mode){
    if(!this.captureOwner)return [];
    try {
      const current=await this.channelSettings(this.captureOwner.channelIndex);
      if(current.logFilename!==this.capture || !current.logEnabled)return [];
      if(Date.now()>=this.captureReadyAt){
        // QFile can buffer short receptions. Close the app-owned log briefly to flush it.
        const previous=this.capture;
        await this.call('set_channel_settings',{channelIndex:this.captureOwner.channelIndex,settings:{logEnabled:0}});
        await this.waitForCaptureClose(this.captureOwner.channelIndex,previous);
        const next=join(tmpdir(),'open-air-'+randomBytes(6).toString('hex')+'.csv');
        await this.call('set_channel_settings',{channelIndex:this.captureOwner.channelIndex,settings:{logFilename:next,logEnabled:1}});
        this.capture=next;
        this.captureReadyAt=Date.now()+9000;
        await this.saveCaptureSegment(previous,mode,this.captureFrequency);
        await unlink(previous).catch(()=>{});
      }
      return this.messageHistory;
    } catch(error) {
      if(error.code==='ENOENT'||error.code==='EBUSY'||error.code==='EPERM')return [];
      throw error;
    }
  }
  async snapshot(){
    if(this.pending)return {connected:true,running:false,notice:'Switching sources…'};
    return this.readSnapshot();
  }
  async readSnapshot(){
    try{
      const radio=await this.inspect();
      const centre=Number(radio.samplingDevice.centerFrequency);
      const running=radio.samplingDevice.state==='running';
      const base={connected:true,running,frequency:centre,centre,mode:null,bandwidth:null,updated:new Date().toISOString(),aircraft:[],aircraftReceived:[],messages:[],activity:[]};
      const preferred = this.selectedSource;
      const candidates = [preferred,...[...availableSources,...(this.localPresets??[])].filter(p=>p.id!==preferred?.id)]
        .map(p=>p?.decoder==='ADSBDemod' && p.centre+p.offset===centre ? {...p,centre,offset:0} : p)
        .filter(p=>p?.centre===centre);
      let source=null, channel=null, selectedSettings=null;
      findSource: for(const p of candidates){
        if(!p.decoder){source=p;break;}
        for(const candidate of radio.channels||[]){
          if(candidate.id!==p.decoder)continue;
          const settings=await this.channelSettings(candidate.index);
          if(settings.inputFrequencyOffset===p.offset&&(p.settings.mode==null||settings.mode===p.settings.mode)&&
             (!defaultAudio.has(candidate.id)||!settings.audioMute)){
            source=p;
            channel=candidate;
            selectedSettings=settings;
            break findSource;
          }
        }
      }
      if(source){
        base.source=source.id;
        base.sourceName=source.name;
        base.frequency=source.centre+source.offset;
        base.mode=modeOf(source);
        if(finite(selectedSettings?.rfBandwidth))base.bandwidth=selectedSettings.rfBandwidth;
        if(finite(selectedSettings?.squelch))base.squelchThreshold=selectedSettings.squelch;
        if(finite(selectedSettings?.volume))base.volume=selectedSettings.volume;
      }
      if(!running)return base;
      const readings=await Promise.allSettled([
        this.call('get_device_settings'),
        channel?this.call('get_channel_report',{channelIndex:channel.index}):null,
        this.call('get_spectrum_data',{bins:180}),
        source?.kind==='aircraft'?this.call('get_map_items',{source:'ADSBDemod',limit:100}):null,
        source?.kind==='aircraft'?this.call('get_location'):null
      ]);
      const [dev,report,spectrum,map,station]=readings.map(item=>item.status==='fulfilled'?item.value:null);
      const stats=keyed(report,'Report');
      base.gain=dev?.rtlSdrSettings?.gain;
      if(finite(dev?.rtlSdrSettings?.devSampleRate)){
        base.span=dev.rtlSdrSettings.devSampleRate/2**(dev.rtlSdrSettings.log2Decim||0);
      }
      base.channelPower=stats.channelPowerDB;
      base.squelch=stats.squelch==null?null:Boolean(stats.squelch);
      base.spectrum=spectrum?.centerFrequency===centre?spectrum:null;
      if(source?.kind==='aircraft'){
        base.aircraft=localAircraftPositions(map?.items,stats.aircraftState,station);
        base.aircraftReceived=localAircraftReceived(base.aircraft,stats.aircraftState,station);
        base.adsb={channelSampleRate:stats.channelSampleRate,correlationThreshold:selectedSettings?.correlationThreshold,
          trackedAircraft:Array.isArray(stats.aircraftState)?stats.aircraftState.length:null};
      }
      if(source?.kind==='message'){
        base.messages=await this.readMessages(source.settings.mode);
        base.notice=this.captureOwner?null:'Select this source to start its live message log.';
      }else if(source?.kind==='voice'||source?.kind==='radio'){
        if(stats.rdsReport?.pid && stats.rdsReport.pid!=='0000')base.activity.push({
          title:stats.rdsReport.progServiceName || source.name,tag:'RDS',detail:stats.rdsReport.radioText||'Station data received.'
        });
        if(base.squelch!=null)base.activity.push({
          title:base.squelch?'Audio is open':'Listening for a transmission',
          tag:base.squelch?'OPEN':'STANDBY',detail:'Audio plays through the SDRangel receiver.'
        });
      }
      return base;
    }catch(error){
      return {connected:false,running:false,notice:'Open SDRangel and check that the local MCP Server is running. '+errorText(error)};
    }
  }
  async readVoiceSquelch(source){
    if(this.pending || this.selectedSource?.id!==source || !Number.isInteger(this.selectedChannelIndex))return this.snapshot();
    const radio=await this.inspect();
    const running=radio.samplingDevice.state==='running';
    const matching=Number(radio.samplingDevice.centerFrequency)===this.selectedSource.centre &&
      radio.channels?.some(channel=>channel.index===this.selectedChannelIndex && channel.id===this.selectedSource.decoder);
    if(!matching || !running)return {connected:true,running};
    const stats=keyed(await this.call('get_channel_report',{channelIndex:this.selectedChannelIndex}),'Report');
    return {source,connected:true,running,squelch:stats.squelch==null?null:Boolean(stats.squelch)};
  }
  async readScanSpectrum(centre){
    const radio=await this.inspect();
    const running=radio.samplingDevice.state==='running';
    const current=Number(radio.samplingDevice.centerFrequency);
    const spectrum=running && current===centre ? await this.call('get_spectrum_data',{bins:512}) : null;
    return {connected:true,running,centre:current,spectrum};
  }
  async tune(sourceId, custom, cbSquelch, {quick=false,audio,recall}={}){
    if(this.pending)throw Error('A source switch is already in progress.');
    const current=audio && this.selectedSource?.id===sourceId ? this.selectedSource : null;
    let source=recall??(custom == null ? current??availableSources.find(item=>item.id===sourceId)??this.localPresets?.find(item=>item.id===sourceId) : customSource(custom));
    if(!source)throw Error('Unknown radio source.');
    if(Number.isFinite(cbSquelch) && cbSources.has(source.id))source={...source,settings:{...source.settings,squelch:cbSquelch}};
    if(audio)source={...source,gain:audio.gain??source.gain,settings:{...source.settings,...audio.settings}};
    this.pending=this.change(source).then(async confirmed=>{
      this.selectedSource=source;
      this.selectedChannelIndex=confirmed.channelIndex;
      if(quick && confirmed.wasRunning){
        const {device,channel}=confirmed;
        return {source:source.id,sourceName:source.name,connected:true,running:true,frequency:source.centre+source.offset,centre:source.centre,
          mode:modeOf(source),bandwidth:channel?.rfBandwidth,squelchThreshold:channel?.squelch,volume:channel?.volume,
          gain:device.gain,span:device.devSampleRate/2**(device.log2Decim||0),updated:new Date().toISOString()};
      }
      const result=await this.readSnapshot();
      if(result.source!==source.id||!result.running)throw Error('SDRangel did not report the selected source.');
      return result;
    });
    try{return await this.pending;}finally{this.pending=null;}
  }
  async change(source){
    const radio=await this.inspect();
    const channels=radio.channels||[];
    const audio=defaultAudio.has(source.decoder);
    const title='Open Air '+source.decoder;
    let channel=channels.find(c=>c.id===source.decoder&&(!audio||c.title===title));
    if(source.decoder&&!channel){
      const add=await this.call('add_channel',{channelType:source.decoder,settings:audio?{title,audioMute:1}:{}},40000);
      channel=Number.isInteger(add.channelIndex)?{index:add.channelIndex,id:source.decoder}:
        (await this.inspect()).channels?.find(c=>c.id===source.decoder&&(!audio||c.title===title));
      if(!channel)throw Error('SDRangel did not create the receiver channel.');
    }
    const channelIndex=channel?.index;
    const scannerChannels=channels.filter(current=>current.id==='FreqScanner');
    const audioChannels=channels.filter(current=>defaultAudio.has(current.id)&&current.index!==channelIndex);
    const [deviceBefore,targetBefore,scannerStates,audioStates]=await Promise.all([
      this.call('get_device_settings').then(result=>result.rtlSdrSettings),
      channel?this.channelSettings(channelIndex):null,
      Promise.all(scannerChannels.map(async current=>({
        index:current.index,
        report:keyed(await this.call('get_channel_report',{channelIndex:current.index}),'Report')
      }))),
      Promise.all(audioChannels.map(async current=>({
        index:current.index,
        settings:await this.channelSettings(current.index)
      })))
    ]);
    const changed=[];
    const applySettings=async(name,args,previous,desired)=>{
      const entries=Object.entries(desired).filter(([key,value])=>previous[key]!==value);
      if(!entries.length)return;
      const rollback=Object.fromEntries(entries.filter(([key])=>previous[key]!=null).map(([key])=>[key,previous[key]]));
      if(Object.keys(rollback).length)changed.push(()=>this.call(name,{...args,settings:rollback}));
      await this.call(name,{...args,settings:Object.fromEntries(entries)});
    };
    const deviceSettings={centerFrequency:source.centre,devSampleRate:audio?1024000:2400000,log2Decim:0,agc:0,gain:source.gain};
    const targetSettings={inputFrequencyOffset:source.offset,...source.settings,...(audio?{audioMute:0,title}:{})};
    const captureFrequency=source.centre+source.offset;
    const captureChanged=source.settings.mode!==this.captureMode||captureFrequency!==this.captureFrequency;
    try{
      for(const {index,report} of scannerStates){
        if(report.scanState>0){
          changed.push(()=>this.call('channel_action',{channelIndex:index,actions:{run:1}}));
          await this.call('channel_action',{channelIndex:index,actions:{run:0}});
        }
      }
      for(const {index,settings} of audioStates){
        if(settings.audioMute===0)await applySettings('set_channel_settings',{channelIndex:index},settings,{audioMute:1});
      }
      if(this.captureOwner&&(source.kind!=='message'||captureChanged)){
        const previousChannel=this.captureOwner.channelIndex;
        await this.releaseCapture();
        changed.push(()=>this.captureMessages(previousChannel));
      }
      await applySettings('set_device_settings',{},deviceBefore,deviceSettings);
      if(channel)await applySettings('set_channel_settings',{channelIndex},targetBefore,targetSettings);
      if(radio.samplingDevice.state!=='running'){
        await this.call('start_device');
        changed.push(()=>this.call('stop_device'));
      }
      let confirmed;
      for(let attempt=0;attempt<20;attempt++){
        const [device,c]=await Promise.all([
          this.call('get_device_settings'),
          channel?this.channelSettings(channelIndex):null
        ]);
        const dev=device.rtlSdrSettings;
        if(Object.entries(deviceSettings).every(([k,v])=>dev[k]===v)&&
          (!channel||Object.entries(targetSettings).filter(([k])=>k!=='title')
            .every(([k,v])=>k==='volume'?Math.fround(c[k])===Math.fround(v):c[k]===v))){
          confirmed={device:dev,channel:c,channelIndex,wasRunning:radio.samplingDevice.state==='running'};
          break;
        }
        if(attempt===19)throw Error('The receiver did not settle on the requested frequency.');
        await sleep(75);
      }
      if(source.kind==='message'){
        await this.captureMessages(channelIndex);
        if(captureChanged)this.messageHistory=[];
        this.captureMode=source.settings.mode;
        this.captureFrequency=captureFrequency;
      }
      return confirmed;
    }catch(error){
      let restoreFailed=false;
      for(const undo of changed.reverse()){
        try{await undo();}catch{restoreFailed=true;}
      }
      if(restoreFailed)throw Error(errorText(error)+' A previous receiver setting could not be restored.');
      throw error;
    }
  }
}

const assets=new Map([
  ['/','index.html'],['/style.css','style.css'],['/app.js','app.js'],['/sources.mjs','sources.mjs'],
  ['/cb-panel.mjs','cb-panel.mjs'],['/cb-panel.css','cb-panel.css'],['/signal-meter.mjs','signal-meter.mjs'],
  ['/local-setup.mjs','local-setup.mjs'],['/tower-map.mjs','tower-map.mjs'],['/message-help.mjs','message-help.mjs'],
  ['/detail-fields.mjs','detail-fields.mjs'],['/aircraft-appearance.mjs','aircraft-appearance.mjs']
]);
const contentTypes={html:'text/html',css:'text/css',js:'application/javascript',mjs:'application/javascript'};

export async function desktopSpectrumPort(device, request=fetch){
  const root='http://'+host+':8091/sdrangel/deviceset/'+device+'/spectrum';
  const call=async(path, method='GET', data)=>{
    const response=await request(root+path,{
      method,redirect:'error',signal:AbortSignal.timeout(1500),
      ...(data ? {headers:{'Content-Type':'application/json'},body:JSON.stringify(data)} : {})
    });
    if(!response.ok)throw Error('SDRangel spectrum API returned HTTP '+response.status+'.');
    return response.json();
  };
  let status=await call('/server');
  if(Number(status.run)===0){
    await call('/settings','PATCH',{wsSpectrumAddress:host,wsSpectrumPort:8887});
    await call('/server','POST');
    for(let attempt=0;attempt<10;attempt++){
      status=await call('/server');
      if(Number(status.run)===1)break;
      await sleep(100);
    }
  }
  if(Number(status.run)!==1)throw Error('SDRangel did not start its spectrum server.');
  if(![host,'0.0.0.0','::'].includes(status.listeningAddress)){
    throw Error('Set the SDRangel spectrum server address to 127.0.0.1 for local streaming.');
  }
  return portOf(status.listeningPort,8887);
}

function send(res,status,body,type='application/json'){
  res.writeHead(status,{'Content-Type':type+'; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',
    'Content-Security-Policy':"default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; " +
      "script-src 'self' https://unpkg.com/leaflet@1.9.4/dist/; style-src 'self' https://unpkg.com/leaflet@1.9.4/dist/; " +
      "img-src 'self' data: https://tile.openstreetmap.org https://unpkg.com/leaflet@1.9.4/dist/"});
  res.end(type==='application/json'?JSON.stringify(body):body);
}

function tuneSlot(state, selected){
  if(!state?.connected || !state.running || !Number.isFinite(state.frequency))return null;
  const source=selected?.id===state.source?selected:availableSources.find(item=>item.id===state.source);
  if(!source || source.centre+source.offset!==state.frequency)return null;
  const settings={...source.settings};
  for(const [setting,reported] of [['rfBandwidth','bandwidth'],['squelch','squelchThreshold'],['volume','volume']]){
    if(finite(state[reported]))settings[setting]=state[reported];
  }
  return {...source,settings,gain:state.gain??source.gain};
}

function sameChannel(left,right){
  return left && right && left.centre+left.offset===right.centre+right.offset && modeOf(left)===modeOf(right);
}

function describeSlot(source){
  return source?{source:source.id,name:source.name,frequency:source.centre+source.offset,mode:modeOf(source)}:null;
}

export function appServer(receiver, port=8877, options={}){
  const localOrigin = 'http://' + host + ':' + port;
  const publicOrigin = options.origin ? new URL(options.origin) : null;
  if (publicOrigin && (publicOrigin.origin !== options.origin || !['https:','http:'].includes(publicOrigin.protocol))) {
    throw Error('OPEN_AIR_ORIGIN must be an HTTP or HTTPS origin without a path or trailing slash.');
  }
  const allowedHosts = new Set([host+':'+port, publicOrigin?.host].filter(Boolean));
  const allowedOrigins = new Set([localOrigin, publicOrigin?.origin].filter(Boolean));
  const access=createAccess(options.access);
  const networkAircraft=createAircraftNetwork({request:options.aircraftRequest,apiKey:options.aircraftApiKey});
  const profileStore=options.profileStore??createLocalProfileStore();
  let area, areaRevision, readingArea;
  function useProfile(profile){
    area=profile;
    areaRevision=createHash('sha256').update(JSON.stringify(profile)).digest('hex').slice(0,16);
    receiver.localPresets=profile.presets.map(localSource);
    return profile;
  }
  async function getProfile(){
    if(area)return area;
    if(!readingArea)readingArea=profileStore.read().then(useProfile).finally(()=>{readingArea=null;});
    return readingArea;
  }
  function profileSummary(){
    return {name:area?.name,includeSydney:area?.includeSydney,revision:areaRevision};
  }
  function listedPresets(){
    const examples=area.includeSydney?availableSources:availableSources.filter(source=>!isSydneyPreset(source));
    return [...examples,...receiver.localPresets];
  }
  const isTuning = () => Boolean(receiver.pending);
  const waterfall = options.spectrumPort && waterfallRelay(options.spectrumPort, isTuning);
  const audio = options.audioPort && audioRelay(options.audioPort);
  const capabilities = {
    waterfall:Boolean(waterfall||options.desktopSpectrum), audio:Boolean(audio), service:Boolean(publicOrigin)
  };
  let desktopWaterfall, preparingWaterfall, preparingAudio;
  async function prepareWaterfall(){
    if(!preparingWaterfall){
      preparingWaterfall=receiver.inspect().then(()=>desktopSpectrumPort(receiver.device)).then(streamPort=>{
        if(desktopWaterfall?.port!==streamPort){
          desktopWaterfall={port:streamPort,stream:waterfallRelay(streamPort,isTuning)};
        }
        return desktopWaterfall.stream;
      }).finally(()=>{preparingWaterfall=null;});
    }
    return preparingWaterfall;
  }
  let fresh=null, fetchedAt=0, pendingRead;
  async function snapshot(){
    if(Date.now()-fetchedAt<1300&&fresh)return fresh;
    if(!pendingRead) pendingRead=receiver.snapshot().then(s=>{fresh=s;fetchedAt=Date.now();return s;}).finally(()=>{pendingRead=null;});
    return pendingRead;
  }
  let controlling=false;
  let currentTune=null, previousTune=null, canSeedTune=true;
  let cbSquelch=receiverModes.find(mode=>mode.id==='nfm')?.squelch?.default ?? -62;
  async function tune(source,custom,options){
    if(pendingRead)await pendingRead;
    fresh=null;
    const result=await receiver.tune(source,custom,cbSquelch,options);
    fresh=result;
    fetchedAt=options?.quick?0:Date.now();
    return result;
  }
  const readSquelch=id=>receiver.readVoiceSquelch?.(id)??receiver.snapshot();
  const cbScanner=createCbScanner({tune:id=>tune(id), read:readSquelch});
  const towerScanner=createVoiceScanner({
    tune:(id,source)=>tune(id,undefined,{recall:source,quick:true}), read:readSquelch
  });
  const rfScanner=createRfScanner({
    tune:centre=>tune(undefined,{frequency:centre,mode:'spectrum'}),
    read:centre=>receiver.readScanSpectrum?.(centre)??receiver.snapshot()
  });
  function scannerStatus(){
    return {cbScan:cbScanner.status(),towerScan:towerScanner.status(),rfScan:rfScanner.status(),cbSquelch};
  }
  function seedTune(state){
    if(canSeedTune && !currentTune)currentTune=tuneSlot(state,receiver.selectedSource);
  }
  function withControls(state){
    return {...state,...scannerStatus(),ab:{current:describeSlot(currentTune),previous:describeSlot(previousTune)},profile:profileSummary()};
  }
  function haState(state){
    const {connected,running,source,sourceName,frequency,mode,channelPower,squelch,squelchThreshold,cbScan,towerScan,rfScan,cbSquelch,ab,profile}=withControls(state??{});
    return {apiVersion:1,connected:Boolean(connected),running:Boolean(running),source,sourceName,frequency,mode,
      channelPower,squelch,squelchThreshold,cbScan,towerScan,rfScan,cbSquelch,ab,profile};
  }
  async function stopScanners(){
    await Promise.all([cbScanner.stop(),towerScanner.stop(),rfScanner.stop()]);
  }
  const receiverActions=new Set(['/api/tune','/api/ab-switch','/api/cb-scan','/api/tower-scan','/api/rf-scan','/api/cb-squelch','/api/audio-settings','/api/profile','/api/local-scan']);
  const haCommands=new Set(['tune','ab-switch','cb-scan','cb-squelch','tower-scan','local-scan']);
  const server=createServer(async(req,res)=>{
    try{
      if(!allowedHosts.has(req.headers.host))return send(res,403,{error:'Use the configured Open Air address.'});
      let path=new URL(req.url,localOrigin).pathname;
      if(req.method==='GET'&&path==='/api/health')return send(res,200,{app:'open-air'});
      const ha=path.startsWith('/api/ha/');
      if(ha){
        if(!access.haEnabled)return send(res,404,{error:'Home Assistant access is disabled.'});
        if(!access.checkHa(req.headersDistinct??req.headers))return send(res,401,{error:'The Open Air token was not accepted.'});
        await getProfile();
        if(req.method==='GET'&&path==='/api/ha/state'){
          const state=await snapshot();
          seedTune(state);
          return send(res,200,haState(state));
        }
        if(req.method==='GET'&&path==='/api/ha/sources'){
          const enabledModes=await receiver.availableModes?.();
          const acceptsMode=mode=>!enabledModes||enabledModes.includes(mode);
          const sources=listedPresets().flatMap(preset=>{
            const mode=modeOf(preset);
            return acceptsMode(mode)?[{id:preset.id,name:preset.name,frequency:preset.centre+preset.offset,mode}]:[];
          });
          const modes=receiverModes.filter(({id})=>acceptsMode(id)).map(({id,label})=>({id,label}));
          return send(res,200,{sources,modes});
        }
        const command=path.slice('/api/ha/'.length);
        if(req.method!=='POST'||!haCommands.has(command))return send(res,404,{error:'Unknown Home Assistant command.'});
        path='/api/'+command;
      }else if(!access.checkWeb(req.headersDistinct??req.headers)){
        res.setHeader('WWW-Authenticate','Basic realm="Open Air", charset="UTF-8"');
        return send(res,401,{error:'Sign in to Open Air.'});
      }
      const success=state=>send(res,200,ha?haState(state?.connected===undefined?fresh:state):state);
      if(req.method==='GET'&&assets.has(path)){
        const name=assets.get(path);
        return send(res,200,await readFile(join(directory,name),'utf8'),contentTypes[name.split('.').pop()]);
      }
      if(req.method==='GET'&&path==='/api/capabilities'){
        const [availableModes,gains]=await Promise.all([receiver.availableModes?.(),receiver.availableGains?.()]);
        return send(res,200,{...capabilities,availableModes:availableModes??null,gains:gains??null});
      }
      if(req.method==='GET'&&(path==='/api/waterfall'||path==='/api/audio')){
        if(req.headers['sec-fetch-site']==='cross-site' || (req.headers.origin && !allowedOrigins.has(req.headers.origin))){
          return send(res,403,{error:'Use Open Air to receive the stream.'});
        }
        let stream = path==='/api/waterfall' ? waterfall : audio;
        if(!stream&&path==='/api/waterfall'&&options.desktopSpectrum){
          try{stream=await prepareWaterfall();}
          catch(error){return send(res,503,{error:errorText(error)});}
          if(res.destroyed)return;
        }
        if(!stream)return send(res,404,{error:'This stream is disabled.'});
        if(path==='/api/audio'){
          // SDRangel 8.1 only copies UDP audio once the tuned decoder has opened its audio output.
          if(!preparingAudio){
            preparingAudio=configureAudioForwarding(options.audioPort,options.audioRequest)
              .finally(()=>{preparingAudio=null;});
          }
          try{await preparingAudio;}
          catch(error){return send(res,503,{error:errorText(error)});}
          if(res.destroyed)return;
        }
        return stream(res);
      }
      if(req.method==='GET'&&path==='/api/profile')return send(res,200,{...(await getProfile()),revision:areaRevision});
      if(req.method==='GET'&&path==='/api/state'){
        await getProfile();
        const state=await snapshot();
        seedTune(state);
        return send(res,200,withControls(state));
      }
      if(req.method==='GET'&&path==='/api/scanners')return send(res,200,scannerStatus());
      if(req.method==='GET'&&path==='/api/messages'){
        const {revision,...history}=await receiver.archive?.read()??{messages:[],limit:messageLimit};
        if(revision){
          const tag=`"${revision}"`;
          res.setHeader('ETag',tag);
          if(req.headers['if-none-match']===tag){
            res.writeHead(304,{'Cache-Control':'no-store'});
            return res.end();
          }
        }
        return send(res,200,history);
      }
      if(req.method==='GET'&&path==='/api/tower/aircraft'){
        if(req.headers['sec-fetch-site']==='cross-site'||(req.headers.origin&&!allowedOrigins.has(req.headers.origin))){
          return send(res,403,{error:'Open the Tower view in Open Air.'});
        }
        const profile=await getProfile();
        return send(res,200,await networkAircraft(profile.aircraftCentre));
      }
      if(req.method==='GET'&&path==='/aircraft.json'){
        const state=await snapshot();
        if(!state.running||state.source!=='adsb')return send(res,503,{error:'Select ADS-B to publish local aircraft.'});
        return send(res,200,aircraftFeed(state));
      }
      if(req.method==='POST'&&path==='/api/close'){
        if(publicOrigin || !allowedOrigins.has(req.headers.origin))return send(res,403,{error:'The Open Air service is managed on the receiver.'});
        if(receiver.pending)return send(res,409,{error:'Wait for the source switch to finish.'});
        await stopScanners();
        if(pendingRead)await pendingRead;
        await receiver.releaseCapture();
        send(res,200,{closed:true});
        setTimeout(()=>server.close(),200);
        return;
      }
      if(req.method==='POST'&&receiverActions.has(path)){
        if((!ha&&!allowedOrigins.has(req.headers.origin))||!String(req.headers['content-type']).startsWith('application/json')){
          return send(res,403,{error:'Use the receiver controls in Open Air.'});
        }
        const chunks=[];
        let size=0;
        const canSaveProfile=!ha&&(path==='/api/profile'||path==='/api/local-scan');
        const maximum=canSaveProfile?64*1024:1024;
        for await(const chunk of req){
          size+=chunk.length;
          if(size>maximum)return send(res,413,{error:'Request is too large.'});
          chunks.push(chunk);
        }
        const action=JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if(controlling)return send(res,409,{error:'Another receiver control is in progress.'});
        controlling=true;
        try{
          if(path==='/api/profile'){
            const saved=useProfile(await profileStore.save(action));
            return send(res,200,{...saved,revision:areaRevision});
          }
          await getProfile();
          if(path==='/api/tune'){
            seedTune(fresh);
            await stopScanners();
            const state=await tune(action.source,action.custom,{quick:true});
            const selected=tuneSlot(state,receiver.selectedSource??customSource(action.custom));
            if(selected){
              if(!sameChannel(currentTune,selected))previousTune=currentTune;
              currentTune=selected;
            }
            return success(withControls(state));
          }
          if(path==='/api/ab-switch'){
            if(!previousTune)return send(res,409,{error:'Tune two channels to use A/B.'});
            if(action.source!==previousTune.id)return send(res,409,{error:'The A/B target changed. Try the current A/B button.'});
            const target=previousTune;
            await stopScanners();
            const state=await tune(target.id,undefined,{quick:true,recall:target});
            previousTune=currentTune;
            currentTune=tuneSlot(state,receiver.selectedSource??target)??target;
            return success(withControls(state));
          }
          if(path==='/api/audio-settings'){
            await stopScanners();
            const observed=await snapshot();
            if(!observed.connected || !observed.running || observed.source!==action.source){
              return send(res,409,{error:'The receiver changed channels. Apply settings to the current channel.'});
            }
            const gains=action.gain===undefined?null:await receiver.availableGains?.();
            const audio=audioUpdate(observed.mode,action,gains);
            seedTune(observed);
            const state=await tune(observed.source,undefined,{quick:true,audio});
            const selected=tuneSlot(state,receiver.selectedSource);
            if(sameChannel(currentTune,selected))currentTune=selected;
            return success(withControls(state));
          }
          if(path==='/api/cb-squelch'){
            const {level}=action;
            if(!Number.isInteger(level) || level < -100 || level > 0)throw Error('Enter an integer squelch level from −100 to 0 dB.');
            const old=cbSquelch;
            const resume=['scanning','holding'].includes(cbScanner.status().status);
            await cbScanner.stop();
            cbSquelch=level;
            try {
              if(towerScanner.status().status==='idle' && rfScanner.status().status!=='scanning' && cbSources.has(fresh?.source)){
                await tune(fresh.source);
              }
            } catch(error){cbSquelch=old;throw error;}
            finally{if(resume)cbScanner.start(fresh?.source);}
            return success(scannerStatus());
          }
          if(typeof action.running!=='boolean')throw Error('Specify whether the scan should run.');
          const cb=path==='/api/cb-scan';
          const tower=path==='/api/tower-scan';
          const local=path==='/api/local-scan';
          let scanProfile;
          if(local&&action.profile!==undefined&&(ha||!action.running))throw Error('Save area settings in Open Air.');
          const scanner=cb ? cbScanner : tower ? towerScanner : rfScanner;
          if(!action.running)await scanner.stop();
          else if(cb){
            seedTune(fresh);
            canSeedTune=false;
            await Promise.all([rfScanner.stop(),towerScanner.stop()]);
            cbScanner.start(fresh?.source);
          } else if(tower){
            const level=action.squelch;
            if(level!==undefined&&(!Number.isInteger(level)||level < -100||level > 0)){
              throw Error('Enter a scan squelch level from -100 to 0 dB.');
            }
            const channels=new Map();
            for(const preset of listedPresets().filter(isAirbandScanChannel))channels.set(preset.centre+preset.offset,preset);
            if(!channels.size)throw Error('Add an airband voice preset in Setup to scan this area.');
            const ordered=[...channels].sort(([a],[b])=>a-b).map(([,source])=>level===undefined?source:
              {...source,settings:{...source.settings,squelch:level}});
            seedTune(fresh);
            canSeedTune=false;
            await Promise.all([cbScanner.stop(),rfScanner.stop()]);
            towerScanner.start(receiver.selectedSource?.id??fresh?.source,ordered);
          } else {
            if(rfScanner.status().status==='scanning')return send(res,409,{error:'An RF scan is already running.'});
            if(local&&action.profile!==undefined){
              const saved=useProfile(await profileStore.save(action.profile));
              scanProfile={...saved,revision:areaRevision};
            }
            const range=local?area.scan:validateRfScanRange(action);
            seedTune(fresh);
            canSeedTune=false;
            await Promise.all([cbScanner.stop(),towerScanner.stop()]);
            rfScanner.start(range);
          }
          return success({...scannerStatus(),...(scanProfile&&{profile:scanProfile})});
        }finally{controlling=false;}
      }
      return send(res,404,{error:'Page not found.'});
    }catch(error){return send(res,400,{error:errorText(error)});}
  });
  server.once('close',()=>void stopScanners());
  return server;
}

if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  const port=portOf(process.env.OPEN_AIR_PORT,8877);
  const mcpPort=portOf(process.env.SDRANGEL_MCP_PORT,8092);
  const dataDirectory=join(homedir(),'open-air-data');
  const receiver=new Receiver(new Mcp(mcpPort),undefined,undefined,
    createMessageArchive(process.env.OPEN_AIR_MESSAGE_FILE||join(dataDirectory,'messages.json')));
  const server=appServer(receiver,port,{
    origin:process.env.OPEN_AIR_ORIGIN,
    access:{username:process.env.OPEN_AIR_WEB_USER,password:process.env.OPEN_AIR_WEB_PASSWORD,haToken:process.env.OPEN_AIR_HA_TOKEN},
    aircraftApiKey:process.env.OPEN_AIR_ADSB_LOL_API_KEY,
    profileStore:createLocalProfileStore(process.env.OPEN_AIR_PROFILE_FILE||join(dataDirectory,'local-profile.json')),
    spectrumPort:portOf(process.env.OPEN_AIR_SPECTRUM_PORT,null),
    desktopSpectrum:process.platform==='win32'&&typeof globalThis.WebSocket==='function',
    audioPort:portOf(process.env.OPEN_AIR_AUDIO_PORT,null)
  });
  server.on('error',error=>{console.error(error.message);process.exitCode=1;});
  server.listen(port,host,()=>{
    const url='http://'+host+':'+port;
    console.log('Open Air ready at '+url);
    if(process.argv.includes('--open')&&process.platform==='win32'){
      const opener=spawn('explorer.exe',[url],{stdio:'ignore',windowsHide:true,detached:true});
      opener.on('error',()=>{});
      opener.unref();
    }
  });
  for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>{
    server.close();
    receiver.releaseCapture().catch(()=>{}).finally(()=>process.exit());
  });
}

