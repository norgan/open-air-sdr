import {constants, createReadStream, createWriteStream} from 'node:fs';
import {access, lstat, mkdir, open, readdir, readFile, statfs, unlink, writeFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {basename, delimiter, dirname, extname, isAbsolute, join, resolve} from 'node:path';
import {Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {crc32} from 'node:zlib';
import {lrptFrequencies, weatherSatellites} from './skywatcher-orbits.mjs';

const capturePrefix = 'open-air-sky-';
const captureId = /^[0-9a-f-]{36}$/;
const recordingLimit = 16 * 60_000;
const decodingLimit = 15 * 60_000;
const galleryLimit = 20;
const imageDirectory = 'images';
const imageTypes = {'.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg'};

export function validateWeatherTarget(input) {
  const satellite = weatherSatellites.find(item => item.id === input?.satellite);
  if (!satellite || !lrptFrequencies.includes(input.frequency)) throw Error('Choose a listed Meteor satellite and LRPT frequency.');
  if (![72000,80000].includes(input.symbolRate)) throw Error('Choose 72 or 80 ksym/s.');
  return {satellite, frequency:input.frequency, symbolRate:input.symbolRate};
}

export function readIqHeader(header) {
  if (header.length !== 32 || crc32(header.subarray(0,28)) !== header.readUInt32LE(28)) {
    throw Error('The SDRangel IQ header is incomplete or invalid.');
  }
  const sampleRate = header.readUInt32LE(0);
  const frequency = Number(header.readBigUInt64LE(4));
  const bits = header.readUInt32LE(20);
  if (sampleRate < 200000 || sampleRate > 600000 || ![16,24,32].includes(bits)) {
    throw Error('The recording uses an unsupported IQ format.');
  }
  return {sampleRate, frequency, bits, format:bits === 32 ? 'cs32' : 'cs16'};
}

export function convert24BitIq() {
  let remainder = Buffer.alloc(0);
  return new Transform({
    transform(chunk, encoding, done) {
      const input = remainder.length ? Buffer.concat([remainder,chunk]) : chunk;
      const aligned = input.length - input.length % 4;
      const pcm = Buffer.allocUnsafe(aligned / 2);
      for (let i = 0; i < aligned; i += 4) pcm.writeInt16LE(input.readInt32LE(i) >> 8, i / 2);
      remainder = input.subarray(aligned);
      done(null, pcm);
    },
    flush(done) { done(remainder.length ? Error('The IQ recording ended mid-sample.') : null); },
  });
}

export function satDumpArguments(target, iq, input, output, cli = 'stable') {
  const selected = target.symbolRate === 80000 ? 'meteor_m2-x_lrpt_80k' : 'meteor_m2-x_lrpt';
  return [...(cli === 'pipeline' ? ['pipeline'] : []), selected, 'baseband', input, output,
    '--samplerate', String(iq.sampleRate), '--baseband_format', iq.format,
    '--satellite_number', target.satellite.satdump, '--dc_block', 'true'];
}

async function findExecutable(binary) {
  const name = binary || (process.platform === 'win32' ? 'satdump.exe' : 'satdump');
  const candidates = isAbsolute(name) ? [name] : (process.env.PATH || '').split(delimiter)
    .filter(isAbsolute).map(directory => join(directory, name));
  for (const path of candidates) {
    try {
      await access(path, constants.X_OK);
      const item = await lstat(path);
      if (item.isFile() || item.isSymbolicLink()) return path;
    } catch {}
  }
  return null;
}

function runDecoder(executable, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {shell:false, windowsHide:true, stdio:['ignore','pipe','pipe']});
    let output = '', timedOut = false;
    function read(bytes) { output = (output + bytes.toString('utf8')).slice(-6000); }
    child.stdout.on('data', read);
    child.stderr.on('data', read);
    const timer = setTimeout(() => { timedOut=true; child.kill('SIGKILL'); }, decodingLimit);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => {
      clearTimeout(timer);
      if (timedOut) reject(Error('SatDump ran out of time.'));
      else if (code !== 0) {
        console.warn('Skywatcher SatDump exit:', code, output);
        reject(Error('SatDump could not decode the capture. Check the frequency, symbol rate and signal.'));
      } else resolve();
    });
  });
}

async function outputImages(directory, depth = 0) {
  if (depth > 5) return [];
  const images = [];
  for (const item of await readdir(directory, {withFileTypes:true})) {
    if (item.name.startsWith('.') || images.length >= 50) continue;
    const path = join(directory, item.name);
    if (item.isDirectory()) images.push(...await outputImages(path, depth+1));
    else if (item.isFile() && imageTypes[extname(item.name).toLowerCase()]) {
      const {size} = await lstat(path);
      if (size >= 1024 && size <= 30 * 1024 * 1024) images.push({path, size});
    }
  }
  return images.slice(0,50);
}

export function createWeatherCapture({receiver, directory, prepare, binary, cli = 'stable',
  decode = runDecoder, executable = () => findExecutable(binary), now = Date.now} = {}) {
  let current = null, timer, finishing, available, checkedAt = -Infinity;
  const root = directory && resolve(directory);
  const call = (method, args, timeout) => receiver.call(method, args, timeout);
  const enabled = Boolean(root && typeof receiver.call === 'function' && typeof receiver.inspect === 'function');
  const holdsTuner = () => ['starting','recording','stopping'].includes(current?.phase);
  const isBusy = () => holdsTuner() || Boolean(finishing);
  const makeStatus = () => current && {id:current.id, satellite:current.target.satellite.name,
    frequency:current.target.frequency, symbolRate:current.target.symbolRate, phase:current.phase,
    started:current.started, ends:current.ends, message:current.message};

  function ownedPath(path, base) {
    return typeof path === 'string' && typeof base === 'string' && isAbsolute(base) &&
      dirname(resolve(path)) === dirname(resolve(base)) && basename(path).startsWith(basename(base)+'.') &&
      extname(path).toLowerCase() === '.sdriq';
  }

  async function removeOwnedFiles(files, base) {
    for (const file of files ?? []) if (ownedPath(file.path, base)) await unlink(file.path).catch(() => {});
  }

  async function findChannel(job) {
    const report = await call('get_server_status', {}, 8000);
    const recording = report.capture?.activeRecordings?.find(item =>
      item.deviceSetIndex === receiver.device && basename(item.fileBase ?? '') === capturePrefix + job.id);
    if (!recording || !Number.isInteger(recording.channelIndex)) return null;
    job.base = recording.fileBase;
    const settings = await receiver.channelSettings(recording.channelIndex);
    if (resolve(settings.fileRecordName ?? '') !== resolve(job.base + '.sdriq')) {
      throw Error('The recorder channel changed outside Open Air.');
    }
    return recording.channelIndex;
  }

  async function stopRecording(job) {
    const channelIndex = await findChannel(job);
    if (channelIndex === null) return [];
    const stopped = await call('stop_iq_recording', {channelIndex,deleteChannel:true}, 25_000);
    if (stopped.warning && !stopped.channelDeleted) throw Error('SDRangel could not confirm the IQ recording was closed.');
    return stopped.files ?? [];
  }

  async function recover() {
    if (!enabled || holdsTuner()) return;
    const status = await call('get_server_status', {}, 8000);
    for (const active of status.capture?.activeRecordings ?? []) {
      const name = basename(active.fileBase ?? '');
      const id = name.slice(capturePrefix.length);
      if (!name.startsWith(capturePrefix) || !captureId.test(id) || active.deviceSetIndex !== receiver.device) continue;
      const job = {id,base:active.fileBase};
      const files = await stopRecording(job);
      await removeOwnedFiles(files, job.base);
    }
  }

  async function decoderPath() {
    if (now() - checkedAt >= 30_000) {
      available = await executable();
      checkedAt = now();
    }
    return available;
  }

  async function release(job) {
    if(!job.tuned||!job.afterRecording)return;
    try { await job.afterRecording(); }
    catch(error) { console.warn('Skywatcher could not restore the previous channel:',error.message); }
  }

  async function start(target, endTime, {afterRecording,onFinish} = {}) {
    if (!enabled) throw Error('Skywatcher capture is unavailable on this receiver.');
    if (isBusy()) throw Error('Wait for the current Skywatcher capture to finish.');
    const job = {id:randomUUID(),target,phase:'starting',started:now(),ends:null,afterRecording,onFinish};
    current = job;
    try {
      job.executable = await decoderPath();
      if (!job.executable) throw Error('Install SatDump on the receiver host to decode images.');
      await mkdir(root, {recursive:true,mode:0o700});
      const s = await statfs(root);
      if (s.bavail * s.bsize < 5 * 1024 ** 3) throw Error('Skywatcher needs at least 5 GiB of free space for IQ and decoding.');
      const tuned = await prepare(target);
      job.tuned = true;
      const offset = target.frequency - tuned.centre;
      if (!Number.isInteger(offset) || tuned.frequency !== target.frequency) throw Error('The receiver did not confirm the satellite frequency.');
      job.requested = true;
      const started = await call('start_iq_recording', {fileName:capturePrefix + job.id,
        log2Decim:3, frequencyOffset:offset}, 40_000);
      if (started.warning || !Number.isInteger(started.channelIndex) || !isAbsolute(started.fileBase ?? '') ||
          basename(started.fileBase) !== capturePrefix + job.id) throw Error('SDRangel did not confirm IQ recording.');
      job.base = started.fileBase;
      job.started = now();
      const maximum = job.started + recordingLimit;
      job.ends = Number.isSafeInteger(endTime) && endTime > job.started ? Math.min(maximum, endTime) : maximum;
      job.phase = 'recording';
      timer = setTimeout(() => void stop(), job.ends - now());
      timer.unref();
      return makeStatus();
    } catch (error) {
      job.phase = 'stopping';
      try {
        if (job.requested) {
          const files = await stopRecording(job);
          await removeOwnedFiles(files, job.base);
        }
        await release(job);
        job.phase = 'failed';
      } catch {
        job.phase = 'recording';
        timer = setTimeout(() => void stop({discard:true}), 5000);
        timer.unref();
      }
      job.message = error.message;
      throw error;
    }
  }

  async function processRecording(job, files) {
    const inputs = files.filter(file => ownedPath(file.path, job.base) && file.sizeBytes > 32);
    if (inputs.length !== 1) throw Error('The receiver did not produce one continuous IQ recording.');
    const source = inputs[0].path;
    const disk = await lstat(source);
    if (!disk.isFile() || disk.size > 2_450_000_032) throw Error('IQ capture exceeds the decode size limit.');
    const handle = await open(source,'r');
    let iq;
    try {
      const header = Buffer.alloc(32);
      const {bytesRead} = await handle.read(header);
      iq = readIqHeader(header.subarray(0,bytesRead));
    } finally { await handle.close(); }
    if (Math.abs(iq.frequency - job.target.frequency) > 1000) throw Error('The captured IQ frequency does not match the selected downlink.');
    const jobDir = join(root,job.id);
    const output = join(jobDir,imageDirectory);
    const input = join(jobDir,'capture.'+iq.format);
    await mkdir(output,{recursive:true,mode:0o700});
    try {
      const read = createReadStream(source,{start:32});
      const write = createWriteStream(input,{flags:'wx',mode:0o600});
      if (iq.bits === 24) await pipeline(read,convert24BitIq(),write);
      else await pipeline(read,write);
      await decode(job.executable,satDumpArguments(job.target,iq,input,output,cli));
      const images = await outputImages(output);
      if (!images.length) throw Error('No weather image decoded. Check the pass, signal and symbol rate.');
      const capture = {...makeStatus(),phase:'complete',images:images.map(({path,size})=>({
        file:path.slice(output.length + 1),name:basename(path),size,
      }))};
      await writeFile(join(jobDir,'capture.json'), JSON.stringify(capture), {flag:'wx',mode:0o600});
    } finally { await unlink(input).catch(() => {}); }
  }

  function stop({discard = false} = {}) {
    if (finishing) return finishing;
    if (current?.phase !== 'recording') return Promise.resolve(makeStatus());
    clearTimeout(timer);
    const job = current;
    job.phase = 'stopping';
    finishing = (async () => {
      let files;
      try {
        files = await stopRecording(job);
      } catch {
        job.phase = 'recording';
        job.message = 'Could not stop the IQ recorder. Retry Stop and decode.';
        timer = setTimeout(() => void stop({discard}), 5000);
        timer.unref();
        return makeStatus();
      }
      try {
        await release(job);
        job.phase = 'decoding';
        if (!discard) await processRecording(job, files);
        job.phase = discard ? 'cancelled' : 'complete';
        job.message = '';
      } catch (error) {
        job.phase = 'failed';
        job.message = error.message;
      } finally { await removeOwnedFiles(files,job.base); }
      try { await job.onFinish?.(makeStatus()); }
      catch(error) { console.warn('Skywatcher could not save the scheduled capture result:',error.message); }
      return makeStatus();
    })().finally(() => { finishing=null; });
    return finishing;
  }

  async function manifest(id) {
    if (!root || !captureId.test(id)) return null;
    try { return JSON.parse(await readFile(join(root,id,'capture.json'),'utf8')); }
    catch { return null; }
  }
  async function gallery() {
    if (!root) return [];
    const entries = await readdir(root,{withFileTypes:true}).catch(() => []);
    const results = await Promise.all(entries.filter(entry=>entry.isDirectory()&&captureId.test(entry.name))
      .map(entry=>manifest(entry.name)));
    return results.filter(Boolean).sort((a,b)=>b.started-a.started).slice(0,galleryLimit).map(item=>({...item,
      images:item.images.map(({name,size},index)=>({name,size,url:'/api/skywatcher/image/'+item.id+'/'+index})),
    }));
  }
  async function image(id,index) {
    const data = await manifest(id);
    const item = data?.images?.[index];
    if (!item?.file || isAbsolute(item.file)) return null;
    const output = join(root,id,imageDirectory);
    const path = resolve(output,item.file);
    if (!path.startsWith(output + (process.platform==='win32' ? '\\' : '/'))) return null;
    const type = imageTypes[extname(path).toLowerCase()];
    if (!type || !(await lstat(path).catch(() => null))?.isFile()) return null;
    return {path,type};
  }
  return {start,stop,recover,status:makeStatus,holdsTuner,isBusy,gallery,image,
    ready:async()=>enabled && Boolean(await decoderPath())};
}
