import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {writeStateFile} from './state-file.mjs';
import {validateWeatherTarget} from './skywatcher-capture.mjs';
import {lrptFrequencies,weatherSatellites} from './skywatcher-orbits.mjs';

const lead = 20_000;
const tail = 15_000;
const matchWindow = 180_000;
const activePhases = new Set(['queued','starting','recording']);
const defaults = {
  enabled:false,
  minElevation:30,
  targets:weatherSatellites.map(({id,defaultFrequency})=>({
    satellite:id,frequency:defaultFrequency,symbolRate:72000,enabled:true,
  })),
};

const samePass = (a,b)=>a.satellite===b.satellite&&Math.abs(a.rise-b.rise)<matchWindow;
const overlaps = (a,b)=>a.rise-lead<b.set+tail&&b.rise-lead<a.set+tail;
const cutoff = job=>Math.min(job.peak,job.set-45_000);
const sameTarget = (a,b)=>a.satellite===b.satellite&&a.frequency===b.frequency&&a.symbolRate===b.symbolRate;

function validateSettings(input) {
  if(typeof input?.enabled!=='boolean'||!Number.isInteger(input.minElevation)||
      input.minElevation<10||input.minElevation>90||!Array.isArray(input.targets)||
      input.targets.length!==weatherSatellites.length)throw Error('Choose an elevation from 10 to 90 degrees and configure both satellites.');
  const targets=weatherSatellites.map(({id})=>{
    const match=input.targets.filter(item=>item?.satellite===id);
    if(match.length!==1||typeof match[0].enabled!=='boolean')throw Error('Choose a capture profile for each satellite.');
    const {frequency,symbolRate}=validateWeatherTarget(match[0]);
    return {satellite:id,frequency,symbolRate,enabled:match[0].enabled};
  });
  if(input.enabled&&!targets.some(target=>target.enabled))throw Error('Enable at least one satellite for automatic capture.');
  return {enabled:input.enabled,minElevation:input.minElevation,targets};
}

function makeJob(target,pass,site,automatic) {
  const {satellite,frequency,symbolRate}=target;
  const {rise,peak,set,maxElevation}=pass;
  return {id:randomUUID(),satellite,frequency,symbolRate,rise,peak,set,maxElevation,site,automatic,phase:'queued'};
}

export function createWeatherSchedule({file,site,plan,busy,ready,launch,now=Date.now}) {
  let state, initialising, timer, running=false, stopped=false, serial=Promise.resolve();
  let upcoming=[], note='';

  async function read() {
    if(state)return state;
    if(!initialising)initialising=(async()=>{
      let saved;
      try { saved=JSON.parse(await readFile(file,'utf8')); }
      catch(error) { if(error.code!=='ENOENT')throw error; }
      if(!saved)return state={settings:structuredClone(defaults),jobs:[]};
      saved.settings=validateSettings(saved.settings);
      const interrupted=saved.jobs.filter(job=>['starting','recording'].includes(job.phase));
      for(const job of interrupted){
        job.phase='failed';
        job.message='Open Air restarted before this capture completed.';
      }
      if(interrupted.length)await writeStateFile(file,saved);
      return state=saved;
    })().finally(()=>{initialising=null;});
    return initialising;
  }

  function update(change) {
    const pending=serial.then(async()=>{
      const draft=structuredClone(await read());
      if(change(draft)===false)return false;
      const active=draft.jobs.filter(job=>activePhases.has(job.phase));
      const recent=draft.jobs.filter(job=>!activePhases.has(job.phase)).sort((a,b)=>b.rise-a.rise).slice(0,40);
      draft.jobs=[...active,...recent];
      await writeStateFile(file,draft);
      state=draft;
      return true;
    });
    serial=pending.catch(()=>{});
    return pending;
  }

  async function status() {
    const saved=await read();
    return {available:true,settings:saved.settings,note,frequencies:lrptFrequencies,
      satellites:weatherSatellites.map(({id,name})=>({id,name})),
      upcoming:upcoming.filter(pass=>pass.set>now()).slice(0,4).map(({site:observer,path,...pass})=>pass),
      jobs:saved.jobs.map(({site:observer,...job})=>job)};
  }

  async function request(input) {
    if(input?.action==='settings'){
      const settings=validateSettings(input.settings);
      await update(draft=>{draft.settings=settings;});
    }else if(input?.action==='cancel'){
      await update(draft=>{
        const job=draft.jobs.find(job=>job.id===input.id&&job.phase==='queued');
        if(!job)throw Error('That pass is no longer queued.');
        job.phase='cancelled';
        job.message='Cancelled before the pass.';
      });
    }else if(input?.action==='queue'){
      const target=validateWeatherTarget(input);
      if(!Number.isSafeInteger(input.rise))throw Error('Select an upcoming pass.');
      const centre=await site();
      if(!centre)throw Error('Set your observing location in Setup.');
      const predictions=await plan(centre);
      const satellite=predictions.satellites.find(item=>item.id===target.satellite.id);
      const pass=satellite?.passes.find(candidate=>Math.abs(candidate.rise-input.rise)<matchWindow);
      if(!pass||cutoff(pass)<=now())throw Error('That pass is no longer available to schedule. Select an upcoming pass.');
      const job=makeJob({...target,satellite:target.satellite.id},pass,JSON.stringify(centre),false);
      await update(draft=>{
        const queued=draft.jobs.filter(job=>job.phase==='queued');
        if(queued.length>=12)throw Error('Cancel a queued pass before adding another.');
        if(draft.jobs.some(other=>activePhases.has(other.phase)&&overlaps(job,other))){
          throw Error('This pass overlaps another scheduled capture.');
        }
        draft.jobs.push(job);
      });
    }else throw Error('Choose a Skywatcher schedule action.');
    return status();
  }

  function autoPasses(saved,predictions,observer,time) {
    const candidates=saved.settings.targets.filter(target=>target.enabled).flatMap(target=>{
      const satellite=predictions.satellites.find(item=>item.id===target.satellite);
      return (satellite?.passes??[]).filter(pass=>pass.maxElevation>=saved.settings.minElevation&&cutoff(pass)>time)
        .map(pass=>({...target,...pass,site:observer,automatic:true}));
    }).filter(pass=>!saved.jobs.some(job=>samePass(job,pass)));
    const reserved=saved.jobs.filter(job=>activePhases.has(job.phase)&&job.set>time);
    const chosen=[];
    for(const pass of candidates.sort((a,b)=>b.maxElevation-a.maxElevation||a.rise-b.rise)){
      if(reserved.some(other=>overlaps(pass,other)))continue;
      chosen.push(pass);
      reserved.push(pass);
    }
    return chosen.sort((a,b)=>a.rise-b.rise);
  }

  async function finish(id,result) {
    await update(draft=>{
      const job=draft.jobs.find(item=>item.id===id);
      if(!job||!activePhases.has(job.phase))return false;
      job.phase=result.phase==='complete'?'complete':'failed';
      job.message=result.message || (job.phase==='complete'?'Images are ready in the gallery.':'No image was saved.');
    });
  }

  async function tick() {
    if(running||stopped)return;
    running=true;
    try{
      let saved=await read();
      const queued=saved.jobs.filter(job=>job.phase==='queued');
      if(!saved.settings.enabled&&!queued.length){upcoming=[];note='';return;}
      const centre=await site();
      const observer=JSON.stringify(centre);
      let time=now();
      const expired=queued.filter(job=>job.site!==observer||cutoff(job)<=time);
      if(expired.length){
        const ids=new Set(expired.map(job=>job.id));
        await update(draft=>{
          for(const job of draft.jobs.filter(item=>ids.has(item.id)&&item.phase==='queued')){
            job.phase='missed';
            job.message=job.site!==observer?'Observing location changed.':'The start window passed before the receiver was available.';
          }
        });
        saved=await read();
      }
      if(!centre){upcoming=[];note='Set your observing location in Setup.';return;}
      const predictions=saved.settings.enabled?await plan(centre):null;
      time=now();
      upcoming=predictions?autoPasses(saved,predictions,observer,time):[];
      const due=saved.jobs.filter(job=>job.phase==='queued'&&job.site===observer&&job.rise-lead<=time&&cutoff(job)>time)
        .sort((a,b)=>a.rise-b.rise)[0]??upcoming.find(job=>job.rise-lead<=time);
      if(!due){
        note=predictions&&predictions.satellites.every(item=>!item.passes.length)?'Waiting for usable orbital predictions.':'';
        return;
      }
      note=busy();
      if(note)return;
      if(!await ready()){note='Waiting for SatDump to become available.';return;}
      const job=due.automatic?makeJob(due,due,observer,true):due;
      const claimed=await update(draft=>{
        if(stopped||cutoff(job)<=now()||busy())return false;
        if(job.automatic){
          const {settings}=draft;
          if(!settings.enabled||job.maxElevation<settings.minElevation||
            !settings.targets.some(target=>target.enabled&&sameTarget(target,job))||
            draft.jobs.some(other=>samePass(other,job)||(activePhases.has(other.phase)&&overlaps(other,job))))return false;
          draft.jobs.push({...job,phase:'starting'});
        }else{
          const queued=draft.jobs.find(item=>item.id===job.id&&item.phase==='queued');
          if(!queued)return false;
          queued.phase='starting';
        }
      });
      if(!claimed)return;
      try{
        const capture=stopped?null:await launch(validateWeatherTarget(job),job.set+tail,result=>finish(job.id,result));
        if(!capture){
          await update(draft=>{
            const pending=draft.jobs.find(item=>item.id===job.id&&item.phase==='starting');
            if(!pending)return false;
            if(job.automatic)draft.jobs=draft.jobs.filter(item=>item.id!==job.id);
            else pending.phase='queued';
          });
          return;
        }
        await update(draft=>{
          const starting=draft.jobs.find(item=>item.id===job.id&&item.phase==='starting');
          if(!starting)return false;
          starting.phase='recording';
          starting.captureId=capture.id;
        });
      }catch(error){
        await finish(job.id,{phase:'failed',message:error.message});
      }
    }finally{running=false;}
  }

  function start() {
    if(timer)return;
    stopped=false;
    const poll=()=>void tick().catch(error=>{note='Skywatcher could not check the schedule.';console.warn(note,error.message);});
    poll();
    timer=setInterval(poll,5000);
    timer.unref();
  }

  function stop() {stopped=true;clearInterval(timer);timer=null;}
  return {request,status,start,stop,tick};
}
