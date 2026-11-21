import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export function spectrumRow(buffer, limit = 512) {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 44) return null;
  const data = new DataView(buffer);
  const centre = Number(data.getBigUint64(0, true));
  const time = Number(data.getBigUint64(16, true));
  const bins = data.getUint32(24, true);
  const span = data.getUint32(28, true);
  const flags = data.getUint32(32, true);
  if (!centre || !span || bins < 2 || bins > 65536 || buffer.byteLength !== 36 + bins * 4) return null;
  // Open Air uses the receiver's two-sided spectrum.
  if (flags & 2) return null;
  const columns = Math.min(limit, bins);
  const power = Array.from({length:columns}, (_, column) => {
    let peak = -140;
    const first = Math.floor(column * bins / columns);
    const last = Math.floor((column + 1) * bins / columns);
    for (let index = first; index < last; index++) {
      const value = data.getFloat32(36 + 4 * index, true);
      if (!Number.isFinite(value)) continue;
      const db = flags & 1 ? 10 * Math.log10(value) : value;
      if (db > peak) peak = db;
    }
    return Math.round(peak * 10) / 10;
  });
  return {centre, span, time, power};
}

export function waterfallRelay(port, isTuning) {
  const clients = new Set();
  let socket, retry, lastFrame = 0;

  function connect() {
    if (socket || !clients.size) return;
    const Socket = globalThis.WebSocket || require('ws');
    socket = new Socket('ws://127.0.0.1:' + port);
    socket.binaryType = 'arraybuffer';
    socket.addEventListener('message', event => {
      const now = Date.now();
      if (isTuning() || now - lastFrame < 100) return;
      const row = spectrumRow(event.data);
      if (!row) return;
      lastFrame = now;
      const message = 'data: ' + JSON.stringify(row) + '\n\n';
      for (const client of clients) {
        if (!client.writableNeedDrain) client.write(message);
      }
    });
    socket.addEventListener('close', () => {
      socket = null;
      if (clients.size) retry = setTimeout(connect, 1000);
    });
  }

  return res => {
    if (clients.size >= 8) { res.writeHead(503).end(); return; }
    res.writeHead(200, {
      'Content-Type':'text/event-stream', 'Cache-Control':'no-cache, no-transform', 'X-Accel-Buffering':'no'
    });
    res.write(': connected\n\n');
    clients.add(res);
    const heartbeat = setInterval(() => {
      if (!res.writableNeedDrain) res.write(': heartbeat\n\n');
    }, 15000);
    res.on('close', () => {
      clearInterval(heartbeat);
      clients.delete(res);
      if (!clients.size) {
        clearTimeout(retry);
        socket?.close();
      }
    });
    connect();
  };
}

export async function configureAudioForwarding(port, request = fetch) {
  const result = await request('http://127.0.0.1:8091/sdrangel/audio/output/parameters', {
    method: 'PATCH',
    signal: AbortSignal.timeout(4000),
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      index:-1, sampleRate:48000, copyToUDP:1, udpUsesRTP:0, udpChannelMode:2,
      udpChannelCodec:0, udpDecimationFactor:1, udpAddress:'127.0.0.1', udpPort:port
    })
  });
  if (!result.ok) throw Error('SDRangel audio configuration returned HTTP ' + result.status + '.');
  const settings = await result.json();
  if (settings.copyToUDP !== 1 || settings.udpAddress !== '127.0.0.1' || settings.udpPort !== port) {
    throw Error('SDRangel did not apply local audio forwarding.');
  }
}

export function audioRelay(port, spawnEncoder = spawn) {
  const clients = new Set();
  let encoder;
  let stopping = false;

  function startEncoder() {
    if (encoder || !clients.size) return;
    encoder = spawnEncoder('ffmpeg', [
      '-nostdin', '-loglevel', 'error',
      '-f', 's16le', '-ar', '48000', '-ac', '1', '-probesize', '32', '-analyzeduration', '0',
      '-i', 'udp://127.0.0.1:' + port + '?timeout=20000000',
      '-c:a', 'libmp3lame', '-b:a', '64k', '-write_xing', '0', '-id3v2_version', '0',
      '-flush_packets', '1', '-f', 'mp3', 'pipe:1'
    ], {stdio:['ignore','pipe','inherit'], windowsHide:true});
    encoder.stdout.on('data', chunk => {
      if (stopping) return;
      for (const client of clients) {
        if (client.writableLength > 65536) client.destroy();
        else client.write(chunk);
      }
    });
    encoder.on('error', error => console.error('Open Air audio: ' + error.message));
    encoder.once('close', () => {
      encoder = null;
      if (stopping) {
        stopping = false;
        // Rebind the UDP input only after the departing encoder has closed it.
        startEncoder();
        return;
      }
      const disconnected = [...clients];
      clients.clear();
      for (const client of disconnected) client.end();
    });
  }

  return res => {
    if (clients.size >= 8) { res.writeHead(503).end(); return; }
    res.writeHead(200, {
      'Content-Type':'audio/mpeg', 'Cache-Control':'no-cache, no-transform', 'X-Accel-Buffering':'no'
    });
    res.flushHeaders();
    clients.add(res);
    res.once('close', () => {
      clients.delete(res);
      if (!clients.size && encoder && !stopping) {
        stopping = true;
        encoder.kill();
      }
    });
    startEncoder();
  };
}
