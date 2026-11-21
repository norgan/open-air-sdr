# Open Air SDR

Open Air runs an RTL-SDR receiver through headless SDRangel. From your browser you can tune signals, listen, inspect the live waterfall, switch between the last two channels, and scan a frequency range or Australian UHF CB channels. The Home Assistant integration connects to the same server for receiver controls and automations.

**Tower** brings AM airband audio and live aircraft positions together. Select a channel or scan the area's AM airband presets. The scan holds on open squelch, then resumes after 1.5 seconds of silence. Switch between **Map** and **Radar** while listening. The receiver handles audio and adsb.lol supplies the positions independently. Open an aircraft row for its ICAO address, type, position, altitude, speed and other available fields. The map uses OpenStreetMap. [Aircraft data and API limits](https://www.adsb.lol/docs/open-data/api) · [Map attribution](https://www.openstreetmap.org/copyright)

One tuner cannot stay on airband voice and 1090 MHz simultaneously. Tower uses network positions for that reason. Receiving both ATC and ADS-B locally at the same time requires a second receiver.

**Messages** keeps the latest 500 decoded ACARS and VDL Mode 2 messages on your receiver server. Open a message to inspect its metadata, complete decoded payload, raw frame and **Meaning** notes for recognised labels, positions, airport codes and system identifiers. [ACARS application formats](https://github.com/szpajder/libacars/blob/master/doc/PROG_GUIDE.md) · [Message labels](https://github.com/brmlab/acarsdec/blob/master/datasets/acars_mls.txt)

In **Receiver**, drag the lower edge of the waterfall or focus the handle and use the arrow keys to resize it. The browser remembers the height.

## Install the receiver server

Use an unprivileged Debian 13 LXC container with an RTL-SDR USB dongle and an antenna. On Proxmox, identify the dongle with `lsusb`. Pass through its USB node with group `46` and mode `0660`. Set the container ID and USB path for your own deployment on the Proxmox host.

```bash
read -r -p 'Container ID: ' CTID
read -r -p 'USB device path from lsusb: ' USB_NODE
pct set "$CTID" --dev0 "path=$USB_NODE,gid=46,mode=0660"
```

If the dongle is unplugged and assigned a new USB device number, update the passthrough path. To test the dongle outside SDRangel, run `systemctl stop open-air sdrangelsrv` in the container, run `timeout 8 rtl_test`, then run `systemctl start open-air` to resume reception. A timeout is expected when sample reads continue normally.

Copy or clone this repository into the container. Run these commands as root from the repository directory. Substitute the exact HTTPS origin you will use in the browser, with no path.

```bash
bash deploy/install-debian.sh https://open-air.example.com
```

The first install builds SDRangel and libacars and enables Open Air at boot. Browser sign-in is optional, including over HTTPS. To opt in, run `bash deploy/configure-access.sh`; it configures browser credentials and issues a separate Home Assistant token. Settings live in `/etc/open-air.env`.

To remove browser sign-in from an existing installation, run `node deploy/disable-web-auth.mjs` as root, then `systemctl restart open-air.service`. The command backs up the affected files, removes the saved browser credentials and migrates the older mandatory HTTPS sign-in check. An existing Home Assistant token is preserved.

## Publish through your reverse proxy

In the container's `/etc/nginx/conf.d/open-air.conf`, add an `allow` line for the private address or CIDR of your reverse proxy above `deny all`. Apply the change with `nginx -t && systemctl reload nginx`.

Create an HTTPS proxy host in Nginx Proxy Manager pointing to the container's private hostname on port `80` over HTTP. Preserve the browser's `Host` header and pass through `Authorization` and `X-Open-Air-Token` when those optional access methods are configured. Disable response buffering for the Open Air proxy host so the live waterfall and audio stream promptly. Keep the proxy-to-container hop private. A proxy login is also optional. [Nginx Proxy Manager guide](https://nginxproxymanager.com/guide/)

Open your HTTPS hostname. In **Receiver**, tune a known local FM station, enable the speaker, and check that the waterfall updates. For service diagnostics, run the following inside the container.

```bash
systemctl status open-air sdrangelsrv open-air-pulse --no-pager
journalctl -u open-air -u sdrangelsrv -n 60 --no-pager
```

## Set up your area and rescan

1. Open **Setup** and enter your **Area name**. Regional presets are off by default. Enable **Include Sydney example presets** only if that catalogue suits your receiver.
2. Set **From (MHz)** and **To (MHz)** to a short section of a band your antenna and tuner cover. Start with **Above noise (dB)** at 12. Choose **Save setup** to keep the area and scan settings on the server.
3. Click **Rescan** and watch **Detected peaks**. Choose **Use peak** to fill the preset editor. Select a mode and choose **Tune** to inspect the signal.
4. Add confirmed frequencies under **Local presets** with a name and mode. They appear in **Signals** and become available to Home Assistant. Edit or remove them in **Setup** as your local reception changes.

If a short scan misses a known station, check its signal on the waterfall, then try a lower threshold or move the antenna and rescan. Repeat with another band to build out the catalogue. One physical tuner is shared across clients. A scan retunes that receiver, and manual tuning stops the active scan.

For file-based provisioning, copy [the area profile example](examples/local-profile.json), edit it for your own region, and point `OPEN_AIR_PROFILE_FILE` to the copy in the receiver environment. Keep deployed profiles and access credentials local to the installation.

Set **Tower map centre** in **Setup** to a nearby airport or city. The receiver server sends that centre to adsb.lol when the view is open. You can set `OPEN_AIR_ADSB_LOL_API_KEY` in `/etc/open-air.env` to use your own provider quota. To see what your antenna receives at 1090 MHz, select **ADS-B** in **Signals**. Open Air offsets the tuner centre by 100 kHz while the decoder stays at 1090 MHz. This moves the decoder off the tuner's centre spur. The ADS-B filter is 2 MHz at 2.4 MS/s. Positionless tracks are shown as **NO POSITION** while the decoder waits for enough valid frames to calculate coordinates. Reliable local range still depends on a 1090 MHz-capable tuner, antenna, feedline and line of sight.

## Home Assistant

1. Copy `home-assistant/custom_components/open_air` from this repository into the Home Assistant configuration directory as `/config/custom_components/open_air`.
2. Restart Home Assistant. Go to **Settings → Devices & services → Add integration** and search for **Open Air**.
3. Enter the Open Air HTTPS origin and the token issued by `deploy/configure-access.sh`. If an additional upstream proxy requires Basic credentials, enter that proxy's credentials in the optional fields. Open Air's browser password is separate from the integration's token.
4. Open the Open Air device to find receiver status, presets, and scan controls for dashboards and automations. Use the browser for the live waterfall, audio, and editing your area or presets.

The integration uses the local-area catalogue and shares the same tuner as the browser. Its switches control Tower, UHF CB and the saved range scan. [Home Assistant integrations](https://www.home-assistant.io/docs/apps-and-integrations/)

## Windows

Install Node.js 22 or later. Run SDRangel with the RTL-SDR and its MCP Server feature on `127.0.0.1:8092`. From the Open Air source folder, use `node server.mjs --open`. SDRangel supplies local audio. Run `node --test` from the same folder to exercise the app without a receiver.

## Update

Get the new release, then rerun `bash deploy/install-debian.sh https://open-air.example.com` using your existing origin. Update the `open_air` component folder separately and restart Home Assistant.

## Licence

Open Air is released under the [MIT licence](LICENSE). SDRangel and libacars are separately installed dependencies with their own licences.

