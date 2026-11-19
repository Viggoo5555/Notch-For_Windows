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
  setupHw: $('setupHw'),
  setupProgress: $('setupProgress'),
  setupBar: $('setupBar'),
  setupStatus: $('setupStatus'),
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
  languageSelect: $('languageSelect'),
  rateRange: $('rateRange'),
  testVoice: $('testVoice'),
  wakeToggle: $('wakeToggle'),
  sttLine: $('sttLine'),
  voiceLine: $('voiceLine'),
  hwLine: $('hwLine'),
  toast: $('toast'),
  suggestions: $('suggestions'),
};

const state = {
  settings: {
    model: '',
    voice: '',
    engine: 'neural',
    neuralVoice: '',
    studioVoice: 'bm_george',
    rate: 0,
    speak: true,
    wake: false,
  },
  neural: { available: false, voices: [] },
  studio: { available: false, recommended: false, voices: [], note: '' },
  sttPlan: null,
  status: { running: false, version: '', models: [] },
  presets: [],
  voices: [],
  history: [],
  busy: false,
  stream: null,
  pulling: null,
  stt: null,
  studioAnnounced: false,
  gamePaused: false,
  lastVoice: '',
};

// Danish is recognisable by its letters, which the small models respect better
// than any instruction about language.
const DANISH_LETTERS = /[æøåÆØÅ]/;
const DANISH_WORDS =
  /\b(og|ikke|jeg|det|der|er|til|med|på|for|af|du|vi|kan|hvad|hvor|hvordan|hvorfor|gerne|tak|hej|nu|så|også|men|har|skal|vil|mig|dig|den|dette|klokken|vejret|dansk|godaften|godmorgen|godnat|hr)\b/gi;

function looksDanish(text) {
  const value = String(text || '');
  if (DANISH_LETTERS.test(value)) return true;
  const words = value.trim().split(/\s+/).filter(Boolean);
  if (words.length < 4) return false;
  return (value.match(DANISH_WORDS) || []).length >= 2;
}

function systemPrompt() {
  const lines = [
    'You are Jarvis, a calm British assistant living in a small window on a Windows desktop.',
    'Speak the way a good butler would: short, dry, precise, never flustered. Use "sir" now and then, not in every sentence.',
    'Keep answers to two or three sentences unless asked for depth. Plain language; fenced code blocks only when code is wanted.',
    'Never invent facts; say plainly when you are unsure.',
  ];
  const language = state.settings.language || 'auto';
  if (language === 'da') {
    lines.push(
      'Svar altid på dansk, også når spørgsmålet er på engelsk. Du er stadig Jarvis: rolig, kort og præcis, og du siger "hr." nu og da i stedet for "sir".',
    );
  } else if (language === 'en') {
    lines.push('Answer in English, even if the question is in Danish.');
  } else {
    lines.push(
      'Answer in the language the user wrote or spoke in — Danish when they used Danish, English otherwise. Never mix the two in one reply, and keep the same voice in both.',
    );
  }
  lines.push(
    'Lead with the answer: no preamble, no restating the question, no summary at the end. The first sentence is the answer.',
    'You can work this computer, and you are expected to. When the user asks for a thing rather than an explanation, do it and add one command in double square brackets at the very end:',
    '[[open: Brave]], [[search: google for weather in Aarhus]], [[play: Norah Jones]], [[run: ipconfig]].',
    'Anything a terminal can do is allowed: run hands the rest of the line to cmd, so [[run: dir C:\\Users]] works. Locking the machine, sleep, shutting down, restarting, volume up, volume down, mute and a screenshot are orders of their own — just carry them out.',
    'You can also work Notch, the app you live in, and you should never claim otherwise: any order that is about Notch itself goes in the same brackets with the word notch first —',
    '[[notch: open the library]], [[notch: make it mint]], [[notch: frosted glass]], [[notch: taskbar off]], [[notch: show the performance overlay]], [[notch: focus for 25 minutes]], [[notch: launch Hades II]], [[notch: rescan the library]], [[notch: start with Windows]].',
    'What Notch answers to: opening the panel, the library, the store, the focus timer, the clipboard or the settings; the accent colour (blue, lilac, mint, pink, amber); the surface (liquid, frosted, black); tint, blur, grain, pill glow, animation speed and easing, hover delay, pill width, attached or island shape; the glass source (live desktop or wallpaper); the taskbar, its auto-hide and its style; the focus timer (start, pause, reset, any number of minutes); the game library (rescan it, count it, launch a game by name); the store, which draws Steam\'s catalogue inside the panel, best reviewed first, with its own filters and sorting; starting with Windows; and quitting the app.',
    'The window carries the command out and removes the brackets from the reply, so say what you are doing in one short line and put the command after it.',
    'Use one of those forms per reply, and never when the user merely asked a question — "what is liquid glass" is a question, "make it liquid glass" is an order.',
  );
  return lines.join(' ');
}

// The system message is rebuilt when the language changes, so a switch takes
// effect on the very next reply rather than at the next restart.
function refreshSystemPrompt() {
  const content = systemPrompt();
  const existing = state.history.find((message) => message.role === 'system');
  if (existing) existing.content = content;
  else state.history.unshift({ role: 'system', content });
}

// The model writes its orders as [[open: X]] so that any local model can drive
// the machine without tool-calling support. They are taken out before the reply
// is shown or spoken.
const ACTION_TAG = /\[\[\s*(open|search|play|launch|start|run|notch)\s*:\s*([^\]]+?)\s*\]\]/gi;

function extractActions(text) {
  const actions = [];
  const clean = String(text || '').replace(ACTION_TAG, (_match, verb, target) => {
    const said = verb.toLowerCase();
    // Notch's own orders keep their word: it is what tells main this is about the
    // app rather than about whatever app the user named.
    const order = said === 'launch' || said === 'start' ? 'open' : said;
    actions.push(`${order} ${target.trim()}`);
    return '';
  });
  return { clean: clean.replace(/[ \t]+$/gm, '').trim(), actions };
}

// Moonshine is built for short clips on a CPU: the same sentence takes ~2 s here,
// where whisper-tiny needed 25 s without WASM threads. Main sends a better plan
// (whisper on WebGPU) when the machine has a real GPU.
const STT_MODELLING = 'onnx-community/moonshine-tiny-ONNX';
const STT_FALLBACK = '';
const STT_TIMEOUT = 20000;

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
    .replace(/\[\[[^\]]*\]\]/g, ' ')
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
  // Running without a downloaded model is still setup: there is nothing to talk
  // to yet.
  const ready = connected && state.status.models.length > 0;
  els.setup.hidden = ready;
  if (!ready) refreshSetupCard(connected);
}

// The first-run card: what this PC is, whether Ollama is here, and which model
// fits. One button does whichever of those is missing.
function refreshSetupCard(connected = state.status.running) {
  if (state.setupBusy || state.pulling) return;
  const recName = state.recommended ? modelLabel(state.recommended.name) : '';
  const hw = state.hardware;
  if (hw) {
    const bits = [`${hw.cores} CPU threads`, `${hw.ramGb} GB RAM`];
    if (hw.gpu) bits.push(hw.gpu);
    els.setupHw.textContent = `This PC: ${bits.join(' · ')}${recName ? ` · best fit: ${recName}` : ''}`;
  }
  if (connected) {
    els.setupTitle.textContent = 'Get the model for this PC';
    els.setupText.textContent = recName
      ? `${recName} is the largest model that still answers quickly here. It is downloaded once and stays on this machine.`
      : 'Download a model to start talking.';
    els.setupInstall.textContent = recName ? `Download ${recName}` : 'Download the model';
  } else {
    els.setupTitle.textContent = 'Set up Jarvis';
    els.setupText.textContent =
      'One click installs Ollama and fetches the model that fits this PC — no account, nothing sent anywhere.';
    els.setupInstall.textContent = 'Install Ollama';
  }
}

// Install, start, then download the model this machine was sized for.
async function runSetup() {
  if (state.setupBusy) return;
  state.setupBusy = true;
  els.setupInstall.disabled = true;
  els.setupRetry.disabled = true;
  els.setupProgress.hidden = false;
  els.setupBar.style.width = '4%';
  els.setupStatus.textContent = 'Looking for Ollama…';
  try {
    if (!state.status.running) {
      els.setupTitle.textContent = 'Setting up';
      const result = await api.installEngine().catch(() => null);
      if (!result || !result.ok) {
        els.setupTitle.textContent = 'Almost there';
        els.setupStatus.textContent =
          result && result.reason === 'winget'
            ? 'The Windows Package Manager is missing — opening the download page instead.'
            : 'The installer did not finish. Finish it, then press “I installed it”.';
        if (result && result.url) api.open(result.url);
        return;
      }
      await refreshStatus();
    }
    const name = state.recommended ? state.recommended.name : '';
    if (!name || state.status.models.length) {
      els.setupBar.style.width = '100%';
      els.setupStatus.textContent = 'Ready.';
      return;
    }
    els.setupBar.style.width = '8%';
    els.setupStatus.textContent = `Downloading ${modelLabel(name)}…`;
    await pull(name);
  } finally {
    state.setupBusy = false;
    els.setupInstall.disabled = false;
    els.setupRetry.disabled = false;
  }
}

// Progress from typing goes to the sheet; the same numbers feed the first-run
// card while it is on screen.
function mirrorSetupProgress(text, pct) {
  if (els.setup.hidden) return;
  els.setupProgress.hidden = false;
  if (typeof pct === 'number') {
    els.setupBar.style.width = `${Math.max(2, Math.min(100, pct))}%`;
  }
  if (text) els.setupStatus.textContent = text;
}

if (api.onInstall) {
  api.onInstall((data) => {
    if (!data) return;
    if (data.stage === 'error') toast(data.message || 'The install did not finish.');
    mirrorSetupProgress(data.message, data.pct);
  });
}

// ---------------------------------------------------------------- the voice

// One player at a time: a new reply cuts the old one off, the way a person
// would not talk over themselves.
let player = null;

// The voice leaves the synthesiser dry and a little thin. This is the small
// studio under it: a rumble cut, a lift in the chest, the harsh band around
// 3 kHz tamed, gentle compression so quiet words still carry, and a very short
// room. None of it costs render time, it just makes the clip sound recorded.
let voiceCtx = null;
let voiceChain = null;
let voiceFailed = false;

function roomImpulse(ctx, seconds) {
  const frames = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const buffer = ctx.createBuffer(2, frames, ctx.sampleRate);
  for (let channel = 0; channel < 2; channel += 1) {
    const data = buffer.getChannelData(channel);
    for (let i = 0; i < frames; i += 1) {
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / frames, 3.4);
    }
  }
  return buffer;
}

function voiceBus() {
  if (voiceChain) return voiceChain;
  if (voiceFailed) return null;
  try {
    const ctx = new AudioContext();
    const rumble = ctx.createBiquadFilter();
    rumble.type = 'highpass';
    rumble.frequency.value = 88;
    const chest = ctx.createBiquadFilter();
    chest.type = 'lowshelf';
    chest.frequency.value = 210;
    chest.gain.value = 2.6;
    const harsh = ctx.createBiquadFilter();
    harsh.type = 'peaking';
    harsh.frequency.value = 3300;
    harsh.Q.value = 1.1;
    harsh.gain.value = -2.2;
    const air = ctx.createBiquadFilter();
    air.type = 'highshelf';
    air.frequency.value = 7600;
    air.gain.value = 1.2;
    const level = ctx.createDynamicsCompressor();
    level.threshold.value = -21;
    level.knee.value = 18;
    level.ratio.value = 2.4;
    level.attack.value = 0.006;
    level.release.value = 0.22;
    const out = ctx.createGain();
    out.gain.value = 0.95;
    const room = ctx.createConvolver();
    room.buffer = roomImpulse(ctx, 0.26);
    const wet = ctx.createGain();
    wet.gain.value = 0.08;

    rumble.connect(chest);
    chest.connect(harsh);
    harsh.connect(air);
    air.connect(level);
    level.connect(out);
    out.connect(ctx.destination);
    out.connect(room);
    room.connect(wet);
    wet.connect(ctx.destination);

    voiceCtx = ctx;
    voiceChain = rumble;
    return voiceChain;
  } catch {
    voiceFailed = true;
    return null;
  }
}

// A semitone down, which is most of what makes the voice sound like a person
// with a chest rather than a reader. Piper rendered the clip slightly quick to
// pay for it, so the pace is unchanged.
const VOICE_PITCH = 0.95;

// The Danish voice is a different model with its own pitch and its own pacing:
// dropped a semitone it drags, and the model already speaks at a natural speed,
// so it plays as rendered and only the warmth chain is added.
function pitchFor(voiceId) {
  return String(voiceId || '').startsWith('da') ? 1 : VOICE_PITCH;
}

function wireVoice(audio, pitch = VOICE_PITCH) {
  try {
    audio.preservesPitch = false;
    audio.webkitPreservesPitch = false;
    audio.playbackRate = pitch;
  } catch {
    /* older engines keep their own pitch */
  }
  const chain = voiceBus();
  if (!chain) return;
  try {
    if (voiceCtx.state === 'suspended') voiceCtx.resume().catch(() => {});
    voiceCtx.createMediaElementSource(audio).connect(chain);
  } catch {
    /* the element plays straight to the speakers instead */
  }
}

// ------------------------------------------------------------- the studio voice

// Kokoro lives in a worker of its own: it is far heavier than Piper, and a
// frame drop in the window would be visible while it reads.
let studioWorker = null;
let studioReady = false;
let studioBroken = false;
let studioSeq = 0;
let studioWaiters = [];
const studioPending = new Map();

function studioSettleReady(ok) {
  studioReady = ok;
  const waiters = studioWaiters;
  studioWaiters = [];
  for (const done of waiters) done(ok);
}

function ensureStudio() {
  if (studioWorker) return studioWorker;
  if (studioBroken) return null;
  try {
    const worker = new Worker(new URL('./assistant-tts.worker.js', import.meta.url), { type: 'module' });
    studioWorker = worker;
    worker.onmessage = (event) => {
      const data = event.data || {};
      if (data.type === 'progress') {
        // The first use downloads the model; say so once rather than leaving the
        // reply silently waiting.
        if (!state.studioAnnounced && typeof data.pct === 'number') {
          state.studioAnnounced = true;
          toast('Preparing the studio voice — this happens once.', 4200);
        }
        return;
      }
      if (data.type === 'ready') {
        studioSettleReady(true);
        return;
      }
      if (data.type === 'error') {
        studioSettleReady(false);
        return;
      }
      if (data.type === 'result') {
        const done = studioPending.get(data.id);
        if (!done) return;
        studioPending.delete(data.id);
        done(data.samples && data.samples.length ? { samples: data.samples, rate: data.rate || 24000 } : null);
      }
    };
    worker.onerror = () => {
      studioBroken = true;
      studioSettleReady(false);
      studioWorker = null;
      for (const done of studioPending.values()) done(null);
      studioPending.clear();
    };
    worker.postMessage({ type: 'init', device: 'auto', voice: state.settings.studioVoice || 'bm_george' });
    return worker;
  } catch {
    studioBroken = true;
    return null;
  }
}

// Waits for the model the first time rather than answering with a fallback: the
// download only happens once, and after it the wait is nothing.
async function studioAwake(timeout) {
  if (studioReady) return true;
  const worker = ensureStudio();
  if (!worker) return false;
  if (studioBroken) return false;
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeout);
    studioWaiters.push((ok) => {
      clearTimeout(timer);
      resolve(!!ok);
    });
  });
}

async function studioRender(text) {
  const worker = ensureStudio();
  if (!worker) return null;
  if (!(await studioAwake(180000))) return null;
  return new Promise((resolve) => {
    const id = (studioSeq += 1);
    studioPending.set(id, resolve);
    worker.postMessage({ type: 'speak', id, text, voice: state.settings.studioVoice || 'bm_george' });
  });
}

// The studio voice already sounds recorded, so it goes through the same chain
// only for level and room, and is not pitched down.
function playSamples(samples, rate) {
  return new Promise((resolve) => {
    const chain = voiceBus();
    if (!chain) {
      resolve();
      return;
    }
    stopAudio();
    try {
      if (voiceCtx.state === 'suspended') voiceCtx.resume().catch(() => {});
      const buffer = voiceCtx.createBuffer(1, samples.length, rate);
      buffer.copyToChannel(samples, 0);
      const source = voiceCtx.createBufferSource();
      source.buffer = buffer;
      source.connect(chain);
      source.onended = () => {
        if (studioSource === source) studioSource = null;
        resolve();
      };
      studioSource = source;
      source.start();
    } catch {
      studioSource = null;
      resolve();
    }
  });
}

// A clip from the studio voice plays from memory rather than from a file, so it
// needs stopping separately.
let studioSource = null;

function stopAudio() {
  if (studioSource) {
    try {
      studioSource.stop();
    } catch {
      /* already over */
    }
    studioSource = null;
  }
  if (!player) return;
  try {
    player.pause();
    player.removeAttribute('src');
    player.load();
  } catch {
    /* already stopped */
  }
  player = null;
}

// Resolves when the clip is done, so a long reply can be spoken sentence by
// sentence without the next one cutting off the one before it.
function playFileWhenDone(url, voiceId) {
  return new Promise((resolve) => {
    stopAudio();
    const audio = new Audio(url);
    player = audio;
    wireVoice(audio, pitchFor(voiceId));
    const finish = () => {
      if (player === audio) player = null;
      resolve();
    };
    audio.addEventListener('ended', finish);
    audio.addEventListener('error', finish);
    audio.play().catch(finish);
  });
}

function playFile(url) {
  stopAudio();
  const audio = new Audio(url);
  player = audio;
  wireVoice(audio);
  audio.addEventListener('ended', () => {
    if (player === audio) player = null;
    setVoiceState('idle');
  });
  audio.play().catch(() => {
    // Autoplay refused or the file vanished: fall back to the system voice.
    if (player === audio) player = null;
    api.speak(stripForSpeech(els.thread.innerText).slice(-400));
  });
}

let speakTimer = 0;
// One utterance at a time, in order. The first sentence of a reply goes out
// while the rest of it is still being written.
let speechChain = Promise.resolve();
// Rendering a sentence costs about a second, so the next one is made while the
// one before it is being spoken. This chain runs ahead of the player, which is
// what keeps the voice from stopping between sentences.
let speechRender = Promise.resolve();
// The studio voice renders into the same kind of queue, separately, because the
// two are different workers.
let studioRenderChain = Promise.resolve();

// Piper reads a whole request before it writes a single note, so handing it a
// paragraph means silence while it works. Sentences are the natural unit
// anyway: the pauses between them are what make speech sound considered. The
// first piece is kept short so the reply is heard sooner rather than later.
function speechChunks(value, limit = 120, firstLimit = 60) {
  const sentences = value.match(/[^.!?;]+[.!?;]*\s*/g) || [value];
  const parts = [];
  for (const sentence of sentences) {
    if (sentence.trim().length <= limit) {
      parts.push(sentence);
      continue;
    }
    // A long sentence is broken at its commas: a breath in the middle of it is
    // what a person would do anyway.
    for (const piece of sentence.split(/(?<=,)\s+/)) parts.push(`${piece} `);
  }
  const chunks = [];
  let current = '';
  for (const part of parts) {
    const cap = chunks.length ? limit : firstLimit;
    if (current && current.length + part.length > cap) {
      chunks.push(current.trim());
      current = part;
    } else {
      current += part;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.length ? chunks : [value];
}

async function speakSystem(value) {
  api.speak(value);
  // The system voice gives no end signal, so guess from the length of the text.
  const words = value.split(/\s+/).filter(Boolean).length;
  clearTimeout(speakTimer);
  await new Promise((resolve) => {
    speakTimer = setTimeout(resolve, Math.max(1400, (words / 2.6) * 1000));
  });
}

function say(text) {
  const value = stripForSpeech(text);
  if (!value) return speechChain;
  if (window.__jarvis) {
    window.__jarvis.spoke.push({ t: Date.now(), text: value.slice(0, 48) });
    if (window.__jarvis.spoke.length > 20) window.__jarvis.spoke.shift();
  }
  if (state.settings.engine === 'system' || !state.neural.available) {
    speechChain = speechChain
      .then(() => speakSystem(value))
      .then(() => setVoiceState('idle'))
      .catch(() => {});
    return speechChain;
  }
  // The studio voice has no Danish, so a Danish reply goes to the Danish voice
  // instead of being read with an English accent.
  const useStudio =
    state.settings.engine === 'studio' && state.studio.available && !studioBroken && !looksDanish(value);
  if (useStudio) ensureStudio();
  // Start rendering now, rather than once the sentence before has been spoken.
  let render = useStudio ? studioRenderChain : speechRender;
  const clips = speechChunks(value).map((chunk) => {
    render = render.then(() =>
      useStudio ? studioRender(chunk) : api.speakNeural(chunk).catch(() => null),
    );
    return { chunk, clip: render };
  });
  if (useStudio) studioRenderChain = render.then(
    () => null,
    () => null,
  );
  else speechRender = render.then(
    () => null,
    () => null,
  );

  speechChain = speechChain
    .then(async () => {
      setVoiceState('speaking');
      for (let index = 0; index < clips.length; index += 1) {
        const clip = await clips[index].clip;
        if (useStudio) {
          if (clip && clip.samples) {
            await playSamples(clip.samples, clip.rate);
            continue;
          }
          // The studio voice was not ready or could not read that line: the fast
          // voice is always there, so the reply is still spoken.
          const spare = await api.speakNeural(clips[index].chunk).catch(() => null);
          if (spare && spare.ok && spare.url) {
            await playFileWhenDone(spare.url, spare.voice);
            continue;
          }
          await speakSystem(clips.slice(index).map((item) => item.chunk).join(' '));
          break;
        }
        if (clip && clip.ok && clip.url) {
          if (clip.voice) state.lastVoice = clip.voice;
          await playFileWhenDone(clip.url, clip.voice);
          continue;
        }
        // That line could not be synthesised: finish the rest of the reply with
        // the system voice rather than leaving a hole in it.
        await speakSystem(clips.slice(index).map((item) => item.chunk).join(' '));
        break;
      }
      setVoiceState('idle');
    })
    .catch(() => setVoiceState('idle'));
  return speechChain;
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

  // "open spotify" is an order, not a question: do it, then say so.
  const action = await api.act(prompt).catch(() => null);
  if (action && action.handled) {
    const reply = action.say || 'Done.';
    els.input.value = '';
    autosize();
    addMessage('user', prompt);
    addMessage('assistant', reply);
    state.history.push({ role: 'user', content: prompt }, { role: 'assistant', content: reply });
    trimHistory();
    if (state.settings.speak) say(reply);
    else setVoiceState('idle');
    followUpIfAsked(reply);
    return;
  }

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
  setVoiceState('thinking');

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

// Jarvis asked something, so the answer is the next thing said: the microphone
// opens again by itself instead of waiting for the wake word. It only happens
// hands-free (wake word on) and only when the question is actually spoken, and
// it needs a real question — a reply that ends in a full stop does not trigger it.
function followUpIfAsked(reply) {
  if (!state.settings.wake || !state.settings.speak) return;
  const value = String(reply || '').trim();
  if (!value) return;
  const lastSentence = value.split(/(?<=[.!?])\s+/).pop() || value;
  if (!lastSentence.includes('?')) return;
  speechChain
    .then(() => {
      if (state.busy || !state.settings.wake) return null;
      // The reply is still in the room after the last word — the speakers ring
      // for a moment and the room echoes — and a microphone opened into that
      // records Jarvis answering itself. So the room is given until it is quiet
      // again before listening starts.
      return new Promise((resolve) => {
        const started = Date.now();
        const tick = setInterval(() => {
          const quiet = !audio || audio.silence >= 3 || Date.now() - started > 3000;
          if (!quiet) return;
          clearInterval(tick);
          resolve();
        }, 90);
      });
    })
    .then(() => new Promise((resolve) => setTimeout(resolve, 360)))
    .then(() => {
      if (state.busy || !state.settings.wake) return null;
      toast('Listening…', 1600);
      return listenOnce({ followUp: true });
    })
    .catch(() => {});
}

function finishStream(text, aborted) {
  if (!state.stream) return;
  const { body } = state.stream;
  const spokenAt = state.stream.spokenAt || 0;
  state.stream = null;
  setBusy(false);

  const { clean, actions } = extractActions(text);
  const card = body.closest('.msg');
  if (!clean.trim() && card) card.remove();
  else body.textContent = clean;

  // Anything the model asked for happens now, after it has answered.
  for (const action of actions) api.act(action).catch(() => {});

  if (clean.trim()) {
    state.history.push({ role: 'assistant', content: clean });
    trimHistory();
    trimHistory();
    if (state.settings.speak && !aborted) {
      const rest = clean.slice(Math.min(spokenAt, clean.length)).trim();
      if (rest) say(rest);
      else if (!spokenAt) say(clean);
    } else setVoiceState('idle');
    if (!aborted) followUpIfAsked(clean);
  } else {
    setVoiceState('idle');
  }
  scrollDown();
}

// Speak the first finished sentence before the reply is complete: waiting for
// the last token is what made the assistant feel slow to answer.
function speakFirstSentence(stream) {
  if (!state.settings.speak || stream.spokenAt) return;
  const match = stream.text.match(/^([\s\S]{24,}?[.!?])(?:\s|$)/);
  if (!match) return;
  stream.spokenAt = match[1].length;
  say(match[1]);
}

api.onDelta((chunk) => {
  if (!state.stream) return;
  state.stream.text += chunk;
  speakFirstSentence(state.stream);
  const body = state.stream.body;
  // Commands are for the machine, not for the eye: hide them as they arrive.
  body.textContent = extractActions(state.stream.text).clean;
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
    const isRecommended = !!preset.recommended;
    card.className = `preset${isInstalled ? ' installed' : ''}${isRecommended ? ' rec' : ''}`;
    card.innerHTML = '';
    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = preset.label;
    const note = document.createElement('span');
    note.className = 'note';
    note.textContent = isInstalled ? 'Installed' : isRecommended ? 'Best for this PC' : preset.note;
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

function showHardware() {
  const hw = state.hardware;
  const rec = state.recommended;
  if (!hw) return;
  const bits = [`${hw.cores} CPU threads`, `${hw.ramGb} GB RAM`, hw.integrated ? `${hw.gpu} (integrated)` : `${hw.gpu} (${hw.vramGb} GB)`];
  const recName = rec ? (state.presets.find((p) => p.name === rec.name) || {}).label || rec.name : '';
  els.hwLine.textContent = rec
    ? `${bits.join(' · ')}. ${rec.reason} Suggested: ${recName}.`
    : `${bits.join(' · ')}.`;
  if (els.voiceLine) {
    const studio = state.studio;
    els.voiceLine.textContent = studio.recommended
      ? `${studio.note} Choose a studio voice below for the best this machine can do.`
      : `${studio.note} “Jarvis” is the voice that suits this machine.`;
  }
}

// Nothing installed yet? Fetch the model this machine was made for.
let autoPullStarted = false;
function maybeAutoPull() {
  if (autoPullStarted || state.pulling) return;
  if (!state.status.running || !state.recommended) return;
  if (state.status.models.length) return;
  autoPullStarted = true;
  const preset = state.presets.find((p) => p.name === state.recommended.name);
  toast(`Downloading ${preset ? preset.label : state.recommended.name} — the model that fits this PC.`, 5000);
  pull(state.recommended.name);
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
    // Whatever fits this machine wins over whatever happens to be installed.
    const wanted = state.recommended && state.recommended.name;
    const preferred =
      (wanted && state.status.models.find((m) => m.name === wanted)) ||
      state.status.models.find((m) => m.name.includes('1.5b')) ||
      state.status.models[0];
    selectModel(preferred.name);
  }
  renderModels();
  renderPresets();
  refreshModelChip();
  maybeAutoPull();
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
    mirrorSetupProgress('Done — loading the model.', 100);
    return;
  }
  if (payload.total > 0) {
    const pct = Math.max(2, Math.min(100, Math.round((payload.completed / payload.total) * 100)));
    els.pullBar.style.width = `${pct}%`;
    els.pullText.textContent = `${payload.status || 'Downloading'} · ${pct}% of ${formatSize(payload.total)}`;
    mirrorSetupProgress(`${payload.status || 'Downloading'} · ${pct}% of ${formatSize(payload.total)}`, pct);
  } else {
    els.pullBar.style.width = '8%';
    els.pullText.textContent = payload.status || 'Working…';
    mirrorSetupProgress(payload.status || 'Working…');
  }
  if (payload.error) toast(payload.error);
});

// ---------------------------------------------------------------------- voice

// A model load can wedge (a busy first second, a slow disk): throw the worker
// away and start another one instead of pretending to listen forever.
function dropStt(worker, why) {
  clearTimeout(worker && worker.loadTimer);
  try {
    worker.terminate();
  } catch {
    /* already gone */
  }
  if (state.stt !== worker) return;
  state.stt = null;
  if (state.sttAttempts >= 3) {
    els.sttLine.textContent = 'Speech model unavailable — the microphone still types nothing, sorry.';
    return;
  }
  if (why) els.sttLine.textContent = why;
  setTimeout(() => {
    if (!state.stt) ensureStt();
  }, 1500);
}

function ensureStt() {
  if (state.stt) return state.stt;
  state.sttAttempts = (state.sttAttempts || 0) + 1;
  const worker = new Worker(new URL('./assistant-stt.worker.js', import.meta.url), { type: 'module' });
  state.stt = worker;
  worker.pending = null;
  worker.ready = false;
  worker.loadTimer = setTimeout(() => {
    if (!worker.ready) dropStt(worker, 'Speech model was slow to start — trying again.');
  }, 45000);
  worker.onerror = () => dropStt(worker, 'Speech model failed to start — trying again.');
  worker.onmessage = (event) => {
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
      worker.ready = true;
      worker.threads = data.threads || 0;
      worker.device = data.device || '';
      clearTimeout(worker.loadTimer);
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
  const plan = state.sttPlan || {};
  state.stt.postMessage({
    type: 'init',
    model: plan.model || STT_MODELLING,
    fallback: plan.fallback ?? STT_FALLBACK,
    device: plan.device || 'auto',
    language: plan.language || null,
  });
  return state.stt;
}

function transcribe(samples) {
  const worker = ensureStt();
  return new Promise((resolve) => {
    if (worker.pending) {
      resolve('');
      return;
    }
    let done = false;
    const finish = (text) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (worker.pending === finish) worker.pending = null;
      resolve(text);
    };
    worker.pending = finish;
    // A wedged inference must never block every later phrase: start over. The
    // first call can include loading the model, so it gets a longer rope.
    const timer = setTimeout(() => {
      finish('');
      dropStt(worker, 'Speech model stopped answering — restarting it.');
      state.sttAnnounced = false;
    }, worker.ready ? STT_TIMEOUT : 60000);
    const copy = normalizeAudio(samples);
    worker.postMessage({ type: 'transcribe', audio: copy }, [copy.buffer]);
  });
}

// Quiet speech is the usual reason a phrase comes back wrong. Lift it to a
// sensible level (without clipping) before the model sees it.
function normalizeAudio(samples) {
  const out = new Float32Array(samples);
  let peak = 0;
  for (let i = 0; i < out.length; i += 1) {
    const value = Math.abs(out[i]);
    if (value > peak) peak = value;
  }
  if (peak > 0.004 && peak < 0.85) {
    const gain = Math.min(6, 0.9 / peak);
    for (let i = 0; i < out.length; i += 1) {
      out[i] = Math.max(-1, Math.min(1, out[i] * gain));
    }
  }
  return out;
}

let audio = null;

async function ensureAudio() {
  if (audio) return audio;
  const stream = await navigator.mediaDevices.getUserMedia({
    // Automatic gain keeps a quiet speaker as audible as a loud one.
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  const context = new AudioContext({ sampleRate: 16000 });
  const source = context.createMediaStreamSource(stream);
  const analyser = context.createAnalyser();
  analyser.fftSize = 1024;
  source.connect(analyser);
  audio = { stream, context, source, analyser, processor: null, buffers: [], running: false };
  return audio;
}

// Let the microphone go entirely. Stopping the loop alone leaves the capture
// stream open, and an open stream keeps the machine's audio service awake for as
// long as anything is running — which is exactly what a game should not pay for.
function releaseMicrophone() {
  const a = audio;
  audio = null;
  if (!a) return;
  try {
    if (a.processor) a.processor.disconnect();
  } catch {
    /* already detached */
  }
  try {
    a.source.disconnect();
  } catch {
    /* already detached */
  }
  try {
    for (const track of a.stream.getTracks()) track.stop();
  } catch {
    /* stream already gone */
  }
  try {
    a.context.close();
  } catch {
    /* already closed */
  }
}

function recorderStart(threshold = 0.012) {
  const a = audio;
  if (!a) return;
  a.buffers = [];
  a.levels = [];
  a.threshold = threshold;
  a.voice = false;
  a.silence = 0;
  a.blocks = 0;
  a.loud = 0;
  a.floorLevel = null;
  a.processor = a.context.createScriptProcessor(4096, 1, 1);
  a.processor.onaudioprocess = (event) => {
    const data = event.inputBuffer.getChannelData(0);
    a.buffers.push(new Float32Array(data));
    let sum = 0;
    for (let i = 0; i < data.length; i += 1) sum += data[i] * data[i];
    const rms = Math.sqrt(sum / data.length);
    a.levels.push(rms);
    a.level = rms;
    // Learn the room, not a fixed number: microphones differ by a factor of
    // twenty, and a gate set for a loud one made a quiet one deaf. Only quiet
    // blocks teach the floor, so speech never drags it up.
    if (a.floorLevel === null) a.floorLevel = Math.max(0.0004, rms);
    else if (rms < a.floorLevel * 1.8) a.floorLevel = a.floorLevel * 0.92 + rms * 0.08;
    a.gate = Math.max(0.004, a.floorLevel * 2.4, threshold * 0.6);
    if (rms > a.gate) {
      a.voice = true;
      a.silence = 0;
      a.loud += 1;
    } else if (a.voice) {
      a.silence += 1;
    }
    a.blocks += 1;
  };
  a.source.connect(a.processor);
  a.processor.connect(a.context.destination);
}

// What the take contains, without the silence in front of and behind it: the
// model's cost is linear in audio length, and a short blip inside a long take
// should not pay for the quiet parts.
function trimTake(a) {
  const total = a.buffers.reduce((sum, chunk) => sum + chunk.length, 0);
  let out = new Float32Array(total);
  let offset = 0;
  for (const chunk of a.buffers) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  const levels = a.levels || [];
  const floor = a.gate || a.threshold || 0.012;
  let first = -1;
  let last = -1;
  for (let i = 0; i < levels.length; i += 1) {
    if (levels[i] > floor) {
      if (first < 0) first = i;
      last = i;
    }
  }
  if (first >= 0) {
    const start = Math.max(0, first - 1) * 4096;
    const end = Math.min(out.length, (last + 2) * 4096);
    if (end > start) out = out.slice(start, end);
  }
  return out;
}

// Take what the microphone has heard and start a fresh take. The stream itself
// keeps running, so a phrase can never fall into the gap between recordings.
function recorderTake() {
  const a = audio;
  if (!a) return new Float32Array(0);
  const out = trimTake(a);
  a.buffers = [];
  a.levels = [];
  a.voice = false;
  a.silence = 0;
  a.blocks = 0;
  a.loud = 0;
  return out;
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
  return recorderTake();
}

function setListening(value) {
  document.body.dataset.listening = value ? 'true' : 'false';
}

// A small two-note chime for the moment it hears its name. Cheaper and quicker
// than saying "yes", and short enough that the microphone does not mistake it
// for the start of a command.
let chimeCtx = null;

function wakeChime() {
  try {
    chimeCtx = chimeCtx || new AudioContext();
    if (chimeCtx.state === 'suspended') chimeCtx.resume();
    const now = chimeCtx.currentTime + 0.02;
    const notes = [
      { freq: 784, at: 0, gain: 0.24 },
      { freq: 1175, at: 0.11, gain: 0.17 },
    ];
    for (const note of notes) {
      const osc = chimeCtx.createOscillator();
      const amp = chimeCtx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(note.freq, now + note.at);
      amp.gain.setValueAtTime(0.0001, now + note.at);
      amp.gain.exponentialRampToValueAtTime(note.gain, now + note.at + 0.02);
      amp.gain.exponentialRampToValueAtTime(0.0001, now + note.at + 0.34);
      osc.connect(amp);
      amp.connect(chimeCtx.destination);
      osc.start(now + note.at);
      osc.stop(now + note.at + 0.38);
    }
  } catch {
    /* no audio device, no chime — listening still works */
  }
}

// ------------------------------------------------------- the presence on screen

// Listening, thinking, speaking. The HUD at the bottom of the screen follows
// this, and the microphone level is posted with it so the light moves with the
// voice instead of looping blindly.
let voiceState = 'idle';
let voiceMeter = 0;

function setVoiceState(next) {
  if (voiceState === next) return;
  voiceState = next;
  api.voiceState({ state: next });
  clearInterval(voiceMeter);
  if (next === 'listening') {
    voiceMeter = setInterval(() => {
      const level = audio ? Math.min(1, (audio.level || 0) * 4.5) : 0;
      api.voiceLevel(level);
    }, 90);
  }
}

async function listenOnce(options = {}) {
  if (state.busy) {
    if (!options.followUp) toast('One thing at a time.');
    return;
  }
  // The wake listener owns the microphone; hand it over for this recording and
  // pick listening back up afterwards.
  const wasWaking = pauseWake();
  try {
    await recordAndSend(options);
  } finally {
    if (wasWaking) startWakeLoop();
  }
}

async function recordAndSend(options = {}) {
  try {
    await ensureAudio();
  } catch {
    toast('Microphone blocked — check Windows privacy settings.');
    return;
  }
  if (audio.context.state === 'suspended') await audio.context.resume();

  setListening(true);
  setVoiceState('listening');
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

  // After a question of its own, nothing said is a normal end to the conversation
  // rather than a failed recording, so it is left without a complaint.
  if (!samples.length || samples.length < 1600) {
    setVoiceState('idle');
    if (!options.followUp) toast('I did not catch that.');
    return;
  }
  if (!options.followUp) toast('Transcribing…', 1400);
  const text = await transcribe(samples);
  const clean = String(text || '').trim();
  if (!clean) {
    setVoiceState('idle');
    if (!options.followUp) toast('I did not catch that.');
    return;
  }
  const stripped = clean
    .replace(/^(hey|hi|hej|hejsa|okay|ok|halløj)[,\s]*jarvis[,\s.!:-]*/i, '')
    .trim();
  const command = stripped || clean;
  els.input.value = command;
  autosize();
  send(command);
}

// The speech model never spells "Jarvis" the same way twice, and there may or
// may not be a greeting in front of it, so the name is matched by shape: any of
// the usual spellings, or a word one letter away from it, in the first few words
// of the phrase.
const WAKE_NAME = /^(?:jarvis|jarv[ie]s|jarwis|jarvus|javis|charvis|harvis|garvis|jarves)\b/i;

function closeEnough(word) {
  const value = word.toLowerCase().replace(/[^a-z]/g, '');
  if (value.length < 5) return false;
  if (value.startsWith('jarvis')) return true;
  const target = 'jarvis';
  if (Math.abs(value.length - target.length) > 1) return false;
  // One letter swapped: jorvis, jervis, jarwis.
  if (value.length === target.length) {
    let misses = 0;
    for (let i = 0; i < value.length; i += 1) {
      if (value[i] !== target[i]) misses += 1;
      if (misses > 1) return false;
    }
    return true;
  }
  // One letter dropped or added: jarvi, jarvisss, jarviss.
  const longer = value.length > target.length ? value : target;
  const shorter = value.length > target.length ? target : value;
  for (let skip = 0; skip < longer.length; skip += 1) {
    if (longer.slice(0, skip) + longer.slice(skip + 1) === shorter) return true;
  }
  return false;
}

// Within a conversation the name on its own is enough. After a while away it
// takes a greeting in front of it — "hey Jarvis", "hej Jarvis", "okay Jarvis" — so
// that the television saying a name at an empty desk does not start one.
const WAKE_GREETING = /^(hey|hej|hejsa|hejhej|hi|ok|okay|okey|hallo|halløj|goddag|yo)$/i;
const WAKE_FRESH_MS = 5 * 60 * 1000;
let lastWakeAt = 0;

function wakeNeedsGreeting() {
  return Date.now() - lastWakeAt > WAKE_FRESH_MS;
}

function wakeCommand(text, requireGreeting = false) {
  const words = String(text || '').replace(/\s+/g, ' ').trim().split(' ');
  if (!words.length || !words[0]) return null;
  const head = Math.min(words.length, 4);
  for (let i = 0; i < head; i += 1) {
    const bare = words[i].replace(/[^a-zA-ZæøåÆØÅ]/g, '');
    if (!bare) continue;
    if (!WAKE_NAME.test(bare) && !closeEnough(bare)) continue;
    if (requireGreeting) {
      const before = words
        .slice(0, i)
        .map((word) => word.replace(/[^a-zA-ZæøåÆØÅ]/g, ''))
        .filter(Boolean);
      const greeting = before.length > 0 && WAKE_GREETING.test(before[before.length - 1]);
      // A cold wake needs the greeting: the name by itself is passed over here,
      // and the phrase keeps listening for a better one.
      if (!greeting) return null;
    }
    return words
      .slice(i + 1)
      .join(' ')
      .replace(/^[,.:;!?\-\s]+/, '')
      .trim();
  }
  return null;
}

// The listener records all the time and transcribes each finished phrase. The
// old version recorded a fixed window, transcribed it, waited, then recorded
// again — and anything said in the gaps or straddling a window was simply lost.
let wakeTimer = 0;
let wakeListening = false;
let wakeBusy = false;

function stopWakeLoop() {
  clearInterval(wakeTimer);
  wakeTimer = 0;
  if (!wakeListening) return;
  wakeListening = false;
  recorderStop();
  setListening(false);
}

function pauseWake() {
  if (!wakeListening) return false;
  stopWakeLoop();
  return true;
}

async function startWakeLoop() {
  if (!state.settings.wake || wakeListening) return;
  try {
    await ensureAudio();
  } catch {
    toast('Microphone blocked — wake word off.');
    els.wakeToggle.checked = false;
    state.settings.wake = false;
    api.save({ wake: false });
    return;
  }
  if (!state.settings.wake || wakeListening) return;
  if (audio.context.state === 'suspended') await audio.context.resume();
  if (audio.processor) recorderStop();
  // A gentler gate than the mic button needs: the room only has to sound like
  // speech, not like shouting, before the phrase is worth transcribing.
  recorderStart(0.008);
  wakeListening = true;
  clearInterval(wakeTimer);
  wakeTimer = setInterval(wakeTick, 110);
}

function wakeTick() {
  const a = audio;
  if (!a || !a.processor) return;
  if (wakeBusy) {
    // The model is still reading the last phrase; do not let this pile up
    // forever if it wedges.
    if (a.buffers.length > 48) recorderTake();
    return;
  }
  if (state.busy) {
    if (a.buffers.length > 48) recorderTake();
    return;
  }
  const long = a.blocks * 4096 >= 16000 * 9;
  const done = a.voice && a.silence >= 4;
  if (!done && !long) return;
  const loud = a.loud;
  const samples = recorderTake();
  // One loud block is a quarter of a second, which is all a quick "Jarvis" takes.
  // Asking for two made the shortest, most natural way of waking it the one that
  // never arrived; a stray noise costs a short transcription and nothing else,
  // because a phrase without the name is dropped on the next line.
  if (loud < 1 || samples.length < 5000) return;
  wakeBusy = true;
  transcribe(samples)
    .then((text) => {
      const command = wakeCommand(text, wakeNeedsGreeting());
      if (command === null) return null;
      lastWakeAt = Date.now();
      wakeChime();
      setVoiceState('listening');
      if (command.length > 1) {
        els.input.value = command;
        autosize();
        send(command);
        return null;
      }
      toast('Listening…', 1500);
      // The name on its own is a wake-up call, not a command: listen for the
      // order, and if none comes, go quietly back to waiting.
      return listenOnce({ followUp: true });
    })
    .catch(() => {})
    .finally(() => {
      wakeBusy = false;
    });
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
  const studio = state.studio.available ? state.studio.voices : [];
  for (const voice of studio) {
    const option = document.createElement('option');
    option.value = `studio:${voice.id}`;
    option.textContent = `${voice.label} · ${voice.note}`;
    els.voiceSelect.appendChild(option);
  }
  const neural = state.neural.available ? state.neural.voices : [];
  for (const voice of neural) {
    const option = document.createElement('option');
    option.value = `neural:${voice.id}`;
    option.textContent = `${voice.label} · ${voice.note}`;
    els.voiceSelect.appendChild(option);
  }
  for (const voice of state.voices) {
    const option = document.createElement('option');
    option.value = `system:${voice.name}`;
    option.textContent = `${voice.name.replace('Microsoft ', '').replace(' Desktop', '')} · ${voice.culture}`;
    els.voiceSelect.appendChild(option);
  }
  // A select picks its first option on its own, so the choice is made here and
  // only applied if that option really exists.
  const has = (value) => [...els.voiceSelect.options].some((option) => option.value === value);
  let chosen = '';
  if (state.settings.engine === 'studio' && studio.length) {
    chosen = `studio:${state.settings.studioVoice || studio[0].id}`;
    if (!has(chosen)) chosen = `studio:${studio[0].id}`;
  } else if (state.settings.engine !== 'system' && neural.length) {
    chosen = `neural:${state.settings.neuralVoice || neural[0].id}`;
    if (!has(chosen)) chosen = `neural:${neural[0].id}`;
  } else if (state.voices.length) {
    chosen = `system:${state.settings.voice || state.voices[0].name}`;
    if (!has(chosen)) chosen = `system:${state.voices[0].name}`;
  }
  if (chosen && has(chosen)) els.voiceSelect.value = chosen;
}

function applySettingsToUi() {
  els.speakToggle.checked = !!state.settings.speak;
  els.wakeToggle.checked = !!state.settings.wake;
  if (els.languageSelect) els.languageSelect.value = state.settings.language || 'auto';
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
els.hideBtn.addEventListener('click', () => {
  stopAudio();
  setVoiceState('idle');
  api.hide();
});
els.modelChip.addEventListener('click', openSheet);
els.setupInstall.addEventListener('click', () => {
  // Running already? The missing piece is the model, not the engine.
  if (state.status.running && state.status.models.length === 0) {
    const name = state.recommended ? state.recommended.name : '';
    if (name) {
      els.setupProgress.hidden = false;
      els.setupBar.style.width = '6%';
      els.setupStatus.textContent = `Downloading ${modelLabel(name)}…`;
      pull(name);
      return;
    }
  }
  runSetup();
});
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
  if (!state.settings.speak) {
    stopAudio();
    api.hush();
    setVoiceState('idle');
  }
});

els.voiceSelect.addEventListener('change', () => {
  const value = els.voiceSelect.value || '';
  if (value.startsWith('studio:')) {
    state.settings.engine = 'studio';
    state.settings.studioVoice = value.slice('studio:'.length);
    api.save({ engine: 'studio', studioVoice: state.settings.studioVoice });
    ensureStudio();
  } else if (value.startsWith('neural:')) {
    state.settings.engine = 'neural';
    state.settings.neuralVoice = value.slice('neural:'.length);
    api.save({ engine: 'neural', neuralVoice: state.settings.neuralVoice });
  } else if (value.startsWith('system:')) {
    state.settings.engine = 'system';
    state.settings.voice = value.slice('system:'.length);
    api.save({ engine: 'system', voice: state.settings.voice });
  }
  say('At your service, sir.');
});

if (els.languageSelect) {
  els.languageSelect.addEventListener('change', () => {
    state.settings.language = els.languageSelect.value;
    api.save({ language: state.settings.language });
    refreshSystemPrompt();
    // The listening model depends on the language, so the next recording rebuilds
    // it, and the voice for it is warmed now rather than mid-sentence.
    if (state.stt) {
      const worker = state.stt;
      state.stt = null;
      try {
        worker.terminate();
      } catch {
        /* already gone */
      }
    }
    state.sttAttempts = 0;
    state.sttAnnounced = false;
    api.warmVoice();
    api.boot().then((data) => {
      if (data && data.stt) {
        state.sttPlan = data.stt;
        if (els.sttLine && data.stt.note) els.sttLine.textContent = data.stt.note;
      }
    });
    say(
      state.settings.language === 'da'
        ? 'Godaften. Klar til tjeneste, hr.'
        : state.settings.language === 'en'
          ? 'At your service, sir.'
          : 'At your service, sir. Godaften.',
    );
  });
}

els.rateRange.addEventListener('input', () => {
  state.settings.rate = Number(els.rateRange.value) || 0;
  api.save({ rate: state.settings.rate });
});

els.testVoice.addEventListener('click', () => {
  say('All systems nominal, sir. The model is ready when you are.');
});

els.wakeToggle.addEventListener('change', () => {
  state.settings.wake = els.wakeToggle.checked;
  api.save({ wake: state.settings.wake });
  if (state.settings.wake) {
    toast('Say “Hey Jarvis”.', 2200);
    startWakeLoop();
  } else {
    stopWakeLoop();
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
    stopAudio();
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

// A game owns the machine: the microphone is closed, the speech model is thrown
// away, and the window stays parked until the game is over. Twice-called by
// design (message and direct call), so it remembers what it has already done.
let gameModeSeen = null;

function applyGameMode(on) {
  if (gameModeSeen === on) return;
  gameModeSeen = on;
  if (on) {
    state.gamePaused = pauseWake();
    releaseMicrophone();
    setListening(false);
    setVoiceState('idle');
    stopAudio();
  } else if (state.gamePaused) {
    state.gamePaused = false;
    startWakeLoop();
    // Loading a model is a few seconds of disk and CPU, so it waits until the
    // game is actually gone rather than racing its last frames.
    setTimeout(() => {
      if (!state.stt) ensureStt();
    }, 2500);
  }
}

// A hook for testing the wake word with recorded audio (no microphone needed).
window.__jarvis = {
  transcribe,
  say,
  gameMode: null,
  voice: () => ({
    busy: !!voiceChain,
    failed: voiceFailed,
    state: voiceCtx ? voiceCtx.state : null,
    rate: player ? player.playbackRate : null,
    studio: !!studioSource,
    studioReady,
    last: state.lastVoice || '',
    prompt: (state.history[0] && state.history[0].content) || '',
    hud: voiceState,
    wake: wakeListening,
    stt: !!state.stt,
    paused: !!state.gamePaused,
    sinceWake: lastWakeAt ? Date.now() - lastWakeAt : null,
    needsGreeting: wakeNeedsGreeting(),
  }),
  followUp: followUpIfAsked,
  sttModel: (model, language) => {
    if (state.stt) {
      try {
        state.stt.terminate();
      } catch {
        /* already gone */
      }
      state.stt = null;
    }
    state.sttAttempts = 0;
    state.sttPlan = {
      ...(state.sttPlan || {}),
      model,
      fallback: model,
      device: 'auto',
      language: language || (state.sttPlan && state.sttPlan.language) || null,
    };
    ensureStt();
    return state.sttPlan;
  },
  stt: () => ({
    pending: !!(state.stt && state.stt.pending),
    ready: !!(state.stt && state.stt.ready),
    threads: (state.stt && state.stt.threads) || 0,
    model: (state.sttPlan && state.sttPlan.model) || '',
    device: (state.stt && state.stt.device) || '',
    isolated: window.crossOriginIsolated === true,
    cores: navigator.hardwareConcurrency || 0,
    attempts: state.sttAttempts,
    plan: state.sttPlan || null,
    line: (els.sttLine && els.sttLine.textContent) || '',
  }),
  wakeCommand,
  wake: () => ({
    listening: wakeListening,
    busy: wakeBusy,
    level: audio ? Number((audio.level || 0).toFixed(3)) : null,
    loud: audio ? audio.loud : 0,
  }),
  chime: wakeChime,
  spoke: [],
  setup: { run: runSetup, refresh: refreshSetupCard },
};

// Wired at load, not at the end of boot: boot gives up when main does not answer
// its first question, and a game can start at any moment.
api.onGameMode(applyGameMode);
// Main also calls this straight into the page: a hidden, throttled renderer can
// sit on a queued message, and letting go of the microphone cannot wait for that.
window.__jarvis.gameMode = applyGameMode;



// ----------------------------------------------------------------------- boot

(async function boot() {
  const data = await api.boot();
  if (!data) return;
  state.settings = { ...state.settings, ...(data.settings || {}) };
  state.status = data.status || state.status;
  state.presets = data.presets || [];
  state.hardware = data.hardware || null;
  state.recommended = data.recommended || null;
  state.neural = data.neural || { available: false, voices: [] };
  state.studio = data.studio || state.studio;
  state.sttPlan = data.stt || null;
  if (els.sttLine && state.sttPlan && state.sttPlan.note) els.sttLine.textContent = state.sttPlan.note;
  state.voices = data.voices || [];
  state.history = [{ role: 'system', content: systemPrompt() }];

  applySettingsToUi();
  fillVoices();

  // The studio voice takes a while to load, so start it before it is asked for.
  if (state.settings.engine === 'studio' && state.studio.available) ensureStudio();
  setConnected(state.status.running, state.status.version);
  refreshModelChip();
  renderModels();
  renderPresets();
  showHardware();
  if (state.status.models.length && !state.settings.model) {
    const wanted = state.recommended && state.recommended.name;
    const match = wanted && state.status.models.find((m) => m.name === wanted);
    selectModel((match || state.status.models[0]).name);
  }
  maybeAutoPull();
  // Load the voice model now so the first spoken reply is not slow.
  if (state.neural.available) api.warmVoice().catch(() => {});
  // Put the brain in video memory before the first order rather than during it:
  // the reply then starts at the first token instead of after a 4.7 GB load.
  if (state.settings.model && state.status.running && api.warm) api.warm().catch(() => {});
  // Warm the speech model once, a beat after boot: loading it while the window
  // is still settling is what used to leave it stuck at 100%, and without this
  // the first phrase you say pays the whole 20-second load.
  setTimeout(() => {
    if (!state.stt) ensureStt();
  }, 2500);
  // The wake word survives restarts: pick listening back up where it left off.
  if (state.settings.wake) {
    startWakeLoop();
  }

  refreshSetupCard();
  els.input.focus();
})();

// Keep the connection chip honest without polling hard.
setInterval(() => {
  if (document.visibilityState !== 'visible') return;
  if (els.sheet.hidden && !state.busy) refreshStatus();
}, 8000);

// A model Ollama has unloaded (an idle timeout, a game taking the card) is put
// back the moment the window is in front of the user again, not when they ask.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (state.settings.model && state.status.running && api.warm) api.warm().catch(() => {});
  if (!state.busy) refreshStatus();
});
