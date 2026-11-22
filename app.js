import { sources, availableSources, customSource, formatMHz, isAirbandScanChannel, isAirbandVoice, isSydneyPreset, localSource, receiverModes, sample } from '/sources.mjs';
import { createCbPanel } from '/cb-panel.mjs';
import { createLocalSetup } from '/local-setup.mjs';
import { aircraftDetailFields, messageDetailFields, messageDetailKey } from '/detail-fields.mjs';
import { explainMessage } from '/message-help.mjs';
import { estimateSignal } from '/signal-meter.mjs';
import { aircraftOutline, createTowerMap } from '/tower-map.mjs';
import { applyAircraftAppearance, defaultAircraftAppearance, loadAircraftAppearance, saveAircraftAppearance } from '/aircraft-appearance.mjs';

const $ = id => document.getElementById(id);
const icons = {
  aircraft: '<path d="M12 3v18m0-10 7 5m-7-5-7 5m7 2 3 2m-3-2-3 2"/>',
  message: '<path d="M5 5h14v12H9l-4 3V5Zm4 4h6m-6 4h8"/>',
  voice: '<path d="M4 13h3l2-6 3 10 3-12 2 8h3"/>',
  spectrum: '<path d="M4 18h16M7 15v-4m5 4V5m5 10V8"/>',
  radio: '<path d="M5 8h14v11H5zM6 8l11-4M8 12h3m4 3h1m-8 1h3"/>'
};
function icon(kind) { return '<svg viewBox="0 0 24 24" aria-hidden="true">' + (icons[kind] || icons.voice) + '</svg>'; }
let mode = 'live';
let view = 'signals';
let state = {};
let busy = false;
let closed = false;
let clockGeneration = 0;
let lastSpectrum = null;
const scope = $('scope');
const buttons = [];
const waterfallCanvas = $('waterfall');
const waterfallContext = waterfallCanvas.getContext('2d');
const waterfallPixels = waterfallContext.createImageData(waterfallCanvas.width,1);
const waterfallDivider = $('waterfall-resize');
const waterfallMinimum = Number(waterfallDivider.getAttribute('aria-valuemin'));
const waterfallMaximum = Number(waterfallDivider.getAttribute('aria-valuemax'));
let waterfallDrag;

function resizeWaterfall(height, remember = false) {
  const size=Math.min(waterfallMaximum,Math.max(waterfallMinimum,Math.round(height)));
  waterfallCanvas.style.setProperty('--waterfall-height',size+'px');
  if (remember) {
    try { localStorage.setItem('open-air-waterfall-height',String(size)); } catch {}
  }
}

try {
  const height=Number(localStorage.getItem('open-air-waterfall-height'));
  if (height>=waterfallMinimum && height<=waterfallMaximum) resizeWaterfall(height);
} catch {}

new ResizeObserver(() => {
  const height=waterfallCanvas.clientHeight;
  if (!height) return;
  waterfallDivider.setAttribute('aria-valuenow',String(height));
  waterfallDivider.setAttribute('aria-valuetext',height+' pixels');
  if (height===waterfallCanvas.height) return;
  const recent=waterfallContext.getImageData(0,0,waterfallCanvas.width,Math.min(height,waterfallCanvas.height));
  waterfallCanvas.height=height;
  waterfallContext.putImageData(recent,0,0);
}).observe(waterfallCanvas);

waterfallDivider.addEventListener('pointerdown', event => {
  if (event.button!==0 || !event.isPrimary) return;
  waterfallDivider.setPointerCapture(event.pointerId);
  waterfallDrag={pointer:event.pointerId,from:event.clientY,height:waterfallCanvas.clientHeight};
});
waterfallDivider.addEventListener('pointermove', event => {
  if (waterfallDrag?.pointer===event.pointerId) resizeWaterfall(waterfallDrag.height+event.clientY-waterfallDrag.from);
});
waterfallDivider.addEventListener('lostpointercapture', event => {
  if (waterfallDrag?.pointer===event.pointerId) {
    waterfallDrag=undefined;
    resizeWaterfall(waterfallCanvas.clientHeight,true);
  }
});
waterfallDivider.addEventListener('keydown', event => {
  const height=waterfallCanvas.clientHeight;
  const next={ArrowUp:height-16,ArrowDown:height+16,Home:waterfallMinimum,End:waterfallMaximum}[event.key];
  if (next===undefined) return;
  event.preventDefault();
  resizeWaterfall(next,true);
});
const audioPlayer = $('audio-player');
const listenButton = $('listen-audio');
let streamOptions = {};
let waterfallStream;
let waterfallBand;
let waterfallScale;
let liveFrame = null;
let lastSignalFrameAt = -Infinity;
let lastMeterPaint = -Infinity;
let streamOnline = false;
let lastSnapshotRow;
const spectrumPadding = {left:45,right:16,top:20,bottom:29};
const audioRetryDelays = [700,1700];
let listenEnabled = false;
let audioPlayback = 'idle';
let audioGeneration = 0;
let audioRetryCount = 0;
let audioRetryTimer;

function audioReady() {
  if (!streamOptions.audio || closed || mode!=='live' || busy) return false;
  return Boolean(state.connected && state.running && isAudioMode(currentMode())) ||
    Boolean(scanActive(scanState.towerScan) && scanState.towerScan.source) ||
    (scanState.cbScan.status==='holding' && scanState.cbScan.squelch===true);
}

function releaseAudio() {
  audioGeneration++;
  clearTimeout(audioRetryTimer);
  audioRetryTimer = undefined;
  if (audioPlayer.hasAttribute('src')) {
    audioPlayer.pause();
    audioPlayer.removeAttribute('src');
    audioPlayer.load();
  }
  audioPlayback = 'idle';
}

function audioInterrupted(error) {
  releaseAudio();
  if (listenEnabled && audioReady()) {
    if (error?.name==='NotAllowedError' || audioRetryCount===audioRetryDelays.length) {
      audioPlayback = 'error';
    } else {
      audioRetryTimer = setTimeout(() => {
        audioRetryTimer = undefined;
        syncAudio();
      },audioRetryDelays[audioRetryCount++]);
    }
  } else {
    audioRetryCount = 0;
  }
  syncAudio();
}

function playAudio() {
  audioPlayback = 'loading';
  const generation = ++audioGeneration;
  if (!audioPlayer.hasAttribute('src')) audioPlayer.src = '/api/audio';
  audioPlayer.play().then(() => {
    if (generation!==audioGeneration) return;
    audioPlayback = 'playing';
    audioRetryCount = 0;
    syncAudio();
  }).catch(error => {
    if (generation===audioGeneration) audioInterrupted(error);
  });
}

function syncAudio() {
  const available = streamOptions.audio && !closed;
  const ready = audioReady();
  $('remote-audio').hidden = !available;
  audioPlayer.muted = !listenEnabled || !ready || scanState.towerScan.status==='scanning';
  if (!listenEnabled || !available || mode!=='live') {
    if (audioPlayer.hasAttribute('src') || audioRetryTimer || audioPlayback!=='idle') releaseAudio();
  } else if (ready && !audioRetryTimer && audioPlayback!=='error' &&
             (!audioPlayer.hasAttribute('src') || (audioPlayback==='playing' && audioPlayer.paused))) {
    playAudio();
  }
  const appearance = !listenEnabled ? 'muted' : audioPlayback==='error' ? 'error' : !ready ? 'waiting' :
    audioPlayback==='playing' ? 'playing' : 'loading';
  const hint = {muted:'Turn on receiver audio',waiting:'Listening enabled. Waiting for an audio channel.',
    loading:'Connecting to receiver audio',playing:'Mute receiver audio',error:'Tap to resume receiver audio'}[appearance];
  listenButton.dataset.audio = appearance;
  listenButton.setAttribute('aria-pressed',String(listenEnabled));
  listenButton.setAttribute('aria-description',hint);
  listenButton.title = hint;
  const label = !listenEnabled ? 'Listen' : appearance==='error' ? 'Resume audio' : 'Mute';
  if ($('listen-label').textContent!==label) $('listen-label').textContent = label;
}

for (const event of ['ended','error']) audioPlayer.addEventListener(event,() => {
  if (audioPlayer.hasAttribute('src')) audioInterrupted();
});
listenButton.addEventListener('click',() => {
  if (audioPlayback==='error') releaseAudio();
  else listenEnabled = !listenEnabled;
  audioRetryCount = 0;
  syncAudio();
});

function drawWaterfall(row) {
  if (!row.power?.length || !Number.isFinite(row.centre) || !(row.span > 0)) return;
  waterfallScale = {centre:row.centre,span:row.span};
  const band = row.centre + ':' + row.span;
  const {width,height} = waterfallCanvas;
  if(waterfallBand!==band) {
    waterfallContext.clearRect(0,0,width,height);
    waterfallBand=band;
  }
  $('waterfall-frequency').textContent = `${formatMHz(row.centre)} MHz centre · ${formatMHz(row.span)} MHz span`;
  $('waterfall-empty').hidden = true;
  const {power} = row;
  const sorted = power.slice().sort((a,b)=>a-b);
  const floor = sorted[Math.floor(sorted.length/2)] - 3;
  for(let x=0;x<width;x++) {
    const value = Math.max(0,Math.min(1,(power[Math.floor(x*power.length/width)]-floor)/48));
    const pixel = x*4;
    waterfallPixels.data.set([15+240*value**3,21+211*value**1.35,35+120*value,255],pixel);
  }
  waterfallContext.drawImage(waterfallCanvas,0,0,width,height-1,0,1,width,height-1);
  waterfallContext.putImageData(waterfallPixels,0,0);
}

function clearWaterfall(message) {
  waterfallBand = undefined;
  waterfallScale = undefined;
  liveFrame = null;
  lastSignalFrameAt = -Infinity;
  lastSnapshotRow = undefined;
  waterfallContext.clearRect(0, 0, waterfallCanvas.width, waterfallCanvas.height);
  $('waterfall-frequency').textContent = message;
  $('waterfall-empty').textContent = message;
  $('waterfall-empty').hidden = false;
}

function syncStreams() {
  const show = streamOptions.waterfall && mode==='live' && !closed;
  $('waterfall-panel').hidden = view !== 'receiver' && !show;
  syncAudio();
  if(show && !document.hidden && !waterfallStream) {
    waterfallStream = new EventSource('/api/waterfall');
    waterfallStream.onmessage = event => {
      if (busy || !state.connected || !state.running) return;
      const frame = JSON.parse(event.data);
      const centre = expectedCentre(state);
      if (Number.isFinite(centre) && Math.abs(centre - frame.centre) > 1000) return;
      liveFrame = frame;
      lastSignalFrameAt = performance.now();
      streamOnline = true;
      drawWaterfall(frame);
      syncSignalMeter(false);
      if (view === 'receiver') spectrum(spectrumFromFrame(frame));
    };
    waterfallStream.onerror = () => {
      if (streamOnline) clearWaterfall('Waiting for live samples');
      streamOnline = false;
    };
  } else if((!show || document.hidden) && waterfallStream) {
    waterfallStream.close();
    waterfallStream = null;
    streamOnline = false;
    clearWaterfall('Waiting for live samples');
  }
  if (!show && waterfallBand === undefined) clearWaterfall(mode === 'demo' ? 'Switch to live reception for the waterfall' : 'Waiting for spectrum samples');
}

function spectrumFromFrame(frame) {
  return {power:frame.power, startFrequency:frame.centre-frame.span/2, stopFrequency:frame.centre+frame.span/2};
}

const signalLabels = {
  'no-reading':'Waiting for signal', 'no-clear-carrier':'No clear carrier', 'weak-carrier':'Weak carrier',
  'carrier-detected':'Carrier detected', 'likely-usable':'Likely usable', 'audio-open':'Squelch open',
  'decode-activity':'Decoded activity'
};

function polledMeterFrame(spectrum) {
  const {startFrequency,stopFrequency,power,linear} = spectrum || {};
  if (!Number.isFinite(startFrequency) || !Number.isFinite(stopFrequency) || !(stopFrequency>startFrequency) || power?.length<2 || !Array.isArray(power)) return null;
  const centre = (startFrequency+stopFrequency)/2;
  const span = (stopFrequency-startFrequency)*power.length/(power.length-1);
  return {centre,span,power:Number(linear)===1 ? power.map(value=>Number.isFinite(value) && value>0 ? 10*Math.log10(value) : null) : power};
}

function decodedRecently(data) {
  const now = Date.now();
  return data.activity?.some(item=>item.tag==='RDS') ||
    data.aircraft?.some(item=>Number.isFinite(item.seen) && item.seen>=0 && item.seen<=8) ||
    data.messages?.some(item=>{
      const received=Date.parse(item.time);
      return Number.isFinite(received) && received<=now && now-received<=15000;
    });
}

function syncSignalMeter(force = true) {
  const now = performance.now();
  if (!force && now-lastMeterPaint<200) return;
  lastMeterPaint=now;
  const section=$('signal-meter');
  section.hidden=mode!=='live' || closed;
  if(section.hidden)return;
  const ready=!busy && state.connected && state.running;
  const frame=ready ? (liveFrame && now-lastSignalFrameAt<1400 ? liveFrame : polledMeterFrame(state.spectrum)) : null;
  const signal=estimateSignal(frame,{
    frequency:ready?state.frequency:undefined,
    bandwidth:state.bandwidth??sourceById(state.source)?.settings.rfBandwidth,
    squelch:ready?state.squelch:null,
    decoded:ready && decodedRecently(state)
  });
  const level=signal.level ?? (ready && Number.isFinite(state.channelPower) ? state.channelPower : null);
  const track=$('signal-meter-track');
  const position=value=>Math.max(0,Math.min(100,(value+120)*100/120))+'%';
  track.dataset.hasLevel=String(Number.isFinite(level));
  track.dataset.hasNoise=String(Number.isFinite(signal.noise));
  if(Number.isFinite(level))track.style.setProperty('--signal-fill',position(level));
  if(Number.isFinite(signal.noise))track.style.setProperty('--noise-position',position(signal.noise));
  const mark=Number.isFinite(level)?level.toFixed(1)+' dB':'—';
  const contrast=Number.isFinite(signal.contrast)?`${signal.contrast>=0?'+':''}${signal.contrast.toFixed(1)} dB vs floor`:'—';
  if($('signal-level').textContent!==mark)$('signal-level').textContent=mark;
  if($('signal-contrast').textContent!==contrast)$('signal-contrast').textContent=contrast;
  const label=signalLabels[signal.status] || signalLabels['no-reading'];
  const quality=$('signal-quality');
  quality.dataset.quality=signal.status;
  if(quality.textContent!==label)quality.textContent=label;
}

const choices = new Map(availableSources.map(source=>[source.id,source]));
const sydneyIds = new Set(availableSources.filter(isSydneyPreset).map(source=>source.id));
const localIds = new Set();
let localArea;
let loadingArea;
const customInputs = new Map();
const cbChannels = availableSources.filter(source => Number.isInteger(source.channel));
const cbIds = new Set(cbChannels.map(source => source.id));
const renderCb = createCbPanel($('cb-panel'), {
  channels:cbChannels.map(source => ({number:source.channel,id:source.id,frequency:source.centre+source.offset})),
  onChannel:id => selectPreset(id),
  onScanChange:running => void scannerAction('/api/cb-scan',{running}),
  onSquelchChange:level => void scannerAction('/api/cb-squelch',{level})
});
const receiverForm = $('receiver-form');
const receiverFrequency = $('receiver-frequency');
const receiverMode = $('receiver-mode');
const receiverBandwidth = $('receiver-bandwidth');
const receiverSquelch = $('receiver-squelch');
const liveAudioForm = $('live-audio-form');
const liveFilter = $('live-audio-filter');
const liveSquelch = $('live-audio-squelch');
const liveVolume = $('live-audio-volume');
const liveGain = $('live-rf-gain');
const signalList = $('signal-list');
const signalGroups = $('signal-groups');
const modes = new Map(receiverModes.map(definition => [definition.id, definition]));
const modeLabels = new Map(receiverModes.map(({id,label}) => [id,label]));
const presetModes = {AMDemod:'am',NFMDemod:'nfm',BFMDemod:'bfm',ADSBDemod:'adsb'};
const audioModes = new Set(['am','nfm','bfm']);
const viewTitles = {signals:'Signals',receiver:'Receiver',tower:'Tower','uhf-cb':'UHF CB',messages:'Messages',setup:'Setup'};
const towerChannel = $('tower-channel');
const towerSquelch = $('tower-squelch');
const showTowerMap = createTowerMap($('tower-map'),$('tower-map-status'));
function loadAircraftDisplay(key,fallback) {
  try {
    const display=window.localStorage.getItem(key);
    return ['map','radar'].includes(display)?display:fallback;
  } catch { return fallback; }
}
function saveAircraftDisplay(key,display) {
  try { window.localStorage.setItem(key,display); } catch {}
}
const towerDisplayKey='open-air-tower-aircraft-display';
const localAircraftDisplayKey='open-air-local-aircraft-display';
let towerDisplay = loadAircraftDisplay(towerDisplayKey,'map');
let localAircraftDisplay = loadAircraftDisplay(localAircraftDisplayKey,'radar');
let aircraftAppearance;
try { aircraftAppearance=loadAircraftAppearance(window.localStorage); }
catch { aircraftAppearance={...defaultAircraftAppearance}; }
applyAircraftAppearance(document.documentElement,aircraftAppearance);

function syncAircraftAppearanceControls() {
  $('aircraft-colour').value=aircraftAppearance.colour;
  $('aircraft-outline').value=aircraftAppearance.outline;
  $('aircraft-size').value=String(aircraftAppearance.size);
  $('map-opacity').value=String(aircraftAppearance.mapOpacity);
  $('aircraft-size-value').textContent=aircraftAppearance.size+' px';
  $('map-opacity-value').textContent=aircraftAppearance.mapOpacity+'%';
}
function setAircraftAppearance(patch,persist=true) {
  aircraftAppearance={...aircraftAppearance,...patch};
  if(persist) {
    try { aircraftAppearance=saveAircraftAppearance(window.localStorage,aircraftAppearance); } catch {}
  }
  aircraftAppearance=applyAircraftAppearance(document.documentElement,aircraftAppearance);
  syncAircraftAppearanceControls();
  if(view==='tower'&&towerDisplay==='radar')drawTowerTraffic(mode==='demo');
  else if(view==='signals'&&localAircraftDisplay==='radar'&&
          (sourceById(state.source)?.kind==='aircraft'||currentMode()==='adsb'))drawLocalAircraft(state,mode==='demo');
}
for(const [id,key] of [['aircraft-colour','colour'],['aircraft-outline','outline']]) {
  $(id).addEventListener('input',event=>setAircraftAppearance({[key]:event.currentTarget.value}));
}
for(const [id,key] of [['aircraft-size','size'],['map-opacity','mapOpacity']]) {
  $(id).addEventListener('input',event=>setAircraftAppearance({[key]:Number(event.currentTarget.value)}));
}
$('aircraft-style-reset').addEventListener('click',()=>setAircraftAppearance({...defaultAircraftAppearance}));
syncAircraftAppearanceControls();
let towerChoicesKey;
let towerInitTune = false;
let towerAircraft;
let localAircraftFallbackCentre;
let loadingAircraft = false;
let savedMessages;
let messageTag;
let loadingMessages=false;
let category = 'All';
let lastCb = 'cb40';
let pendingCb;
let cbEntryPending = false;
let receiverDirty = false;
let presetButtons = [];
let manualSource;
let pendingPreset;
let switchingAb = false;
let audioSettingsSource;
let audioSettingsDraft = false;
let applyingAudioSettings = false;
let gainChoices = '';
let filterChoices = '';
let scanState = {cbScan:{status:'idle'},towerScan:{status:'idle'},rfScan:{status:'idle'},cbSquelch:-62};
let scanActionPending;
let scanRefreshPending = false;
let scanGeneration = 0;
let rangeHitSignature = '';

function sourceById(id) {
  return choices.get(id) || (manualSource?.id === id ? manualSource : undefined);
}

function sourceMode(source) {
  if (source?.decoder === 'ACARSDemod') return source.settings.mode === 1 ? 'vdl2' : 'acars';
  return source?.mode || presetModes[source?.decoder] || 'spectrum';
}

function currentMode() {
  if (modes.has(state.mode)) return state.mode;
  return sourceMode(sourceById(state.source));
}

function isAudioMode(id) {
  return audioModes.has(id);
}

function expectedCentre(data) {
  const source = sourceById(data.source);
  return data.centre ?? source?.centre;
}

function registerCustom(input) {
  const source = customSource(input);
  if (!source) return null;
  customInputs.set(source.id,input);
  choices.set(source.id,source);
  return source;
}

try {
  const saved = JSON.parse(localStorage.getItem('open-air-channels') || '[]');
  if (Array.isArray(saved)) saved.forEach(registerCustom);
} catch {}

function sourceButton(source, index) {
  const button = document.createElement('button');
  button.className = 'source';
  button.type = 'button';
  button.title = 'Switch to ' + source.name;
  button.dataset.source = source.id;
  button.disabled = busy || closed;
  button.setAttribute('aria-pressed', 'false');
  const decoration = document.createElement('span');
  decoration.className = 'src-icon';
  decoration.innerHTML = icon(source.kind);
  const description = document.createElement('span');
  const label = document.createElement('strong');
  label.textContent = source.name;
  const frequency = document.createElement('small');
  frequency.textContent = `${source.label} MHz${index == null ? ' · ' + modeLabels.get(sourceMode(source)) : ''}`;
  description.append(label, frequency);
  button.append(decoration, description);
  if (index != null) {
    const key = document.createElement('kbd');
    key.textContent = index + 1;
    button.append(key);
  }
  button.addEventListener('click', () => selectPreset(source.id));
  return button;
}

for (const [index, source] of sources.entries()) {
  const button = sourceButton(source, index);
  button.hidden=!presetVisible(source.id);
  $('quick-sources').append(button);
  buttons.push(button);
}

function groupFor(source) {
  if (source.group) return source.group;
  return {aircraft:'Aircraft data',message:'Aircraft data',radio:'Sydney FM',voice:source.decoder === 'AMDemod' ? 'Sydney airband' : 'Amateur radio'}[source.kind] || 'Other';
}

function updateSelectedPresets() {
  for (const button of [...buttons, ...presetButtons]) {
    button.setAttribute('aria-pressed', String(button.dataset.source === state.source));
    button.dataset.tuning = String(button.dataset.source === pendingPreset);
  }
}

function presetVisible(id) {
  return localArea?.includeSydney===true || !sydneyIds.has(id);
}

function browserPresets() {
  return Array.from(choices.values()).filter(source=>presetVisible(source.id));
}

function renderBrowser() {
  const presets = browserPresets();
  const categories = ['All', ...new Set(presets.map(groupFor))];
  if (!categories.includes(category)) category='All';
  signalGroups.replaceChildren(...categories.map(value => {
    const button = document.createElement('button');
    button.className = 'group-filter';
    button.type = 'button';
    button.textContent = value;
    button.setAttribute('aria-pressed', String(value === category));
    button.addEventListener('click', () => {
      category = value;
      renderPresetList(presets);
      for (const chip of signalGroups.children) chip.setAttribute('aria-pressed', String(chip === button));
    });
    return button;
  }));
  renderPresetList(presets);
}

function renderPresetList(presets = browserPresets()) {
  const words = $('signal-search').value.toLocaleLowerCase('en-AU').trim().split(/\s+/).filter(Boolean);
  const matches = presets.filter(source => {
    const group = groupFor(source);
    const text = [source.name, source.label, group, sourceMode(source), modeLabels.get(sourceMode(source))].join(' ').toLocaleLowerCase('en-AU');
    return (category === 'All' || category === group) && words.every(word => text.includes(word));
  });
  presetButtons = matches.map(source => sourceButton(source));
  signalList.replaceChildren(...presetButtons);
  signalList.hidden = !matches.length;
  $('signal-empty').hidden = Boolean(matches.length);
  $('signal-empty').textContent = 'No matching presets.';
  updateSelectedPresets();
}

$('signal-search').addEventListener('input', () => renderPresetList());
renderBrowser();

function useLocalArea(profile) {
  const centreChanged = JSON.stringify(localArea?.aircraftCentre)!==JSON.stringify(profile.aircraftCentre);
  localArea=profile;
  if (centreChanged) {
    towerAircraft=undefined;
    localAircraftFallbackCentre=undefined;
  }
  for (const id of localIds) choices.delete(id);
  localIds.clear();
  for (const preset of profile.presets) {
    const source=localSource(preset);
    if (!source) continue;
    localIds.add(source.id);
    choices.set(source.id,source);
  }
  $('local-area-footer').textContent=profile.name;
  for (const button of buttons) button.hidden=!presetVisible(button.dataset.source);
  renderBrowser();
  syncLocalSetup();
  if (view==='tower') {
    drawTowerTraffic(mode==='demo');
    syncTowerControls();
    tuneTowerOnEntry();
    if (centreChanged) void refreshAircraft();
  }
  if (view==='signals' && (sourceById(state.source)?.kind==='aircraft'||currentMode()==='adsb')) {
    drawLocalAircraft(state,mode==='demo');
  }
  return profile;
}

function loadLocalArea() {
  if (!loadingArea) {
    const current = localArea;
    loadingArea=request('/api/profile').then(profile => {
      if (localArea===current) return useLocalArea(profile);
      return localArea;
    }).catch(error => {
      if (view==='setup') notice(error.message);
    }).finally(()=>{loadingArea=null;});
  }
  return loadingArea;
}

async function saveLocalArea(profile) {
  const saved=await request('/api/profile',{
    method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(profile)
  });
  return {profile:useLocalArea(saved)};
}

const localSetup = createLocalSetup({
  onSave:saveLocalArea,
  async onRescan(profile) {
    const result=await scannerAction('/api/local-scan',{running:true,...(profile && {profile})},true);
    if (result.profile) return {profile:useLocalArea(result.profile)};
  },
  onStop:()=>scannerAction('/api/local-scan',{running:false},true),
  async onTune(input) {
    const source=customSource(input);
    if (!source) throw Error('Enter a supported mode and frequency.');
    if (!await tune(source.id,input,source)) throw Error($('notice').textContent || 'The receiver could not tune this preset.');
    navigate('receiver',false);
  }
});

function syncLocalSetup() {
  if(view!=='setup')return;
  const available=mode==='live' && !closed && !busy && !scanActionPending && Boolean(state.connected);
  localSetup.update(localArea,scanState.rfScan,{canScan:available,canTune:available});
}

function towerPresets() {
  const presets = browserPresets().filter(isAirbandVoice);
  return presets.sort((left,right) => (left.centre + left.offset) - (right.centre + right.offset));
}

function syncTowerControls() {
  if (view!=='tower') return;
  const presets=towerPresets();
  const key=JSON.stringify(presets.map(({id,name,label})=>[id,name,label]));
  if (key!==towerChoicesKey) {
    towerChoicesKey=key;
    towerChannel.replaceChildren(new Option('Choose an ATC channel',''),
      ...presets.map(source=>new Option(`${source.name} · ${source.label} MHz`,source.id)));
  }
  const scan=scanState.towerScan;
  const active=mode==='live' && scanActive(scan);
  const source=sourceById(active ? scan.source : state.source);
  const available=mode==='live' && state.connected && !closed;
  const blocked=busy || Boolean(scanActionPending) || (!available && mode!=='demo');
  towerChannel.value=pendingPreset || source?.id || '';
  if (towerChannel.selectedIndex<0) towerChannel.value='';
  towerChannel.disabled=blocked || !presets.length;
  towerSquelch.disabled=active || blocked || !available;
  const scanButton=$('tower-scan');
  scanButton.textContent=active ? 'Stop scan' : 'Scan';
  scanButton.setAttribute('aria-pressed',String(active));
  scanButton.disabled=blocked || !available || (!active && !presets.some(isAirbandScanChannel));
  const status=active ? (scan.status==='holding' ? `Holding ${source?.name || 'airband'}` : 'Scanning ATC channels') :
    scan.status==='error' ? scan.error : mode==='demo' ? 'Sample view' :
    !available ? 'Waiting for the receiver' : !presets.length ? 'Add an AM airband preset in Setup' :
    currentMode()!=='am' ? 'Choose an ATC channel to listen' : '';
  const feedback=$('tower-scan-status');
  if (feedback.textContent!==status) feedback.textContent=status;
}

function tuneTowerOnEntry() {
  if (!towerInitTune || !localArea || mode!=='live' || busy || !state.connected || scanActionPending) return;
  towerInitTune=false;
  if ([scanState.cbScan,scanState.towerScan,scanState.rfScan].some(scanActive)) return;
  if (state.running && currentMode()==='am' && state.frequency>=118e6 && state.frequency<137e6) return;
  const presets=towerPresets();
  const first=presets.find(source=>source.id==='tower') ?? presets.find(isAirbandScanChannel) ?? presets[0];
  if (first) void tune(first.id);
}

async function refreshAircraft() {
  if (loadingAircraft || !localArea || view!=='tower' || mode!=='live' || closed || document.hidden) return;
  loadingAircraft=true;
  const centre=JSON.stringify(localArea.aircraftCentre);
  try {
    const result=await request('/api/tower/aircraft');
    if (centre===JSON.stringify(localArea.aircraftCentre)) towerAircraft=result;
  } catch {
    if (centre===JSON.stringify(localArea.aircraftCentre)) towerAircraft={status:'unavailable',aircraft:[]};
  } finally {
    loadingAircraft=false;
    if (view==='tower' && mode==='live') drawTowerTraffic(false);
    if (centre!==JSON.stringify(localArea.aircraftCentre)) void refreshAircraft();
  }
}

towerChannel.addEventListener('change',() => {
  if (towerChannel.value) void tune(towerChannel.value);
});
$('tower-scan').addEventListener('click',() => {
  const running=!scanActive(scanState.towerScan);
  if (!running || towerSquelch.reportValidity()) {
    void scannerAction('/api/tower-scan',{running,...(running && {squelch:towerSquelch.valueAsNumber})});
  }
});
for (const display of ['map','radar']) {
  $('tower-show-'+display).addEventListener('click',() => {
    towerDisplay=display;
    saveAircraftDisplay(towerDisplayKey,display);
    drawTowerTraffic(mode==='demo');
  });
  $('local-show-'+display).addEventListener('click',() => {
    localAircraftDisplay=display;
    saveAircraftDisplay(localAircraftDisplayKey,display);
    drawLocalAircraft(state,mode==='demo');
  });
}

function notice(message) {
  $('notice').textContent = message || '';
  $('notice').hidden = !message;
}

function readRoute() {
  const route = location.hash.slice(1);
  return Object.hasOwn(viewTitles,route) ? route : 'signals';
}

function showView(nextView, tuneCb = true) {
  const changed = view !== nextView;
  view = nextView;
  document.body.dataset.view = view;
  $('signal-browser').hidden = view !== 'signals';
  $('receiver-controls').hidden = view !== 'receiver';
  $('cb-panel').hidden = view !== 'uhf-cb';
  $('local-setup').hidden = view !== 'setup';
  $('tower-controls').hidden = view !== 'tower';
  $('decoded-history').hidden = view !== 'messages';
  $('frequency-readout').hidden = view === 'uhf-cb';
  for (const target of Object.keys(viewTitles)) {
    const link = $('nav-'+target);
    if (target === view) link.setAttribute('aria-current','page');
    else link.removeAttribute('aria-current');
  }
  if (changed && view === 'receiver') receiverDirty = false;
  if (changed) towerInitTune = view==='tower';
  render(state);
  cbEntryPending = false;
  if (view === 'uhf-cb' && tuneCb && (!cbIds.has(state.source) || !state.running)) {
    if (busy) cbEntryPending = true;
    else void tune(lastCb);
  }
  if ((view==='setup' || view==='tower') && !localArea) void loadLocalArea();
  if (view==='tower') void refreshAircraft();
  if (view==='messages') {
    drawMessages();
    void refreshMessages();
  }
}

function navigate(nextView, tuneCb = true) {
  if (location.hash !== '#'+nextView) history.pushState(null,'','#'+nextView);
  showView(nextView,tuneCb);
}

for (const target of Object.keys(viewTitles)) {
  $('nav-'+target).addEventListener('click', event => {
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigate(target);
  });
}
window.addEventListener('hashchange', () => {
  if (!location.hash || Object.hasOwn(viewTitles,location.hash.slice(1))) showView(readRoute());
});

function selectPreset(id) {
  if (busy || closed) return;
  navigate(cbIds.has(id) ? 'uhf-cb' : 'signals', false);
  void tune(id);
}

function cbStatus() {
  const cbScan = scanState.cbScan;
  const confirmedScanSource = mode==='live' && scanActive(cbScan) ? sourceById(cbScan.source) : null;
  const shown = pendingCb || confirmedScanSource?.id || (cbIds.has(state.source) ? state.source : lastCb);
  const matched = shown === state.source;
  renderCb({
    source:shown,
    frequency:confirmedScanSource && !pendingCb ? confirmedScanSource.centre + confirmedScanSource.offset : matched ? state.frequency : null,
    connected:Boolean(confirmedScanSource) || state.connected, running:Boolean(confirmedScanSource) || state.running,
    squelch:confirmedScanSource ? cbScan.squelch : matched ? state.squelch : null, demo:mode==='demo', busy,
    scan:cbScan, scanPending:scanActionPending==='/api/cb-scan',
    squelchLevel:scanState.cbSquelch, squelchPending:scanActionPending==='/api/cb-squelch'
  });
}

function scanActive(scan) {
  return scan?.status==='scanning' || scan?.status==='holding';
}

function updateScanState(data) {
  if (!data.cbScan || !data.rfScan) return;
  scanState = {cbScan:data.cbScan,towerScan:data.towerScan??{status:'idle'},rfScan:data.rfScan,cbSquelch:data.cbSquelch};
  cbStatus();
  syncTowerControls();
  renderRangeScan();
  syncAudio();
  syncLocalSetup();
}

function renderRangeScan() {
  const scan = scanState.rfScan;
  const active = scanActive(scan);
  const live = mode==='live' && !closed;
  const disabled = !live || busy || Boolean(scanActionPending);
  const hits = scan.hits || [];
  $('range-start-button').hidden = active && live;
  $('range-start-button').disabled = disabled;
  $('range-stop-button').hidden = !active || !live;
  $('range-stop-button').disabled = disabled;
  const status = $('range-status');
  const progress = $('range-progress');
  $('range-feedback').hidden = !live || scan.status==='idle';
  progress.hidden = !active;
  progress.max = scan.total || 1;
  progress.value = scan.visited || 0;
  let summary = '';
  if (active) summary = `${scan.visited || 0} / ${scan.total || 0} windows checked${scan.centre ? ' · '+formatMHz(scan.centre)+' MHz' : ''}`;
  else if (scan.status==='error') summary = scan.error || 'The receiver could not finish the scan.';
  else if (scan.status==='complete') summary = scan.survey ? `Survey complete · ${scan.levels?.length || 0} power measurements` :
    hits.length ? `${hits.length} peaks above the noise floor.` : 'No peaks met the threshold.';
  else if (scan.status==='stopped') summary = `Scan stopped after ${scan.visited || 0} windows.`;
  if (status.textContent !== summary) status.textContent = summary;
  const results = $('range-hits');
  results.hidden = !live || !hits.length;
  const signature = JSON.stringify(hits);
  if (signature !== rangeHitSignature) {
    rangeHitSignature = signature;
    results.replaceChildren(...hits.map(hit=>{
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'control';
      button.textContent = formatMHz(hit.frequency)+' MHz';
      const level = document.createElement('span');
      level.textContent = '+'+Math.round(hit.aboveNoise)+' dB';
      button.append(level);
      button.addEventListener('click', () => tuneAt(hit.frequency));
      return button;
    }));
  }
  for (const button of results.children) button.disabled = disabled;
  drawRangeProfile(scan,live);
}

function drawRangeProfile(scan, live) {
  const profile = $('range-profile');
  const levels = scan.levels || [];
  profile.hidden = !live || !scan.survey || !levels.length;
  if (profile.hidden) return;
  const ctx = profile.getContext('2d');
  const {width,height} = profile;
  const left=45, right=width-20, top=14, bottom=height-26;
  const frequencySpan=scan.stopFrequency-scan.startFrequency;
  const ladder=levels.map(point=>point.power);
  const min=Math.floor(Math.min(...ladder)/10)*10-5;
  const max=Math.max(min+20, Math.ceil(Math.max(...ladder)/10)*10+3);
  const x=frequency=>left+(frequency-scan.startFrequency)*(right-left)/frequencySpan;
  const y=power=>bottom-(power-min)*(bottom-top)/(max-min);
  ctx.clearRect(0,0,width,height);
  ctx.font='11px Cascadia Mono, Consolas, monospace';
  ctx.fillStyle='#aeb9c4';
  ctx.strokeStyle='#37424a';
  ctx.textAlign='left';
  for (const power of [min,Math.round((max+min)/2),max]) {
    ctx.beginPath();ctx.moveTo(left,y(power));ctx.lineTo(right,y(power));ctx.stroke();
    ctx.fillText(power+' dB',3,y(power)+4);
  }
  ctx.fillText(formatMHz(scan.startFrequency)+' MHz',left,height-7);
  ctx.textAlign='right';
  ctx.fillText(formatMHz(scan.stopFrequency)+' MHz',right,height-7);
  ctx.strokeStyle='#acdba1';ctx.fillStyle='#acdba1';ctx.lineWidth=2;
  ctx.beginPath();
  levels.forEach((point,index)=>index?ctx.lineTo(x(point.frequency),y(point.power)):ctx.moveTo(x(point.frequency),y(point.power)));
  ctx.stroke();
  if(levels.length===1)ctx.fillRect(x(levels[0].frequency)-2,y(levels[0].power)-2,4,4);
}

async function scannerAction(path, payload, reportFailure = false) {
  if (scanActionPending || busy || closed || mode!=='live') {
    if(reportFailure)throw Error('Wait for the current receiver action.');
    return;
  }
  scanActionPending = path;
  scanGeneration++;
  cbStatus();
  syncTowerControls();
  renderRangeScan();
  syncLiveAudioSettings();
  syncAb();
  notice('');
  try {
    const result = await request(path, {
      method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)
    });
    updateScanState(result);
    if (path==='/api/cb-squelch') void refresh();
    return result;
  } catch(error) {
    notice(error.message);
    if(reportFailure)throw error;
  }
  finally {
    scanActionPending = undefined;
    cbStatus();
    syncTowerControls();
    renderRangeScan();
    syncLiveAudioSettings();
    syncAb();
    syncLocalSetup();
  }
}

$('range-form').addEventListener('submit',event=>{
  event.preventDefault();
  void scannerAction('/api/rf-scan',{
    running:true,
    startFrequency:Math.round(Number($('range-start').value)*1e6),
    stopFrequency:Math.round(Number($('range-end').value)*1e6),
    threshold:Number($('range-threshold').value)
  });
});
$('range-stop-button').addEventListener('click',()=>void scannerAction('/api/rf-scan',{running:false}));
$('scan-mux').addEventListener('click',()=>{
  const source=sourceById(state.source);
  if(!source?.scanWidth || busy || scanActionPending) return;
  const width=source.scanWidth/2+1e6;
  const startFrequency=source.centre-width, stopFrequency=source.centre+width;
  navigate('receiver',false);
  $('range-scanner').open=true;
  $('range-start').value=formatMHz(startFrequency);
  $('range-end').value=formatMHz(stopFrequency);
  void scannerAction('/api/rf-scan',{running:true,startFrequency,stopFrequency,survey:true});
});

async function refreshScans() {
  if (closed || busy || document.hidden || mode!=='live' || scanRefreshPending || scanActionPending ||
      ![scanState.cbScan,scanState.towerScan,scanState.rfScan].some(scanActive)) return;
  scanRefreshPending = true;
  const generation = scanGeneration;
  try {
    const result = await request('/api/scanners');
    if (generation===scanGeneration && mode==='live') updateScanState(result);
  } catch {} finally { scanRefreshPending = false; }
}

function syncModeOptions() {
  const disabled = streamOptions.availableModes ? new Set(streamOptions.availableModes) : null;
  const chosen = receiverMode.value || currentMode();
  receiverMode.replaceChildren(...receiverModes.map(definition => {
    const option = document.createElement('option');
    option.value = definition.id;
    option.disabled = disabled !== null && !disabled.has(definition.id);
    option.textContent = definition.label + (option.disabled ? ' (unavailable)' : '');
    return option;
  }));
  receiverMode.value = chosen;
}

function syncModeField(input, field, limits, scale, refreshValue) {
  $(field).hidden = !limits;
  input.disabled = !limits || busy || closed;
  if (limits) {
    input.min = limits.min/scale;
    input.max = limits.max/scale;
    input.placeholder = limits.default/scale;
  }
  if (refreshValue || !limits) input.value = input.type==='range' && limits ? limits.default/scale : '';
}

function squelchReadout(input, id) {
  const text=String(input.value).replace(/^-/,'−')+' dB';
  const output=$(id);
  if(output.textContent!==text) output.textContent=text;
  input.setAttribute('aria-valuetext',text);
}

function syncModeFields(refreshValue = false) {
  const definition = modes.get(receiverMode.value);
  syncModeField(receiverBandwidth,'bandwidth-field',definition?.bandwidth,1000,refreshValue);
  syncModeField(receiverSquelch,'squelch-field',definition?.squelch,1,refreshValue);
  squelchReadout(receiverSquelch,'receiver-squelch-readout');
}

function syncReceiverForm() {
  if (view !== 'receiver' || receiverDirty) return;
  if (Number.isFinite(state.frequency)) receiverFrequency.value = formatMHz(state.frequency);
  receiverMode.value = currentMode();
  syncModeFields();
  receiverBandwidth.value = !receiverBandwidth.disabled && Number.isFinite(state.bandwidth) ? state.bandwidth/1000 : '';
  if (!receiverSquelch.disabled) {
    receiverSquelch.value = state.squelchThreshold ?? modes.get(receiverMode.value)?.squelch?.default ?? -62;
    squelchReadout(receiverSquelch,'receiver-squelch-readout');
  }
}

function syncLiveAudioSettings() {
  const source=sourceById(state.source);
  const definition=modes.get(currentMode());
  const active=mode==='live' && !closed && Boolean(state.source && state.connected && state.running && isAudioMode(currentMode()));
  $('live-audio-settings').hidden=!active;
  if (!active) return;
  const sourceChanged=audioSettingsSource!==state.source;
  if (sourceChanged) {
    audioSettingsSource=state.source;
    audioSettingsDraft=false;
  }
  const showSquelch=Boolean(definition?.squelch && !(view==='uhf-cb' && cbIds.has(state.source)));
  const gains=streamOptions.gains || [];
  $('live-squelch-field').hidden=!showSquelch;
  $('live-rf-gain-field').hidden=!gains.length;
  if (gainChoices!==gains.join(',')) {
    gainChoices=gains.join(',');
    liveGain.replaceChildren(...gains.map(gain=>new Option(String(gain/10),String(gain))));
  }
  const choices=definition?.bandwidth?.choices || [];
  if (filterChoices!==choices.join(',')) {
    filterChoices=choices.join(',');
    $('live-filter-choices').replaceChildren(...choices.map(width=>new Option(String(width/1000))));
  }
  if (definition?.bandwidth) {
    liveFilter.min=definition.bandwidth.min/1000;
    liveFilter.max=definition.bandwidth.max/1000;
  }
  if (showSquelch) {
    liveSquelch.min=definition.squelch.min;
    liveSquelch.max=definition.squelch.max;
  }
  const disabled=busy || Boolean(scanActionPending);
  liveFilter.disabled=disabled || !definition?.bandwidth;
  liveSquelch.disabled=disabled || !showSquelch;
  liveVolume.disabled=disabled;
  liveGain.disabled=disabled || !gains.length;
  const apply=$('live-audio-apply');
  apply.disabled=disabled;
  apply.textContent=applyingAudioSettings?'Applying…':'Apply';
  if (showSquelch && !applyingAudioSettings && (sourceChanged || (document.activeElement!==liveSquelch && !liveSquelch.matches(':active')))) {
    liveSquelch.value=state.squelchThreshold ?? definition.squelch.default;
  }
  squelchReadout(liveSquelch,'live-squelch-readout');
  if (audioSettingsDraft) return;
  const filter=state.bandwidth ?? definition?.bandwidth?.default;
  liveFilter.value=filter?filter/1000:'';
  liveVolume.value=Math.min(100,Math.round((state.volume??source?.settings?.volume??1)*100));
  liveGain.value=state.gain ?? '';
}

async function applyLiveAudioSettings(payload, preserveDraft = false) {
  if(busy || closed || scanActionPending || !state.source)return;
  busy=true;
  applyingAudioSettings=true;
  clockGeneration++;
  syncTuningControls();
  try {
    const result=await request('/api/audio-settings',{
      method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)
    });
    if(!preserveDraft) audioSettingsDraft=false;
    render(result);
    notice('');
  } catch(error){ notice(error.message); }
  finally{
    busy=false;
    applyingAudioSettings=false;
    syncTuningControls();
    void refresh();
  }
}

liveAudioForm.addEventListener('input',event=>{
  if(event.target===liveSquelch) squelchReadout(liveSquelch,'live-squelch-readout');
  else audioSettingsDraft=true;
});
liveSquelch.addEventListener('change',()=>{
  if(!liveSquelch.disabled && Number(liveSquelch.value)!==state.squelchThreshold) {
    void applyLiveAudioSettings({source:state.source,squelch:Number(liveSquelch.value)},true);
  }
});
liveAudioForm.addEventListener('submit',event=>{
  event.preventDefault();
  const payload={source:state.source};
  if(!liveFilter.disabled && liveFilter.value) payload.bandwidth=Math.round(Number(liveFilter.value)*1000);
  if(!liveSquelch.disabled && liveSquelch.value) payload.squelch=Number(liveSquelch.value);
  if(!liveVolume.disabled && liveVolume.value) payload.volume=Number(liveVolume.value);
  if(!liveGain.disabled && liveGain.value && Number(liveGain.value)!==state.gain) payload.gain=Number(liveGain.value);
  void applyLiveAudioSettings(payload);
});

receiverFrequency.min = 1;
receiverFrequency.max = 2000;
syncModeOptions();
syncModeFields();
receiverForm.addEventListener('input', event => {
  if ([receiverFrequency,receiverBandwidth,receiverSquelch,receiverMode].includes(event.target)) receiverDirty = true;
  if (event.target===receiverSquelch) squelchReadout(receiverSquelch,'receiver-squelch-readout');
});
receiverMode.addEventListener('change', () => {
  receiverDirty = true;
  syncModeFields(true);
});

function rememberPreset(input) {
  registerCustom(input);
  renderBrowser();
  try { localStorage.setItem('open-air-channels',JSON.stringify(Array.from(customInputs.values()))); }
  catch { return false; }
  return true;
}

async function tuneManual(input, save = false) {
  if (busy || closed) return;
  const source = customSource(input);
  if (!source || receiverMode.selectedOptions[0]?.disabled) {
    notice('Choose an available receive mode and a valid frequency and filter.');
    return;
  }
  const saved = !save || rememberPreset(input);
  await tune(source.id,input,source);
  if (!saved) notice('This browser could not save your preset for next time.');
}

receiverForm.addEventListener('submit', event => {
  event.preventDefault();
  const save = event.submitter === $('save-preset');
  const input = {frequency:Math.round(Number(receiverFrequency.value)*1e6),mode:receiverMode.value};
  if (!receiverBandwidth.disabled && receiverBandwidth.value) input.bandwidth = Math.round(Number(receiverBandwidth.value)*1000);
  if (!receiverSquelch.disabled && receiverSquelch.value) input.squelch = Number(receiverSquelch.value);
  if (save) input.name = $('preset-name').value.trim();
  void tuneManual(input, save);
});

function tuneAt(frequency) {
  if (!Number.isFinite(frequency) || busy || closed) return;
  receiverFrequency.value = formatMHz(Math.min(2e9,Math.max(1e6,Math.round(frequency))));
  receiverDirty = true;
  receiverForm.requestSubmit($('tune-frequency'));
}

function tuneStep(direction) {
  const current = Number(receiverFrequency.value)*1e6;
  const step = Number($('receiver-step').value);
  if (!receiverFrequency.value) { receiverFrequency.reportValidity(); return; }
  const frequency = step === 8333 ? (Math.round(current*3/25000)+direction)*25000/3 : current+step*direction;
  tuneAt(frequency);
}

$('step-down').addEventListener('click', () => tuneStep(-1));
$('step-up').addEventListener('click', () => tuneStep(1));
scope.addEventListener('click', event => {
  if (view !== 'receiver' || !lastSpectrum?.power?.length) return;
  const width = scope.clientWidth-spectrumPadding.left-spectrumPadding.right;
  const ratio = (event.clientX-scope.getBoundingClientRect().left-spectrumPadding.left)/width;
  if (ratio >= 0 && ratio <= 1) tuneAt(lastSpectrum.startFrequency+(lastSpectrum.stopFrequency-lastSpectrum.startFrequency)*ratio);
});
waterfallCanvas.addEventListener('click', event => {
  if (view !== 'receiver' || !waterfallScale) return;
  const {left,width} = waterfallCanvas.getBoundingClientRect();
  tuneAt(waterfallScale.centre+waterfallScale.span*((event.clientX-left)/width-0.5));
});

async function request(path, options) {
  const response = await fetch(path, { cache: 'no-store', ...options });
  const data = await response.json();
  if (!response.ok) throw Error(data.error || 'No response from the radio service.');
  return data;
}
function syncTuningControls() {
  for (const button of [...buttons, ...presetButtons]) button.disabled = busy || closed;
  for (const field of [receiverFrequency,receiverMode,$('receiver-step'),$('step-down'),$('step-up'),$('tune-frequency'),$('save-preset')]) {
    field.disabled = busy || closed;
  }
  syncModeFields();
  cbStatus();
  renderRangeScan();
  syncAudio();
  syncLiveAudioSettings();
  $('scan-mux').disabled = busy || Boolean(scanActionPending);
  syncAb();
  updateSelectedPresets();
  syncSignalMeter();
  syncLocalSetup();
  syncTowerControls();
}

function syncAb() {
  const button=$('ab-switch');
  const target=mode==='live' ? state.ab?.previous : null;
  const frequency=target ? formatMHz(target.frequency)+' MHz' : '';
  const label=target?.name || frequency;
  const description=target ? 'Switch to '+label+(label===frequency?'':' ('+frequency+')') : 'Tune two channels to use A/B';
  button.disabled=busy || closed || Boolean(scanActionPending) || !target;
  button.dataset.switching=String(switchingAb);
  button.title=description;
  button.setAttribute('aria-label','A/B. '+description);
  $('ab-target').textContent=label || '—';
}

function swapAb() {
  const target=state.ab?.previous;
  if ($('ab-switch').disabled || !target) return;
  void tune(target.source,undefined,target,true);
}

$('ab-switch').addEventListener('click',swapAb);

async function tune(id, input = customInputs.get(id), source = sourceById(id), swap = false) {
  if (busy || closed || (swap && mode!=='live')) return false;
  if (!source) return false;
  if (mode === 'demo') {
    if (!choices.has(id)) manualSource = source;
    receiverDirty = false;
    render(sample(id,source));
    return true;
  }
  busy = true;
  switchingAb = swap;
  pendingPreset = id;
  scanGeneration++;
  pendingCb = cbIds.has(id) ? id : undefined;
  clockGeneration++;
  syncTuningControls();
  clearWaterfall('Waiting for samples from the tuned frequency');
  streamOnline = false;
  notice('Tuning ' + source.name + '.');
  try {
    const data = await request(swap ? '/api/ab-switch' : '/api/tune', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(swap ? {source:id} : {source:id,custom:input})
    });
    if (!swap && !choices.has(id)) manualSource = source;
    receiverDirty = false;
    audioSettingsDraft = false;
    pendingCb = undefined;
    const targetView=cbIds.has(data.source)?'uhf-cb':'signals';
    if(swap && ['signals','uhf-cb'].includes(view) && view!==targetView){
      state=data;
      navigate(targetView,false);
    }else render(data);
    notice(data.notice);
    return true;
  } catch (error) {
    notice(error.message);
    return false;
  } finally {
    busy = false;
    switchingAb = false;
    pendingPreset = undefined;
    pendingCb = undefined;
    syncTuningControls();
    syncReceiverForm();
    if (cbEntryPending) {
      cbEntryPending = false;
      if (!cbIds.has(state.source) || !state.running) void tune(lastCb);
    }
    void refresh();
  }
}

function measure(value, label) {
  const node = document.createElement('div');
  node.className = 'metric';
  const caption = document.createElement('span');
  caption.textContent = label;
  const quantity = document.createElement('strong');
  quantity.textContent = value;
  node.title = value + ' ' + label;
  node.append(caption, quantity);
  return node;
}
function distance(value) { return Number.isFinite(value) ? value.toFixed(0) + ' km' : '—'; }
function number(value) { return Number.isFinite(value) ? value.toLocaleString('en-AU') : '—'; }
function power(value) { return Number.isFinite(value) ? value.toFixed(1) + ' dB' : '—'; }
function formattedTime(value) {
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d.toLocaleTimeString('en-AU', {hour12:false, timeZoneName:'short'}) : '';
}
function aircraftRecord(item,row,openRecords) {
  const key=JSON.stringify([item.hex||'',item.registration||'',item.title||'',item.source||'']);
  const record=document.createElement('details');
  const summary=document.createElement('summary');
  const body=document.createElement('div');
  const facts=document.createElement('dl');
  record.className='aircraft-record';
  record.dataset.aircraft=key;
  record.open=openRecords.has(key);
  summary.className='activity-item';
  summary.title='Open aircraft details';
  const compact=row.querySelector('.activity-item');
  summary.append(...compact.childNodes);
  body.className='aircraft-record-content';
  facts.className='aircraft-fields';
  for(const {label,value} of aircraftDetailFields(item)) {
    const field=document.createElement('div');
    const term=document.createElement('dt');
    const description=document.createElement('dd');
    term.textContent=label;
    description.textContent=value;
    field.append(term,description);
    facts.append(field);
  }
  body.append(facts);
  record.append(summary,body);
  return record;
}
function messageRecord(item,row,openRecords,openHelp) {
  const key=item.id||messageDetailKey(item);
  const record=document.createElement('details');
  const summary=document.createElement('summary');
  const body=document.createElement('div');
  const facts=document.createElement('dl');
  const payloadLabel=document.createElement('h3');
  const payload=document.createElement('pre');
  record.className='message-record';
  record.dataset.message=key;
  record.open=openRecords.has(key);
  summary.className='activity-item';
  summary.title='Open message details';
  const compact=row.querySelector('.activity-item');
  summary.append(...compact.childNodes);
  body.className='message-record-content';
  facts.className='message-fields';
  for(const {label,value} of messageDetailFields(item)) {
    const field=document.createElement('div');
    const term=document.createElement('dt');
    const description=document.createElement('dd');
    term.textContent=label;
    description.textContent=value;
    field.append(term,description);
    facts.append(field);
  }
  payloadLabel.textContent='Decoded payload';
  payload.textContent=item.detail||'No decoded payload text was reported.';
  const {summary:meaning,fields}=explainMessage(item);
  const help=document.createElement('details');
  const trigger=document.createElement('summary');
  const explanation=document.createElement('div');
  help.className='message-help';
  help.dataset.message=key;
  help.open=openHelp.has(key);
  trigger.textContent='Meaning';
  trigger.title=[meaning,...fields].join('\n');
  for(const line of [meaning,...fields]) {
    const paragraph=document.createElement('p');
    paragraph.textContent=line;
    explanation.append(paragraph);
  }
  help.append(trigger,explanation);
  body.append(facts,payloadLabel,payload);
  if(item.raw&&item.raw!==item.detail) {
    const rawLabel=document.createElement('h3');
    const raw=document.createElement('pre');
    rawLabel.textContent='Raw frame';
    raw.textContent=item.raw;
    body.append(rawLabel,raw);
  }
  body.append(help);
  record.append(summary,body);
  return record;
}
function rows(items, kind, emptyText, list = $('activity'), limit = 24) {
  const content=document.createDocumentFragment();
  const openHelp=new Set(Array.from(list.querySelectorAll('.message-help[open]'),node=>node.dataset.message));
  const openMessages=new Set(Array.from(list.querySelectorAll('.message-record[open]'),node=>node.dataset.message));
  const openAircraft=new Set(Array.from(list.querySelectorAll('.aircraft-record[open]'),node=>node.dataset.aircraft));
  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = emptyText ?? (kind === 'aircraft' ? 'No positions from your antenna yet.' :
      kind === 'message' ? 'Listening for decoded messages…' : 'Waiting for receiver measurements.');
    content.append(empty);
  }
  for (const item of items.slice(0,limit)) {
    const row = $('thing').content.cloneNode(true);
    row.querySelector('.item-icon').innerHTML = icon(kind);
    row.querySelector('strong').textContent = item.title || 'Received signal';
    row.querySelector('small').textContent = item.tag || '';
    row.querySelector('.item-detail').textContent = item.detail || '';
    if (kind==='aircraft') {
      content.append(aircraftRecord(item,row,openAircraft));
      continue;
    }
    if (kind==='message') {
      content.append(messageRecord(item,row,openMessages,openHelp));
      continue;
    }
    content.append(row);
  }
  list.replaceChildren(content);
}

function drawMessages() {
  if (view!=='messages') return;
  const demo=mode==='demo';
  const items=demo ? sample('acars').messages.map(message=>({...message,mode:'acars',frequency:131_550_000})) : savedMessages?.messages ?? [];
  const term=$('history-search').value.trim().toLowerCase();
  const matching=items.filter(item=>[item.title,item.tag,item.detail,item.mode].some(text=>text.toLowerCase().includes(term)));
  const status=demo ? 'Sample messages' : savedMessages?.warning ||
    (savedMessages ? `${items.length} saved · Keeps the latest ${savedMessages.limit ?? 500}` : 'Loading saved messages');
  $('history-status').textContent=status;
  const rendered=matching.map(item=>({
    ...item,rawLabel:item.tag,tag:[item.tag,item.mode==='vdl2'?'VDL2':'ACARS',formatMHz(item.frequency)+' MHz',item.time?.replace('T',' ')].filter(Boolean).join(' · '),
  }));
  rows(rendered,'message',term ? 'No matching messages.' : 'Decoded messages appear here as they are received.',
    $('history-results'),rendered.length);
}

async function refreshMessages() {
  if (loadingMessages || view!=='messages' || mode!=='live' || closed || document.hidden) return;
  loadingMessages=true;
  try {
    const headers=messageTag ? {'If-None-Match':messageTag} : {};
    const response=await fetch('/api/messages',{cache:'no-store',headers});
    if (response.status===304) return;
    if (!response.ok) throw Error('History unavailable.');
    savedMessages=await response.json();
    messageTag=response.headers.get('etag');
  } catch {
    messageTag=undefined;
    savedMessages={messages:savedMessages?.messages ?? [],warning:'Message history is unavailable.'};
  } finally {loadingMessages=false;}
  drawMessages();
}
$('history-search').addEventListener('input',drawMessages);
function radar(items, accessibleLabel = 'Relative positions of aircraft received by your antenna') {
  const NS = 'http://www.w3.org/2000/svg';
  const make = (tag, attrs, label) => {
    const node = document.createElementNS(NS, tag);
    for (const [key,value] of Object.entries(attrs)) node.setAttribute(key,value);
    if (label) node.textContent = label;
    return node;
  };
  const svg = make('svg', {viewBox:'0 0 620 370',role:'img','aria-label':accessibleLabel});
  const cx = 310, cy = 183, radius = 139;
  const aircraftScale=(Number.isFinite(aircraftAppearance.size)?aircraftAppearance.size:defaultAircraftAppearance.size)/28;
  const farthest = Math.max(0, ...items.map(item => Number.isFinite(item.distanceKm) ? item.distanceKm : 0));
  const limit = farthest > 200 ? Math.ceil(farthest / 100) * 100 : farthest > 100 ? 200 : farthest > 50 ? 100 : 50;
  const labels = {fontFamily:'Cascadia Mono,Consolas,monospace','font-size':'11',fill:'#9ba6b4'};
  for (const [x,y,text] of [[cx,23,'N'],[cx,349,'S'],[145,cy+4,'W'],[475,cy+4,'E']]) {
    svg.append(make('text', {...labels,x,y,'text-anchor':'middle'},text));
  }
  svg.append(make('path', {d:'M310 44V322M171 183H449',stroke:'#303b45','stroke-dasharray':'3 5'}));
  for (let i=1;i<=4;i++) {
    const r=radius*i/4;
    svg.append(make('circle',{cx,cy,r,fill:'none',stroke:'#34454a'}));
    svg.append(make('text',{...labels,x:cx+8,y:cy-r+12,fill:'#a4b0b5'},Math.round(limit*i/4)+' km'));
  }
  svg.append(make('circle',{cx,cy,r:5,fill:'#acdba1'}),make('circle',{cx,cy,r:10,fill:'none',stroke:'#acdba1'}));
  for (const [i,item] of items.entries()) {
    if (!Number.isFinite(item.distanceKm) || !Number.isFinite(item.bearing)) continue;
    const a = item.bearing * Math.PI / 180;
    const r = item.distanceKm / limit * radius;
    const x = cx + Math.sin(a) * r;
    const y = cy - Math.cos(a) * r;
    const group = make('g',{class:'radar-aircraft',transform:'translate('+x+' '+y+')'});
    group.append(make('title',{},item.title+' · '+distance(item.distanceKm)));
    group.append(make('path',{d:aircraftOutline,fill:'var(--aircraft-colour)',stroke:'var(--aircraft-outline)',
      'stroke-width':'1.5','paint-order':'stroke fill','vector-effect':'non-scaling-stroke',
      transform:'rotate('+(Number.isFinite(item.heading)?item.heading:0)+') scale('+aircraftScale+')'}));
    if (i < 9) {
      const right=x<420;
      group.append(make('text',{...labels,fill:'var(--aircraft-colour)',stroke:'var(--aircraft-outline)',
        'stroke-width':'.7','paint-order':'stroke fill',x:right?11:-11,y:-9,
        'text-anchor':right?'start':'end'},String(item.title).slice(0,13)));
    }
    svg.append(group);
  }
  $('radar').replaceChildren(svg);
}

const sampleTowerCentre = {latitude:0, longitude:0};
const sampleTowerAircraft = sample('adsb').aircraft.map((item,index) => {
  const direction=item.bearing*Math.PI/180;
  return {...item,hex:String(index),lat:sampleTowerCentre.latitude+item.distanceKm*Math.cos(direction)/111,
    lon:sampleTowerCentre.longitude+item.distanceKm*Math.sin(direction)/111};
});

function drawTowerTraffic(demo) {
  const centre=demo ? sampleTowerCentre : towerAircraft?.centre ?? localArea?.aircraftCentre;
  const items=demo ? sampleTowerAircraft : towerAircraft?.aircraft ?? [];
  const status=towerAircraft?.status;
  const map=towerDisplay==='map';
  $('tower-show-map').setAttribute('aria-pressed',String(map));
  $('tower-show-radar').setAttribute('aria-pressed',String(!map));
  $('stage-title').textContent=map ? 'Aircraft map' : 'Aircraft radar';
  $('stage-caption').textContent=demo ? 'Sample aircraft positions' : (localArea?.name || 'Local area');
  $('stage-tag').textContent=demo ? 'SAMPLE' : status==='live' ? 'LIVE NETWORK' : 'NETWORK';
  $('activity-title').textContent='Aircraft with positions';
  const updated=towerAircraft?.updated ? formattedTime(towerAircraft.updated) : '';
  const feedback=demo ? 'Sample positions' : !centre ? 'Set the Tower map centre in Setup.' :
    status==='rate-limited' ? 'Aircraft feed quota reached.' : status==='unavailable' ? 'Aircraft feed unavailable.' :
    updated ? `${items.length} aircraft · Updated ${updated}` : 'Loading aircraft positions';
  $('activity-caption').textContent=feedback;
  $('aircraft-display-settings').hidden=false;
  $('local-aircraft-layout').hidden=true;
  $('local-aircraft-credit').hidden=true;
  $('tower-aircraft-credit').hidden=demo;
  scope.hidden=true;
  $('radar').hidden=map || !centre;
  $('tower-map').hidden=!map || !centre;
  if (!map || !centre) $('tower-map-status').hidden=true;
  const empty=$('stage-empty');
  empty.hidden=Boolean(centre);
  empty.textContent=feedback;
  if (centre && map) void showTowerMap(centre,items);
  if (centre && !map) radar(items,'Relative aircraft positions around the Tower map centre');
  rows(items,'aircraft',status==='live' ? 'No recent aircraft positions in this area.' : feedback);
}

function drawLocalAircraft(next,demo) {
  const items=demo ? sampleTowerAircraft : next.aircraft ?? [];
  const firstPosition=items.find(item=>Number.isFinite(item.lat)&&Number.isFinite(item.lon));
  if(!localArea?.aircraftCentre&&!localAircraftFallbackCentre&&firstPosition) {
    localAircraftFallbackCentre={latitude:firstPosition.lat,longitude:firstPosition.lon};
  }
  const centre=demo ? sampleTowerCentre : localArea?.aircraftCentre ?? localAircraftFallbackCentre;
  const map=localAircraftDisplay==='map';
  $('local-show-map').setAttribute('aria-pressed',String(map));
  $('local-show-radar').setAttribute('aria-pressed',String(!map));
  $('local-aircraft-layout').hidden=false;
  $('aircraft-display-settings').hidden=false;
  $('stage-title').textContent=map?'Local aircraft map':'Aircraft around your receiver';
  $('stage-caption').textContent=map?'Positions decoded by your antenna':'Distance and direction from the antenna';
  $('stage-tag').textContent=demo?'SAMPLE':'LOCAL RF';
  $('tower-aircraft-credit').hidden=true;
  $('local-aircraft-credit').textContent=demo?'SAMPLE':'LOCAL RF';
  $('local-aircraft-credit').hidden=false;
  scope.hidden=true;
  $('radar').hidden=map;
  $('tower-map').hidden=!map||!centre;
  if(!map||!centre)$('tower-map-status').hidden=true;
  const empty=$('stage-empty');
  empty.hidden=!map||Boolean(centre);
  empty.textContent='Set the map centre in Setup or wait for a local aircraft position.';
  if(map&&centre)void showTowerMap(centre,items);
  if(!map)radar(items,'Relative positions decoded by your antenna');
}

function spectrum(data) {
  lastSpectrum = data;
  if (scope.hidden) return;
  const w = scope.clientWidth, h = scope.clientHeight;
  if (!w || !h) return;
  const scale = window.devicePixelRatio || 1;
  const pixelsWide = Math.round(w*scale);
  const pixelsHigh = Math.round(h*scale);
  if (scope.width !== pixelsWide) scope.width = pixelsWide;
  if (scope.height !== pixelsHigh) scope.height = pixelsHigh;
  const ctx = scope.getContext('2d');
  ctx.setTransform(scale,0,0,scale,0,0);
  ctx.clearRect(0,0,w,h);
  const values = (data?.power || []).map(value => Number.isFinite(value) ? value : null);
  const finite = values.filter(value => value !== null);
  if (finite.length < 2) return;
  const top = Math.ceil(Math.max(...finite)/10)*10 + 5;
  const bottom = Math.min(top-45, Math.floor(Math.min(...finite)/10)*10-3);
  const pad = spectrumPadding;
  const width = w-pad.left-pad.right, height = h-pad.top-pad.bottom;
  if (width < 20 || height < 20) return;
  const x = i => pad.left+width*i/(values.length-1);
  const y = n => pad.top+height*(top-n)/(top-bottom);
  ctx.font = '10px Cascadia Mono,Consolas,monospace';
  ctx.strokeStyle = '#29343e'; ctx.fillStyle = '#9ba6b4';
  for (let i=0;i<=4;i++) {
    const mark=top-(top-bottom)*i/4, line=y(mark);
    ctx.beginPath(); ctx.moveTo(pad.left,line); ctx.lineTo(w-pad.right,line); ctx.stroke();
    ctx.fillText(Math.round(mark)+' dB',6,line+4);
  }
  for (let i=0;i<=4;i++) {
    const px=pad.left+width*i/4;
    ctx.beginPath(); ctx.moveTo(px,pad.top); ctx.lineTo(px,h-pad.bottom); ctx.stroke();
    const f=(data.startFrequency+(data.stopFrequency-data.startFrequency)*i/4)/1e6;
    if (Number.isFinite(f)) {
      const label=f.toFixed(w<450?2:3);
      ctx.fillText(label,Math.min(w-ctx.measureText(label).width-4,px-ctx.measureText(label).width/2),h-9);
    }
  }
  const span = data.stopFrequency-data.startFrequency;
  const tuned = (state.frequency-data.startFrequency)/span;
  if (view==='receiver' && tuned>=0 && tuned<=1) {
    const marker = pad.left+width*tuned;
    if (Number.isFinite(state.bandwidth) && state.bandwidth>0) {
      const radius = width*state.bandwidth/(2*span);
      const left = Math.max(marker-radius,pad.left), right = Math.min(marker+radius,w-pad.right);
      ctx.fillStyle='#a9dea32b'; ctx.fillRect(left,pad.top,right-left,height);
    }
    ctx.strokeStyle='#deae74'; ctx.lineWidth=1;
    ctx.beginPath(); ctx.moveTo(marker,pad.top); ctx.lineTo(marker,h-pad.bottom); ctx.stroke();
  }
  ctx.lineWidth=1.8;ctx.strokeStyle='#b2dca7';ctx.beginPath();
  let drawing=false;
  for (const [i,val] of values.entries()) {
    if (val===null) {drawing=false;continue;}
    if (drawing) ctx.lineTo(x(i),y(val)); else ctx.moveTo(x(i),y(val));
    drawing=true;
  }
  ctx.stroke();
}
function render(next) {
  const previous = state;
  state = next;
  if(next.profile?.revision && next.profile.revision!==localArea?.revision)void loadLocalArea();
  if (!scanActionPending) updateScanState(next);
  const source = sourceById(next.source);
  const tunedMode = currentMode();
  const kind = source?.kind || (tunedMode === 'adsb' ? 'aircraft' : ['acars','vdl2'].includes(tunedMode) ? 'message' : tunedMode === 'spectrum' ? 'spectrum' : 'voice');
  const active = next.connected && next.running;
  const demo = mode === 'demo';
  if (cbIds.has(next.source)) lastCb = next.source;
  if (expectedCentre(previous) !== expectedCentre(next) || (previous.running && !next.running)) {
    streamOnline = false;
    clearWaterfall('Waiting for samples from the tuned frequency');
  }
  syncStreams();
  syncSignalMeter();
  document.body.dataset.state = demo?'demo':active?'live':'offline';
  $('live-label').textContent = demo?'SAMPLE DATA':active?'LIVE FROM YOUR ANTENNA':next.connected?'RECEIVER STOPPED':'RECEIVER OFFLINE';
  $('side-status').textContent = demo?'Sample data':active?'Receiver connected':next.connected?'Receiver stopped':'Receiver unavailable';
  $('title').textContent = view === 'signals'
    ? (source?.name || next.sourceName || 'Signals')
    : {receiver:'Receiver',tower:'Tower','uhf-cb':'Australian UHF CB',messages:'Messages',setup:'Local setup'}[view];
  $('section-name').textContent = viewTitles[view];
  $('subtitle').textContent = view === 'signals'
    ? 'Known signals'
    : view === 'uhf-cb'
      ? ''
      : (source?.name || next.sourceName || '');
  $('subtitle').hidden = !$('subtitle').textContent;
  $('frequency').textContent = Number.isFinite(next.frequency) ? formatMHz(next.frequency) : '—';
  $('scan-mux').hidden = !source?.scanWidth || demo;
  $('scan-mux').disabled = busy || Boolean(scanActionPending);
  syncAb();
  updateSelectedPresets();
  syncReceiverForm();
  syncLiveAudioSettings();
  cbStatus();
  renderRangeScan();
  syncLocalSetup();
  syncTowerControls();
  const positionedAircraft=kind==='aircraft'?(next.aircraft || []):[];
  const receivedAircraft=kind==='aircraft'?(next.aircraftReceived || positionedAircraft):[];
  const items = kind==='aircraft'?positionedAircraft:kind==='message'?(next.messages || []):(next.activity || []);
  const decoderTracks=kind==='aircraft' ? Math.max(positionedAircraft.length,receivedAircraft.length,
    Number.isFinite(next.adsb?.trackedAircraft)?next.adsb.trackedAircraft:0) : 0;
  const metrics = kind==='aircraft' ? [
    [active||demo?number(decoderTracks):'-','Decoder tracks'],
    [active||demo?number(positionedAircraft.length):'-','Aircraft with positions'],
    [power(next.channelPower),'Channel power']
  ] : kind==='message' ? [
    [active||demo?number(items.length):'—','Recent messages'],
    [items[0]?.tag || '—','Latest label'],
    [power(next.channelPower),'Channel power']
  ] : [
    [power(next.channelPower),'Channel power'],
    [Number.isFinite(next.gain)?(next.gain/10).toFixed(1)+' dB':'—','Receiver gain'],
    [next.squelch === true?'Open':next.squelch === false?'Closed':'—','Audio squelch']
  ];
  $('metrics').replaceChildren(...metrics.map(([v,l])=>measure(v,l)));
  $('updated').textContent=demo?'SAMPLE VIEW':next.updated?'UPDATED '+formattedTime(next.updated):'-';
  if(!busy) notice(next.notice);
  if (view==='tower') {
    drawTowerTraffic(demo);
    tuneTowerOnEntry();
    return;
  }
  const showLocalAircraft = kind==='aircraft' && view==='signals';
  const graph = view === 'receiver' && liveFrame ? spectrumFromFrame(liveFrame) : next.spectrum;
  if(!showLocalAircraft) {
    $('tower-map').hidden=true;
    $('tower-map-status').hidden=true;
    $('tower-aircraft-credit').hidden=true;
    $('local-aircraft-credit').hidden=true;
    $('local-aircraft-layout').hidden=true;
    $('aircraft-display-settings').hidden=true;
    $('stage-title').textContent='Radio spectrum';
    $('stage-caption').textContent=view==='receiver' ? 'Click the spectrum or waterfall to tune' : (source?.description || 'Signal power across the tuned band');
    $('stage-tag').textContent=demo?'SAMPLE':active?'LOCAL RF':'OFFLINE';
  }
  $('activity-title').textContent=kind==='aircraft'?'Aircraft received':kind==='message'?'Decoded messages':'Reception activity';
  $('activity-caption').textContent=kind==='aircraft'?'Positions broadcast by aircraft':kind==='message'?'Newest messages first':kind==='spectrum'?'Spectrum only':streamOptions.audio?'Audio from your receiver':'Audio plays through SDRangel';
  if (kind==='aircraft' && next.adsb) {
    const {channelSampleRate,correlationThreshold,trackedAircraft}=next.adsb;
    const tracked=Number.isFinite(trackedAircraft)?Math.max(trackedAircraft,receivedAircraft.length):decoderTracks;
    const awaiting=Math.max(0,tracked-positionedAircraft.length);
    const diagnostics=[
      `${tracked} decoded ${tracked===1?'track':'tracks'}`,
      awaiting>0 && `${awaiting} awaiting position frames`,
      tracked>0 && awaiting===0 && `${positionedAircraft.length} with positions`,
      Number.isFinite(channelSampleRate) && `${(channelSampleRate/1e6).toFixed(2)} MS/s delivered`,
      Number.isFinite(correlationThreshold) && `Correlation ${correlationThreshold}`,
    ].filter(Boolean);
    if (diagnostics.length) $('activity-caption').textContent=diagnostics.join(' · ');
  }
  if(showLocalAircraft) {
    drawLocalAircraft(next,demo);
  } else {
    scope.hidden=false;
    $('radar').hidden=true;
    const empty = $('stage-empty');
    empty.hidden=Boolean(graph?.power?.length);
    empty.textContent=active?'Waiting for a spectrum reading.': 'Waiting for the SDRangel receiver.';
    spectrum(graph);
  }
  if (view==='receiver' && active && !demo && !busy && !streamOnline && graph?.power?.length &&
      Number.isFinite(graph.startFrequency) && Number.isFinite(graph.stopFrequency) && next.updated !== lastSnapshotRow) {
    lastSnapshotRow = next.updated;
    const span = graph.stopFrequency-graph.startFrequency;
    drawWaterfall({centre:graph.startFrequency+span/2, span, power:graph.power});
    $('waterfall-frequency').textContent += ' · sampled live spectrum';
  }
  const emptyText=kind==='aircraft' && active
    ? decoderTracks>0
      ? 'Aircraft frames are decoding, but none has supplied a complete position yet.'
      : 'No aircraft frames decoded yet. Check the 1090 MHz antenna path and line of sight.'
    : undefined;
  rows(kind==='aircraft'?receivedAircraft:items,kind,emptyText);
}

new ResizeObserver(()=>spectrum(lastSpectrum)).observe(scope);
$('close-app').addEventListener('click',async()=>{
  if(busy||closed) return;
  busy=true; clockGeneration++;
  try {
    await request('/api/close',{method:'POST'});
    closed=true;
    mode='live';
    syncStreams();
    render({});
    $('title').textContent='Open Air is closed';
    notice('Open Air.exe will start the display again.');
    document.querySelectorAll('button').forEach(button=>{button.disabled=true;});
  } catch(error) { notice(error.message); }
  finally { busy=false; }
});
$('demo').addEventListener('click',()=>{
  if(busy) return;
  clockGeneration++;
  mode=mode==='demo'?'live':'demo';
  syncStreams();
  $('demo').textContent=mode==='demo'?'Back to live':'Sample view';
  if(mode==='demo') {
    const selected=state.source || (view==='uhf-cb' ? lastCb : 'adsb');
    notice('');
    render(sample(selected,sourceById(selected)));
    drawMessages();
  } else {
    receiverDirty = false;
    render({});
    void refresh();
    void refreshAircraft();
    drawMessages();
    void refreshMessages();
  }
});
function presentation(on) {
  document.body.classList.toggle('presenting',on);
  $('present').lastChild.textContent=on?' Exit presentation':' Present';
}
$('present').addEventListener('click',async()=>{
  if(document.body.classList.contains('presenting')){
    if(document.fullscreenElement) await document.exitFullscreen().catch(()=>{});
    presentation(false);
  } else {
    presentation(true);
    if(document.documentElement.requestFullscreen) await document.documentElement.requestFullscreen().catch(()=>{});
  }
});
document.addEventListener('fullscreenchange',()=>{if(!document.fullscreenElement) presentation(false);});
document.addEventListener('keydown',event=>{
  if(event.ctrlKey||event.metaKey||event.altKey||event.repeat||event.target.isContentEditable||['INPUT','TEXTAREA','SELECT'].includes(event.target.tagName)) return;
  if(event.key.toLowerCase()==='b' && !$('ab-switch').disabled){ event.preventDefault(); swapAb(); return; }
  if(event.target.tagName==='BUTTON')return;
  if(event.key==='Escape'&&document.body.classList.contains('presenting')) { presentation(false); return; }
  if(/^[1-8]$/.test(event.key)) { const source=sources[Number(event.key)-1]; if(source && presetVisible(source.id)) selectPreset(source.id); }
});
let refreshing=false;
let capabilitiesPending=false;
async function loadCapabilities() {
  if (capabilitiesPending) return;
  capabilitiesPending=true;
  try {
    streamOptions=await request('/api/capabilities');
    $('close-app').hidden=streamOptions.service;
    syncModeOptions();
    syncModeFields();
    syncStreams();
    syncLiveAudioSettings();
  } catch {} finally { capabilitiesPending=false; }
}

async function refresh() {
  if (closed || busy || mode !== 'live' || refreshing || document.hidden) return;
  refreshing=true;
  const generation = clockGeneration;
  try {
    const data=await request('/api/state');
    if(generation===clockGeneration && mode==='live') {
      if (data.connected && !state.connected) void loadCapabilities();
      render(data);
    }
  } catch(error) {
    if(generation===clockGeneration && mode==='live') render({notice:error.message});
  } finally { refreshing=false; }
}
document.addEventListener('visibilitychange', () => { syncStreams(); void refresh(); void refreshAircraft(); void refreshMessages(); });
showView(readRoute());
void loadCapabilities();
setInterval(refresh,2300);
setInterval(refreshScans,600);
setInterval(refreshAircraft,15000);
setInterval(refreshMessages,5000);
void refresh();
