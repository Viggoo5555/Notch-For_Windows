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
  rows: [],
  active: -1,
  icons: {},
  display: null,
  glass: null,
};

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

function renderRows(entries) {
  els.results.replaceChildren();
  state.rows = entries;
  state.active = entries.length ? 0 : -1;
  entries.forEach((entry, index) => {
    const row = document.createElement('div');
    row.className = `row${index === state.active ? ' active' : ''}`;
    row.dataset.index = String(index);
    row.appendChild(iconNode(entry.target, entry.name, 22));

    const meta = document.createElement('div');
    meta.className = 'meta';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = entry.name;
    const sub = document.createElement('span');
    sub.className = 'sub';
    sub.textContent = entry.sub || (entry.target.startsWith('uwp:') ? 'Windows app' : entry.target);
    meta.append(name, sub);
    row.appendChild(meta);

    buildPinButton(row, entry);
    row.addEventListener('click', () => api.launch(entry.target));
    row.addEventListener('mousemove', () => setActive(index, false));
    els.results.appendChild(row);
  });
  els.empty.hidden = entries.length > 0;
}

function render() {
  const query = els.query.value || '';
  const results = filter(query);
  const searching = query.trim().length > 0;

  renderPinned();
  els.pinnedSection.hidden = searching || state.pinned.length === 0;
  els.appsTitle.textContent = searching ? 'Best matches' : 'All apps';
  renderRows(results);
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
    if (entry) api.launch(entry.target);
  }
});

els.shell.addEventListener('contextmenu', (event) => event.preventDefault());

async function boot() {
  const data = await api.boot();
  if (!data) return;
  state.index = Array.isArray(data.index) ? data.index : [];
  state.pinned = Array.isArray(data.pinned) ? data.pinned : [];
  render();
}

api.onShow(() => {
  els.query.value = '';
  els.body.scrollTop = 0;
  render();
  els.query.focus();
  // The window can take focus a beat after the show message.
  setTimeout(() => els.query.focus(), 40);
  // Restart the drop-in from the top even when two presses arrive back to back —
  // the class has to leave and be re-applied in a frame that was laid out.
  document.body.classList.remove('in');
  void document.body.offsetWidth;
  document.body.classList.add('in');
  placeSource();
  if (state.glass) {
    state.glass.markChanged(els.source);
  } else {
    ensureGlass();
  }
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
