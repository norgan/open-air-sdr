import { constants } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { copyFile, open, readFile, rename, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const stationKeys = ['OPEN_AIR_STATION_LATITUDE','OPEN_AIR_STATION_LONGITUDE'];
const receiverRoot = 'http://127.0.0.1:8091/sdrangel';

function assignmentValues(text, key) {
  const pattern = new RegExp(`^\\s*${key}\\s*=\\s*(.*?)\\s*$`);
  return text.split(/\r?\n/).map(line=>line.match(pattern)?.[1]).filter(value=>value!==undefined);
}

function unquote(value) {
  const trimmed=value.trim();
  if (trimmed.startsWith('"')&&trimmed.endsWith('"')) {
    return trimmed.slice(1,-1).replace(/\\([\\"`$])/g,'$1');
  }
  if (trimmed.startsWith("'")&&trimmed.endsWith("'")) return trimmed.slice(1,-1);
  return trimmed;
}

function stationError() {
  return Error(`Set both valid ${stationKeys[0]} and ${stationKeys[1]} values.`);
}

function parseCoordinate(value, limit) {
  const raw=unquote(value);
  if (!raw || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(raw)) throw stationError();
  const number=Number(raw);
  if (!Number.isFinite(number)||Math.abs(number)>limit) throw stationError();
  return number;
}

function configuredStation(text) {
  const values=stationKeys.map(key=>assignmentValues(text,key));
  if (values.every(matches=>matches.length===0)) return null;
  if (values.some(matches=>matches.length!==1)) throw stationError();
  return {latitude:parseCoordinate(values[0][0],90),longitude:parseCoordinate(values[1][0],180)};
}

function point(value, latitudeLimit=90) {
  return value && Number.isFinite(value.latitude) && Math.abs(value.latitude)<=latitudeLimit &&
    Number.isFinite(value.longitude) && Math.abs(value.longitude)<=180
    ? {latitude:value.latitude,longitude:value.longitude} : null;
}

function distanceKm(a,b) {
  const radians=value=>value*Math.PI/180;
  const latitude=radians(b.latitude-a.latitude);
  const longitude=radians(((b.longitude-a.longitude+540)%360)-180);
  const x=Math.sin(latitude/2)**2+
    Math.cos(radians(a.latitude))*Math.cos(radians(b.latitude))*Math.sin(longitude/2)**2;
  const bounded=Math.max(0,Math.min(1,x));
  return 6371*2*Math.atan2(Math.sqrt(bounded),Math.sqrt(1-bounded));
}

function openAirPort(text) {
  const values=assignmentValues(text,'OPEN_AIR_PORT');
  if (!values.length) return 8877;
  const port=Number(unquote(values.at(-1)));
  if (!Number.isInteger(port)||port<1||port>65535) throw Error('OPEN_AIR_PORT must be a valid port.');
  return port;
}

function profileHeaders(text) {
  const user=assignmentValues(text,'OPEN_AIR_WEB_USER').at(-1);
  const password=assignmentValues(text,'OPEN_AIR_WEB_PASSWORD').at(-1);
  if (user===undefined&&password===undefined) return {};
  if (user===undefined||password===undefined) throw Error('Set both browser sign-in values or remove both before reading the local profile.');
  return {Authorization:'Basic '+Buffer.from(`${unquote(user)}:${unquote(password)}`,'utf8').toString('base64')};
}

async function json(fetcher,url,options={}) {
  const response=await fetcher(url,{...options,signal:options.signal??AbortSignal.timeout(10000)});
  if (!response?.ok) {
    const detail=typeof response?.text==='function' ? (await response.text()).slice(0,200) : '';
    throw Error(`${options.method||'GET'} ${new URL(url).pathname} returned ${response?.status??'no response'}${detail?' '+detail:''}`);
  }
  return response.json();
}

function appendStation(text,station) {
  const newline=text.includes('\r\n')?'\r\n':'\n';
  const prefix=text && !text.endsWith('\n') ? text+newline : text;
  return prefix+`${stationKeys[0]}=${station.latitude}${newline}${stationKeys[1]}=${station.longitude}${newline}`;
}

async function writeEnvironment(envFile,after) {
  const temporary=envFile+'.'+randomBytes(8).toString('hex')+'.tmp';
  let file;
  try {
    file=await open(temporary,'wx',0o600);
    try {
      await file.writeFile(after,'utf8');
      await file.sync();
    } finally {
      await file.close();
      file=null;
    }
    await copyFile(envFile,envFile+'.before-station-reference',constants.COPYFILE_EXCL)
      .catch(error=>{if(error.code!=='EEXIST')throw error;});
    await rename(temporary,envFile);
  } finally {
    if (file) await file.close().catch(()=>{});
    await unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;});
  }
}

export async function configureStation({envFile='/etc/open-air.env',fetch=globalThis.fetch}={}) {
  const environment=await readFile(envFile,'utf8');
  let station=configuredStation(environment);
  let source='environment';
  let approximate=false;
  let profileDistanceKm;

  if (!station) {
    const profile=await json(fetch,`http://127.0.0.1:${openAirPort(environment)}/api/profile`,{headers:profileHeaders(environment)});
    const centre=point(profile?.aircraftCentre,85);
    if (!centre) throw Error('Save a valid aircraft map centre in Open Air before configuring the station reference.');
    const current=point(await json(fetch,receiverRoot+'/location'));
    profileDistanceKm=current?distanceKm(current,centre):undefined;
    if (current && profileDistanceKm<=100) {
      station=current;
      source='receiver';
    } else {
      station=centre;
      source='profile';
      approximate=true;
    }
    await writeEnvironment(envFile,appendStation(environment,station));
  }

  await json(fetch,receiverRoot+'/location',{
    method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(station)
  });
  const confirmed=point(await json(fetch,receiverRoot+'/location'));
  if (!confirmed || Math.abs(confirmed.latitude-station.latitude)>=0.0001 ||
      Math.abs(confirmed.longitude-station.longitude)>=0.0001) {
    throw Error('SDRangel did not confirm the selected station reference.');
  }

  const message=source==='environment'
    ? 'Using the explicit station reference already saved in open-air.env; its values were preserved.'
    : source==='receiver'
      ? `Using SDRangel's existing receiver location as the antenna reference (${profileDistanceKm.toFixed(1)} km from the saved profile centre).`
      : 'Using the saved profile aircraft centre as an approximate CPR reference; it is not a confirmed antenna position.';
  return {source,approximate,station,...(profileDistanceKm===undefined?{}:{profileDistanceKm}),message};
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href===import.meta.url) {
  try {
    if (process.argv.length!==3 || process.argv[2]!=='--from-profile') {
      throw Error('Usage: node configure-station.mjs --from-profile');
    }
    console.log((await configureStation()).message);
  } catch(error) {
    console.error(error.message);
    process.exitCode=1;
  }
}
