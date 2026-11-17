'use strict';

const {
  app,
  BrowserWindow,
  ipcMain,
  screen,
  clipboard,
  systemPreferences,
  shell,
  globalShortcut,
  Tray,
  Menu,
  nativeImage,
  dialog,
  powerMonitor,
  desktopCapturer,
  net,
  session,
} = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { scanGames } = require('./games');
const zlib = require('node:zlib');
const { execFile, execFileSync, spawn } = require('node:child_process');

const isWin = process.platform === 'win32';

// Trim Electron's baseline footprint: cap the V8 heap, because this window only
// ever draws a small overlay. (Electron already suppresses the spare renderer.)
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=192 --max-semi-space-size=2');
// Let Chromium drop caches while nothing is happening.
app.commandLine.appendSwitch('aggressive-cache-discard');

// The notch hangs from the top edge: the window is only as wide as the thing
// visible inside it, so it never blocks the desktop it isn't covering.
const PILL_W = 96;
const PILL_H = 26;
const PANEL_W = 672;
const PANEL_H = 440;
// Must match --notch-inset in styles.css: in island mode the visible notch
// floats this far below the top edge, so the hit rect moves with it.
const NOTCH_GAP = 8;

let win = null;
let tray = null;
let revealed = false;
let isExpanded = false;
let pointerInside = false;
let ignoringMouse = null;
let pointerTimer = null;
let lastEnterAt = 0;
let pointerNear = false;
let statsTimer = null;
let clipTimer = null;
let battery = null;
let lastClip = null;
let pinned = false;
let games = [];
const clips = [];

// ---------------------------------------------------------------- preferences

const prefsPath = () => path.join(app.getPath('userData'), 'notch.json');

const DEFAULT_SETTINGS = {
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
};

let prefs = { login: false, customGames: [], settings: { ...DEFAULT_SETTINGS } };
let saveTimer = null;

function loadPrefs() {
  try {
    prefs = { ...prefs, ...JSON.parse(fs.readFileSync(prefsPath(), 'utf8')) };
  } catch {
    /* first run */
  }
  const stored = prefs.settings || {};
  prefs.settings = { ...DEFAULT_SETTINGS, ...stored };
  prefs.settings.assistant = { ...ASSISTANT_DEFAULTS, ...(stored.assistant || {}) };
  if (!Array.isArray(prefs.pinned)) prefs.pinned = [];
  // Older builds stored a live-glass on/off switch; carry the choice over.
  if (stored.backdrop == null && stored.liveBackdrop === false) prefs.settings.backdrop = 'wallpaper';
  delete prefs.settings.liveBackdrop;
}

// 'live' samples the desktop behind the notch; 'wallpaper' pins one image and
// never shows what is actually behind the window.
function usesLiveBackdrop() {
  return prefs.settings.backdrop !== 'wallpaper';
}

function savePrefs() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(prefsPath()), { recursive: true });
      fs.writeFileSync(prefsPath(), JSON.stringify(prefs, null, 2));
    } catch {
      /* not fatal */
    }
  }, 200);
}

// ---------------------------------------------------------------------- games

function rescanGames() {
  games = scanGames(prefs.customGames || []);
  return games;
}

// ---------------------------------------------------------------------- icons

const iconCache = new Map();
let iconsResolving = false;

// The -h suffix marks the header-sized art; older square-cropped capsules in
// the cache are ignored instead of being shown in the wide slot.
function iconFile(id) {
  const safe = String(id).replace(/[^a-z0-9]+/gi, '-');
  return path.join(app.getPath('userData'), 'icons', `${safe}-h.img`);
}

function readCachedIcon(file) {
  try {
    const buf = fs.readFileSync(file);
    if (buf.length > 200) return `data:image/jpeg;base64,${buf.toString('base64')}`;
  } catch {
    /* no cache yet */
  }
  return null;
}

async function steamIcon(game) {
  const file = iconFile(game.id);
  const cached = readCachedIcon(file);
  if (cached) return cached;
  if (!game.appid) return null;
  const urls = [
    `https://cdn.cloudflare.steamstatic.com/steam/apps/${game.appid}/header.jpg`,
    `https://cdn.cloudflare.steamstatic.com/steam/apps/${game.appid}/capsule_231x87.jpg`,
  ];
  for (const url of urls) {
    let res;
    try {
      res = await net.fetch(url);
    } catch {
      continue;
    }
    if (!res.ok) continue;
    const buf = Buffer.from(await res.arrayBuffer());
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, buf);
    return `data:image/jpeg;base64,${buf.toString('base64')}`;
  }
  return null;
}

// The executable's own icon is the only reliable art for Epic and local games.
function findExe(target, name) {
  if (!target) return null;
  try {
    const stat = fs.statSync(target);
    if (stat.isFile()) return target.toLowerCase().endsWith('.exe') ? target : null;
  } catch {
    return null;
  }
  let entries = [];
  try {
    entries = fs.readdirSync(target, { withFileTypes: true });
  } catch {
    return null;
  }
  const exes = entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.exe'))
    .map((entry) => path.join(target, entry.name));
  if (!exes.length) return null;
  const norm = (value) => String(value).toLowerCase().replace(/[^a-z0-9]/g, '');
  const wanted = norm(name);
  return exes
    .map((exe) => {
      const base = norm(path.basename(exe, '.exe'));
      const score = base === wanted ? 0 : base.includes(wanted) || wanted.includes(base) ? 1 : 2;
      let size = 0;
      try {
        size = fs.statSync(exe).size;
      } catch {
        /* ignore */
      }
      return { exe, score, size };
    })
    .sort((a, b) => a.score - b.score || b.size - a.size)[0].exe;
}

async function localIcon(game) {
  const exe = findExe(game.path, game.name);
  if (!exe) return null;
  const image = await app.getFileIcon(exe, { size: 'large' });
  if (image.isEmpty()) return null;
  return image.toDataURL();
}

async function resolveIcons() {
  if (iconsResolving) return;
  iconsResolving = true;
  let changed = false;
  for (const game of games) {
    if (iconCache.has(game.id)) continue;
    try {
      const icon = game.kind === 'steam' ? await steamIcon(game) : await localIcon(game);
      if (icon) {
        iconCache.set(game.id, icon);
        changed = true;
      }
    } catch {
      /* keep the monogram */
    }
  }
  iconsResolving = false;
  if (changed && win && !win.isDestroyed()) {
    win.webContents.send('notch:icons', Object.fromEntries(iconCache));
  }
}

// ------------------------------------------------------------------ wallpaper

let wallpaperCache;
let wallpaperSourceCache;
const wallpaperFittedCache = new Map();

// The chosen image if the user picked one, else the Windows wallpaper.
function wallpaperSource() {
  if (wallpaperSourceCache !== undefined) return wallpaperSourceCache;
  wallpaperSourceCache = null;

  const candidates = [];
  if (prefs.backdropPath) candidates.push(prefs.backdropPath);
  try {
    const out = execFileSync('reg', ['query', 'HKCU\\Control Panel\\Desktop', '/v', 'WallPaper'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const match = out.match(/REG_SZ\s+(.+?)\s*$/m);
    if (match) candidates.push(match[1].trim().replace(/^"|"$/g, ''));
  } catch {
    /* no registry value */
  }
  if (process.env.APPDATA) {
    candidates.push(path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Themes', 'TranscodedWallpaper'));
  }

  for (const file of candidates) {
    try {
      if (!file || !fs.existsSync(file)) continue;
      const image = nativeImage.createFromPath(file);
      if (image.isEmpty()) continue;
      wallpaperSourceCache = image;
      break;
    } catch {
      /* try the next candidate */
    }
  }
  return wallpaperSourceCache;
}

// A small, blurred sample of the wallpaper: the fallback before the first
// desktop frame, and the widget's backdrop when there is no live sample.
function wallpaperImage() {
  if (wallpaperCache !== undefined) return wallpaperCache;
  wallpaperCache = null;
  const image = wallpaperSource();
  if (!image) return null;
  const size = image.getSize();
  const wide = Math.min(1000, size.width || 1000);
  const scaled = size.width > wide ? image.resize({ width: wide, quality: 'good' }) : image;
  wallpaperCache = `data:image/jpeg;base64,${scaled.toJPEG(74).toString('base64')}`;
  return wallpaperCache;
}

// The wallpaper laid over a whole display (cover, centred), so a crop of it
// lines up with the exact desktop region the glass would have sampled.
function wallpaperFitted(display) {
  const image = wallpaperSource();
  if (!image) return null;
  const key = `${display.bounds.width}x${display.bounds.height}`;
  const hit = wallpaperFittedCache.get(key);
  if (hit !== undefined) return hit;

  let fitted = null;
  try {
    const size = image.getSize();
    const ratio = Math.max(display.bounds.width / size.width, display.bounds.height / size.height);
    const scaled = image.resize({
      width: Math.max(1, Math.round(size.width * ratio)),
      height: Math.max(1, Math.round(size.height * ratio)),
      quality: 'good',
    });
    const wide = scaled.getSize();
    fitted = scaled.crop({
      x: Math.max(0, Math.round((wide.width - display.bounds.width) / 2)),
      y: Math.max(0, Math.round((wide.height - display.bounds.height) / 2)),
      width: display.bounds.width,
      height: display.bounds.height,
    });
  } catch {
    fitted = null;
  }
  wallpaperFittedCache.set(key, fitted);
  return fitted;
}

// Cut the panel's slice out of a display-sized image.
function cropPanelFrom(image, display) {
  const size = image.getSize();
  if (!size.width || !size.height) return null;
  const scale = size.width / display.bounds.width;
  const target = targetBounds(true);
  const x = Math.max(0, Math.round((target.x - display.bounds.x) * scale));
  const y = Math.max(0, Math.round((target.y - display.bounds.y) * scale));
  const width = Math.max(1, Math.min(size.width - x, Math.round(target.width * scale)));
  const height = Math.max(1, Math.min(size.height - y, Math.round(target.height * scale)));
  try {
    const cropped = image.crop({ x, y, width, height });
    const scaled = cropped.resize({ width: PANEL_W, height: PANEL_H, quality: 'good' });
    return `data:image/jpeg;base64,${scaled.toJPEG(76).toString('base64')}`;
  } catch {
    return null;
  }
}

function panelDisplay() {
  if (win && !win.isDestroyed()) return screen.getDisplayMatching(win.getBounds());
  return screen.getPrimaryDisplay();
}

// What the notch should refract: a pinned wallpaper, or the last live sample.
function panelBackdrop() {
  if (!usesLiveBackdrop()) {
    const fitted = wallpaperFitted(panelDisplay());
    return fitted ? cropPanelFrom(fitted, panelDisplay()) : wallpaperImage();
  }
  return backdropDataUrl() || wallpaperImage();
}

// ------------------------------------------------------------ desktop sample

// A transparent window cannot blur the desktop with CSS, so the panel samples
// the screen behind it instead. Frames are taken while the window is only a
// pill, so the open panel never appears in its own backdrop.
let desktopFrame = null;
let desktopTimer = null;
let desktopBusy = false;

function backdropDataUrl() {
  if (!desktopFrame) return null;
  return cropPanelFrom(desktopFrame.image, desktopFrame.display);
}

async function captureDesktop() {
  if (!win || win.isDestroyed() || desktopBusy || !usesLiveBackdrop()) return;
  desktopBusy = true;
  const shielded = [];
  try {
    const display = screen.getDisplayMatching(win.getBounds());
    // Hide our own surfaces from the grab. Windows honours content protection
    // as capture exclusion, so the sample is the bare desktop — the pill and
    // the panel then refract the same pixels the open panel sees, with no
    // ghost of the pill baked into the source.
    for (const surface of [win, widgetWin]) {
      if (surface && !surface.isDestroyed() && surface.isVisible()) {
        surface.setContentProtection(true);
        shielded.push(surface);
      }
    }
    if (shielded.length) await new Promise((resolve) => setTimeout(resolve, 90));
    const thumbWidth = Math.max(320, Math.round(display.size.width / 2));
    const grab = () =>
      desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: {
          width: thumbWidth,
          height: Math.max(200, Math.round((thumbWidth * display.size.height) / display.size.width)),
        },
      });
    const pick = (sources) =>
      sources.find((entry) => String(entry.display_id) === String(display.id)) || sources[0];
    // Toggling content protection re-routes the display briefly; DXGI
    // duplication can miss a frame right after it, so a failed grab retries.
    let source = pick(await grab());
    if (!source || source.thumbnail.isEmpty()) {
      await new Promise((resolve) => setTimeout(resolve, 180));
      source = pick(await grab());
    }
    if (!source || source.thumbnail.isEmpty()) return;
    desktopFrame = { image: source.thumbnail, display };
    const url = backdropDataUrl();
    if (url && win && !win.isDestroyed()) win.webContents.send('notch:backdrop', url);
  } catch {
    /* capture unavailable: the wallpaper sample stays as the fallback */
  } finally {
    for (const surface of shielded) {
      if (!surface.isDestroyed()) surface.setContentProtection(false);
    }
    desktopBusy = false;
  }
}

function startDesktopSampling() {
  if (!usesLiveBackdrop() || desktopTimer) return;
  setTimeout(() => {
    if (win && !win.isDestroyed() && win.isVisible()) captureDesktop();
  }, 200);
  desktopTimer = setInterval(() => {
    if (win && !win.isDestroyed() && win.isVisible()) captureDesktop();
  }, 3500);
}

function stopDesktopSampling() {
  clearInterval(desktopTimer);
  desktopTimer = null;
}

// ---------------------------------------------------------------- live values

let cpuSnapshot = os.cpus();

function cpuUsage() {
  const now = os.cpus();
  let idle = 0;
  let total = 0;
  for (let i = 0; i < now.length; i += 1) {
    const a = cpuSnapshot[i] || now[i];
    const b = now[i];
    idle += b.times.idle - a.times.idle;
    total +=
      b.times.user + b.times.nice + b.times.sys + b.times.idle + b.times.irq -
      (a.times.user + a.times.nice + a.times.sys + a.times.idle + a.times.irq);
  }
  cpuSnapshot = now;
  if (total <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round(100 - (idle / total) * 100)));
}

function diskInfo() {
  for (const root of ['C:\\', path.parse(process.env.SystemDrive || 'C:').root]) {
    try {
      const s = fs.statfsSync(root);
      return { total: s.blocks * s.bsize, free: s.bavail * s.bsize };
    } catch {
      /* try next */
    }
  }
  return { total: 0, free: 0 };
}

function readBattery() {
  if (!isWin) return;
  execFile(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '(Get-CimInstance -ClassName Win32_Battery | Select-Object -First 1).EstimatedChargeRemaining',
    ],
    { windowsHide: true, timeout: 8000 },
    (err, stdout) => {
      if (err) return;
      const value = Number.parseInt(String(stdout).trim(), 10);
      if (Number.isFinite(value)) battery = value;
    },
  );
}

function currentStats() {
  const total = os.totalmem();
  const free = os.freemem();
  const disk = diskInfo();
  let charging = true;
  try {
    charging = !powerMonitor.isOnBatteryPower();
  } catch {
    /* keep default */
  }
  return {
    cpu: cpuUsage(),
    ram: { used: total - free, total },
    disk,
    battery,
    charging,
    uptime: Math.round(os.uptime() * 1000),
  };
}

function pushStats() {
  if (!win || win.isDestroyed()) return;
  win.webContents.send('notch:stats', currentStats());
}

let clipBusy = false;

async function pollClipboard() {
  if (clipBusy) return;
  clipBusy = true;
  try {
    let raw;
    try {
      raw = clipboard.readText();
      // Recent Electron returns a promise here; older builds return the string.
      if (raw && typeof raw.then === 'function') raw = await raw;
    } catch {
      return;
    }
    // readText can hand back a non-string for some clipboard owners; never trust it.
    let text = '';
    if (typeof raw === 'string') text = raw;
    else if (raw != null) text = String(raw);
    text = text.trim();
    if (!text || text === lastClip) return;
    lastClip = text;
    clips.unshift({
      id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      text: text.slice(0, 400),
      at: Date.now(),
    });
    if (clips.length > 20) clips.length = 20;
    if (win && !win.isDestroyed()) win.webContents.send('notch:clips', clips.slice(0, 8));
  } finally {
    clipBusy = false;
  }
}

function startLiveData() {
  if (!statsTimer) {
    pushStats();
    statsTimer = setInterval(pushStats, 2000);
  }
  if (!clipTimer) {
    pollClipboard();
    clipTimer = setInterval(pollClipboard, 1200);
  }
}

function stopLiveData() {
  clearInterval(statsTimer);
  clearInterval(clipTimer);
  statsTimer = null;
  clipTimer = null;
}

// --------------------------------------------------------------------- window

function targetBounds() {
  const area = screen.getPrimaryDisplay().workArea;
  const width = PANEL_W + 32;
  const height = PANEL_H + 34;
  return {
    x: Math.round(area.x + (area.width - width) / 2),
    y: area.y,
    width,
    height,
  };
}

// The window is always panel-sized; only the clip changes. Clicks outside the
// visible notch are handed back to the desktop by the cursor poll below.
function notchScreenRect() {
  if (!win || win.isDestroyed()) return null;
  const bounds = win.getBounds();
  // As soon as the cursor is on the pill the panel is on its way out, so the
  // whole panel footprint becomes the hover area right away instead of waiting
  // for the renderer to confirm the expansion.
  const wide = isExpanded || pointerInside;
  const width = wide ? PANEL_W : Math.max(56, Math.min(200, prefs.settings.pillWidth || PILL_W));
  const gap = prefs.settings.notchStyle === 'island' ? NOTCH_GAP : 0;
  const height = wide ? PANEL_H - gap : PILL_H;
  return {
    x: Math.round(bounds.x + (bounds.width - width) / 2),
    y: bounds.y + gap,
    width,
    height,
  };
}

function pointInRect(point, rect) {
  return (
    point.x >= rect.x &&
    point.x <= rect.x + rect.width &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.height
  );
}

function pollPointer() {
  if (!win || win.isDestroyed() || !win.isVisible()) return;
  const rect = notchScreenRect();
  if (!rect) return;
  const point = cursorDip();
  // Exactly the visible notch, no padding: it must not open a pixel early.
  const inside = pointInRect(point, rect);
  if (inside !== pointerInside) {
    pointerInside = inside;
    win.webContents.send('notch:pointer', inside ? 'enter' : 'leave');
    if (inside) lastEnterAt = Date.now();
  } else if (inside && !isExpanded && Date.now() - lastEnterAt > 600) {
    // A synthetic mouse-leave can close the panel while the cursor never moved;
    // re-assert the hover so it cannot get stuck shut.
    lastEnterAt = Date.now();
    win.webContents.send('notch:pointer', 'enter');
  }
  const ignore = !inside;
  if (ignore !== ignoringMouse) {
    ignoringMouse = ignore;
    win.setIgnoreMouseEvents(ignore, { forward: true });
  }

  // Sample the desktop only when the pointer is close enough to matter, so an
  // untouched notch does no capture work at all and never leaves the timer on.
  const near = !isExpanded && usesLiveBackdrop() && (inside || nearRect(point, rect));
  if (near !== pointerNear) {
    pointerNear = near;
    if (near) startDesktopSampling();
    else stopDesktopSampling();
  }
}

function nearRect(point, rect) {
  const slack = 280;
  return (
    point.x >= rect.x - slack &&
    point.x <= rect.x + rect.width + slack &&
    point.y >= rect.y - slack &&
    point.y <= rect.y + rect.height + slack
  );
}

// The window is created at panel size, hidden, so the renderer can rasterise
// the whole glass stack before it is ever visible. It then shrinks to the pill.
function revealWindow() {
  if (revealed || !win || win.isDestroyed()) return;
  revealed = true;
  win.showInactive();
  win.moveTop();
  if (!pointerTimer) armPointerPoll();
}

// Idle polling is the only thing this process does while the notch is folded,
// so it runs slow when the cursor is nowhere near and speeds up the moment the
// pointer reaches the pill or a panel is open. Fast enough that the panel opens
// on the next frame the cursor touches it, and closes the moment it leaves.
function armPointerPoll() {
  clearTimeout(pointerTimer);
  const delay = isExpanded || pointerInside || pointerNear ? 16 : 40;
  pointerTimer = setTimeout(() => {
    pollPointer();
    if (win && !win.isDestroyed()) armPointerPoll();
  }, delay);
}

function createWindow() {
  win = new BrowserWindow({
    ...targetBounds(true),
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    thickFrame: false,
    roundedCorners: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    title: 'Notch',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });

  win.setMenu(null);
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setSkipTaskbar(true);
  win.setIgnoreMouseEvents(true, { forward: true });
  win.loadFile(path.join(__dirname, 'src', 'index.html'));
  win.once('ready-to-show', () => setTimeout(revealWindow, 1200));
  win.on('closed', () => {
    stopDesktopSampling();
    win = null;
    revealed = false;
  });

  screen.on('display-metrics-changed', () => {
    if (win && !win.isDestroyed()) win.setBounds(targetBounds(), false);
  });
}

// ------------------------------------------------------------------- tray icon

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    crc ^= buf[i];
    for (let k = 0; k < 8; k += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function png(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const chunk = (type, data) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, 'ascii');
    data.copy(out, 8);
    out.writeUInt32BE(
      crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])),
      8 + data.length,
    );
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function accentHex() {
  try {
    const raw = systemPreferences.getAccentColor();
    if (raw && /^[0-9a-f]{6}/i.test(raw)) return `#${raw.slice(0, 6)}`;
  } catch {
    /* fallback */
  }
  return '#7c9cff';
}

function trayImage() {
  const size = 32;
  const buf = Buffer.alloc(size * size * 4);
  const hex = accentHex().slice(1);
  const r = Number.parseInt(hex.slice(0, 2), 16);
  const g = Number.parseInt(hex.slice(2, 4), 16);
  const b = Number.parseInt(hex.slice(4, 6), 16);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const px = x + 0.5;
      const py = y + 0.5;
      const bottom = 22;
      const radius = 7;
      let inside = px >= 4 && px <= 28 && py >= 3 && py <= bottom;
      if (inside && py > bottom - radius) {
        const cx = px < 16 ? 4 + radius : 28 - radius;
        const dx = px - cx;
        const dy = py - (bottom - radius);
        inside = dx * dx + dy * dy <= radius * radius;
      }
      if (!inside) continue;
      const i = (y * size + x) * 4;
      buf[i] = r;
      buf[i + 1] = g;
      buf[i + 2] = b;
      buf[i + 3] = 255;
    }
  }
  return nativeImage.createFromBuffer(png(size, size, buf));
}

// ------------------------------------------------------------------ assistant

// Jarvis talks to a local Ollama server. Everything else (voice, history) is
// ours, so the window is self-contained and nothing leaves the machine.
const OLLAMA = 'http://127.0.0.1:11434';
const JARVIS_W = 528;
const JARVIS_H = 736;

const ASSISTANT_DEFAULTS = {
  model: '',
  voice: '',
  rate: 0,
  speak: true,
  wake: false,
};

const OLLAMA_PRESETS = [
  { name: 'qwen2.5:1.5b', label: 'Qwen 2.5 1.5B', size: '1.0 GB', note: 'Instant, tiny' },
  { name: 'qwen2.5:3b', label: 'Qwen 2.5 3B', size: '1.9 GB', note: 'Fast and light' },
  { name: 'qwen2.5:7b', label: 'Qwen 2.5 7B', size: '4.7 GB', note: 'Best fit for 8 GB VRAM', pick: true },
  { name: 'llama3.1:8b', label: 'Llama 3.1 8B', size: '4.9 GB', note: 'General chat' },
  { name: 'qwen2.5:14b', label: 'Qwen 2.5 14B', size: '9.0 GB', note: 'Smarter, some CPU offload' },
  { name: 'qwen2.5:32b', label: 'Qwen 2.5 32B', size: '20 GB', note: 'Needs the 32 GB of RAM' },
];

let jarvisWin = null;
let chatAbort = null;
let speechChild = null;
let voiceCache = null;

function assistantSettings() {
  return { ...ASSISTANT_DEFAULTS, ...(prefs.settings.assistant || {}) };
}

function setAssistantSettings(patch) {
  prefs.settings.assistant = { ...assistantSettings(), ...(patch || {}) };
  savePrefs();
  return prefs.settings.assistant;
}

function ollamaEndpoint(pathname) {
  return `${OLLAMA}${pathname}`;
}

async function ollamaJson(pathname, init = {}, timeout = 6000) {
  const response = await fetch(ollamaEndpoint(pathname), {
    ...init,
    signal: AbortSignal.timeout(timeout),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    const error = new Error(body || `HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return response;
}

async function listOllamaModels() {
  try {
    const response = await ollamaJson('/api/tags', {}, 5000);
    const payload = await response.json();
    return (payload.models || []).map((model) => ({
      name: model.name,
      size: model.size || 0,
      params: model.details?.parameter_size || '',
      family: model.details?.family || '',
      quant: model.details?.quantization_level || '',
    }));
  } catch {
    return [];
  }
}

async function assistantStatus() {
  try {
    const response = await ollamaJson('/api/version', {}, 2500);
    const version = await response.json();
    const models = await listOllamaModels();
    return { running: true, version: version.version || '', models };
  } catch {
    return { running: false, version: '', models: [] };
  }
}

function findOllamaBinary() {
  const candidates = [
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Ollama', 'ollama.exe'),
    path.join(process.env.ProgramFiles || '', 'Ollama', 'ollama.exe'),
  ];
  for (const candidate of candidates) {
    try {
      if (candidate && fs.existsSync(candidate)) return candidate;
    } catch {
      /* keep looking */
    }
  }
  try {
    const where = execFileSync('where', ['ollama'], { encoding: 'utf8', windowsHide: true });
    const first = String(where).split(/\r?\n/).map((line) => line.trim()).find(Boolean);
    if (first && fs.existsSync(first)) return first;
  } catch {
    /* not on PATH */
  }
  return '';
}

function startOllama() {
  const binary = findOllamaBinary();
  if (!binary) return { ok: false, reason: 'missing' };
  try {
    const child = spawn(binary, ['serve'], { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
    return { ok: true, path: binary };
  } catch (error) {
    return { ok: false, reason: String(error && error.message) };
  }
}

function jarvisBounds() {
  const display = screen.getPrimaryDisplay();
  const height = Math.min(JARVIS_H, display.workAreaSize.height - 24);
  const width = Math.min(JARVIS_W, display.workAreaSize.width - 24);
  return {
    x: Math.round(display.workArea.x + (display.workAreaSize.width - width) / 2),
    y: Math.round(display.workArea.y + Math.max(8, (display.workAreaSize.height - height) / 2)),
    width,
    height,
  };
}

function createJarvis() {
  if (jarvisWin) return jarvisWin;
  jarvisWin = new BrowserWindow({
    ...jarvisBounds(),
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    thickFrame: false,
    roundedCorners: false,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    title: 'Jarvis',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'assistant-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      // Hidden means hidden: pause its animations and timers when minimised.
      backgroundThrottling: true,
    },
  });
  jarvisWin.setMenu(null);
  jarvisWin.loadFile(path.join(__dirname, 'src', 'assistant.html'));
  jarvisWin.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      jarvisWin.hide();
    }
  });
  jarvisWin.on('closed', () => {
    jarvisWin = null;
  });
  return jarvisWin;
}

function showJarvis() {
  const window = createJarvis();
  if (!window) return;
  if (!window.isVisible()) window.setBounds(jarvisBounds());
  window.show();
  window.focus();
}

function toggleJarvis() {
  if (jarvisWin && jarvisWin.isVisible() && jarvisWin.isFocused()) {
    jarvisWin.hide();
  } else {
    showJarvis();
  }
}

function stopSpeaking() {
  if (!speechChild) return;
  try {
    speechChild.kill();
  } catch {
    /* already gone */
  }
  speechChild = null;
}

function speak(text) {
  const value = String(text || '').trim();
  if (!value) return { ok: false };
  stopSpeaking();
  const settings = assistantSettings();
  const rate = Math.max(-8, Math.min(8, Number(settings.rate) || 0));
  const voice = String(settings.voice || '').replace(/'/g, "''");
  const script = [
    'Add-Type -AssemblyName System.Speech',
    '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
    voice ? `$s.SelectVoice('${voice}')` : '',
    `$s.Rate = ${rate}`,
    '$s.Volume = 100',
    '$text = [Console]::In.ReadToEnd()',
    'if ($text.Trim().Length -gt 0) { $s.Speak($text) }',
  ]
    .filter(Boolean)
    .join('; ');
  try {
    const child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    child.stdin.on('error', () => {});
    child.stdin.end(value);
    child.on('exit', () => {
      if (speechChild === child) speechChild = null;
    });
    speechChild = child;
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: String(error && error.message) };
  }
}

// Asking Windows for its voices takes a second the first time, so keep it off
// the main thread's critical path and remember the answer.
function listVoices() {
  if (voiceCache) return Promise.resolve(voiceCache);
  return new Promise((resolve) => {
    const script =
      'Add-Type -AssemblyName System.Speech; ' +
      '(New-Object System.Speech.Synthesis.SpeechSynthesizer).GetInstalledVoices() | ' +
      'ForEach-Object { $_.VoiceInfo.Name + "|" + $_.VoiceInfo.Culture.Name } | ' +
      'ConvertTo-Json -Compress';
    execFile(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, timeout: 10000, encoding: 'utf8' },
      (error, stdout) => {
        if (!error) {
          try {
            const parsed = JSON.parse(String(stdout).trim() || '[]');
            const rows = Array.isArray(parsed) ? parsed : [parsed];
            voiceCache = rows
              .filter((row) => typeof row === 'string' && row.includes('|'))
              .map((row) => {
                const [name, culture] = row.split('|');
                return { name, culture };
              });
          } catch {
            voiceCache = [];
          }
        }
        if (!voiceCache) voiceCache = [];
        resolve(voiceCache);
      },
    );
  });
}

async function streamOllama(response, onLine) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) {
        let chunk = null;
        try {
          chunk = JSON.parse(line);
        } catch {
          chunk = null;
        }
        if (chunk) onLine(chunk);
      }
      newline = buffer.indexOf('\n');
    }
  }
  const tail = buffer.trim();
  if (tail) {
    try {
      onLine(JSON.parse(tail));
    } catch {
      /* partial line */
    }
  }
}

ipcMain.handle('assistant:boot', async () => {
  const status = await assistantStatus();
  // Waking the engine here keeps the first open quiet: the poll picks it up
  // without making the window wait for the server to come up.
  if (!status.running) startOllama();
  return {
    settings: assistantSettings(),
    status,
    voices: await listVoices(),
    presets: OLLAMA_PRESETS,
    hotkey: 'Ctrl+Alt+J',
    platform: process.platform,
  };
});

ipcMain.handle('assistant:status', () => assistantStatus());

function sendTo(sender, channel, payload) {
  if (!sender || sender.isDestroyed()) return;
  sender.send(channel, payload);
}

ipcMain.handle('assistant:start', async () => {
  const started = startOllama();
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const status = await assistantStatus();
    if (status.running) return { ...started, status };
  }
  return { ...started, status: await assistantStatus() };
});

ipcMain.handle('assistant:chat', async (event, payload) => {
  const model = String(payload?.model || assistantSettings().model || '').trim();
  const messages = Array.isArray(payload?.messages) ? payload.messages : [];
  if (!model) {
    sendTo(event.sender, 'assistant:error', {
      code: 'no-model',
      message: 'Pick a model first — the gear opens the model manager.',
    });
    return { ok: false };
  }
  if (chatAbort) chatAbort.abort();
  chatAbort = new AbortController();
  const signal = chatAbort.signal;
  try {
    const response = await fetch(ollamaEndpoint('/api/chat'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, messages, stream: true }),
      signal,
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      sendTo(event.sender, 'assistant:error', {
        code: response.status === 404 ? 'missing-model' : 'ollama',
        message:
          response.status === 404
            ? `The model “${model}” is not installed. Open the model manager to download it.`
            : body || `Ollama answered HTTP ${response.status}.`,
      });
      return { ok: false };
    }
    let full = '';
    await streamOllama(response, (chunk) => {
      if (chunk.error) {
        sendTo(event.sender, 'assistant:error', { code: 'ollama', message: String(chunk.error) });
        return;
      }
      const text = chunk.message?.content || '';
      if (text) {
        full += text;
        sendTo(event.sender, 'assistant:delta', text);
      }
    });
    sendTo(event.sender, 'assistant:done', { text: full, model });
    return { ok: true };
  } catch (error) {
    if (error && error.name === 'AbortError') {
      sendTo(event.sender, 'assistant:done', { text: '', aborted: true });
      return { ok: false, aborted: true };
    }
    sendTo(event.sender, 'assistant:error', {
      code: 'connection',
      message: 'Ollama is not answering on 127.0.0.1:11434. Start it in the model manager.',
    });
    return { ok: false };
  } finally {
    chatAbort = null;
  }
});

ipcMain.on('assistant:stop', () => {
  if (chatAbort) chatAbort.abort();
});

ipcMain.handle('assistant:pull', async (event, name) => {
  const model = String(name || '').trim();
  if (!model) return { ok: false };
  try {
    const response = await fetch(ollamaEndpoint('/api/pull'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, stream: true }),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      return { ok: false, message: body || `HTTP ${response.status}` };
    }
    await streamOllama(response, (chunk) => {
      sendTo(event.sender, 'assistant:pull', {
        model,
        status: chunk.status || '',
        completed: chunk.completed || 0,
        total: chunk.total || 0,
        error: chunk.error || '',
      });
    });
    sendTo(event.sender, 'assistant:pull', { model, status: 'done', completed: 1, total: 1 });
    return { ok: true, models: await listOllamaModels() };
  } catch (error) {
    return { ok: false, message: String((error && error.message) || error) };
  }
});

ipcMain.handle('assistant:remove', async (_event, name) => {
  const model = String(name || '').trim();
  if (!model) return { ok: false };
  try {
    const response = await fetch(ollamaEndpoint('/api/delete'), {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model }),
    });
    if (assistantSettings().model === model) setAssistantSettings({ model: '' });
    return { ok: response.ok, models: await listOllamaModels() };
  } catch (error) {
    return { ok: false, message: String((error && error.message) || error) };
  }
});

ipcMain.handle('assistant:voices', () => listVoices());

ipcMain.handle('assistant:speak', (_event, text) => speak(text));

ipcMain.on('assistant:hush', () => stopSpeaking());

ipcMain.handle('assistant:settings', (_event, patch) => setAssistantSettings(patch));

ipcMain.handle('assistant:open', (_event, url) => {
  const target = String(url || '');
  if (!/^https:\/\/(ollama\.com|github\.com|huggingface\.co)\//.test(target)) return { ok: false };
  shell.openExternal(target);
  return { ok: true };
});

ipcMain.on('assistant:hide', () => {
  if (jarvisWin && !jarvisWin.isDestroyed()) jarvisWin.hide();
});

ipcMain.on('assistant:quit', () => app.quit());

// ------------------------------------------------------------------- launcher

// A glass Start menu: pinned apps, every Start-menu shortcut, and instant
// search. The Windows key opens it instead of the built-in menu.
const LAUNCHER_W = 720;
const LAUNCHER_H = 564;

let launcherWin = null;
let appIndex = null;
let appIndexBuilding = null;
let hookProc = null;
let hookFailures = 0;
const appIconCache = new Map();
const iconSourceCache = new Map();

function startMenuRoots() {
  const roots = [];
  const appData = process.env.APPDATA;
  const programData = process.env.ProgramData;
  if (appData) roots.push(path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs'));
  if (programData) roots.push(path.join(programData, 'Microsoft', 'Windows', 'Start Menu', 'Programs'));
  return roots;
}

function walkShortcuts(dir, out) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkShortcuts(full, out);
      continue;
    }
    if (/\.(lnk|url)$/i.test(entry.name)) {
      out.push({ file: full, name: entry.name.replace(/\.(lnk|url)$/i, '') });
    }
  }
}

// A .lnk's own icon is often the generic page glyph; the real logo lives on the
// target executable (or in the shortcut's IconLocation). Resolve all of them in
// one pass, once.
function readShortcutInfo(files) {
  return new Promise((resolve) => {
    if (!files.length) {
      resolve(new Map());
      return;
    }
    // Hundreds of paths will not fit on a command line, so hand PowerShell a file.
    const listPath = path.join(os.tmpdir(), `notch-links-${process.pid}.json`);
    try {
      fs.writeFileSync(listPath, JSON.stringify(files));
    } catch {
      resolve(new Map());
      return;
    }
    const script = [
      `$list = Get-Content -Raw '${listPath.replace(/'/g, "''")}' | ConvertFrom-Json`,
      '$sh = New-Object -ComObject WScript.Shell',
      '$list | ForEach-Object {',
      '  try {',
      '    $s = $sh.CreateShortcut($_)',
      '    [pscustomobject]@{ Path = $_; Target = $s.TargetPath; Icon = $s.IconLocation }',
      '  } catch { }',
      '} | ConvertTo-Json -Compress',
    ].join('\n');
    execFile(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, timeout: 20000, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout) => {
        try {
          fs.unlinkSync(listPath);
        } catch {
          /* temp file */
        }
        const map = new Map();
        if (!error) {
          try {
            const parsed = JSON.parse(String(stdout).trim() || '[]');
            const rows = Array.isArray(parsed) ? parsed : [parsed];
            for (const row of rows) {
              if (!row || !row.Path) continue;
              map.set(row.Path, {
                target: String(row.Target || ''),
                icon: String(row.Icon || ''),
              });
            }
          } catch {
            /* leave the map empty */
          }
        }
        resolve(map);
      },
    );
  });
}

function iconSourceFor(file, info) {
  const candidates = [];
  if (info && info.icon) candidates.push(info.icon.replace(/,\s*-?\d+$/, '').trim());
  if (info && info.target) candidates.push(info.target);
  candidates.push(file);
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      /* keep looking */
    }
  }
  return file;
}

function readStartApps() {
  return new Promise((resolve) => {
    execFile(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', 'Get-StartApps | ConvertTo-Json -Compress'],
      { windowsHide: true, timeout: 15000, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          resolve([]);
          return;
        }
        try {
          const parsed = JSON.parse(String(stdout).trim() || '[]');
          const rows = Array.isArray(parsed) ? parsed : [parsed];
          resolve(
            rows
              .filter((row) => row && row.Name && row.AppID)
              .map((row) => ({ name: String(row.Name), appId: String(row.AppID) })),
          );
        } catch {
          resolve([]);
        }
      },
    );
  });
}

async function buildAppIndex() {
  if (appIndex) return appIndex;
  if (appIndexBuilding) return appIndexBuilding;
  const build = (async () => {
    const shortcuts = [];
    for (const root of startMenuRoots()) walkShortcuts(root, shortcuts);
    for (const shortcut of shortcuts) iconSourceCache.set(shortcut.file, shortcut.file);
    const infos = await readShortcutInfo(shortcuts.filter((s) => /\.lnk$/i.test(s.file)).map((s) => s.file));
    for (const [file, info] of infos) iconSourceCache.set(file, iconSourceFor(file, info));
    const rows = [];
    const seen = new Set();
    for (const shortcut of shortcuts) {
      const key = shortcut.name.toLowerCase().trim();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      rows.push({ id: shortcut.file, name: shortcut.name, target: shortcut.file, sub: 'App' });
    }
    for (const app of await readStartApps()) {
      const key = app.name.toLowerCase().trim();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      rows.push({ id: `uwp:${app.appId}`, name: app.name, target: `uwp:${app.appId}`, sub: 'App' });
    }
    rows.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    appIndex = rows;
    return rows;
  })();
  appIndexBuilding = build;
  build
    .catch(() => {})
    .then(() => {
      if (appIndexBuilding === build) appIndexBuilding = null;
    });
  return build;
}

async function iconForTarget(target) {
  const key = String(target || '');
  if (!key) return null;
  if (appIconCache.has(key)) return appIconCache.get(key);
  let icon = null;
  if (!key.startsWith('uwp:')) {
    const source = iconSourceCache.get(key) || key;
    try {
      const image = await app.getFileIcon(source, { size: 'large' });
      if (!image.isEmpty()) icon = image.toDataURL();
    } catch {
      icon = null;
    }
  }
  appIconCache.set(key, icon);
  return icon;
}

function launchTarget(target) {
  const value = String(target || '');
  if (!value) return { ok: false };
  try {
    if (value.startsWith('uwp:')) {
      execFile('explorer.exe', [`shell:AppsFolder\\${value.slice(4)}`], { windowsHide: true }, () => {});
      return { ok: true };
    }
    if (fs.existsSync(value)) {
      shell.openPath(value);
      return { ok: true };
    }
  } catch {
    /* fall through */
  }
  return { ok: false };
}

function pinnedEntries() {
  return (Array.isArray(prefs.pinned) ? prefs.pinned : []).map((pin) => ({
    id: pin.id,
    name: pin.name || 'App',
    target: pin.target || pin.id,
    icon: pin.icon || null,
  }));
}

function broadcastPinned() {
  if (launcherWin && !launcherWin.isDestroyed()) {
    launcherWin.webContents.send('launcher:pinned', pinnedEntries());
  }
  refreshTaskbar();
}

function launcherBounds() {
  const display = screen.getPrimaryDisplay();
  const width = Math.min(LAUNCHER_W, display.workAreaSize.width - 40);
  const height = Math.min(LAUNCHER_H, display.workAreaSize.height - 80);
  return {
    x: Math.round(display.workArea.x + (display.workAreaSize.width - width) / 2),
    y: Math.round(display.workArea.y + Math.max(24, Math.round((display.workAreaSize.height - height) * 0.22))),
    width,
    height,
  };
}

function createLauncher() {
  if (launcherWin) return launcherWin;
  launcherWin = new BrowserWindow({
    ...launcherBounds(),
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    thickFrame: false,
    roundedCorners: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    title: 'Launcher',
    webPreferences: {
      preload: path.join(__dirname, 'launcher-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      backgroundThrottling: true,
    },
  });
  launcherWin.setMenu(null);
  launcherWin.setAlwaysOnTop(true, 'screen-saver');
  launcherWin.loadFile(path.join(__dirname, 'src', 'launcher.html'));
  launcherWin.webContents.on('did-finish-load', sendLauncherState);
  launcherWin.on('blur', () => {
    if (launcherWin && launcherWin.isVisible()) launcherWin.hide();
  });
  launcherWin.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      launcherWin.hide();
    }
  });
  launcherWin.on('closed', () => {
    launcherWin = null;
  });
  return launcherWin;
}

// A show sent while the page is still parsing lands nowhere, so the renderer
// also asks for this on boot and the window re-sends it once loaded.
function sendLauncherState() {
  const window = launcherWin;
  if (!window || window.isDestroyed() || !window.isVisible()) return;
  window.webContents.send('launcher:show');
  const backdrop = taskbarBackdrop();
  if (backdrop) window.webContents.send('launcher:backdrop', backdrop);
}

// Windows will not give us the foreground just because we ask: the key that
// opened the launcher was handled by the hook process. Ask the hook to attach to
// the current foreground thread and hand it over, which does stick.
function stealLauncherFocus(window) {
  if (!window || window.isDestroyed()) return;
  if (process.platform !== 'win32') {
    window.focus();
    return;
  }
  if (hookProc && hookProc.stdin && !hookProc.stdin.destroyed) {
    try {
      const handle = window.getNativeWindowHandle();
      const hwnd = handle.length >= 8 ? handle.readBigUInt64LE(0) : BigInt(handle.readUInt32LE(0));
      hookProc.stdin.write(`focus ${hwnd}\n`);
      return;
    } catch {
      /* fall through to the app-level focus */
    }
  }
  app.focus({ steal: true });
  window.focus();
}

function showLauncher() {
  const window = createLauncher();
  if (!window) return;
  revealTaskbar();
  window.setBounds(launcherBounds());
  window.show();
  window.moveTop();
  window.webContents.focus();
  stealLauncherFocus(window);
  sendLauncherState();
}

ipcMain.on('launcher:ready', sendLauncherState);

function hideLauncher() {
  if (launcherWin && !launcherWin.isDestroyed() && launcherWin.isVisible()) launcherWin.hide();
}

function toggleLauncher() {
  if (launcherWin && !launcherWin.isDestroyed() && launcherWin.isVisible()) hideLauncher();
  else showLauncher();
}

// One tiny PowerShell host watches the Windows key: a lone tap is swallowed so
// the built-in Start never opens, chords pass through untouched.
function stopWinHook() {
  if (!hookProc) return;
  const proc = hookProc;
  hookProc = null;
  try {
    proc.kill();
  } catch {
    /* already gone */
  }
}

function startWinHook() {
  if (hookProc || !prefs.settings.windowsKey || !isWin) return;
  if (hookFailures >= 3) return;
  let proc = null;
  try {
    proc = spawn(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        path.join(__dirname, 'winhook.ps1'),
      ],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] },
    );
  } catch {
    hookFailures += 1;
    return;
  }
  hookProc = proc;
  if (proc.stdin) proc.stdin.on('error', () => {});
  let buffer = '';
  proc.stdout.on('data', (chunk) => {
    buffer += String(chunk);
    let line = buffer.indexOf('\n');
    while (line >= 0) {
      const text = buffer.slice(0, line).trim();
      buffer = buffer.slice(line + 1);
      if (windowListBuffer) {
        if (text === 'WE') {
          const rows = windowListBuffer;
          windowListBuffer = null;
          if (windowRequest) windowRequest.finish(rows);
        } else if (text === 'win') {
          toggleLauncher();
        } else if (text.startsWith('slot ')) {
          activateTaskbarSlot(Number(text.slice(5)));
        } else if (text.includes('\t')) {
          windowListBuffer.push(text);
        }
      } else if (text === 'WB') {
        windowListBuffer = [];
      } else if (text === 'win') toggleLauncher();
      else if (text.startsWith('slot ')) activateTaskbarSlot(Number(text.slice(5)));
      else if (text === 'ready') hookFailures = 0;
      else if (text.startsWith('fail')) {
        hookFailures = 3;
        stopWinHook();
      }
      line = buffer.indexOf('\n');
    }
  });
  proc.on('exit', () => {
    if (hookProc !== proc) return; // stopped on purpose
    hookProc = null;
    hookFailures += 1;
    if (prefs.settings.windowsKey && hookFailures < 3) {
      setTimeout(startWinHook, 2500);
    }
  });
}

function syncWinHook() {
  if (prefs.settings.windowsKey) startWinHook();
  else stopWinHook();
}

ipcMain.handle('launcher:boot', async () => ({
  index: await buildAppIndex(),
  pinned: pinnedEntries(),
  settings: { windowsKey: !!prefs.settings.windowsKey },
}));

ipcMain.handle('launcher:icons', async (_event, targets) => {
  const list = Array.isArray(targets) ? targets.slice(0, 24) : [];
  const out = {};
  for (const target of list) {
    out[target] = await iconForTarget(target);
  }
  return out;
});

ipcMain.handle('launcher:launch', (_event, target) => {
  const result = launchTarget(target);
  if (result.ok) hideLauncher();
  return result;
});

ipcMain.handle('launcher:pin', async (_event, entry) => {
  const id = String(entry?.id || entry?.target || '').trim();
  if (!id) return pinnedEntries();
  const pins = Array.isArray(prefs.pinned) ? prefs.pinned.slice() : [];
  const index = pins.findIndex((pin) => pin.id === id);
  if (index >= 0) pins.splice(index, 1);
  else if (pins.length < 12) {
    pins.push({
      id,
      name: String(entry?.name || 'App').slice(0, 60),
      target: String(entry?.target || id),
      icon: await iconForTarget(entry?.target || id),
    });
  }
  prefs.pinned = pins;
  savePrefs();
  broadcastPinned();
  return pinnedEntries();
});

ipcMain.on('launcher:hide', () => hideLauncher());

ipcMain.on('taskbar:launch', (_event, target) => launchTarget(target));

function buildTray() {
  tray = new Tray(trayImage());
  tray.setToolTip('Notch');
  const rebuild = () => {
    if (!tray) return;
    tray.setContextMenu(
      Menu.buildFromTemplate([
        {
          label: 'Open notch',
          click: () => {
            if (!win) return;
            win.webContents.send('notch:open');
          },
        },
        {
          label: 'Pin open',
          type: 'checkbox',
          checked: pinned,
          click: () => {
            if (win) win.webContents.send('notch:toggle-pin');
          },
        },
        {
          label: 'Search apps',
          accelerator: 'Win',
          click: () => toggleLauncher(),
        },
        {
          label: 'Ask Jarvis',
          accelerator: 'Control+Alt+J',
          click: () => showJarvis(),
        },
        { type: 'separator' },
        {
          label: 'Start with Windows',
          type: 'checkbox',
          checked: !!prefs.login,
          click: (item) => {
            prefs.login = item.checked;
            applyLogin();
            savePrefs();
          },
        },
        { type: 'separator' },
        { label: 'Quit Notch', click: () => app.quit() },
      ]),
    );
  };
  rebuild();
  tray.on('click', () => {
    if (!win) return;
    win.webContents.send('notch:toggle-pin');
  });
  tray.on('right-click', rebuild);
  globalThis.__rebuildTray = rebuild;
}

function applyLogin() {
  try {
    app.setLoginItemSettings({
      openAtLogin: !!prefs.login,
      path: process.execPath,
      args: app.isPackaged ? [] : [path.join(__dirname)],
    });
  } catch {
    /* unsupported */
  }
}

// ------------------------------------------------------------------------- ipc

ipcMain.handle('notch:bootstrap', () => {
  rescanGames();
  readBattery();
  resolveIcons();
  return {
    accent: accentHex(),
    version: app.getVersion(),
    platform: process.platform,
    demo: false,
    icons: Object.fromEntries(iconCache),
    settings: prefs.settings,
    games,
    clips: clips.slice(0, 8),
    stats: currentStats(),
    login: !!prefs.login,
    wallpaper: panelBackdrop(),
    canScan: true,
  };
});

ipcMain.on('notch:ready', () => revealWindow());

ipcMain.on('notch:expanded', (_event, expanded) => {
  isExpanded = !!expanded;
  if (!win || win.isDestroyed()) return;
  // Keep the animation clock live while the panel is out, but let Chromium
  // throttle the folded pill: it has nothing to draw between frames.
  if (typeof win.webContents.setBackgroundThrottling === 'function') {
    win.webContents.setBackgroundThrottling(!isExpanded);
  }
  if (expanded) {
    startLiveData();
    stopDesktopSampling();
  } else {
    stopLiveData();
    if (pointerNear && usesLiveBackdrop()) setTimeout(startDesktopSampling, 700);
    else stopDesktopSampling();
  }
});

ipcMain.on('notch:pinned', (_event, value) => {
  pinned = !!value;
  if (globalThis.__rebuildTray) globalThis.__rebuildTray();
});

ipcMain.on('notch:focus', () => {
  if (win && !win.isDestroyed()) win.focus();
});

ipcMain.on('notch:quit', () => app.quit());

ipcMain.handle('notch:login', (_event, value) => {
  prefs.login = !!value;
  applyLogin();
  savePrefs();
  if (globalThis.__rebuildTray) globalThis.__rebuildTray();
  return prefs.login;
});

ipcMain.handle('notch:set-settings', (_event, patch) => {
  prefs.settings = { ...DEFAULT_SETTINGS, ...prefs.settings, ...(patch || {}) };
  savePrefs();
  if (!usesLiveBackdrop()) {
    // Pinned image: stop sampling entirely (also the cheapest idle state) and
    // hand the renderer the wallpaper slice in place of the desktop.
    stopDesktopSampling();
    desktopFrame = null;
    const url = panelBackdrop();
    if (url && win && !win.isDestroyed()) win.webContents.send('notch:backdrop', url);
    sendWidgetBackdrop();
  } else if (pointerNear && !isExpanded) {
    startDesktopSampling();
  }
  refreshTaskbar();
  syncWinHook();
  return prefs.settings;
});

// Pick an image to sit behind the notch permanently. The file is copied into
// userData so moving or deleting the original does not break the backdrop.
ipcMain.handle('notch:pick-wallpaper', async () => {
  if (!win || win.isDestroyed()) return { canceled: true };
  const result = await dialog.showOpenDialog(win, {
    title: 'Choose a backdrop image',
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp'] }],
  });
  if (result.canceled || !result.filePaths.length) return { canceled: true };
  const file = result.filePaths[0];
  const image = nativeImage.createFromPath(file);
  if (image.isEmpty()) return { canceled: false, bad: true };

  let stored = file;
  try {
    const copy = path.join(app.getPath('userData'), 'backdrop-image');
    fs.copyFileSync(file, copy);
    stored = copy;
  } catch {
    /* keep the original path if the copy fails */
  }

  prefs.backdropPath = stored;
  prefs.settings = { ...prefs.settings, backdrop: 'wallpaper' };
  savePrefs();
  wallpaperSourceCache = undefined;
  wallpaperCache = undefined;
  wallpaperFittedCache.clear();

  stopDesktopSampling();
  desktopFrame = null;
  const url = panelBackdrop();
  if (url) win.webContents.send('notch:backdrop', url);
  sendWidgetBackdrop();
  sendTaskbarBackdrop();
  return { canceled: false, url, settings: prefs.settings };
});

ipcMain.handle('notch:rescan', () => {
  const list = rescanGames();
  resolveIcons();
  return list;
});

ipcMain.handle('notch:add-game', async () => {
  if (!win) return games;
  const result = await dialog.showOpenDialog(win, {
    title: 'Add a game',
    properties: ['openFile'],
    filters: [
      { name: 'Programs', extensions: ['exe', 'bat', 'cmd', 'lnk', 'url'] },
      { name: 'All files', extensions: ['*'] },
    ],
  });
  if (result.canceled || !result.filePaths.length) return games;
  const file = result.filePaths[0];
  prefs.customGames = [
    ...(prefs.customGames || []),
    { name: path.basename(file, path.extname(file)), path: file },
  ];
  savePrefs();
  const list = rescanGames();
  resolveIcons();
  return list;
});

ipcMain.handle('notch:launch', async (_event, id) => {
  const game = games.find((g) => g.id === id);
  if (!game) return { ok: false };
  try {
    if (game.kind === 'steam') {
      await shell.openExternal(`steam://rungameid/${game.appid}`);
    } else if (game.kind === 'epic') {
      await shell.openExternal(
        `com.epicgames.launcher://apps/${encodeURIComponent(game.appName)}?action=launch&silent=true`,
      );
    } else if (game.path) {
      const err = await shell.openPath(game.path);
      if (err) return { ok: false, error: err };
    }
    return { ok: true, name: game.name };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
});

ipcMain.handle('notch:copy-clip', async (_event, id) => {
  const clip = clips.find((c) => c.id === id);
  if (!clip) return false;
  await clipboard.writeText(clip.text);
  lastClip = clip.text;
  const index = clips.indexOf(clip);
  if (index > 0) {
    clips.splice(index, 1);
    clips.unshift(clip);
    if (win && !win.isDestroyed()) win.webContents.send('notch:clips', clips.slice(0, 8));
  }
  return true;
});

// ---------------------------------------------------------------- system widget

// A tile dragged out of the panel becomes its own always-on-top window: small
// meters that expand into a live "what is using it" breakdown.
const WIDGET_W = 268;
let widgetWin = null;
let widgetExpanded = false;
let widgetDragTimer = null;
let widgetDragOrigin = null;
let widgetStatsTimer = null;
let widgetProcTimer = null;
let procBusy = false;
let procPrev = new Map();
let procPrevAt = 0;

function widgetSize(expanded) {
  return { width: WIDGET_W, height: expanded ? 276 : 116 };
}

// Electron already reports the pointer in DIP; older notes here assumed physical
// and converted again, which put every reading a fifth of the way up the
// screen. Convert only when the point falls outside the DIP display, which is
// what a genuinely physical reading looks like on a scaled display.
function cursorDip() {
  const point = screen.getCursorScreenPoint();
  const bounds = screen.getPrimaryDisplay().bounds;
  const outside =
    point.x < bounds.x ||
    point.y < bounds.y ||
    point.x > bounds.x + bounds.width ||
    point.y > bounds.y + bounds.height;
  if (!outside) return point;
  try {
    const converted = screen.screenToDipPoint(point);
    if (converted && Number.isFinite(converted.x) && Number.isFinite(converted.y)) return converted;
  } catch {
    /* older Electron */
  }
  return point;
}

function clampWidget(x, y, width, height) {
  const area = screen.getDisplayNearestPoint({ x, y }).workArea;
  return {
    x: Math.round(Math.min(Math.max(x, area.x), area.x + area.width - width)),
    y: Math.round(Math.min(Math.max(y, area.y), area.y + area.height - height)),
  };
}

// The window follows the cursor while the button is down, so the widget can be
// dragged out of the panel and moved again later with the same code path.
function startWidgetDrag(grab) {
  stopWidgetDrag();
  widgetDragOrigin = grab;
  widgetDragTimer = setInterval(() => {
    if (!widgetWin || widgetWin.isDestroyed()) {
      stopWidgetDrag();
      return;
    }
    const point = cursorDip();
    // setBounds, not setPosition: on scaled Windows displays a bare
    // setPosition can make the transparent window creep wider on every call.
    const size = widgetSize(widgetExpanded);
    widgetWin.setBounds({
      x: Math.round(point.x - widgetDragOrigin.dx),
      y: Math.round(point.y - widgetDragOrigin.dy),
      width: size.width,
      height: size.height,
    });
  }, 16);
}

function stopWidgetDrag() {
  clearInterval(widgetDragTimer);
  widgetDragTimer = null;
  widgetDragOrigin = null;
}

function finishWidgetDrag() {
  if (!widgetWin || widgetWin.isDestroyed()) {
    stopWidgetDrag();
    return;
  }
  const bounds = widgetWin.getBounds();
  const pos = clampWidget(bounds.x, bounds.y, bounds.width, bounds.height);
  stopWidgetDrag();
  widgetWin.setPosition(pos.x, pos.y);
}

// The widget is glass over whatever is behind it. The last desktop sample was
// taken while only the pill was on screen, so it is clean: no panel, no widget.
function widgetBackdrop() {
  if (!usesLiveBackdrop()) {
    const display = screen.getPrimaryDisplay();
    const fitted = wallpaperFitted(display);
    if (!fitted) return null;
    return {
      url: `data:image/jpeg;base64,${fitted.toJPEG(72).toString('base64')}`,
      width: display.bounds.width,
      height: display.bounds.height,
      x: display.bounds.x,
      y: display.bounds.y,
    };
  }
  if (!desktopFrame) {
    const wallpaper = wallpaperImage();
    return wallpaper ? { url: wallpaper, width: 0, height: 0, x: 0, y: 0 } : null;
  }
  const point = cursorDip();
  const display = screen.getDisplayNearestPoint({
    x: Math.round(point.x),
    y: Math.round(point.y),
  });
  if (String(display.id) !== String(desktopFrame.display.id)) return null;
  const url = `data:image/jpeg;base64,${desktopFrame.image.toJPEG(72).toString('base64')}`;
  return {
    url,
    width: display.bounds.width,
    height: display.bounds.height,
    x: display.bounds.x,
    y: display.bounds.y,
  };
}

function sendWidgetBackdrop() {
  if (!widgetWin || widgetWin.isDestroyed()) return;
  const backdrop = widgetBackdrop();
  if (backdrop) widgetWin.webContents.send('widget:backdrop', backdrop);
}

// ------------------------------------------------------------------ taskbar

// A thin strip of the windows you have open, pinned to the bottom edge. It can
// be one glass bar, one glass island per app, or nothing but the icons.
const TASKBAR_H = 52;
const TASKBAR_LIFT = 10;
const TASKBAR_ITEM = 40;
const TASKBAR_SEP = 6;
const TASKBAR_PAD = 8;

let taskbarWin = null;
let taskbarTimer = null;
let taskbarItems = [];
let taskbarBusy = false;
let taskbarPeekTimer = null;
let taskbarRevealed = false;
let taskbarLeaveTimer = null;


function taskbarOn() {
  return !!prefs.settings.taskbar;
}

function taskbarMode() {
  return {
    style: prefs.settings.taskbarStyle === 'hidden' ? 'hidden' : 'glass',
    shape: prefs.settings.taskbarShape === 'islands' ? 'islands' : 'attached',
  };
}

function taskbarPinned() {
  const show = prefs.settings.taskbarShow || 'both';
  return show === 'open' ? [] : pinnedEntries();
}

function taskbarOpenItems() {
  const show = prefs.settings.taskbarShow || 'both';
  return show === 'pinned' ? [] : taskbarItems;
}

function taskbarAutoHide() {
  return !!prefs.settings.taskbarAutoHide;
}

function taskbarGeometry(hidden) {
  const display = screen.getPrimaryDisplay();
  const pinned = taskbarPinned().length;
  const open = taskbarOpenItems().length;
  const count = Math.max(1, pinned + open);
  const divider = pinned > 0 && open > 0 ? TASKBAR_SEP + 1 : 0;
  const width = Math.min(
    display.bounds.width - 24,
    TASKBAR_PAD * 2 + count * TASKBAR_ITEM + (count - 1) * TASKBAR_SEP + divider,
  );
  const height = TASKBAR_H + TASKBAR_LIFT;
  const bottom = display.bounds.y + display.bounds.height;
  return {
    x: Math.round(display.bounds.x + (display.bounds.width - width) / 2),
    y: hidden ? bottom : bottom - height,
    width,
    height,
    bottom,
  };
}

function taskbarBounds() {
  return taskbarGeometry(taskbarAutoHide() && !taskbarRevealed);
}

let windowListBuffer = null;
let windowRequest = null;
const exeIconCache = new Map();
// Shell surfaces that look like app windows but are not apps.
const SHELL_PROCESSES = new Set([
  'shellexperiencehost.exe',
  'startmenuexperiencehost.exe',
  'searchhost.exe',
  'searchapp.exe',
  'textinputhost.exe',
  'lockapp.exe',
  'winstore.app.exe',
]);

async function iconForExe(exe) {
  const key = String(exe || '').toLowerCase();
  if (!key) return null;
  if (exeIconCache.has(key)) return exeIconCache.get(key);
  let icon = null;
  try {
    const image = await app.getFileIcon(exe, { size: 'normal' });
    if (!image.isEmpty()) icon = image.toDataURL();
  } catch {
    icon = null;
  }
  exeIconCache.set(key, icon);
  return icon;
}

// Ask the hook helper for the real window list. Chromium's own enumeration
// leaves out whole apps (Windows Terminal, Explorer), which made the bar look
// like a short dock while windows were missing from it.
function requestWindowList(timeout = 1800) {
  const proc = hookProc;
  if (!proc || proc.killed || !proc.stdin || proc.stdin.destroyed) return Promise.resolve(null);
  if (windowRequest) return windowRequest.promise;
  const request = { promise: null, finish: null, done: false };
  request.promise = new Promise((resolve) => {
    const timer = setTimeout(() => finish(null), timeout);
    function finish(value) {
      if (request.done) return;
      request.done = true;
      clearTimeout(timer);
      if (windowRequest === request) windowRequest = null;
      resolve(value);
    }
    request.finish = finish;
    windowRequest = request;
    windowListBuffer = [];
    try {
      proc.stdin.write('windows\n');
    } catch {
      finish(null);
    }
  });
  return request.promise;
}

async function readTaskbarWindowsFromHelper() {
  const rows = await requestWindowList();
  if (!rows) return null;
  const items = [];
  for (const row of rows) {
    const [handle, pidText, title, exe] = String(row).split('\t');
    const hwnd = Number(handle);
    const pid = Number(pidText);
    if (!hwnd || pid === process.pid) continue;
    if (!title || title === 'Program Manager') continue;
    const base = String(exe || '').split(/[\\/]/).pop().toLowerCase();
    if (SHELL_PROCESSES.has(base)) continue;
    items.push({ hwnd, title, icon: await iconForExe(exe) });
  }
  return items;
}

async function readTaskbarWindows() {
  const fromHelper = await readTaskbarWindowsFromHelper();
  if (fromHelper) return fromHelper;
  return readTaskbarWindowsFromCapturer();
}

// Fallback when the Windows key helper is not running.
async function readTaskbarWindowsFromCapturer() {
  try {
    const sources = await desktopCapturer.getSources({
      types: ['window'],
      thumbnailSize: { width: 0, height: 0 },
      fetchWindowIcons: true,
    });
    const rows = [];
    for (const source of sources) {
      const title = String(source.name || '').trim();
      if (
        !title ||
        title === 'Notch' ||
        title === 'System' ||
        title === 'Taskbar' ||
        title === 'Jarvis' ||
        title === 'Launcher'
      )
        continue;
      const hwnd = Number(String(source.id).split(':')[1]);
      if (!hwnd) continue;
      const icon =
        source.appIcon && !source.appIcon.isEmpty() ? source.appIcon.toDataURL() : null;
      rows.push({ hwnd, title, icon });
    }
    return rows;
  } catch {
    return [];
  }
}

// Keep the order stable while windows come and go; new arrivals go on the end.
function mergeTaskbarItems(rows) {
  const byHandle = new Map(rows.map((row) => [row.hwnd, row]));
  const next = [];
  for (const item of taskbarItems) {
    const fresh = byHandle.get(item.hwnd);
    if (!fresh) continue;
    next.push({ ...item, title: fresh.title, icon: fresh.icon || item.icon });
    byHandle.delete(item.hwnd);
  }
  // Every remaining window gets a slot: this is a taskbar, not a short dock.
  for (const row of byHandle.values()) next.push(row);
  return next;
}

function taskbarSignature(items) {
  return items.map((item) => `${item.hwnd}:${item.title}`).join(',');
}

function taskbarBackdrop() {
  const display = screen.getPrimaryDisplay();
  const fitted = wallpaperFitted(display);
  if (usesLiveBackdrop() && desktopFrame) {
    return {
      url: `data:image/jpeg;base64,${desktopFrame.image.toJPEG(72).toString('base64')}`,
      width: display.bounds.width,
      height: display.bounds.height,
      x: display.bounds.x,
      y: display.bounds.y,
    };
  }
  if (!fitted) return null;
  return {
    url: `data:image/jpeg;base64,${fitted.toJPEG(72).toString('base64')}`,
    width: display.bounds.width,
    height: display.bounds.height,
    x: display.bounds.x,
    y: display.bounds.y,
  };
}

function sendTaskbarBackdrop() {
  if (!taskbarWin || taskbarWin.isDestroyed()) return;
  const backdrop = taskbarBackdrop();
  if (backdrop) taskbarWin.webContents.send('taskbar:backdrop', backdrop);
}

function sendTaskbarUpdate() {
  if (!taskbarWin || taskbarWin.isDestroyed()) return;
  const mode = taskbarMode();
  const items = taskbarOpenItems();
  const pinned = taskbarPinned();
  taskbarWin.webContents.send('taskbar:update', {
    items,
    pinned,
    show: prefs.settings.taskbarShow || 'both',
    ...mode,
  });
  taskbarWin.setBounds(taskbarBounds(), false);
  if (!items.length && !pinned.length) {
    if (taskbarWin.isVisible()) taskbarWin.hide();
  } else if (!taskbarWin.isVisible()) {
    taskbarWin.showInactive();
    sendTaskbarBackdrop();
  }
}

async function pollTaskbar() {
  if (!taskbarWin || taskbarWin.isDestroyed() || taskbarBusy) return;
  taskbarBusy = true;
  try {
    const rows = await readTaskbarWindows();
    const items = mergeTaskbarItems(rows);
    const changed = taskbarSignature(items) !== taskbarSignature(taskbarItems);
    taskbarItems = items;
    if (!changed) return;
    sendTaskbarUpdate();
  } finally {
    taskbarBusy = false;
  }
}

function startTaskbarPolling() {
  if (taskbarTimer) return;
  setTimeout(pollTaskbar, 400);
  taskbarTimer = setInterval(pollTaskbar, 2500);
}

function stopTaskbarPolling() {
  clearInterval(taskbarTimer);
  taskbarTimer = null;
  taskbarBusy = false;
}

function createTaskbar() {
  if (taskbarWin) return;
  const bounds = taskbarBounds();
  taskbarWin = new BrowserWindow({
    ...bounds,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    thickFrame: false,
    roundedCorners: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: false,
    show: false,
    title: 'Taskbar',
    webPreferences: {
      preload: path.join(__dirname, 'taskbar-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });
  taskbarWin.setMenu(null);
  taskbarWin.setAlwaysOnTop(true, 'screen-saver');
  taskbarWin.setSkipTaskbar(true);
  taskbarWin.setFocusable(false);
  taskbarWin.loadFile(path.join(__dirname, 'src', 'taskbar.html'));
  taskbarWin.once('ready-to-show', () => {
    if (!taskbarWin || taskbarWin.isDestroyed()) return;
    taskbarWin.setBounds(taskbarBounds(), false);
    taskbarWin.showInactive();
    sendTaskbarBackdrop();
  });
  taskbarWin.on('closed', () => {
    taskbarWin = null;
    stopTaskbarPolling();
  });
  startTaskbarPolling();
}

function destroyTaskbar() {
  stopTaskbarPolling();
  if (taskbarPeekTimer) clearInterval(taskbarPeekTimer);
  taskbarPeekTimer = null;
  if (taskbarLeaveTimer) clearTimeout(taskbarLeaveTimer);
  taskbarLeaveTimer = null;
  taskbarRevealed = false;
  taskbarItems = [];
  if (taskbarWin && !taskbarWin.isDestroyed()) taskbarWin.destroy();
  taskbarWin = null;
}

function refreshTaskbar() {
  if (!taskbarOn()) {
    destroyTaskbar();
    return;
  }
  if (!taskbarWin) createTaskbar();
  else sendTaskbarUpdate();
  syncTaskbarPeek();
}

// Auto-hide: the bar waits just past the bottom edge and comes up when the
// pointer touches that edge, or when the launcher opens. The poll only runs
// while the setting is on, and it is a single cursor read every 120 ms.
function setTaskbarRevealed(revealed) {
  if (taskbarRevealed === revealed) return;
  taskbarRevealed = revealed;
  if (!taskbarWin || taskbarWin.isDestroyed() || !taskbarOn()) return;
  taskbarWin.setBounds(taskbarBounds(), false);
}

function revealTaskbar() {
  if (!taskbarAutoHide() || !taskbarOn()) return;
  if (taskbarLeaveTimer) clearTimeout(taskbarLeaveTimer);
  taskbarLeaveTimer = null;
  setTaskbarRevealed(true);
}

function tickTaskbarPeek() {
  if (!taskbarWin || taskbarWin.isDestroyed() || !taskbarOn() || !taskbarAutoHide()) return;
  // While the Start sheet is open the bar stays out, the way Windows keeps its
  // taskbar up until Start closes again.
  if (launcherWin && !launcherWin.isDestroyed() && launcherWin.isVisible()) {
    if (taskbarLeaveTimer) clearTimeout(taskbarLeaveTimer);
    taskbarLeaveTimer = null;
    return;
  }
  const shown = taskbarGeometry(false);
  const point = cursorDip();
  const atEdge = point.y >= shown.bottom - 2;

  const over =
    point.x >= shown.x - 6 &&
    point.x <= shown.x + shown.width + 6 &&
    point.y >= shown.y - 2 &&
    point.y <= shown.bottom;
  if (atEdge) {
    revealTaskbar();
    return;
  }
  if (!taskbarRevealed) return;
  if (over) {
    if (taskbarLeaveTimer) clearTimeout(taskbarLeaveTimer);
    taskbarLeaveTimer = null;
    return;
  }
  if (!taskbarLeaveTimer) {
    taskbarLeaveTimer = setTimeout(() => {
      taskbarLeaveTimer = null;
      setTaskbarRevealed(false);
    }, 320);
  }
}

function syncTaskbarPeek() {
  const wanted = taskbarOn() && taskbarAutoHide();
  if (!wanted) {
    if (taskbarPeekTimer) clearInterval(taskbarPeekTimer);
    taskbarPeekTimer = null;
    if (taskbarLeaveTimer) clearTimeout(taskbarLeaveTimer);
    taskbarLeaveTimer = null;
    taskbarRevealed = false;
  } else if (!taskbarPeekTimer) {
    taskbarPeekTimer = setInterval(tickTaskbarPeek, 120);
  }
  if (taskbarWin && !taskbarWin.isDestroyed()) taskbarWin.setBounds(taskbarBounds(), false);
}

ipcMain.on('taskbar:ready', () => {
  sendTaskbarUpdate();
  sendTaskbarBackdrop();
});

// Bring a window forward: restore it if minimised, then focus it.
function focusTaskbarWindow(hwnd) {
  if (!Number.isFinite(hwnd) || hwnd <= 0) return;
  if (hookProc && hookProc.stdin && !hookProc.stdin.destroyed) {
    try {
      hookProc.stdin.write(`activate ${Math.trunc(hwnd)}\n`);
      return;
    } catch {
      /* fall through to the helper process */
    }
  }
  const script =
    `Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd); ` +
    `[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);' ` +
    `-Name U -Namespace W; [W.U]::ShowWindow([IntPtr]${hwnd}, 9) | Out-Null; [W.U]::SetForegroundWindow([IntPtr]${hwnd}) | Out-Null`;
  execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 4000 }, () => {});
}

ipcMain.on('taskbar:focus', (_event, handle) => focusTaskbarWindow(Number(handle)));

// Win+<number> opens whatever the bar shows under that number: pins first, then
// running windows, exactly like the buttons left to right.
function activateTaskbarSlot(slot) {
  if (!Number.isFinite(slot) || slot < 1 || slot > 10) return;
  const entries = [];
  for (const pin of pinnedEntries()) entries.push({ pin });
  for (const item of taskbarItems) entries.push({ item });
  const entry = entries[slot - 1];
  if (!entry) return;
  hideLauncher();
  if (entry.pin) launchTarget(entry.pin.target);
  else focusTaskbarWindow(entry.item.hwnd);
}

function sendWidgetStats() {
  if (!widgetWin || widgetWin.isDestroyed()) return;
  const stats = currentStats();
  widgetWin.webContents.send('widget:stats', {
    cpu: Math.round(stats.cpu),
    ram: stats.ram,
    disk: stats.disk,
  });
}

function startWidgetStats() {
  sendWidgetStats();
  if (widgetStatsTimer) return;
  widgetStatsTimer = setInterval(sendWidgetStats, 1500);
}

function stopWidgetStats() {
  clearInterval(widgetStatsTimer);
  widgetStatsTimer = null;
  stopProcSampling();
}

function startProcSampling() {
  if (widgetProcTimer) return;
  sampleProcesses();
  widgetProcTimer = setInterval(sampleProcesses, 3000);
}

function stopProcSampling() {
  clearInterval(widgetProcTimer);
  widgetProcTimer = null;
  procPrev = new Map();
  procPrevAt = 0;
}

// Task Manager–style breakdown: PowerShell lists the busiest processes, and the
// CPU column is the delta of their accumulated CPU seconds between samples.
function sampleProcesses() {
  if (procBusy || !widgetExpanded || !widgetWin || widgetWin.isDestroyed()) return;
  procBusy = true;
  const script =
    'Get-Process | Where-Object { $_.WorkingSet64 -gt 20000000 } | Sort-Object CPU -Descending | Select-Object -First 12 Name,Id,CPU,WorkingSet64 | ConvertTo-Json -Compress';
  execFile(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { windowsHide: true, timeout: 6000 },
    (error, stdout) => {
      procBusy = false;
      if (error || !stdout) return;
      let list;
      try {
        list = JSON.parse(stdout);
      } catch {
        return;
      }
      if (!Array.isArray(list)) list = [list];
      const now = Date.now();
      const elapsed = procPrevAt ? (now - procPrevAt) / 1000 : 0;
      const cores = Math.max(1, os.cpus().length);
      const totalRam = os.totalmem();
      const next = new Map();
      const items = [];
      for (const entry of list) {
        const key = `${entry.Id}-${entry.Name}`;
        const seconds = Number(entry.CPU) || 0;
        next.set(key, seconds);
        const before = procPrev.get(key);
        const percent =
          elapsed > 0 && before !== undefined
            ? Math.max(0, ((seconds - before) / elapsed / cores) * 100)
            : 0;
        items.push({ name: entry.Name, cpu: percent, mem: Number(entry.WorkingSet64) || 0 });
      }
      procPrev = next;
      procPrevAt = now;
      const topCpu = [...items]
        .sort((a, b) => b.cpu - a.cpu)
        .slice(0, 4)
        .map((item) => ({
          name: item.name,
          share: Math.min(1, item.cpu / 100),
          label: `${Math.round(item.cpu)}%`,
        }));
      const topRam = [...items]
        .sort((a, b) => b.mem - a.mem)
        .slice(0, 4)
        .map((item) => ({
          name: item.name,
          share: totalRam ? item.mem / totalRam : 0,
          label: `${(item.mem / 1073741824).toFixed(1)} GB`,
        }));
      if (widgetWin && !widgetWin.isDestroyed()) {
        widgetWin.webContents.send('widget:processes', { cpu: topCpu, ram: topRam });
      }
    },
  );
}

function setWidgetExpanded(value) {
  widgetExpanded = !!value;
  if (!widgetWin || widgetWin.isDestroyed()) return;
  const bounds = widgetWin.getBounds();
  const size = widgetSize(widgetExpanded);
  const pos = clampWidget(bounds.x, bounds.y, size.width, size.height);
  // setContentSize keeps the page exactly the size the layout expects; window
  // bounds on a transparent Windows window can carry invisible frame insets.
  widgetWin.setContentSize(size.width, size.height);
  widgetWin.setPosition(pos.x, pos.y);
  widgetWin.webContents.send('widget:expanded-state', widgetExpanded);
  if (widgetExpanded) startProcSampling();
  else stopProcSampling();
}

function createWidget() {
  widgetWin = new BrowserWindow({
    ...widgetSize(widgetExpanded),
    x: 40,
    y: 80,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    thickFrame: false,
    roundedCorners: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    title: 'System',
    webPreferences: {
      preload: path.join(__dirname, 'widget-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });
  widgetWin.setMenu(null);
  widgetWin.setAlwaysOnTop(true, 'screen-saver');
  widgetWin.setSkipTaskbar(true);
  widgetWin.loadFile(path.join(__dirname, 'src', 'widget.html'));
  widgetWin.once('ready-to-show', () => {
    if (!widgetWin || widgetWin.isDestroyed()) return;
    const size = widgetSize(widgetExpanded);
    widgetWin.setContentSize(size.width, size.height);
    widgetWin.showInactive();
    widgetWin.moveTop();
    startWidgetStats();
    sendWidgetBackdrop();
  });
  widgetWin.on('closed', () => {
    widgetWin = null;
    widgetExpanded = false;
    stopWidgetDrag();
    stopWidgetStats();
  });
}

function openWidget(at) {
  const size = widgetSize(widgetExpanded);
  const pos = clampWidget(
    Math.round(at.x - size.width / 2),
    Math.round(at.y - 26),
    size.width,
    size.height,
  );
  if (!widgetWin || widgetWin.isDestroyed()) {
    createWidget();
    widgetWin.setContentSize(size.width, size.height);
    widgetWin.setPosition(pos.x, pos.y);
  } else {
    widgetWin.setContentSize(size.width, size.height);
    widgetWin.setPosition(pos.x, pos.y);
    widgetWin.showInactive();
    widgetWin.moveTop();
    startWidgetStats();
  }
  startWidgetDrag({ dx: size.width / 2, dy: 26 });
}

ipcMain.on('notch:detach', (_event, point) => {
  const at = point && Number.isFinite(point.x) ? point : cursorDip();
  openWidget(at);
});

ipcMain.on('notch:detach-end', () => finishWidgetDrag());

ipcMain.on('widget:drag-start', () => {
  if (!widgetWin || widgetWin.isDestroyed()) return;
  const point = cursorDip();
  const bounds = widgetWin.getBounds();
  startWidgetDrag({ dx: point.x - bounds.x, dy: point.y - bounds.y });
});

ipcMain.on('widget:drag-end', () => finishWidgetDrag());

ipcMain.on('widget:close', () => {
  if (widgetWin && !widgetWin.isDestroyed()) widgetWin.close();
});

ipcMain.on('widget:expanded', (_event, value) => setWidgetExpanded(value));

ipcMain.on('widget:ready', () => {
  startWidgetStats();
  sendWidgetBackdrop();
  if (widgetExpanded) startProcSampling();
});

// --------------------------------------------------------------------- startup

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.setAppUserModelId('com.notch.desktop');

  app.on('second-instance', () => {
    if (win && !win.isDestroyed()) {
      win.showInactive();
      win.webContents.send('notch:open');
    }
  });

  app.whenReady().then(() => {
    loadPrefs();
    // The assistant listens through the microphone; Chromium asks us first.
    try {
      const allowed = new Set(['media', 'notifications', 'clipboard-read', 'clipboard-sanitized-write']);
      session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => {
        callback(allowed.has(permission));
      });
      session.defaultSession.setPermissionCheckHandler((_contents, permission) => allowed.has(permission));
    } catch {
      /* older Electron */
    }
    rescanGames();
    readBattery();
    createWindow();
    buildTray();
    applyLogin();
    refreshTaskbar();
    syncWinHook();
    // Warm the launcher and its app index so the first Windows key is instant.
    createLauncher();
    buildAppIndex().catch(() => {});

    globalShortcut.register('Control+Alt+Space', () => toggleLauncher());
    globalShortcut.register('Control+Alt+N', () => {
      if (win && !win.isDestroyed()) win.webContents.send('notch:toggle-pin');
    });
    globalShortcut.register('Control+Alt+J', () => toggleJarvis());
    globalShortcut.register('Control+Alt+Q', () => app.quit());

    setInterval(readBattery, 15 * 60 * 1000);
  });

  app.on('before-quit', () => {
    app.isQuitting = true;
    stopWinHook();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    stopLiveData();
    stopDesktopSampling();
    stopWidgetDrag();
    stopWidgetStats();
    clearTimeout(pointerTimer);
    pointerTimer = null;
    if (tray) {
      tray.destroy();
      tray = null;
    }
  });

  app.on('activate', () => {
    if (!win) createWindow();
    else win.showInactive();
  });
}
