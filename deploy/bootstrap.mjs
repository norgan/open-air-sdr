import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';

export async function configureReceiver({request=fetch, delay=wait, env=process.env}={}) {
  const root = 'http://127.0.0.1:8091/sdrangel';
  const spectrumPort = Number(env.OPEN_AIR_SPECTRUM_PORT || 8887);
  const mcpPort = Number(env.SDRANGEL_MCP_PORT || 8092);
  for (const port of [spectrumPort,mcpPort]) {
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error('Invalid local receiver port.');
  }
  const api = async (path, method='GET', data) => {
    const res = await request(root+path, {
      method, signal:AbortSignal.timeout(4000),
      ...(data ? {headers:{'Content-Type':'application/json'},body:JSON.stringify(data)} : {})
    });
    if (!res.ok) throw Error(method+' '+path+' returned '+res.status+' '+(await res.text()).slice(0,200));
    return res.json();
  };
  const until = async (read, description) => {
    let recentError;
    for (let attempt=0; attempt<30; attempt++) {
      try {
        const value = await read();
        if (value) return value;
      } catch (error) { recentError=error.message; }
      await delay(500);
    }
    throw Error(description+(recentError ? '. '+recentError : ''));
  };
  await until(()=>api(''),'SDRangel REST service did not start');
  const {devices} = await api('/devices?direction=0');
  const radios = (devices || []).filter(device=>device.hwType==='RTLSDR' &&
    (!env.OSDR_SERIAL || device.serial===env.OSDR_SERIAL));
  if (radios.length!==1) throw Error('Expected one RTL-SDR receiver. Check guest USB assignment or set OSDR_SERIAL.');

  const readDeviceSets = async () => {
    const snapshot = await api('/devicesets');
    return snapshot.deviceSets || [];
  };
  let sets = await readDeviceSets();
  if (!sets.length) {
    await api('/deviceset?direction=0','POST');
    sets = await until(async()=> {
      const found=await readDeviceSets();
      return found.length ? found : null;
    },'No receive device set was created');
  }
  const set = sets[0].samplingDevice;
  const radio = radios[0];
  if (sets.length!==1 || (set && Number(set.direction)!==0)) throw Error('Use a dedicated receive-only SDRangel instance.');
  if (set?.hwType!=='RTLSDR' || set.serial!==radio.serial) {
    await api('/deviceset/0/device','PUT',{hwType:'RTLSDR',serial:radio.serial,direction:0});
    // SDRangel 8.1 queues the device swap. Reading devicesets during the swap can crash the server.
    await delay(1000);
    await until(async()=>{
      const current=(await readDeviceSets())[0]?.samplingDevice;
      return current?.hwType==='RTLSDR' && current.serial===radio.serial;
    },'SDRangel did not select the RTL-SDR');
  }
  await api('/deviceset/0/spectrum/settings','PATCH',{
    wsSpectrumAddress:'127.0.0.1', wsSpectrumPort:spectrumPort, fftSize:2048, linear:0, ssb:0
  });
  const spectrumPath='/deviceset/0/spectrum/server';
  if (!(await api(spectrumPath)).run) await api(spectrumPath,'POST');
  await until(async()=>{
    const state=await api(spectrumPath);
    return Number(state.run)===1 && state.listeningAddress==='127.0.0.1' && Number(state.listeningPort)===spectrumPort;
  },'The local spectrum WebSocket did not start');

  const findMcp = async () => (await api('/featureset')).features?.find(feature=>feature.id==='MCPServer');
  let mcp = await findMcp();
  if (!mcp) {
    await api('/featureset/feature','POST',{featureType:'MCPServer'});
    mcp = await until(findMcp,'The headless build did not load MCPServer');
  }
  const featurePath='/featureset/feature/'+mcp.index;
  await api(featurePath+'/settings','PATCH',{
    featureType:'MCPServer',MCPServerSettings:{address:'127.0.0.1',port:mcpPort}
  });
  if ((await api(featurePath+'/run')).state!=='running') await api(featurePath+'/run','POST');
  await until(async()=> (await api(featurePath+'/run')).state==='running','The local MCP server did not start');
  if ((await api('/deviceset/0/device/run')).state!=='running') await api('/deviceset/0/device/run','POST');
  await until(async()=> (await api('/deviceset/0/device/run')).state==='running','The RTL-SDR did not start sampling');
}

if(process.argv[1] && pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  try { await configureReceiver(); }
  catch(error) { console.error(error.message); process.exitCode=1; }
}
