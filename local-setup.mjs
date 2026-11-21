import { formatMHz, receiverModes } from './sources.mjs';

const modeLabels = new Map(receiverModes.map(({id, label}) => [id, label]));
const mhz = frequency => formatMHz(frequency) + ' MHz';
const toHz = input => Math.round(input.valueAsNumber * 1_000_000);

function setFeedback(node, message, error = false) {
  if (node.textContent !== message) node.textContent = message;
  node.dataset.error = String(error);
}

function makeButton(label, description, handler) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'control';
  button.textContent = label;
  button.setAttribute('aria-label', description);
  button.addEventListener('click', handler);
  return button;
}

function makeRow(title, detail, ...buttons) {
  const row = document.createElement('li');
  const text = document.createElement('div');
  const heading = document.createElement('strong');
  const subtitle = document.createElement('small');
  heading.textContent = title;
  subtitle.textContent = detail;
  text.append(heading, subtitle);
  const actions = document.createElement('div');
  actions.className = 'setup-row-actions';
  actions.append(...buttons);
  row.append(text, actions);
  return row;
}

export function createLocalSetup({onSave, onRescan, onStop, onTune}) {
  const get = id => document.getElementById(id);
  const profileForm = get('local-profile-form');
  const profileFields = get('local-profile-fields');
  const area = get('local-area');
  const sydney = get('local-sydney');
  const start = get('local-scan-start');
  const end = get('local-scan-end');
  const threshold = get('local-scan-threshold');
  const latitude = get('local-map-latitude');
  const longitude = get('local-map-longitude');
  const save = get('local-setup-save');
  const rescan = get('local-scan-run');
  const stop = get('local-scan-stop');
  const profileFeedback = get('local-setup-feedback');
  const progress = get('local-scan-progress');
  const count = get('local-scan-count');
  const scanStatus = get('local-scan-status');
  const hitList = get('local-scan-hits');
  const presetForm = get('local-preset-form');
  const presetFields = get('local-preset-fields');
  const presetName = get('local-preset-name');
  const presetFrequency = get('local-preset-frequency');
  const presetMode = get('local-preset-mode');
  const apply = get('local-preset-submit');
  const cancel = get('local-preset-cancel');
  const tuneDraft = get('local-preset-tune');
  const presetFeedback = get('local-preset-feedback');
  const presetList = get('local-preset-list');
  let loadedKey = '';
  let dirty = false;
  let pending = false;
  let canScan = false;
  let canTune = false;
  let active = false;
  let survey = false;
  let presets = [];
  let editing = -1;
  let hitsKey = '';

  presetMode.replaceChildren(...receiverModes.map(({id, label}) => new Option(label, id)));

  function refreshControls() {
    profileFields.disabled = !loadedKey || pending;
    presetFields.disabled = profileFields.disabled;
    save.disabled = !dirty;
    rescan.hidden = active;
    rescan.disabled = !canScan;
    rescan.textContent = dirty ? 'Save and rescan' : 'Rescan';
    stop.hidden = !active;
    stop.disabled = !canScan;
    tuneDraft.disabled = !canTune || active || !presetFrequency.validity.valid;
    for (const button of hitList.querySelectorAll('button')) button.disabled = profileFields.disabled;
    for (const button of presetList.querySelectorAll('button')) {
      button.disabled = profileFields.disabled || (button.dataset.tune === 'true' && (!canTune || active));
    }
  }

  function markDirty() {
    dirty = true;
    setFeedback(profileFeedback, 'Unsaved changes');
    refreshControls();
  }

  function fillEditor(index, preset = {}) {
    editing = index;
    presetName.value = preset.name || '';
    presetFrequency.value = preset.frequency ? formatMHz(preset.frequency) : '';
    presetMode.value = preset.mode || 'spectrum';
    presetFrequency.setCustomValidity('');
    apply.textContent = index < 0 ? 'Add preset' : 'Update preset';
    cancel.hidden = index < 0 && !preset.frequency;
    refreshControls();
  }

  function openEditor(index, preset) {
    fillEditor(index, preset);
    setFeedback(presetFeedback, '');
    presetName.focus();
  }

  function renderPresets() {
    presetList.replaceChildren(...presets.map((preset, index) => {
      const name = preset.name || mhz(preset.frequency);
      const detail = modeLabels.get(preset.mode);
      const tune = makeButton('Tune', 'Tune ' + name, () => tunePreset(preset));
      tune.dataset.tune = 'true';
      return makeRow(
        name,
        preset.name ? mhz(preset.frequency) + ' · ' + detail : detail,
        tune,
        makeButton('Edit', 'Edit ' + name, () => openEditor(index, preset)),
        makeButton('Remove', 'Remove ' + name, () => {
          presets.splice(index, 1);
          if (editing === index) fillEditor(-1);
          else if (editing > index) editing--;
          renderPresets();
          markDirty();
          setFeedback(presetFeedback, 'Preset removed. Save setup to keep this change.');
          presetName.focus();
        })
      );
    }));
    presetList.hidden = !presets.length;
  }

  function loadProfile(profile, keepEditor = false) {
    const key = JSON.stringify(profile);
    if (key === loadedKey) return;
    loadedKey = key;
    area.value = profile.name;
    sydney.checked = profile.includeSydney;
    start.value = formatMHz(profile.scan.startFrequency);
    end.value = formatMHz(profile.scan.stopFrequency);
    threshold.value = profile.scan.threshold;
    latitude.value = profile.aircraftCentre?.latitude ?? '';
    longitude.value = profile.aircraftCentre?.longitude ?? '';
    survey = profile.scan.survey === true;
    for (const input of [area, end, threshold, latitude, longitude]) input.setCustomValidity('');
    presets = [...profile.presets];
    if (!keepEditor) fillEditor(-1);
    renderPresets();
    setFeedback(profileFeedback, '');
    setFeedback(presetFeedback, '');
  }

  function update(profile, scan, availability = {}) {
    canScan = availability.canScan ?? true;
    canTune = availability.canTune ?? canScan;
    if (profile && !pending && !dirty) loadProfile(profile);
    active = scan?.status === 'scanning' || scan?.status === 'holding';
    const hits = scan?.survey ? [] : scan?.hits ?? [];
    const range = Number.isFinite(scan?.startFrequency) && Number.isFinite(scan?.stopFrequency)
      ? ' ' + formatMHz(scan.startFrequency) + '–' + mhz(scan.stopFrequency)
      : '';
    let message = 'Run a scan to find peaks above the noise floor.';
    if (active) message = 'Scanning' + range;
    else if (scan?.status === 'complete') {
      if (scan.survey) message = 'Spectrum survey complete' + range + '.';
      else {
        const outcome = hits.length === 1 ? '1 peak found.' :
          hits.length > 1 ? hits.length + ' peaks found.' : 'No peaks met the threshold.';
        message = 'Scan complete' + range + '. ' + outcome;
      }
    } else if (scan?.status === 'error') message = scan.error || 'The receiver could not finish the scan.';
    else if (scan?.status === 'stopped') message = 'Scan stopped after ' + (scan.visited || 0) + ' windows.';
    setFeedback(scanStatus, message, scan?.status === 'error');
    progress.hidden = !active;
    progress.max = scan?.total || 1;
    progress.value = scan?.visited || 0;
    count.hidden = !active;
    if (active) count.textContent = progress.value + '/' + progress.max + ' windows';
    const key = JSON.stringify(hits);
    if (key !== hitsKey) {
      hitsKey = key;
      hitList.replaceChildren(...hits.map(hit => {
        const frequency = mhz(hit.frequency);
        return makeRow(frequency, '+' + hit.aboveNoise + ' dB above noise',
          makeButton('Use peak', 'Use ' + frequency + ' peak', () => openEditor(-1, {frequency:hit.frequency})));
      }));
      hitList.hidden = !hits.length;
    }
    refreshControls();
  }

  async function perform(work, feedback, profile, success) {
    if (pending) return;
    pending = true;
    setFeedback(feedback, 'Working…');
    refreshControls();
    try {
      const result = await work();
      if (profile) {
        dirty = false;
        loadProfile(result?.profile ?? profile, true);
      }
      setFeedback(feedback, success);
    } catch (error) {
      setFeedback(feedback, error.message || 'Open Air could not finish the request.', true);
    } finally {
      pending = false;
      refreshControls();
    }
  }

  function tunePreset(preset) {
    if (canTune && !active) void perform(() => onTune(preset), presetFeedback, null, '');
  }

  function readPreset() {
    const mode = presetMode.value;
    const previous = presets[editing];
    return {
      ...(previous?.mode === mode && previous),
      name:presetName.value.trim(),
      frequency:toHz(presetFrequency),
      mode
    };
  }

  profileForm.addEventListener('input', () => {
    for (const input of [area, end, threshold, latitude, longitude]) input.setCustomValidity('');
    markDirty();
  });
  profileForm.addEventListener('submit', event => {
    event.preventDefault();
    const scanning = event.submitter === rescan;
    if (pending || (scanning ? !canScan || active : !dirty)) return;
    if (scanning && !dirty) {
      void perform(() => onRescan(), profileFeedback, null, '');
      return;
    }
    const profile = {
      name:area.value.trim(),
      includeSydney:sydney.checked,
      scan:{startFrequency:toHz(start), stopFrequency:toHz(end), threshold:threshold.valueAsNumber, ...(survey && {survey})},
      presets
    };
    if (latitude.value || longitude.value) {
      profile.aircraftCentre = {latitude:latitude.valueAsNumber,longitude:longitude.valueAsNumber};
      latitude.setCustomValidity(latitude.value ? '' : 'Enter the latitude of the map centre.');
      longitude.setCustomValidity(longitude.value ? '' : 'Enter the longitude of the map centre.');
      if (!latitude.checkValidity() || !longitude.checkValidity()) latitude.closest('details').open = true;
    }
    area.setCustomValidity(profile.name ? '' : 'Enter an area name.');
    end.setCustomValidity(profile.scan.stopFrequency > profile.scan.startFrequency ? '' : 'Enter a frequency above the scan start.');
    threshold.setCustomValidity(profile.scan.threshold > 0 ? '' : 'Enter a positive threshold.');
    if (!profileForm.reportValidity()) return;
    const callback = scanning ? onRescan : onSave;
    void perform(() => callback(profile), profileFeedback, profile, scanning ? '' : 'Setup saved.');
  });
  stop.addEventListener('click', () => {
    if (canScan && active) void perform(onStop, profileFeedback, null, dirty ? 'Unsaved changes' : '');
  });
  presetForm.addEventListener('input', () => {
    presetFrequency.setCustomValidity('');
    cancel.hidden = editing < 0 && !presetName.value && !presetFrequency.value;
    refreshControls();
  });
  presetForm.addEventListener('submit', event => {
    event.preventDefault();
    const preset = readPreset();
    const duplicate = presets.some((other, index) => index !== editing && other.frequency === preset.frequency && other.mode === preset.mode);
    presetFrequency.setCustomValidity(duplicate ? 'A preset already uses this frequency and mode.' : '');
    if (!presetForm.reportValidity()) return;
    if (editing < 0) presets.push(preset);
    else presets[editing] = preset;
    fillEditor(-1);
    renderPresets();
    markDirty();
    setFeedback(presetFeedback, 'Save setup to keep this preset.');
  });
  tuneDraft.addEventListener('click', () => {
    if (presetForm.reportValidity()) tunePreset(readPreset());
  });
  cancel.addEventListener('click', () => {
    fillEditor(-1);
    setFeedback(presetFeedback, '');
    presetName.focus();
  });

  return {update};
}
