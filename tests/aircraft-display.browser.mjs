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
    lat:51.505,lon:-0.11,altitude:6200,speed:245,heading:75,distanceKm:1.8,bearing:70},
  {hex:'abc124',title:'LOCAL124',tag:'B738',detail:'3,500 ft · 2.4 km',source:'Local receiver',
    lat:51.49,lon:-0.135,altitude:3500,speed:180,heading:220,distanceKm:2.4,bearing:220},
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
const receiver={
  selectedSource:availableSources.find(item=>item.id==='adsb'),
  async snapshot(){
    return {source:'adsb',sourceName:'ADS-B',mode:'adsb',connected:true,running:true,
      frequency:1090e6,centre:1090100000,bandwidth:2e6,gain:197,channelPower:-46,
      aircraft:localAircraft,aircraftReceived:[...localAircraft,pendingAircraft],
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
let browser;
try{
  browser=await chromium.launch();
  const page=await browser.newPage({viewport:{width:1280,height:1000}});
  const errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  let towerRequests=0;
  await page.route(origin+'/api/tower/aircraft',route=>{
    towerRequests++;
    return route.fulfill({json:{status:'live',centre,updated:new Date().toISOString(),aircraft:networkAircraft}});
  });
  await page.route('https://unpkg.com/leaflet@1.9.4/dist/**',async route=>{
    const name=new URL(route.request().url()).pathname.split('/').at(-1);
    if(!['leaflet.css','leaflet.js'].includes(name))return route.abort();
    return route.fulfill({body:await readFile(join(leafletDirectory,'dist',name)),
      contentType:name.endsWith('.css')?'text/css':'application/javascript'});
  });
  // A pale reference tile makes marker contrast visible without contacting a tile provider.
  const tile='<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#e7e7df"/><path d="M0 80H256M75 0V256M0 210L256 20" stroke="#fff" stroke-width="15"/><path d="M0 80H256M75 0V256M0 210L256 20" stroke="#b9bec0" stroke-width="2"/><path d="M190 0V256" stroke="#b3d7e7" stroke-width="25"/></svg>';
  await page.route('https://tile.openstreetmap.org/**',route=>route.fulfill({contentType:'image/svg+xml',body:tile}));
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
  assert.equal(tunes,0,'Map/Radar and appearance controls never retune');
  assert.deepEqual(errors,[],'browser modules initialise without page errors');
  console.log('Aircraft display browser checks passed.');
}finally{
  await browser?.close();
  service.closeAllConnections();
  await new Promise(resolve=>service.close(resolve));
}
