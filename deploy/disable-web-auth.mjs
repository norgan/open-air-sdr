import { constants } from 'node:fs';
import { copyFile, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const run = promisify(execFile);
const legacyGuard = /else if\(publicOrigin\?\.protocol==='https:'&&!access\.webEnabled\)\{\r?\n\s*return send\(res,503,\{error:'Configure browser sign-in on the Open Air receiver to use this HTTPS address\.'\}\);\r?\n\s*\}/;

export async function disableBrowserAuth({ appFile='/opt/open-air/server.mjs', envFile='/etc/open-air.env' }={}) {
  const [app, env] = await Promise.all([readFile(appFile,'utf8'),readFile(envFile,'utf8')]);
  const updatedApp = app.replace(legacyGuard,'');
  if (updatedApp.includes("publicOrigin?.protocol==='https:'&&!access.webEnabled")) {
    throw Error('Unrecognised HTTPS sign-in guard. No files were changed.');
  }
  const updatedEnv = env.split(/\r?\n/).filter(line=>!/^\s*OPEN_AIR_WEB_(?:USER|PASSWORD)\s*=/.test(line)).join('\n');
  const changes = [{file:appFile,before:app,after:updatedApp,script:true},{file:envFile,before:env,after:updatedEnv}]
    .filter(change=>change.before!==change.after);
  const staged = [];
  try {
    for (const change of changes) {
      const mode = (await stat(change.file)).mode & 0o777;
      const temporary = change.file+'.'+randomBytes(8).toString('hex')+(change.script?'.mjs':'.tmp');
      staged.push({...change,temporary});
      await writeFile(temporary,change.after,{mode,flag:'wx'});
      if (change.script) await run(process.execPath,['--check',temporary]);
    }
    for (const change of staged) {
      await copyFile(change.file,change.file+'.before-web-auth-removal',constants.COPYFILE_EXCL)
        .catch(error=>{if(error.code!=='EEXIST')throw error;});
    }
    for (const change of staged) await rename(change.temporary,change.file);
    return {changed:changes.length>0};
  } finally {
    for (const change of staged) await unlink(change.temporary).catch(error=>{if(error.code!=='ENOENT')throw error;});
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href===import.meta.url) {
  await disableBrowserAuth();
  console.log('Browser sign-in disabled. Restart open-air.service to apply.');
}
