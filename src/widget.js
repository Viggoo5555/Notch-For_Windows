'use strict';

import './widget-glass.js';

const $ = (selector) => document.querySelector(selector);
const api = window.widgetAPI;
const tile = new URLSearchParams(location.search).get('tile') || 'system';
const TITLES = { system: 'System', focus: 'Focus', library: 'Library', clip: 'Clipboard' };
// The page title becomes the window title, which the drag helper and the
// window list both read.
document.title = TITLES[tile] || 'System';

const card = $('#card');
let expanded = false;
let drag = null;

// --------------------------------------------------------------- glass backdrop

// The lens samples the whole display under the window, so it is slid by the
// window's screen offset while the widget is dragged.
let panUntil = 0;

function syncBackdrop() {
  if (window.widgetGlass) window.widgetGlass.position(screenX, screenY);
}

function applyBackdrop(data) {
  if (!data) return;
  // The card borrows the panel's surface: black when the notch is black.
  if (window.widgetGlass) {
    if (data.surface) window.widgetGlass.surface(data.surface);
    if (data.url) window.widgetGlass.backdrop(data);
  }
  syncBackdrop();
}

function panLoop() {
  syncBackdrop();
  if (performance.now() < panUntil) requestAnimationFrame(panLoop);
}

function keepPanning(ms = 700) {
  panUntil = Math.max(panUntil, performance.now() + ms);
  requestAnimationFrame(panLoop);
}

window.addEventListener('resize', syncBackdrop);

function el(name, className, text) {
  const node = document.createElement(name);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function bar(element, value) {
  element.style.width = `${Math.max(0, Math.min(100, value))}%`;
}

// ------------------------------------------------------------------- system card

const system = {};

function buildSystem() {
  $('#wTitle').textContent = 'System';
  const meters = el('div', 'meters');
  for (const [key, label] of [
    ['cpu', 'CPU'],
    ['ram', 'Memory'],
    ['disk', 'Disk'],
  ]) {
    const row = el('div', 'meter');
    row.append(el('span', 'meter-label', label));
    const track = el('span', 'bar');
    const fill = el('i');
    fill.id = `bar-${key}`;
    track.appendChild(fill);
    const value = el('span', 'meter-val', '—');
    value.id = `val-${key}`;
    row.append(track, value);
    meters.appendChild(row);
    system[`bar_${key}`] = fill;
    system[`val_${key}`] = value;
  }

  const breakdown = el('section', 'breakdown');
  breakdown.id = 'breakdown';
  breakdown.setAttribute('aria-hidden', 'true');
  for (const [key, label] of [
    ['cpu', 'Top CPU'],
    ['ram', 'Top memory'],
  ]) {
    breakdown.appendChild(el('div', 'bhead', label));
    const list = el('ol', 'plist');
    list.id = `top-${key}`;
    breakdown.appendChild(list);
    system[`list_${key}`] = list;
  }

  $('#wBody').append(meters, breakdown);
  $('#wHint').textContent = 'Press for details · drag to move';
}

function setMeters(data) {
  const ramPct = data.ram && data.ram.total ? (data.ram.used / data.ram.total) * 100 : 0;
  const diskPct =
    data.disk && data.disk.total ? ((data.disk.total - data.disk.free) / data.disk.total) * 100 : 0;
  system.val_cpu.textContent = `${Math.round(data.cpu)}%`;
  bar(system.bar_cpu, data.cpu);
  system.val_ram.textContent = data.ram ? `${(data.ram.used / 1073741824).toFixed(1)} GB` : '—';
  bar(system.bar_ram, ramPct);
  system.val_disk.textContent = `${Math.round(diskPct)}%`;
  bar(system.bar_disk, diskPct);
}

// ----------------------------------------------------- performance overlay card

// Three numbers and nothing else: no title, no glass, no background. The frame
// rate is counted from this window's own animation callback, which is the rate the
// desktop compositor is delivering frames at — for a game in a window or borderless
// that is the rate the game is being shown at, capped by the monitor.
const perf = {};
let perfFrames = 0;
let perfStamp = 0;

function buildPerf() {
  document.body.classList.add('perf');
  const row = el('div', 'perf');
  for (const [key, label] of [
    ['fps', 'FPS'],
    ['cpu', 'CPU'],
    ['gpu', 'GPU'],
    ['ram', 'RAM'],
  ]) {
    const item = el('div', 'perf-item');
    const value = el('b', null, '—');
    value.id = `perf-${key}`;
    item.append(value, el('span', null, label));
    row.appendChild(item);
    perf[key] = value;
  }
  $('#wBody').appendChild(row);
}

function countFrames() {
  perfFrames += 1;
  const now = performance.now();
  if (!perfStamp) perfStamp = now;
  else if (now - perfStamp >= 500) {
    if (perf.fps) perf.fps.textContent = String(Math.round((perfFrames * 1000) / (now - perfStamp)));
    perfFrames = 0;
    perfStamp = now;
  }
  requestAnimationFrame(countFrames);
}

function setPerfMeters(data) {
  if (perf.cpu) perf.cpu.textContent = `${Math.round(data.cpu)}%`;
  if (perf.gpu) {
    perf.gpu.textContent =
      typeof data.gpu === 'number' && data.gpu >= 0 ? `${Math.round(data.gpu)}%` : '—';
  }
  const ramPct = data.ram && data.ram.total ? (data.ram.used / data.ram.total) * 100 : 0;
  if (perf.ram) perf.ram.textContent = `${Math.round(ramPct)}%`;
}

function renderList(element, rows) {
  element.replaceChildren();
  (rows || []).forEach((row, index) => {
    const item = el('li');
    item.style.setProperty('--i', String(index));
    const name = el('span', 'pname', row.name);
    name.title = row.name;
    const track = el('span', 'pbar');
    const fill = el('i');
    fill.style.width = `${Math.max(2, Math.min(100, row.share * 100))}%`;
    track.appendChild(fill);
    item.append(name, track, el('b', null, row.label));
    element.appendChild(item);
  });
}

function setExpanded(value) {
  expanded = !!value;
  card.classList.toggle('is-open', expanded);
  $('#breakdown').setAttribute('aria-hidden', expanded ? 'false' : 'true');
  $('#wHint').textContent = expanded ? 'Press to collapse · drag to move' : 'Press for details · drag to move';
  keepPanning(800);
}

// -------------------------------------------------------------------- focus card

const focusView = {};
let focusState = null;

const FOCUS_C = 2 * Math.PI * 34;

function clockText(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function buildFocus() {
  $('#wTitle').textContent = 'Focus';
  const dial = el('div', 'w-dial');
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 80 80');
  for (const [cls, extra] of [
    ['dial-track', {}],
    ['dial-fill', { id: 'wDialFill' }],
  ]) {
    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('cx', '40');
    circle.setAttribute('cy', '40');
    circle.setAttribute('r', '34');
    circle.setAttribute('class', cls);
    for (const [key, value] of Object.entries(extra)) circle.setAttribute(key, value);
    svg.appendChild(circle);
  }
  const time = el('span', 'w-dial-time', '25:00');
  dial.append(svg, time);
  focusView.time = time;
  focusView.fill = svg.querySelector('#wDialFill');
  focusView.fill.style.strokeDasharray = String(FOCUS_C);

  const presets = el('div', 'w-presets');
  for (const minutes of [5, 15, 25, 45]) {
    const button = el('button', null, String(minutes));
    button.type = 'button';
    button.dataset.min = String(minutes);
    button.addEventListener('click', () => api.focus(`minutes:${minutes}`));
    presets.appendChild(button);
    focusView[`preset_${minutes}`] = button;
  }

  const buttons = el('div', 'w-buttons');
  const toggle = el('button', 'primary', 'Start');
  toggle.type = 'button';
  toggle.addEventListener('click', () => api.focus('toggle'));
  const reset = el('button', 'ghost', 'Reset');
  reset.type = 'button';
  reset.addEventListener('click', () => api.focus('reset'));
  buttons.append(toggle, reset);
  focusView.toggle = toggle;

  $('#wBody').append(dial, presets, buttons);
  $('#wHint').textContent = 'Drag to move';
}

function renderFocus(next) {
  if (next) focusState = next;
  if (!focusState || !focusView.time) return;
  const remaining = focusState.running
    ? Math.max(0, focusState.endsAt - Date.now())
    : focusState.remaining;
  const progress = focusState.total > 0 ? 1 - remaining / focusState.total : 0;
  focusView.time.textContent = clockText(remaining);
  focusView.fill.style.strokeDashoffset = String(FOCUS_C * progress);
  const started = focusState.running || remaining < focusState.total;
  focusView.toggle.textContent = focusState.running ? 'Pause' : started ? 'Resume' : 'Start';
  for (const minutes of [5, 15, 25, 45]) {
    focusView[`preset_${minutes}`].classList.toggle('is-on', Number(minutes) === focusState.minutes);
  }
  card.classList.toggle('is-live', !!focusState.running);
}

// ------------------------------------------------------------ clipboard card

function renderClips(clips) {
  $('#wTitle').textContent = 'Clipboard';
  const body = $('#wBody');
  body.replaceChildren();
  const list = el('div', 'w-list');
  for (const clip of (clips || []).slice(0, 8)) {
    const row = el('button', 'w-row');
    row.type = 'button';
    const text = el('span', 'w-row-text', String(clip.text || '').replace(/\s+/g, ' ').trim());
    row.append(text, el('span', 'w-row-tag', 'copy'));
    row.addEventListener('click', async () => {
      const ok = await api.copyClip(clip.id);
      $('#wHint').textContent = ok ? 'Copied' : 'Could not copy';
    });
    list.appendChild(row);
  }
  if (!list.children.length) list.appendChild(el('div', 'w-empty', 'Nothing copied yet.'));
  body.appendChild(list);
}

// -------------------------------------------------------------- library card

function renderGames(games) {
  $('#wTitle').textContent = 'Library';
  const body = $('#wBody');
  body.replaceChildren();
  const list = el('div', 'w-list');
  for (const game of (games || []).slice(0, 10)) {
    const row = el('button', 'w-row');
    row.type = 'button';
    row.append(el('span', 'w-row-text', game.name));
    if (game.icon) {
      const icon = el('img', 'w-icon');
      icon.src = game.icon;
      icon.alt = '';
      row.prepend(icon);
    }
    row.addEventListener('click', () => api.launch(game.id));
    list.appendChild(row);
  }
  if (!list.children.length) list.appendChild(el('div', 'w-empty', 'No games found.'));
  body.appendChild(list);
}

// ---------------------------------------------------------------- interaction

card.addEventListener('pointerdown', (event) => {
  if (event.button !== 0 || event.target.closest('#close, button')) return;
  card.setPointerCapture(event.pointerId);
  drag = { x: event.clientX, y: event.clientY, moved: false };
  card.classList.add('press');
});

card.addEventListener('pointermove', (event) => {
  if (!drag || !event.buttons) return;
  if (!drag.moved && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) > 4) {
    drag.moved = true;
    card.classList.add('dragging');
    api.dragStart();
    keepPanning(600);
  }
});

function endPress(cancel) {
  if (!drag) return;
  const moved = drag.moved;
  drag = null;
  card.classList.remove('press', 'dragging');
  if (moved) api.dragEnd();
  else if (!cancel && tile === 'system') api.setExpanded(!expanded);
  keepPanning(500);
}

card.addEventListener('pointerup', () => endPress(false));
card.addEventListener('pointercancel', () => endPress(true));

$('#close').addEventListener('click', (event) => {
  event.stopPropagation();
  api.close();
});

// The System card minimises into the performance overlay: the same readings in the
// same place, with no card behind them. The overlay folds back out with its own
// button. The other cards have nothing to fold down to.
if (tile === 'system') {
  $('#minimize').addEventListener('click', (event) => {
    event.stopPropagation();
    api.minimize();
  });
} else {
  $('#minimize').remove();
}

if (tile === 'perf') {
  $('#restore').addEventListener('click', (event) => {
    event.stopPropagation();
    api.restore();
  });
} else {
  $('#restore').remove();
}

// ------------------------------------------------------------------ live data

if (tile === 'focus') buildFocus();
else if (tile === 'clip') renderClips([]);
else if (tile === 'library') renderGames([]);
else if (tile === 'perf') {
  buildPerf();
  requestAnimationFrame(countFrames);
} else buildSystem();

if (tile === 'focus') setInterval(() => renderFocus(), 1000);

api.onStats((data) => {
  if (tile === 'system') setMeters(data);
  else if (tile === 'perf') setPerfMeters(data);
  else if (tile === 'focus' && data.focus) renderFocus(data.focus);
});
api.onBackdrop(applyBackdrop);
api.onProcesses((data) => {
  if (tile !== 'system') return;
  renderList($('#top-cpu'), data.cpu);
  renderList($('#top-ram'), data.ram);
});
api.onFocus(renderFocus);
api.onClips((clips) => {
  if (tile === 'clip') renderClips(clips);
});
api.onGames((games) => {
  if (tile === 'library') renderGames(games);
});
api.onExpanded(setExpanded);

api.ready();
