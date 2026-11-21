import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Mcp, Receiver, aircraftFeed, audioUpdate, localAircraft, localAircraftPositions, parseAcars, appServer, desktopSpectrumPort } from './server.mjs';
import { catalogue, customSource, formatMHz, sources } from './sources.mjs';
import { spectrumRow } from './streams.mjs';
import { configureReceiver } from './deploy/bootstrap.mjs';

const point = {name:'abc123',latitude:10.275,longitude:20.1,aircraftState:{altitude:6900,callsign:'TEST123'}};
const instant=Date.parse('2026-11-21T03:00:00Z');

test('aircraft feed uses only current positions and keeps local range',()=>{
  const station={latitude:10,longitude:20};
  assert.equal(localAircraft({...point,positionDateTime:'2026-11-21T02:58:00Z'},station,instant),null);
  const local=localAircraft({...point,positionDateTime:'2026-11-21T02:59:45Z'},station,instant);
  assert.equal(local.title,'TEST123');
  assert.ok(local.distanceKm>30&&local.distanceKm<35);
  const feed=aircraftFeed({aircraft:[local]});
  assert.equal(feed.aircraft[0].alt_baro,6900);
  assert.equal(feed.aircraft[0].seen_pos,15);
});

test('local ADS-B uses direct decoder positions when map items are unavailable',()=>{
  const station={latitude:10,longitude:20};
  const tracker=[{icao:'abc123',latitude:10.27,longitude:20.1,callsign:'TRACKER1',altitude:6800},
    {icao:'abc124',callsign:'NO-POSITION',latitude:0,longitude:0}];
  const [direct]=localAircraftPositions(undefined,tracker,station,instant);
  assert.equal(direct.title,'TRACKER1');
  assert.ok(Number.isFinite(direct.distanceKm));
  assert.equal(aircraftFeed({aircraft:[direct]}).aircraft[0].seen_pos,undefined);
  const fresh={...point,positionDateTime:'2026-11-21T02:59:45Z'};
  const positions=localAircraftPositions([fresh],tracker,station,instant);
  assert.equal(positions.length,1);
  assert.equal(positions[0].title,'TEST123');
  assert.equal(positions[0].seen,15);
});

test('SDRangel hex capture strips parity and extracts ACARS heading and text',()=>{
  const frame=Buffer.from([1,0x32,...Buffer.from('.VH-ABC').map(v=>v|128),0x15,0x48,0x31,0x32,2,...Buffer.from('CHECK IN'),3,0,0]);
  const msg=parseAcars('2026-11-21T14:33:00', frame.toString('hex'));
  assert.equal(msg.title,'VH-ABC');
  assert.equal(msg.tag,'H1');
  assert.equal(msg.detail,'CHECK IN');
  assert.equal(parseAcars('', 'unrecognised bytes'),null);
});

test('MCP client negotiates a session and decodes its HTTP event stream',async()=>{
  let requests=0;
  const mcp=new Mcp(8092,async(url,opts)=>{
    const rpc=JSON.parse(opts.body);
    switch(requests++){
      case 0:
        assert.equal(rpc.method,'initialize');
        return Response.json({jsonrpc:'2.0',id:rpc.id,result:{protocolVersion:'2025-03-26'}},{headers:{'Mcp-Session-Id':'local-test'}});
      case 1:
        assert.equal(rpc.method,'notifications/initialized');
        assert.ok(!('id' in rpc));
        return new Response(null,{status:202});
      case 2: {
        assert.equal(opts.headers['Mcp-Session-Id'],'local-test');
        const message=JSON.stringify({jsonrpc:'2.0',id:rpc.id,result:{structuredContent:{centre:1090000000}}});
        return new Response('event: message\n'+'data: '+message+'\n\n',{headers:{'content-type':'text/event-stream'}});
      }
      default: assert.fail('Unexpected HTTP request');
    }
  });
  assert.deepEqual(await mcp.call('get_device_settings'),{centre:1090000000});
  assert.equal(requests,3);
});

test('source switch configures the live receiver and confirms the ADS-B setting',async()=>{
  const changes=[];
  const radio={centerFrequency:1090000000,devSampleRate:2400000,log2Decim:0,agc:0,gain:184};
  const settings={inputFrequencyOffset:0,correlationThreshold:7,rfBandwidth:2600000};
  const voice={inputFrequencyOffset:0,audioMute:1};
  const fake={async call(name, args){
    changes.push([name,args]);
    switch(name){
      case 'get_instance_summary':
        assert.deepEqual(args,{});
        return {devicesetlist:{deviceSets:[{samplingDevice:{direction:0,hwType:'RTLSDR',state:'running',centerFrequency:radio.centerFrequency},channels:[{id:'ADSBDemod',index:1},{id:'NFMDemod',index:2,title:'Open Air NFMDemod'}]}]}};
      case 'get_device_settings': return {rtlSdrSettings:{...radio}};
      case 'get_channel_settings': return args.channelIndex===1?{ADSBDemodSettings:{...settings}}:{NFMDemodSettings:{...voice}};
      case 'set_device_settings': Object.assign(radio,args.settings); return {};
      case 'set_channel_settings': Object.assign(args.channelIndex===1?settings:voice,args.settings); return {};
      case 'get_channel_report': return {ADSBDemodReport:{channelPowerDB:-43}};
      case 'get_map_items': return {items:[{...point,positionDateTime:new Date().toISOString()}]};
      case 'get_location': return {latitude:10,longitude:20};
      case 'get_spectrum_data': return {centerFrequency:radio.centerFrequency,power:[-80,-70]};
      default: throw Error('Unexpected radio operation '+name);
    }
  }};
  const receiver=new Receiver(fake);
  assert.equal((await receiver.snapshot()).source,'adsb');
  const current=await receiver.tune('adsb');
  assert.equal(current.source,'adsb');
  assert.equal(current.mode,'adsb');
  assert.equal(current.frequency,1090000000);
  assert.equal(current.centre,1090100000);
  assert.equal(settings.inputFrequencyOffset,-100000);
  assert.equal(settings.rfBandwidth,2000000);
  assert.ok(settings.rfBandwidth < radio.devSampleRate);
  assert.equal(current.aircraft.length,1);
  assert.equal(settings.correlationThreshold,5);
  assert.equal(sources.find(p=>p.id==='acars').centre+sources.find(p=>p.id==='acars').offset,131554000);
  assert.ok(!changes.some(([name])=>name==='delete_channel'));
  changes.length=0;
  assert.equal((await receiver.tune('adsb')).frequency,1090000000);
  assert.ok(!changes.some(([name])=>/^set_/.test(name)));
  assert.equal((await receiver.tune('cb41')).frequency,476437500);
  assert.equal(radio.devSampleRate,1024000);
  const manual=await receiver.tune(null,{mode:'nfm',frequency:476987500,name:'My UHF'});
  assert.equal(manual.frequency,476987500);
  assert.equal((await receiver.snapshot()).source,manual.source);
  const narrow=await receiver.tune(null,{mode:'nfm',frequency:476437500,bandwidth:8000});
  assert.equal(narrow.mode,'nfm');
  assert.equal(narrow.centre,476537500);
  assert.equal(narrow.bandwidth,8000);
  assert.equal(narrow.span,1024000);
  assert.equal(voice.rfBandwidth,8000);
  changes.length=0;
  const sweep=await receiver.tune(null,{mode:'spectrum',frequency:476437500});
  assert.equal(sweep.mode,'spectrum');
  assert.equal(sweep.centre,476437500);
  assert.equal(sweep.frequency,476437500);
  assert.equal(sweep.bandwidth,null);
  assert.equal(sweep.span,2400000);
  assert.equal(voice.audioMute,1);
  assert.ok(!changes.some(([name])=>name==='add_channel'));
  assert.equal((await receiver.tune('adsb')).frequency,1090000000);
  assert.equal(radio.devSampleRate,2400000);
  changes.length=0;
  const quick=await receiver.tune('cb40',undefined,-60,{quick:true,audio:{settings:{volume:0.7,rfBandwidth:8000},gain:127}});
  assert.equal(quick.source,'cb40');
  assert.equal(quick.frequency,477400000);
  assert.equal(quick.bandwidth,8000);
  assert.equal(quick.squelchThreshold,-60);
  assert.equal(quick.volume,0.7);
  assert.equal(quick.gain,127);
  assert.ok(!changes.some(([name])=>['get_channel_report','get_spectrum_data','get_map_items','get_location'].includes(name)));
});

test('live audio settings support each analogue mode and validate reported tuner gains',async()=>{
  for(const mode of ['am','nfm','bfm']){
    assert.deepEqual(audioUpdate(mode,{bandwidth:mode==='bfm'?180000:8000,squelch:-78,volume:70,gain:184},[63,184]),{
      gain:184,settings:{rfBandwidth:mode==='bfm'?180000:8000,squelch:-78,volume:0.7}
    });
  }
  assert.throws(()=>audioUpdate('adsb',{volume:70}),/Tune an/);
  assert.throws(()=>audioUpdate('am',{gain:170},[63,184]),/reported by the receiver/);
  assert.throws(()=>audioUpdate('bfm',{bandwidth:5000}),/Invalid bandwidth/);
  const receiver=new Receiver({async call(name,args){
    assert.equal(name,'get_device_report');
    assert.deepEqual(args,{deviceSetIndex:0});
    return {rtlSdrReport:{gains:[{gainCB:63},{gainCB:184},{gainCB:63}]}};
  }});
  assert.deepEqual(await receiver.availableGains(),[63,184]);
});

test('receiver modes reflect the SDRangel receive plugin inventory',async()=>{
  const radio=new Receiver({async call(name,args){
    assert.equal(name,'list_channel_types');
    assert.deepEqual(args,{direction:'rx'});
    return {rx:['AMDemod (AM Demodulator)','ACARSDemod','SSBDemod (SSB Demodulator)']};
  }});
  assert.deepEqual(new Set(await radio.availableModes()),new Set(['spectrum','am','acars','vdl2']));
});

test('desktop spectrum reuses a running listener and starts a stopped one on loopback',async()=>{
  const base='http://127.0.0.1:8091/sdrangel/deviceset/0/spectrum';
  let current={run:1,listeningAddress:'127.0.0.1',listeningPort:8990};
  const calls=[];
  const request=async(url,{method,body})=>{
    assert.ok(url.startsWith(base));
    const command=method+' '+url.slice(base.length);
    calls.push(command);
    if(command==='GET /server')return Response.json(current);
    if(command==='PATCH /settings'){
      assert.deepEqual(JSON.parse(body),{wsSpectrumAddress:'127.0.0.1',wsSpectrumPort:8887});
      return Response.json({});
    }
    if(command==='POST /server'){
      current={run:1,listeningAddress:'127.0.0.1',listeningPort:8887};
      return Response.json(current);
    }
    assert.fail('Unexpected desktop spectrum command '+command);
  };
  assert.equal(await desktopSpectrumPort(0,request),8990);
  assert.deepEqual(calls,['GET /server']);
  current={run:0};
  calls.length=0;
  assert.equal(await desktopSpectrumPort(0,request),8887);
  assert.deepEqual(calls,['GET /server','PATCH /settings','POST /server','GET /server']);
});

test('channel catalogue preserves 12.5 kHz steps and accepts supported custom modes',()=>{
  assert.equal(catalogue.filter(source=>source.group==='Australian UHF CB').length,76);
  assert.equal(formatMHz(477412500),'477.4125');
  assert.equal(formatMHz(97500000),'97.500');
  assert.equal(customSource({mode:'dvb',frequency:121500000}),null);
  assert.equal(customSource({mode:'bfm',frequency:105700000}).decoder,'BFMDemod');
});

test('waterfall downsampling keeps narrow peaks and reads the receiver centre',()=>{
  const frame=new ArrayBuffer(36+4*4);
  const data=new DataView(frame);
  data.setBigUint64(0,131650000n,true);
  data.setBigUint64(16,1700000000000n,true);
  data.setUint32(24,4,true);
  data.setUint32(28,1024000,true);
  [-95,-31,-55,-72].forEach((db,index)=>data.setFloat32(36+4*index,db,true));
  assert.deepEqual(spectrumRow(frame,2),{
    centre:131650000, span:1024000, time:1700000000000, power:[-31,-55]
  });
  assert.equal(spectrumRow(frame.slice(0,-1)),null);
});

test('headless bootstrap brings up one RTL-SDR and keeps backend streams local',async()=>{
  let samplingDevice, spectrum, mcpSettings, selected=false;
  let features=[], deviceSets=[];
  let spectrumRunning=false, mcpRunning=false, receiverRunning=false;
  const request=async(url,{method,body})=>{
    assert.ok(url.startsWith('http://127.0.0.1:8091/sdrangel'));
    const route=String(url).slice('http://127.0.0.1:8091/sdrangel'.length);
    const payload=body&&JSON.parse(body);
    switch(method+' '+route) {
      case 'GET ':return Response.json({version:'8.1.0'});
      case 'GET /devices?direction=0':return Response.json({devices:[{hwType:'RTLSDR',serial:'test'}]});
      case 'GET /devicesets':return Response.json({deviceSets});
      case 'POST /deviceset?direction=0':
        samplingDevice={direction:0};
        deviceSets=[{samplingDevice}];
        break;
      case 'PUT /deviceset/0/device':
        selected=true;
        Object.assign(samplingDevice,payload);
        break;
      case 'PATCH /deviceset/0/spectrum/settings':spectrum=payload;break;
      case 'GET /deviceset/0/spectrum/server':
        return Response.json({run:Number(spectrumRunning),listeningAddress:spectrum.wsSpectrumAddress,listeningPort:spectrum.wsSpectrumPort});
      case 'POST /deviceset/0/spectrum/server':spectrumRunning=true;break;
      case 'GET /featureset':return Response.json({features});
      case 'POST /featureset/feature':
        features=[{index:0,id:payload.featureType}];
        break;
      case 'PATCH /featureset/feature/0/settings':mcpSettings=payload.MCPServerSettings;break;
      case 'GET /featureset/feature/0/run':return Response.json({state:mcpRunning?'running':'idle'});
      case 'POST /featureset/feature/0/run':mcpRunning=true;break;
      case 'GET /deviceset/0/device/run':return Response.json({state:receiverRunning?'running':'idle'});
      case 'POST /deviceset/0/device/run':receiverRunning=true;break;
      default:assert.fail('Unexpected request '+method+' '+route);
    }
    return Response.json({});
  };
  await configureReceiver({request,delay:async()=>{},env:{}});
  assert.equal(selected,true);
  assert.equal(receiverRunning,true);
  assert.equal(spectrum.wsSpectrumAddress,'127.0.0.1');
  assert.equal(mcpSettings.address,'127.0.0.1');
  await configureReceiver({request,delay:async()=>{},env:{}});
  assert.equal(deviceSets.length,1);
  assert.equal(features.length,1);
});

test('browser playback applies audio forwarding to SDRangel before opening the stream',async(t)=>{
  const port=18881;
  const requests=[];
  const service=appServer({},port,{
    audioPort:9998,
    async audioRequest(url,{method,body}){
      requests.push({url,method,settings:JSON.parse(body)});
      return Response.json({}, {status:503});
    }
  });
  await new Promise((ok,fail)=>{service.once('error',fail);service.listen(port,'127.0.0.1',ok);});
  t.after(()=>{service.closeAllConnections();service.close();});
  const root='http://127.0.0.1:'+port;
  const capabilities=await (await fetch(root+'/api/capabilities')).json();
  assert.equal(capabilities.audio,true);
  assert.equal(requests.length,0);
  assert.equal((await fetch(root+'/api/audio',{headers:{Origin:'http://another.test'}})).status,403);
  assert.equal(requests.length,0);
  const response=await fetch(root+'/api/audio');
  assert.equal(response.status,503);
  assert.match((await response.json()).error,/SDRangel audio/);
  assert.deepEqual(requests,[{
    url:'http://127.0.0.1:8091/sdrangel/audio/output/parameters',method:'PATCH',
    settings:{index:-1,sampleRate:48000,copyToUDP:1,udpUsesRTP:0,udpChannelMode:2,
      udpChannelCodec:0,udpDecimationFactor:1,udpAddress:'127.0.0.1',udpPort:9998}
  }]);
});

test('scans share the receiver and manual tuning stops them with the requested CB squelch',async(t)=>{
  const port=18882;
  const tunes=[];
  let state={connected:true,running:true,source:'cb1'};
  const service=appServer({
    async snapshot(){return state;},
    async tune(source,custom,squelch){
      tunes.push({source,custom,squelch});
      state={connected:true,running:true,source,squelch:false,centre:custom?.frequency};
      return state;
    }
  },port);
  await new Promise((ok,fail)=>{service.once('error',fail);service.listen(port,'127.0.0.1',ok);});
  t.after(()=>{service.closeAllConnections();service.close();});
  const root='http://127.0.0.1:'+port;
  const control=async(path,body)=>{
    const response=await fetch(root+path,{method:'POST',headers:{'Content-Type':'application/json',Origin:root},body:JSON.stringify(body)});
    const result=await response.json();
    assert.equal(response.status,200,JSON.stringify(result));
    return result;
  };
  assert.equal((await control('/api/cb-squelch',{level:-74})).cbSquelch,-74);
  await control('/api/tune',{source:'cb1'});
  assert.equal(tunes.at(-1).squelch,-74);
  const cb=await control('/api/cb-scan',{running:true});
  assert.equal(cb.cbScan.status,'scanning');
  const invalid=await fetch(root+'/api/rf-scan',{method:'POST',headers:{'Content-Type':'application/json',Origin:root},
    body:JSON.stringify({running:true,startFrequency:480e6,stopFrequency:470e6})});
  assert.equal(invalid.status,400);
  assert.equal((await (await fetch(root+'/api/scanners')).json()).cbScan.status,'scanning');
  const range=await control('/api/rf-scan',{running:true,startFrequency:470e6,stopFrequency:480e6});
  assert.equal(range.cbScan.status,'idle');
  assert.equal(range.rfScan.status,'scanning');
  const manual=await control('/api/tune',{source:'cb40'});
  assert.equal(manual.rfScan.status,'stopped');
  assert.equal(manual.source,'cb40');
  assert.equal(tunes.at(-1).squelch,-74);
});

test('A/B recalls two confirmed manual channels, including custom settings, after scanner activity',async(t)=>{
  const port=18895;
  const root='http://127.0.0.1:'+port;
  const tower=sources.find(preset=>preset.id==='tower');
  let fail=false;
  const radio={
    selectedSource:tower,
    async snapshot(){
      const selected=this.selectedSource;
      return {source:selected.id,sourceName:selected.name,connected:true,running:true,
        frequency:selected.centre+selected.offset,mode:selected.mode??'am',bandwidth:selected.settings.rfBandwidth,
        squelchThreshold:selected.settings.squelch,volume:selected.settings.volume,gain:selected.gain};
    },
    async tune(id,custom,squelch,options){
      if(fail && options?.recall)throw Error('Receiver stopped before confirming tune.');
      let source=options?.recall??(custom?customSource(custom):id===tower.id?tower:this.selectedSource);
      if(options?.audio)source={...source,settings:{...source.settings,...options.audio.settings}};
      this.selectedSource=source;
      return this.snapshot();
    }
  };
  const service=appServer(radio,port);
  await new Promise((ok,fail)=>{service.once('error',fail);service.listen(port,'127.0.0.1',ok);});
  t.after(()=>{service.closeAllConnections();service.close();});
  const state=async()=> (await fetch(root+'/api/state')).json();
  const control=async(path,body,status=200,origin=root)=>{
    const response=await fetch(root+path,{method:'POST',headers:{'Content-Type':'application/json',Origin:origin},body:JSON.stringify(body)});
    const data=await response.json();
    assert.equal(response.status,status,JSON.stringify(data));
    return data;
  };
  assert.equal((await state()).ab.previous,null);
  await control('/api/ab-switch',{source:tower.id},409);
  const custom={mode:'am',frequency:125437500,bandwidth:9000,squelch:-76,name:'Quiet air'};
  const b=await control('/api/tune',{custom});
  assert.equal(b.ab.previous.source,tower.id);
  const adjusted=await control('/api/audio-settings',{source:b.source,volume:70});
  assert.equal(adjusted.ab.previous.source,tower.id);
  fail=true;
  await control('/api/ab-switch',{source:tower.id},400);
  assert.equal((await state()).ab.current.source,b.source);
  fail=false;

  await control('/api/rf-scan',{running:true,startFrequency:118000000,stopFrequency:119000000});
  assert.equal((await state()).ab.previous.source,tower.id);
  const a=await control('/api/ab-switch',{source:tower.id});
  assert.equal(a.rfScan.status,'stopped');
  assert.equal(a.source,tower.id);
  assert.equal(a.ab.previous.name,'Quiet air');
  await control('/api/ab-switch',{source:tower.id},409);
  await control('/api/ab-switch',{source:b.source},403,'http://wrong-origin.test');
  const recalled=await control('/api/ab-switch',{source:b.source});
  assert.equal(recalled.frequency,125437500);
  assert.equal(recalled.sourceName,'Quiet air');
  assert.equal(recalled.bandwidth,9000);
  assert.equal(recalled.squelchThreshold,-76);
  assert.equal(recalled.volume,0.7);
  assert.equal((await state()).ab.previous.source,tower.id);
  const sameFrequency=await control('/api/tune',{custom:{...custom,squelch:-68}});
  assert.equal(sameFrequency.ab.previous.source,tower.id);
});

test('local browser serves the UI and bars cross-origin tuning',async(t)=>{
  const port=18877;
  let tuned=0;
  const service=appServer({
    async snapshot(){return {source:'adsb',running:true,aircraft:[]};},
    async tune(){tuned++;return {source:'adsb',running:true,aircraft:[]};}
  },port,{origin:'http://open-air.home.arpa'});
  await new Promise((ok,fail)=>{service.once('error',fail);service.listen(port,'127.0.0.1',ok);});
  t.after(()=>{service.closeAllConnections();service.close();});
  const root='http://127.0.0.1:'+port;
  assert.match(await (await fetch(root)).text(),/Open Air/);
  assert.match(await (await fetch(root+'/signal-meter.mjs')).text(),/export function estimateSignal/);
  assert.equal((await (await fetch(root+'/aircraft.json')).json()).aircraft.length,0);
  const request={method:'POST',headers:{'Content-Type':'application/json',Origin:'http://another.test'},body:'{"source":"adsb"}'};
  assert.equal((await fetch(root+'/api/tune',request)).status,403);
  assert.equal(tuned,0);
  request.headers.Origin=root;
  assert.equal((await fetch(root+'/api/tune',request)).status,200);
  assert.equal(tuned,1);
  request.headers.Origin='http://open-air.home.arpa';
  assert.equal((await fetch(root+'/api/tune',request)).status,200);
  assert.equal(await (await fetch(root+'/api/capabilities')).json().then(value=>value.service),true);
  assert.equal((await fetch(root+'/api/close',{method:'POST',headers:{Origin:root}})).status,403);
});

const knownLog=process.env.OPEN_AIR_TEST_CAPTURE;
if(knownLog)test('reads an actual SDRangel ACARS capture without printing its messages',async()=>{
  const rows=(await readFile(knownLog,'utf8')).trim().split(/\r?\n/).slice(1);
  const messages=rows.map(row=>{
    const comma=row.indexOf(',');
    return parseAcars(row.slice(0,comma),row.slice(comma+1));
  });
  assert.ok(messages.some(msg=>msg?.title&&msg?.tag));
});
