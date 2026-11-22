// The taskbar is the notch's glass laid along the bottom edge: apps in the
// middle, the notification tray, battery and clock on the right. Apps come in
// already grouped one-per-app; a group with several windows opens the hover
// list in its own small window above the bar.

import { LiquidGlass } from './vendor/liquidglass.js';

const root = document.querySelector('#tbRoot');
const bar = document.querySelector('#tbBar');
const row = document.querySelector('#tbRow');
const source = document.querySelector('#tbSource');
const leftPad = document.querySelector('#tbLeft');
const appsEl = document.querySelector('#tbApps');
const rightEl = document.querySelector('#tbRight');
const trayEl = document.querySelector('#tbTray');
const timeEl = document.querySelector('#tbTime');
const dateEl = document.querySelector('#tbDate');
const batteryEl = document.querySelector('#tbBattery');
const api = window.taskbarAPI;

// Islands are two windows: one draws the apps, one draws the tray, battery and
// clock. Attached is a single window carrying both zones.
const zone = (() => {
  const value = new URLSearchParams(location.search).get('zone');
  return value === 'apps' || value === 'tray' ? value : 'both';
})();
root.dataset.zone = zone;

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

// The bevel has to stay well short of half the island's height: at 48px a 16px
// z-radius leaves the top and bottom rims almost touching and the island reads
// as a bright bubble instead of a slab of glass.
// Blurred harder than the panel: the islands float over whatever the desktop
// shows there, often a window full of text, and glass is meant to soften that
// rather than mirror it.
const ISLAND = {
  ...BASE,
  cornerRadius: 12,
  zRadius: 10,
  refraction: 1.35,
  edgeHighlight: 0.22,
  specular: 0.5,
  fresnel: 1.02,
  tintStrength: 0.3,
  blurAmount: 0.52,
};

function configFor(shape) {
  return shape === 'islands' ? ISLAND : BASE;
}

let instance = null;
let paneTimer = null;
let pulseFrames = 0;
let apps = [];
let tray = [];
let battery = null;
let mode = { style: 'glass', shape: 'attached' };
let display = null;
let built = '';
let hoverTimer = null;
// Which backdrop is allowed to reach the shader, and which request owns it. The
// lens paints an empty scene white, so the picture is decoded off the page and
// only then swapped in: a strip that is still loading must never be what a
// frame is drawn from.
let backdropToken = 0;

// Live, not captured once: the bar slides with auto-hide, and its backdrop is
// placed against wherever the window is at that moment.
function placeSource() {
  if (!display) {
    source.style.width = '100%';
    source.style.height = '100%';
    source.style.transform = 'none';
    return;
  }
  const left = display.x - (window.screenX || 0);
  const top = display.y - (window.screenY || 0);
  source.style.width = `${display.width}px`;
  source.style.height = `${display.height}px`;
  source.style.transform = `translate3d(${left}px, ${top}px, 0)`;
}

// A strip that never arrived, or that GDI handed back with no pixels in it, is
// no use to the shader: the scene stays empty and the bar turns flat white.
function stripUsable(image) {
  if (!image || !image.naturalWidth || !image.naturalHeight) return false;
  const probe = document.createElement('canvas');
  probe.width = 8;
  probe.height = 2;
  const ctx = probe.getContext('2d', { willReadFrequently: true });
  if (!ctx) return true;
  try {
    ctx.drawImage(image, 0, 0, probe.width, probe.height);
    const { data } = ctx.getImageData(0, 0, probe.width, probe.height);
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] > 0) return true;
    }
  } catch {
    /* no readable pixels: treat it as a failed grab */
  }
  return false;
}

// Take a strip of the desktop from main and hand it to the lens once it is
// ready. A picture that loses the race to a newer one, or that decoded to
// nothing, leaves the strip already there in place.
async function setBackdrop(data) {
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
  if (!stripUsable(next)) return;
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

function initials(text) {
  return String(text || '?')
    .replace(/\.exe$/i, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .slice(0, 2)
    .toUpperCase();
}

function iconOrLetters(node, item) {
  if (item.icon) {
    const img = document.createElement('img');
    img.className = 'tb-icon';
    img.src = item.icon;
    img.alt = '';
    img.decoding = 'async';
    node.appendChild(img);
    return;
  }
  const label = document.createElement('span');
  label.className = 'tb-initials';
  label.textContent = initials(item.name || item.title);
  node.appendChild(label);
}

// ------------------------------------------------------------------- pins
// A pin is made and broken where Windows makes it, on a right-click. The pins
// are held in the order the bar draws them, so dragging one drops it into that
// array and the bar keeps the new order from then on.

const drag = { id: '', mark: null };

function pinnedOrder() {
  return apps.filter((app) => app.pin).map((app) => app.pin.id);
}

function clearDropMarks() {
  if (!drag.mark) return;
  drag.mark.classList.remove('tb-drop-before', 'tb-drop-after');
  drag.mark = null;
}

// Move one pin in front of another; an empty place means the end of the row.
// A pin dropped on itself stays where it is.
function movePin(id, before) {
  if (!id || id === before) return;
  const order = pinnedOrder();
  const from = order.indexOf(id);
  if (from < 0) return;
  order.splice(from, 1);
  const at = before ? order.indexOf(before) : -1;
  if (at < 0) order.push(id);
  else order.splice(at, 0, id);
  if (api) api.reorder({ order });
}

function wirePinControls(button, app) {
  button.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    if (api) api.context(app.key);
  });
  // A pin dropped on a running app's button goes to the end of the row: open
  // apps always follow the pins, so there is nowhere else for it to land.
  if (!app.pin) {
    button.addEventListener('dragover', (event) => {
      if (!drag.id) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
      clearDropMarks();
    });
    button.addEventListener('drop', (event) => {
      if (!drag.id) return;
      event.preventDefault();
      const id = drag.id;
      drag.id = '';
      clearDropMarks();
      movePin(id, '');
    });
    return;
  }
  // Only a pin can be dragged: an open app sits where its group put it until it
  // is pinned, and moving it would move nothing that outlives the window.
  button.draggable = true;
  button.addEventListener('dragstart', (event) => {
    drag.id = app.pin.id;
    button.classList.add('tb-dragging');
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', app.key);
    }
  });
  button.addEventListener('dragend', () => {
    drag.id = '';
    button.classList.remove('tb-dragging');
    clearDropMarks();
  });
  button.addEventListener('dragover', (event) => {
    if (!drag.id || drag.id === app.pin.id) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    // The half of the button the pointer is over decides which side of it the
    // pin lands on, as it does on Windows.
    const box = button.getBoundingClientRect();
    const after = event.clientX > box.left + box.width / 2;
    if (drag.mark !== button) {
      clearDropMarks();
      drag.mark = button;
    }
    button.classList.toggle('tb-drop-before', !after);
    button.classList.toggle('tb-drop-after', after);
  });
  button.addEventListener('drop', (event) => {
    if (!drag.id) return;
    event.preventDefault();
    const id = drag.id;
    const after = button.classList.contains('tb-drop-after');
    drag.id = '';
    clearDropMarks();
    const order = pinnedOrder();
    const at = order.indexOf(app.pin.id);
    movePin(id, after ? order[at + 1] || '' : app.pin.id);
  });
}

// Dropping past the last button, anywhere on the row (the empty end of the apps
// island or the tray side), puts the pin at the end of the row.
row.addEventListener('dragover', (event) => {
  if (!drag.id) return;
  event.preventDefault();
});
row.addEventListener('drop', (event) => {
  if (!drag.id) return;
  event.preventDefault();
  const id = drag.id;
  drag.id = '';
  clearDropMarks();
  movePin(id, '');
});

// The Start button is the launcher's list of everything installed, and it sits
// where Windows keeps its Start: immediately left of the pins.
function startButton() {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'tb-item tb-start';
  button.title = 'All apps';
  button.setAttribute('aria-label', 'All apps');
  button.innerHTML =
    '<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="3.2" y="3.2" width="5.9" height="5.9" rx="1.5"/><rect x="10.9" y="3.2" width="5.9" height="5.9" rx="1.5"/><rect x="3.2" y="10.9" width="5.9" height="5.9" rx="1.5"/><rect x="10.9" y="10.9" width="5.9" height="5.9" rx="1.5"/></svg>';
  button.addEventListener('click', () => {
    if (api) api.start();
  });
  return button;
}

function buildApps() {
  appsEl.replaceChildren();
  appsEl.appendChild(startButton());
  if (apps.length) {
    const separator = document.createElement('span');
    separator.className = 'tb-sep';
    separator.setAttribute('aria-hidden', 'true');
    appsEl.appendChild(separator);
  }
  // Windows numbers the taskbar 1..0 for Win+<key>; show the same numbers.
  let slot = 0;
  for (const app of apps) {
    slot += 1;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'tb-item';
    button.dataset.key = app.key;
    const open = app.windows.length > 0;
    button.classList.toggle('tb-pin', !open);
    button.classList.toggle('tb-running', open);
    button.classList.toggle('tb-multi', app.windows.length > 1);
    button.title = open ? `${app.name} — ${app.windows.length} window${app.windows.length > 1 ? 's' : ''}` : app.name;
    button.setAttribute('aria-label', app.name || 'App');
    iconOrLetters(button, app);
    wirePinControls(button, app);
    button.addEventListener('click', () => {
      if (api) api.group(app.key);
    });
    // Middle click closes, as it does on the taskbar this replaces.
    button.addEventListener('auxclick', (event) => {
      if (!api || event.button !== 1 || !open) return;
      event.preventDefault();
      api.close(app.key);
    });
    button.addEventListener('mouseenter', () => {
      if (!api || app.windows.length < 2) return;
      clearTimeout(hoverTimer);
      hoverTimer = setTimeout(() => {
        const box = button.getBoundingClientRect();
        api.hoverGroup({ key: app.key, left: box.left + box.width / 2 });
      }, 130);
    });
    button.addEventListener('mouseleave', () => {
      clearTimeout(hoverTimer);
      if (api) api.hoverEnd();
    });
    appsEl.appendChild(button);
  }
}

// Tray icons are pixels lifted off the notification area, so the taskbar they
// sit on comes with them. Drop that background: sample the corners, then make
// anything close to it transparent.
async function keyOutIcon(src) {
  const image = new Image();
  image.src = src;
  await image.decode();
  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = image.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return src;
  ctx.drawImage(image, 0, 0);
  const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const pixels = frame.data;
  const corners = [
    0,
    (canvas.width - 1) * 4,
    (canvas.height - 1) * canvas.width * 4,
    ((canvas.height - 1) * canvas.width + canvas.width - 1) * 4,
  ];
  let r = 0;
  let g = 0;
  let b = 0;
  for (const index of corners) {
    r += pixels[index];
    g += pixels[index + 1];
    b += pixels[index + 2];
  }
  r /= corners.length;
  g /= corners.length;
  b /= corners.length;
  for (let i = 0; i < pixels.length; i += 4) {
    const distance =
      Math.abs(pixels[i] - r) + Math.abs(pixels[i + 1] - g) + Math.abs(pixels[i + 2] - b);
    if (distance < 40) pixels[i + 3] = 0;
    else if (distance < 96) pixels[i + 3] = Math.round((pixels[i + 3] * (distance - 40)) / 56);
  }
  ctx.putImageData(frame, 0, 0);
  return canvas.toDataURL('image/png');
}

const trayIconCache = new Map();

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

// With no notification-area helper there are no icons to lift off the Windows
// tray, so the three things a tray is reached for stand in and open their own
// Windows pages.
const FALLBACK_TRAY = [
  {
    kind: 'network',
    name: 'Network',
    svg: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M2.6 7.2a10.6 10.6 0 0 1 14.8 0M5.4 10a6.6 6.6 0 0 1 9.2 0M8.2 12.8a2.9 2.9 0 0 1 3.6 0" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><circle cx="10" cy="15.4" r="1.15" fill="currentColor"/></svg>',
  },
  {
    kind: 'sound',
    name: 'Sound',
    svg: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3.6 8h2.6L9.8 5v10L6.2 12H3.6z" fill="currentColor"/><path d="M12.4 7.6a3.4 3.4 0 0 1 0 4.8M14.5 5.5a6.3 6.3 0 0 1 0 9" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
  },
  {
    kind: 'settings',
    name: 'Settings',
    svg: '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="2.5" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="10" cy="10" r="6.2" fill="none" stroke="currentColor" stroke-width="1.4" stroke-dasharray="2.1 2.7"/></svg>',
  },
];

// The chevron at the head of the tray is Windows' own ^: it opens the panel of
// notification icons the shell keeps hidden, so every icon is reachable even
// when the bar has no room for it.
function overflowButton() {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'tb-tray-item tb-tray-more';
  button.title = 'Show hidden icons';
  button.setAttribute('aria-label', 'Show hidden icons');
  button.innerHTML =
    '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5.4 12.6 10 8l4.6 4.6" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" /></svg>';
  button.addEventListener('click', () => {
    if (api) api.overflow();
  });
  return button;
}

function buildTray() {
  trayEl.replaceChildren();
  trayEl.appendChild(overflowButton());
  for (const item of tray) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'tb-tray-item';
    button.title = item.name || 'System tray';
    button.setAttribute('aria-label', item.name || 'System tray');
    if (item.icon) {
      const img = document.createElement('img');
      img.alt = '';
      img.decoding = 'async';
      useTrayIcon(img, item.icon);
      button.appendChild(img);
    } else {
      const dot = document.createElement('span');
      dot.className = 'tb-tray-dot';
      button.appendChild(dot);
    }
    button.addEventListener('click', () => {
      if (api) api.trayClick(item.i);
    });
    trayEl.appendChild(button);
  }
  if (!tray.length) {
    for (const item of FALLBACK_TRAY) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'tb-tray-item tb-tray-builtin';
      button.title = item.name;
      button.setAttribute('aria-label', item.name);
      button.innerHTML = item.svg;
      button.addEventListener('click', () => {
        if (api) api.system(item.kind);
      });
      trayEl.appendChild(button);
    }
  }
}

function paintBattery() {
  const percent = battery && Number.isFinite(battery.percent) ? Math.round(battery.percent) : null;
  if (percent === null) {
    batteryEl.hidden = true;
    return;
  }
  const pct = Math.max(0, Math.min(100, percent));
  batteryEl.hidden = false;
  batteryEl.classList.toggle('charging', !!battery.charging);
  batteryEl.title = `Battery ${pct}%${battery.charging ? ' — charging' : ''}`;
  batteryEl.innerHTML =
    `<span class="tb-batt-icon" aria-hidden="true"><i style="width:${Math.max(6, pct)}%"></i></span>` +
    `<span class="tb-batt-text">${pct}%</span>`;
  batteryEl.classList.toggle('low', pct <= 20);
}

function paintClock() {
  const now = new Date();
  timeEl.textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  dateEl.textContent = now.toLocaleDateString([], { day: '2-digit', month: '2-digit', year: 'numeric' });
}

// Apps centred on the screen, not on the bar: the left gap matches the width of
// the tray side exactly, which is what keeps them in the middle of the display.
function measure() {
  // The attached bar is the width of the display: there is nothing to fit, and
  // the apps are centred on the screen by the stylesheet.
  if (mode.shape === 'attached') return;
  if (zone !== 'both') {
    // One island alone in its window: the window is its content and the padding
    // the row and the zone add around it.
    const content = zone === 'tray' ? rightEl.offsetWidth : appsEl.offsetWidth;
    const natural = Math.ceil(content + 26);
    if (api && Math.abs(natural - window.innerWidth) > 3) api.resize({ zone, width: natural });
    return;
  }
  const side = Math.max(84, Math.round(rightEl.offsetWidth));
  document.documentElement.style.setProperty('--side-w', `${side}px`);
  const natural = Math.ceil(appsEl.offsetWidth + side * 2 + 34);
  if (api && Math.abs(natural - window.innerWidth) > 3) api.resize({ zone, width: natural });
}

// Which boxes this window actually paints. The bar runs along the bottom edge of
// the screen, exactly where Windows keeps its own taskbar, so whatever the window
// leaves empty has to let clicks fall through to it — a bar with no surface of
// its own is only its icons, and an attached bar is only its slab.
function reportHits() {
  if (!api || typeof api.hit !== 'function') return;
  const rects = [];
  const add = (el) => {
    if (!el || el.hidden || !el.offsetWidth || !el.offsetHeight) return;
    const box = el.getBoundingClientRect();
    if (box.width < 1 || box.height < 1) return;
    rects.push({ x: box.left, y: box.top, width: box.width, height: box.height });
  };
  if (mode.shape === 'islands') {
    // An island is its window: the padding around the icons is part of it.
    add(appsEl);
    add(rightEl);
  } else if (!bar.hidden) {
    add(bar);
  } else {
    // Invisible surface: only the icons and the clock take a click.
    for (const el of root.querySelectorAll('.tb-item, .tb-tray-item, .tb-tray-more, .tb-clock')) add(el);
  }
  api.hit({ rects });
}

function build() {
  const signature = JSON.stringify([
    mode,
    apps.map((app) => [app.key, app.name, app.windows.length, !!app.icon]),
    tray.map((item) => [item.i, item.name, !!item.icon]),
    battery && battery.percent,
  ]);
  if (signature === built) {
    measure();
    reportHits();
    return;
  }
  built = signature;
  root.dataset.shape = mode.shape;
  root.dataset.style = mode.style;
  bar.hidden = mode.style === 'hidden' || mode.shape !== 'attached';
  buildApps();
  buildTray();
  paintBattery();
  measure();
  placeIslandPanes();
  rebuildGlass();
  reportHits();
}

// One pane per zone (the apps island and the tray island), copied from the
// laid-out zones so the glass tracks them instead of duplicating their spacing.
// The library only accepts panes that are direct children of the root.
// Returns whether the panes had to move: the window resizes to fit its zone, so
// the glass has to be laid out again after every resize, not just after a build.
function placeIslandPanes() {
  const wanted = [];
  if (mode.shape === 'islands' && mode.style !== 'hidden') {
    const base = root.getBoundingClientRect();
    for (const zone of [appsEl, rightEl]) {
      if (!zone.offsetWidth) continue;
      const box = zone.getBoundingClientRect();
      wanted.push({
        left: `${box.left - base.left}px`,
        top: `${box.top - base.top}px`,
        width: `${box.width}px`,
        height: `${box.height}px`,
      });
    }
  }
  const current = [...root.querySelectorAll('.tb-pane')];
  const same =
    current.length === wanted.length &&
    current.every(
      (pane, index) =>
        pane.style.left === wanted[index].left &&
        pane.style.top === wanted[index].top &&
        pane.style.width === wanted[index].width &&
        pane.style.height === wanted[index].height,
    );
  if (same) return false;
  for (const pane of current) pane.remove();
  for (const box of wanted) {
    const pane = document.createElement('span');
    pane.className = 'tb-pane';
    Object.assign(pane.style, box);
    root.insertBefore(pane, bar);
  }
  return true;
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
  // Nothing to refract: the dark CSS surface is the honest thing to show, where
  // the shader over an empty scene would be one flat white bar.
  if (!stripUsable(source)) {
    root.classList.remove('gl');
    return;
  }
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
  apps = Array.isArray(data.apps) ? data.apps : [];
  tray = Array.isArray(data.tray) ? data.tray : [];
  battery = data.battery || null;
  const style = data.style === 'hidden' ? 'hidden' : data.style === 'black' ? 'black' : 'glass';
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
  measure();
  reportHits();
  placeSource();
  // The window just grew or shrank to its zone, so the island's glass moved with
  // it. Rebuilding costs a frame or two, hence the short wait for it to settle.
  if (placeIslandPanes()) {
    clearTimeout(paneTimer);
    paneTimer = setTimeout(rebuildGlass, 60);
  } else if (instance) {
    instance.markChanged(source);
  }
});

paintClock();
setInterval(paintClock, 1000);

// A frame can still be drawn a tick before its picture is ready, when a resize
// or a rebuild lands mid-decode. Draw again the moment it lands, rather than
// leaving that one white frame up until the next thing changes.
source.addEventListener('load', () => {
  placeSource();
  if (!instance) return;
  instance.markChanged(source);
  pulse();
});

if (api) {
  api.onUpdate(apply);
  api.onBackdrop(setBackdrop);
  api.ready();
}
