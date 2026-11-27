const formatTime = new Intl.DateTimeFormat('en-AU',{weekday:'short',hour:'2-digit',minute:'2-digit',timeZoneName:'short'});
const mhz = frequency => (frequency / 1e6).toFixed(4).replace(/0$/,'') + ' MHz';
const direction = az => ['N','NE','E','SE','S','SW','W','NW'][Math.round(az / 45) % 8];
const signed = number => (number < 0 ? '−' : '+') + Math.abs(number);
function skyPoint(point) {
  const angle = point.az * Math.PI / 180;
  const radius = 110 * (1 - Math.min(90,point.el) / 90);
  return [140 + radius * Math.sin(angle),140 - radius * Math.cos(angle)];
}

export function mountSkywatcher({request, onTune}) {
  const $ = id => document.getElementById('sky-'+id);
  const satellite = $('satellite'), frequency = $('frequency'), rate = $('symbol-rate');
  let active = false, live = true, orbitLoading = false, statusLoading = false, action = '';
  let statusUnavailable = false;
  let orbit, report, selectedPass, orbitTimer, statusTimer, selectedKey, notice = '', orbitFailed = false;
  let lastGalleryId, passRowsKey = '';
  let schedule, scheduleTimer, scheduleLoading=false, scheduleAction=false, scheduleNotice='';
  let scheduleRevision=0;
  let settingsKey='', jobRowsKey='';

  function satellites() { return orbit?.satellites ?? []; }
  function target() { return satellites().find(item => item.id === Number(satellite.value)); }
  function populate(select, values, initial) {
    const key = JSON.stringify(values);
    if (select.dataset.options === key) return;
    select.dataset.options = key;
    const previous = select.value;
    select.replaceChildren(...values.map(([value,label]) => new Option(label,value)));
    select.value = values.some(([value]) => String(value) === previous) ? previous : String(initial ?? '');
  }
  function passKey(id, pass) { return id + ':' + pass.rise; }
  function drawPlot(pass) {
    const item = target();
    const look = item?.look;
    $('path').setAttribute('points',(pass?.path ?? []).map(point=>skyPoint(point).join(',')).join(' '));
    const visible = look?.el >= 0 && (!pass || pass.rise <= Date.now() && pass.set > Date.now());
    const [x,y] = visible ? skyPoint(look) : [-10,-10];
    $('position').setAttribute('cx',x);
    $('position').setAttribute('cy',y);
    $('pointing').textContent = visible
      ? `Point ${direction(look.az)} ${look.az}° · Elevation ${look.el}° · Doppler ${signed(look.dopplerHz)} Hz`
      : pass?.path?.length ? `${direction(pass.path[0].az)} → ${direction(pass.path.at(-1).az)} · Peak ${pass.maxElevation}°`
      : 'Choose a pass to see its path across the sky.';
    $('transmitters').hidden = !item?.reference;
    if(item?.reference) $('transmitters').href = item.reference;
  }
  function drawPasses() {
    if(!orbit)return;
    const now = Date.now();
    const rows = satellites().flatMap(item => item.passes
      .filter(pass=>pass.set>now).map(pass=>({item,pass,key:passKey(item.id,pass)})))
      .sort((a,b)=>a.pass.rise-b.pass.rise).slice(0,14);
    const selected = rows.find(row=>row.key===selectedKey) || rows.find(row=>row.item.id===Number(satellite.value));
    selectedPass = selected?.pass;
    selectedKey = selected?.key;
    const key = JSON.stringify(rows.map(({key,pass})=>[key,pass.rise<=now,pass.maxElevation]));
    if(key !== passRowsKey) {
      passRowsKey = key;
      $('passes').replaceChildren(...rows.map(({item,pass,key})=>{
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'sky-pass';
        button.dataset.pass = key;
        const name = document.createElement('strong');
        name.textContent = item.name;
        const elevation = document.createElement('span');
        elevation.className = 'sky-elevation';
        elevation.textContent = pass.maxElevation + '°';
        const timing = document.createElement('span');
        timing.textContent = (pass.rise <= now ? 'Above horizon · ends ' + formatTime.format(pass.set) : formatTime.format(pass.rise))
          + ' · ' + Math.round((pass.set-pass.rise)/60000) + ' min';
        button.append(name,elevation,timing);
        button.addEventListener('click',()=>{
          if (satellite.value !== String(item.id)) {
            satellite.value = item.id;
            frequency.value = item.defaultFrequency;
          }
          selectedKey = key;
          drawPasses();
        });
        return button;
      }));
    }
    for(const button of $('passes').children)button.setAttribute('aria-pressed',String(button.dataset.pass===selectedKey));
    const missing = satellites().filter(item=>item.orbit==='unavailable').length;
    $('orbit-status').textContent = !orbit.centre ? 'Set your Tower map centre in Setup to calculate passes.'
      : orbitFailed || missing===satellites().length ? 'Orbital data is temporarily unavailable. You can still tune a downlink.'
      : !rows.length ? 'No passes reach 10° elevation in the next 36 hours.'
      : missing || satellites().some(item=>item.orbit==='cached') ? 'Using available orbital data. Some updates are delayed.'
      : 'Next 36 hours · minimum peak 10°';
    $('observer').textContent = orbit.centre
      ? `${orbit.observer || 'Saved site'} · horizon at the edge, overhead at the centre`
      : 'Observer location uses your Tower map centre.';
    drawPlot(selectedPass);
    drawScheduleControls();
  }

  function drawScheduleControls(){
    const queued=schedule?.jobs?.some(job=>['queued','starting','recording'].includes(job.phase)&&
      job.satellite===Number(satellite.value)&&Math.abs(job.rise-selectedPass?.rise)<180_000);
    $('queue-pass').hidden=schedule?.available===false;
    $('queue-pass').disabled=!live||!schedule?.available||!selectedPass||
      selectedPass.peak<=Date.now()||queued||scheduleAction||Boolean(action);
    $('queue-pass').textContent=queued?'Pass scheduled':'Schedule pass';
    for(const button of $('schedule').querySelectorAll('button'))button.disabled=!live||scheduleAction;
  }

  function namedSatellite(id){
    return schedule?.satellites?.find(item=>item.id===id)?.name ?? satellites().find(item=>item.id===id)?.name ?? 'Meteor';
  }

  function buildAutoSettings(settings){
    $('auto-enabled').checked=settings.enabled;
    $('auto-elevation').value=settings.minElevation;
    const groups=settings.targets.map(target=>{
      const field=document.createElement('fieldset');
      field.className='sky-auto-target';
      field.dataset.satellite=target.satellite;
      const legend=document.createElement('legend');
      legend.textContent=namedSatellite(target.satellite);
      const enabled=document.createElement('label');
      const toggle=document.createElement('input');
      toggle.type='checkbox';
      toggle.name='enabled';
      toggle.checked=target.enabled;
      enabled.append(toggle,' Include');
      const downlink=document.createElement('label');
      downlink.className='tuner-field';
      const channels=document.createElement('select');
      channels.name='frequency';
      populate(channels,schedule.frequencies.map(value=>[value,mhz(value)]),target.frequency);
      downlink.append('Downlink',channels);
      const symbols=document.createElement('label');
      symbols.className='tuner-field';
      const rates=document.createElement('select');
      rates.name='symbolRate';
      populate(rates,[[72000,'72 ksym/s'],[80000,'80 ksym/s']],target.symbolRate);
      symbols.append('LRPT symbol rate',rates);
      field.append(legend,enabled,downlink,symbols);
      return field;
    });
    $('auto-targets').replaceChildren(...groups);
  }

  function drawSchedule(){
    $('schedule').hidden=!schedule?.available;
    if(!schedule?.available){drawScheduleControls();return;}
    const {settings,jobs,upcoming,note}=schedule;
    const key=JSON.stringify(settings);
    if(settingsKey!==key){settingsKey=key;buildAutoSettings(settings);}
    const next=upcoming[0];
    const status=settings.enabled
      ? next ? `Auto-capture on · Next ${namedSatellite(next.satellite)} · ${formatTime.format(next.rise)} · ${next.maxElevation}°`
        : 'Auto-capture on · Waiting for a qualifying pass'
      : 'Auto-capture off · Schedule individual passes from the list above';
    $('schedule-status').textContent=[scheduleNotice,status,note].filter(Boolean).join(' · ');
    const queued=jobs.filter(job=>['queued','starting','recording'].includes(job.phase)).sort((a,b)=>a.rise-b.rise);
    const history=jobs.filter(job=>!queued.includes(job)).slice(0,6);
    const rows=[...queued,...history];
    const rowsKey=JSON.stringify(rows);
    if(rowsKey!==jobRowsKey){
      jobRowsKey=rowsKey;
      $('jobs').replaceChildren(...rows.map(job=>{
        const row=document.createElement('li');
        const info=document.createElement('div');
        const title=document.createElement('strong');
        title.textContent=namedSatellite(job.satellite)+' · '+formatTime.format(job.rise);
        const detail=document.createElement('span');
        const phase=job.phase==='recording'?'Capture in progress':job.phase[0].toUpperCase()+job.phase.slice(1);
        detail.textContent=[phase,job.automatic?'Automatic':null,mhz(job.frequency),job.message].filter(Boolean).join(' · ');
        info.append(title,detail);
        row.append(info);
        if(job.phase==='queued'){
          const cancel=document.createElement('button');
          cancel.type='button';
          cancel.className='control';
          cancel.textContent='Cancel';
          cancel.setAttribute('aria-label','Cancel '+title.textContent);
          cancel.addEventListener('click',()=>void updateSchedule({action:'cancel',id:job.id}));
          row.append(cancel);
        }
        return row;
      }));
    }
    drawScheduleControls();
  }

  async function refreshSchedule(){
    if(!active||scheduleLoading||scheduleAction)return;
    scheduleLoading=true;
    const revision=scheduleRevision;
    try{
      const updated=await request('/api/skywatcher/schedule',{signal:AbortSignal.timeout(15_000)});
      if(revision===scheduleRevision)schedule=updated;
    }catch{
      if(!schedule)schedule={available:false};
    }finally{scheduleLoading=false;}
    drawSchedule();
  }

  async function updateSchedule(body){
    if(scheduleAction||!live)return;
    scheduleRevision++;
    scheduleAction=true;
    scheduleNotice='Saving schedule…';
    drawSchedule();
    try{
      schedule=await request('/api/skywatcher/schedule',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify(body),signal:AbortSignal.timeout(20_000)});
      scheduleNotice=body.action==='queue'?'Pass scheduled. You can close this page.':
        body.action==='cancel'?'Scheduled pass cancelled.':'Automatic capture settings saved.';
    }catch(error){scheduleNotice=error.message;}
    finally{scheduleAction=false;drawSchedule();}
  }

  function drawControls() {
    drawScheduleControls();
    const capture = report?.capture;
    const recording = capture?.phase==='recording';
    const usingRadio = ['starting','recording','stopping'].includes(capture?.phase);
    const working = usingRadio || capture?.phase==='decoding';
    for(const field of [satellite,frequency,rate]) field.disabled = Boolean(action || usingRadio);
    $('tune').disabled = !live || action || usingRadio || !target();
    $('capture').disabled = !live || action || working || !target() || statusUnavailable || !report?.decoderReady;
    $('stop').hidden = !recording;
    $('stop').disabled = Boolean(action);
    for(const name of ['tune','capture','stop']) $(name).dataset.pending = String(action === name);
    const decoderMissing = report?.decoderReady === false;
    $('capture').textContent = action === 'capture' ? 'Starting capture…'
      : decoderMissing ? 'SatDump required' : statusUnavailable ? 'Receiver unavailable'
      : !report ? 'Checking decoder…' : 'Capture pass';
    $('decoder').hidden = !decoderMissing && !statusUnavailable;
    $('decoder').textContent = decoderMissing ? 'Install SatDump on the receiver host to enable capture and image decoding.'
      : 'Could not check the receiver. Skywatcher will retry.';
    const phases = {
      starting:'Preparing the IQ recorder…',
      recording:capture ? `Recording ${capture.satellite} at ${mhz(capture.frequency)} · ends ${capture.ends ? formatTime.format(capture.ends) : 'when stopped'}` : '',
      stopping:'Closing the recording…',
      decoding:'SatDump is decoding the captured IQ…',
      complete:'Decoded weather images are ready below.',
      failed:'Image capture did not complete.',
    };
    $('status').textContent = notice || capture?.message || phases[capture?.phase] ||
      (action ? 'Waiting for the receiver…' : 'Meteor downlinks can change. Check recent observations if the band is quiet.');
  }

  async function refreshOrbits() {
    if(!active || orbitLoading)return;
    orbitLoading = true;
    try {
      orbit = await request('/api/skywatcher/orbits');
      orbitFailed = false;
      populate(satellite,satellites().map(item=>[item.id,item.name]),satellites()[0]?.id);
      populate(frequency,(orbit.frequencies ?? []).map(value=>[value,mhz(value)]),target()?.defaultFrequency);
    } catch {
      orbitFailed = true;
      $('orbit-status').textContent = 'Unable to load the Skywatcher service.';
    } finally { orbitLoading = false; }
    drawPasses();
    drawControls();
  }
  async function refreshGallery() {
    try {
      const captures = await request('/api/skywatcher/gallery');
      const pictures = captures.flatMap(capture=>capture.images.map(image=>({capture,image})));
      $('gallery-status').textContent = pictures.length
        ? `${captures.length} decoded ${captures.length===1 ? 'capture' : 'captures'}` : 'Capture a Meteor pass to see images here.';
      $('images').replaceChildren(...pictures.map(({capture,image})=>{
        const link = document.createElement('a');
        link.className = 'sky-image';
        link.href = image.url;
        link.target = '_blank';
        link.rel = 'noopener';
        const preview = document.createElement('img');
        preview.src = image.url;
        preview.alt = capture.satellite + ' · ' + image.name;
        preview.loading = 'lazy';
        const label = document.createElement('span');
        label.textContent = `${capture.satellite} · ${formatTime.format(capture.started)} · ${image.name}`;
        link.append(preview,label);
        return link;
      }));
    } catch { $('gallery-status').textContent = 'Saved weather images are temporarily unavailable.'; }
  }
  async function refreshStatus() {
    if(!active || statusLoading || action)return;
    statusLoading = true;
    try {
      report = await request('/api/skywatcher/status',{signal:AbortSignal.timeout(15_000)});
      statusUnavailable = false;
      if(report.capture?.phase==='complete' && lastGalleryId!==report.capture.id){
        lastGalleryId = report.capture.id;
        void refreshGallery();
      }
    } catch { report = undefined; statusUnavailable = true; }
    finally { statusLoading = false; }
    drawControls();
  }
  async function control(name) {
    if(action)return;
    action = name;
    notice = '';
    drawControls();
    try {
      const ends = selectedPass?.rise <= Date.now() + 60_000 ? selectedPass.set + 15_000 : undefined;
      const body = name==='stop' ? {} : {satellite:Number(satellite.value),frequency:Number(frequency.value),
        symbolRate:Number(rate.value),ends};
      const result=await request('/api/skywatcher/'+name,{method:'POST',
        headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(75_000)});
      if(result.capture)report = {...report,capture:result.capture};
      if(result.state){
        onTune(result.state);
        notice = 'Tuned to '+mhz(result.state.frequency)+'.';
      }
    } catch(error) {
      if (error.name === 'TimeoutError') {
        statusUnavailable = true;
        notice = 'The receiver did not respond in time. Checking its status.';
      } else notice = error.message;
    } finally { action = ''; drawControls(); void refreshStatus(); }
  }

  satellite.addEventListener('change',()=>{
    if (target()) frequency.value = target().defaultFrequency;
    selectedKey = undefined;
    notice = '';
    drawPasses();
    drawControls();
  });
  frequency.addEventListener('change',()=>{notice='';drawControls();});
  for(const name of ['tune','capture','stop'])$(name).addEventListener('click',()=>void control(name));
  $('queue-pass').addEventListener('click',()=>{
    if(!selectedPass)return;
    void updateSchedule({action:'queue',rise:selectedPass.rise,satellite:Number(satellite.value),
      frequency:Number(frequency.value),symbolRate:Number(rate.value)});
  });
  $('auto-form').addEventListener('submit',event=>{
    event.preventDefault();
    const targets=[...$('auto-targets').children].map(field=>({
      satellite:Number(field.dataset.satellite),enabled:field.querySelector('[name=enabled]').checked,
      frequency:Number(field.querySelector('[name=frequency]').value),
      symbolRate:Number(field.querySelector('[name=symbolRate]').value),
    }));
    void updateSchedule({action:'settings',settings:{enabled:$('auto-enabled').checked,
      minElevation:Number($('auto-elevation').value),targets}});
  });
  return {
    show(visible, receiverLive) {
      live = receiverLive;
      if(active===visible){if(active)drawControls();return;}
      active=visible;
      document.getElementById('skywatcher').hidden = !active;
      clearInterval(orbitTimer);
      clearInterval(statusTimer);
      clearInterval(scheduleTimer);
      if(!active)return;
      drawControls();
      void refreshOrbits();
      void refreshStatus();
      void refreshGallery();
      void refreshSchedule();
      orbitTimer = setInterval(refreshOrbits,10000);
      statusTimer = setInterval(refreshStatus,2000);
      scheduleTimer = setInterval(refreshSchedule,5000);
    },
  };
}
