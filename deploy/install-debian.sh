#!/usr/bin/env bash
set -euo pipefail

if [[ $(id -u) != 0 || $# != 1 ]]; then
  echo 'Usage inside the Open Air Debian 13 container: bash install-debian.sh https://open-air.example.com' >&2
  exit 1
fi

origin=${1%/}
host_pattern='[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?'
if [[ $origin =~ ^$host_pattern$ ]]; then
  origin=http://${origin,,}
fi
origin_pattern="^https?://$host_pattern(:[0-9]{1,5})?\$"
if [[ ! $origin =~ $origin_pattern ]]; then
  echo 'Enter an HTTP or HTTPS origin, such as https://open-air.example.com, without a path or trailing slash.' >&2
  exit 1
fi

app=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
if [[ ! -x /opt/sdrangel/bin/sdrangelsrv ]]; then
  bash "$app/deploy/build-debian.sh"
fi

# Keep the same canonical URL checks as Open Air. Neither parsing nor the local
# proxy check needs DNS for the public hostname.
origin_parts=$(node -e '
  try {
    const input = process.argv[1];
    const url = new URL(input);
    if (url.origin !== input) throw Error();
    console.log(url.hostname);
    console.log(url.host);
  } catch {
    console.error("Use the exact browser origin with a lowercase hostname and omit the default port.");
    process.exitCode = 1;
  }
' -- "$origin")
mapfile -t origin_fields <<<"$origin_parts"
hostname=${origin_fields[0]}
browser_host=${origin_fields[1]}

test "$(getent group plugdev | cut -d: -f3)" = 46
app_files=(access.mjs aircraft-network.mjs app.js cb-panel.css cb-panel.mjs cb-scan.mjs detail-fields.mjs index.html local-profile.mjs local-setup.mjs message-archive.mjs message-help.mjs rf-scan.mjs server.mjs signal-meter.mjs sources.mjs state-file.mjs streams.mjs style.css tower-map.mjs)
deploy_files=(bootstrap.mjs configure-access.sh configure-station.mjs disable-web-auth.mjs patch-adsb-headless.mjs repair-adsb-headless.sh open-air-pulse.service open-air.service pulse.pa sdrangelsrv.service)
for file in "${app_files[@]}" "${deploy_files[@]/#/deploy/}"; do
  if [[ ! -r $app/$file ]]; then
    printf 'The Open Air package is missing %s.\n' "$file" >&2
    exit 1
  fi
done

env_file=/etc/open-air.env
nginx_file=/etc/nginx/conf.d/open-air.conf
env_source=$env_file
nginx_source=$nginx_file
[[ -e $env_file ]] || env_source="$app/deploy/open-air.env.example"
[[ -e $nginx_file ]] || nginx_source="$app/deploy/nginx.conf.example"
if [[ $(grep -Ec '^[[:blank:]]*OPEN_AIR_ORIGIN[[:blank:]]*=' "$env_source") != 1 ||
      $(grep -Ec '^[[:blank:]]*server_name[[:blank:]]' "$nginx_source") != 1 ||
      $(grep -Ec '^[[:blank:]]*server_name[[:blank:]]+[^;#]+;[[:blank:]]*(#.*)?$' "$nginx_source") != 1 ]]; then
  echo 'Expected one OPEN_AIR_ORIGIN assignment and one server_name directive in the Open Air configuration.' >&2
  exit 1
fi

env_stage=''
nginx_stage=''
nginx_backup=''
restore_nginx=false
cleanup() {
  if [[ $restore_nginx == true ]]; then
    if [[ -n $nginx_backup ]]; then
      mv -f -- "$nginx_backup" "$nginx_file"
    else
      rm -f -- "$nginx_file"
    fi
  fi
  rm -f -- "$env_stage" "$nginx_stage" "$nginx_backup"
}
trap cleanup EXIT
env_stage=$(mktemp /etc/.open-air.env.XXXXXX)
nginx_stage=$(mktemp /etc/nginx/conf.d/.open-air.XXXXXX)

stage_mode() {
  if [[ -e $1 ]]; then
    chown --reference="$1" "$2"
    chmod --reference="$1" "$2"
  else
    chmod 0644 "$2"
  fi
}

sed -E "s|^([[:blank:]]*OPEN_AIR_ORIGIN[[:blank:]]*=).*$|\1$origin|" "$env_source" >"$env_stage"
sed -E "s|^([[:blank:]]*server_name[[:blank:]]+)[^;#]+;|\1$hostname;|" "$nginx_source" >"$nginx_stage"
chown root:root "$env_stage"
chmod 0600 "$env_stage"
stage_mode "$nginx_file" "$nginx_stage"
if [[ -e $nginx_file ]]; then
  nginx_backup=$(mktemp /etc/nginx/conf.d/.open-air-backup.XXXXXX)
  cp -p -- "$nginx_file" "$nginx_backup"
fi

mv -f -- "$nginx_stage" "$nginx_file"
restore_nginx=true
nginx -t

install -d /opt/open-air/deploy
if [[ $app != /opt/open-air ]]; then
  for file in "${app_files[@]}"; do
    install -m 0644 "$app/$file" "/opt/open-air/$file"
  done
  install -m 0644 "$app/deploy/"{bootstrap.mjs,configure-access.sh,configure-station.mjs,disable-web-auth.mjs,patch-adsb-headless.mjs,repair-adsb-headless.sh,pulse.pa} /opt/open-air/deploy/
fi
mv -f -- "$env_stage" "$env_file"
restore_nginx=false

install -m 0644 "$app/deploy/"*.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable open-air.service
systemctl restart open-air.service
systemctl enable --now nginx
systemctl reload nginx
curl -fsS http://127.0.0.1:8877/api/health
printf '\n'
# nginx signals the master on reload. Allow the workers serving the new vhost to come up.
if ! curl -fs --retry 5 --retry-delay 1 --retry-all-errors \
  -H "Host: $browser_host" http://127.0.0.1/api/health; then
  printf '\nOpen Air is running locally. Check nginx routing for %s in /etc/nginx/conf.d/open-air.conf.\n' "$browser_host" >&2
  exit 1
fi
printf '\nOpen Air: %s/\n' "$origin"

