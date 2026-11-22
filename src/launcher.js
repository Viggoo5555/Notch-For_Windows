// The glass start sheet. The index is handed over once, so typing filters in
// the same frame — no round trip between keystroke and result.

import { LiquidGlass } from './vendor/liquidglass.js';

const api = window.launcher;
const $ = (id) => document.getElementById(id);

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
  empty: $('empty'),
  count: $('count'),
  closeBtn: $('closeBtn'),
};

const state = {
  index: [],
  pinned: [],
  recent: [],
  rows: [],
  active: -1,
  icons: {},
  display: null,
  glass: null,
};

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
  if (state.glass || !els.source.getAttribute('src')) return;
  await els.source.decode().catch(() => {});
  els.pane.dataset.config = JSON.stringify(CONFIG);
  try {
    state.glass = await LiquidGlass.init({
      root: els.shell,
      glassElements: [els.pane],
      defaults: CONFIG,
    });
    els.shell.classList.add('gl');
    state.glass.markChanged(els.source);
  } catch (error) {
    console.warn('Launcher glass unavailable', error);
  }
}

// ----------------------------------------------------------------- searching

function score(name, query) {
  const value = name.toLowerCase();
  if (value === query) return 0;
  if (value.startsWith(query)) return 1;
  if (value.split(/[\s\-_.()]+/).some((word) => word.startsWith(query))) return 2;
  const inside = value.indexOf(query);
  if (inside > 0) return 3 + Math.min(inside, 20) / 100;
  let cursor = 0;
  for (const letter of value) {
    if (letter === query[cursor]) cursor += 1;
    if (cursor === query.length) return 6;
  }
  return -1;
}

function filter(query) {
  const needle = query.trim().toLowerCase();
  if (!needle) return state.index.slice(0, 80);
  const hits = [];
  for (const entry of state.index) {
    const value = score(entry.name, needle);
    if (value >= 0) hits.push({ entry, value });
  }
  hits.sort((a, b) => a.value - b.value || a.entry.name.localeCompare(b.entry.name));
  return hits.slice(0, 40).map((hit) => hit.entry);
}

// -------------------------------------------------------------- not just apps
// A search box is the one place a user expects everything: it finds apps, but a
// sum in it should come back worked out and a web address should open. Nothing
// new to learn or to find — it all happens where typing already happens.

function calcValue(text) {
  const source = String(text || '')
    .replace(/[×✕]/g, '*')
    .replace(/[÷]/g, '/')
    .replace(/,/g, '.')
    .replace(/\s+/g, '');
  if (!source || !/[0-9]/.test(source)) return null;
  if (!/^[0-9.+\-*/()%]+$/.test(source)) return null;
  let at = 0;
  const number = () => {
    const match = /^(?:\d+(?:\.\d*)?|\.\d+)/.exec(source.slice(at));
    if (!match) throw new Error('number');
    at += match[0].length;
    return Number(match[0]);
  };
  const factor = () => {
    let sign = 1;
    while (source[at] === '-' || source[at] === '+') {
      if (source[at] === '-') sign = -sign;
      at += 1;
    }
    let value;
    if (source[at] === '(') {
      at += 1;
      value = sum();
      if (source[at] !== ')') throw new Error('bracket');
      at += 1;
    } else {
      value = number();
    }
    let percent = false;
    while (source[at] === '%') {
      at += 1;
      percent = true;
    }
    return sign * (percent ? value / 100 : value);
  };
  const product = () => {
    let value = factor();
    while (source[at] === '*' || source[at] === '/') {
      const op = source[at];
      at += 1;
      const right = factor();
      value = op === '*' ? value * right : value / right;
    }
    return value;
  };
  const sum = () => {
    let value = product();
    while (source[at] === '+' || source[at] === '-') {
      const op = source[at];
      at += 1;
      const right = product();
      value = op === '+' ? value + right : value - right;
    }
    return value;
  };
  try {
    const value = sum();
    if (at !== source.length || !Number.isFinite(value)) return null;
    // Long decimals are noise in a launcher, not information.
    return String(Math.round(value * 1e10) / 1e10);
  } catch {
    return null;
  }
}

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

function renderRows(entries) {
  els.results.replaceChildren();
  state.rows = entries;
  state.active = entries.length ? 0 : -1;
  entries.forEach((entry, index) => {
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

    if (entry.target) buildPinButton(row, entry);
    row.addEventListener('click', () => runRow(entry));
    row.addEventListener('mousemove', () => setActive(index, false));
    els.results.appendChild(row);
  });
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
  const quick = quickRows(query);
  // Only when nothing here answers it: a web search is the last resort, not a
  // banner across every search.
  const web =
    searching && searched.length >= 2 && !results.length
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
  renderRows([...quick, ...results, ...web]);
  els.count.textContent = `${results.length}${searching ? '' : ` of ${state.index.length}`} apps`;
  requestIcons();
}

function setActive(index, scroll = true) {
  if (index < 0 || index >= state.rows.length) return;
  state.active = index;
  for (const row of els.results.children) {
    row.classList.toggle('active', Number(row.dataset.index) === index);
  }
  if (scroll) {
    const node = els.results.children[index];
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

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    event.preventDefault();
    api.hide();
    return;
  }
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    const delta = event.key === 'ArrowDown' ? 1 : -1;
    const next = Math.min(state.rows.length - 1, Math.max(0, state.active + delta));
    setActive(next);
    return;
  }
  if (event.key === 'Enter') {
    event.preventDefault();
    const entry = state.rows[state.active];
    if (entry) runRow(entry);
  }
});

els.shell.addEventListener('contextmenu', (event) => event.preventDefault());

async function boot() {
  const data = await api.boot();
  if (!data) return;
  state.index = Array.isArray(data.index) ? data.index : [];
  state.pinned = Array.isArray(data.pinned) ? data.pinned : [];
  state.recent = Array.isArray(data.recent) ? data.recent : [];
  if (data.settings && data.settings.animations) {
    animations = data.settings.animations === 'always' ? 'always' : 'system';
    applyMotion();
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
