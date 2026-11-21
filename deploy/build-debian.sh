#!/usr/bin/env bash
set -euo pipefail

if [[ $(id -u) != 0 ]]; then
  echo 'Run inside the dedicated Debian 13 container as root.' >&2
  exit 1
fi
. /etc/os-release
if [[ $ID != debian || $VERSION_ID != 13 ]] || ! systemd-detect-virt --container >/dev/null; then
  echo 'This build script is for the Debian 13 container.' >&2
  exit 1
fi

apt-get update
apt-get install -y --no-install-recommends \
  ca-certificates curl git build-essential cmake ninja-build pkgconf xxd \
  qtbase5-dev qtbase5-private-dev qttools5-dev qtmultimedia5-dev libqt5multimedia5-plugins \
  libqt5websockets5-dev libqt5serialport5-dev qtpositioning5-dev libqt5charts5-dev \
  libboost-dev libfftw3-dev libusb-1.0-0-dev librtlsdr-dev libopus-dev zlib1g-dev \
  libasound2-dev libfaad-dev libflac-dev libxml2-dev libunwind-dev \
  nodejs node-ws ffmpeg nginx pulseaudio pulseaudio-utils rtl-sdr usbutils

if ! id openair >/dev/null 2>&1; then
  useradd --system --user-group --create-home --home-dir /var/lib/open-air --shell /usr/sbin/nologin openair
fi
getent group plugdev >/dev/null || groupadd --gid 46 plugdev
usermod -aG plugdev openair
build_root=/var/lib/open-air/src
install -d -o openair -g "$(id -gn openair)" "$build_root"
cd "$build_root"
run_build() { runuser -u openair -- "$@"; }

if [[ ! -d $build_root/libacars/.git ]]; then
  run_build git clone --branch v2.2.1 --depth 1 https://github.com/szpajder/libacars.git "$build_root/libacars"
fi
run_build cmake -S "$build_root/libacars" -B "$build_root/libacars-build" -G Ninja \
  -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=/opt/open-air-deps -DCMAKE_INSTALL_LIBDIR=lib
run_build cmake --build "$build_root/libacars-build" --parallel 2
cmake --install "$build_root/libacars-build"

if [[ ! -d $build_root/sdrangel/.git ]]; then
  run_build git clone --branch v8.1.0 --depth 1 https://github.com/f4exb/sdrangel.git "$build_root/sdrangel"
fi
patch_script=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/patch-adsb-headless.mjs
install -m 0644 -o openair -g "$(id -gn openair)" "$patch_script" "$build_root/patch-adsb-headless.mjs"
run_build node "$build_root/patch-adsb-headless.mjs" "$build_root/sdrangel"
flags=()
while IFS= read -r option; do
  case "$option" in
    ENABLE_CHANNELRX_DEMODACARS|ENABLE_CHANNELRX_DEMODADSB|ENABLE_CHANNELRX_DEMODAM|ENABLE_CHANNELRX_DEMODNFM|ENABLE_CHANNELRX_DEMODBFM|ENABLE_CHANNELRX_DEMODAIS|ENABLE_CHANNELRX_DEMODRADIOSONDE|ENABLE_CHANNELRX_DEMODPACKET|ENABLE_CHANNELRX_FILESINK|ENABLE_CHANNELRX_FREQSCANNER|ENABLE_FEATURE_MCPSERVER) ;;
    *) flags+=("-D$option=OFF");;
  esac
done < <(sed -nE 's/^option\((ENABLE_(CHANNELRX|FEATURE)_[A-Z0-9_.]+) .*/\1/p' "$build_root/sdrangel/CMakeLists.txt")
run_build cmake -S "$build_root/sdrangel" -B "$build_root/sdrangel-build" -G Ninja \
  -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=/opt/sdrangel \
  -DCMAKE_INSTALL_RPATH_USE_LINK_PATH=ON -DLIBACARS_DIR=/opt/open-air-deps \
  -DENABLE_EXTERNAL_LIBRARIES=OFF -DENABLE_QT6=OFF \
  -DBUILD_GUI=OFF -DBUILD_SERVER=ON -DBUILD_BENCH=OFF -DBUILD_MCP_BRIDGE=OFF -DBUILD_MCP_BUNDLE=OFF \
  -DENABLE_RTLSDR=ON -DENABLE_CHANNELTX=OFF -DENABLE_CHANNELMIMO=OFF \
  -DENABLE_AIRSPY=OFF -DENABLE_AIRSPYHF=OFF -DENABLE_SDRPLAY=OFF -DENABLE_LIMESUITE=OFF \
  -DENABLE_USRP=OFF -DENABLE_HACKRF=OFF -DENABLE_BLADERF=OFF -DENABLE_IIO=OFF \
  -DENABLE_SOAPYSDR=OFF -DENABLE_XTRX=OFF -DENABLE_FOBOS=OFF -DENABLE_FUNCUBE=OFF \
  "${flags[@]}"
run_build cmake --build "$build_root/sdrangel-build" --parallel 2
cmake --install "$build_root/sdrangel-build"
test -x /opt/sdrangel/bin/sdrangelsrv
for plugin in featuremcpserversrv demodacarssrv demodadsbsrv inputrtlsdrsrv; do
  if ! find /opt/sdrangel -name "lib*${plugin}.so" -print -quit | grep -q .; then
    printf 'Expected SDRangel plugin is missing: %s\n' "$plugin" >&2
    exit 1
  fi
done
node --version

