#!/usr/bin/env bash
set -euo pipefail

if [[ $(id -u) != 0 || ! -t 0 || ! -f /etc/open-air.env ]]; then
  echo 'Run this in an interactive root terminal inside the installed Open Air server.' >&2
  exit 1
fi

app=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
read -r -p 'Open Air browser username: ' login
IFS= read -rs -p 'Open Air browser password: ' password
printf '\n'
IFS= read -rs -p 'Repeat the password: ' repeated
printf '\n'
if [[ $password != "$repeated" ]]; then
  echo 'The passwords differ.' >&2
  exit 1
fi

token=$(OPEN_AIR_INPUT_USER="$login" OPEN_AIR_INPUT_PASSWORD="$password" \
  node --input-type=module - /etc/open-air.env "$app/access.mjs" <<'NODE'
import { randomBytes } from 'node:crypto';
import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const [file, accessModule] = process.argv.slice(2);
const {createAccess}=await import(pathToFileURL(accessModule));
const {OPEN_AIR_INPUT_USER:username,OPEN_AIR_INPUT_PASSWORD:password}=process.env;
const existing=await readFile(file,'utf8');
const savedToken=existing.match(/^\s*OPEN_AIR_HA_TOKEN\s*=\s*(?:"([a-zA-Z0-9._~-]+)"|([a-zA-Z0-9._~-]+))\s*$/m);
if(!username || !password)throw Error('Enter a username and password.');
const haToken=savedToken?.[1]??savedToken?.[2]??randomBytes(32).toString('hex');
createAccess({username,password,haToken});
const quoted=value=>'"'+value.replace(/[\\"`$]/g,'\\$&')+'"';
const rest=existing.split(/\r?\n/).filter(line=>!/^\s*OPEN_AIR_(WEB_USER|WEB_PASSWORD|HA_TOKEN)\s*=/.test(line)).join('\n').trimEnd();
const content=`${rest}\nOPEN_AIR_WEB_USER=${quoted(username)}\nOPEN_AIR_WEB_PASSWORD=${quoted(password)}\nOPEN_AIR_HA_TOKEN=${quoted(haToken)}\n`;
const temporary=file+'.'+randomBytes(8).toString('hex');
try {
  await writeFile(temporary,content,{mode:0o600,flag:'wx'});
  await rename(temporary,file);
} finally {
  await unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;});
}
console.log(haToken);
NODE
)
unset login password repeated
systemctl restart open-air.service
printf 'Home Assistant token. Enter it in the Open Air integration setup.\n%s\n' "$token"
