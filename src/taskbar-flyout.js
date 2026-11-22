// The hover list for an app with several windows: one row per window, like the
// thumbnails the Windows taskbar stacks above a grouped button. The card is the
// same liquid glass as the bar: the library refracts the strip of desktop the
// main process sampled behind it.

import { LiquidGlass } from './vendor/liquidglass.js';
import { keyOutIcon } from './tray-icon.js';

const root = document.querySelector('#fxRoot');
const pane = document.querySelector('#fxPane');
const source = document.querySelector('#fxSource');
const list = document.querySelector('#fxList');
const api = window.taskbarAPI;

// Tooltip-sized glass: a shallower bevel than the bar, and a shade darker so the
// window titles stay readable over whatever is behind.
const CONFIG = {
  cornerRadius: 12,
  zRadius: 18,
  refraction: 1.15,
  chromAberration: 0.12,
  edgeHighlight: 0.14,
  specular: 0.3,
  fresnel: 1,
  distortion: 0.012,
  blurAmount: 0.34,
  tintStrength: 0.32,
  saturation: 0.16,
  brightness: -0.08,
  shadowOpacity: 0,
  shadowSpread: 0,
  shadowOffsetY: 0,
};

let rows = [];
let instance = null;
let starting = false;
let style = 'glass';
// 'windows' is an app's window list; 'tray' is Notch's own notification panel,
// which lists every icon the shell holds instead.
let kind = 'windows';
// The readings the quick panel is drawn from: volume, backlight and the radio.
let quick = null;

const trayIconCache = new Map();

// A tray icon is lifted off a screenshot of Windows' own bar, so it comes with
// that bar's background; it is dropped here the way the bar drops it.
function useTrayIcon(img, src) {
  if (trayIconCache.has(src)) {
    img.src = trayIconCache.get(src);
    return;
  }
  img.src = src;
  keyOutIcon(src)
    .then((clean) => {
      if (!clean) return;
      trayIconCache.set(src, clean);
      img.src = clean;
    })
    .catch(() => {
      /* keep the raw crop */
    });
}

function initials(text) {
  return String(text || '?')
    .replace(/\.exe$/i, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .slice(0, 2)
    .toUpperCase();
}

// A labelled row of the quick panel: a title on the left, whatever reads its
// value on the right, and one control under them.
function quickBlock(title, readout, control, wide) {
  const box = document.createElement('div');
  box.className = 'qs-block';
  const head = document.createElement('div');
  head.className = 'qs-head';
  const name = document.createElement('span');
  name.className = 'qs-name';
  name.textContent = title;
  head.appendChild(name);
  for (const node of [readout, control]) if (node) head.appendChild(node);
  box.appendChild(head);
  if (wide) box.appendChild(wide);
  return box;
}

function quickReadout(text) {
  const span = document.createElement('span');
  span.className = 'qs-value';
  span.textContent = text;
  return span;
}

function quickButton(text, onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'qs-btn';
  button.textContent = text;
  button.addEventListener('click', onClick);
  return button;
}

// A slider that follows the thumb at once and writes to the helper at most every
// 60 ms: a drag is a stream of values and the endpoint only needs the last one.
function quickSlider(what, value, onMove) {
  const input = document.createElement('input');
  input.type = 'range';
  input.min = '0';
  input.max = '100';
  input.step = '1';
  input.className = 'qs-slider';
  input.value = String(Math.max(0, Math.min(100, Number(value) || 0)));
  input.setAttribute('aria-label', what === 'volume' ? 'Volume' : 'Brightness');
  let timer = 0;
  input.addEventListener('input', () => {
    const next = Number(input.value);
    onMove(next);
    if (timer) return;
    timer = setTimeout(() => {
      timer = 0;
      if (api) api.setQuick({ what, value: Number(input.value) });
    }, 60);
  });
  return input;
}

function renderQuick() {
  list.replaceChildren();
  const data = quick || {};
  if (data.volume !== null && data.volume !== undefined) {
    const readout = quickReadout(data.mute ? 'Muted' : `${data.volume}%`);
    const mute = quickButton(data.mute ? 'Unmute' : 'Mute', () => {
      if (!api) return;
      api.mute();
      const nowMuted = mute.textContent === 'Mute';
      mute.textContent = nowMuted ? 'Unmute' : 'Mute';
      readout.textContent = nowMuted ? 'Muted' : `${data.volume}%`;
    });
    const slider = quickSlider('volume', data.volume, (next) => {
      readout.textContent = `${next}%`;
      if (mute.textContent === 'Unmute') mute.textContent = 'Mute';
    });
    list.appendChild(quickBlock('Volume', readout, mute, slider));
  }
  if (data.brightness !== null && data.brightness !== undefined) {
    const readout = quickReadout(`${data.brightness}%`);
    const slider = quickSlider('brightness', data.brightness, (next) => {
      readout.textContent = `${next}%`;
    });
    list.appendChild(quickBlock('Brightness', readout, null, slider));
  }
  const state =
    data.wifi === 'on'
      ? data.ssid
        ? `Connected · ${data.ssid}`
        : 'Connected'
      : data.wifi === 'off'
        ? 'Off'
        : 'No Wi-Fi adapter';
  const settings = quickButton('Network settings', () => {
    if (api) api.openQuick('wifi');
  });
  settings.classList.add('qs-wide');
  list.appendChild(quickBlock('Wi-Fi', quickReadout(state), null, settings));
}

function render() {
  list.replaceChildren();
  if (kind === 'quick') {
    renderQuick();
    return;
  }
  if (!rows.length) {
    const empty = document.createElement('div');
    empty.className = 'fx-empty';
    empty.textContent = kind === 'tray' ? 'Nothing in the tray' : 'No windows';
    list.appendChild(empty);
    return;
  }
  for (const row of rows) {
    const tray = kind === 'tray';
    const text = String(row.title || row.name || (tray ? 'System tray' : 'Window'));
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'fx-row';
    button.title = text;
    if (row.icon) {
      const img = document.createElement('img');
      img.alt = '';
      img.decoding = 'async';
      if (tray) useTrayIcon(img, row.icon);
      else img.src = row.icon;
      button.appendChild(img);
    } else {
      const label = document.createElement('span');
      label.className = 'fx-letters';
      label.textContent = initials(text);
      button.appendChild(label);
    }
    const title = document.createElement('span');
    title.className = 'fx-title';
    title.textContent = text;
    button.appendChild(title);
    if (tray) {
      // An icon Windows keeps in its overflow area is still listed, and says so:
      // there is no picture of it to show, and the shell sometimes refuses a
      // press on one that is not on screen.
      if (row.hidden) {
        const badge = document.createElement('span');
        badge.className = 'fx-badge';
        badge.textContent = 'hidden';
        button.appendChild(badge);
      }
      button.addEventListener('click', () => {
        if (api) api.trayPick(row.i, { name: row.name });
      });
    } else {
      button.addEventListener('click', () => {
        if (api) api.pick(row.hwnd);
      });
    }
    list.appendChild(button);
  }
}

async function start() {
  if (instance || starting) return;
  if (style !== 'glass') return;
  if (!source.getAttribute('src')) return;
  starting = true;
  try {
    await source.decode().catch(() => {});
    pane.dataset.config = JSON.stringify(CONFIG);
    instance = await LiquidGlass.init({ root, glassElements: [pane], defaults: CONFIG });
    root.classList.add('gl');
    instance.markChanged(source);
  } catch (error) {
    console.warn('Window list glass unavailable', error);
  } finally {
    starting = false;
  }
}

// The lens paints an empty scene white, so the strip is decoded off the page and
// only then swapped in: the list must never be drawn from a picture that is
// still loading.
let backdropToken = 0;

async function backdrop(data) {
  if (!data || !data.url) return;
  const token = ++backdropToken;
  const next = new Image();
  next.src = data.url;
  try {
    await next.decode();
  } catch {
    return;
  }
  if (token !== backdropToken) return;
  source.src = data.url;
  source.style.width = data.width ? `${data.width}px` : '100%';
  source.style.height = data.height ? `${data.height}px` : '100%';
  if (instance) instance.markChanged(source);
  else start();
}

// If a frame is ever drawn before the strip lands, draw it again once it is in.
source.addEventListener('load', () => {
  if (instance) instance.markChanged(source);
});

if (api) {
  api.onRows((data) => {
    rows = data && Array.isArray(data.rows) ? data.rows : [];
    if (data && data.kind) {
      kind = data.kind;
      root.dataset.kind = kind;
    }
    if (data && data.quick) quick = data.quick;
    if (data && data.style) {
      style = data.style;
      root.dataset.style = style;
    }
    render();
  });
  if (api.onFlyoutBackdrop) api.onFlyoutBackdrop(backdrop);
  api.flyoutReady();
}
