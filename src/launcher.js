// The glass start sheet. The index is handed over once, so typing filters in
// the same frame — no round trip between keystroke and result.

import { LiquidGlass } from './vendor/liquidglass.js';
import { rankEntries } from './core/rank.mjs';
import { calcValue } from './core/calc.mjs';

const bridge = window.launcher;
const $ = (id) => document.getElementById(id);
// In the app this page is loaded with a preload. The demo server has none, so a
// bridge of its own keeps the sheet drawable there; a page opened without either
// answers every call with nothing rather than painting apps that are not there.
const served = location.protocol === 'http:' || location.protocol === 'https:';
const quiet = () => Promise.resolve(null);
const SILENT = {
  boot: async () => null,
  icons: async () => ({}),
  launch: quiet,
  reveal: quiet,
  pin: quiet,
  recent: async () => [],
  copy: quiet,
  open: quiet,
  hide() {},
  ready() {},
  onShow() {},
  onDismiss() {},
  onMotion() {},
  onMaterial() {},
  onBackdrop() {},
  onPinned() {},
};
const api = bridge || (served ? createDemoBridge() : SILENT);

const els = {
  shell: $('shell'),
  source: $('source'),
  pane: $('pane'),
  query: $('query'),
  body: $('body'),
  pinnedSection: $('pinnedSection'),
  pinned: $('pinned'),
  recentSection: $('recentSection'),
  recent: $('recent'),
  appsSection: $('appsSection'),
  appsTitle: $('appsTitle'),
  results: $('results'),
  foldersSection: $('foldersSection'),
  folders: $('folders'),
  empty: $('empty'),
  count: $('count'),
  closeBtn: $('closeBtn'),
};

const state = {
  index: [],
  folders: [],
  pinned: [],
  recent: [],
  rows: [],
  active: -1,
  icons: {},
  display: null,
  glass: null,
};

// Which surface the sheet wears: the liquid lens, the frosted desktop, or the
// black sheet. The panel decides it; the sheet is never a surface of its own.
let material = 'liquid';

// ---------------------------------------------------------------- open/close
// The sheet sits painted in its dismissed state while the window is hidden. The
// window is shown first and the drop is started after that, because an animation
// that runs while the window is still unpainted is simply over when it appears —
// which reads as a flash. Closing plays the same state backwards, and the window
// is only taken down once the faded frame is on screen, so the next show starts
// from transparent instead of flashing the old picture.

const systemReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// Notch's own choice wins over Windows: 'system' follows the setting, 'always' plays
// the sheet on machines that have animations switched off for them.
let animations = 'system';

function motionOff() {
  return systemReducedMotion && animations !== 'always';
}

function applyMotion() {
  document.documentElement.classList.toggle('force-motion', animations === 'always');
}

applyMotion();

let openFrame = 0;
let openTimer = 0;
let openDone = false;
let closeTimer = 0;
let closeDone = null;
let closeOnEnd = null;

function stopClose() {
  clearTimeout(closeTimer);
  closeTimer = 0;
  closeDone = null;
  if (closeOnEnd) {
    els.shell.removeEventListener('transitionend', closeOnEnd);
    closeOnEnd = null;
  }
}

function openSheet() {
  stopClose();
  if (openFrame) cancelAnimationFrame(openFrame);
  clearTimeout(openTimer);
  openFrame = 0;
  openTimer = 0;
  openDone = false;
  const open = () => {
    if (openDone) return;
    openDone = true;
    openFrame = 0;
    clearTimeout(openTimer);
    openTimer = 0;
    document.body.classList.remove('out');
  };
  if (motionOff()) {
    open();
    return;
  }
  // One frame presents the transparent window, the next starts the drop.
  openFrame = requestAnimationFrame(() => {
    openFrame = requestAnimationFrame(open);
  });
  // A window that is not drawing yet must not swallow the sheet entirely.
  openTimer = setTimeout(open, 140);
}

function closeSheet() {
  if (document.body.classList.contains('out')) {
    if (openFrame) cancelAnimationFrame(openFrame);
    clearTimeout(openTimer);
    openFrame = 0;
    openTimer = 0;
    openDone = true;
    api.hidden();
    return;
  }
  stopClose();
  document.body.classList.add('out');
  const finish = () => {
    if (!closeDone) return;
    stopClose();
    // Two frames: the first paints the faded sheet, the second lets the window go.
    requestAnimationFrame(() => requestAnimationFrame(() => api.hidden()));
  };
  closeDone = finish;
  closeOnEnd = (event) => {
    if (event.target === els.shell && event.propertyName === 'opacity') finish();
  };
  els.shell.addEventListener('transitionend', closeOnEnd);
  closeTimer = setTimeout(finish, 320);
  if (motionOff()) finish();
}

const CONFIG = {
  cornerRadius: 26,
  zRadius: 46,
  refraction: 1.15,
  chromAberration: 0.16,
  edgeHighlight: 0.16,
  specular: 0.42,
  fresnel: 1,
  distortion: 0.014,
  blurAmount: 0.3,
  tintStrength: 0.26,
  saturation: 0.18,
  brightness: -0.1,
  shadowOpacity: 0,
  shadowSpread: 0,
  shadowOffsetY: 0,
};

function placeSource() {
  if (!state.display) {
    els.source.style.width = '100%';
    els.source.style.height = '100%';
    els.source.style.transform = 'none';
    return;
  }
  els.source.style.width = `${state.display.width}px`;
  els.source.style.height = `${state.display.height}px`;
  els.source.style.transform = `translate3d(${state.display.x - screenX}px, ${state.display.y - screenY}px, 0)`;
}

async function ensureGlass() {
  if (material !== 'liquid' || !els.source.getAttribute('src')) return;
  if (state.glass) {
    els.shell.classList.add('gl');
    state.glass.setPaused(false);
    state.glass.markChanged(els.source);
    return;
  }
  await els.source.decode().catch(() => {});
  els.pane.dataset.config = JSON.stringify(CONFIG);
  try {
    state.glass = await LiquidGlass.init({
      root: els.shell,
      glassElements: [els.pane],
      defaults: CONFIG,
    });
    // The surface can be changed while the lens is still starting.
    if (material !== 'liquid') {
      state.glass.setPaused(true);
      return;
    }
    els.shell.classList.add('gl');
    state.glass.markChanged(els.source);
  } catch (error) {
    console.warn('Launcher glass unavailable', error);
  }
}

function applyMaterial(value) {
  material = value === 'black' ? 'black' : value === 'frost' ? 'frost' : 'liquid';
  document.body.dataset.material = material;
  if (material === 'liquid') {
    ensureGlass();
    return;
  }
  // Frosted and black are painted by the stylesheet; the lens is parked so it
  // costs nothing while it is not on screen.
  if (state.glass && typeof state.glass.setPaused === 'function') state.glass.setPaused(true);
  els.shell.classList.remove('gl');
}

// ----------------------------------------------------------------- searching

// The ranking itself lives in src/core/rank.mjs, where it can be tested without
// a window; these are the two lists it is asked about.
const filter = (query) => rankEntries(state.index, query);
const filterFolders = (query) =>
  String(query || '').trim() ? rankEntries(state.folders, query, 16) : [];

// -------------------------------------------------------------- not just apps
// A search box is the one place a user expects everything: it finds apps, but a
// sum in it should come back worked out and a web address should open. Nothing
// new to learn or to find — it all happens where typing already happens.

function quickRows(query) {
  const text = query.trim();
  if (!text) return [];
  const rows = [];
  const sum = calcValue(text);
  if (sum !== null) {
    rows.push({
      kind: 'calc',
      glyph: '=',
      name: sum,
      sub: 'Enter copies it',
      action: () => {
        api.copy(sum);
        api.hide();
      },
    });
  }
  // A host name with a dot in it is a place, not an app name.
  if (
    !/\s/.test(text) &&
    /^(?:[a-z][a-z0-9-]*:\/\/)?[^\s/]+\.[a-z]{2,}(?::\d+)?(?:[/?#]\S*)?$/i.test(text)
  ) {
    const url = /^[a-z][a-z0-9-]*:\/\//i.test(text) ? text : `https://${text}`;
    rows.push({
      kind: 'url',
      glyph: '\u2197',
      name: `Open ${text.replace(/^https?:\/\//i, '')}`,
      sub: 'in your browser',
      action: () => {
        api.open(url);
        api.hide();
      },
    });
  }
  return rows;
}

// ----------------------------------------------------------------- rendering

function iconNode(target, name, size) {
  const cached = state.icons[target];
  if (cached) {
    const img = document.createElement('img');
    img.src = cached;
    img.alt = '';
    img.dataset.target = target;
    return img;
  }
  const letter = document.createElement('span');
  letter.className = 'letter';
  letter.dataset.target = target;
  letter.textContent = String(name || '?')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .slice(0, 2)
    .toUpperCase();
  letter.style.width = `${size}px`;
  letter.style.height = `${size}px`;
  return letter;
}

function isPinned(id) {
  return state.pinned.some((pin) => pin.id === id);
}

function buildPinButton(box, entry) {
  const pinned = isPinned(entry.id);
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `pin-btn${pinned ? ' on' : ''}`;
  button.title = pinned ? 'Unpin from taskbar' : 'Pin to taskbar';
  button.innerHTML = pinned
    ? '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.6 8.6l3 3 5.8-6.6"/></svg>'
    : '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3.4v9.2M3.4 8h9.2"/></svg>';
  button.addEventListener('click', async (event) => {
    event.stopPropagation();
    const pinned = await api.pin({ id: entry.id, name: entry.name, target: entry.target });
    if (Array.isArray(pinned)) state.pinned = pinned;
    render();
  });
  box.appendChild(button);
}

function renderPinned() {
  els.pinned.replaceChildren();
  const hasPins = state.pinned.length > 0;
  els.pinnedSection.hidden = !hasPins;
  if (!hasPins) return;
  for (const pin of state.pinned) {
    const tile = document.createElement('div');
    tile.className = 'pin-tile';
    tile.title = pin.name;
    tile.appendChild(iconNode(pin.target, pin.name, 26));
    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = pin.name;
    tile.appendChild(label);

    const unpin = document.createElement('button');
    unpin.type = 'button';
    unpin.className = 'unpin';
    unpin.textContent = '×';
    unpin.title = 'Unpin';
    unpin.addEventListener('click', async (event) => {
      event.stopPropagation();
      const pinned = await api.pin({ id: pin.id, name: pin.name, target: pin.target });
      if (Array.isArray(pinned)) state.pinned = pinned;
      render();
    });
    tile.appendChild(unpin);

    tile.addEventListener('click', () => api.launch(pin.target));
    els.pinned.appendChild(tile);
  }
}

function glyphNode(symbol) {
  const node = document.createElement('span');
  node.className = 'letter glyph';
  node.textContent = symbol;
  node.style.width = '22px';
  node.style.height = '22px';
  return node;
}

function runRow(entry) {
  if (typeof entry.action === 'function') entry.action();
  else api.launch(entry.target);
}

function rowNode(entry, index) {
  const row = document.createElement('div');
  row.className = `row${index === state.active ? ' active' : ''}${entry.kind ? ` row-${entry.kind}` : ''}`;
  row.dataset.index = String(index);
  // An answer row is not an app, so it carries a mark instead of an icon.
  row.appendChild(entry.glyph ? glyphNode(entry.glyph) : iconNode(entry.target, entry.name, 22));

  const meta = document.createElement('div');
  meta.className = 'meta';
  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = entry.name;
  const sub = document.createElement('span');
  sub.className = 'sub';
  sub.textContent =
    entry.sub ||
    (String(entry.target || '').startsWith('uwp:') ? 'Windows app' : entry.target || '');
  meta.append(name, sub);
  row.appendChild(meta);

  // A folder opens in Explorer and is not an app to pin to the bar.
  if (entry.target && entry.kind !== 'folder') buildPinButton(row, entry);
  row.addEventListener('click', () => runRow(entry));
  row.addEventListener('mousemove', () => setActive(index, false));
  return row;
}

// One list, two boxes: the row index is the place in `state.rows`, so ↑ ↓ runs
// through apps and folders as one, while each draws under its own heading.
function renderRows(entries) {
  els.results.replaceChildren();
  els.folders.replaceChildren();
  state.rows = entries;
  state.active = entries.length ? 0 : -1;
  entries.forEach((entry, index) => {
    const row = rowNode(entry, index);
    if (entry.kind === 'folder') els.folders.appendChild(row);
    else els.results.appendChild(row);
  });
  els.foldersSection.hidden = els.folders.children.length === 0;
  // A heading over an empty list is worse than no heading: the folders below
  // already say the search found something.
  els.appsSection.hidden = entries.length > 0 && els.results.children.length === 0;
  els.empty.hidden = entries.length > 0;
}

function renderRecent(searching) {
  els.recent.replaceChildren();
  els.recentSection.hidden = searching || state.recent.length === 0;
  if (searching) return;
  for (const entry of state.recent) {
    const tile = document.createElement('div');
    tile.className = 'pin-tile';
    tile.title = entry.name;
    tile.appendChild(iconNode(entry.target, entry.name, 26));
    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = entry.name;
    tile.appendChild(label);
    tile.addEventListener('click', () => api.launch(entry.target));
    els.recent.appendChild(tile);
  }
}

function render() {
  const query = els.query.value || '';
  const searched = query.trim();
  const searching = searched.length > 0;
  const results = filter(query);
  const folders = filterFolders(query);
  const quick = quickRows(query);
  // Only when nothing here answers it: a web search is the last resort, not a
  // banner across every search.
  const web =
    searching && searched.length >= 2 && !results.length && !folders.length
      ? [
          {
            kind: 'web',
            glyph: '\u2315',
            name: `Search the web for “${searched}”`,
            sub: 'Google',
            action: () => {
              api.open(`https://www.google.com/search?q=${encodeURIComponent(searched)}`);
              api.hide();
            },
          },
        ]
      : [];

  renderPinned();
  renderRecent(searching);
  els.pinnedSection.hidden = searching || state.pinned.length === 0;
  els.appsTitle.textContent = searching ? 'Best matches' : 'All apps';
  renderRows([...quick, ...results, ...folders, ...web]);
  const counted = [
    `${results.length}${searching ? '' : ` of ${state.index.length}`} apps`,
  ];
  if (folders.length) counted.push(`${folders.length} folder${folders.length === 1 ? '' : 's'}`);
  els.count.textContent = counted.join(' · ');
  requestIcons();
}

function setActive(index, scroll = true) {
  if (index < 0 || index >= state.rows.length) return;
  state.active = index;
  for (const row of els.body.querySelectorAll('.row')) {
    row.classList.toggle('active', Number(row.dataset.index) === index);
  }
  if (scroll) {
    const node = els.body.querySelector(`.row[data-index="${index}"]`);
    if (node) node.scrollIntoView({ block: 'nearest' });
  }
}

function requestIcons() {
  const targets = [];
  for (const pin of state.pinned.slice(0, 12)) {
    if (!state.icons[pin.target]) targets.push(pin.target);
  }
  for (const entry of state.recent.slice(0, 8)) {
    if (entry.target && !state.icons[entry.target]) targets.push(entry.target);
  }
  for (const entry of state.rows.slice(0, 24)) {
    if (!state.icons[entry.target]) targets.push(entry.target);
  }
  if (!targets.length) return;
  api.icons(targets).then((icons) => {
    let changed = false;
    for (const [target, url] of Object.entries(icons || {})) {
      if (url && !state.icons[target]) {
        state.icons[target] = url;
        changed = true;
      }
    }
    if (changed) {
      for (const img of els.shell.querySelectorAll('img[data-target]')) {
        const url = state.icons[img.dataset.target];
        if (url) img.src = url;
      }
      for (const node of els.shell.querySelectorAll('.letter[data-target]')) {
        const url = state.icons[node.dataset.target];
        if (!url) continue;
        const img = document.createElement('img');
        img.src = url;
        img.alt = '';
        img.dataset.target = node.dataset.target;
        img.style.width = node.style.width;
        img.style.height = node.style.height;
        node.replaceWith(img);
      }
    }
  });
}

// ------------------------------------------------------------------- wiring

els.query.addEventListener('input', render);
els.closeBtn.addEventListener('click', () => api.hide());

const MOVE_KEYS = new Set(['ArrowDown', 'ArrowUp', 'Home', 'End', 'PageDown', 'PageUp']);

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    event.preventDefault();
    // Escape clears the search before it closes the sheet: a query is a place to
    // come back from, and the key that typed it is the key that takes it away.
    if (els.query.value) {
      els.query.value = '';
      render();
      return;
    }
    api.hide();
    return;
  }
  if (MOVE_KEYS.has(event.key)) {
    event.preventDefault();
    const last = state.rows.length - 1;
    let next = state.active;
    if (event.key === 'ArrowDown') next += 1;
    else if (event.key === 'ArrowUp') next -= 1;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = last;
    else if (event.key === 'PageDown') next += 5;
    else next -= 5;
    setActive(Math.min(last, Math.max(0, next)));
    return;
  }
  if (event.key === 'Enter') {
    event.preventDefault();
    const entry = state.rows[state.active];
    if (!entry) return;
    // Ctrl+Enter shows the app's own folder in Explorer instead of opening it.
    if ((event.ctrlKey || event.metaKey) && entry.target && api.reveal) {
      api.reveal(entry.target);
      return;
    }
    runRow(entry);
  }
});

els.shell.addEventListener('contextmenu', (event) => event.preventDefault());

async function boot() {
  const data = await api.boot();
  if (!data) return;
  state.index = Array.isArray(data.index) ? data.index : [];
  state.folders = Array.isArray(data.folders) ? data.folders : [];
  state.pinned = Array.isArray(data.pinned) ? data.pinned : [];
  state.recent = Array.isArray(data.recent) ? data.recent : [];
  if (data.settings) {
    if (data.settings.animations) {
      animations = data.settings.animations === 'always' ? 'always' : 'system';
      applyMotion();
    }
    applyMaterial(data.settings.material);
  }
  render();
}

api.onShow(() => {
  els.query.value = '';
  els.body.scrollTop = 0;
  // What was opened last is likely what is wanted next, so it is asked again on
  // every show rather than only when the window loaded.
  if (api.recent) {
    api.recent().then((list) => {
      state.recent = Array.isArray(list) ? list : [];
      render();
    });
  }
  render();
  els.query.focus();
  // The window can take focus a beat after the show message.
  setTimeout(() => els.query.focus(), 40);
  openSheet();
  placeSource();
  if (state.glass) {
    state.glass.markChanged(els.source);
  } else {
    ensureGlass();
  }
});

api.onDismiss(closeSheet);

api.onMotion((value) => {
  animations = value === 'always' ? 'always' : 'system';
  applyMotion();
});

api.onMaterial((value) => applyMaterial(value));

api.onBackdrop((data) => {
  if (!data || !data.url) return;
  state.display =
    data.width > 0 && data.height > 0
      ? { width: data.width, height: data.height, x: data.x, y: data.y }
      : null;
  els.source.src = data.url;
  placeSource();
  if (state.glass) {
    state.glass.markChanged(els.source);
  } else {
    ensureGlass();
  }
});

api.onPinned((pinned) => {
  if (Array.isArray(pinned)) {
    state.pinned = pinned;
    render();
  }
});

window.addEventListener('resize', placeSource);
window.addEventListener('focus', () => els.query.focus());

boot();
api.ready();

// -------------------------------------------------------------- demo bridge

// What `npm run dev` shows: a sheet of real-looking apps with no preload behind
// it. The icons are the initials the sheet already draws for an app it has no
// picture of, so the demo is also the one place those can be looked at.
function createDemoBridge() {
  const app = (name, sub) => ({ id: `demo-${name}`, name, target: `demo:${name}`, sub: sub || 'App' });
  const index = [
    'Brave',
    'Blender',
    'Calculator',
    'Claude',
    'Discord',
    'File Explorer',
    'Freebuff',
    'Notepad',
    'OpenRGB',
    'Paint',
    'Settings',
    'Spotify',
    'Steam',
    'Terminal',
    'Visual Studio Code',
  ].map((name) => app(name));
  const pinned = [app('Brave'), app('Terminal'), app('File Explorer'), app('Settings')];
  const recent = [app('Steam'), app('Discord'), app('Blender'), app('OpenRGB'), app('Freebuff'), app('Claude')];
  const showHandlers = [];
  return {
    boot: async () => ({
      index,
      folders: [
        { ...app('Projects', 'Folder in Documents'), kind: 'folder' },
        { ...app('Screenshots', 'Folder in Pictures'), kind: 'folder' },
      ],
      pinned,
      recent,
      settings: { animations: 'system', material: 'liquid' },
    }),
    icons: async () => ({}),
    launch: async () => ({ ok: true }),
    reveal: async () => true,
    pin: async () => pinned,
    recent: async () => recent,
    copy: async () => true,
    open: async () => true,
    hide() {},
    ready() {},
    onShow(callback) {
      showHandlers.push(callback);
      // Nothing sends a show in a browser, so the sheet lets itself in.
      setTimeout(() => callback(), 80);
    },
    onDismiss() {},
    onMotion() {},
    onMaterial() {},
    onBackdrop() {},
    onPinned() {},
  };
}
