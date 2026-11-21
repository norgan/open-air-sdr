# Open Air on Debian 13

Use the Debian 13 LXC template in an unprivileged Proxmox container. The RTL-SDR is the only USB device it needs. Run the build and install commands inside the dedicated container.

## Receiver check

On the Proxmox host, use `lsusb` and `lsusb -t` to identify the SDR. Pass that specific node through with `pct set <CTID> --dev0 path=/dev/bus/usb/001/002,gid=46,mode=0660`, substituting the actual bus and device numbers. The device number may change after the dongle is unplugged. Debian's `plugdev` group is GID 46 in this deployment.

Inside the container, test with `lsusb -d 0bda:2832` and `timeout 8 rtl_test`. A timeout is expected while samples are flowing. If opening the receiver reports that it is busy and the host shows `dvb_usb_rtl28xxu` bound to the tuner on port `1-2`, unbind that interface on the Proxmox host with `printf '%s' '1-2:1.0' > /sys/bus/usb/drivers/dvb_usb_rtl28xxu/unbind` and retry.

## Install

Copy this source directory into the container, preserving `deploy`. Pass the exact origin the browser uses, including its scheme. With Nginx Proxy Manager terminating HTTPS, use the HTTPS hostname served by that proxy. In the container, run:

```bash
bash deploy/install-debian.sh https://open-air.example.com
bash deploy/configure-access.sh
```

The first run builds SDRangel 8.1.0 and libacars 2.2.1 on Debian. It then configures systemd, a virtual audio sink and the container’s Open Air virtual host. Build output is under `/var/lib/open-air/src`. The installer derives nginx’s `server_name` from the browser origin. SDRangel control, FFT streaming and PCM input bind to loopback.

An HTTPS origin requires Open Air browser credentials. The access script prompts for them and provides a distinct Home Assistant API token. The health endpoint is available while credentials are being configured.

Add your proxy’s private IP as an `allow` entry before `deny all` in `/etc/nginx/conf.d/open-air.conf`. Apply it with `nginx -t && systemctl reload nginx`. In Nginx Proxy Manager, forward the published hostname to the container over HTTP port 80. Preserve the original Host and authorization headers and disable response buffering. For a DNS-based upstream, use a LAN record such as `open-air.home.arpa` and verify it resolves from NPM. [Nginx Proxy Manager guide](https://nginxproxymanager.com/guide/)

To update an installed instance or move it to a different browser hostname, extract the release and run the same installer with the intended origin. It updates the origin and nginx virtual host together, reuses the installed SDRangel binary and restarts Open Air. If an older build stopped on `QtGui/private/qzipreader_p.h`, install `qtbase5-private-dev` in the container and rerun the installer. Ninja reuses the completed objects. [Debian package files](https://packages.debian.org/trixie/amd64/qtbase5-private-dev/filelist)

Bootstrap gives SDRangel 8.1 time to complete its asynchronous RTL-SDR device selection before reading it back.

The installer retries its proxied health check while nginx reloads. Open Air configures local PCM forwarding when browser playback starts. This applies the audio settings after the selected decoder has opened SDRangel's audio output.

## Verify

```bash
systemctl status open-air sdrangelsrv open-air-pulse --no-pager
journalctl -u sdrangelsrv -u open-air -n 60 --no-pager
curl -fsS http://127.0.0.1:8877/api/health
```

In **Signals**, choose an FM station and click **Listen**. In **Receiver**, confirm the frequency, resize the waterfall and sweep a short frequency range. In **Tower**, check that AM audio and the network aircraft positions update together. Start the ATC scan and confirm it holds on a transmission before moving on. In **UHF CB**, step between channels and start a scan. Choose a known channel to stop the scan. Select ADS-B in **Signals** to check your antenna’s position reports. Switch away from ACARS and confirm its entries remain in **Messages**.

The server writes your area profile and decoded message history under the `openair` user’s `open-air-data` directory. Set `OPEN_AIR_ADSB_LOL_API_KEY` in `/etc/open-air.env` if you have an adsb.lol key, then restart `open-air.service`. The server only polls for network aircraft while a Tower view is open. [adsb.lol API limits](https://www.adsb.lol/docs/open-data/api)
