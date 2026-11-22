'use strict';

const $ = (selector, root = document) => root.querySelector(selector);
const bridge = window.notchAPI;
// The demo page is dev-server-only: it is served over http and has no preload. In
// the app the page is a file:// document, so a missing bridge there is not a demo —
// it is the shell failing to load, and it must not paint the demo backdrop over the
// screen as if everything were fine.
const served = location.protocol === 'http:' || location.protocol === 'https:';
const isDemo = !bridge && served;
// The version already announced, so the notice does not repeat every check.
let announcedUpdate = '';

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
  // The store is drawn here from Steam's own prices, paged by Steam's search and
  // filled in as the list is scrolled: items are what has been fetched so far.
  store: {
    items: [],
    seen: new Set(),
    more: true,
    loading: false,
    tried: false,
    epoch: 0,
    query: '',
    discount: 0,
    budget: 0,
    sort: 'reviews',
  },
  // The last capture: a preview the panel paints, and the size it came at.
  shot: null,
  // What the updater last heard from the releases page.
  update: {
    current: '',
    latest: '',
    newer: false,
    url: '',
    page: '',
    checked: false,
    busy: false,
    percent: 0,
    error: '',
    // An install that could not run: the button offers the release page instead.
    failed: false,
  },
  // What the Windows-key helper last reported: running, starting, or refused.
  winHook: 'starting',
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
    pillHeight: 26,
    pillOffset: 0,
    pillItems: ['dot', 'time', 'focus', 'date', 'battery'],
    pillHidden: [],
    notchStyle: 'attached',
    backdrop: 'live',
    taskbar: false,
    taskbarStyle: 'glass',
    taskbarShape: 'islands',
    taskbarShow: 'both',
    taskbarAutoHide: false,
    hideWinTaskbar: true,
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
let closeSettleTimer = null;
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
  // "100%" is wider than "7%": the pill follows whatever it is holding.
  measurePillWidth();

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

  // A cross in the corner takes the game out of the library; the card still
  // launches it, so the press has to stop there rather than bubble up.
  // A span, not a button: the card is one, and a button cannot sit inside one.
  const remove = document.createElement('span');
  remove.className = 'game-remove';
  remove.setAttribute('role', 'button');
  remove.tabIndex = 0;
  remove.title = 'Remove from library';
  remove.setAttribute('aria-label', `Remove ${game.name} from the library`);
  const cross = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  cross.setAttribute('viewBox', '0 0 12 12');
  cross.setAttribute('aria-hidden', 'true');
  const stroke = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  stroke.setAttribute('d', 'M3.2 3.2 8.8 8.8M8.8 3.2 3.2 8.8');
  cross.appendChild(stroke);
  remove.appendChild(cross);
  remove.addEventListener('pointerdown', (event) => event.stopPropagation());
  remove.addEventListener('click', (event) => {
    event.stopPropagation();
    event.preventDefault();
    removeGame(game);
  });
  remove.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    event.stopPropagation();
    removeGame(game);
  });

  button.append(art, text, play, remove);
  button.addEventListener('click', () => launchGame(game));
  return button;
}

// The library is a list of what you want to see: taking a game out is Notch's
// own note, and nothing on disk is touched.
async function removeGame(game) {
  if (!api.removeGame || !game) return;
  try {
    const list = await api.removeGame(game.id);
    if (!Array.isArray(list)) return;
    state.games = list;
    renderGames();
    if (state.detail === 'library') renderDetail();
    toast(`Removed ${game.name}`);
  } catch {
    toast('Could not remove that game');
  }
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

// The dial is the way to any length of session: press it, type the minutes, Enter.
// The presets stay as shortcuts for the common ones.
function editableTime(dial) {
  if (!dial || dial.dataset.editable) return;
  dial.dataset.editable = '1';
  dial.title = 'Set any time';
  dial.addEventListener('pointerdown', (event) => event.stopPropagation());
  dial.addEventListener('click', (event) => {
    event.stopPropagation();
    if (dial.querySelector('input')) return;
    const label = dial.querySelector('.dial-time, .detail-dial-time');
    if (!label) return;
    const input = document.createElement('input');
    input.type = 'number';
    input.className = 'dial-input';
    input.min = '1';
    input.max = '180';
    input.step = '1';
    input.value = String(focus.minutes);
    input.setAttribute('aria-label', 'Focus minutes');
    label.hidden = true;
    dial.append(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (apply) => {
      if (done) return;
      done = true;
      const minutes = Math.max(1, Math.min(180, Math.round(Number(input.value)) || 0));
      input.remove();
      label.hidden = false;
      if (apply && minutes) setFocusMinutes(minutes);
      else renderFocus();
    };
    input.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'Enter') {
        event.preventDefault();
        finish(true);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        finish(false);
      }
    });
    input.addEventListener('blur', () => finish(true));
  });
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
  { key: 'pill', label: 'Pill', type: 'action', action: 'pillEditor', button: 'Customise…' },
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
  { key: 'hideWinTaskbar', label: 'Hide Windows taskbar', type: 'toggle' },
  { key: 'syncPins', label: 'Pins', type: 'action', action: 'syncPins', button: 'Sync with Windows' },
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
  { key: 'winHook', label: 'Key hook', type: 'status', text: () => state.winHook },
  { group: 'Update' },
  { key: 'version', label: 'Version', type: 'status', text: () => state.update.current || 'unknown' },
  { key: 'update', label: 'Updates', type: 'update' },
];

function applySettings() {
  const s = state.settings;
  const root = document.documentElement;
  root.style.setProperty('--accent', s.accent);
  root.style.setProperty('--motion', String(s.motion / 100));
  root.classList.toggle('force-motion', s.animations === 'always');
  root.style.setProperty('--pill-w', `${s.pillWidth}px`);
  root.style.setProperty('--pill-h', `${s.pillHeight}px`);
  root.style.setProperty('--pill-offset', `${s.pillOffset}px`);
  applyPillLayout();
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

// The pill carries the updater's answer without the panel being opened: when a
// newer build is waiting the dot turns green and says so on hover, and the menu
// foot writes the two versions side by side.
function paintUpdate() {
  const u = state.update;
  const dot = $('#statusDot');
  if (dot) {
    dot.classList.toggle('update', !!u.newer);
    dot.title = u.newer ? `Notch ${u.latest} is ready` : u.checked ? 'Up to date' : '';
  }
  const version = $('#version');
  if (version && u.current) {
    version.textContent = u.newer && u.latest ? `v${u.current} \u2192 v${u.latest}` : `v${u.current}`;
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
  settingsPage = 'main';
  $('#settingsSheet').hidden = false;
  renderSettings();
  // Ask as the sheet opens whether the key helper is actually up: a key that is
  // being refused on this machine is then visible instead of silently dead.
  if (api.winHook) {
    Promise.resolve(api.winHook())
      .then((status) => {
        if (!status) return;
        state.winHook = status;
        if (state.settingsOpen) renderSettings();
      })
      .catch(() => {});
  }
}

function closeSettings() {
  state.settingsOpen = false;
  state.busy = false;
  settingsPage = 'main';
  $('#settingsSheet').hidden = true;
}

// ------------------------------------------------------------------- the pill

// Everything the folded pill can be made of, in the order the editor offers it.
const PILL_ITEMS = [
  ['dot', 'Status dot'],
  ['time', 'Clock'],
  ['focus', 'Focus timer'],
  ['date', 'Date'],
  ['battery', 'Battery'],
];

// Which page of the settings sheet is open: the list, or the pill editor.
let settingsPage = 'main';

// The live pill's pieces are kept by reference: turning one off takes it out of
// the DOM, and it has to be findable the moment it is turned back on.
let pillParts = null;
function pillLiveParts() {
  // Re-read while the pill has not been found yet: the settings can be applied
  // before the document has finished laying the pill out.
  if (!pillParts || !pillParts.dot) {
    pillParts = {
      dot: $('#statusDot'),
      time: $('#pillTime'),
      focus: $('#focusMini'),
      date: $('#pillDate'),
      battery: $('#batteryPill'),
    };
  }
  return pillParts;
}

function pillOrder() {
  const known = PILL_ITEMS.map(([key]) => key);
  const stored = Array.isArray(state.settings.pillItems) ? state.settings.pillItems : [];
  const order = [];
  for (const key of stored) if (known.includes(key) && !order.includes(key)) order.push(key);
  for (const key of known) if (!order.includes(key)) order.push(key);
  return order;
}

function pillVisible() {
  const hidden = Array.isArray(state.settings.pillHidden) ? state.settings.pillHidden : [];
  return pillOrder().filter((key) => !hidden.includes(key));
}

function pillSeparator(key, next) {
  const writing = (value) => value === 'time' || value === 'date';
  if (writing(key) && writing(next)) {
    const sep = document.createElement('span');
    sep.className = 'pill-sep';
    sep.textContent = '·';
    return sep;
  }
  if (next === 'battery' && key !== 'dot') {
    const gap = document.createElement('span');
    gap.className = 'pill-gap';
    return gap;
  }
  return null;
}

// Rebuilds the folded pill in the chosen order, keeping the same nodes so the
// clock and the battery keep writing into them.
function applyPillLayout() {
  const collapsed = $('#collapsed');
  if (!collapsed) return;
  const parts = pillLiveParts();
  const order = pillVisible().filter((key) => parts[key]);
  collapsed.replaceChildren();
  order.forEach((key, index) => {
    collapsed.appendChild(parts[key]);
    const separator = pillSeparator(key, order[index + 1]);
    if (separator) collapsed.appendChild(separator);
  });
  measurePillWidth();
}

// The pill is as wide as its pieces need. The width setting is a floor rather
// than a ceiling: a piece that was switched on must not be pushed out of the
// clip that shows it, so the pill — and the hover rect behind it — grows.
let pillMeasuredWidth = 0;
function measurePillWidth() {
  const collapsed = $('#collapsed');
  if (!collapsed) return;
  const kids = [...collapsed.children];
  const inner = kids.reduce((sum, el) => sum + el.getBoundingClientRect().width, 0);
  // The row's own gap and the padding either side of it.
  const natural = Math.ceil(inner + Math.max(0, kids.length - 1) * 6 + 20);
  const wanted = Math.max(Number(state.settings.pillWidth) || 96, natural);
  if (wanted === pillMeasuredWidth) return;
  pillMeasuredWidth = wanted;
  document.documentElement.style.setProperty('--pill-w', `${wanted}px`);
  if (api && api.pillWidth) api.pillWidth(wanted);
}

// The preview is drawn from copies, not the live pill: the sheet is open, so the
// real pill is folded away, and its clock and battery belong to the real thing.
function pillMock(key) {
  if (key === 'dot') {
    const dot = document.createElement('span');
    dot.className = 'status-dot';
    return dot;
  }
  if (key === 'time') {
    const time = document.createElement('span');
    time.className = 'pill-time';
    time.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return time;
  }
  if (key === 'date') {
    const date = document.createElement('span');
    date.className = 'pill-date';
    date.textContent = new Intl.DateTimeFormat(undefined, {
      weekday: 'short',
      day: 'numeric',
    }).format(new Date());
    return date;
  }
  if (key === 'battery') {
    const wrap = document.createElement('span');
    wrap.className = 'battery';
    const svg = svgNode('svg', { viewBox: '0 0 24 14', 'aria-hidden': 'true' });
    svg.appendChild(
      svgNode('rect', { class: 'batt-shell', x: 0.8, y: 2.4, width: 19.4, height: 9.2, rx: 2.8 }),
    );
    svg.appendChild(
      svgNode('rect', { class: 'batt-fill', x: 2.6, y: 4.2, width: 11, height: 5.6, rx: 1.4 }),
    );
    svg.appendChild(svgNode('rect', { class: 'batt-tip', x: 21.4, y: 5.2, width: 2, height: 3.6, rx: 1 }));
    const label = document.createElement('span');
    label.className = 'batt-text';
    label.textContent = '76%';
    wrap.append(svg, label);
    return wrap;
  }
  const mini = document.createElement('span');
  mini.className = 'focus-mini';
  const svg = svgNode('svg', { viewBox: '0 0 20 20', 'aria-hidden': 'true' });
  svg.appendChild(svgNode('circle', { class: 'ring-track', cx: 10, cy: 10, r: 7.6 }));
  svg.appendChild(svgNode('circle', { class: 'ring-fill', cx: 10, cy: 10, r: 7.6 }));
  const label = document.createElement('span');
  label.textContent = '25:00';
  mini.append(svg, label);
  return mini;
}

// Dragging a row in the list reorders the pill: the row follows the pointer and
// the list is rebuilt in the new order when it is dropped.
function beginPillItemDrag(event, row, list, key) {
  if (event.target instanceof HTMLElement && event.target.closest('input')) return;
  const rows = [...list.children];
  if (rows.length < 2) return;
  const startY = event.clientY;
  const step = rows[1].getBoundingClientRect().top - rows[0].getBoundingClientRect().top;
  let moved = 0;
  row.classList.add('lift');
  const move = (moveEvent) => {
    moved = moveEvent.clientY - startY;
    row.style.transform = `translateY(${moved}px)`;
  };
  const finish = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', finish);
    window.removeEventListener('pointercancel', finish);
    row.style.transform = '';
    row.classList.remove('lift');
    const shift = step > 0 ? Math.round(moved / step) : 0;
    if (!shift) return;
    const order = pillOrder();
    const from = order.indexOf(key);
    const to = Math.max(0, Math.min(order.length - 1, from + shift));
    if (from < 0 || to === from) return;
    order.splice(to, 0, ...order.splice(from, 1));
    updateSetting('pillItems', order);
    renderSettings();
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', finish);
  window.addEventListener('pointercancel', finish);
  event.preventDefault();
}

function renderPillEditor(body) {
  const s = state.settings;

  const back = document.createElement('button');
  back.type = 'button';
  back.className = 'pill-back';
  back.textContent = '‹ Settings';
  back.addEventListener('click', () => {
    settingsPage = 'main';
    renderSettings();
  });
  body.appendChild(back);

  // The stage is the top of the screen at a souvenir size: drag the pill across
  // it and that is where it will hang.
  const stage = document.createElement('div');
  stage.className = 'pill-stage';
  const preview = document.createElement('div');
  preview.className = 'pill-preview';
  preview.title = 'Drag to move the pill';
  // The preview is never narrower than the pill itself will be: the real one
  // grows to its pieces, so the picture of it has to as well.
  const sizePreviewWidth = (el, width) => {
    el.style.width = `${width}px`;
    const natural = Math.ceil(el.scrollWidth);
    if (natural > width) el.style.width = `${natural}px`;
  };

  const shown = pillVisible();
  shown.forEach((key, index) => {
    preview.appendChild(pillMock(key));
    const separator = pillSeparator(key, shown[index + 1]);
    if (separator) preview.appendChild(separator);
  });
  preview.style.height = `${s.pillHeight}px`;
  stage.appendChild(preview);
  sizePreviewWidth(preview, s.pillWidth);
  const hint = document.createElement('span');
  hint.className = 'pill-stage-hint';
  hint.textContent = 'drag to move';
  stage.appendChild(hint);
  body.appendChild(stage);

  let drag = null;
  preview.addEventListener('pointerdown', (event) => {
    drag = { x: event.clientX, start: Number(state.settings.pillOffset) || 0, value: 0 };
    drag.value = drag.start;
    preview.setPointerCapture(event.pointerId);
    preview.classList.add('dragging');
    event.preventDefault();
  });
  preview.addEventListener('pointermove', (event) => {
    if (!drag) return;
    const room = Math.max(0, (stage.clientWidth - preview.offsetWidth) / 2);
    const next = Math.max(-room, Math.min(room, drag.start + (event.clientX - drag.x)));
    drag.value = Math.round(next);
    // Only the variable moves while the finger is down; the setting is written
    // once, on release, so the glass is not re-rendered for every pixel.
    document.documentElement.style.setProperty('--pill-offset', `${drag.value}px`);
  });
  const release = () => {
    if (!drag) return;
    const value = drag.value;
    drag = null;
    preview.classList.remove('dragging');
    updateSetting('pillOffset', value);
  };
  preview.addEventListener('pointerup', release);
  preview.addEventListener('pointercancel', release);

  const rangeRow = (label, key, min, max, step, suffix) => {
    const row = document.createElement('div');
    row.className = 'set-row';
    const name = document.createElement('span');
    name.className = 'set-key';
    name.textContent = label;
    const wrap = document.createElement('span');
    wrap.className = 'pill-range';
    const value = document.createElement('span');
    value.className = 'set-val';
    value.textContent = `${state.settings[key]}${suffix}`;
    const input = document.createElement('input');
    input.type = 'range';
    input.min = min;
    input.max = max;
    input.step = step;
    input.value = state.settings[key];
    input.addEventListener('input', () => {
      value.textContent = `${input.value}${suffix}`;
      updateSetting(key, Number(input.value));
      sizePreviewWidth(preview, state.settings.pillWidth);
      preview.style.height = `${state.settings.pillHeight}px`;
    });
    wrap.append(input, value);
    row.append(name, wrap);
    body.appendChild(row);
  };
  rangeRow('Width', 'pillWidth', 72, 200, 4, 'px');
  rangeRow('Height', 'pillHeight', 20, 36, 2, 'px');

  const group = document.createElement('div');
  group.className = 'set-group';
  group.textContent = 'Widgets';
  body.appendChild(group);

  const note = document.createElement('p');
  note.className = 'pill-editor-hint';
  note.textContent = 'Drag a row to move it in the pill. Untick to hide it.';
  body.appendChild(note);

  const list = document.createElement('div');
  list.className = 'pill-items';
  body.appendChild(list);

  const hidden = Array.isArray(state.settings.pillHidden) ? state.settings.pillHidden : [];
  for (const key of pillOrder()) {
    const row = document.createElement('div');
    row.className = 'pill-item';
    row.dataset.key = key;

    const grip = document.createElement('span');
    grip.className = 'pill-grip';
    grip.setAttribute('aria-hidden', 'true');
    grip.textContent = '⠿';

    const label = document.createElement('span');
    label.className = 'pill-item-label';
    label.textContent = (PILL_ITEMS.find(([value]) => value === key) || [key, key])[1];

    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.className = 'set-switch';
    toggle.checked = !hidden.includes(key);
    toggle.addEventListener('change', () => {
      const next = new Set(Array.isArray(state.settings.pillHidden) ? state.settings.pillHidden : []);
      if (toggle.checked) next.delete(key);
      else next.add(key);
      updateSetting('pillHidden', [...next]);
      renderSettings();
    });

    row.append(grip, label, toggle);
    list.appendChild(row);
    row.addEventListener('pointerdown', (event) => beginPillItemDrag(event, row, list, key));
  }
}

function renderSettings() {
  const body = $('#settingsBody');
  body.replaceChildren();
  const s = state.settings;

  if (settingsPage === 'pill') {
    renderPillEditor(body);
    return;
  }

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
      button.addEventListener('click', async () => {
        if (item.action === 'pickWallpaper') pickWallpaper();
        else if (item.action === 'pillEditor') {
          settingsPage = 'pill';
          renderSettings();
        } else if (item.action === 'syncPins') {
          // Windows' pins, in Windows' order: the bar is rebuilt from them.
          const result = await api.syncPins();
          toast(result && result.ok ? 'Pins synced with Windows' : 'No Windows pins found');
          renderSettings();
        }
      });
      row.appendChild(button);
    } else if (item.type === 'status') {
      if (isDemo) continue;
      const value = document.createElement('span');
      value.className = 'set-val';
      value.textContent = item.text();
      row.appendChild(value);
    } else if (item.type === 'update') {
      if (isDemo) continue;
      const wrap = document.createElement('span');
      wrap.style.display = 'flex';
      wrap.style.alignItems = 'center';
      wrap.style.gap = '10px';
      const u = state.update;
      const when = u.checkedAt
        ? new Date(u.checkedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        : '';
      const note = document.createElement('span');
      note.className = 'set-val';
      if (u.busy) {
        note.id = 'updateProgress';
        note.textContent = u.percent < 100 ? `Downloading ${u.percent}%` : 'Installing\u2026';
      } else if (u.newer) {
        note.textContent = `v${u.current} \u2192 v${u.latest}${when ? ` \u00b7 checked ${when}` : ''}`;
      } else if (u.error) {
        note.textContent = u.error;
      } else if (u.checked) {
        note.textContent = `v${u.current} is the newest${when ? ` \u00b7 checked ${when}` : ''}`;
      } else {
        note.textContent = '';
      }
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'set-action';
      button.disabled = u.busy;
      if (u.busy) button.textContent = 'Updating\u2026';
      else if (u.failed) button.textContent = 'Open release';
      else if (u.newer && u.url) button.textContent = 'Install';
      else if (u.newer) button.textContent = 'Open release';
      else button.textContent = 'Check now';
      button.addEventListener('click', async () => {
        // An install that could not run is not a dead end: the same file can be
        // downloaded from the release page by hand.
        if (state.update.failed) {
          if (api.openUpdatePage) api.openUpdatePage();
          state.update = { ...state.update, failed: false };
          renderSettings();
          return;
        }
        if (state.update.newer && state.update.url) {
          state.update = { ...state.update, busy: true, percent: 0 };
          renderSettings();
          const result = await api.installUpdate();
          if (!result || !result.ok) {
            state.update = {
              ...state.update,
              busy: false,
              failed: true,
              error: (result && result.error) || 'Update failed',
            };
            renderSettings();
          } else {
            toast(`Installing Notch ${state.update.latest}`);
          }
          return;
        }
        if (state.update.newer) {
          if (api.openUpdatePage) api.openUpdatePage();
          return;
        }
        const result = await api.checkUpdate();
        if (result) state.update = { ...state.update, ...result, checked: true, failed: false };
        renderSettings();
        toast(state.update.newer ? `Notch ${state.update.latest} is ready` : 'Notch is up to date');
      });
      wrap.append(note, button);
      row.appendChild(wrap);
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

  // Hovering a tile builds its window in the background, so a drag that starts a
  // moment later already has something to pull out.
  tile.addEventListener('pointerenter', () => {
    if (api.prewarmTile) api.prewarmTile(kind);
  });

  tile.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    // No capture yet: capturing here retargets the click that follows to the tile, so
    // a press on the tile's own controls never reaches them — the bag in the library
    // opened the library instead of the store. Capture waits until there is a drag.
    drag = { id: event.pointerId, x: event.screenX, y: event.screenY, started: false, warmed: false };
  });

  tile.addEventListener('pointermove', (event) => {
    if (!drag || event.pointerId !== drag.id) return;
    const travelled = Math.hypot(event.screenX - drag.x, event.screenY - drag.y);
    // A couple of pixels is enough to know this is a pull, not a tap: the window is
    // built now, while the pointer is still moving, so it is ready to appear on the
    // move that actually starts the drag instead of a page load later.
    if (!drag.warmed && travelled > 2) {
      drag.warmed = true;
      if (api.prewarmTile) api.prewarmTile(kind);
    }
    if (!drag.started && travelled > 6) {
      drag.started = true;
      state.detaching = true;
      tile.classList.add('detaching');
      try {
        tile.setPointerCapture?.(event.pointerId);
      } catch {
        /* the pointer is already gone: the drag follows the cursor from main */
      }
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
  shot: 'Screenshot',
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
  // The store view is gone: a page that lands after this has nothing to paint.
  storePaint = null;
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
  } else if (kind === 'focus') {
    renderDetailFocus(body);
  } else if (kind === 'shot') {
    if (state.shot) meta.textContent = `${state.shot.width} × ${state.shot.height}`;
    renderDetailShot(body);
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

// The store is Steam's catalogue with Notch's own hands on it. The list is paged
// out of Steam's own search — a hundred rows at a time, in the order chosen here —
// and drawn a screenful at a time, so it scrolls as far as it is scrolled.
const STORE_DISCOUNTS = [0, 25, 50, 75];
const STORE_BUDGETS = [0, 500, 1000, 2000];
const STORE_SORTS = [
  ['reviews', 'Best reviewed'],
  ['popular', 'Most reviewed'],
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
  if (item.review && item.review.percent) {
    return `${item.review.label || 'Reviewed'} · ${item.review.percent}%`;
  }
  if (item.source === 'new') return 'New release';
  if (item.source === 'top') return 'Top rated';
  return item.discount ? 'Deal' : 'Steam';
}

// The view is drawn into this, so a page that lands while it is open repaints it
// in place instead of rebuilding the panel (which would lose the scroll and the
// caret in the search box). Null while the store page is closed.
let storePaint = null;

// A different search, order or filter is a different list: drop what has been
// fetched and start again from the first row.
function resetStore() {
  const store = state.store;
  store.epoch += 1;
  store.items = [];
  store.seen.clear();
  store.more = true;
  store.loading = false;
  store.tried = false;
}

// One more screenful from Steam, appended to what is already here. The order is
// Steam's (it is the order the view asked for), so a page can simply be added.
async function loadStorePage() {
  const store = state.store;
  if (store.loading || !store.more || !api.storePage) return;
  const epoch = store.epoch;
  store.loading = true;
  if (storePaint) storePaint();
  try {
    const page = await api.storePage({
      start: store.items.length,
      term: store.query.trim(),
      sort: store.sort,
      deals: store.discount > 0,
      maxprice: store.budget ? store.budget / 100 : 0,
    });
    // A filter changed while this page was on its way: it belongs to a list that
    // is no longer on screen.
    if (epoch !== store.epoch) return;
    const items = page && Array.isArray(page.items) ? page.items : [];
    const batch = items.filter((item) => item && item.appid && !store.seen.has(item.appid));
    // Two of the orders on offer have no answer in Steam's search, so each page
    // is put in that order as it arrives: the list keeps its place and every
    // screenful still leads with what its name promises.
    if (store.sort === 'popular') {
      batch.sort(
        (a, b) =>
          (b.review ? b.review.count : -1) - (a.review ? a.review.count : -1),
      );
    } else if (store.sort === 'discount') {
      batch.sort((a, b) => b.discount - a.discount || a.final - b.final);
    }
    for (const item of batch) {
      store.seen.add(item.appid);
      store.items.push(item);
    }
    store.more = !!page && page.more === true && items.length > 0;
    store.tried = true;
    if (page && page.error) toast('Steam is not answering');
  } catch {
    if (epoch === store.epoch) store.tried = true;
    toast('Steam is not answering');
  } finally {
    if (epoch === store.epoch) {
      store.loading = false;
      if (storePaint) storePaint();
    }
  }
}

// Steam answered the search itself, so the rows are already the matches; the
// chips are the part that is filtered here, as pages arrive.
function storeRows() {
  const store = state.store;
  return store.items.filter((item) => {
    if (item.discount < store.discount) return false;
    // A budget is a question about a price, and a row Steam did not quote one for
    // cannot answer it — so it steps out rather than pretending to be free.
    if (store.budget && (!item.priced || item.final > store.budget)) return false;
    return true;
  });
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
  final.textContent = !item.priced
    ? '—'
    : item.free
      ? 'Free'
      : money(item.final, item.currency);
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
      if (store.discount === value) return;
      store.discount = value;
      resetStore();
      renderDetail();
    });
  }
  for (const value of STORE_BUDGETS) {
    chipButton(value ? `Under ${money(value, currency)}` : 'Any price', store.budget === value, () => {
      if (store.budget === value) return;
      store.budget = value;
      resetStore();
      renderDetail();
    });
  }
  chipButton('Refresh', false, () => {
    resetStore();
    renderDetail();
  });
  wrap.appendChild(chips);

  // What stands in when there are no rows to draw (loading, closed, nothing
  // matches). The list itself is only the scroll box; its contents are a top
  // spacer, the few rows around the viewport, and a bottom spacer.
  const notice = document.createElement('div');
  notice.className = 'store-notice';

  const list = document.createElement('div');
  list.className = 'store-list';
  const spaceTop = document.createElement('div');
  spaceTop.className = 'store-space';
  const grid = document.createElement('div');
  grid.className = 'store-grid';
  const spaceBottom = document.createElement('div');
  spaceBottom.className = 'store-space';
  const footer = document.createElement('div');
  footer.className = 'store-more';
  list.append(spaceTop, grid, spaceBottom, footer);

  wrap.append(notice, list);
  body.appendChild(wrap);

  // Two columns, 58 px rows and a 7 px gap, so one row of the virtual list is one
  // step of the scroll. Only the rows around the viewport exist in the document:
  // two above and two below mean a fast wheel never shows a hole, and the spacers
  // keep the scrollbar honest about the length of the whole list.
  const STEP = 58 + 7;
  const MARGIN = 2;
  let paintedFrom = -1;
  let paintedTo = -1;
  let paintedCount = -1;

  const paint = () => {
    const meta = $('#detailMeta');
    if (meta) meta.textContent = store.items.length ? `${store.items.length} on the list` : '';

    const rows = storeRows();
    notice.replaceChildren();
    if (!store.items.length) {
      const asking = store.loading || !store.tried;
      notice.appendChild(
        emptyBlock(
          asking ? 'Asking Steam…' : 'The store is closed',
          api.storePage
            ? 'Prices, discounts and what is on sale today.'
            : 'Start the app from Notch.exe to reach the store.',
        ),
      );
    } else if (!rows.length) {
      notice.appendChild(emptyBlock('Nothing matches', 'Loosen a filter or clear the search.'));
    }
    list.hidden = !rows.length;
    if (!rows.length) return;

    const total = Math.ceil(rows.length / 2);
    const viewH = list.clientHeight || 320;
    const first = Math.max(0, Math.min(total - 1, Math.floor(list.scrollTop / STEP) - MARGIN));
    const last = Math.min(
      total - 1,
      Math.max(first, Math.ceil((list.scrollTop + viewH) / STEP) + MARGIN),
    );

    spaceTop.style.height = `${first * STEP}px`;
    spaceBottom.style.height = `${(total - 1 - last) * STEP}px`;
    // The same rows are redrawn only when the window actually moved or the list
    // grew: a short scroll inside the margin keeps the pictures it already has.
    if (first !== paintedFrom || last !== paintedTo || rows.length !== paintedCount) {
      paintedFrom = first;
      paintedTo = last;
      paintedCount = rows.length;
      grid.replaceChildren();
      for (let index = first * 2; index < Math.min(rows.length, (last + 1) * 2); index += 1) {
        grid.appendChild(storeRow(rows[index]));
      }
    }
    footer.textContent = store.loading ? 'Asking Steam…' : store.more ? '' : 'That is every match';

    // A chip can leave the list shorter than the viewport while Steam still has
    // more rows behind it: keep asking until it fills, but not forever.
    if (store.more && !store.loading && store.items.length < 600) {
      if (list.scrollHeight <= list.clientHeight + 400) loadStorePage();
    }
  };

  storePaint = paint;
  paint();
  if (!store.items.length && !store.loading && !store.tried) loadStorePage();

  // The list never reaches its end before the next page is there: four hundred
  // pixels from the bottom is the point to ask for it.
  let scrollFrame = 0;
  list.addEventListener(
    'scroll',
    () => {
      if (scrollFrame) return;
      scrollFrame = requestAnimationFrame(() => {
        scrollFrame = 0;
        paint();
        if (list.scrollTop + list.clientHeight >= list.scrollHeight - 400) loadStorePage();
      });
    },
    { passive: true },
  );

  // Typing filters what is on screen at once and asks Steam for the real matches
  // a moment later, without rebuilding the view, so the caret stays put.
  let queryTimer = 0;
  input.addEventListener('input', () => {
    store.query = input.value;
    clearTimeout(queryTimer);
    queryTimer = setTimeout(() => {
      resetStore();
      list.scrollTop = 0;
      paint();
      loadStorePage();
    }, 320);
  });
  sort.addEventListener('change', () => {
    store.sort = sort.value;
    resetStore();
    list.scrollTop = 0;
    paint();
    loadStorePage();
  });
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
  editableTime(dial);

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

// A screenshot is one capture plus the three things it can be turned into: a file
// in Pictures, the text on the clipboard, and a guess at the typeface.
function shotAction(label, icon) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'shot-action';
  button.append(icon);
  const text = document.createElement('span');
  text.className = 'shot-action-label';
  text.textContent = label;
  button.appendChild(text);
  return button;
}

function shotIcon(paths, circles = []) {
  const svg = svgNode('svg', { viewBox: '0 0 16 16', 'aria-hidden': 'true' });
  for (const d of paths) svg.appendChild(svgNode('path', { d }));
  for (const circle of circles) svg.appendChild(svgNode('circle', circle));
  return svg;
}

function renderDetailShot(body) {
  const shot = state.shot;
  if (!shot) {
    const empty = document.createElement('p');
    empty.className = 'detail-sub';
    empty.textContent = 'Press the camera to take one.';
    body.appendChild(empty);
    return;
  }

  const wrap = document.createElement('div');
  wrap.className = 'detail-shot';

  const frame = document.createElement('div');
  frame.className = 'shot-frame';
  const image = document.createElement('img');
  image.className = 'shot-image';
  image.alt = 'Screenshot';
  image.src = shot.preview;
  frame.appendChild(image);
  const size = document.createElement('span');
  size.className = 'shot-size';
  size.textContent = `${shot.width} × ${shot.height}`;
  frame.appendChild(size);
  wrap.appendChild(frame);

  const result = document.createElement('div');
  result.className = 'shot-result';
  const note = (message) => {
    const line = document.createElement('p');
    line.className = 'detail-sub shot-note';
    line.textContent = message;
    return line;
  };

  const save = shotAction('Save', shotIcon(['M3 5.4h2.2l.9-1.6h4.8l.9 1.6H13v6.4H3z']));
  save.title = 'Save to Pictures\\Notch\\Screenshots';
  save.addEventListener('click', async () => {
    save.disabled = true;
    const answer = await api.saveShot();
    if (answer && answer.ok) {
      save.classList.add('done');
      save.querySelector('.shot-action-label').textContent = 'Saved';
      toast('Saved to Pictures\\Notch\\Screenshots');
    } else {
      save.disabled = false;
      toast((answer && answer.error) || 'Could not save');
    }
  });

  const read = shotAction(
    'Text',
    shotIcon(['M2.8 4.6h10.4', 'M5.6 4.6v7.2', 'M10.4 4.6v7.2', 'M4 11.8h3.2', 'M8.8 11.8H12']),
  );
  read.title = 'Read the text and copy it';
  read.addEventListener('click', async () => {
    read.disabled = true;
    result.replaceChildren(note('Reading the picture…'));
    const answer = await api.shotText();
    read.disabled = false;
    if (!answer || !answer.ok) {
      result.replaceChildren(note((answer && answer.error) || 'No text found'));
      return;
    }
    const text = String(answer.text || '').trim();
    if (!text) {
      result.replaceChildren(note('No text in this picture'));
      return;
    }
    const block = document.createElement('pre');
    block.className = 'shot-text';
    block.textContent = text;
    result.replaceChildren(note(`Copied to the clipboard · ${text.length} characters`), block);
    toast('Text copied');
  });

  const font = shotAction('Font', shotIcon(['M3.2 12.6 6.9 3.8l3.7 8.8', 'M4.8 9.4h4.4']));
  font.title = 'Guess the typeface';
  font.addEventListener('click', async () => {
    font.disabled = true;
    result.replaceChildren(note('Comparing the lettering…'));
    const answer = await api.shotFont();
    font.disabled = false;
    if (!answer || !answer.ok) {
      result.replaceChildren(note((answer && answer.error) || 'Could not read the lettering'));
      return;
    }
    const fonts = Array.isArray(answer.fonts) ? answer.fonts : [];
    if (!fonts.length) {
      result.replaceChildren(note('No lettering to compare in this picture'));
      return;
    }
    const list = document.createElement('div');
    list.className = 'shot-fonts';
    fonts.slice(0, 4).forEach((entry, index) => {
      const row = document.createElement('div');
      row.className = index === 0 ? 'shot-font best' : 'shot-font';
      const name = document.createElement('span');
      name.className = 'shot-font-name';
      name.textContent = String(entry.name || '?');
      name.title = name.textContent;
      const track = document.createElement('span');
      track.className = 'shot-font-bar';
      const fill = document.createElement('i');
      fill.style.width = `${Math.max(4, Math.min(100, Math.round((entry.score || 0) * 100)))}%`;
      track.appendChild(fill);
      const value = document.createElement('span');
      value.className = 'shot-font-score';
      value.textContent = `${Math.round((entry.score || 0) * 100)}%`;
      row.append(name, track, value);
      list.appendChild(row);
    });
    result.replaceChildren(note('Best guesses, from the biggest line of text'), list);
  });

  const actions = document.createElement('div');
  actions.className = 'shot-actions';
  actions.append(save, read, font);
  wrap.append(actions, result);
  body.appendChild(wrap);
}

// --------------------------------------------------------------------- shell

function openNotch() {
  if (state.open) return;
  clearTimeout(hoverTimer);
  state.open = true;
  clearTimeout(closeTimer);
  api.setExpanded(true);
  if (api.setCollapsing) api.setCollapsing(0);
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

// How long the clip's close transition really runs: the animation-speed setting
// scales it, so the window cannot assume a fixed 340ms. It keeps the panel
// hoverable until the shape has finished shrinking, plus a little slack for the
// last frames of the spring.
function closeMs() {
  const notch = $('#notch');
  if (!notch) return 430;
  const raw = getComputedStyle(notch).transitionDuration || '';
  const longest = raw
    .split(',')
    .map((part) => {
      const text = part.trim();
      const value = parseFloat(text) || 0;
      return text.endsWith('ms') ? value : value * 1000;
    })
    .reduce((a, b) => Math.max(a, b), 0);
  return Math.round(longest || 340) + 90;
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
  // Read after the class swap, so the duration is the close one, not the open one.
  // Everything that has to outlive the shrinking shape — the hover rect the
  // window keeps open, the content that must not vanish mid-motion, the shader —
  // runs off this number, not off a fixed guess that ignored the animation speed.
  const closing = closeMs();
  if (api.setCollapsing) api.setCollapsing(closing);
  const settle = () => {
    notch.removeEventListener('transitionend', onClipEnd);
    if (state.open) return;
    notch.classList.remove('closing');
    // Nothing of the shader is on screen now, so stop its render loop.
    if (window.notchGlass) window.notchGlass.setPaused(true);
  };
  // The transition ending is the accurate end of the shrink; the timer is only
  // the safety net for a frame that never reports one.
  const onClipEnd = (event) => {
    if (event.target !== notch || event.propertyName !== 'clip-path') return;
    clearTimeout(closeSettleTimer);
    if (api.setCollapsing) api.setCollapsing(0);
    settle();
  };
  notch.addEventListener('transitionend', onClipEnd);
  clearTimeout(closeSettleTimer);
  closeSettleTimer = setTimeout(settle, closing);
  notch.setAttribute('aria-expanded', 'false');
  hideMenu();
  $('#gameSearch').blur();
  clearTimeout(closeTimer);
  closeTimer = setTimeout(() => {
    if (!state.open) api.setExpanded(false);
  }, closing + 40);
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

  $('#shotBtn').addEventListener('click', async () => {
    if (!api.captureShot) {
      toast('Screenshots need the desktop app');
      return;
    }
    const button = $('#shotBtn');
    button.disabled = true;
    let answer = null;
    try {
      answer = await api.captureShot();
    } catch {
      answer = { ok: false, error: 'The screen could not be read' };
    }
    button.disabled = false;
    if (answer && answer.cancelled) return;
    if (!answer || !answer.ok) {
      // The drag left the pointer out on the desktop, so the panel folded itself
      // while it was away: open it again, or the reason would be said to a folded pill.
      openNotch();
      toast((answer && answer.error) || 'Could not take the picture');
      return;
    }
    state.shot = answer;
    // Choosing a region takes the pointer off the panel, so it may have folded
    // while the drag was out there: the picture opens it again.
    openNotch();
    openDetail('shot');
  });

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
  editableTime(document.querySelector('.dial'));
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
  if (api.onUpdate) {
    api.onUpdate((data) => {
      if (!data) return;
      state.update = { ...state.update, ...data, checked: true, failed: false };
      paintUpdate();
      if (state.settingsOpen) renderSettings();
      // Said once per version: a newer build is waiting, and the drawer is where it
      // is installed from.
      if (data.newer && data.latest && data.latest !== announcedUpdate) {
        announcedUpdate = data.latest;
        toast(`Notch ${data.latest} is ready — open settings to update`);
      }
    });
  }
  if (api.onUpdateProgress) {
    api.onUpdateProgress((data) => {
      if (!data) return;
      state.update.percent = data.percent || 0;
      const progress = document.getElementById('updateProgress');
      if (progress) {
        progress.textContent =
          state.update.percent < 100 ? `Downloading ${state.update.percent}%` : 'Installing\u2026';
      }
    });
  }
  // The window covers more than the notch, so the main process owns the
  // hover hit-test and hands clicks back to the desktop outside the shape.
  if (api.onPointer) {
    api.onPointer((where) => {
      if (where === 'enter') requestOpen();
      else scheduleClose();
    });
  }
  if (api.onShot) {
    api.onShot((data) => {
      if (!data || !data.ok) return;
      state.shot = data;
      if (state.detail === 'shot') renderDetail();
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
    if (data.version) state.update.current = String(data.version);
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
  paintUpdate();

  // Asked once on start as well as from the schedule in main: the drawer then has
  // an answer to show the first time it is opened, instead of an empty row.
  if (!isDemo && api.checkUpdate) {
    api
      .checkUpdate()
      .then((data) => {
        if (!data) return;
        state.update = { ...state.update, ...data, checked: true, failed: false };
        paintUpdate();
        if (state.settingsOpen) renderSettings();
      })
      .catch(() => {});
  }

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
    removeGame: async (id) => {
      const at = games.findIndex((game) => game.id === id);
      if (at >= 0) games.splice(at, 1);
      return games;
    },
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
