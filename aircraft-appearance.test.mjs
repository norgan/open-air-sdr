import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import {
  applyAircraftAppearance,
  defaultAircraftAppearance,
  loadAircraftAppearance,
  saveAircraftAppearance,
} from './aircraft-appearance.mjs';
import { createTowerMap } from './tower-map.mjs';

const defaults = {
  colour: '#ffd166',
  outline: '#101820',
  size: 28,
  mapOpacity: 75,
};

function memoryStorage(initial = null) {
  let value = initial;
  return {
    getItem(key) {
      assert.equal(key, 'open-air-aircraft-appearance');
      return value;
    },
    setItem(key, next) {
      assert.equal(key, 'open-air-aircraft-appearance');
      value = next;
    },
    saved() {
      return value;
    },
  };
}

test('exports safe aircraft display defaults without requiring a DOM', () => {
  assert.deepEqual(defaultAircraftAppearance, defaults);
  assert.ok(Object.isFrozen(defaultAircraftAppearance));
  const loaded = loadAircraftAppearance();
  assert.deepEqual(loaded, defaults);
  assert.notEqual(loaded, defaultAircraftAppearance);
});

test('persists validated appearance values and restores them independently', () => {
  const storage = memoryStorage();
  const saved = saveAircraftAppearance(storage, {
    colour: '#ABCDEF',
    outline: '#000001',
    size: 44,
    mapOpacity: 30,
  });
  assert.deepEqual(saved, {
    colour: '#abcdef',
    outline: '#000001',
    size: 44,
    mapOpacity: 30,
  });
  assert.equal(storage.saved(), JSON.stringify(saved));
  assert.deepEqual(loadAircraftAppearance(storage), saved);

  const lowerBounds = saveAircraftAppearance(storage, {
    colour: '#010203',
    outline: '#fefefe',
    size: 18,
    mapOpacity: 100,
  });
  assert.equal(lowerBounds.size, 18);
  assert.equal(lowerBounds.mapOpacity, 100);
});

test('rejects unsafe colours and values outside the display bounds field by field', () => {
  const storage = memoryStorage(JSON.stringify({
    colour: '#fff',
    outline: '#101820;background:red',
    size: 17,
    mapOpacity: 101,
  }));
  assert.deepEqual(loadAircraftAppearance(storage), defaults);
  assert.deepEqual(saveAircraftAppearance(storage, {
    colour: '#123456',
    outline: null,
    size: Number.NaN,
    mapOpacity: 55,
  }), {
    colour: '#123456',
    outline: defaults.outline,
    size: defaults.size,
    mapOpacity: 55,
  });
});

test('blocked or malformed local storage never prevents the display from loading', () => {
  assert.deepEqual(loadAircraftAppearance({getItem() { throw new Error('blocked'); }}), defaults);
  assert.deepEqual(loadAircraftAppearance(memoryStorage('{not json')), defaults);
  assert.doesNotThrow(() => saveAircraftAppearance({
    setItem() { throw new Error('quota'); },
  }, defaults));
});

test('applies all appearance values as root CSS variables and updates size immediately', () => {
  const declarations = new Map();
  const root = {style:{setProperty(name, value) { declarations.set(name, value); }}};
  applyAircraftAppearance(root, defaults);
  assert.deepEqual(Object.fromEntries(declarations), {
    '--aircraft-colour': '#ffd166',
    '--aircraft-outline': '#101820',
    '--aircraft-size': '28px',
    '--map-opacity': '0.75',
  });
  applyAircraftAppearance(root, {...defaults, size:44, mapOpacity:100});
  assert.equal(declarations.get('--aircraft-size'), '44px');
  assert.equal(declarations.get('--map-opacity'), '1');
  assert.doesNotThrow(() => applyAircraftAppearance(null, defaults));
});

test('marker styling is variable-driven while opacity is isolated to map tiles', async () => {
  const css = await readFile(new URL('./style.css', import.meta.url), 'utf8');
  assert.match(css, /\.tower-aircraft-marker\{[^}]*width:var\(--aircraft-size,28px\)!important/);
  assert.match(css, /\.tower-aircraft-marker path\.tower-aircraft-shape\{[^}]*fill:var\(--aircraft-colour,#ffd166\)!important;stroke:var\(--aircraft-outline,#101820\)!important/);
  assert.match(css, /#tower-map \.leaflet-tile-pane\{opacity:var\(--map-opacity,\.75\)\}/);
  assert.equal((css.match(/opacity:var\(--map-opacity/g) || []).length, 1);
  assert.doesNotMatch(css, /#tower-map\{[^}]*opacity/);
});

test('two maps share one Leaflet load and mounted markers retain the live size contract', async t => {
  const originalDocument = globalThis.document;
  const originalWindow = globalThis.window;
  const originalResizeObserver = globalThis.ResizeObserver;
  t.after(() => {
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
    if (originalResizeObserver === undefined) delete globalThis.ResizeObserver;
    else globalThis.ResizeObserver = originalResizeObserver;
  });

  const resources = [];
  const icons = [];
  const shapes = [];
  let markerCount = 0;

  function element(tagName) {
    const listeners = new Map();
    return {
      tagName: tagName.toUpperCase(),
      attributes: new Map(),
      children: [],
      addEventListener(type, listener) {
        listeners.set(type, listener);
      },
      dispatch(type) {
        listeners.get(type)?.();
      },
      setAttribute(name, value) {
        this.attributes.set(name, String(value));
      },
      append(child) {
        this.children.push(child);
      },
    };
  }

  const leaflet = {
    map() {
      return {
        invalidateSize() {},
        setView() {},
      };
    },
    tileLayer() {
      const layer = {
        on() { return layer; },
        addTo() { return layer; },
      };
      return layer;
    },
    divIcon(options) {
      icons.push(options);
      return options;
    },
    marker() {
      markerCount += 1;
      const pin = {
        bindPopup() { return pin; },
        addTo() { return pin; },
        setLatLng() { return pin; },
        setPopupContent() { return pin; },
        remove() {},
      };
      return pin;
    },
  };

  globalThis.window = {};
  globalThis.document = {
    head: {
      append(resource) {
        resources.push(resource);
        if (resource.tagName === 'SCRIPT') globalThis.window.L = leaflet;
        queueMicrotask(() => resource.dispatch('load'));
      },
    },
    createElement(tagName) {
      return element(tagName);
    },
    createElementNS(_namespace, tagName) {
      const node = element(tagName);
      if (tagName === 'path') shapes.push(node);
      return node;
    },
  };
  globalThis.ResizeObserver = class {
    observe() {}
  };

  const centre = {latitude:-33.86, longitude:151.21};
  const aircraft = [{
    hex: '7c0001',
    lat: -33.8,
    lon: 151.1,
    heading: 92,
    title: 'TEST1',
    tag: 'A320',
    detail: '4 km',
  }];
  const first = createTowerMap({hidden:false}, {hidden:true, textContent:''});
  const second = createTowerMap({hidden:false}, {hidden:true, textContent:''});
  await Promise.all([first(centre, aircraft), second(centre, aircraft)]);

  assert.deepEqual(resources.map(item => item.tagName), ['LINK', 'SCRIPT']);
  assert.equal(markerCount, 2);
  assert.deepEqual(icons.map(item => item.iconSize), [[28,28], [28,28]]);
  assert.equal(shapes.length, 2);
  assert.ok(shapes.every(shape => shape.attributes.get('class') === 'tower-aircraft-shape'));
  assert.ok(shapes.every(shape => shape.attributes.get('transform') === 'rotate(92)'));

  const declarations = new Map();
  applyAircraftAppearance({style:{setProperty(name, value) {
    declarations.set(name, value);
  }}}, {...defaults, size:44});
  assert.equal(declarations.get('--aircraft-size'), '44px');
  assert.equal(markerCount, 2);
});
