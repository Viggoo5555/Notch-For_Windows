'use strict';

const $ = (selector, root = document) => root.querySelector(selector);
const bridge = window.notchAPI;
// The demo page is dev-server-only: it is served over http and has no preload. In
// the app the page is a file:// document, so a missing bridge there is not a demo —
// it is the shell failing to load, and it must not paint the demo backdrop over the
// screen as if everything were fine.
const served = location.protocol === 'http:' || location.protocol === 'https:';
const isDemo = !bridge && served;

if (isDemo) document.documentElement.classList.add('demo');
else if (!bridge) {
  document.documentElement.classList.add('nobridge');
  const hint = $('.demo-hint');
  if (hint) hint.textContent = 'Notch is not connected here — start the app from Notch.exe';
}

const api = bridge || createDemoBridge();

const DIAL_R = 39;
const DIAL_C = 2 * Math.PI * DIAL_R;
const MINI_R = 7.6;
const MINI_C = 2 * Math.PI * MINI_R;
const DETAIL_R = 52;
const DETAIL_C = 2 * Math.PI * DETAIL_R;

const state = {
  open: false,
  pinned: false,
  busy: false,
  games: [],
  icons: {},
  settingsOpen: false,
  detail: null,
  // The store is drawn here from Steam's own prices; sorting and filtering
  // happen in this window, not on somebody's server.
  store: { items: [], loading: false, query: '', discount: 0, budget: 0, sort: 'discount' },
  settings: {
    accent: '#7c9cff',
    material: 'liquid',
    tint: 55,
    blur: 45,
    grain: true,
    glow: true,
    motion: 100,
    easing: 'spring',
    hoverDelay: 0,
    pillWidth: 96,
    notchStyle: 'attached',
    backdrop: 'live',
    taskbar: false,
    taskbarStyle: 'glass',
    taskbarShape: 'islands',
    taskbarShow: 'both',
    taskbarAutoHide: false,
    windowsKey: true,
  },
  filter: '',
  clips: [],
  processes: null,
  login: false,
  detaching: false,
  stats: {
    cpu: 0,
    ram: { used: 0, total: 0 },
    disk: { free: 0, total: 0 },
    battery: null,
    charging: true,
    uptime: 0,
  },
};

const focus = {
  minutes: 25,
  total: 25 * 60000,
  remaining: 25 * 60000,
  endsAt: 0,
  running: false,
};

let closeTimer = null;
let toastTimer = null;
let hoverTimer = null;
let clockTimer = null;
let focusTimer = null;
let settingsSaveTimer = null;

// ------------------------------------------------------------------- helpers

function hashHue(text) {
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) hash = (hash * 31 + text.charCodeAt(i)) % 360;
  return hash;
}

function initials(name) {
  const words = String(name).trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '??';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

function clockText(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function uptimeText(ms) {
  if (!ms) return '—';
  const minutes = Math.floor(ms / 60000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  return `${minutes}m`;
}

function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 1700);
}

// --------------------------------------------------------------------- clock

const shortDateFormat = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
});
const longDateFormat = new Intl.DateTimeFormat(undefined, {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
});

// Idle cost: a folded notch only needs the clock once a minute, aligned to the
// wall clock, instead of a one-second timer that redraws nothing visible.
function scheduleClock() {
  clearTimeout(clockTimer);
  const now = Date.now();
  const delay = state.open ? 1000 : 60000 - (now % 60000) + 40;
  clockTimer = setTimeout(() => {
    tickClock();
    scheduleClock();
  }, delay);
}

function tickClock() {
  const now = new Date();
  const time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  $('#pillTime').textContent = time;
  $('#clock').textContent = time;
  $('#pillDate').textContent = shortDateFormat.format(now);
  $('#today').textContent = longDateFormat.format(now);
}

// --------------------------------------------------------------------- stats

function updateBattery() {
  const level = state.stats.battery;
  const charging = state.stats.charging && level != null;
  const low = level != null && level <= 20 && !charging;
  const label = level == null ? 'AC' : `${level}%`;

  $('#battTextPill').textContent = label;
  $('#battText').textContent = label;

  const width = level == null ? 6 : Math.max(1.4, (15.8 * level) / 100);
  $('#battFillPill').style.width = `${width}px`;
  $('#battFillChip').style.width = `${width}px`;

  for (const el of [$('#batteryPill'), $('#batteryChip')]) {
    el.classList.toggle('low', low);
    el.classList.toggle('charging', charging);
  }
  $('#batteryChip').classList.toggle('charging', charging);
  $('#batteryChip').classList.toggle('low', low);
}

function setMeter(name, value) {
  const bar = $(`#bar${name}`);
  const val = $(`#val${name}`);
  if (bar) bar.style.width = `${Math.max(0, Math.min(100, value))}%`;
  if (val) val.textContent = `${Math.round(value)}%`;
}

function gb(bytes) {
  return `${(bytes / 1e9).toFixed(1)} GB`;
}

function renderStats() {
  const s = state.stats || {};
  const cpu = Math.round(s.cpu || 0);
  const ramPct = s.ram && s.ram.total ? (s.ram.used / s.ram.total) * 100 : 0;
  const diskPct = s.disk && s.disk.total ? (1 - s.disk.free / s.disk.total) * 100 : 0;
  setMeter('Cpu', cpu);
  setMeter('Ram', ramPct);
  setMeter('Disk', diskPct);
  $('#uptime').textContent = uptimeText(s.uptime);
  updateBattery();
  renderDetailSystem(s, cpu, ramPct, diskPct);
}

// The System detail repeats the meters at full width with real figures.
function renderDetailSystem(s, cpu, ramPct, diskPct) {
  const bar = $('#dBarCpu');
  if (!bar) return;
  bar.style.width = `${Math.max(0, Math.min(100, cpu))}%`;
  $('#dValCpu').textContent = `${cpu}%`;
  $('#dBarRam').style.width = `${Math.max(0, Math.min(100, ramPct))}%`;
  $('#dValRam').textContent = `${Math.round(ramPct)}%`;
  $('#dSubRam').textContent = s.ram && s.ram.total ? `${gb(s.ram.used)} of ${gb(s.ram.total)}` : '';
  $('#dBarDisk').style.width = `${Math.max(0, Math.min(100, diskPct))}%`;
  $('#dValDisk').textContent = `${Math.round(diskPct)}%`;
  $('#dSubDisk').textContent =
    s.disk && s.disk.total ? `${gb(s.disk.free)} free of ${gb(s.disk.total)}` : '';
}

// ---------------------------------------------------------------- game library

function renderGames() {
  const list = $('#gameList');
  const query = state.filter.trim().toLowerCase();
  const filtered = query
    ? state.games.filter((game) => game.name.toLowerCase().includes(query))
    : state.games;
  const visible = filtered.slice(0, 12);

  list.replaceChildren();
  for (const game of visible) list.appendChild(gameCard(game));

  $('#gameCount').textContent = state.games.length ? String(state.games.length) : '';

  const empty = $('#gameEmpty');
  empty.hidden = visible.length > 0;
  if (!visible.length) {
    if (!state.games.length) {
      $('#emptyTitle').textContent = isDemo ? 'Demo library' : 'No games found';
      $('#emptyHint').textContent = isDemo
        ? 'The desktop app reads your Steam and Epic libraries.'
        : 'Steam and Epic libraries are scanned on launch.';
    } else {
      $('#emptyTitle').textContent = 'Nothing matches';
      $('#emptyHint').textContent = `No game called “${state.filter.trim()}”.`;
    }
  }
}

function gameCard(game) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'game';
  button.dataset.id = game.id;
  button.title = `Launch ${game.name}`;

  const icon = state.icons[game.id];
  let art;
  if (icon) {
    art = document.createElement('img');
    art.className = 'art';
    art.src = icon;
    art.alt = '';
    art.decoding = 'async';
  } else {
    art = document.createElement('span');
    art.className = 'art';
    art.style.setProperty('--h', String(hashHue(game.name)));
    art.textContent = initials(game.name);
  }

  const text = document.createElement('span');
  text.className = 'game-text';
  const name = document.createElement('span');
  name.className = 'game-name';
  name.textContent = game.name;
  const source = document.createElement('span');
  source.className = 'game-source';
  source.textContent = game.source || 'Library';
  text.append(name, source);

  const play = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  play.setAttribute('viewBox', '0 0 12 12');
  play.setAttribute('class', 'play');
  play.setAttribute('aria-hidden', 'true');
  const triangle = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  triangle.setAttribute('d', 'M3.4 1.9 9.9 6l-6.5 4.1Z');
  play.appendChild(triangle);

  button.append(art, text, play);
  button.addEventListener('click', () => launchGame(game));
  return button;
}

// Icons arrive after the first paint: swap them in without re-rendering the
// list, so the scroll position and hover state survive.
function applyIcons(map) {
  if (!map) return;
  Object.assign(state.icons, map);
  for (const card of document.querySelectorAll('.game')) {
    const url = state.icons[card.dataset.id];
    if (!url) continue;
    const art = card.querySelector('.art');
    if (!art || art.tagName === 'IMG') continue;
    const img = document.createElement('img');
    img.className = 'art';
    img.src = url;
    img.alt = '';
    img.decoding = 'async';
    art.replaceWith(img);
  }
}

function setBackdrop(url) {
  if (!url) return;
  const backdrop = document.querySelector('.glass-backdrop');
  if (backdrop) backdrop.style.backgroundImage = `url("${url}")`;
  if (window.notchGlass) window.notchGlass.setSource(url);
  else window.__backdrop = url;
}

async function launchGame(game) {
  try {
    const result = await api.launch(game.id);
    if (result && result.ok) toast(`Launching ${game.name}`);
    else toast(`Could not launch ${game.name}`);
  } catch {
    toast('Launch failed');
  }
}

async function rescanLibraries() {
  const button = $('#rescan');
  if (button.classList.contains('spin')) return;
  button.classList.add('spin');
  try {
    const games = await api.rescan();
    if (Array.isArray(games)) {
      state.games = games;
      renderGames();
      if (state.detail === 'library') renderDetail();
      toast(games.length ? `${games.length} games found` : 'No games found');
    }
  } finally {
    button.classList.remove('spin');
  }
}

// The bag in the library row opens the store page here in the panel: the rows,
// the prices and the sorting are this window's own work.
function openStore() {
  openDetail('store');
}

async function addGame() {
  state.busy = true;
  clearTimeout(closeTimer);
  try {
    const games = await api.addGame();
    if (Array.isArray(games)) {
      state.games = games;
      renderGames();
      if (state.detail === 'library') renderDetail();
    }
  } finally {
    state.busy = false;
  }
}

// ----------------------------------------------------------------- clipboard

function renderClips() {
  const row = $('#clips');
  row.replaceChildren();
  $('#clipMeta').textContent = state.clips.length ? String(state.clips.length) : '';

  if (!state.clips.length) {
    const empty = document.createElement('span');
    empty.className = 'clips-empty';
    empty.textContent = 'Copy something and it lands here.';
    row.appendChild(empty);
    return;
  }

  for (const clip of state.clips.slice(0, 6)) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'clip';
    button.title = 'Copy again';
    const text = document.createElement('span');
    text.textContent = String(clip.text || '').replace(/\s+/g, ' ').trim();
    button.appendChild(text);
    button.addEventListener('click', async () => {
      const ok = await api.copyClip(clip.id);
      toast(ok ? 'Copied to clipboard' : 'Could not copy');
    });
    row.appendChild(button);
  }
}

// --------------------------------------------------------------------- focus

function renderFocus() {
  const remaining = focus.running ? Math.max(0, focus.endsAt - Date.now()) : focus.remaining;
  const progress = focus.total > 0 ? 1 - remaining / focus.total : 0;

  $('#dialTime').textContent = clockText(remaining);
  $('#dialFill').style.strokeDashoffset = String(DIAL_C * progress);
  $('#dialFill').style.strokeDasharray = String(DIAL_C);

  const started = focus.running || remaining < focus.total;
  const mini = $('#focusMini');
  mini.hidden = !started;
  if (started) {
    $('#focusMiniTime').textContent = clockText(remaining);
    $('#ringMini').style.strokeDasharray = String(MINI_C);
    $('#ringMini').style.strokeDashoffset = String(MINI_C * progress);
  }

  const stateLabel = focus.running ? 'Focusing' : remaining === 0 ? 'Done' : started ? 'Paused' : `${focus.minutes} min`;
  $('#focusState').textContent = stateLabel;
  $('#focusToggle').textContent = focus.running ? 'Pause' : started ? 'Resume' : 'Start';
  document.querySelector('.dial').classList.toggle('running', focus.running);

  const dot = $('#statusDot');
  dot.classList.toggle('live', focus.running);
  dot.classList.toggle('idle', !focus.running);

  renderDetailFocusStats(remaining, progress, started);

  // A detached Focus card mirrors the same timer; the panel stays the owner.
  if (api.focusState) {
    api.focusState({
      minutes: focus.minutes,
      total: focus.total,
      remaining: focus.running ? remaining : focus.remaining,
      endsAt: focus.endsAt,
      running: focus.running,
    });
  }
}

function renderDetailFocusStats(remaining, progress, started) {
  const time = $('#detailDialTime');
  if (!time) return;
  time.textContent = clockText(remaining);
  const fill = $('#detailDialFill');
  fill.style.strokeDasharray = String(DETAIL_C);
  fill.style.strokeDashoffset = String(DETAIL_C * progress);
  $('#detailFocusToggle').textContent = focus.running ? 'Pause' : started ? 'Resume' : 'Start';
  document.querySelectorAll('#detailPresets button').forEach((button) => {
    button.classList.toggle('is-on', Number(button.dataset.min) === focus.minutes);
  });
  $('#detailFocusNote').textContent = focus.running
    ? `Focusing · ends at ${new Date(focus.endsAt).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
      })}`
    : remaining === 0
      ? 'Session complete'
      : started
        ? `Paused · ${clockText(remaining)} left`
        : `${focus.minutes} minute session`;
}

// The focus ticker only exists while the timer runs, so an idle notch has no
// periodic work at all.
function ensureFocusTicker() {
  clearInterval(focusTimer);
  focusTimer = null;
  if (focus.running) focusTimer = setInterval(tickFocus, 1000);
}

function startFocus() {
  if (focus.remaining <= 0) focus.remaining = focus.total;
  focus.endsAt = Date.now() + focus.remaining;
  focus.running = true;
  ensureFocusTicker();
  renderFocus();
}

function pauseFocus() {
  focus.remaining = Math.max(0, focus.endsAt - Date.now());
  focus.running = false;
  ensureFocusTicker();
  renderFocus();
}

function toggleFocus() {
  if (focus.running) pauseFocus();
  else startFocus();
}

function resetFocus() {
  focus.running = false;
  focus.remaining = focus.total;
  ensureFocusTicker();
  renderFocus();
}

function setFocusMinutes(minutes) {
  focus.minutes = minutes;
  focus.total = minutes * 60000;
  focus.remaining = focus.total;
  focus.running = false;
  document.querySelectorAll('.presets button[data-min]').forEach((button) => {
    button.classList.toggle('is-on', Number(button.dataset.min) === minutes);
  });
  renderFocus();
}

function tickFocus() {
  if (focus.running) {
    focus.remaining = focus.endsAt - Date.now();
    if (focus.remaining <= 0) {
      focus.remaining = 0;
      focus.running = false;
      focus.total = focus.minutes * 60000;
      toast('Focus session complete');
      focus.remaining = focus.total;
      ensureFocusTicker();
    }
    renderFocus();
  }
}

// ---------------------------------------------------------------------- menu

function hideMenu() {
  $('#menu').hidden = true;
}

function toggleMenu() {
  const menu = $('#menu');
  menu.hidden = !menu.hidden;
}

// ------------------------------------------------------------------ settings

const SETTINGS_SCHEMA = [
  { group: 'Appearance' },
  {
    key: 'accent',
    label: 'Accent',
    type: 'swatch',
    options: ['#7c9cff', '#bf8cff', '#6fe3b0', '#ff8fb8', '#ffb86b'],
  },
  {
    key: 'material',
    label: 'Surface',
    type: 'segment',
    options: [
      ['liquid', 'Liquid'],
      ['frost', 'Frosted'],
      ['black', 'Black'],
    ],
  },
  { key: 'tint', label: 'Tint', type: 'range', min: 0, max: 100, step: 5, suffix: '%' },
  { key: 'blur', label: 'Blur', type: 'range', min: 0, max: 100, step: 5, suffix: '%' },
  { key: 'grain', label: 'Grain', type: 'toggle' },
  { key: 'glow', label: 'Pill glow', type: 'toggle' },
  { group: 'Motion' },
  {
    key: 'animations',
    label: 'Animations',
    type: 'segment',
    // Windows' own setting is the default; 'Always' is for machines that have it
    // switched off for them, where the sheet would otherwise just appear.
    options: [
      ['system', 'Windows'],
      ['always', 'Always'],
    ],
  },
  { key: 'motion', label: 'Animation', type: 'range', min: 50, max: 150, step: 10, suffix: '%' },
  {
    key: 'easing',
    label: 'Easing',
    type: 'segment',
    options: [['spring', 'Spring'], ['soft', 'Soft'], ['linear', 'Linear']],
  },
  { key: 'hoverDelay', label: 'Hover delay', type: 'range', min: 0, max: 400, step: 20, suffix: 'ms' },
  { group: 'Notch' },
  {
    key: 'notchStyle',
    label: 'Shape',
    type: 'segment',
    options: [['attached', 'Attached'], ['island', 'Island']],
  },
  { key: 'pillWidth', label: 'Pill width', type: 'range', min: 72, max: 160, step: 4, suffix: 'px' },
  { group: 'Backdrop' },
  {
    key: 'backdrop',
    label: 'Glass source',
    type: 'segment',
    options: [
      ['live', 'Live'],
      ['wallpaper', 'Wallpaper'],
    ],
  },
  { key: 'backdropImage', label: 'Image', type: 'action', action: 'pickWallpaper', button: 'Choose…' },
  {
    key: 'glassStatus',
    label: 'Glass',
    type: 'status',
    text: () => {
      const glass = window.notchGlass && window.notchGlass.status ? window.notchGlass.status() : null;
      if (!glass || glass.mode === 'pending') return 'starting';
      if (glass.mode === 'shader') return 'WebGL';
      return glass.reason === 'no-webgl' ? 'flat — no WebGL' : 'flat — no image';
    },
  },
  { group: 'Taskbar' },
  { key: 'taskbar', label: 'Show taskbar', type: 'toggle' },
  {
    key: 'taskbarStyle',
    label: 'Surface',
    type: 'segment',
    options: [
      ['glass', 'Glass'],
      ['hidden', 'Invisible'],
    ],
  },
  {
    key: 'taskbarShape',
    label: 'Layout',
    type: 'segment',
    options: [
      ['attached', 'Attached'],
      ['islands', 'Islands'],
    ],
  },
  {
    key: 'taskbarShow',
    label: 'Items',
    type: 'segment',
    options: [
      ['both', 'Both'],
      ['open', 'Open'],
      ['pinned', 'Pinned'],
    ],
  },
  { key: 'taskbarAutoHide', label: 'Auto-hide', type: 'toggle' },
  { group: 'Start menu' },
  { key: 'windowsKey', label: 'Windows key opens it', type: 'toggle' },
];

function applySettings() {
  const s = state.settings;
  const root = document.documentElement;
  root.style.setProperty('--accent', s.accent);
  root.style.setProperty('--motion', String(s.motion / 100));
  root.classList.toggle('force-motion', s.animations === 'always');
  root.style.setProperty('--pill-w', `${s.pillWidth}px`);
  root.style.setProperty('--grain', s.grain ? '0.026' : '0');
  root.style.setProperty('--tint-o', String(Math.max(0, Math.min(1, s.tint / 70))));
  root.classList.toggle('ease-soft', s.easing === 'soft');
  root.classList.toggle('ease-linear', s.easing === 'linear');
  root.classList.toggle('island', s.notchStyle === 'island');
  // The shader sizes its canvas from the glass root, which moves and shrinks
  // in island mode. The vendor listens for window resizes, so nudge it once
  // the new geometry has been laid out.
  requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
  const notch = $('#notch');
  notch.classList.toggle('no-glow', !s.glow);
  notch.classList.toggle('frost', s.material === 'frost');
  notch.classList.toggle('solid', s.material === 'black');
  if (window.notchGlass) {
    window.notchGlass.apply({ tint: s.tint, blur: s.blur });
    // Black draws no glass at all, so park the shader; switching back resumes it.
    if (s.material === 'black') window.notchGlass.setPaused(true);
    else window.notchGlass.refresh();
  }
}

// Rapid edits (drag a slider, then tap a toggle) are coalesced into one patch;
// a single-key timer would drop everything but the last change.
let pendingSettings = {};

function updateSetting(key, value) {
  state.settings = { ...state.settings, [key]: value };
  applySettings();
  pendingSettings[key] = value;
  clearTimeout(settingsSaveTimer);
  settingsSaveTimer = setTimeout(() => {
    const patch = pendingSettings;
    pendingSettings = {};
    if (!api.setSettings) return;
    Promise.resolve(api.setSettings(patch)).catch(() => {});
  }, 150);
}

async function pickWallpaper() {
  if (!api.pickWallpaper) return;
  const result = await api.pickWallpaper();
  if (!result || result.canceled) return;
  if (!result.url || result.bad) {
    toast('Could not read that image');
    return;
  }
  if (result.settings) state.settings = { ...state.settings, ...result.settings };
  setBackdrop(result.url);
  renderSettings();
  toast('Backdrop image set');
}

function openSettings() {
  hideMenu();
  clearTimeout(closeTimer);
  state.settingsOpen = true;
  state.busy = true;
  $('#settingsSheet').hidden = false;
  renderSettings();
}

function closeSettings() {
  state.settingsOpen = false;
  state.busy = false;
  $('#settingsSheet').hidden = true;
}

function renderSettings() {
  const body = $('#settingsBody');
  body.replaceChildren();
  const s = state.settings;

  for (const item of SETTINGS_SCHEMA) {
    if (item.group) {
      const group = document.createElement('div');
      group.className = 'set-group';
      group.textContent = item.group;
      body.appendChild(group);
      continue;
    }

    const row = document.createElement('div');
    row.className = 'set-row';
    const key = document.createElement('span');
    key.className = 'set-key';
    key.textContent = item.label;
    row.appendChild(key);

    if (item.type === 'range') {
      const wrap = document.createElement('span');
      wrap.style.display = 'flex';
      wrap.style.alignItems = 'center';
      wrap.style.gap = '10px';
      const value = document.createElement('span');
      value.className = 'set-val';
      value.textContent = `${s[item.key]}${item.suffix || ''}`;
      const input = document.createElement('input');
      input.type = 'range';
      input.min = item.min;
      input.max = item.max;
      input.step = item.step;
      input.value = s[item.key];
      input.addEventListener('input', () => {
        value.textContent = `${input.value}${item.suffix || ''}`;
        updateSetting(item.key, Number(input.value));
      });
      wrap.append(input, value);
      row.appendChild(wrap);
    } else if (item.type === 'toggle') {
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.className = 'set-switch';
      input.checked = !!s[item.key];
      input.addEventListener('change', () => updateSetting(item.key, input.checked));
      row.appendChild(input);
    } else if (item.type === 'segment') {
      const seg = document.createElement('div');
      seg.className = 'seg';
      for (const [option, label] of item.options) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = label;
        button.classList.toggle('on', s[item.key] === option);
        button.addEventListener('click', () => {
          updateSetting(item.key, option);
          renderSettings();
        });
        seg.appendChild(button);
      }
      row.appendChild(seg);
    } else if (item.type === 'action') {
      if (isDemo) continue;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'set-action';
      button.textContent = item.button;
      button.addEventListener('click', () => {
        if (item.action === 'pickWallpaper') pickWallpaper();
      });
      row.appendChild(button);
    } else if (item.type === 'status') {
      if (isDemo) continue;
      const value = document.createElement('span');
      value.className = 'set-val';
      value.textContent = item.text();
      row.appendChild(value);
    } else if (item.type === 'swatch') {
      const swatches = document.createElement('div');
      swatches.className = 'swatches';
      for (const color of item.options) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'swatch';
        button.style.background = color;
        button.setAttribute('aria-label', color);
        button.classList.toggle('on', s[item.key] === color);
        button.addEventListener('click', () => {
          updateSetting(item.key, color);
          renderSettings();
        });
        swatches.appendChild(button);
      }
      row.appendChild(swatches);
    }

    body.appendChild(row);
  }
}

// ---------------------------------------------------------------- detaching

// Drag the System tile out of the panel and it becomes its own always-on-top
// window; a plain press only hints that it can be pulled out.
function bindTileDetach() {
  for (const tile of document.querySelectorAll('.tile')) {
    const kind = tile.dataset.detail;
    if (kind) bindDetach(tile, kind);
  }
}

function bindDetach(tile, kind) {
  let drag = null;

  const end = (event) => {
    if (!drag || event.pointerId !== drag.id) return;
    const started = drag.started;
    drag = null;
    state.detaching = false;
    tile.classList.remove('detaching');
    if (tile.hasPointerCapture?.(event.pointerId)) tile.releasePointerCapture(event.pointerId);
    if (started) {
      tile.dataset.dragged = '1';
      if (api.detachEnd) api.detachEnd();
      closeNotch(true);
    }
  };

  tile.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    drag = { id: event.pointerId, x: event.screenX, y: event.screenY, started: false };
    tile.setPointerCapture?.(event.pointerId);
  });

  tile.addEventListener('pointermove', (event) => {
    if (!drag || event.pointerId !== drag.id) return;
    if (!drag.started && Math.hypot(event.screenX - drag.x, event.screenY - drag.y) > 14) {
      drag.started = true;
      state.detaching = true;
      tile.classList.add('detaching');
      if (api.detachTile) api.detachTile({ tile: kind, x: event.screenX, y: event.screenY });
    }
  });

  tile.addEventListener('pointerup', end);
  tile.addEventListener('pointercancel', end);
}

// ---------------------------------------------------------------- detail view

// Every tile can open into the whole panel: same glass, more of that widget.
const DETAIL_TITLES = {
  library: 'Library',
  store: 'Store',
  focus: 'Focus',
  system: 'System',
  clip: 'Clipboard',
};

function svgNode(name, attrs = {}) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return node;
}

function openDetail(kind) {
  if (!DETAIL_TITLES[kind] || state.settingsOpen) return;
  state.detail = kind;
  hideMenu();
  $('#grid').hidden = true;
  $('#detail').hidden = false;
  $('#detailTitle').textContent = DETAIL_TITLES[kind];
  renderDetail();
  if (api.detail) api.detail(kind);
}

function closeDetail() {
  if (!state.detail) return;
  state.detail = null;
  if (api.detail) api.detail(null);
  $('#detail').hidden = true;
  $('#grid').hidden = false;
  $('#detailBody').replaceChildren();
  $('#detailMeta').textContent = '';
}

function renderDetail() {
  const kind = state.detail;
  const body = $('#detailBody');
  const meta = $('#detailMeta');
  body.replaceChildren();
  meta.textContent = '';
  if (!kind) return;

  if (kind === 'library') {
    meta.textContent = state.games.length ? `${state.games.length} games` : '';
    renderDetailLibrary(body);
  } else if (kind === 'store') {
    renderDetailStore(body);
    loadStore();
  } else if (kind === 'focus') {
    renderDetailFocus(body);
  } else if (kind === 'system') {
    meta.textContent = uptimeText(state.stats.uptime);
    renderDetailSystemView(body);
  } else {
    meta.textContent = state.clips.length ? `${state.clips.length} items` : '';
    renderDetailClips(body);
  }
}

function emptyBlock(title, hint) {
  const wrap = document.createElement('div');
  wrap.className = 'empty';
  const line = document.createElement('span');
  line.textContent = title;
  const small = document.createElement('small');
  small.textContent = hint;
  wrap.append(line, small);
  return wrap;
}

function renderDetailLibrary(body) {
  if (!state.games.length) {
    body.appendChild(
      emptyBlock(
        'No games found',
        isDemo
          ? 'The desktop app reads your Steam and Epic libraries.'
          : 'Steam and Epic libraries are scanned on launch.',
      ),
    );
    return;
  }
  const list = document.createElement('div');
  list.className = 'game-list detail-games';
  for (const game of state.games) list.appendChild(gameCard(game));
  body.appendChild(list);
}

// ------------------------------------------------------------------- store

// The store is Steam's catalogue with Notch's own hands on it: one fetch of the
// featured list, then every filter and every sort happens here, in this window.
const STORE_DISCOUNTS = [0, 25, 50, 75];
const STORE_BUDGETS = [0, 500, 1000, 2000];
const STORE_SORTS = [
  ['discount', 'Biggest discount'],
  ['price', 'Cheapest first'],
  ['pricey', 'Priciest first'],
  ['name', 'A–Z'],
];

function money(cents, currency) {
  const value = Math.max(0, Number(cents) || 0) / 100;
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: String(currency || 'USD').toUpperCase(),
      maximumFractionDigits: 2,
    }).format(value);
  } catch {
    return `${value.toFixed(2)} ${String(currency || '').toUpperCase()}`.trim();
  }
}

function storeSource(item) {
  if (item.source === 'new') return 'New release';
  if (item.source === 'top') return 'Top seller';
  return item.discount ? 'Deal' : 'Steam';
}

async function loadStore() {
  const store = state.store;
  if (store.loading || store.tried || !api.store) return;
  store.tried = true;
  store.loading = true;
  try {
    const data = await api.store();
    if (data && Array.isArray(data.items)) {
      store.items = data.items;
      if (data.error) toast('Steam is not answering');
    }
  } catch {
    toast('Steam is not answering');
  } finally {
    store.loading = false;
    if (state.detail === 'store') renderDetail();
  }
}

function storeRows() {
  const store = state.store;
  const query = store.query.trim().toLowerCase();
  const rows = store.items.filter((item) => {
    if (item.discount < store.discount) return false;
    if (store.budget && item.final > store.budget) return false;
    if (query && !item.name.toLowerCase().includes(query)) return false;
    return true;
  });
  const sorters = {
    discount: (a, b) => b.discount - a.discount || a.final - b.final,
    price: (a, b) => a.final - b.final,
    pricey: (a, b) => b.final - a.final,
    name: (a, b) => a.name.localeCompare(b.name),
  };
  return rows.sort(sorters[store.sort] || sorters.discount);
}

function storeRow(item) {
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'store-row';
  row.title = `${item.name} on Steam`;
  row.addEventListener('click', () => {
    if (api.openStorePage) api.openStorePage(item.appid);
  });

  const art = document.createElement('img');
  art.className = 'store-art';
  art.src = item.art;
  art.alt = '';
  art.loading = 'lazy';
  art.decoding = 'async';

  const text = document.createElement('span');
  text.className = 'store-text';
  const name = document.createElement('span');
  name.className = 'store-name';
  name.textContent = item.name;
  const meta = document.createElement('span');
  meta.className = 'store-meta';
  meta.textContent = storeSource(item);
  text.append(name, meta);

  const price = document.createElement('span');
  price.className = 'store-price';
  if (item.discount) {
    const off = document.createElement('span');
    off.className = 'store-off';
    off.textContent = `−${item.discount}%`;
    price.appendChild(off);
  }
  const final = document.createElement('span');
  final.className = 'store-final';
  final.textContent = item.free ? 'Free' : money(item.final, item.currency);
  price.appendChild(final);
  if (item.discount && item.original) {
    const old = document.createElement('span');
    old.className = 'store-old';
    old.textContent = money(item.original, item.currency);
    price.appendChild(old);
  }

  row.append(art, text, price);
  return row;
}

function renderDetailStore(body) {
  const store = state.store;
  const currency = store.items[0] ? store.items[0].currency : 'USD';

  const wrap = document.createElement('div');
  wrap.className = 'store';

  const bar = document.createElement('div');
  bar.className = 'store-bar';

  const search = document.createElement('label');
  search.className = 'search store-search';
  const lens = svgNode('svg', { viewBox: '0 0 16 16', 'aria-hidden': 'true' });
  lens.append(svgNode('circle', { cx: 7, cy: 7, r: 4.4 }), svgNode('path', { d: 'm10.4 10.4 3 3' }));
  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = 'Search the store';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.value = store.query;
  search.append(lens, input);
  bar.appendChild(search);

  const sort = document.createElement('select');
  sort.className = 'store-sort';
  sort.title = 'Sort';
  for (const [value, label] of STORE_SORTS) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    option.selected = store.sort === value;
    sort.appendChild(option);
  }
  bar.appendChild(sort);
  wrap.appendChild(bar);

  const chips = document.createElement('div');
  chips.className = 'store-chips';
  const chipButton = (label, active, onClick) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'store-chip';
    button.textContent = label;
    button.classList.toggle('is-on', active);
    button.addEventListener('click', onClick);
    chips.appendChild(button);
  };
  for (const value of STORE_DISCOUNTS) {
    chipButton(value ? `−${value}% or more` : 'All', store.discount === value, () => {
      store.discount = value;
      renderDetail();
    });
  }
  for (const value of STORE_BUDGETS) {
    chipButton(value ? `Under ${money(value, currency)}` : 'Any price', store.budget === value, () => {
      store.budget = value;
      renderDetail();
    });
  }
  chipButton(store.loading ? 'Asking Steam…' : 'Refresh', false, () => {
    store.tried = false;
    store.items = [];
    renderDetail();
  });
  wrap.appendChild(chips);

  const list = document.createElement('div');
  list.className = 'store-list';
  wrap.appendChild(list);

  const paint = () => {
    list.replaceChildren();
    if (store.loading && !store.items.length) {
      list.appendChild(emptyBlock('Asking Steam…', 'Prices, discounts and what is on sale today.'));
      return;
    }
    if (!store.items.length) {
      list.appendChild(
        emptyBlock(
          'The store is closed',
          api.store ? 'Steam did not answer. Press Refresh in a moment.' : 'Start the app from Notch.exe to reach the store.',
        ),
      );
      return;
    }
    const rows = storeRows();
    if (!rows.length) {
      list.appendChild(emptyBlock('Nothing matches', 'Loosen a filter or clear the search.'));
      return;
    }
    for (const item of rows) list.appendChild(storeRow(item));
  };
  paint();

  input.addEventListener('input', () => {
    store.query = input.value;
    paint();
  });
  sort.addEventListener('change', () => {
    store.sort = sort.value;
    paint();
  });

  body.appendChild(wrap);
  const meta = $('#detailMeta');
  if (meta) meta.textContent = store.items.length ? `${store.items.length} on the list` : '';
}

function renderDetailFocus(body) {
  const wrap = document.createElement('div');
  wrap.className = 'detail-focus';

  const dial = document.createElement('div');
  dial.className = 'detail-dial';
  const ring = svgNode('svg', { viewBox: '0 0 120 120' });
  ring.append(
    svgNode('circle', { class: 'dial-track', cx: 60, cy: 60, r: DETAIL_R }),
    svgNode('circle', { class: 'dial-fill', id: 'detailDialFill', cx: 60, cy: 60, r: DETAIL_R }),
  );
  const time = document.createElement('span');
  time.className = 'detail-dial-time';
  time.id = 'detailDialTime';
  time.textContent = clockText(focus.remaining);
  dial.append(ring, time);

  const side = document.createElement('div');
  side.className = 'detail-focus-side';

  const presets = document.createElement('div');
  presets.className = 'presets';
  presets.id = 'detailPresets';
  for (const minutes of [5, 15, 25, 45]) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.min = String(minutes);
    button.textContent = String(minutes);
    button.addEventListener('click', () => setFocusMinutes(minutes));
    presets.appendChild(button);
  }

  const buttons = document.createElement('div');
  buttons.className = 'focus-buttons';
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'primary';
  toggle.id = 'detailFocusToggle';
  toggle.textContent = 'Start';
  toggle.addEventListener('click', toggleFocus);
  const reset = document.createElement('button');
  reset.type = 'button';
  reset.className = 'mini-btn';
  reset.title = 'Reset';
  reset.setAttribute('aria-label', 'Reset timer');
  const icon = svgNode('svg', { viewBox: '0 0 16 16', 'aria-hidden': 'true' });
  icon.append(
    svgNode('path', { d: 'M13 8a5 5 0 1 1-1.6-3.7' }),
    svgNode('path', { d: 'M13.2 2.4v2.6h-2.6' }),
  );
  reset.appendChild(icon);
  reset.addEventListener('click', resetFocus);
  buttons.append(toggle, reset);

  const note = document.createElement('div');
  note.className = 'detail-note';
  note.id = 'detailFocusNote';

  side.append(presets, buttons, note);
  wrap.append(dial, side);
  body.appendChild(wrap);
  renderFocus();
}

function renderDetailSystemView(body) {
  const wrap = document.createElement('div');
  wrap.className = 'detail-system';
  for (const [key, label] of [
    ['Cpu', 'CPU'],
    ['Ram', 'Memory'],
    ['Disk', 'Disk'],
  ]) {
    const row = document.createElement('div');
    row.className = 'detail-meter';
    const top = document.createElement('div');
    top.className = 'detail-meter-top';
    const name = document.createElement('span');
    name.className = 'detail-meter-label';
    name.textContent = label;
    const value = document.createElement('span');
    value.className = 'meter-val';
    value.id = `dVal${key}`;
    value.textContent = '—';
    top.append(name, value);
    const bar = document.createElement('span');
    bar.className = 'meter-bar';
    const fill = document.createElement('i');
    fill.id = `dBar${key}`;
    bar.appendChild(fill);
    const sub = document.createElement('span');
    sub.className = 'detail-sub';
    sub.id = `dSub${key}`;
    row.append(top, bar, sub);
    wrap.appendChild(row);
  }
  const hint = document.createElement('div');
  hint.className = 'detail-sub';
  hint.textContent = 'Drag the System tile out of the notch to keep it on screen.';
  wrap.appendChild(hint);

  const procHint = document.createElement('div');
  procHint.className = 'detail-sub detail-proc-head';
  procHint.textContent = 'What is using it';
  wrap.appendChild(procHint);

  const procWrap = document.createElement('div');
  procWrap.className = 'detail-procs';
  for (const [key, label] of [
    ['cpu', 'Top CPU'],
    ['ram', 'Top memory'],
  ]) {
    const block = document.createElement('div');
    block.className = 'detail-proc-block';
    const head = document.createElement('div');
    head.className = 'detail-proc-label';
    head.textContent = label;
    const list = document.createElement('div');
    list.className = 'detail-proc-list';
    list.id = `proc-${key}`;
    block.append(head, list);
    procWrap.appendChild(block);
  }
  wrap.appendChild(procWrap);
  body.appendChild(wrap);
  renderStats();
  renderProcesses();
}

// Process rows arrive from the main process while the System view is open.
function renderProcesses(data) {
  if (data) state.processes = data;
  for (const key of ['cpu', 'ram']) {
    const list = document.getElementById(`proc-${key}`);
    if (!list) continue;
    list.replaceChildren();
    for (const row of (state.processes && state.processes[key]) || []) {
      const item = document.createElement('div');
      item.className = 'detail-proc';

      const name = document.createElement('span');
      name.className = 'detail-proc-name';
      name.textContent = row.name;
      name.title = row.name;

      const track = document.createElement('span');
      track.className = 'detail-proc-bar';
      const fill = document.createElement('i');
      fill.style.width = `${Math.max(2, Math.min(100, (row.share || 0) * 100))}%`;
      track.appendChild(fill);

      const value = document.createElement('span');
      value.className = 'detail-proc-val';
      value.textContent = row.label;

      item.append(name, track, value);
      list.appendChild(item);
    }
  }
}

function renderDetailClips(body) {
  if (!state.clips.length) {
    body.appendChild(emptyBlock('Nothing copied yet', 'Copy something and it lands here.'));
    return;
  }
  const list = document.createElement('div');
  list.className = 'detail-clips';
  for (const clip of state.clips.slice(0, 24)) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'detail-clip';
    const text = document.createElement('span');
    text.className = 'detail-clip-text';
    text.textContent = String(clip.text || '').replace(/\s+/g, ' ').trim();
    const copy = document.createElement('span');
    copy.className = 'detail-clip-copy';
    copy.textContent = 'Copy';
    row.append(text, copy);
    row.addEventListener('click', async () => {
      const ok = await api.copyClip(clip.id);
      toast(ok ? 'Copied to clipboard' : 'Could not copy');
    });
    list.appendChild(row);
  }
  body.appendChild(list);
}

// --------------------------------------------------------------------- shell

function openNotch() {
  if (state.open) return;
  clearTimeout(hoverTimer);
  state.open = true;
  clearTimeout(closeTimer);
  api.setExpanded(true);
  const notch = $('#notch');
  notch.classList.remove('closing');
  notch.classList.add('open');
  notch.setAttribute('aria-expanded', 'true');
  if (window.notchGlass) window.notchGlass.setPaused(false);
  tickClock();
  scheduleClock();
}

function requestOpen() {
  clearTimeout(hoverTimer);
  const delay = Math.max(0, Number(state.settings.hoverDelay) || 0);
  if (delay === 0) openNotch();
  else hoverTimer = setTimeout(openNotch, delay);
}

function closeNotch(force = false) {
  if (!state.open) return;
  if (state.pinned && !force) return;
  state.open = false;
  closeSettings();
  closeDetail();
  const notch = $('#notch');
  notch.classList.remove('open');
  scheduleClock();
  notch.classList.add('closing');
  setTimeout(() => {
    if (state.open) return;
    notch.classList.remove('closing');
    // Nothing of the shader is on screen now, so stop its render loop.
    if (window.notchGlass) window.notchGlass.setPaused(true);
  }, 360);
  notch.setAttribute('aria-expanded', 'false');
  hideMenu();
  $('#gameSearch').blur();
  clearTimeout(closeTimer);
  closeTimer = setTimeout(() => {
    if (!state.open) api.setExpanded(false);
  }, 380);
}

// Leaving the panel closes it at once — no linger timer to outrun. Only a pin
// or a tile being dragged out of the notch keeps it on screen.
function scheduleClose() {
  if (state.pinned || state.detaching || !state.open) return;
  clearTimeout(closeTimer);
  closeNotch();
}

function setPinned(value) {
  state.pinned = !!value;
  api.setPinned(state.pinned);
  const button = $('#pinBtn');
  button.classList.toggle('on', state.pinned);
  button.title = state.pinned ? 'Unpin (Ctrl+Alt+N)' : 'Pin open (Ctrl+Alt+N)';
  if (state.pinned) {
    openNotch();
    toast('Pinned open');
  }
}

// --------------------------------------------------------------------- wiring

function bindEvents() {
  const notch = $('#notch');
  // In the desktop app the main process owns the hit-test (the window is larger
  // than the notch); the browser demo still uses plain hover.
  if (!api.onPointer) {
    notch.addEventListener('mouseenter', requestOpen);
    notch.addEventListener('mouseleave', scheduleClose);
  }

  $('#pinBtn').addEventListener('click', () => setPinned(!state.pinned));
  $('#menuBtn').addEventListener('click', (event) => {
    event.stopPropagation();
    toggleMenu();
  });
  document.addEventListener('pointerdown', (event) => {
    if (!event.target.closest('.menu') && !event.target.closest('#menuBtn')) hideMenu();
  });

  bindTileDetach();

  // Any tile opens into a single-widget view; its little chevron does the same
  // explicitly. Controls inside a tile keep their own behaviour.
  document.querySelectorAll('[data-detail]').forEach((button) => {
    if (button.classList.contains('tile')) return;
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      openDetail(button.dataset.detail);
    });
  });
  for (const tile of document.querySelectorAll('.tile')) {
    tile.addEventListener('click', (event) => {
      if (tile.dataset.dragged) {
        delete tile.dataset.dragged;
        return;
      }
      if (event.target.closest('button, input, label, a, .game, .clip')) return;
      openDetail(tile.dataset.detail);
    });
  }
  $('#detailBack').addEventListener('click', closeDetail);

  $('#settingsBtn').addEventListener('click', (event) => {
    event.stopPropagation();
    openSettings();
  });
  $('#settingsBack').addEventListener('click', () => closeSettings());

  $('#overlayBtn').addEventListener('click', async () => {
    hideMenu();
    const result = await api.overlay();
    toast(
      result && result.open
        ? 'Overlay on — drag it where you want it'
        : 'Overlay off',
    );
  });
  $('#quitBtn').addEventListener('click', () => api.quit());
  $('#loginToggle').addEventListener('change', async (event) => {
    state.login = await api.setLogin(event.target.checked);
    toast(state.login ? 'Notch will start with Windows' : 'Removed from startup');
  });

  $('#rescan').addEventListener('click', rescanLibraries);
  $('#addGame').addEventListener('click', addGame);
  $('#steamdb').addEventListener('click', openStore);

  const search = $('#gameSearch');
  search.addEventListener('input', () => {
    state.filter = search.value;
    renderGames();
  });
  search.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    const query = state.filter.trim().toLowerCase();
    const first = query
      ? state.games.find((game) => game.name.toLowerCase().includes(query))
      : state.games[0];
    if (first) launchGame(first);
  });

  $('#focusToggle').addEventListener('click', toggleFocus);
  $('#focusReset').addEventListener('click', resetFocus);
  document.querySelectorAll('#presets button').forEach((button) => {
    button.addEventListener('click', () => setFocusMinutes(Number(button.dataset.min)));
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (state.settingsOpen) {
        closeSettings();
        return;
      }
      if (state.detail) {
        closeDetail();
        return;
      }
      if (state.pinned) setPinned(false);
      closeNotch(true);
      return;
    }
    if (event.key === '/' && document.activeElement !== search) {
      event.preventDefault();
      search.focus();
    }
  });

  api.onStats((stats) => {
    state.stats = stats;
    if (state.open) renderStats();
  });
  api.onProcesses((data) => {
    state.processes = data;
    if (state.detail === 'system') renderProcesses();
  });
  if (api.onFocusAction) {
    api.onFocusAction((action) => {
      const text = String(action || '');
      if (text === 'reset') resetFocus();
      else if (text === 'start') startFocus();
      else if (text === 'pause') pauseFocus();
      else if (text.startsWith('minutes:')) setFocusMinutes(Number(text.split(':')[1]) || 25);
      else toggleFocus();
    });
  }
  api.onClips((clips) => {
    state.clips = clips;
    if (state.open) renderClips();
    if (state.detail === 'clip') renderDetail();
  });
  api.onTogglePin(() => {
    // Keyboard/tray toggle: second press folds the notch away again.
    if (state.pinned) {
      setPinned(false);
      closeNotch(true);
    } else {
      setPinned(true);
    }
  });
  api.onOpen(() => openNotch());
  // Jarvis works the app from the main process: a page to open, a setting that
  // changed, a library that was rescanned. The panel follows all three.
  if (api.onSettings) {
    api.onSettings((settings) => {
      if (!settings) return;
      state.settings = { ...state.settings, ...settings };
      applySettings();
      if (state.settingsOpen) renderSettings();
    });
  }
  if (api.onView) {
    api.onView((kind) => {
      openNotch();
      if (!kind || kind === 'panel') {
        closeSettings();
        closeDetail();
        return;
      }
      if (kind === 'settings') openSettings();
      else openDetail(kind);
    });
  }
  if (api.onGames) {
    api.onGames((list) => {
      if (!Array.isArray(list)) return;
      state.games = list;
      renderGames();
      if (state.detail === 'library') renderDetail();
    });
  }
  if (api.onIcons) api.onIcons((map) => applyIcons(map));
  if (api.onBackdrop) api.onBackdrop((url) => setBackdrop(url));
  // The window covers more than the notch, so the main process owns the
  // hover hit-test and hands clicks back to the desktop outside the shape.
  if (api.onPointer) {
    api.onPointer((where) => {
      if (where === 'enter') requestOpen();
      else scheduleClose();
    });
  }
}

// ---------------------------------------------------------------------- boot

async function boot() {
  bindEvents();
  tickClock();
  scheduleClock();

  $('#dialFill').style.strokeDasharray = String(DIAL_C);
  $('#ringMini').style.strokeDasharray = String(MINI_C);

  try {
    const data = await api.bootstrap();
    if (data.settings && typeof data.settings === 'object') {
      state.settings = { ...state.settings, ...data.settings };
    }
    if (data.accent) state.settings.accent = data.accent;
    if (data.version) $('#version').textContent = `v${data.version}`;
    if (data.wallpaper) setBackdrop(data.wallpaper);
    if (data.stats) state.stats = data.stats;
    if (data.icons && typeof data.icons === 'object') state.icons = { ...data.icons };
    if (Array.isArray(data.games)) state.games = data.games;
    if (Array.isArray(data.clips)) state.clips = data.clips;
    state.login = !!data.login;
    $('#loginToggle').checked = state.login;
  } catch {
    toast('Could not read system data');
  }

  applySettings();

  if (isDemo) {
    $('#addGame').hidden = true;
    $('#rescan').hidden = true;
    $('#quitBtn').hidden = true;
    $('#loginToggle').closest('.menu-row').hidden = true;
  }

  renderGames();
  renderClips();
  renderStats();
  renderFocus();
  prewarm();
}

// Rasterise the full panel once while the window is still created at panel
// size and hidden, so the first hover doesn't pay for the glass stack.
function prewarm() {
  if (isDemo) return;
  const notch = $('#notch');
  notch.classList.add('open', 'prewarm');
  void notch.offsetWidth;
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      notch.classList.remove('open', 'prewarm');
      if (window.notchGlass) window.notchGlass.setPaused(true);
      if (api.ready) api.ready();
    });
  });
}

// -------------------------------------------------------------- demo bridge

function createDemoBridge() {
  const games = [
    { id: 'demo-1', name: 'Hollow Knight', source: 'Steam' },
    { id: 'demo-2', name: 'Hades II', source: 'Steam' },
    { id: 'demo-3', name: 'Outer Wilds', source: 'Epic' },
    { id: 'demo-4', name: 'Celeste', source: 'Steam' },
    { id: 'demo-5', name: 'Tunic', source: 'Steam' },
    { id: 'demo-6', name: 'Disco Elysium', source: 'Epic' },
  ];

  let clips = [
    { id: 'clip-1', text: 'npm run dev' },
    { id: 'clip-2', text: 'A small glass pill at the top of your screen.' },
    { id: 'clip-3', text: 'moss-and-fern-42' },
  ];

  const stats = {
    cpu: 14,
    ram: { used: 9.4e9, total: 32e9 },
    disk: { free: 412e9, total: 953e9 },
    battery: 87,
    charging: false,
    uptime: (3 * 24 + 5) * 60 * 60000 + 42 * 60000,
  };

  const watchers = { stats: [], clips: [] };

  const drift = (value, amount, min, max) =>
    Math.max(min, Math.min(max, value + (Math.random() - 0.5) * amount));

  setInterval(() => {
    stats.cpu = drift(stats.cpu, 14, 3, 88);
    stats.ram.used = drift(stats.ram.used, 0.6e9, 6e9, 22e9);
    stats.uptime += 2000;
    for (const callback of watchers.stats) callback({ ...stats });
  }, 2000);

  return {
    setSettings: async (patch) => patch,
    bootstrap: async () => ({
      accent: '#7c9cff',
      version: 'demo',
      platform: 'demo',
      demo: true,
      games,
      clips,
      stats: { ...stats },
      login: false,
      canScan: false,
    }),
    setExpanded() {},
    setPinned() {},
    focus() {},
    quit() {},
    setLogin: async () => false,
    rescan: async () => games,
    addGame: async () => games,
    pickWallpaper: async () => ({ canceled: true }),
    launch: async (id) => {
      const game = games.find((item) => item.id === id);
      return { ok: Boolean(game), name: game && game.name };
    },
    copyClip: async (id) => {
      const clip = clips.find((item) => item.id === id);
      if (!clip) return false;
      try {
        await navigator.clipboard.writeText(clip.text);
      } catch {
        /* clipboard permission */
      }
      return true;
    },
    onStats: (callback) => watchers.stats.push(callback),
    onClips: (callback) => watchers.clips.push(callback),
    onTogglePin() {},
    onOpen() {},
  };
}

boot();
