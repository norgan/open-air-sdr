export function initialiseAircraftScreen({document:doc=globalThis.document,window:win=globalThis.window}={}) {
  const panel=doc?.querySelector('.panel.stage');
  const settings=doc?.getElementById('aircraft-display-settings');
  const actions=doc?.getElementById('aircraft-screen-actions');
  const button=doc?.getElementById('aircraft-fullscreen');
  const switcher=doc?.getElementById('aircraft-screen-switch');
  const mapButton=doc?.getElementById('aircraft-screen-map');
  const radarButton=doc?.getElementById('aircraft-screen-radar');
  const hint=doc?.getElementById('aircraft-screen-hint');
  const localLayout=doc?.getElementById('local-aircraft-layout');
  if(!panel||!settings||!actions||!button||!switcher||!mapButton||!radarButton||!hint)return null;

  let fallback=false;
  let entering=false;
  let leaving=false;
  let wasActive=false;
  let restorePoint;
  const listeners=[];
  const observers=[];
  const active=()=>fallback||doc.fullscreenElement===panel;
  const available=()=>!settings.hidden;
  const originalControls=()=>localLayout&&!localLayout.hidden?'local':'tower';
  const on=(target,event,handler)=>{
    target.addEventListener(event,handler);
    listeners.push(()=>target.removeEventListener(event,handler));
  };
  function restore() {
    if(!restorePoint)return;
    const saved=restorePoint;
    restorePoint=undefined;
    (saved.focus?.isConnected?saved.focus:button).focus({preventScroll:true});
    win?.scrollTo?.(saved.x,saved.y);
  }
  function sync() {
    const expanded=active();
    actions.hidden=!available()&&!expanded;
    button.textContent=expanded?'Exit fullscreen':'Fullscreen';
    button.setAttribute('aria-pressed',String(expanded));
    button.title=expanded?'Return to the normal aircraft view':'Show the aircraft map or radar fullscreen';
    switcher.hidden=!expanded;
    hint.hidden=!expanded;
    doc.body.classList.toggle('aircraft-screen-active',expanded);
    const prefix=originalControls();
    mapButton.setAttribute('aria-pressed',doc.getElementById(prefix+'-show-map')?.getAttribute('aria-pressed')||'false');
    radarButton.setAttribute('aria-pressed',doc.getElementById(prefix+'-show-radar')?.getAttribute('aria-pressed')||'false');
    if(wasActive&&!expanded)restore();
    wasActive=expanded;
    if(expanded&&!available()&&!leaving)void exit();
  }
  async function enter() {
    if(!available()||active()||entering)return;
    entering=true;
    restorePoint={focus:doc.activeElement,x:win?.scrollX||0,y:win?.scrollY||0};
    try {
      if(doc.fullscreenEnabled===false||typeof panel.requestFullscreen!=='function')throw Error('Fullscreen unavailable');
      await panel.requestFullscreen({navigationUI:'hide'});
    } catch {
      if(available()) {
        fallback=true;
        panel.classList.add('aircraft-screen-focus');
      }
    } finally {
      entering=false;
      sync();
      if(active())button.focus({preventScroll:true});
      else restore();
    }
  }
  async function exit() {
    if(leaving)return;
    leaving=true;
    fallback=false;
    panel.classList.remove('aircraft-screen-focus');
    if(doc.fullscreenElement===panel) {
      try { await doc.exitFullscreen(); } catch {}
    }
    sync();
    leaving=false;
  }
  function toggle() {
    if(active())void exit();
    else void enter();
  }
  function choose(view) {
    doc.getElementById(originalControls()+'-show-'+view)?.click();
    sync();
  }
  function keydown(event) {
    if(!active())return;
    if(event.key==='Escape'&&fallback) {
      event.preventDefault();
      void exit();
      return;
    }
    if(event.key!=='Tab')return;
    const controls=[...panel.querySelectorAll('button:not([disabled]),a[href],input:not([disabled]),select:not([disabled]),summary,[tabindex]:not([tabindex="-1"])')]
      .filter(control=>control.getClientRects().length>0&&!control.closest('[hidden]'));
    const first=controls[0], last=controls.at(-1);
    if(!first)return;
    if(event.shiftKey&&doc.activeElement===first) {
      event.preventDefault();last.focus();
    } else if(!event.shiftKey&&doc.activeElement===last) {
      event.preventDefault();first.focus();
    } else if(!panel.contains(doc.activeElement)) {
      event.preventDefault();first.focus();
    }
  }
  on(button,'click',toggle);
  on(mapButton,'click',()=>choose('map'));
  on(radarButton,'click',()=>choose('radar'));
  on(doc,'fullscreenchange',sync);
  on(doc,'keydown',keydown);
  if(win?.MutationObserver) {
    const observer=new win.MutationObserver(sync);
    observer.observe(settings,{attributes:true,attributeFilter:['hidden']});
    if(localLayout)observer.observe(localLayout,{attributes:true,attributeFilter:['hidden']});
    for(const id of ['local-show-map','local-show-radar','tower-show-map','tower-show-radar']) {
      const control=doc.getElementById(id);
      if(control)observer.observe(control,{attributes:true,attributeFilter:['aria-pressed']});
    }
    observers.push(observer);
  }
  sync();
  return {enter,exit,sync,destroy() {
    for(const stop of listeners)stop();
    for(const observer of observers)observer.disconnect();
    void exit();
  }};
}

if(typeof document!=='undefined')initialiseAircraftScreen();
