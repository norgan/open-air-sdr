// Browser integration check; run after installing Playwright and Leaflet in the CI workspace.
// The receiver, aircraft and map tiles are synthetic. No SDR hardware or provider calls are used.
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { chromium } from 'playwright';
import { appServer } from '../server.mjs';
import { availableSources } from '../sources.mjs';

const require=createRequire(import.meta.url);
const leafletDirectory=dirname(require.resolve('leaflet/package.json'));
const localAircraft=[
  {hex:'abc123',title:'LOCAL123',tag:'A320',detail:'6,200 ft · 1.8 km',source:'Local receiver',
    registration:'G-TEST',lat:51.505,lon:-0.11,altitude:6200,speed:245,heading:75,distanceKm:1.8,bearing:70},
  {hex:'abc124',title:'LOCAL124',tag:'B738',detail:'3,500 ft · 2.4 km',source:'Local receiver',
    registration:'G-OTHER',lat:51.49,lon:-0.135,altitude:3500,speed:180,heading:220,distanceKm:2.4,bearing:220},
];
const pendingAircraft={hex:'abc125',title:'AWAITING',tag:'NO POSITION',
  detail:'1,500 ft · Waiting for position frames',source:'Local receiver',altitude:1500};
const networkAircraft=[
  {hex:'def123',title:'NETWORK1',tag:'A359',detail:'5,000 ft',source:'adsb.lol',
    lat:51.51,lon:-0.10,altitude:5000,heading:45,distanceKm:2,bearing:45},
  {hex:'def124',title:'NETWORK2',tag:'B788',detail:'7,000 ft',source:'adsb.lol',
    lat:51.48,lon:-0.14,altitude:7000,heading:170,distanceKm:3,bearing:190},
];
const centre={latitude:51.5,longitude:-0.12};
const profile={name:'Preview area',includeSydney:false,aircraftCentre:centre,
  scan:{startFrequency:118e6,stopFrequency:137e6,threshold:12},presets:[]};
let tunes=0;
let snapshotReads=0;
const receiver={
  selectedSource:availableSources.find(item=>item.id==='adsb'),
  async snapshot(){
    const frame=++snapshotReads;
    const currentAircraft=localAircraft.map(item=>({...item,detail:item.detail+' · sample '+frame}));
    return {source:'adsb',sourceName:'ADS-B',mode:'adsb',connected:true,running:true,
      frequency:1090e6,centre:1090100000,bandwidth:2e6,gain:197,channelPower:-46,
      aircraft:currentAircraft,aircraftReceived:[...currentAircraft,pendingAircraft],
      adsb:{channelSampleRate:2400000,correlationThreshold:5,trackedAircraft:3},
      updated:new Date().toISOString()};
  },
  async availableModes(){return ['am','nfm','bfm','adsb','spectrum'];},
  async availableGains(){return [0,197];},
  async tune(){tunes++;return this.snapshot();},
};
const port=18896;
const origin='http://127.0.0.1:'+port;
const service=appServer(receiver,port,{
  profileStore:{async read(){return profile;}},
  async aircraftRequest(){throw Error('Live aircraft provider disabled in browser fixture.');},
});
await new Promise((resolve,reject)=>{service.once('error',reject);service.listen(port,'127.0.0.1',resolve);});
let browser,page;
try{
  browser=await chromium.launch();
  page=await browser.newPage({viewport:{width:1280,height:1000}});
  page.setDefaultTimeout(15000);
  const context=page.context();
  const errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  const childApiRequests=[];
  context.on('request',request=>{
    if(!request.url().startsWith(origin+'/api/'))return;
    try { if(request.frame().page()!==page)childApiRequests.push(request.url()); } catch {}
  });
  let towerRequests=0;
  const identityRequests=[];
  let failedPhotoRequests=0;
  let releasePendingIdentity;
  let pendingIdentityStarted;
  const pendingIdentityReady=new Promise(resolve=>{pendingIdentityStarted=resolve;});
  const pendingIdentityGate=new Promise(resolve=>{releasePendingIdentity=resolve;});
  const photoUrl='https://t.plnspttrs.net/000/000000-preview.jpg';
  const failedPhotoUrl='https://t.plnspttrs.net/000/000001-missing.jpg';
  const photo={url:photoUrl,link:'https://www.planespotters.net/photo/000000/preview',
    photographer:'Fixture Photographer',source:'Planespotters.net'};
  await context.route(origin+'/api/aircraft-info?*',async route=>{
    const query=new URL(route.request().url()).searchParams;
    const hex=String(query.get('hex')).toUpperCase();
    const callsign=query.get('callsign')||'';
    identityRequests.push({hex,callsign});
    if(hex==='ABC123'){
      return route.fulfill({json:{hex,callsign,airline:'Preview Air',
        flightNumber:callsign==='LOCAL456'?'PA456':'PA123',registration:'G-TEST',aircraftType:'A320',
        identityStatus:'ready',metadataSource:'adsbdb',photo}});
    }
    if(hex==='ABC125'){
      pendingIdentityStarted();
      await pendingIdentityGate;
      return route.fulfill({json:{hex,callsign,airline:'Pending Air',registration:'G-WAIT',
        identityStatus:'partial',metadataSource:'adsbdb',photo:{...photo,url:failedPhotoUrl}}});
    }
    if(callsign==='UNAVAIL')return route.fulfill({status:503,json:{error:'Fixture metadata service unavailable'}});
    return route.fulfill({json:{hex,callsign,identityStatus:'not-found',metadataSource:'adsbdb'}});
  });
  const photoImage='<svg xmlns="http://www.w3.org/2000/svg" width="640" height="320"><rect width="640" height="320" fill="#d6e4ef"/><path d="M90 180L300 150L430 70L455 80L385 155L550 175L550 195L370 195L330 270L305 270L320 190L90 200Z" fill="#fff" stroke="#243746" stroke-width="5"/></svg>';
  await context.route(photoUrl,route=>route.fulfill({contentType:'image/svg+xml',body:photoImage}));
  await context.route(failedPhotoUrl,route=>{
    failedPhotoRequests++;
    return route.fulfill({status:404,body:'Missing fixture photograph'});
  });
  await context.route(origin+'/api/tower/aircraft',route=>{
    towerRequests++;
    return route.fulfill({json:{status:'live',centre,updated:new Date().toISOString(),aircraft:networkAircraft}});
  });
  await context.route(origin+'/api/messages',route=>route.fulfill({json:{limit:500,messages:[
    {id:'msg-match',title:'G-TEST',tag:'H1',mode:'acars',frequency:131550000,
      time:'2026-11-22T00:00:00Z',detail:'Exact registration fixture.'},
    {id:'msg-near-match',title:'G-TESTX',tag:'H1',mode:'acars',frequency:131550000,
      time:'2026-11-22T00:00:01Z',detail:'A different registration.'},
    {id:'msg-payload-only',title:'UNRELATED',tag:'H1',mode:'acars',frequency:131550000,
      time:'2026-11-22T00:00:02Z',detail:'Payload mentions G-TEST but does not identify that aircraft.'},
  ]}}));
  await context.route('https://unpkg.com/leaflet@1.9.4/dist/**',async route=>{
    const name=new URL(route.request().url()).pathname.split('/').at(-1);
    if(!['leaflet.css','leaflet.js'].includes(name))return route.abort();
    return route.fulfill({body:await readFile(join(leafletDirectory,'dist',name)),
      contentType:name.endsWith('.css')?'text/css':'application/javascript'});
  });
  // A pale reference tile makes marker contrast visible without contacting a tile provider.
  const tile='<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#e7e7df"/><path d="M0 80H256M75 0V256M0 210L256 20" stroke="#fff" stroke-width="15"/><path d="M0 80H256M75 0V256M0 210L256 20" stroke="#b9bec0" stroke-width="2"/><path d="M190 0V256" stroke="#b3d7e7" stroke-width="25"/></svg>';
  await context.route('https://tile.openstreetmap.org/**',route=>route.fulfill({contentType:'image/svg+xml',body:tile}));
  const countMarkers=async expected=>page.waitForFunction(count=>
    document.querySelectorAll('#tower-map .tower-aircraft-marker').length===count,expected);
  const markerTitles=()=>page.locator('#tower-map .tower-aircraft-marker').evaluateAll(nodes=>nodes.map(node=>node.title).sort());
  const waitVisible=selector=>page.locator(selector).waitFor({state:'visible'});
  const setColour=async(id,value)=>page.locator(id).evaluate((input,colour)=>{
    input.value=colour;input.dispatchEvent(new Event('input',{bubbles:true}));
  },value);
  const openDisplay=async()=>{
    const settings=page.locator('#aircraft-display-settings');
    if(!await settings.evaluate(node=>node.open))await settings.locator('summary').click();
  };
  const recordFor=callsign=>page.locator('#activity .aircraft-record').filter({hasText:callsign});
  const identityCount=hex=>identityRequests.filter(item=>item.hex===hex).length;
  const waitNextAircraftFrame=async callsign=>{
    const before=await recordFor(callsign).locator('.item-detail').innerText();
    await page.waitForFunction(({callsign,before})=>{
      const record=[...document.querySelectorAll('#activity .aircraft-record')]
        .find(node=>node.querySelector('summary')?.textContent.includes(callsign));
      return record?.querySelector('.item-detail')?.textContent!==before;
    },{callsign,before});
  };
  const tileZoom=()=>page.locator('#tower-map img.leaflet-tile').evaluateAll(images=>
    Math.max(...images.map(image=>Number(new URL(image.src).pathname.split('/')[1]))));
  const enterAircraftFullscreen=async()=>{
    await page.locator('#aircraft-fullscreen').click();
    await page.waitForFunction(()=>Boolean(document.fullscreenElement)||
      Boolean(document.querySelector('.aircraft-screen-focus')));
    await waitVisible('#aircraft-screen-map');
    await waitVisible('#aircraft-screen-radar');
  };
  const exitAircraftFullscreen=async()=>{
    await page.keyboard.press('Escape');
    await page.waitForFunction(()=>!document.fullscreenElement&&!document.querySelector('.aircraft-screen-focus'));
    assert.equal(await page.locator('#aircraft-screen-map').isVisible(),false);
  };
  const openDetachedPanel=async selector=>{
    const opened=page.waitForEvent('popup');
    await page.locator(selector).click();
    const child=await opened;
    child.on('pageerror',error=>errors.push(error.message));
    await child.waitForLoadState('domcontentloaded');
    return child;
  };
  const detachedMarkerTitles=child=>child.locator('#detached-map .tower-aircraft-marker')
    .evaluateAll(nodes=>nodes.map(node=>node.title).sort());

  await page.goto(origin+'/#signals');
  await waitVisible('#local-show-map');
  await page.locator('#local-show-map').click();
  await waitVisible('#tower-map');
  await countMarkers(2);
  assert.deepEqual(await markerTitles(),['LOCAL123','LOCAL124']);
  assert.equal(await page.locator('#activity .aircraft-record').count(),3,'partial RF tracks remain in the received list');
  assert.match(await page.locator('#activity').innerText(),/AWAITING[\s\S]*NO POSITION/);
  assert.equal(towerRequests,0,'local ADS-B does not request the network feed');
  assert.equal(tunes,0,'display choice does not retune the receiver');
  assert.equal(identityRequests.length,0,'aircraft identity is looked up only when a row opens');

  // Identity enrichment augments a received track without supplying its RF position.
  for(let step=0;step<3;step++)await page.getByRole('button',{name:'Zoom in',exact:true}).click();
  await page.locator('#tower-map .tower-aircraft-marker[data-aircraft-hex="abc123"]').click();
  await recordFor('LOCAL123').locator('.aircraft-profile-airline').filter({hasText:'Preview Air'}).waitFor();
  assert.equal(await recordFor('LOCAL123').getAttribute('open'),'','selecting a map icon opens its aircraft row');
  assert.equal(await recordFor('LOCAL123').locator('summary').getAttribute('aria-current'),'true');
  assert.equal(await page.locator('#tower-map .tower-aircraft-marker[data-aircraft-hex="abc123"]').getAttribute('aria-pressed'),'true');
  assert.match(await recordFor('LOCAL123').locator('.aircraft-profile-flight').innerText(),/PA123/);
  assert.match(await recordFor('LOCAL123').innerText(),/LOCAL123/,'the received callsign remains available');
  const aircraftPhoto=recordFor('LOCAL123').locator('img.aircraft-photo');
  await aircraftPhoto.scrollIntoViewIfNeeded();
  await page.waitForFunction(()=>{
    const image=document.querySelector('#activity .aircraft-photo');
    return image?.complete&&image.naturalWidth>0;
  });
  assert.equal(await recordFor('LOCAL123').locator('.aircraft-photo-link').getAttribute('href'),photo.link);
  assert.match(await recordFor('LOCAL123').locator('.aircraft-photo-attribution').innerText(),/Fixture Photographer/);
  assert.deepEqual(identityRequests,[{hex:'ABC123',callsign:'LOCAL123'}]);
  await waitNextAircraftFrame('LOCAL123');
  assert.equal(await recordFor('LOCAL123').getAttribute('open'),'','a polled track retains its open details');
  assert.equal(await aircraftPhoto.isVisible(),true,'the photograph survives live polling');
  assert.equal(identityCount('ABC123'),1,'polling uses the cached identity');
  assert.equal(await recordFor('LOCAL123').locator('summary').getAttribute('aria-current'),'true','selection survives polling');
  await recordFor('LOCAL123').locator('summary').click();
  await recordFor('LOCAL123').locator('summary').click();
  assert.equal(identityCount('ABC123'),1,'reopening uses the cached identity');

  // A changed callsign belongs to the same aircraft card but needs a fresh flight lookup.
  localAircraft[0]={...localAircraft[0],title:'LOCAL456'};
  await recordFor('LOCAL456').locator('.aircraft-profile-flight').filter({hasText:'PA456'}).waitFor();
  assert.equal(await recordFor('LOCAL456').getAttribute('open'),'');
  assert.equal(identityCount('ABC123'),2);
  assert.equal(identityRequests.filter(item=>item.hex==='ABC123'&&item.callsign==='LOCAL456').length,1);
  localAircraft[0]={...localAircraft[0],title:'LOCAL123'};
  await recordFor('LOCAL123').locator('.aircraft-profile-flight').filter({hasText:'PA123'}).waitFor();
  assert.equal(identityCount('ABC123'),2,'returning to a known callsign uses its cached flight');

  // Late metadata cannot replace another aircraft's card; a failed image stays failed across polls.
  await recordFor('AWAITING').locator('summary').click();
  await pendingIdentityReady;
  await recordFor('AWAITING').locator('summary').click();
  await recordFor('LOCAL124').locator('summary').click();
  assert.equal(await page.locator('#tower-map .tower-aircraft-marker[data-aircraft-hex="abc124"]').getAttribute('aria-pressed'),'true',
    'selecting an aircraft row highlights its map icon');
  await recordFor('LOCAL124').locator('.aircraft-profile-status').filter({hasText:'No additional aircraft details found.'}).waitFor();
  releasePendingIdentity();
  assert.doesNotMatch(await recordFor('LOCAL124').innerText(),/Pending Air/);
  await recordFor('AWAITING').locator('summary').click();
  await recordFor('AWAITING').locator('.aircraft-photo-frame').scrollIntoViewIfNeeded();
  await recordFor('AWAITING').locator('.aircraft-photo-fallback').filter({hasText:'No aircraft photo available.'}).waitFor();
  assert.match(await recordFor('AWAITING').innerText(),/NO POSITION/);
  assert.equal(identityCount('ABC125'),1);
  assert.equal(failedPhotoRequests,1);
  await waitNextAircraftFrame('LOCAL123');
  assert.equal(failedPhotoRequests,1,'a missing photo is not fetched again on each poll');
  assert.equal(await recordFor('AWAITING').locator('.aircraft-photo-fallback').isVisible(),true);
  assert.deepEqual(await markerTitles(),['LOCAL123','LOCAL124'],'metadata never creates a position for a partial track');
  localAircraft[1]={...localAircraft[1],title:'UNAVAIL'};
  await recordFor('UNAVAIL').locator('.aircraft-profile-status')
    .filter({hasText:'Aircraft details are temporarily unavailable.'}).waitFor();
  assert.equal(await recordFor('UNAVAIL').getAttribute('open'),'','a metadata failure retains the received track');
  localAircraft[1]={...localAircraft[1],title:'LOCAL124'};
  await recordFor('LOCAL124').locator('.aircraft-profile-status')
    .filter({hasText:'No additional aircraft details found.'}).waitFor();
  assert.equal(towerRequests,0);
  assert.equal(tunes,0,'aircraft identity and photos do not retune');
  await mkdir('test-results',{recursive:true});
  await page.screenshot({path:'test-results/aircraft-identity-photo.png',fullPage:true});
  for(const callsign of ['LOCAL123','LOCAL124','AWAITING']){
    if(await recordFor(callsign).evaluate(node=>node.open))await recordFor(callsign).locator('summary').click();
  }

  // The actual Leaflet wheel handler changes the geographic map zoom.
  const popupClose=page.locator('#tower-map .leaflet-popup-close-button');
  if(await popupClose.isVisible())await popupClose.click();
  const initialZoom=await tileZoom();
  await page.locator('#tower-map').hover();
  await page.mouse.wheel(0,-360);
  await page.waitForFunction(before=>Math.max(...[...document.querySelectorAll('#tower-map img.leaflet-tile')]
    .map(image=>Number(new URL(image.src).pathname.split('/')[1])))>before,initialZoom);
  const zoomBeforeFullscreen=await tileZoom();
  await enterAircraftFullscreen();
  assert.equal(await page.locator('#aircraft-screen-map').getAttribute('aria-pressed'),'true');
  await page.locator('#aircraft-screen-radar').click();
  await waitVisible('#radar');
  assert.equal(await page.locator('#tower-map').isVisible(),false);
  await page.locator('#radar .radar-aircraft[data-aircraft-hex="abc124"]').click();
  assert.equal(await recordFor('LOCAL124').getAttribute('open'),'','radar selection opens the matching aircraft row');
  assert.equal(await recordFor('LOCAL124').locator('summary').getAttribute('aria-current'),'true');
  await page.locator('#aircraft-screen-map').click();
  await waitVisible('#tower-map');
  assert.equal(await tileZoom(),zoomBeforeFullscreen,'fullscreen toggling preserves the geographic zoom');
  await exitAircraftFullscreen();
  assert.equal(await page.locator('#local-show-map').getAttribute('aria-pressed'),'true');

  // Detached aircraft windows consume the parent's positions without starting another app or poller.
  const aircraftWindow=await openDetachedPanel('#aircraft-popout');
  await aircraftWindow.waitForFunction(()=>document.querySelectorAll('#detached-map .tower-aircraft-marker').length===2);
  assert.deepEqual(await detachedMarkerTitles(aircraftWindow),['LOCAL123','LOCAL124']);
  assert.match(await aircraftWindow.locator('#detached-source').innerText(),/LOCAL RF/);
  assert.equal(await aircraftWindow.locator('#nav-signals').count(),0,'a detached panel does not boot the full app');
  assert.equal(await aircraftWindow.locator('script[src="/app.js"]').count(),0);
  assert.deepEqual(childApiRequests,[],'an idle detached aircraft window starts no API poller');
  await aircraftWindow.setViewportSize({width:720,height:500});
  for(let step=0;step<3;step++)await aircraftWindow.getByRole('button',{name:'Zoom in',exact:true}).click();
  await aircraftWindow.locator('#detached-view-radar').click();
  await aircraftWindow.locator('#detached-radar').waitFor({state:'visible'});
  await aircraftWindow.waitForFunction(()=>document.querySelectorAll('#detached-radar .radar-aircraft').length===2);
  assert.equal(await aircraftWindow.locator('#detached-map').isVisible(),false);
  await aircraftWindow.locator('#detached-view-map').click();
  await aircraftWindow.locator('#detached-map').waitFor({state:'visible'});
  await aircraftWindow.locator('#detached-map .tower-aircraft-marker[data-aircraft-hex="abc123"]').click();
  const detachedCard=aircraftWindow.locator('.leaflet-popup-content .aircraft-card');
  await detachedCard.locator('.aircraft-profile-airline').filter({hasText:'Preview Air'}).waitFor();
  const detachedPhoto=detachedCard.locator('img.aircraft-photo');
  await detachedPhoto.scrollIntoViewIfNeeded();
  await aircraftWindow.waitForFunction(()=>{
    const image=document.querySelector('.leaflet-popup-content img.aircraft-photo');
    return image?.complete&&image.naturalWidth>0;
  });
  assert.match(await detachedCard.locator('.aircraft-profile-flight').innerText(),/PA123/);
  assert.equal(childApiRequests.length,1,'clicking a detached aircraft performs one lazy identity lookup');
  assert.equal(new URL(childApiRequests[0]).pathname,'/api/aircraft-info');
  await aircraftWindow.screenshot({path:'test-results/aircraft-detached-photo.png'});
  const originalPosition=await aircraftWindow.locator('#detached-map .tower-aircraft-marker').first().getAttribute('style');
  const savedLatitude=localAircraft[0].lat;
  localAircraft[0]={...localAircraft[0],lat:savedLatitude+0.015};
  await page.bringToFront();
  await waitNextAircraftFrame('LOCAL123');
  await aircraftWindow.waitForFunction(previous=>
    document.querySelector('#detached-map .tower-aircraft-marker')?.getAttribute('style')!==previous,originalPosition);
  localAircraft[0]={...localAircraft[0],lat:savedLatitude};
  assert.equal(await page.locator('#aircraft-popout').isVisible(),true,'the main receiver controls remain available');
  const detachedPopupClose=aircraftWindow.locator('.leaflet-popup-close-button');
  if(await detachedPopupClose.isVisible())await detachedPopupClose.click();
  await page.bringToFront();
  await recordFor('LOCAL124').locator('summary').click();
  await aircraftWindow.waitForFunction(()=>
    document.querySelector('.tower-aircraft-marker[data-aircraft-hex="abc124"]')?.getAttribute('aria-pressed')==='true');
  await page.locator('#nav-messages').click();
  const matchingMessage=page.locator('#history-results .message-record[data-message="msg-match"]');
  const nearMessage=page.locator('#history-results .message-record[data-message="msg-near-match"]');
  const payloadMessage=page.locator('#history-results .message-record[data-message="msg-payload-only"]');
  await matchingMessage.waitFor({state:'visible'});
  await nearMessage.locator('summary').click();
  assert.equal(await nearMessage.getAttribute('data-aircraft-hex')||'','',
    'a registration prefix is not treated as the same aircraft');
  assert.notEqual(await aircraftWindow.locator('.tower-aircraft-marker[data-aircraft-hex="abc123"]').getAttribute('aria-pressed'),'true');
  await payloadMessage.locator('summary').click();
  assert.equal(await payloadMessage.getAttribute('data-aircraft-hex')||'','',
    'a registration mention inside a payload is not an aircraft identity');
  await matchingMessage.locator('summary').click();
  assert.equal(await matchingMessage.getAttribute('data-aircraft-hex'),'abc123');
  await aircraftWindow.waitForFunction(()=>
    document.querySelector('.tower-aircraft-marker[data-aircraft-hex="abc123"]')?.getAttribute('aria-pressed')==='true');
  assert.equal(await matchingMessage.evaluate(node=>node.classList.contains('aircraft-selected')),true);
  assert.equal(await nearMessage.evaluate(node=>node.classList.contains('aircraft-selected')),false);
  assert.equal(await payloadMessage.evaluate(node=>node.classList.contains('aircraft-selected')),false);
  await page.locator('#nav-signals').click();
  await waitVisible('#local-show-map');
  assert.equal(await recordFor('LOCAL123').locator('summary').getAttribute('aria-current'),'true',
    'message selection returns to the associated aircraft row');
  const windowCount=context.pages().length;
  await page.locator('#aircraft-popout').click();
  assert.equal(context.pages().length,windowCount,'opening the same detached panel reuses its window');
  await aircraftWindow.screenshot({path:'test-results/aircraft-detached-window.png'});
  await aircraftWindow.close();
  const reopenedAircraftWindow=await openDetachedPanel('#aircraft-popout');
  await reopenedAircraftWindow.waitForFunction(()=>document.querySelectorAll('#detached-map .tower-aircraft-marker').length===2);
  await reopenedAircraftWindow.close();
  assert.equal(childApiRequests.filter(url=>new URL(url).pathname!=='/api/aircraft-info').length,0,
    'detached aircraft windows never start RF or network position requests');
  assert.equal(tunes,0,'detached aircraft controls do not retune');

  await openDisplay();
  await setColour('#aircraft-colour','#ff0088');
  await setColour('#aircraft-outline','#000000');
  await page.locator('#aircraft-size').focus();
  await page.locator('#aircraft-size').press('End');
  await page.locator('#map-opacity').focus();
  await page.locator('#map-opacity').press('Home');
  await page.waitForFunction(()=>{
    const marker=document.querySelector('#tower-map .tower-aircraft-marker');
    return marker&&getComputedStyle(marker).width==='44px';
  });
  const styles=await page.evaluate(()=>{
    const marker=document.querySelector('#tower-map .tower-aircraft-marker');
    const path=marker.querySelector('path');
    const tilePane=document.querySelector('#tower-map .leaflet-tile-pane');
    const credit=document.querySelector('#tower-map .leaflet-control-attribution');
    return {fill:getComputedStyle(path).fill,stroke:getComputedStyle(path).stroke,
      markerOpacity:getComputedStyle(marker).opacity,tileOpacity:getComputedStyle(tilePane).opacity,
      creditOpacity:getComputedStyle(credit).opacity};
  });
  assert.equal(styles.fill,'rgb(255, 0, 136)');
  assert.equal(styles.stroke,'rgb(0, 0, 0)');
  assert.equal(styles.tileOpacity,'0.3');
  assert.equal(styles.markerOpacity,'1');
  assert.equal(styles.creditOpacity,'1','map opacity keeps attribution legible');
  await mkdir('test-results',{recursive:true});
  await page.screenshot({path:'test-results/aircraft-local-map.png',fullPage:true});

  await page.locator('#nav-tower').click();
  await waitVisible('#tower-show-radar');
  await countMarkers(2);
  await page.waitForFunction(()=>document.querySelector('#tower-map .tower-aircraft-marker')?.title==='NETWORK1');
  assert.deepEqual(await markerTitles(),['NETWORK1','NETWORK2']);
  await page.locator('#tower-show-radar').click();
  await waitVisible('#radar');
  assert.equal(await page.locator('#tower-map').isVisible(),false);
  await enterAircraftFullscreen();
  assert.equal(await page.locator('#aircraft-screen-radar').getAttribute('aria-pressed'),'true');
  await page.locator('#aircraft-screen-map').click();
  await waitVisible('#tower-map');
  assert.deepEqual(await markerTitles(),['NETWORK1','NETWORK2']);
  await page.locator('#aircraft-screen-radar').click();
  await waitVisible('#radar');
  await exitAircraftFullscreen();
  await page.locator('#nav-signals').click();
  await waitVisible('#tower-map');
  await countMarkers(2);
  await page.waitForFunction(()=>document.querySelector('#tower-map .tower-aircraft-marker')?.title==='LOCAL123');
  assert.deepEqual(await markerTitles(),['LOCAL123','LOCAL124'],'network markers cannot leak into RF view');
  assert.match(await page.locator('#activity').innerText(),/AWAITING/);
  await page.locator('#local-show-radar').click();
  await waitVisible('#radar');
  assert.equal(await page.locator('#tower-map').isVisible(),false);
  const radarFill=await page.locator('#radar .radar-aircraft path, #radar path.radar-aircraft').first().evaluate(node=>getComputedStyle(node).fill);
  assert.equal(radarFill,'rgb(255, 0, 136)','the radar shares aircraft colour');
  await page.locator('#nav-tower').click();
  await waitVisible('#radar');
  assert.equal(await page.locator('#tower-show-radar').getAttribute('aria-pressed'),'true');
  await page.locator('#tower-show-map').click();
  await waitVisible('#tower-map');
  await page.locator('#nav-signals').click();
  await waitVisible('#radar');
  await page.reload();
  await waitVisible('#local-show-radar');
  assert.equal(await page.locator('#local-show-radar').getAttribute('aria-pressed'),'true');
  await waitVisible('#radar');
  await openDisplay();
  assert.equal(await page.locator('#aircraft-colour').inputValue(),'#ff0088');
  assert.equal(await page.locator('#aircraft-size').inputValue(),'44');
  assert.equal(await page.locator('#map-opacity').inputValue(),'30');
  await page.locator('#nav-tower').click();
  await waitVisible('#tower-map');
  assert.equal(await page.locator('#tower-show-map').getAttribute('aria-pressed'),'true','Tower preference persists independently');
  await openDisplay();
  await page.locator('#aircraft-style-reset').click();
  assert.equal(await page.locator('#aircraft-colour').inputValue(),'#ffd166');
  assert.equal(await page.locator('#aircraft-size').inputValue(),'28');
  assert.equal(await page.locator('#map-opacity').inputValue(),'75');
  await page.setViewportSize({width:390,height:844});
  await page.locator('#nav-signals').click();
  await waitVisible('#local-show-radar');
  await openDisplay();
  const mobile=await page.evaluate(()=>{
    const ids=['aircraft-colour','aircraft-outline','aircraft-size','map-opacity'];
    return {overflow:document.documentElement.scrollWidth>document.documentElement.clientWidth+1,
      fields:ids.map(id=>{
        const node=document.getElementById(id);
        const rect=node.getBoundingClientRect();
        return {id,label:node.labels?.[0]?.textContent?.trim(),width:rect.width,
          inViewport:rect.left>=0&&rect.right<=innerWidth};
      })};
  });
  assert.equal(mobile.overflow,false,'display settings do not cause horizontal scrolling on a narrow screen');
  for(const field of mobile.fields){
    assert.ok(field.label,field.id+' has an associated label');
    assert.ok(field.width>=40&&field.inViewport,field.id+' remains usable at 390px');
  }
  await page.screenshot({path:'test-results/aircraft-mobile-controls.png',fullPage:true});
  await page.setViewportSize({width:1280,height:1000});
  await page.locator('#nav-receiver').click();
  await waitVisible('#waterfall-popout');
  const paintWaterfall=colour=>page.locator('#waterfall').evaluate((canvas,fill)=>{
    canvas.dataset.fixtureColour=fill;
    const context=canvas.getContext('2d');
    context.fillStyle=fill;
    context.fillRect(0,0,canvas.width,canvas.height);
    context.fillStyle='#ffda66';
    context.fillRect(Math.round(canvas.width/3),0,24,canvas.height);
  },colour);
  await paintWaterfall('#2064dc');
  // Keep synthetic samples flowing while ordinary RF polling clears its own empty stream state.
  const waterfallPainter=await page.evaluate(()=>{
    const paint=()=>{
      const canvas=document.getElementById('waterfall');
      const context=canvas.getContext('2d');
      context.fillStyle=canvas.dataset.fixtureColour||'#2064dc';
      context.fillRect(0,0,canvas.width,canvas.height);
      context.fillStyle='#ffda66';
      context.fillRect(Math.round(canvas.width/3),0,24,canvas.height);
      document.getElementById('waterfall-frequency').textContent='1090.000 MHz centre · test frame';
    };
    paint();
    return setInterval(paint,60);
  });
  const waterfallWindow=await openDetachedPanel('#waterfall-popout');
  await waterfallWindow.waitForFunction(()=>{
    const canvas=document.getElementById('detached-waterfall');
    if(!canvas?.width||!canvas.height)return false;
    const [r,g,b]=canvas.getContext('2d').getImageData(canvas.width/2,canvas.height/2,1,1).data;
    return b>g&&g>r;
  });
  assert.equal(await waterfallWindow.locator('#nav-signals').count(),0);
  assert.match(await waterfallWindow.locator('#detached-caption').innerText(),/1090\.000/);
  const firstWaterfallSize=await waterfallWindow.locator('#detached-waterfall').evaluate(canvas=>{
    const rect=canvas.getBoundingClientRect();
    return {width:rect.width,height:rect.height};
  });
  await waterfallWindow.setViewportSize({width:980,height:640});
  await waterfallWindow.waitForFunction(before=>{
    const rect=document.getElementById('detached-waterfall').getBoundingClientRect();
    return rect.width!==before.width||rect.height!==before.height;
  },firstWaterfallSize);
  await paintWaterfall('#28ba6a');
  await waterfallWindow.waitForFunction(()=>{
    const canvas=document.getElementById('detached-waterfall');
    const [r,g,b]=canvas.getContext('2d').getImageData(canvas.width/2,canvas.height/2,1,1).data;
    return g>b&&g>r;
  });
  const waterfallWindowCount=context.pages().length;
  await page.bringToFront();
  await page.locator('#waterfall-popout').click();
  assert.equal(context.pages().length,waterfallWindowCount,'the waterfall button reuses its detached window');
  await waterfallWindow.screenshot({path:'test-results/waterfall-detached-window.png'});
  await waterfallWindow.close();
  await paintWaterfall('#2064dc');
  const reopenedWaterfallWindow=await openDetachedPanel('#waterfall-popout');
  await reopenedWaterfallWindow.locator('#detached-waterfall').waitFor({state:'visible'});
  await reopenedWaterfallWindow.close();
  await page.evaluate(timer=>clearInterval(timer),waterfallPainter);
  assert.equal(childApiRequests.filter(url=>new URL(url).pathname!=='/api/aircraft-info').length,0,
    'detached panels share parent data instead of polling RF or network positions');
  assert.equal(tunes,0,'Map/Radar and appearance controls never retune');
  assert.deepEqual(errors,[],'browser modules initialise without page errors');
  console.log('Aircraft display browser checks passed.');
}catch(error){
  await mkdir('test-results',{recursive:true});
  await page?.screenshot({path:'test-results/aircraft-display-failure.png',fullPage:true}).catch(()=>{});
  throw error;
}finally{
  await browser?.close();
  service.closeAllConnections();
  await new Promise(resolve=>service.close(resolve));
}
