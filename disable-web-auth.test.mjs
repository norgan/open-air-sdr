import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { disableBrowserAuth } from './deploy/disable-web-auth.mjs';

test('disabling browser sign-in repairs the legacy HTTPS guard and preserves HA access and backups',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'open-air-auth-test-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const appFile=join(directory,'server.mjs'),envFile=join(directory,'open-air.env');
  const original=`function check(){if(false){
  }else if(publicOrigin?.protocol==='https:'&&!access.webEnabled){
    return send(res,503,{error:'Configure browser sign-in on the Open Air receiver to use this HTTPS address.'});
  }else if(!access.checkWeb(req.headers)){return false;}}
`;
  const env='OPEN_AIR_ORIGIN=https://radio.example.com\nOPEN_AIR_WEB_USER="test"\nOPEN_AIR_WEB_PASSWORD="test-pass"\nOPEN_AIR_HA_TOKEN="test-ha-token"\n';
  await writeFile(appFile,original,{mode:0o644});
  await writeFile(envFile,env,{mode:0o600});
  assert.deepEqual(await disableBrowserAuth({appFile,envFile}),{changed:true});
  assert.doesNotMatch(await readFile(appFile,'utf8'),/Configure browser sign-in/);
  assert.equal(await readFile(envFile,'utf8'),'OPEN_AIR_ORIGIN=https://radio.example.com\nOPEN_AIR_HA_TOKEN="test-ha-token"\n');
  assert.equal(await readFile(appFile+'.before-web-auth-removal','utf8'),original);
  assert.equal(await readFile(envFile+'.before-web-auth-removal','utf8'),env);
  assert.equal((await stat(envFile)).mode&0o777,0o600);
  assert.deepEqual(await disableBrowserAuth({appFile,envFile}),{changed:false});
});

test('an unrecognised legacy guard leaves both files untouched',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'open-air-auth-test-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const appFile=join(directory,'server.mjs'),envFile=join(directory,'open-air.env');
  const original="if(publicOrigin?.protocol==='https:'&&!access.webEnabled){throw Error('changed');}";
  const env='OPEN_AIR_WEB_USER=test\nOPEN_AIR_WEB_PASSWORD=test-pass\n';
  await writeFile(appFile,original);await writeFile(envFile,env);
  await assert.rejects(disableBrowserAuth({appFile,envFile}),/Unrecognised/);
  assert.equal(await readFile(appFile,'utf8'),original);
  assert.equal(await readFile(envFile,'utf8'),env);
});
