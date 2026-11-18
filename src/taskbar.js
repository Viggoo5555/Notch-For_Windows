// The taskbar is the notch's glass laid along the bottom edge: one bar, one
// island per app, or no surface at all. Items come from the main process.

import { LiquidGlass } from './vendor/liquidglass.js';

const root = document.querySelector('#tbRoot');
const bar = document.querySelector('#tbBar');
const row = document.querySelector('#tbRow');
const source = document.querySelector('#tbSource');
const api = window.taskbarAPI;

// Same glass as the notch panel. A 40px island has far less room for a bevel
// than a long bar, so it gets a stronger rim to stay readable.
const BASE = {
  cornerRadius: 14,
  zRadius: 26,
  refraction: 1.2,
  chromAberration: 0.16,
  edgeHighlight: 0.12,
  specular: 0.34,
  fresnel: 1,
  distortion: 0.015,
  blurAmount: 0.24,
  tintStrength: 0.24,
  saturation: 0.2,
  brightness: -0.08,
  shadowOpacity: 0,
  shadowSpread: 0,
  shadowOffsetY: 0,
};

const ISLAND = {
  ...BASE,
  cornerRadius: 12,
  zRadius: 16,
  refraction: 1.5,
  edgeHighlight: 0.3,
  specular: 0.6,
  fresnel: 1.25,
  tintStrength: 0.3,
  blurAmount: 0.3,
};

function configFor(shape) {
  return shape === 'islands' ? ISLAND : BASE;
}

let instance = null;
let pulseFrames = 0;
let items = [];
let pinned = [];
let mode = { style: 'glass', shape: 'islands' };
let display = null;
let built = '';

function placeSource() {
  if (!display) {
    source.style.width = '100%';
    source.style.height = '100%';
    source.style.transform = 'none';
    return;
  }
  source.style.width = `${display.width}px`;
  source.style.height = `${display.height}px`;
  source.style.transform = `translate3d(${display.x - screenX}px, ${display.y - screenY}px, 0)`;
}

// Render a few frames for a change, then stop: an idle taskbar costs nothing.
function pulse() {
  if (!instance) return;
  instance.setPaused(false);
  pulseFrames = 0;
  const step = () => {
    if (!instance) return;
    pulseFrames += 1;
    if (pulseFrames < 4) requestAnimationFrame(step);
    else instance.setPaused(true);
  };
  requestAnimationFrame(step);
}

function build() {
  const signature = `${mode.style}|${mode.shape}|${pinned.map((pin) => pin.id).join(',')}|${items.map((item) => item.hwnd).join(',')}`;
  if (signature === built) return;
  built = signature;
  root.dataset.shape = mode.shape;
  root.dataset.style = mode.style;

  const glass = mode.style === 'glass';
  bar.hidden = mode.style === 'hidden' || mode.shape !== 'attached';
  row.replaceChildren();
  for (const pane of root.querySelectorAll('.tb-pane')) pane.remove();

  // Windows numbers the taskbar 1..0 for Win+<key>; show the same numbers so the
  // shortcut is visible on the bar instead of having to be remembered.
  let slot = 0;
  const addKeyBadge = (button) => {
    slot += 1;
    if (slot > 10) return;
    const key = document.createElement('span');
    key.className = 'tb-key';
    key.textContent = slot === 10 ? '0' : String(slot);
    button.appendChild(key);
  };

  for (const pin of pinned) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'tb-item tb-pin';
    button.title = pin.name || 'App';
    button.setAttribute('aria-label', pin.name || 'App');
    if (pin.icon) {
      const img = document.createElement('img');
      img.className = 'tb-icon';
      img.src = pin.icon;
      img.alt = '';
      img.decoding = 'async';
      button.appendChild(img);
    } else {
      const label = document.createElement('span');
      label.className = 'tb-initials';
      label.textContent = String(pin.name || '?')
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim()
        .slice(0, 2)
        .toUpperCase();
      button.appendChild(label);
    }
    button.addEventListener('click', () => {
      if (api) api.launch(pin.target);
    });
    addKeyBadge(button);
    row.appendChild(button);
  }

  if (pinned.length && items.length) {
    const divider = document.createElement('span');
    divider.className = 'tb-divider';
    row.appendChild(divider);
  }

  for (const item of items) {
    const button = document.createElement('button');
    button.type = 'button';
    // Everything past the divider is a running window: the line under the icon
    // says so.
    button.className = 'tb-item tb-running';
    button.title = item.title || item.name || '';
    button.setAttribute('aria-label', item.title || item.name || 'App');
    if (item.icon) {
      const img = document.createElement('img');
      img.className = 'tb-icon';
      img.src = item.icon;
      img.alt = '';
      img.decoding = 'async';
      button.appendChild(img);
    } else {
      const label = document.createElement('span');
      label.className = 'tb-initials';
      label.textContent = String(item.title || '?')
        .replace(/\.exe$/i, '')
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim()
        .slice(0, 2)
        .toUpperCase();
      button.appendChild(label);
    }
    button.addEventListener('click', () => {
      if (api) api.focus(item.hwnd);
    });
    addKeyBadge(button);
    row.appendChild(button);
  }
  if (mode.style !== 'hidden' && mode.shape === 'islands') placeIslandPanes();
  rebuildGlass();
}

// One pane under each icon, copied from the laid-out buttons so the glass
// tracks the row instead of duplicating its spacing rules. The library needs
// panes to be direct children of the root, hence the insert into root.
function placeIslandPanes() {
  const base = root.getBoundingClientRect();
  for (const button of row.querySelectorAll('.tb-item')) {
    const box = button.getBoundingClientRect();
    const pane = document.createElement('span');
    pane.className = 'tb-pane';
    pane.style.left = `${box.left - base.left}px`;
    pane.style.top = `${box.top - base.top}px`;
    pane.style.width = `${box.width}px`;
    pane.style.height = `${box.height}px`;
    root.insertBefore(pane, bar);
  }
}

async function rebuildGlass() {
  if (instance) {
    instance.destroy();
    instance = null;
  }
  const panes =
    mode.style === 'glass'
      ? [...root.querySelectorAll(mode.shape === 'islands' ? '.tb-pane' : '#tbBar')].filter(
          (el) => !el.hidden,
        )
      : [];
  if (!panes.length || !source.getAttribute('src')) {
    root.classList.remove('gl');
    return;
  }
  await source.decode().catch(() => {});
  const config = configFor(mode.shape);
  for (const pane of panes) pane.dataset.config = JSON.stringify(config);
  try {
    instance = await LiquidGlass.init({ root, glassElements: panes, defaults: config });
    root.classList.add('gl');
    instance.markChanged(source);
    pulse();
  } catch (error) {
    console.warn('Taskbar glass unavailable', error);
  }
}

function apply(data) {
  if (!data) return;
  items = Array.isArray(data.items) ? data.items : [];
  pinned = Array.isArray(data.pinned) ? data.pinned : [];
  const style =
    data.style === 'hidden' ? 'hidden' : data.style === 'black' ? 'black' : 'glass';
  const shape = data.shape === 'islands' ? 'islands' : 'attached';
  if (style !== mode.style || shape !== mode.shape) built = '';
  mode = { style, shape };
  build();
  if (display) {
    placeSource();
    if (instance) {
      instance.markChanged(source);
      pulse();
    }
  }
}

window.addEventListener('resize', () => {
  placeSource();
  if (instance) instance.markChanged(source);
});

if (api) {
  api.onUpdate(apply);
  api.onBackdrop((data) => {
    if (!data || !data.url) return;
    display =
      data.width > 0 && data.height > 0
        ? { width: data.width, height: data.height, x: data.x, y: data.y }
        : null;
    source.src = data.url;
    placeSource();
    if (instance) {
      instance.markChanged(source);
      pulse();
    } else {
      rebuildGlass();
    }
  });
  api.ready();
}
