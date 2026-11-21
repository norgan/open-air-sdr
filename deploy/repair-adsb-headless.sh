#!/usr/bin/env bash
set -euo pipefail

if [[ $(id -u) != 0 || $# != 0 ]]; then
  echo 'Usage inside the Open Air Debian 13 container: bash repair-adsb-headless.sh' >&2
  exit 1
fi

. /etc/os-release
if [[ $ID != debian || $VERSION_ID != 13 ]] || ! systemd-detect-virt --container >/dev/null; then
  echo 'This repair is for the Open Air Debian 13 container.' >&2
  exit 1
fi

for command in node git cmake runuser systemctl curl ldd sha256sum; do
  command -v "$command" >/dev/null || {
    printf 'Required command is missing: %s\n' "$command" >&2
    exit 1
  }
done
getent passwd openair >/dev/null || {
  echo 'The Open Air service account is missing.' >&2
  exit 1
}

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
patch_script="$script_dir/patch-adsb-headless.mjs"
source_root=/var/lib/open-air/src/sdrangel
build_root=/var/lib/open-air/src/sdrangel-build
target=demodadsbsrv
artifact="$build_root/lib/pluginssrv/libdemodadsbsrv.so"
install_script="$build_root/pluginssrv/channelrx/demodadsb/cmake_install.cmake"
installed=/opt/sdrangel/lib/sdrangel/pluginssrv/libdemodadsbsrv.so
expected_commit=fb246280891bbfb3d809e47ab32bc22cb9669afb

test -r "$patch_script" || {
  echo 'Place patch-adsb-headless.mjs beside this repair script.' >&2
  exit 1
}
test -d "$source_root/.git" || {
  echo "The cached SDRangel source tree is missing: $source_root" >&2
  exit 1
}
test -f "$build_root/CMakeCache.txt" || {
  echo "The cached SDRangel build tree is missing: $build_root" >&2
  exit 1
}

actual_commit=$(runuser -u openair -- git -C "$source_root" rev-parse HEAD)
if [[ $actual_commit != "$expected_commit" ]]; then
  printf 'Refusing to patch SDRangel commit %s. Expected v8.1.0 commit %s.\n' \
    "$actual_commit" "$expected_commit" >&2
  exit 1
fi

cache="$build_root/CMakeCache.txt"
for setting in \
  "CMAKE_HOME_DIRECTORY:INTERNAL=$source_root" \
  'CMAKE_INSTALL_PREFIX:PATH=/opt/sdrangel' \
  'CMAKE_BUILD_TYPE:STRING=Release' \
  'BUILD_SERVER:BOOL=ON' \
  'BUILD_GUI:BOOL=OFF' \
  'ENABLE_CHANNELRX_DEMODADSB:BOOL=ON'; do
  if ! grep -Fqx "$setting" "$cache"; then
    printf 'The cached SDRangel build does not contain the required setting: %s\n' "$setting" >&2
    exit 1
  fi
done

test -f "$install_script" || {
  echo 'The ADS-B plugin-only CMake install script is missing.' >&2
  exit 1
}
test -f "$installed" || {
  echo 'The installed SDRangel ADS-B server plugin is missing.' >&2
  exit 1
}

# The source and build trees belong to the unprivileged build account. The
# patcher preserves the source mode and keeps the unmodified source beside it.
cached_patch=/var/lib/open-air/src/patch-adsb-headless.mjs
install -m 0644 -o openair -g "$(id -gn openair)" "$patch_script" "$cached_patch"
runuser -u openair -- node "$cached_patch" "$source_root"

# Keep the running receiver on the old plugin while the replacement compiles.
runuser -u openair -- \
  cmake --build "$build_root" --target "$target" --parallel 2
test -s "$artifact" || {
  echo 'The ADS-B plugin build completed without producing its shared library.' >&2
  exit 1
}

backup_dir=/opt/sdrangel/.rollback
install -d -m 0700 -o root -g root "$backup_dir"
binary_backup="$backup_dir/libdemodadsbsrv.so.$(date -u +%Y%m%dT%H%M%SZ)"
cp -a -- "$installed" "$binary_backup"

rollback() {
  local status=$?
  (( status != 0 )) || status=1
  trap - ERR INT TERM
  echo 'ADS-B repair failed. Restoring the previous plugin.' >&2
  systemctl stop sdrangelsrv.service >/dev/null 2>&1 || true
  cp -a -- "$binary_backup" "$installed"
  systemctl start sdrangelsrv.service open-air.service || true
  printf 'Previous plugin restored from %s\n' "$binary_backup" >&2
  exit "$status"
}
trap rollback ERR INT TERM

# Stopping SDRangel also stops Open Air through the service PartOf relationship.
# Running this directory-level install script installs only demodadsbsrv and lets
# CMake apply the configured install RPATH.
systemctl stop sdrangelsrv.service
cmake \
  -DCMAKE_INSTALL_PREFIX=/opt/sdrangel \
  -DCMAKE_INSTALL_CONFIG_NAME=Release \
  -P "$install_script"

test -s "$installed"
dependencies=$(ldd "$installed")
if grep -q 'not found' <<<"$dependencies"; then
  echo 'The rebuilt ADS-B plugin has an unresolved shared-library dependency.' >&2
  false
fi

systemctl start sdrangelsrv.service open-air.service
for service in sdrangelsrv.service open-air.service; do
  systemctl is-active --quiet "$service"
done
curl --fail --silent --show-error \
  --retry 10 --retry-delay 1 --retry-all-errors \
  http://127.0.0.1:8877/api/health
printf '\n'

trap - ERR INT TERM
sha256sum "$binary_backup" "$installed"
printf 'ADS-B headless repair installed. Rollback copy: %s\n' "$binary_backup"
