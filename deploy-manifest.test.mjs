import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root=dirname(fileURLToPath(import.meta.url));
const read=name=>readFile(resolve(root,...name.split('/')),'utf8');

function localModule(from,specifier) {
  if(specifier.startsWith('/'))return posix.normalize(specifier.slice(1));
  if(specifier.startsWith('./')||specifier.startsWith('../'))return posix.normalize(posix.join(posix.dirname(from),specifier));
  return null;
}

function imports(source) {
  const found=[];
  const pattern=/(?:\b(?:import|export)\s+(?:[^'";]+?\s+from\s+)?|\bimport\s*\()(['"])([^'"]+)\1/g;
  for(const match of source.matchAll(pattern))found.push(match[2]);
  return found;
}

test('Debian deployment includes the complete browser module graph',async()=>{
  const installer=await read('deploy/install-debian.sh');
  const declaration=installer.match(/\bapp_files=\(([\s\S]*?)\)/);
  assert.ok(declaration,'install-debian.sh must declare app_files');
  const installed=new Set(declaration[1].trim().split(/\s+/).filter(Boolean));

  const pages=await Promise.all(['index.html','detached-panel.html'].map(async path=>({path,html:await read(path)})));
  const entries=pages.flatMap(({path,html})=>[...html.matchAll(/<script\b[^>]*\btype=["']module["'][^>]*\bsrc=["']([^"']+)["'][^>]*>/gi)]
    .map(match=>localModule(path,match[1])).filter(Boolean));
  assert.ok(entries.length,'index.html must load a local module entry point');

  const pending=[...entries];
  const visited=new Set();
  while(pending.length){
    const module=pending.pop();
    if(visited.has(module))continue;
    visited.add(module);
    assert.ok(installed.has(module),`${module} is loaded by the browser but missing from deploy app_files`);
    const source=await read(module);
    for(const specifier of imports(source)){
      const dependency=localModule(module,specifier);
      if(dependency&&!visited.has(dependency))pending.push(dependency);
    }
  }

  const server=await read('server.mjs');
  const served=new Map([...server.matchAll(/\[['"]([^'"]+)['"],['"]([^'"]+)['"]\]/g)]
    .map(match=>[match[1],match[2]]));
  for(const module of visited){
    assert.equal(served.get('/'+module),module,`${module} is installed but not served as a browser asset`);
  }
  for(const {path,html} of pages){
    assert.ok(installed.has(path),`${path} is missing from deploy app_files`);
    assert.equal(served.get(path==='index.html'?'/':'/'+path),path,`${path} is installed but not served`);
    for(const match of html.matchAll(/<link\b[^>]*\brel=["']stylesheet["'][^>]*\bhref=["']([^"']+)["']/gi)){
      const stylesheet=localModule(path,match[1]);
      if(!stylesheet)continue;
      assert.ok(installed.has(stylesheet),`${stylesheet} is loaded by the browser but missing from deploy app_files`);
      assert.equal(served.get('/'+stylesheet),stylesheet,`${stylesheet} is installed but not served`);
    }
  }

  assert.deepEqual([...visited].sort(),[
    'aircraft-appearance.mjs','aircraft-card.mjs','aircraft-screen.mjs','aircraft-selection.mjs','app.js','cb-panel.mjs',
    'detached-panel.mjs','detached-panels.mjs','detail-fields.mjs','local-setup.mjs','message-help.mjs',
    'signal-meter.mjs','sources.mjs','tower-map.mjs',
  ]);
});


test('Debian deployment includes the complete receiver server module graph',async()=>{
  const installer=await read('deploy/install-debian.sh');
  const declaration=installer.match(/\bapp_files=\(([\s\S]*?)\)/);
  const installed=new Set(declaration[1].trim().split(/\s+/).filter(Boolean));
  const pending=['server.mjs'];
  const visited=new Set();
  while(pending.length){
    const module=pending.pop();
    if(visited.has(module))continue;
    visited.add(module);
    assert.ok(installed.has(module),`${module} is required by the receiver server but missing from deploy app_files`);
    for(const specifier of imports(await read(module))){
      const dependency=localModule(module,specifier);
      if(dependency&&!visited.has(dependency))pending.push(dependency);
    }
  }
  assert.ok(visited.has('aircraft-info.mjs'),'aircraft metadata lookup must ship with the server');
});
