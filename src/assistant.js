// Jarvis: a local chat window with voice in and out.
// The brain lives in Ollama (127.0.0.1:11434); this file only paints and listens.

const api = window.jarvis;

const $ = (id) => document.getElementById(id);

const els = {
  shell: $('shell'),
  statusChip: $('statusChip'),
  statusText: $('statusText'),
  modelChip: $('modelChip'),
  modelChipText: $('modelChipText'),
  feed: $('feed'),
  welcome: $('welcome'),
  welcomeSub: $('welcomeSub'),
  thread: $('thread'),
  setup: $('setup'),
  setupTitle: $('setupTitle'),
  setupText: $('setupText'),
  setupInstall: $('setupInstall'),
  setupRetry: $('setupRetry'),
  setupFoot: $('setupFoot'),
  input: $('input'),
  sendBtn: $('sendBtn'),
  micBtn: $('micBtn'),
  gearBtn: $('gearBtn'),
  hideBtn: $('hideBtn'),
  sheet: $('sheet'),
  sheetClose: $('sheetClose'),
  brainLine: $('brainLine'),
  startEngine: $('startEngine'),
  refreshModels: $('refreshModels'),
  modelList: $('modelList'),
  presets: $('presets'),
  pullForm: $('pullForm'),
  pullName: $('pullName'),
  pullProgress: $('pullProgress'),
  pullBar: $('pullBar'),
  pullText: $('pullText'),
  speakToggle: $('speakToggle'),
  voiceSelect: $('voiceSelect'),
  rateRange: $('rateRange'),
  testVoice: $('testVoice'),
  wakeToggle: $('wakeToggle'),
  sttLine: $('sttLine'),
  toast: $('toast'),
  suggestions: $('suggestions'),
};

const state = {
  settings: { model: '', voice: '', rate: 0, speak: true, wake: false },
  status: { running: false, version: '', models: [] },
  presets: [],
  voices: [],
  history: [],
  busy: false,
  stream: null,
  pulling: null,
  stt: null,
};

const SYSTEM_PROMPT = [
  'You are Jarvis, a calm, capable assistant living in a small glass window on a Windows desktop.',
  'Be direct and warm. Keep answers short unless asked for depth — two or three sentences usually.',
  'Use plain language and fenced code blocks for code. Never invent facts; say when you are unsure.',
].join(' ');

const STT_MODELLING = 'onnx-community/whisper-base.en';
const STT_FALLBACK = 'Xenova/whisper-tiny.en';

// ------------------------------------------------------------------ utilities

let toastTimer = 0;
function toast(message, ms = 3200) {
  els.toast.textContent = message;
  els.toast.hidden = false;
  els.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    els.toast.classList.remove('show');
    setTimeout(() => {
      els.toast.hidden = true;
    }, 220);
  }, ms);
}

function formatSize(bytes) {
  if (!bytes) return 'unknown size';
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;
}

function stripForSpeech(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, ' code block ')
    .replace(/[\u0060*_#>]/g, '')
    .replace(/\[(.*?)\]\(.*?\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 700);
}

// ------------------------------------------------------------------- rendering

function atBottom() {
  return els.feed.scrollHeight - els.feed.scrollTop - els.feed.clientHeight < 90;
}

function scrollDown(force = false) {
  if (force || atBottom()) els.feed.scrollTop = els.feed.scrollHeight;
}

function hideWelcome() {
  if (!els.welcome.hidden) {
    els.welcome.classList.add('hide');
    els.welcome.hidden = true;
  }
}

function addMessage(role, text = '') {
  hideWelcome();
  const node = document.createElement('div');
  node.className = `msg ${role}`;
  if (role === 'assistant' || role === 'error') {
    const avatar = document.createElement('span');
    avatar.className = 'avatar';
    node.appendChild(avatar);
  }
  const body = document.createElement('div');
  body.className = 'body';
  if (text) body.textContent = text;
  node.appendChild(body);
  els.thread.appendChild(node);
  scrollDown(true);
  return body;
}

function addTyping() {
  const body = addMessage('assistant');
  const dots = document.createElement('span');
  dots.className = 'typing';
  dots.innerHTML = '<i></i><i></i><i></i>';
  body.appendChild(dots);
  return body;
}

function setBusy(busy) {
  state.busy = busy;
  els.sendBtn.classList.toggle('busy', busy);
  els.sendBtn.setAttribute('aria-label', busy ? 'Stop' : 'Send');
  els.input.disabled = false;
}

function setConnected(connected, version = '') {
  document.body.dataset.connected = connected ? 'true' : 'false';
  els.statusText.textContent = connected ? (version ? `Local · ${version.split(' ')[0]}` : 'Local') : 'Offline';
  els.setup.hidden = connected;
  if (connected) els.setup.hidden = true;
}

function modelLabel(name) {
  if (!name) return 'No model';
  return name.replace(/:latest$/, '');
}

function refreshModelChip() {
  els.modelChipText.textContent = modelLabel(state.settings.model);
  const connected = state.status.running;
  els.welcomeSub.textContent = connected
    ? `${modelLabel(state.settings.model) || 'Pick a model'} · local · private`
    : 'A local model, running on your own machine.';
}

// ------------------------------------------------------------------ conversation

function trimHistory() {
  const system = state.history.find((m) => m.role === 'system');
  const rest = state.history.filter((m) => m.role !== 'system').slice(-12);
  state.history = system ? [system, ...rest] : rest;
}

async function send(text) {
  const prompt = String(text || '').trim();
  if (!prompt) return;
  if (state.busy) return;
  if (!state.status.running) {
    openSheet();
    toast('Start Ollama first — the gear has a button for it.');
    return;
  }
  if (!state.settings.model) {
    openSheet();
    toast('Pick a model to talk to.');
    return;
  }

  els.input.value = '';
  autosize();
  addMessage('user', prompt);
  state.history.push({ role: 'user', content: prompt });
  trimHistory();

  const body = addTyping();
  let acc = '';
  state.stream = { body, text: '' };
  setBusy(true);

  try {
    await api.chat({ model: state.settings.model, messages: state.history });
  } catch {
    if (state.stream) state.stream = null;
    setBusy(false);
    addMessage('error', 'The assistant could not reach the model.');
  }
}

function finishStream(text, aborted) {
  if (!state.stream) return;
  const { body } = state.stream;
  state.stream = null;
  setBusy(false);

  const card = body.closest('.msg');
  if (!text.trim() && card) card.remove();
  else body.textContent = text;

  if (text.trim()) {
    state.history.push({ role: 'assistant', content: text });
    trimHistory();
    trimHistory();
    if (state.settings.speak && !aborted) api.speak(stripForSpeech(text));
  }
  scrollDown();
}

api.onDelta((chunk) => {
  if (!state.stream) return;
  state.stream.text += chunk;
  const body = state.stream.body;
  body.textContent = state.stream.text;
  const caret = document.createElement('span');
  caret.className = 'caret';
  body.appendChild(caret);
  scrollDown();
});

api.onDone((payload) => {
  const text = (payload && payload.text) || (state.stream ? state.stream.text : '');
  finishStream(text, !!(payload && payload.aborted));
});

api.onError((payload) => {
  const message = (payload && payload.message) || 'Something went wrong.';
  if (state.stream) {
    const partial = state.stream.text;
    state.stream = null;
    if (partial.trim()) {
      const body = els.thread.lastElementChild?.querySelector('.body');
      if (body) body.textContent = partial;
      state.history.push({ role: 'assistant', content: partial });
    }
  }
  setBusy(false);
  addMessage('error', message);
  if (payload && (payload.code === 'connection' || payload.code === 'no-model')) {
    refreshStatus();
  }
});

// --------------------------------------------------------------------- models

function renderModels() {
  els.modelList.replaceChildren();
  if (!state.status.running) {
    els.brainLine.textContent = 'Ollama is not answering on 127.0.0.1:11434.';
    return;
  }
  const models = state.status.models;
  els.brainLine.textContent = models.length
    ? `${models.length} model${models.length === 1 ? '' : 's'} installed · ${state.status.version || 'local'}`
    : 'No models yet. Download one below — 4–5 GB is plenty for your card.';
  if (!models.length) return;

  for (const model of models) {
    const row = document.createElement('div');
    row.className = 'model-row';
    row.classList.toggle('active', model.name === state.settings.model);

    const meta = document.createElement('div');
    meta.className = 'meta';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = model.name;
    const sub = document.createElement('span');
    sub.className = 'sub';
    sub.textContent = [model.params, model.quant, formatSize(model.size)].filter(Boolean).join(' · ');
    meta.append(name, sub);

    const check = document.createElement('span');
    check.className = 'check';

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'remove';
    remove.title = 'Delete model';
    remove.textContent = '×';
          remove.addEventListener('click', async (event) => {
        event.stopPropagation();
        remove.disabled = true;
        const result = await api.remove(model.name);
        if (result && result.ok) {
          toast(`Deleted ${model.name}`);
          if (state.settings.model === model.name) state.settings.model = '';
          await refreshStatus();
          refreshModelChip();
        } else {
        toast('Could not delete that model.');
        remove.disabled = false;
      }
    });

    row.append(meta, check, remove);
    row.addEventListener('click', () => {
      selectModel(model.name);
      toast(`${modelLabel(model.name)} is awake.`);
    });
    els.modelList.appendChild(row);
  }
}

function renderPresets() {
  els.presets.replaceChildren();
  const installed = new Set(state.status.models.map((m) => m.name));
  for (const preset of state.presets) {
    const card = document.createElement('button');
    card.type = 'button';
    const isInstalled = installed.has(preset.name);
    card.className = `preset${isInstalled ? ' installed' : ''}`;
    card.innerHTML = '';
    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = preset.label;
    const note = document.createElement('span');
    note.className = 'note';
    note.textContent = isInstalled ? 'Installed' : preset.note;
    const size = document.createElement('span');
    size.className = 'size';
    size.textContent = preset.size;
    card.append(label, note, size);
    card.addEventListener('click', () => {
      if (isInstalled) {
        selectModel(preset.name);
        toast(`${preset.label} is awake.`);
        return;
      }
      pull(preset.name);
    });
    els.presets.appendChild(card);
  }
}

function selectModel(name) {
  state.settings.model = name;
  api.save({ model: name });
  refreshModelChip();
  renderModels();
}

let statusSignature = '';

async function refreshStatus() {
  const status = await api.status();
  const next = status || { running: false, version: '', models: [] };
  const signature = `${next.running}|${next.version}|${next.models.map((m) => m.name).join(',')}`;
  const unchanged = signature === statusSignature;
  statusSignature = signature;
  state.status = next;
  if (unchanged && els.sheet.hidden) {
    refreshModelChip();
    return;
  }
  setConnected(state.status.running, state.status.version);
  if (
    state.settings.model &&
    !state.status.models.some((model) => model.name === state.settings.model)
  ) {
    // The model was deleted outside this window; do not keep pointing at it.
    state.settings.model = '';
    api.save({ model: '' });
  }
  if (state.status.running && !state.settings.model && state.status.models.length) {
    const preferred =
      state.status.models.find((m) => m.name.includes('qwen2.5:7b')) || state.status.models[0];
    selectModel(preferred.name);
  }
  renderModels();
  renderPresets();
  refreshModelChip();
}

async function pull(name) {
  if (!state.status.running) {
    toast('Start Ollama first.');
    return;
  }
  if (state.pulling) {
    toast('One download at a time.');
    return;
  }
  state.pulling = name;
  els.pullProgress.hidden = false;
  els.pullBar.style.width = '2%';
  els.pullText.textContent = `Starting ${name}…`;
  renderPresets();

  const result = await api.pull(name);
  state.pulling = null;
  els.pullProgress.hidden = true;

  if (result && result.ok) {
    toast(`${name} is ready.`);
    await refreshStatus();
    selectModel(name);
  } else {
    toast(`Download failed: ${(result && result.message) || 'see Ollama logs'}`);
  }
}

api.onPull((payload) => {
  if (!payload) return;
  if (payload.status === 'done' || payload.status === 'success') {
    els.pullBar.style.width = '100%';
    els.pullText.textContent = 'Done — loading the model.';
    return;
  }
  if (payload.total > 0) {
    const pct = Math.max(2, Math.min(100, Math.round((payload.completed / payload.total) * 100)));
    els.pullBar.style.width = `${pct}%`;
    els.pullText.textContent = `${payload.status || 'Downloading'} · ${pct}% of ${formatSize(payload.total)}`;
  } else {
    els.pullBar.style.width = '8%';
    els.pullText.textContent = payload.status || 'Working…';
  }
  if (payload.error) toast(payload.error);
});

// ---------------------------------------------------------------------- voice

function ensureStt() {
  if (state.stt) return state.stt;
  state.stt = new Worker(new URL('./assistant-stt.worker.js', import.meta.url), { type: 'module' });
  state.stt.pending = null;
  state.stt.ready = false;
  state.stt.onmessage = (event) => {
    const data = event.data || {};
    if (data.type === 'progress') {
      els.sttLine.textContent = `Loading speech model · ${data.pct}%`;
      if (!state.sttAnnounced) {
        state.sttAnnounced = true;
        toast('Preparing the speech model — this happens once.', 4200);
      }
      return;
    }
    if (data.type === 'ready') {
      state.stt.ready = true;
      els.sttLine.textContent = 'Speech model ready.';
      return;
    }
    if (data.type === 'error') {
      els.sttLine.textContent = `Speech model unavailable: ${data.message}`;
      toast('Voice input is unavailable — typing still works.');
      return;
    }
    if (data.type === 'result' && state.stt.pending) {
      const resolve = state.stt.pending;
      state.stt.pending = null;
      resolve(data.text || '');
    }
  };
  state.stt.postMessage({ type: 'init', model: STT_MODELLING, fallback: STT_FALLBACK });
  return state.stt;
}

function transcribe(samples) {
  const worker = ensureStt();
  return new Promise((resolve) => {
    if (worker.pending) {
      resolve('');
      return;
    }
    worker.pending = resolve;
    const copy = new Float32Array(samples);
    worker.postMessage({ type: 'transcribe', audio: copy }, [copy.buffer]);
  });
}

let audio = null;

async function ensureAudio() {
  if (audio) return audio;
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
  });
  const context = new AudioContext({ sampleRate: 16000 });
  const source = context.createMediaStreamSource(stream);
  const analyser = context.createAnalyser();
  analyser.fftSize = 1024;
  source.connect(analyser);
  audio = { stream, context, source, analyser, processor: null, buffers: [], running: false };
  return audio;
}

function recorderStart() {
  const a = audio;
  if (!a) return;
  a.buffers = [];
  a.voice = false;
  a.silence = 0;
  a.blocks = 0;
  a.processor = a.context.createScriptProcessor(4096, 1, 1);
  a.processor.onaudioprocess = (event) => {
    const data = event.inputBuffer.getChannelData(0);
    a.buffers.push(new Float32Array(data));
    let sum = 0;
    for (let i = 0; i < data.length; i += 1) sum += data[i] * data[i];
    const rms = Math.sqrt(sum / data.length);
    if (rms > 0.012) {
      a.voice = true;
      a.silence = 0;
    } else if (a.voice) {
      a.silence += 1;
    }
    a.blocks += 1;
  };
  a.source.connect(a.processor);
  a.processor.connect(a.context.destination);
}

function recorderStop() {
  const a = audio;
  if (!a || !a.processor) return new Float32Array(0);
  try {
    a.source.disconnect(a.processor);
    a.processor.disconnect();
  } catch {
    /* already detached */
  }
  a.processor = null;
  const total = a.buffers.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Float32Array(total);
  let offset = 0;
  for (const chunk of a.buffers) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  a.buffers = [];
  return out;
}

function setListening(value) {
  document.body.dataset.listening = value ? 'true' : 'false';
}

async function listenOnce() {
  if (state.busy) {
    toast('One thing at a time.');
    return;
  }
  try {
    await ensureAudio();
  } catch {
    toast('Microphone blocked — check Windows privacy settings.');
    return;
  }
  if (audio.context.state === 'suspended') await audio.context.resume();

  setListening(true);
  recorderStart();

  const samples = await new Promise((resolve) => {
    const started = Date.now();
    const tick = setInterval(() => {
      const elapsed = Date.now() - started;
      const spoke = audio.voice;
      // 4096 samples at 16 kHz ≈ 0.26 s per block, so four quiet blocks ≈ 1 s.
      const quiet = audio.silence >= 4;
      if ((spoke && quiet) || elapsed > 14000 || (!spoke && elapsed > 6000)) {
        clearInterval(tick);
        resolve(recorderStop());
      }
    }, 90);
  });
  setListening(false);

  if (!samples.length || samples.length < 1600) {
    toast('I did not catch that.');
    return;
  }
  toast('Transcribing…', 1400);
  const text = await transcribe(samples);
  const clean = String(text || '').trim();
  if (!clean) {
    toast('I did not catch that.');
    return;
  }
  const stripped = clean.replace(/^(hey|hi|okay|ok)[,\s]*jarvis[,\s.!:-]*/i, '').trim();
  const command = stripped || clean;
  els.input.value = command;
  autosize();
  send(command);
}

let wakeTimer = 0;

async function wakeLoop() {
  if (!state.settings.wake) return;
  if (state.busy || document.body.dataset.listening === 'true') {
    wakeTimer = setTimeout(wakeLoop, 1200);
    return;
  }
  try {
    await ensureAudio();
  } catch {
    toast('Microphone blocked — wake word off.');
    els.wakeToggle.checked = false;
    api.save({ wake: false });
    return;
  }
  if (audio.context.state === 'suspended') await audio.context.resume();

  setListening(true);
  recorderStart();
  const samples = await new Promise((resolve) => {
    const started = Date.now();
    const tick = setInterval(() => {
      const elapsed = Date.now() - started;
      if ((audio.voice && audio.silence >= 3) || elapsed > 9000) {
        clearInterval(tick);
        resolve(recorderStop());
      }
    }, 90);
  });
  setListening(false);

  if (samples.length > 4000) {
    const text = String(await transcribe(samples)).trim();
    const match = text.match(/^(?:hey|hi|okay|ok)?[,\s]*jarvis[,\s.!:-]*(.*)$/i);
    if (match) {
      const command = (match[1] || '').trim();
      if (command.length > 1) {
        els.input.value = command;
        autosize();
        send(command);
      } else {
        toast('Listening…', 1500);
        await listenOnce();
      }
    }
  }
  if (state.settings.wake) wakeTimer = setTimeout(wakeLoop, 900);
}

// ------------------------------------------------------------------- settings

function openSheet() {
  els.sheet.hidden = false;
  requestAnimationFrame(() => els.sheet.classList.add('open'));
  renderModels();
  renderPresets();
  refreshStatus();
}

function closeSheet() {
  els.sheet.classList.remove('open');
  setTimeout(() => {
    els.sheet.hidden = true;
  }, 220);
}

function fillVoices() {
  els.voiceSelect.replaceChildren();
  const voices = state.voices.length ? state.voices : [{ name: 'Microsoft Zira Desktop', culture: 'en-US' }];
  for (const voice of voices) {
    const option = document.createElement('option');
    option.value = voice.name;
    option.textContent = `${voice.name.replace('Microsoft ', '').replace(' Desktop', '')} · ${voice.culture}`;
    els.voiceSelect.appendChild(option);
  }
  const chosen = state.settings.voice || voices[0]?.name || '';
  els.voiceSelect.value = chosen;
  if (!state.settings.voice && chosen) {
    state.settings.voice = chosen;
    api.save({ voice: chosen });
  }
}

function applySettingsToUi() {
  els.speakToggle.checked = !!state.settings.speak;
  els.wakeToggle.checked = !!state.settings.wake;
  els.rateRange.value = String(state.settings.rate || 0);
}

// --------------------------------------------------------------------- wiring

function autosize() {
  els.input.style.height = 'auto';
  els.input.style.height = `${Math.min(116, els.input.scrollHeight)}px`;
}

els.input.addEventListener('input', autosize);
els.input.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    send(els.input.value);
  }
});

els.sendBtn.addEventListener('click', () => {
  if (state.busy) {
    api.stop();
    return;
  }
  send(els.input.value);
});

els.micBtn.addEventListener('click', () => {
  if (document.body.dataset.listening === 'true') {
    recorderStop();
    setListening(false);
    return;
  }
  listenOnce();
});

els.gearBtn.addEventListener('click', openSheet);
els.sheetClose.addEventListener('click', closeSheet);
els.hideBtn.addEventListener('click', () => api.hide());
els.modelChip.addEventListener('click', openSheet);
els.setupInstall.addEventListener('click', () => api.open('https://ollama.com/download/windows'));
els.setupRetry.addEventListener('click', async () => {
  els.setupTitle.textContent = 'Checking…';
  els.setupText.textContent = 'Looking for Ollama on this machine.';
  const started = await api.startEngine();
  if (started && started.status && started.status.running) {
    await refreshStatus();
    toast('Ollama is running.');
    return;
  }
  els.setupTitle.textContent = started && started.reason === 'missing' ? 'Ollama is not installed' : 'Ollama is still offline';
  els.setupText.textContent =
    started && started.reason === 'missing'
      ? 'Download it once — the installer is small and runs the models locally.'
      : 'Install it, or run “ollama serve” in a terminal, then check again.';
});

els.startEngine.addEventListener('click', async () => {
  els.startEngine.disabled = true;
  els.brainLine.textContent = 'Starting Ollama…';
  const result = await api.startEngine();
  els.startEngine.disabled = false;
  if (result && result.status && result.status.running) {
    toast('Ollama is running.');
    await refreshStatus();
  } else {
    toast('Ollama is not installed yet.');
  }
});

els.refreshModels.addEventListener('click', refreshStatus);

els.pullForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const name = els.pullName.value.trim();
  if (!name) return;
  els.pullName.value = '';
  pull(name);
});

els.speakToggle.addEventListener('change', () => {
  state.settings.speak = els.speakToggle.checked;
  api.save({ speak: state.settings.speak });
  if (!state.settings.speak) api.hush();
});

els.voiceSelect.addEventListener('change', () => {
  state.settings.voice = els.voiceSelect.value;
  api.save({ voice: state.settings.voice });
  api.speak('This is how I sound.');
});

els.rateRange.addEventListener('input', () => {
  state.settings.rate = Number(els.rateRange.value) || 0;
  api.save({ rate: state.settings.rate });
});

els.testVoice.addEventListener('click', () => {
  api.speak('All systems nominal. I am ready when you are.');
});

els.wakeToggle.addEventListener('change', () => {
  state.settings.wake = els.wakeToggle.checked;
  api.save({ wake: state.settings.wake });
  clearTimeout(wakeTimer);
  if (state.settings.wake) {
    toast('Say “Hey Jarvis”.', 2200);
    wakeLoop();
  } else {
    setListening(false);
  }
});

els.suggestions.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-prompt]');
  if (!button) return;
  const prompt = button.dataset.prompt;
  els.input.value = prompt;
  autosize();
  if (/[:：]\s*$/.test(prompt)) {
    els.input.focus();
    return;
  }
  send(prompt);
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    if (!els.sheet.hidden) {
      closeSheet();
      return;
    }
    api.hide();
    return;
  }
  if ((event.ctrlKey || event.metaKey) && event.key === ',') {
    event.preventDefault();
    openSheet();
  }
});

window.addEventListener('focus', () => {
  els.input.focus();
  refreshStatus();
});

// ----------------------------------------------------------------------- boot

(async function boot() {
  const data = await api.boot();
  if (!data) return;
  state.settings = { ...state.settings, ...(data.settings || {}) };
  state.status = data.status || state.status;
  state.presets = data.presets || [];
  state.voices = data.voices || [];
  state.history = [{ role: 'system', content: SYSTEM_PROMPT }];

  applySettingsToUi();
  fillVoices();
  setConnected(state.status.running, state.status.version);
  refreshModelChip();
  renderModels();
  renderPresets();
  if (state.status.models.length && !state.settings.model) {
    selectModel(state.status.models[0].name);
  }
  if (!state.status.running) {
    els.setupTitle.textContent = 'Ollama is not running';
    els.setupText.textContent =
      'Jarvis runs the model itself. Install Ollama once and it stays local — no account, nothing sent anywhere.';
  }
  els.input.focus();
})();

// Keep the connection chip honest without polling hard.
setInterval(() => {
  if (document.visibilityState !== 'visible') return;
  if (els.sheet.hidden && !state.busy) refreshStatus();
}, 8000);
