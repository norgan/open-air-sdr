import { rememberAircraftIdentity, selectAircraft, matchesAircraft, subscribeAircraftSelection } from './aircraft-selection.mjs';

const leafletUrl = 'https://unpkg.com/leaflet@1.9.4/dist/';
const tilesUrl = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const svgNamespace = 'http://www.w3.org/2000/svg';
export const aircraftOutline = 'M0 -8 L2 -1 L7 3 L7 5 L2 3 L2 7 L4 9 L0 8 L-4 9 L-2 7 L-2 3 L-7 5 L-7 3 L-2 -1 Z';
let leafletLoader;

function loadResource(element, url, integrity) {
  return new Promise((resolve, reject) => {
    element.integrity = integrity;
    element.crossOrigin = 'anonymous';
    element.addEventListener('load', resolve, {once:true});
    element.addEventListener('error', reject, {once:true});
    if (element.tagName === 'LINK') element.href = url;
    else element.src = url;
    document.head.append(element);
  });
}

async function loadLeaflet() {
  const stylesheet = document.createElement('link');
  stylesheet.rel = 'stylesheet';
  await loadResource(stylesheet, leafletUrl + 'leaflet.css', 'sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=');
  await loadResource(document.createElement('script'), leafletUrl + 'leaflet.js', 'sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=');
  return window.L;
}

function getLeaflet() {
  if (typeof window !== 'undefined' && window.L) return Promise.resolve(window.L);
  if (!leafletLoader) {
    leafletLoader = loadLeaflet().catch(error => {
      leafletLoader = undefined;
      throw error;
    });
  }
  return leafletLoader;
}

export function createTowerMap(container, status, {createCard,updateCard} = {}) {
  let map;
  let centreKey;
  let lastAircraft;
  let rendered;
  const markers = new Map();
  function paintSelection() {
    for(const marker of markers.values()){
      const active=matchesAircraft(marker.item);
      const element=marker.pin.getElement?.();
      element?.classList?.toggle('aircraft-selected',active);
      element?.setAttribute?.('aria-pressed',String(active));
      element?.setAttribute?.('data-aircraft-hex',String(marker.item.hex||'').toLowerCase());
    }
  }
  subscribeAircraftSelection(paintSelection);

  return async function show(centre, aircraft) {
    if (container.hidden || !centre) return;
    const point = [centre.latitude, centre.longitude];
    const key = point.join('/');
    rendered = aircraft;
    try {
      const leaflet = await getLeaflet();
      if (container.hidden || rendered !== aircraft) return;
      if (!map) {
        map = leaflet.map(container, {minZoom:3, maxZoom:19, scrollWheelZoom:true});
        const tiles = leaflet.tileLayer(tilesUrl, {
          maxZoom:19,
          attribution:'© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        });
        let tileLoaded = false;
        tiles.on('tileload', () => { tileLoaded = true; status.hidden = true; });
        tiles.on('tileerror', () => {
          if (!tileLoaded) {
            status.textContent = 'Map tiles are unavailable. Switch to Radar to see relative positions.';
            status.hidden = false;
          }
        });
        tiles.addTo(map);
        new ResizeObserver(() => { if (!container.hidden) map.invalidateSize(); }).observe(container);
      }
      map.invalidateSize();
      if (centreKey !== key) {
        centreKey = key;
        map.setView(point, 9);
      }
      if (lastAircraft === aircraft) return;
      lastAircraft = aircraft;
      const present = new Set();
      for (const item of aircraft) {
        rememberAircraftIdentity(item);
        present.add(item.hex);
        const coordinates = [item.lat, item.lon];
        const label = document.createElement('span');
        label.textContent = [item.title, item.tag, item.detail].filter(Boolean).join(' · ');
        let marker = markers.get(item.hex);
        if (!marker) {
          const icon = document.createElementNS(svgNamespace, 'svg');
          icon.setAttribute('viewBox','-12 -12 24 24');
          icon.setAttribute('aria-hidden','true');
          const shape = document.createElementNS(svgNamespace, 'path');
          shape.setAttribute('class', 'tower-aircraft-shape');
          shape.setAttribute('d', aircraftOutline);
          icon.append(shape);
          const pin = leaflet.marker(coordinates, {
            icon:leaflet.divIcon({className:'tower-aircraft-marker',html:icon,iconSize:[28,28]}),
            title:item.title, alt:item.title,
          }).bindPopup(label,{maxWidth:380,minWidth:230}).addTo(map);
          marker = {pin, shape, item, card:null};
          const current=marker;
          pin.on?.('popupopen',()=>{
            if(!createCard)return;
            current.card=createCard(current.item);
            pin.setPopupContent(current.card);
          });
          pin.on?.('popupclose',()=>{current.card=null;});
          pin.on?.('click',()=>selectAircraft(current.item,{origin:'map',reveal:true}));
          markers.set(item.hex,marker);
        } else {
          marker.item=item;
          marker.pin.setLatLng(coordinates);
          if(marker.card&&marker.pin.isPopupOpen?.())updateCard?.(marker.card,item);
          else marker.pin.setPopupContent(label);
        }
        marker.shape.setAttribute('transform', `rotate(${item.heading ?? 0})`);
      }
      for (const [hex, {pin}] of markers) {
        if (!present.has(hex)) {
          pin.remove();
          markers.delete(hex);
        }
      }
      paintSelection();
    } catch {
      if (container.hidden) return;
      status.textContent = 'The geographic map could not load. Switch to Radar to see relative positions.';
      status.hidden = false;
    }
  };
}
