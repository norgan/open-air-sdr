#!/usr/bin/env bash
set -euo pipefail

if [[ $(id -u) != 0 || ! -f /opt/open-air/server.mjs ]]; then
  echo 'Run as root inside the existing Open Air container.' >&2
  exit 1
fi
package=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
test -s "$package/FILES"
mapfile -t files <"$package/FILES"
for file in "${files[@]}"; do
  if [[ ! $file =~ ^[a-zA-Z0-9][-a-zA-Z0-9.]*\.(mjs|js|css|html)$ || ! -f $package/$file ]]; then
    echo 'The display package contains an invalid or missing runtime file.' >&2
    exit 1
  fi
done
(cd "$package" && sha256sum -c SHA256SUMS)
for file in "${files[@]}"; do
  if [[ $file == *.mjs || $file == *.js ]]; then
    node --input-type=module --check <"$package/$file"
  fi
done

backup=$(mktemp -d /opt/open-air/display-backup.XXXXXX)
for file in "${files[@]}"; do
  if [[ -f /opt/open-air/$file ]]; then
    cp -p -- "/opt/open-air/$file" "$backup/$file"
  else
    touch "$backup/$file.missing"
  fi
done
rollback() {
  status=$?
  trap - EXIT
  echo 'Update failed; restoring the previous web files.' >&2
  for file in "${files[@]}"; do
    if [[ -f $backup/$file.missing ]]; then
      rm -f -- "/opt/open-air/$file"
    else
      cp -p -- "$backup/$file" "/opt/open-air/$file"
    fi
  done
  systemctl restart open-air.service || true
  exit "$status"
}
trap rollback EXIT
systemctl stop open-air.service
for file in "${files[@]}"; do
  install -m 0644 "$package/$file" "/opt/open-air/$file"
done
systemctl start open-air.service
curl --fail --silent --show-error --retry 10 --retry-connrefused --retry-delay 1 http://127.0.0.1:8877/api/health
printf '\n'
curl --fail --silent --show-error http://127.0.0.1:8877/aircraft-appearance.mjs >/dev/null
curl --fail --silent --show-error http://127.0.0.1:8877/detached-panel.html >/dev/null
trap - EXIT
printf 'Aircraft display update installed. Previous files: %s\n' "$backup"

