export const sources = [
  {id:'adsb', name:'ADS-B aircraft', label:'1090.000', group:'Aviation data', kind:'aircraft', description:'Aircraft positions received directly from your antenna.', centre:1090100000, offset:-100000, gain:184, decoder:'ADSBDemod', settings:{rfBandwidth:2000000,correlationThreshold:5}},
  {id:'acars', name:'ACARS messages', label:'131.550', group:'Aviation data', kind:'message', description:'Text and data sent between aircraft and ground stations.', centre:131650000, offset:-96000, gain:184, decoder:'ACARSDemod', settings:{mode:0,rfBandwidth:12500,hideNoInfo:0,displayChart:1}},
  {id:'vdl2', name:'VDL Mode 2', label:'136.975', group:'Aviation data', kind:'message', description:'Digital aircraft and ground-station traffic.', centre:136875000, offset:100000, gain:184, decoder:'ACARSDemod', settings:{mode:1,rfBandwidth:25000,hideNoInfo:0,displayChart:1}},
  {id:'director', name:'Sydney Director West', label:'126.100', group:'Sydney airband', kind:'voice', description:'Controllers sequencing aircraft for arrival into Sydney.', centre:126000000, offset:100000, gain:184, decoder:'AMDemod', settings:{rfBandwidth:10000,squelch:-64,volume:1}},
  {id:'tower', name:'Sydney Tower West', label:'120.500', group:'Sydney airband', kind:'voice', description:'Takeoff and landing clearances from Sydney Tower.', centre:120400000, offset:100000, gain:184, decoder:'AMDemod', settings:{rfBandwidth:10000,squelch:-64,volume:1}},
  {id:'cb40', name:'UHF CB 40', label:'477.400', group:'Australian UHF CB', channel:40, kind:'voice', description:'Road and highway radio on CB channel 40.', centre:477500000, offset:-100000, gain:184, decoder:'NFMDemod', settings:{rfBandwidth:12500,afBandwidth:3000,squelch:-62,volume:1}},
  {id:'dural', name:'Dural repeater', label:'438.525', group:'Sydney amateur radio', kind:'voice', description:'Local amateur radio through the Dural repeater.', centre:438625000, offset:-100000, gain:184, decoder:'NFMDemod', settings:{rfBandwidth:12500,afBandwidth:3000,squelch:-62,volume:1}},
  {id:'sbs', name:'SBS Radio', label:'97.700', group:'Sydney FM', kind:'radio', description:'Broadcast FM, stereo and station data.', centre:97800000, offset:-100000, gain:63, decoder:'BFMDemod', settings:{rfBandwidth:180000,afBandwidth:15000,deEmphasis:0,audioStereo:1,rdsActive:1,squelch:-60,volume:1}}
];

const audioModes = {
  am: {kind:'voice', gain:184, decoder:'AMDemod', settings:sources[4].settings},
  nfm: {kind:'voice', gain:184, decoder:'NFMDemod', settings:sources[5].settings},
  bfm: {kind:'radio', gain:63, decoder:'BFMDemod', settings:sources[7].settings}
};

const tuningModes = {
  spectrum: { label: 'Spectrum only', kind: 'spectrum', decoder: null, gain: 184, settings: {}, offset: 0 },
  am: {
    label: 'AM', ...audioModes.am,
    bandwidth: { min: 1000, max: 40000, default: audioModes.am.settings.rfBandwidth },
    squelch: { min: -100, max: 0, default: audioModes.am.settings.squelch },
  },
  nfm: {
    label: 'Narrow FM', ...audioModes.nfm,
    bandwidth: { min: 1000, max: 40000, default: audioModes.nfm.settings.rfBandwidth },
    squelch: { min: -100, max: 0, default: audioModes.nfm.settings.squelch },
  },
  bfm: {
    label: 'Broadcast FM', ...audioModes.bfm,
    bandwidth: {
      min: 80000, max: 250000, default: audioModes.bfm.settings.rfBandwidth,
      choices: [80000,100000,120000,140000,160000,180000,200000,220000,250000],
    },
    squelch: { min: -100, max: 0, default: audioModes.bfm.settings.squelch },
  },
  acars: { label: 'ACARS', kind: sources[1].kind, decoder: sources[1].decoder, gain: sources[1].gain, settings: sources[1].settings },
  vdl2: { label: 'VDL Mode 2', kind: sources[2].kind, decoder: sources[2].decoder, gain: sources[2].gain, settings: sources[2].settings },
  adsb: { label: 'ADS-B', kind: sources[0].kind, decoder: sources[0].decoder, gain: sources[0].gain, settings: sources[0].settings, offset: sources[0].offset },
};

export const receiverModes = Object.entries(tuningModes).map(([id, { label, decoder, bandwidth, squelch }]) => ({
  id, label, decoder,
  ...(bandwidth && { bandwidth }),
  ...(squelch && { squelch }),
}));

export function formatMHz(hz) {
  return (hz / 1000000).toFixed(6).replace(/0{1,3}$/, '');
}

function audioChannel(id, name, frequency, mode, group) {
  return {
    id, name, label:formatMHz(frequency), group, ...audioModes[mode],
    centre:frequency+100000, offset:-100000
  };
}

function spectrumChannel(id, name, frequency, group, description) {
  const { kind, decoder, gain, settings, offset } = tuningModes.spectrum;
  return {
    id, name, description, label: formatMHz(frequency), group, kind, mode: 'spectrum',
    decoder, gain, settings, centre: frequency, offset,
  };
}

const sydneyAirband = [
  [118550000,'Sydney ATIS'], [121700000,'Sydney Ground East'],
  [123000000,'Sydney Departures North'], [124400000,'Sydney Approach North'],
  [124550000,'Sydney Centre'], [124700000,'Sydney Tower East'],
  [125300000,'Sydney Director East'], [126500000,'Sydney Ground West'],
  [128300000,'Sydney Approach South'], [129700000,'Sydney Departures South'],
  [133800000,'Sydney Delivery']
];

// Frequencies published by Airservices Australia in ERSA and AIP Supplement H35/26.
const nearbyAirband = [
  [119900000, 'Bankstown Ground'], [120900000, 'Bankstown ATIS'],
  [123600000, 'Bankstown Tower'], [125800000, 'Sydney Centre (Bankstown)'],
  [132800000, 'Bankstown Tower / CTAF'],
  [120100000, 'Camden Tower / CTAF'], [121900000, 'Camden Ground'],
  [125100000, 'Camden ATIS / AWIS'],
  [118400000, 'Walton Departures'], [118650000, 'Walton Delivery'],
  [119350000, 'Walton Approach'], [124050000, 'Walton Ground'],
  [127000000, 'Walton ATIS'], [128100000, 'Walton Tower'],
];

// Port Authority of NSW and ACMA maritime channel allocations.
const marineVhf = [
  [12, 156600000, 'Port Botany VTS'],
  [13, 156650000, 'Sydney Harbour VTS'],
  [16, 156800000, 'Distress, safety and calling'],
  [67, 156375000, 'Weather and navigation warnings'],
  [72, 156625000, 'Vessel working'], [73, 156675000, 'Vessel working'], [77, 156875000, 'Vessel working'],
];

// Sydney FM transmitters listed in the ACMA broadcast station book.
const sydneyFm = [
  ['abc-classic', 92900000, 'ABC Classic Sydney'], ['fbi', 94500000, 'FBi Radio'],
  ['nova', 96900000, 'Nova 96.9'], ['gold', 101700000, 'Gold 101.7'],
  ['fine-music', 102500000, '2MBS Fine Music Sydney'], ['hope', 103200000, 'Hope 103.2'],
  ['2day', 104100000, '2DayFM'], ['triple-m', 104900000, 'Triple M Sydney'],
  ['triple-j', 105700000, 'triple j Sydney'], ['kiis', 106500000, 'KIIS 106.5'],
  ['2ser', 107300000, '2SER'],
];

// ACMA's Sydney digital radio transmitter list and VHF maritime channel allocations.
const spectrumPresets = [
  ['ais1', 'AIS 1', 161975000, 'Marine VHF', 'Vessel tracking signal · Spectrum only'],
  ['ais2', 'AIS 2', 162025000, 'Marine VHF', 'Vessel tracking signal · Spectrum only'],
  ['dab-9a', 'Sydney DAB+ 9A', 202928000, 'Digital radio', 'Broadcast multiplex · Spectrum only'],
  ['dab-9b', 'Sydney DAB+ 9B', 204640000, 'Digital radio', 'Broadcast multiplex · Spectrum only'],
  ['dab-9c', 'Sydney DAB+ 9C', 206352000, 'Digital radio', 'Broadcast multiplex · Spectrum only'],
];

// ACMA TV by Area Served (July 2026) and TX Australia Sydney site specifications.
const sydneyDvb = [
  [6, 177500000, 'Seven'], [7, 184500000, 'SBS'], [8, 191625000, 'Nine'],
  [11, 219500000, '10'], [12, 226500000, 'ABC'],
  [28, 529500000, 'Seven'], [30, 543500000, 'ABC'], [31, 550500000, '10'],
  [32, 557500000, 'SBS'], [33, 564500000, 'Nine'],
];

function dvbChannel([channel, frequency, network]) {
  const site = channel < 13 ? 'Sydney main VHF transmitters' : 'Kurrajong, North Head and Kings Cross UHF relays';
  return {
    ...spectrumChannel(
      'dvb-t-'+channel, network+' DVB-T (RF '+channel+')', frequency, 'Sydney DVB-T',
      site+'. Survey this 7 MHz multiplex across multiple spectrum slices.',
    ),
    scanWidth: 7000000,
  };
}

const cb = Array.from({length:80}, (_, index) => {
  const channel = Math.floor(index/2)+(index%2 ? 41 : 1);
  return {channel, frequency:476425000+index*12500};
}).filter(({channel})=>channel!==40&&(channel<61||channel>63))
  .sort((a,b)=>a.channel-b.channel);

function cbDescription(channel) {
  if (channel === 5 || channel === 35) return 'Emergency channel';
  if (channel === 22 || channel === 23) return 'Telemetry and telecommand';
  if (channel <= 8 || (channel >= 41 && channel <= 48)) return 'Repeater output';
  if ((channel >= 31 && channel <= 38) || (channel >= 71 && channel <= 78)) return 'Repeater input';
  return 'Shared UHF CB channel';
}

export const catalogue = [
  ...sydneyAirband.map(([frequency,name])=>audioChannel('air-'+frequency,name,frequency,'am','Sydney airband')),
  ...nearbyAirband.map(([frequency, name]) => audioChannel('air-'+frequency,name,frequency,'am','Sydney airband')),
  ...marineVhf.map(([channel, frequency, name]) => ({
    ...audioChannel('marine-'+channel,'Marine '+channel+' · '+name,frequency,'nfm','Marine VHF'),
    settings: { ...audioModes.nfm.settings, rfBandwidth: 16000 },
  })),
  ...cb.map(({channel,frequency}) => ({
    ...audioChannel('cb'+channel,'UHF CB '+channel,frequency,'nfm','Australian UHF CB'),
    channel, description: cbDescription(channel),
  })),
  ...sydneyFm.map(([id, frequency, name]) => audioChannel(id,name,frequency,'bfm','Sydney FM')),
  audioChannel('dural-6m','Dural VK2RWI · 6 m FM',53850000,'nfm','Sydney amateur radio'),
  audioChannel('dural-2m','Dural VK2RWI · 2 m FM',147000000,'nfm','Sydney amateur radio'),
  audioChannel('dural-23cm','Dural VK2RWI · 23 cm FM',1273500000,'nfm','Sydney amateur radio'),
  ...spectrumPresets.map(args => spectrumChannel(...args)),
  ...sydneyDvb.map(dvbChannel),
];

export const availableSources = [...sources,...catalogue];

export function isSydneyPreset(source) {
  return source.group.startsWith('Sydney ') || source.name.startsWith('Sydney DAB+') ||
    source.id === 'marine-12' || source.id === 'marine-13';
}

export function isAirbandVoice(source) {
  const frequency=source.centre+source.offset;
  return source.decoder==='AMDemod' && frequency>=118_000_000 && frequency<137_000_000;
}

export function isAirbandScanChannel(source) {
  return isAirbandVoice(source) && !/\b(?:ATIS|AWIS)\b/i.test(source.name);
}

function validOptionalSetting(value, limits) {
  return value == null || (limits && Number.isInteger(value) && value >= limits.min && value <= limits.max);
}

export function customSource(input) {
  if (!input || typeof input.mode !== 'string' || !Object.hasOwn(tuningModes,input.mode) || !Number.isInteger(input.frequency) ||
      input.frequency < 1000000 || input.frequency > 2000000000 ||
      (input.name != null && (typeof input.name !== 'string' || input.name.length > 60))) return null;
  const { mode, frequency, bandwidth, squelch } = input;
  const { kind, decoder, gain, settings, offset = -100000, bandwidth: bandwidthLimits, squelch: squelchLimits } = tuningModes[mode];
  if (!validOptionalSetting(bandwidth, bandwidthLimits) || !validOptionalSetting(squelch, squelchLimits)) return null;
  const label = formatMHz(frequency);
  const baseId = 'custom-'+mode+'-'+frequency;
  const bandwidthSuffix = bandwidth == null || bandwidth === bandwidthLimits.default ? '' : '-bw-'+bandwidth;
  const squelchSuffix = squelch == null || squelch === squelchLimits.default ? '' : '-sq-'+squelch;
  const overrides = {};
  if (bandwidth != null) overrides.rfBandwidth = bandwidth;
  if (squelch != null) overrides.squelch = squelch;
  return {
    id: baseId+bandwidthSuffix+squelchSuffix, name: input.name?.trim() || label+' MHz', label,
    group: 'My channels', mode, kind, gain, decoder, centre: frequency-offset, offset,
    settings: { ...settings, ...overrides },
  };
}

export function localSource(input) {
  const source = customSource(input);
  return source && {...source,id:`local-${input.mode}-${input.frequency}`,group:'Local presets'};
}

export function sample(id, source = availableSources.find(item=>item.id===id)||sources[0]) {
  const updated=new Date().toISOString();
  const power=Array.from({length:144},(_,i)=>-76+Math.sin(i*4.1)*1.8+31*Math.exp(-Math.pow((i-74)/6,2))+13*Math.exp(-Math.pow((i-107)/3,2)));
  return {
    source:source.id, connected:false, running:false, frequency:source.centre+source.offset, updated,
    channelPower:-45.7, gain:source.gain, squelch:true,
    aircraft:[
      {title:'QFA738',tag:'6,900 ft',detail:'Boeing 737 · 33 km',distanceKm:33,bearing:167,heading:136},
      {title:'QLK884',tag:'22,000 ft',detail:'Dash 8 · 41 km',distanceKm:41,bearing:30,heading:11},
      {title:'CFH3',tag:'775 ft',detail:'H145 · 12 km',distanceKm:12,bearing:106,heading:54}
    ],
    messages:[
      {title:'Example aircraft 01',tag:'H1',detail:'Illustrative aircraft status message.'},
      {title:'Example aircraft 02',tag:'Q0',detail:'Illustrative link acknowledgement.'}
    ],
    activity:[{title:'Sample carrier',tag:'OPEN',detail:'Illustrative audio and spectrum activity.'}],
    spectrum:{power,startFrequency:source.centre-600000,stopFrequency:source.centre+600000}
  };
}
