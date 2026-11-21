const segmentPoints = [
  '12,4 42,4 47,9 42,14 12,14 7,9',
  '44,16 49,11 54,16 54,40 49,45 44,40',
  '44,50 49,45 54,50 54,74 49,79 44,74',
  '12,76 42,76 47,81 42,86 12,86 7,81',
  '0,50 5,45 10,50 10,74 5,79 0,74',
  '0,16 5,11 10,16 10,40 5,45 0,40',
  '12,40 42,40 47,45 42,50 12,50 7,45'
];

const digits = [0x3f, 0x06, 0x5b, 0x4f, 0x66, 0x6d, 0x7d, 0x07, 0x7f, 0x6f];
const numberMarkup = [0, 1].map(index => '<g transform="translate(' + index * 65 + ' 0)">' +
  segmentPoints.map(points => '<polygon points="' + points + '"/>').join('') + '</g>').join('');
const squelch = {min:-100, max:0, initial:-62};

export function createCbPanel(container, {channels, onChannel, onScanChange, onSquelchChange}) {
  const channelOrder = [...channels].sort((a, b) => a.number - b.number);
  const channelPositions = new Map(channelOrder.map(({id}, index) => [id, index]));

  container.classList.add('cb-panel');
  container.innerHTML = `
    <div class="cb-speaker" aria-hidden="true"><span></span></div>
    <div class="cb-face">
      <h2 id="cb-panel-title">Australian UHF CB</h2>
      <div class="cb-display">
        <div class="cb-readout">
          <span>CHANNEL</span>
          <svg class="cb-number" viewBox="0 0 119 90" aria-hidden="true">${numberMarkup}</svg>
          <span class="cb-channel-text"></span>
        </div>
        <div class="cb-display-details">
          <span class="cb-status"><i aria-hidden="true"></i><span></span></span>
          <span class="cb-scan-status" role="status"></span>
          <span class="cb-frequency"></span>
        </div>
      </div>
    </div>
    <div class="cb-controls">
      <label for="cb-channel-select">Channel selector</label>
      <div class="cb-buttons">
        <button type="button" aria-label="Previous CB channel"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 9 7 7 7-7"/></svg></button>
        <button type="button" aria-label="Next CB channel"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 15 7-7 7 7"/></svg></button>
      </div>
      <select id="cb-channel-select"></select>
      <button class="cb-scan-button" type="button" hidden>Scan</button>
      <div class="cb-squelch" hidden>
        <div class="cb-squelch-head">
          <label for="cb-squelch-level">Squelch</label>
          <span class="cb-squelch-value" aria-hidden="true">${squelch.initial} dB</span>
        </div>
        <input id="cb-squelch-level" type="range" min="${squelch.min}" max="${squelch.max}" step="1" value="${squelch.initial}">
      </div>
    </div>`;
  container.setAttribute('aria-labelledby', 'cb-panel-title');

  const segments = container.querySelectorAll('.cb-number polygon');
  const channelText = container.querySelector('.cb-channel-text');
  const frequency = container.querySelector('.cb-frequency');
  const status = container.querySelector('.cb-status');
  const statusText = status.lastElementChild;
  const scanStatus = container.querySelector('.cb-scan-status');
  const channelSelect = container.querySelector('select');
  const [previous, next, scanButton] = container.querySelectorAll('button');
  const squelchControl = container.querySelector('.cb-squelch');
  const squelchSlider = container.querySelector('#cb-squelch-level');
  const squelchValue = container.querySelector('.cb-squelch-value');
  let current = -1;
  let scanning = false;
  let confirmedSquelch = squelch.initial;
  let squelchPending = false;
  let squelchPointer = null;

  for (const channel of channelOrder) {
    const option = document.createElement('option');
    option.value = channel.id;
    option.textContent = 'CH ' + String(channel.number).padStart(2, '0');
    channelSelect.append(option);
  }

  function switchChannel(id) {
    if (channelPositions.has(id) && (scanning || id !== channelOrder[current]?.id)) onChannel(id);
  }

  previous.addEventListener('click', () => switchChannel(channelOrder[current - 1]?.id));
  next.addEventListener('click', () => switchChannel(channelOrder[current + 1]?.id));
  channelSelect.addEventListener('change', () => {
    const requested = channelSelect.value;
    channelSelect.value = channelOrder[current]?.id || '';
    switchChannel(requested);
  });
  scanButton.addEventListener('click', () => onScanChange?.(!scanning));

  function showSquelch() {
    const label = squelchSlider.value + ' dB';
    squelchValue.textContent = label;
    squelchSlider.setAttribute('aria-valuetext', label);
  }

  function showConfirmedSquelch() {
    squelchSlider.value = String(confirmedSquelch);
    showSquelch();
  }

  squelchSlider.addEventListener('input', showSquelch);
  squelchSlider.addEventListener('change', () => onSquelchChange?.(squelchSlider.valueAsNumber));
  squelchSlider.addEventListener('pointerdown', event => { squelchPointer = event.pointerId; });
  for (const eventName of ['pointerup', 'pointercancel']) {
    document.addEventListener(eventName, event => {
      if (event.pointerId === squelchPointer) squelchPointer = null;
    });
  }
  squelchSlider.addEventListener('blur', () => {
    if (squelchPointer === null && !squelchPending) showConfirmedSquelch();
  });

  return function renderCb(state) {
    const index = channelPositions.get(state.source);
    if (index === undefined) return;

    const channel = channelOrder[index];
    if (index !== current) {
      const displayNumber = String(channel.number).padStart(2, '0');
      const masks = Array.from(displayNumber, digit => digits[Number(digit)]);
      segments.forEach((segment, offset) => {
        const mask = masks[Math.floor(offset / 7)];
        segment.classList.toggle('lit', Boolean(mask & (1 << (offset % 7))));
      });
      channelText.textContent = displayNumber;
      current = index;
    }

    const scanState = state.demo ? 'idle' : state.scan?.status;
    scanning = scanState === 'scanning' || scanState === 'holding';
    if (!scanning || document.activeElement !== channelSelect) channelSelect.value = channel.id;
    channelSelect.disabled = Boolean(state.busy);
    previous.disabled = Boolean(state.busy || index === 0);
    next.disabled = Boolean(state.busy || index === channelOrder.length - 1);
    const live = Boolean(state.connected && state.running && !state.demo);
    const confirmed = state.frequency === channel.frequency;
    const receiving = live && confirmed && !state.busy && state.squelch === true;
    status.dataset.receiving = String(receiving);
    statusText.textContent = state.demo ? 'SAMPLE' : state.busy ? 'TUNING' : !live ? 'OFFLINE' :
      !confirmed ? 'NOT TUNED' : receiving ? 'RX OPEN' : state.squelch === false ? 'SQUELCH' : 'RECEIVE';
    frequency.textContent = (channel.frequency / 1e6).toFixed(4) + ' MHz';

    scanButton.hidden = state.demo || typeof onScanChange !== 'function';
    scanButton.disabled = Boolean(state.scanPending || state.busy);
    scanButton.dataset.active = String(scanning);
    scanButton.textContent = state.scanPending ? (scanning ? 'Stopping…' : 'Starting…') : scanning ? 'Stop scan' : 'Scan';
    scanStatus.dataset.state = scanState || 'idle';
    const scanLabel = {scanning:'Scanning', holding:'Holding', error:'Scan error'}[scanState] || '';
    if (scanStatus.textContent !== scanLabel) scanStatus.textContent = scanLabel;

    const level = state.squelchLevel;
    if (Number.isInteger(level) && level >= squelch.min && level <= squelch.max) confirmedSquelch = level;
    squelchPending = Boolean(state.squelchPending);
    squelchControl.hidden = state.demo || typeof onSquelchChange !== 'function';
    squelchSlider.disabled = squelchPending || Boolean(state.busy);
    if (!squelchPending && squelchPointer === null && document.activeElement !== squelchSlider) showConfirmedSquelch();
  };
}
