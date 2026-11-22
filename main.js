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

// Settings live in the same folder whether the app runs from a checkout or from
// the packaged executable, so an install keeps the setup you already had.
app.setPath('userData', path.join(app.getPath('appData'), 'notch'));

// Trim Electron's baseline footprint: cap the V8 heap, because this window only
// ever draws a small overlay. (Electron already suppresses the spare renderer.)
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=192 --max-semi-space-size=2');
// Let Chromium drop caches while nothing is happening.
app.commandLine.appendSwitch('aggressive-cache-discard');
// Speech recognition runs on onnxruntime, which only spreads a model over several
// threads when shared memory is available. This window is loaded from a file, so
// there are no headers to make it cross-origin isolated; the switch is what turns
// SharedArrayBuffer on anyway, and four threads instead of one is the difference
// between a Danish phrase taking eight seconds and two.
// Managed machines often have no hardware WebGL, and Chromium refuses its software
// rasterizer for WebGL unless asked: without this the glass has no context and the
// panel falls back to the flat material.
app.commandLine.appendSwitch('enable-unsafe-swiftshader');
app.commandLine.appendSwitch('enable-features', 'SharedArrayBuffer');

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
// When the close animation stops mattering for the hit rect: the panel stays a
// hover target for as long as any of it is still on screen.
let collapsesUntil = 0;
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
  // 'system' follows Windows' animation setting; 'always' animates even where that
  // setting is off, which is how managed and school machines usually ship.
  animations: 'system',
  easing: 'spring',
  hoverDelay: 0,
  pillWidth: 96,
  pillHeight: 26,
  // How far the folded pill sits from the centre of the screen, in DIP.
  pillOffset: 0,
  // The order the folded pill's pieces appear in, and which of them are hidden.
  pillItems: ['dot', 'time', 'focus', 'date', 'battery'],
  pillHidden: [],
  notchStyle: 'attached',
  backdrop: 'live',
  taskbar: false,
  taskbarStyle: 'glass',
  taskbarShape: 'islands',
  taskbarShow: 'both',
  taskbarAutoHide: false,
  // Notch's bar replaces the taskbar: while it is on, the real one can be taken
  // out of the way. Only ever applied with Notch's bar showing.
  hideWinTaskbar: true,
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
  // A black surface has no glass to feed, so the desktop sampling stops entirely.
  if (prefs.settings.material === 'black') return false;
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
  // Games taken out of the library stay out of every scan: a rescan must not
  // bring back something that was deliberately removed.
  const hidden = new Set(Array.isArray(prefs.hiddenGames) ? prefs.hiddenGames : []);
  games = scanGames(prefs.customGames || []).filter((game) => !hidden.has(game.id));
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

// Every window of ours is kept out of screen captures for good. Windows honours
// content protection as capture exclusion, so the samples are the bare desktop —
// no ghost of the pill, the islands or a widget baked into the glass. Setting it
// once at creation also matters for the log: flipping the flag around each grab
// re-routed the display and made Chromium's capturer miss a frame every time.
const protectedSurfaces = new WeakSet();

function protectSurface(surface) {
  if (!surface || surface.isDestroyed() || protectedSurfaces.has(surface)) return false;
  try {
    surface.setContentProtection(true);
    protectedSurfaces.add(surface);
    return true;
  } catch {
    return false;
  }
}

function protectSurfaces() {
  let fresh = 0;
  for (const surface of [
    win,
    ...widgetWins.values(),
    ...taskbarZones().map((zone) => zone.win),
    launcherWin,
    jarvisWin,
    voiceHudWin,
    flyoutWin,
  ]) {
    if (protectSurface(surface)) fresh += 1;
  }
  return fresh;
}

// Windows' screen capture draws the pointer into the frame, so the glass keeps a
// ghost of a mouse that was never there. The patch the pointer covered is healed
// with the colour around it: at half resolution the ghost is barely twenty
// pixels, and the glass blurs the smudge away.
function healCursor(image, display) {
  try {
    if (!image || image.isEmpty() || !display) return image;
    const point = screen.getCursorScreenPoint();
    const at = screen.getDisplayNearestPoint(point);
    if (!at || at.id !== display.id) return image;
    const size = image.getSize();
    const scaleX = size.width / display.size.width;
    const scaleY = size.height / display.size.height;
    if (!(scaleX > 0.01) || !(scaleY > 0.01)) return image;
    const cx = Math.round((point.x - display.bounds.x) * scaleX);
    const cy = Math.round((point.y - display.bounds.y) * scaleY);
    if (cx < 0 || cy < 0 || cx >= size.width || cy >= size.height) return image;
    const radius = Math.max(8, Math.round(24 * scaleX));
    const left = Math.max(0, cx - radius);
    const top = Math.max(0, cy - radius);
    const right = Math.min(size.width - 1, cx + radius);
    const bottom = Math.min(size.height - 1, cy + radius);
    if (right - left < 4 || bottom - top < 4) return image;
    const bitmap = image.toBitmap();
    // The colour around the patch: a ring just outside it, which the pointer
    // itself cannot be covering.
    const ring = Math.max(2, Math.round(3 * scaleX));
    let r = 0;
    let g = 0;
    let b = 0;
    let count = 0;
    const sample = (sx, sy) => {
      if (sx < 0 || sy < 0 || sx >= size.width || sy >= size.height) return;
      const pixel = (sy * size.width + sx) * 4;
      b += bitmap[pixel];
      g += bitmap[pixel + 1];
      r += bitmap[pixel + 2];
      count += 1;
    };
    for (let sx = left; sx <= right; sx += 2) {
      sample(sx, top - ring);
      sample(sx, bottom + ring);
    }
    for (let sy = top; sy <= bottom; sy += 2) {
      sample(left - ring, sy);
      sample(right + ring, sy);
    }
    if (!count) return image;
    r /= count;
    g /= count;
    b /= count;
    const midX = (left + right) / 2;
    const midY = (top + bottom) / 2;
    const reach = Math.max(1, (right - left) / 2, (bottom - top) / 2);
    for (let sy = top; sy <= bottom; sy += 1) {
      for (let sx = left; sx <= right; sx += 1) {
        const distance = Math.hypot(sx - midX, sy - midY) / reach;
        if (distance > 1) continue;
        // Solid under the pointer, feathered out to the ring it sits in.
        const alpha = Math.min(1, (1 - distance) * 2);
        const pixel = (sy * size.width + sx) * 4;
        bitmap[pixel] = Math.round(bitmap[pixel] + (b - bitmap[pixel]) * alpha);
        bitmap[pixel + 1] = Math.round(bitmap[pixel + 1] + (g - bitmap[pixel + 1]) * alpha);
        bitmap[pixel + 2] = Math.round(bitmap[pixel + 2] + (r - bitmap[pixel + 2]) * alpha);
      }
    }
    const healed = nativeImage.createFromBitmap(bitmap, { width: size.width, height: size.height });
    return healed.isEmpty() ? image : healed;
  } catch {
    return image;
  }
}

async function captureDesktop() {
  if (!win || win.isDestroyed() || desktopBusy || !usesLiveBackdrop()) return;
  desktopBusy = true;
  try {
    const display = screen.getDisplayMatching(win.getBounds());
    if (protectSurfaces()) await new Promise((resolve) => setTimeout(resolve, 80));
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
    desktopFrame = { image: healCursor(source.thumbnail, display), display };
    const url = backdropDataUrl();
    if (url && win && !win.isDestroyed()) win.webContents.send('notch:backdrop', url);

  } catch {
    /* capture unavailable: the wallpaper sample stays as the fallback */
  } finally {
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

// The panel streams the desktop itself once it is on screen: one continuous
// capture at screen rate instead of a fresh full-screen grab — about 300 ms on
// this machine — every few seconds. While that stream is up this grab loop stands
// down; if the stream cannot start, the loop is what keeps the glass fed.
let streamActive = false;

// Live glass needs frames while anything wearing it is on screen: the pill when
// the pointer is near, and the taskbar islands whenever they are up.
function samplingWanted() {
  // The islands take their own small strips; this live desktop is only for the
  // panel, so it runs while the panel is open or the pointer is near it and no
  // longer.
  return (
    usesLiveBackdrop() &&
    (isExpanded || pointerNear) &&
    !gameMode &&
    !!win &&
    !win.isDestroyed() &&
    win.isVisible()
  );
}

function syncDesktopSampling() {
  const wanted = samplingWanted();
  if (win && !win.isDestroyed()) win.webContents.send('notch:live', wanted);
  if (!wanted) {
    stopDesktopSampling();
    return;
  }
  if (!streamActive) startDesktopSampling();
}

// ---------------------------------------------------------------- game mode

// A game with the screen in front of it should get the whole machine. Windows
// knows when one owns the display; while that holds every scan, capture, timer
// and microphone in this shell stands down and the windows are put away, so the
// cost of running Notch behind a game is one politer-than-a-second question and
// nothing else.
let gameMode = false;
let gameBusy = false;
let gamePollTimer = null;
let gameHidden = [];

function shellSurfaces() {
  return [
    win,
    ...widgetWins.values(),
    ...taskbarZones().map((zone) => zone.win),
    launcherWin,
    jarvisWin,
    voiceHudWin,
    flyoutWin,
  ].filter((surface) => surface && !surface.isDestroyed());
}

function setGameMode(on) {
  if (gameMode === on) return;
  gameMode = on;
  // A game takes the whole machine, including the bar Notch was drawing: the
  // real taskbar comes back for the duration instead of staying hidden behind a
  // shell that has stepped aside.
  sendNativeTaskbarState();
  // Told first, before its window is hidden and parked: a parked renderer is a
  // poor listener, and this is what makes it let go of the microphone and the
  // speech model.
  tellJarvisGameMode(on);
  if (on) {
    syncDesktopSampling();
    stopJarvisBackdrop();
    setTaskbarRevealed(false);
    // Watched surfaces a game keeps: the performance overlay, because watching the
    // game is what it is for, and an opened System card, which then runs on the slow
    // tick below. Everything else — panel, taskbar, Jarvis, launcher — is put away.
    gameHidden = shellSurfaces().filter(
      (surface) =>
        surface.isVisible() && surface !== widgetsFor('perf') && surface !== widgetsFor('system'),
    );
    for (const surface of gameHidden) {
      try {
        surface.hide();
      } catch {
        /* already gone */
      }
    }
    revealed = false;
    pointerNear = false;
    if (pointerTimer) {
      clearInterval(pointerTimer);
      pointerTimer = null;
    }
  } else {
    // Whatever the game put away comes back where it was.
    for (const surface of gameHidden) {
      if (surface.isDestroyed()) continue;
      try {
        surface.showInactive();
      } catch {
        /* already gone */
      }
    }
    gameHidden = [];
    // A window that has been hidden and shown again does not always keep its
    // topmost bit, so the pill asks for it back rather than trusting the one it
    // was created with.
    pinPillOnTop();
    if (!pointerTimer && win && !win.isDestroyed()) {
      // Hover is what brings it back; the poll has to be running for that.
      armPointerPoll();
    }
  }

  // Chromium parks a throttled window, which is most of the idle cost.
  for (const surface of shellSurfaces()) {
    // The overlay counts frames, which means its animation frame callback has to
    // keep running while the game does — that is the number it shows.
    if (surface === widgetsFor('perf')) continue;
    // The listening window is never throttled: a parked page reads its queue once
    // a minute, which is how a game could start and the microphone stay open. It
    // is what decides to stand down, so it has to keep thinking.
    if (surface === jarvisWin) continue;
    try {
      surface.webContents.setBackgroundThrottling(true);
    } catch {
      /* older builds */
    }
  }
  // The game should never wait for this shell. Dropped to idle, Windows only
  // schedules us when nothing else wants the core, which is what "0% CPU" means
  // in practice — and the overlay keeps counting frames because it is never busy.
  yieldCpuToGame(on);
  // Polling gets slower, not faster: a card left on screen during a game still
  // moves, at a third of the wake-ups.
  if (widgetStatsTimer) {
    clearInterval(widgetStatsTimer);
    widgetStatsTimer = setInterval(sendWidgetStats, gameStatsInterval());
  }
  // The process list is kept alive through a game for the same reason, on its own
  // slower beat.
  if (widgetProcTimer) {
    clearInterval(widgetProcTimer);
    widgetProcTimer = setInterval(sampleProcesses, procInterval());
  }
  try {
    syncTaskbarPeek();
  } catch {
    /* the taskbar is not up yet */
  }
}

// A hidden renderer parks its own event loop, so the notice would sit in a queue
// behind the thing it is meant to stop. The throttle is lifted for a moment, the
// page is told twice (message and a direct call, one of which always lands), and
// then the window is parked again a beat later.
// Loaded again rather than told: a hidden renderer defers messages and timers
// until something wakes it, and during a game nothing does. Reloading is what
// actually closes the microphone and lets go of the speech model, and the page
// comes back in its normal state when the game is over.
function tellJarvisGameMode(on) {
  if (!jarvisWin || jarvisWin.isDestroyed()) return;
  const contents = jarvisWin.webContents;
  // A page that has been out of sight for a while reads its queue once a minute.
  // The throttle is lifted for this, and the call is repeated: the microphone has
  // to close when the game starts, not a minute later.
  try {
    contents.send('jarvis:game-mode', on);
  } catch {
    /* window is not ready */
  }
}

// Every process this app owns, including the renderers, dropped to idle while a
// game runs and put back afterwards. Windows keeps a lower class from taking a
// core away from anything that wants it, so the shell costs the game nothing even
// when a timer fires.
function yieldCpuToGame(on) {
  let pids = [];
  try {
    pids = app.getAppMetrics().map((metric) => metric.pid);
  } catch {
    /* metrics are best effort */
  }
  const priority = on
    ? os.constants.priority.PRIORITY_LOW
    : os.constants.priority.PRIORITY_NORMAL;
  for (const pid of [...new Set([process.pid, ...pids])]) {
    try {
      os.setPriority(pid, priority);
    } catch {
      /* a renderer that already exited */
    }
  }
}

function watchForGames() {
  clearInterval(gamePollTimer);
  gamePollTimer = setInterval(async () => {
    if (gameBusy) return;
    gameBusy = true;
    try {
      const answer = await askHook('game', 'GAME\t', 4000);
      setGameMode(/^1\b/.test(String(answer || '').trim()));
    } catch {
      /* no helper: assume nothing is fullscreen */
    } finally {
      gameBusy = false;
    }
    // Two seconds, not six: the pill has to be gone the moment a video or a game
    // goes fullscreen over it, and back the moment that is over. The question is
    // a couple of Win32 calls in the helper that is already running.
  }, 2000);
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
  if (gameMode || !win || win.isDestroyed()) return;
  win.webContents.send('notch:stats', currentStats());
}

let clipBusy = false;

async function pollClipboard() {
  if (gameMode || clipBusy) return;
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
  const display = screen.getPrimaryDisplay();
  // Centre on the screen, not on the work area: a taskbar docked on the left or
  // right shrinks the work area, and centring inside that parks the notch a
  // little to the right of the screen's middle. The top edge is the same either
  // way, so only the height is taken from the work area.
  const area = display.workArea;
  const full = display.bounds;
  const width = PANEL_W + 32;
  const height = PANEL_H + 34;
  return {
    x: Math.round(full.x + (full.width - width) / 2),
    y: area.y,
    width,
    height,
  };
}

// Windows moves a topmost, non-movable window on its own when the display's
// resolution or scale changes, and the metrics event arrives before Chromium has
// settled on the new scale — re-centring inside the event can land on the old
// geometry and leave the notch leaning to one side. Centring again a beat later
// is what puts it back on the middle; the same holds when the app starts before
// the desktop has its final layout (a login start, a monitor still waking).
function recenterNotch(delay = 0) {
  const place = () => {
    if (!win || win.isDestroyed()) return;
    const next = targetBounds();
    const now = win.getBounds();
    if (
      now.x === next.x &&
      now.y === next.y &&
      now.width === next.width &&
      now.height === next.height
    ) {
      return;
    }
    win.setBounds(next, false);
    pinPillOnTop();
    // The frame Windows kept while it moved the window belongs to the old spot.
    repaintShell();
  };
  if (delay > 0) setTimeout(place, delay);
  else place();
}

// A transparent, always-on-top window can present the frame it last rasterised:
// a colour change in the middle of the sheet (the accent) and content that was
// drawn while the panel was folded away can both come back stale, until a hover
// or a click happens to repaint them. Asking for the whole frame again is what
// makes the blues blue the first time they are on screen.
function repaintShell(delay = 0) {
  const paint = () => {
    if (!win || win.isDestroyed()) return;
    if (win.webContents && typeof win.webContents.invalidate === 'function') {
      win.webContents.invalidate();
    }
  };
  if (delay > 0) setTimeout(paint, delay);
  else paint();
}

// The window is always panel-sized; only the clip changes. Clicks outside the
// visible notch are handed back to the desktop by the cursor poll below.
function notchScreenRect() {
  if (!win || win.isDestroyed()) return null;
  const bounds = win.getBounds();
  // As soon as the cursor is on the pill the panel is on its way out, so the
  // whole panel footprint becomes the hover area right away instead of waiting
  // for the renderer to confirm the expansion. The same holds the other way
  // round: while the panel is still shrinking it is still there to be pointed
  // at, so the rect has to outlive the animation instead of snapping to the pill
  // the moment the cursor leaves and the expansion flag drops.
  const wide = isExpanded || pointerInside || Date.now() < collapsesUntil;
  const pill = Math.max(Number(prefs.settings.pillWidth) || PILL_W, pillContentW);
  const width = wide ? PANEL_W : Math.max(56, Math.min(320, pill));
  const gap = prefs.settings.notchStyle === 'island' ? NOTCH_GAP : 0;
  const height = wide ? PANEL_H - gap : Math.max(20, Math.min(40, prefs.settings.pillHeight || PILL_H));
  // The pill can be dragged off centre, and the rect has to go with it — never
  // past the window's edge, or the pointer would leave before the pill did.
  const room = Math.max(0, (PANEL_W - width) / 2);
  const shift = wide ? 0 : Math.max(-room, Math.min(room, Number(prefs.settings.pillOffset) || 0));
  return {
    x: Math.round(bounds.x + (bounds.width - width) / 2 + shift),
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
  // The pill belongs over every window; only a fullscreen app puts it away, and
  // that is game mode's job. A window that is shown again after being hidden can
  // come back below the topmost band, so the bit is checked on a slow beat — the
  // query is the only cost, and it repaints nothing.
  if (Date.now() - topmostCheckAt > 2000) {
    topmostCheckAt = Date.now();
    if (!win.isAlwaysOnTop()) pinPillOnTop();
  }
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
    syncDesktopSampling();
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

// Over everything: the desktop, a maximised window, the taskbar. Not over a
// fullscreen app — game mode hides the whole shell for that — and nothing else
// takes the pill's place in the stack.
let topmostCheckAt = 0;

function pinPillOnTop() {
  if (!win || win.isDestroyed() || gameMode) return false;
  try {
    win.setAlwaysOnTop(true, 'screen-saver');
    win.moveTop();
    return true;
  } catch {
    return false;
  }
}

function revealWindow() {
  if (gameMode || revealed || !win || win.isDestroyed()) return;
  revealed = true;
  // Placed while it was hidden, possibly before the desktop had its final
  // geometry: put it on the middle before it is seen, and once more after the
  // desktop has settled.
  recenterNotch(0);
  recenterNotch(1200);
  win.showInactive();
  pinPillOnTop();
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

  const reassertPosition = () => {
    recenterNotch(0);
    recenterNotch(700);
  };
  screen.on('display-metrics-changed', reassertPosition);
  screen.on('display-added', reassertPosition);
  screen.on('display-removed', reassertPosition);
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
  engine: 'neural',
  neuralVoice: 'en_GB-alan-medium',
  studioVoice: 'bm_george',
  // auto: answer in whatever the user wrote or spoke. da/en force one language.
  language: 'auto',
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
  // Abliterated and uncensored builds: the same weights with the refusal habit
  // trained out, so an order is carried out instead of argued with. The names are
  // the tags ollama.com publishes, so the pull finds exactly what it asks for.
  {
    name: 'huihui_ai/qwen2.5-abliterate:1.5b',
    label: 'Qwen 2.5 1.5B abliterated',
    size: '986 MB',
    note: 'No refusals',
    free: true,
  },
  {
    name: 'huihui_ai/qwen2.5-abliterate:3b',
    label: 'Qwen 2.5 3B abliterated',
    size: '1.9 GB',
    note: 'No refusals',
    free: true,
  },
  {
    name: 'huihui_ai/qwen2.5-abliterate:7b',
    label: 'Qwen 2.5 7B abliterated',
    size: '4.7 GB',
    note: 'No refusals',
    free: true,
  },
  {
    name: 'huihui_ai/qwen2.5-abliterate:14b',
    label: 'Qwen 2.5 14B abliterated',
    size: '9.0 GB',
    note: 'No refusals',
    free: true,
  },
  {
    name: 'huihui_ai/qwen2.5-abliterate:32b',
    label: 'Qwen 2.5 32B abliterated',
    size: '20 GB',
    note: 'No refusals',
    free: true,
  },
  { name: 'dolphin3:8b', label: 'Dolphin 3 8B', size: '4.9 GB', note: 'Uncensored chat', free: true },
  // One reasoning model and one code specialist for every size class, so each
  // rung of recommendPlan()'s ladder has all three names it needs. The tags and
  // sizes are the ones ollama.com publishes, so a pull finds exactly this.
  { name: 'deepseek-r1:1.5b', label: 'DeepSeek R1 1.5B', size: '1.1 GB', note: 'Thinks, very light' },
  { name: 'deepseek-r1:7b', label: 'DeepSeek R1 7B', size: '4.7 GB', note: 'Step-by-step reasoning' },
  { name: 'deepseek-r1:8b', label: 'DeepSeek R1 8B', size: '5.2 GB', note: 'Reasoning for 8 GB VRAM' },
  { name: 'deepseek-r1:14b', label: 'DeepSeek R1 14B', size: '9.0 GB', note: 'Hard problems, 12 GB VRAM' },
  { name: 'deepseek-r1:32b', label: 'DeepSeek R1 32B', size: '20 GB', note: 'Deep reasoning, 24 GB class' },
  { name: 'qwen2.5-coder:1.5b', label: 'Qwen 2.5 Coder 1.5B', size: '986 MB', note: 'Code, instant' },
  { name: 'qwen2.5-coder:3b', label: 'Qwen 2.5 Coder 3B', size: '1.9 GB', note: 'Code, fast' },
  { name: 'qwen2.5-coder:7b', label: 'Qwen 2.5 Coder 7B', size: '4.7 GB', note: 'Strong code model for 8 GB VRAM' },
  { name: 'qwen2.5-coder:14b', label: 'Qwen 2.5 Coder 14B', size: '9.0 GB', note: 'Best code model under 24 GB' },
  { name: 'qwen2.5-coder:32b', label: 'Qwen 2.5 Coder 32B', size: '20 GB', note: 'Code at GPT-4o class' },
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

// ------------------------------------------------------ hardware + commands

// What the machine can actually run, so the model pick isn't a guess.
let hardwareCache = null;

// Win32_VideoController.AdapterRAM is a 32-bit figure, so a card with 8 GB of
// memory commonly reports 4 GB — and the machine was then sized for a 3B model it
// could carry a 7B on. The driver's own entry in the display class registry is a
// QWORD and carries the real size, so that is read first and the adapter figure
// is only the floor.
function gpuMemoryBytes() {
  if (!isWin) return 0;
  try {
    const raw = execFileSync(
      'reg',
      [
        'query',
        'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}',
        '/s',
        '/v',
        'HardwareInformation.qwMemorySize',
      ],
      { encoding: 'utf8', windowsHide: true, timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    let best = 0;
    for (const match of String(raw).matchAll(/REG_QWORD\s+0x([0-9a-f]+)/gi)) {
      const value = Number.parseInt(match[1], 16);
      if (Number.isFinite(value) && value > best) best = value;
    }
    return best;
  } catch {
    return 0;
  }
}

function detectHardware() {
  if (hardwareCache) return hardwareCache;
  const cpus = os.cpus();
  const cores = cpus.length || 1;
  const ramGb = Math.round((os.totalmem() / 1024 ** 3) * 10) / 10;
  const cpu = String((cpus[0] && cpus[0].model) || '').replace(/\s+/g, ' ').trim();
  let gpu = '';
  let vramGb = Math.round((gpuMemoryBytes() / 1024 ** 3) * 10) / 10;
  try {
    const raw = execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "Get-CimInstance Win32_VideoController | Sort-Object -Property @{e={[int64]$_.AdapterRAM}} -Descending | Select-Object -First 1 Name,@{n='vram';e={[int64]$_.AdapterRAM}} | ConvertTo-Json -Compress",
      ],
      { encoding: 'utf8', windowsHide: true, timeout: 8000 },
    );
    const parsed = JSON.parse(String(raw).trim() || 'null');
    if (parsed) {
      gpu = String(parsed.Name || '').trim();
      const reported = Math.max(Number(parsed.vram) || 0, gpuMemoryBytes());
      vramGb = Math.round((reported / 1024 ** 3) * 10) / 10;
    }
  } catch {
    /* no video controller info: the registry figure, if any, is still usable */
  }
  // Integrated graphics borrow system RAM, so they count as no model space.
  const integrated = !gpu || /intel|uhd|iris|radeon\(tm\) graphics|radeon graphics|vega \d+ graphics/i.test(gpu);
  const gpuMemoryGb = integrated ? 0 : vramGb;
  // Three honest bands instead of a single guess: what the machine can carry
  // for the brain, for listening and for the voice all differ, and a desk with
  // a real card should get the good stuff rather than the safe stuff.
  const tier = gpuMemoryGb >= 6 && cores >= 6 ? 'studio' : gpuMemoryGb >= 3 ? 'gpu' : 'cpu';
  hardwareCache = {
    cpu: cpu || 'Unknown CPU',
    cores,
    ramGb,
    gpu: gpu || 'unknown graphics',
    vramGb,
    integrated,
    gpuMemoryGb,
    tier,
    tierNote:
      tier === 'studio'
        ? `${gpu} with ${gpuMemoryGb} GB of video memory: the studio voice, whisper-small on the GPU and a 7B brain all fit at once, so answers start in about a second.`
        : tier === 'gpu'
          ? `${gpu} with ${gpuMemoryGb} GB of video memory: a GPU-accelerated brain and listening, with the light voice.`
          : `${cores} CPU threads and no dedicated graphics: the light voice and small models, which stay instant here.`,
  };
  return hardwareCache;
}

// Which speech model the machine can afford. A real GPU gets the more accurate
// whisper on WebGPU; everything else gets moonshine, the only thing fast enough
// on a CPU without WASM threads.
function recommendStt(hardware = detectHardware()) {
  // Danish is only understood by the multilingual whisper; the small English
  // models would answer a Danish phrase with English-sounding nonsense.
  if (assistantSettings().language === 'da') {
    // Whisper small was measured at 20–44 s for a one-second Danish phrase on this
    // processor, which is not a conversation; base with Danish named to it is the
    // one that fits. Naming the language is most of the difference between "Åbn
    // lommeregner" and "Open the door", because whisper otherwise guesses English
    // on a short clip. A graphics card has the room for the larger model.
    const gpu = hardware.tier === 'studio' || (!hardware.integrated && hardware.gpuMemoryGb >= 4);
    return {
      model: gpu ? 'onnx-community/whisper-small' : 'onnx-community/whisper-base',
      fallback: 'onnx-community/whisper-base',
      device: 'auto',
      language: 'da',
      note: gpu
        ? `Dansk: whisper-small på ${hardware.gpu} med dansk angivet — den hører dansk bedst, og kortet gør den hurtig nok.`
        : 'Dansk: whisper-base med dansk angivet, så den ikke gætter på engelsk; regn med et par sekunder pr. sætning på en processor.',
    };
  }
  if (hardware.tier === 'studio') {
    return {
      model: 'onnx-community/whisper-small',
      fallback: 'onnx-community/whisper-base',
      device: 'auto',
      note: `${hardware.gpu} has the room for whisper-small on the GPU: it mishears far less than the small CPU models, and still answers in well under a second.`,
    };
  }
  if (!hardware.integrated && hardware.gpuMemoryGb >= 4) {
    return {
      model: 'onnx-community/whisper-base',
      fallback: 'onnx-community/moonshine-tiny-ONNX',
      device: 'auto',
      note: `${hardware.gpu} with ${hardware.gpuMemoryGb} GB of VRAM runs the larger, more accurate model on the GPU.`,
    };
  }
  return {
    model: 'onnx-community/moonshine-tiny-ONNX',
    fallback: '',
    device: 'wasm',
    note: `${hardware.cores} CPU threads and no dedicated GPU: the small model on the CPU, which answers in about two seconds.`,
  };
}

function recommendModel(hardware = detectHardware()) {
  const vram = hardware.gpuMemoryGb;
  const { cores, ramGb } = hardware;
  if (vram >= 12) {
    return {
      name: 'qwen2.5:14b',
      reason: `${hardware.gpu} has ${vram} GB of video memory, so a 14B model fits on the GPU and still answers quickly.`,
    };
  }
  if (vram >= 8) {
    return {
      name: 'qwen2.5:7b',
      reason: `${hardware.gpu} has ${vram} GB of video memory, so a 7B model fits on the GPU and still feels instant.`,
    };
  }
  if (vram >= 4) {
    return {
      name: 'qwen2.5:3b',
      reason: `${vram} GB of video memory holds a 3B model fully on the GPU.`,
    };
  }
  if (cores >= 8 && ramGb >= 16) {
    return {
      name: 'qwen2.5:7b',
      reason: `${cores} CPU cores and ${ramGb} GB of RAM are enough to run a 7B model on the processor.`,
    };
  }
  if (cores >= 6 || ramGb >= 16) {
    return {
      name: 'qwen2.5:3b',
      reason: `${cores} CPU cores, ${ramGb} GB of RAM and no dedicated GPU — 3B is the largest that still answers quickly.`,
    };
  }
  return {
          name: 'qwen2.5:1.5b',
    reason: `${cores} CPU threads, ${ramGb} GB of RAM and integrated graphics: a 1.5B model is the one that stays instant here. Bigger models would answer in minutes.`,
  };
}

// The uncensored twin of the recommended brain: the abliterated build of the same
// size class. Abliteration only removes the refusal direction, so it costs nothing
// in speed or memory — whatever tier the machine landed in, the same size fits.
function recommendFreeModel(hardware = detectHardware()) {
  const brain = recommendModel(hardware);
  const size = String(brain.name.split(':')[1] || '7b').replace(/[^0-9.]/g, '');
  const name = `huihui_ai/qwen2.5-abliterate:${size}b`;
  const capacity = hardware.gpuMemoryGb > 0 ? `${hardware.gpuMemoryGb} GB of video memory` : `${hardware.ramGb} GB of RAM`;
  return {
    name,
    reason: `Its uncensored twin is the same ${size}B model with the refusals taken out, so ${capacity} carries it exactly as well and it does what it is told.`,
  };
}

// ------------------------------------------------------------- three brains

// One brain cannot be both instant and careful, so the machine gets three: a
// small one that answers before you finish reading, a reasoning model that
// thinks the hard questions through, and a code specialist. Each rung of this
// ladder names all three in the size class that rung's hardware carries, so the
// trio fits together in the same memory instead of fighting over it.
const MODEL_RUNGS = [
  { key: 'small', fast: 'qwen2.5:1.5b', think: 'deepseek-r1:1.5b', code: 'qwen2.5-coder:1.5b' },
  { key: 'light', fast: 'qwen2.5:3b', think: 'deepseek-r1:7b', code: 'qwen2.5-coder:3b' },
  { key: 'mid', fast: 'qwen2.5:3b', think: 'deepseek-r1:8b', code: 'qwen2.5-coder:7b' },
  { key: 'large', fast: 'qwen2.5:3b', think: 'deepseek-r1:14b', code: 'qwen2.5-coder:14b' },
  { key: 'huge', fast: 'qwen2.5:7b', think: 'deepseek-r1:32b', code: 'qwen2.5-coder:32b' },
];

function planRung(hardware) {
  const vram = hardware.gpuMemoryGb;
  if (vram >= 20) return 4;
  if (vram >= 12) return 3;
  if (vram >= 6) return 2;
  if (vram >= 4) return 1;
  // No dedicated graphics: the processor and the RAM carry every model, so
  // they decide the rung. 24 GB of RAM holds an 8B reasoner beside Windows and
  // the rest of the trio; 16 GB is enough for the 3B/7B pair; below that the
  // small rung is the one that stays usable instead of swapping.
  const { cores, ramGb } = hardware;
  if (ramGb >= 24 && cores >= 8) return 2;
  if (ramGb >= 16 && cores >= 6) return 1;
  if (ramGb >= 12 && cores >= 4) return 1;
  return 0;
}

function presetFor(name) {
  return OLLAMA_PRESETS.find((preset) => preset.name === name) || null;
}

// Download sizes are stored as the readable strings the cards show; this turns
// them back into gigabytes so the plan can add three of them up.
function presetGb(name) {
  const preset = presetFor(name);
  const match = preset && String(preset.size).match(/([\d.]+)\s*(GB|MB)/i);
  if (!match) return 0;
  const amount = Number.parseFloat(match[1]) || 0;
  return /mb/i.test(match[2]) ? amount / 1024 : amount;
}

function formatTotalGb(value) {
  const rounded = Math.round(value * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)} GB`;
}

// The three models this machine should carry, with the reason each one is there.
function recommendPlan(hardware = detectHardware()) {
  const rung = MODEL_RUNGS[planRung(hardware)];
  const capacity =
    hardware.gpuMemoryGb > 0
      ? `${hardware.gpuMemoryGb} GB of video memory`
      : `${hardware.ramGb} GB of RAM`;
  const build = (role, name, note) => {
    const preset = presetFor(name);
    return {
      role,
      name,
      label: preset ? preset.label : name,
      size: preset ? preset.size : '',
      gb: presetGb(name),
      note,
    };
  };
  const fast = build(
    'fast',
    rung.fast,
    hardware.gpuMemoryGb >= 6 ? 'Fastest answers · about a second' : 'Fastest answers · stays instant here',
  );
  const think = build('think', rung.think, 'More thinking · reasons step by step');
  const code = build('code', rung.code, 'Coding · writes, explains and fixes code');
  const picks = [fast, think, code];
  const totalGb = picks.reduce((sum, pick) => sum + pick.gb, 0);
  return {
    rung: rung.key,
    fast,
    think,
    code,
    picks,
    totalGb,
    totalLabel: formatTotalGb(totalGb),
    note:
      `Three brains for ${capacity}: ${fast.label} answers straight away, ` +
      `${think.label} thinks the harder questions through, and ${code.label} is the code specialist. ` +
      `${formatTotalGb(totalGb)} in total.` +
      // Without a card they run on the processor: honest about what that means.
      (hardware.gpuMemoryGb > 0
        ? ''
        : ' They run on the processor, so the small one is instant and the other two take a few seconds a sentence.'),
  };
}

// Spoken names people use, mapped to the Start-menu entries they mean.
const APP_SPOKEN_NAMES = [
  [/^(browser|internet|browseren)$/i, ['Google Chrome', 'Microsoft Edge', 'Firefox']],
  [/^(files|file explorer|explorer|stifinder)$/i, ['File Explorer']],
  [/^(terminal|cmd|command prompt|powershell|konsol)$/i, ['Terminal', 'Windows PowerShell']],
  [/^(task manager|aktivitetsstyring)$/i, ['Task Manager']],
  [/^(calculator|calc|regnebræt|regner)$/i, ['Calculator']],
  [/^(vs ?code|visual studio code|kode)$/i, ['Visual Studio Code']],
  [/^(store|microsoft store)$/i, ['Microsoft Store']],
  [/^(music|musik|spotify)$/i, ['Spotify']],
  [/^(steam)$/i, ['Steam']],
  [/^(notepad|notes|notesblok)$/i, ['Notepad']],
  [/^(paint)$/i, ['Paint']],
];

// Things Windows ships that are not always in the Start menu index.
const SYSTEM_APPS = [
  [/^(calculator|calc|regnebræt|regner|udregner)$/i, 'calc.exe', 'Calculator'],
  [/^(notepad|notes|notesblok)$/i, 'notepad.exe', 'Notepad'],
  [/^(paint|mspaint)$/i, 'mspaint.exe', 'Paint'],
  [/^(file explorer|explorer|files|stifinder)$/i, 'explorer.exe', 'File Explorer'],
  [/^(command prompt|cmd|kommandoprompt)$/i, 'cmd.exe', 'Command Prompt'],
  [/^(powershell|terminal|windows terminal)$/i, 'wt.exe', 'Terminal'],
  [/^(task manager|aktivitetsstyring)$/i, 'taskmgr.exe', 'Task Manager'],
  [/^(control panel|kontrolpanel)$/i, 'control.exe', 'Control Panel'],
  [/^(snipping tool|klippeværktøj)$/i, 'snippingtool.exe', 'Snipping Tool'],
  [/^(device manager|enhedshåndtering)$/i, 'devmgmt.msc', 'Device Manager'],
  [/^(services|tjenester)$/i, 'services.msc', 'Services'],
  [/^(event viewer|hændelseslog)$/i, 'eventvwr.msc', 'Event Viewer'],
  [/^(disk cleanup|diskoprydning)$/i, 'cleanmgr.exe', 'Disk Cleanup'],
  [/^(resource monitor|ressourcestyring)$/i, 'resmon.exe', 'Resource Monitor'],
  [/^(system information|systemoplysninger)$/i, 'msinfo32.exe', 'System Information'],
  [/^(registry editor|regedit|registreringsdatabasen)$/i, 'regedit.exe', 'Registry Editor'],
];

// Apps Windows opens by protocol rather than by executable. They are what a person
// means by "open the camera" or "open settings", and none of them live in the
// Start menu index.
const SHELL_URIS = [
  [/^(settings|indstillinger|windows settings)$/i, 'ms-settings:', 'Settings'],
  [/^(camera|kamera)$/i, 'microsoft.windows.camera:', 'Camera'],
  [/^(photos|billeder)$/i, 'ms-photos:', 'Photos'],
  [/^(clock|ur|alarm|alarmer)$/i, 'ms-clock:', 'Clock'],
  [/^(mail|e-mail|post)$/i, 'outlookmail:', 'Mail'],
  [/^(calendar|kalender)$/i, 'outlookcal:', 'Calendar'],
  [/^(xbox)$/i, 'xbox:', 'Xbox'],
  [/^(phone link|phone|telefon)$/i, 'ms-phone:', 'Phone Link'],
  [/^(weather|vejr)$/i, 'bingweather:', 'Weather'],
  [/^(screenshot|screen clip|skærmbillede)$/i, 'ms-screenclip:', 'Snipping Tool'],
];

const ASSISTANT_SITES = [
  [/^(youtube)$/i, 'https://www.youtube.com', 'YouTube'],
  [/^(google)$/i, 'https://www.google.com', 'Google'],
  [/^(github)$/i, 'https://github.com', 'GitHub'],
  [/^(gmail|mail|email)$/i, 'https://mail.google.com', 'Gmail'],
  [/^(reddit)$/i, 'https://www.reddit.com', 'Reddit'],
  [/^(twitch)$/i, 'https://www.twitch.tv', 'Twitch'],
  [/^(chatgpt)$/i, 'https://chat.openai.com', 'ChatGPT'],
  [/^(maps|google maps)$/i, 'https://maps.google.com', 'Google Maps'],
  [/^(spotify)$/i, 'https://open.spotify.com', 'Spotify'],
  [/^(netflix)$/i, 'https://www.netflix.com', 'Netflix'],
  [/^(wikipedia)$/i, 'https://en.wikipedia.org', 'Wikipedia'],
  [/^(stack overflow|stackoverflow)$/i, 'https://stackoverflow.com', 'Stack Overflow'],
  [/^(amazon)$/i, 'https://www.amazon.com', 'Amazon'],
  [/^(discord)$/i, 'https://discord.com/app', 'Discord'],
];

// Browsers are often missing from the Start menu — Brave ships as a portable
// install and Edge hides in a folder Windows does not index — so they are
// looked for where they actually live.
const BROWSER_APPS = [
  [
    /^(brave|brave browser|rave|bravebrowser)$/i,
    'Brave',
    [
      '%ProgramFiles%\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
      '%ProgramFiles(x86)%\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
      '%LOCALAPPDATA%\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
    ],
  ],
  [
    /^(chrome|google chrome|krom)$/i,
    'Chrome',
    [
      '%ProgramFiles%\\Google\\Chrome\\Application\\chrome.exe',
      '%ProgramFiles(x86)%\\Google\\Chrome\\Application\\chrome.exe',
      '%LOCALAPPDATA%\\Google\\Chrome\\Application\\chrome.exe',
    ],
  ],
  [
    /^(edge|microsoft edge)$/i,
    'Edge',
    [
      '%ProgramFiles(x86)%\\Microsoft\\Edge\\Application\\msedge.exe',
      '%ProgramFiles%\\Microsoft\\Edge\\Application\\msedge.exe',
    ],
  ],
  [
    /^(firefox|mozilla firefox)$/i,
    'Firefox',
    [
      '%ProgramFiles%\\Mozilla Firefox\\firefox.exe',
      '%ProgramFiles(x86)%\\Mozilla Firefox\\firefox.exe',
      '%LOCALAPPDATA%\\Mozilla Firefox\\firefox.exe',
    ],
  ],
];

function expandEnv(value) {
  return String(value || '').replace(/%([^%]+)%/g, (_match, name) => process.env[name] || '');
}

function findBrowser(asked) {
  const wanted = normaliseName(asked);
  const entry = BROWSER_APPS.find(([pattern]) => pattern.test(wanted));
  if (!entry) return null;
  for (const candidate of entry[2]) {
    const resolved = expandEnv(candidate);
    try {
      if (resolved && fs.existsSync(resolved)) return { exe: resolved, name: entry[1] };
    } catch {
      /* try the next place */
    }
  }
  return null;
}

const normaliseName = (value) =>
  String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9 æøå]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

async function findAppByName(rawName) {
  const wanted = String(rawName || '').trim();
  if (!wanted) return null;
  const rows = await buildAppIndex();
  const candidates = [];
  for (const [pattern, names] of APP_SPOKEN_NAMES) {
    if (pattern.test(wanted)) candidates.push(...names);
  }
  candidates.push(wanted);
  for (const name of candidates) {
    const key = normaliseName(name);
    if (!key) continue;
    let best = null;
    let bestScore = 0;
    for (const row of rows) {
      const rowKey = normaliseName(row.name);
      if (!rowKey) continue;
      let score = 0;
      if (rowKey === key) score = 100;
      else if (rowKey.startsWith(key)) score = 80 - Math.min(20, rowKey.length - key.length);
      else if (rowKey.includes(key)) score = 55;
      else if (key.includes(rowKey) && rowKey.length > 3) score = 40;
      if (score > bestScore) {
        bestScore = score;
        best = row;
      }
    }
    if (best && bestScore >= 40) return best;
  }
  return null;
}

// "hey jarvis, open spotify" -> actually does it, and hands back what to say.
// An order sounds the same with or without the manners, so they come off before
// it is matched: "could you open brave for me" is "open brave".
function cleanOrder(rawText) {
  return String(rawText || '')
    .replace(/^\s*(?:hey|hi|ok|okay|hej|hallo)?[\s,]*jarvis[\s,.:!-]*/i, '')
    .replace(/^\s*(?:can|could|would|will)\s+you\s+(?:please\s+|kindly\s+)?/i, '')
    .replace(/^\s*(?:i\s+(?:want|need)\s+you\s+to\s+)/i, '')
    .replace(/^\s*(?:please|kindly|venligst)\s+/i, '')
    .replace(/\s+(?:for\s+me|please|now|tak)\s*[.!?]*$/i, '')
    .trim();
}

// A Danish order deserves a Danish answer: the replies below follow the language
// the order was given in (or the chosen language, when one is forced).
let answerDanish = false;
const sayBoth = (english, danish) => (answerDanish ? danish : english);
const settingsInDanish = () => assistantSettings().language === 'da';

// Launching something is shared between "open brave" and "open google": both
// may be an app, a browser, a site or a bare domain, in that order of certainty.
async function openSomething(rawAsked) {
  const asked = String(rawAsked || '')
    .replace(/\s+(?:app|program|programmet)$/i, '')
    .trim();
  if (!asked) return '';
  // "calculator and open notepad" is two orders; matching it against the app
  // index would only produce a confident answer to the wrong question.
  if (/\b(?:and|then|og)\s+(?:open|launch|start|run|play|search|google|look)\b/i.test(asked)) return '';
  const uri = SHELL_URIS.find(([pattern]) => pattern.test(asked));
  if (uri) {
    shell.openExternal(uri[1]);
    return sayBoth(`Opening ${uri[2]}.`, `Åbner ${uri[2]}.`);
  }
  // A full path — a folder, a document, a game that no launcher lists — is opened
  // with the program Windows would use, instead of being sent to the Start index.
  const localPath = expandEnv(asked.replace(/^["']|["']$/g, ''));
  if (/^[a-z]:\\/i.test(localPath) || localPath.startsWith('\\\\')) {
    if (fs.existsSync(localPath)) {
      const failure = await shell.openPath(localPath);
      if (!failure) return sayBoth('Opening it.', 'Åbner den.');
    }
  }
  const browser = findBrowser(asked);
  if (browser) {
    try {
      execFile(browser.exe, [], { windowsHide: true }, () => {});
      return sayBoth(`Opening ${browser.name}.`, `Åbner ${browser.name}.`);
    } catch {
      /* fall through to the index */
    }
  }
  const system = SYSTEM_APPS.find(([pattern]) => pattern.test(asked));
  if (system) {
    try {
      execFile(system[1], [], { windowsHide: true }, () => {});
      return sayBoth(`Opening ${system[2]}.`, `Åbner ${system[2]}.`);
    } catch {
      /* fall through to the index */
    }
  }
  const found = await findAppByName(asked);
  if (found && launchTarget(found.target).ok) {
    const name = String(found.name).replace(/\.lnk$/i, '');
    return sayBoth(`Opening ${name}.`, `Åbner ${name}.`);
  }
  const site = ASSISTANT_SITES.find(([pattern]) => pattern.test(asked));
  if (site) {
    shell.openExternal(site[1]);
    return sayBoth(`Opening ${site[2]}.`, `Åbner ${site[2]}.`);
  }
  if (/^https?:\/\/\S+$/i.test(asked)) {
    shell.openExternal(asked);
    return sayBoth(`Opening ${asked}.`, `Åbner ${asked}.`);
  }
  if (/^[\w-]+(\.[\w-]+)+$/.test(asked)) {
    shell.openExternal(`https://${asked}`);
    return sayBoth(`Opening ${asked}.`, `Åbner ${asked}.`);
  }
  return '';
}

// ------------------------------------------------------------ driving Notch

// Jarvis works this app the way it works the rest of the machine: an order in,
// the app changed, one short line back. Every pattern below starts with a verb,
// because this runs on every message — "what is liquid glass" has to stay a
// question and not repaint the panel.
const ACCENT_WORDS = new Map([
  ['blue', '#7c9cff'],
  ['indigo', '#7c9cff'],
  ['blå', '#7c9cff'],
  ['bla', '#7c9cff'],
  ['lilac', '#bf8cff'],
  ['purple', '#bf8cff'],
  ['violet', '#bf8cff'],
  ['lilla', '#bf8cff'],
  ['green', '#6fe3b0'],
  ['mint', '#6fe3b0'],
  ['teal', '#6fe3b0'],
  ['grøn', '#6fe3b0'],
  ['gron', '#6fe3b0'],
  ['pink', '#ff8fb8'],
  ['rose', '#ff8fb8'],
  ['rosa', '#ff8fb8'],
  ['orange', '#ffb86b'],
  ['amber', '#ffb86b'],
  ['gold', '#ffb86b'],
]);

const NOTCH_IMPERATIVE =
  /^(?:please\s+|venligst\s+)?(?:set|make|turn|switch|put|use|enable|disable|change|show|hide|start|stop|open|close|quit|exit|rescan|scan|give|launch|play|sæt|gør|slå|skift|vis|skjul|åbn|luk|giv|start|spil)\b/i;

// "taskbar on" and "glow off" are orders too, noun first, which the verb test
// above would throw out as a question.
const NOTCH_NOUN_SWITCH =
  /^(?:the\s+)?(?:taskbar|glow|grain|overlay|animations|notch)\s+(?:on|off|auto-?hide|auto hide)\b/i;

function wantsOff(text) {
  return /\b(?:off|disable|disabled|no|stop|hide|hidden|without|fra|sluk|skjul|nej)\b/i.test(text);
}

// The panel is not the launcher: it opens on its own message, and a page inside
// it one beat later, once the panel has actually painted.
function showNotchPanel(kind) {
  if (!win || win.isDestroyed() || gameMode) return false;
  // Unfold from the middle of the screen even if the window was nudged since it
  // was last placed, then paint the unfold instead of leaving it to a stale frame.
  recenterNotch(0);
  win.webContents.send('notch:open');
  repaintShell(60);
  setTimeout(
    () => {
      if (!win || win.isDestroyed()) return;
      win.webContents.send('notch:view', kind || 'panel');
      // The page inside is built after the panel has moved: the frame that first
      // shows it is asked for once it exists, and again after the sheet has
      // finished sliding in.
      repaintShell(40);
      repaintShell(420);
    },
    kind ? 320 : 0,
  );
  return true;
}

// The tray is the shortest way to ask: the check runs and the panel opens on the
// row that answers it, so the answer is on screen rather than in a log.
async function openUpdateSettings() {
  if (!showNotchPanel('settings')) return;
  const result = await checkForUpdates();
  globalThis.__rebuildTray?.();
  return result;
}

function tellPanelFocus(action) {
  if (win && !win.isDestroyed()) win.webContents.send('notch:focus-action', action);
}

async function runNotchAction(raw) {
  const text = String(raw || '').trim().replace(/^notch[\s:,]+/i, '');
  if (!text) return '';
  const low = text.toLowerCase();
  const yes = sayBoth;

  // A question is answered with a fact, never with a change.
  if (/^how many games\b/.test(low)) {
    return games.length
      ? yes(`You have ${games.length} games in the library.`, `Du har ${games.length} spil i biblioteket.`)
      : yes('The library is empty.', 'Biblioteket er tomt.');
  }

  if (!NOTCH_IMPERATIVE.test(text) && !NOTCH_NOUN_SWITCH.test(text)) return '';

  // A page of the panel.
  const view = low.match(
    /^(?:open|show|vis|åbn)\s+(?:the\s+|my\s+|min\s+|mit\s+)?(panel|notch|library|games|spil|settings|indstillinger|focus|clipboard|udklipsholder|launcher|start menu)\b/,
  );
  if (view) {
    const word = view[1];
    const kind =
      {
        library: 'library',
        games: 'library',
        spil: 'library',
        focus: 'focus',
        clipboard: 'clip',
        udklipsholder: 'clip',
        settings: 'settings',
        indstillinger: 'settings',
      }[word] || '';
    if (!showNotchPanel(kind)) {
      return yes('A game has the screen; the panel is standing down.', 'Et spil har skærmen; panelet holder sig væk.');
    }
    const en = { library: 'library', focus: 'focus timer', clip: 'clipboard', settings: 'settings' }[kind] || 'panel';
    const da = { library: 'biblioteket', focus: 'fokus-timeren', clip: 'udklipsholderen', settings: 'indstillingerne' }[kind] || 'panelet';
    return yes(`Opening the ${en}.`, `Åbner ${da}.`);
  }

  // Accent: "make it mint", "set the accent to pink", "sæt farven til grøn".
  const accent =
    low.match(/\b(?:accent|colour|color|farve)\b(?:\s+(?:to|til|as|is))?\s+([a-zæøå]+)/) ||
    low.match(/^make it\s+([a-zæøå]+)$/);
  if (accent && ACCENT_WORDS.has(accent[1])) {
    applySettingsPatch({ accent: ACCENT_WORDS.get(accent[1]) });
    return yes(`Accent set to ${accent[1]}.`, `Farven er nu ${accent[1]}.`);
  }

  // Surface, as long as the order is not about the taskbar's own surface.
  if (!/\btaskbar\b/.test(low)) {
    if (/\b(?:frosted|frost|matte)\b/.test(low) && /\b(?:glass|surface|material|panel|look)\b/.test(low)) {
      applySettingsPatch({ material: 'frost' });
      return yes('Frosted glass.', 'Mat glas.');
    }
    if (/\b(?:black|solid|opaque)\b/.test(low) && /\b(?:glass|surface|material|panel|look)\b/.test(low)) {
      applySettingsPatch({ material: 'black' });
      return yes('Black surface.', 'Sort overflade.');
    }
    if (/\bliquid\b/.test(low) && /\b(?:glass|surface|material|panel|look)\b/.test(low)) {
      applySettingsPatch({ material: 'liquid' });
      return yes('Liquid glass it is.', 'Liquid glass, som det skal være.');
    }
  }

  // Numbers: tint, blur, animation speed, pill width, hover delay.
  const range = (pattern, key, min, max, label) => {
    const match = low.match(pattern);
    if (!match) return '';
    const value = Math.max(min, Math.min(max, Number(match[1])));
    applySettingsPatch({ [key]: value });
    return yes(`${label} at ${value}.`, `${label} på ${value}.`);
  };
  const numbered =
    range(/\btint\b[^0-9]{0,16}(\d{1,3})/, 'tint', 0, 100, 'Tint') ||
    range(/\bblur\b[^0-9]{0,16}(\d{1,3})/, 'blur', 0, 100, 'Blur') ||
    range(/\b(?:motion|animation speed|speed|hastighed)\b[^0-9]{0,20}(\d{1,3})/, 'motion', 50, 150, 'Animation') ||
    range(/\b(?:pill width|pillen|width)\b[^0-9]{0,20}(\d{1,3})/, 'pillWidth', 72, 160, 'Pill width') ||
    range(/\bhover delay\b[^0-9]{0,20}(\d{1,3})/, 'hoverDelay', 0, 400, 'Hover delay');
  if (numbered) return numbered;

  // Switches: "turn the taskbar on", "hide glow", "slå taskbaren til".
  const toggle = (pattern, key, on, off) => {
    if (!pattern.test(low)) return '';
    // "auto-hide" holds the word "hide" and would read as turning it off.
    const value = !wantsOff(low.replace(/auto[\s-]?hide/g, 'auto'));
    applySettingsPatch({ [key]: value });
    return value ? on : off;
  };
  const flipped =
    toggle(/\bauto.?hide\b/, 'taskbarAutoHide', yes('Taskbar auto-hides.', 'Joblinjen skjuler sig selv.'), yes('Taskbar stays out.', 'Joblinjen bliver fremme.')) ||
    toggle(/\btaskbar\b|joblinje/, 'taskbar', yes('Taskbar on.', 'Joblinje til.'), yes('Taskbar off.', 'Joblinje fra.')) ||
    toggle(/\bglow\b|glød/, 'glow', yes('Glow on.', 'Glød til.'), yes('Glow off.', 'Glød fra.')) ||
    toggle(/\bgrain\b|\bnoise\b|korn/, 'grain', yes('Grain on.', 'Korn til.'), yes('Grain off.', 'Korn fra.')) ||
    toggle(/\bwindows key\b|\bwin key\b|\bstart menu key\b/, 'windowsKey', yes('The Windows key opens Notch.', 'Windows-tasten åbner Notch.'), yes('The Windows key is yours again.', 'Windows-tasten er din igen.'));
  if (flipped) return flipped;

  // Animations: Windows' setting, or always on.
  if (/\banimat/.test(low)) {
    if (/\balways\b/.test(low)) {
      applySettingsPatch({ animations: 'always' });
      return yes('Animations always play.', 'Animationer kører altid.');
    }
    if (/\b(?:windows|system)\b/.test(low)) {
      applySettingsPatch({ animations: 'system' });
      return yes('Animations follow Windows.', 'Animationer følger Windows.');
    }
  }

  // Shape of the notch itself.
  if (/\bisland\b|\bø-form\b/.test(low)) {
    applySettingsPatch({ notchStyle: 'island' });
    return yes('Island shape.', 'Ø-form.');
  }
  if (/\battach/.test(low) && /\b(?:notch|shape|pill)\b/.test(low)) {
    applySettingsPatch({ notchStyle: 'attached' });
    return yes('Attached to the top edge.', 'Hæftet til overkanten.');
  }

  // Where the glass takes its picture from.
  if (/\b(?:backdrop|glass source)\b/.test(low)) {
    if (/\bwallpaper\b/.test(low)) {
      applySettingsPatch({ backdrop: 'wallpaper' });
      return yes('The glass samples the wallpaper.', 'Glasset bruger tapetet.');
    }
    if (/\b(?:live|desktop)\b/.test(low)) {
      applySettingsPatch({ backdrop: 'live' });
      return yes('The glass follows the desktop.', 'Glasset følger skrivebordet.');
    }
  }

  // The performance overlay, which is a widget in two sizes.
  if (/\boverlay\b|\bfps\b/.test(low)) {
    const up = !!widgetsFor('perf');
    const want = !wantsOff(low) && !/\b(?:close|hide|luk|skjul)\b/.test(low);
    if (up !== want) togglePerformanceOverlay();
    return want ? yes('Overlay up.', 'Overlay fremme.') : yes('Overlay away.', 'Overlay væk.');
  }

  // The focus timer: "focus for 25 minutes", "stop the focus timer".
  if (/\b(?:focus|pomodoro|fokus)\b/.test(low)) {
    if (/\b(?:stop|pause|end|cancel|slut|pause)\b/.test(low)) {
      tellPanelFocus('pause');
      return yes('Focus paused.', 'Fokus sat på pause.');
    }
    if (/\b(?:reset|clear|nulstil)\b/.test(low)) {
      tellPanelFocus('reset');
      return yes('Focus reset.', 'Fokus nulstillet.');
    }
    const minutes = low.match(/(\d{1,3})\s*(?:min|minutes|minutter)/);
    const span = minutes ? Math.max(1, Math.min(180, Number(minutes[1]))) : 25;
    tellPanelFocus(`minutes:${span}`);
    tellPanelFocus('start');
    return yes(`Focusing for ${span} minutes.`, `Fokus i ${span} minutter.`);
  }

  // The library: rescan it, or launch something by name.
  if (/\brescan\b|\bscan (?:my |the )?(?:library|games)\b/.test(low)) {
    const list = rescanGames();
    resolveIcons();
    if (win && !win.isDestroyed()) win.webContents.send('notch:games', list);
    return yes(`Rescanned: ${list.length} games.`, `Gennemsøgt: ${list.length} spil.`);
  }
  const wantGame = low.match(/^(?:launch|start|play|spil)\s+(?:the\s+)?(?:game\s+)?(.+?)[.!?]*$/);
  if (wantGame) {
    const name = wantGame[1].trim();
    const game =
      games.find((entry) => entry.name.toLowerCase() === name) ||
      games.find((entry) => entry.name.toLowerCase().includes(name));
    // Nothing by that name is a song or a video, which the next order handles.
    if (game) {
      const result = await launchGameRecord(game);
      if (result.ok) return yes(`Launching ${game.name}.`, `Starter ${game.name}.`);
      return yes(`${game.name} would not start.`, `${game.name} ville ikke starte.`);
    }
  }

  // The store the library's bag opens, which is drawn in the panel itself.
  if (!/microsoft/.test(low) && /\bsteamdb\b|\bsteam db\b|\bdeals\b|\bstore\b|\bbutik\b/.test(low)) {
    if (!showNotchPanel('store')) {
      return yes('A game has the screen; the store is standing down.', 'Et spil har skærmen; butikken holder sig væk.');
    }
    return yes('Opening the store.', 'Åbner butikken.');
  }

  // Starting with Windows, without opening the menu for it.
  if (/\b(?:start with windows|at login|open at login|login item|ved logon)\b/.test(low)) {
    prefs.login = !wantsOff(low);
    savePrefs();
    applyLogin();
    return prefs.login
      ? yes('Notch will start with Windows.', 'Notch starter med Windows.')
      : yes('Notch will not start with Windows.', 'Notch starter ikke med Windows.');
  }

  if (/^(?:quit|exit|close)\s+(?:notch|yourself|the app)\b/.test(low) || /^(?:quit|shut down)$/.test(low)) {
    // A beat for the reply to be spoken, then the app it lives in goes away.
    setTimeout(() => app.quit(), 1600);
    return yes('Shutting Notch down.', 'Lukker Notch ned.');
  }

  return '';
}

// ------------------------------------------------------------ files on disk

// Where a file the user did not place goes: the Desktop, because that is where
// a person looks for the thing they just asked for.
function desktopPath() {
  try {
    const desktop = app.getPath('desktop');
    if (desktop && fs.existsSync(desktop)) return desktop;
  } catch {
    /* no desktop on this system */
  }
  try {
    return app.getPath('home');
  } catch {
    return process.cwd();
  }
}

const PLACE_FOLDERS = [
  [/^(?:the\s+|my\s+|min\s+|mit\s+)?(?:desktop|skrivebord)\b/i, () => desktopPath()],
  [/^(?:the\s+|my\s+)?(?:documents?|dokumenter)\b/i, () => app.getPath('documents')],
  [/^(?:the\s+|my\s+)?downloads?\b/i, () => app.getPath('downloads')],
  [/^(?:the\s+|my\s+)?(?:pictures?|billeder)\b/i, () => app.getPath('pictures')],
  [/^(?:the\s+|my\s+)?(?:videos?|videoer)\b/i, () => app.getPath('videos')],
  [/^(?:home|hjem|profile|brugerprofil)\b/i, () => app.getPath('home')],
];

function placeFolder(place) {
  for (const [pattern, get] of PLACE_FOLDERS) {
    if (!pattern.test(place)) continue;
    try {
      return get() || '';
    } catch {
      return '';
    }
  }
  return '';
}

// "notes.txt on the desktop", "projects/hello.py in documents" — the place at
// the end of the order becomes the folder the name is relative to.
const PLACE_WORDS =
  '(desktop|skrivebord|documents?|dokumenter|downloads?|pictures?|billeder|videos?|videoer|home|hjem)';

function splitPlace(raw) {
  const text = String(raw || '').trim();
  const match = text.match(
    new RegExp(`^(.*?)\\s+(?:in|into|on|inside|i|på|inde i)\\s+(?:the\\s+|my\\s+|min\\s+|mit\\s+)?${PLACE_WORDS}\\s*$`, 'i'),
  );
  if (match) return { name: match[1].trim(), base: placeFolder(match[2]) };
  return { name: text, base: '' };
}

// A name is a name, not a route out of the folder: a subfolder is welcome
// (projects/app.py), `..` and the characters Windows cannot store are not.
function resolveTarget(raw, fallbackName = '') {
  let { name, base } = splitPlace(raw);
  name = name
    .replace(/^[\s"'`“”]+|[\s"'`“”]+$/g, '')
    .replace(/[.!?]+$/, '')
    .trim();
  if (!name && fallbackName) name = fallbackName;
  if (!name) return '';
  const network = name.startsWith('\\\\');
  const drive = name.match(/^([a-zA-Z]):[\\/]/);
  const rooted = !network && !drive && name.startsWith('/');
  let rest = name;
  if (drive) rest = name.slice(drive[0].length);
  else if (network) rest = name.slice(2);
  else if (rooted) rest = name.slice(1);
  const parts = rest.split(/[\\/]+/).map((part) => part.trim());
  // A step up the tree would put the file anywhere on the disk, so it is not a
  // name. `.` and `..` are the only segments refused outright.
  if (!parts.length || parts.some((part) => /^\.+$/.test(part))) return '';
  const clean = parts
    .map((part) => part.replace(/[<>:"|?*\u0000-\u001f]/g, '').replace(/[. ]+$/g, '').trim())
    .filter(Boolean);
  if (!clean.length) return '';
  // An absolute path stays absolute, and is joined with its own Windows rules so
  // the answer does not depend on the system the code is running on.
  if (drive) return path.win32.join(`${drive[1]}:\\`, ...clean);
  if (network) return path.win32.join('\\\\', ...clean);
  if (rooted) return path.posix.join('/', ...clean);
  return path.join(base || desktopPath(), ...clean);
}

function displayPath(target) {
  try {
    const relative = path.relative(app.getPath('home'), target);
    if (relative && !relative.startsWith('..')) return relative;
  } catch {
    /* fall back to the full path */
  }
  return target;
}

function saveFileAt(raw, content, fallbackName = '') {
  const target = resolveTarget(raw, fallbackName);
  if (!target) return { ok: false, reason: 'no-name' };
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, String(content ?? ''), 'utf8');
    return { ok: true, path: target };
  } catch (error) {
    return { ok: false, reason: 'write', message: String((error && error.message) || error) };
  }
}

function makeFolderAt(raw) {
  const target = resolveTarget(raw);
  if (!target) return { ok: false, reason: 'no-name' };
  try {
    fs.mkdirSync(target, { recursive: true });
    return { ok: true, path: target };
  } catch (error) {
    return { ok: false, reason: 'write', message: String((error && error.message) || error) };
  }
}

// The code from a reply: the first fenced block when there is one, the whole
// answer otherwise. Tags the model wrote for the machine never reach the file.
function splitReplyCode(reply) {
  const text = String(reply || '');
  const fence = text.match(/```([\w+#.\-]*)[^\S\n]*\n([\s\S]*?)```/);
  if (fence) {
    return { language: String(fence[1] || '').toLowerCase(), code: `${fence[2].replace(/\s+$/, '')}\n` };
  }
  const bare = text.replace(/\[\[[^\]]*\]\]/g, '').trim();
  return { language: '', code: bare ? `${bare}\n` : '' };
}

const CODE_EXTENSIONS = {
  python: 'py',
  py: 'py',
  javascript: 'js',
  js: 'js',
  node: 'js',
  typescript: 'ts',
  ts: 'ts',
  html: 'html',
  css: 'css',
  json: 'json',
  sql: 'sql',
  bash: 'sh',
  sh: 'sh',
  shell: 'sh',
  powershell: 'ps1',
  ps1: 'ps1',
  csharp: 'cs',
  'c#': 'cs',
  cs: 'cs',
  cpp: 'cpp',
  'c++': 'cpp',
  c: 'c',
  java: 'java',
  go: 'go',
  golang: 'go',
  rust: 'rs',
  rs: 'rs',
  jsx: 'jsx',
  tsx: 'tsx',
  markdown: 'md',
  md: 'md',
};

const CODE_STOPWORDS = new Set([
  'write', 'create', 'make', 'build', 'generate', 'code', 'script', 'program', 'file', 'app',
  'application', 'a', 'an', 'the', 'me', 'please', 'that', 'which', 'for', 'to', 'in', 'with',
  'using', 'simple', 'small', 'basic', 'some', 'my', 'new', 'can', 'you', 'could', 'would',
  'lav', 'skriv', 'byg', 'en', 'et', 'der', 'som', 'til', 'med', 'og', 'jeg', 'gerne', 'python',
  'javascript', 'typescript', 'html', 'css', 'json', 'sql', 'bash', 'powershell', 'java', 'rust',
  'go', 'react', 'component', 'website', 'game', 'bot', 'scraper', 'api', 'function', 'class',
]);

function codeFileName(request, language) {
  const words = String(request || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/gi, ' ')
    .split(/\s+/)
    .filter((word) => word && word.length > 1 && !CODE_STOPWORDS.has(word))
    .slice(0, 4);
  const base = words.join('-').slice(0, 40) || 'notch-script';
  return `${base}.${CODE_EXTENSIONS[language] || 'txt'}`;
}

// "write me a python script that sorts a list" is a request for a file, so the
// code that comes back is saved instead of only being shown.
function isCodeRequest(text) {
  const value = String(text || '');
  if (/^\s*(?:what|how|why|hvad|hvordan|hvorfor)\b/i.test(value)) return false;
  return (
    /\b(?:write|create|make|build|generate|lav|skriv|byg|programmer)\b/i.test(value) &&
    /\b(?:script|program|code|app|function|class|python|javascript|typescript|html|css|json|sql|bash|powershell|c#|c\+\+|java|rust|golang|bot|scraper|api|website|game)\b/i.test(value)
  );
}

// Spoken orders about files need no model, so they never reach one: a folder is
// a folder whether or not Ollama is awake.
function directFileOrder(order) {
  const text = cleanOrder(order);
  if (!text) return null;
  answerDanish = settingsInDanish() || looksDanish(text);
  const folder = text.match(
    /^(?:create|make|new|add|opret|lav|ny)\s+(?:a\s+|an\s+|en\s+|et\s+)?(?:folder|directory|mappe)\s*(?:called|named|der\s+hedder|som\s+hedder|ved\s+navn)?\s*(.+?)[.!?]*$/i,
  );
  if (folder) {
    const result = makeFolderAt(folder[1]);
    if (!result.ok) return { handled: true, say: sayBoth('That folder could not be made.', 'Den mappe kunne ikke oprettes.') };
    return {
      handled: true,
      say: sayBoth(`Made the folder ${displayPath(result.path)}.`, `Oprettede mappen ${displayPath(result.path)}.`),
    };
  }
  const file = text.match(
    /^(?:create|make|new|write|save|opret|lav|skriv|gem)\s+(?:a\s+|an\s+|en\s+|et\s+)?(?:file|fil)\s*(?:called|named|der\s+hedder|som\s+hedder|ved\s+navn)?\s*(.+?)[.!?]*$/i,
  );
  if (file) {
    const [rawName, ...rest] = file[1].split(/\s+(?:with|containing|that\s+says|and\s+says|med|indeholdende|der\s+siger)\s+/i);
    const body = rest.join(' ');
    // A name is a few words, not a paragraph: anything longer is a request for
    // the model to write the file, and it gets the chance to.
    if (rawName.trim().split(/\s+/).length > 5) return null;
    const result = saveFileAt(rawName, body ? `${body.trim()}\n` : '');
    if (!result.ok) return { handled: true, say: sayBoth('That file could not be written.', 'Den fil kunne ikke skrives.') };
    return {
      handled: true,
      say: sayBoth(`Made ${displayPath(result.path)}.`, `Oprettede ${displayPath(result.path)}.`),
    };
  }
  return null;
}

// Anything the short commands do not name by hand is still reachable: an order
// that starts with "run" is handed to cmd as it was spoken, which is what makes
// "do anything on my PC" true instead of a list of fifteen apps.
function runCommand(command) {
  const line = String(command || '').trim();
  if (!line) return false;
  try {
    execFile('cmd', ['/c', line], { windowsHide: true, timeout: 60000 }, () => {});
    return true;
  } catch {
    return false;
  }
}

function sendKeys(code) {
  try {
    execFile(
      'powershell',
      [
        '-NoProfile',
        '-WindowStyle',
        'Hidden',
        '-Command',
        `(New-Object -ComObject WScript.Shell).SendKeys([char]${code})`,
      ],
      { windowsHide: true },
      () => {},
    );
    return true;
  } catch {
    return false;
  }
}

async function runAction(text) {
  const notch = await runNotchAction(text);
  if (notch) return { handled: true, say: notch };

  const runMatch = text.match(/^(?:run|execute|exec|kør)\s+(.+?)[.!?]*$/i);
  if (runMatch) {
    const line = runMatch[1].trim();
    if (runCommand(line)) return { handled: true, say: sayBoth(`Running ${line}.`, `Kører ${line}.`) };
    return { handled: true, say: sayBoth('That would not run.', 'Det kunne ikke køre.') };
  }

  if (/^(?:lock|lock (?:the )?(?:pc|computer|screen|windows)|lås(?: skærmen| computeren)?)[.!?]*$/i.test(text)) {
    // A beat for the line to be spoken before the screen goes dark.
    setTimeout(() => {
      execFile('rundll32.exe', ['user32.dll,LockWorkStation'], { windowsHide: true }, () => {});
    }, 1200);
    return { handled: true, say: sayBoth('Locking the machine.', 'Låser computeren.') };
  }

  if (/^(?:sleep|sleep (?:the )?(?:pc|computer)|sov(?: nu)?)[.!?]*$/i.test(text)) {
    setTimeout(() => {
      execFile('rundll32.exe', ['powrprof.dll,SetSuspendState', '0,1,0'], { windowsHide: true }, () => {});
    }, 1200);
    return { handled: true, say: sayBoth('Going to sleep.', 'Går i dvale.') };
  }

  if (/^(?:shut ?down|turn off (?:the )?(?:pc|computer)|sluk(?: computeren)?)[.!?]*$/i.test(text)) {
    execFile('shutdown', ['/s', '/t', '30'], { windowsHide: true }, () => {});
    return { handled: true, say: sayBoth('Shutting down in thirty seconds.', 'Slukker om tredive sekunder.') };
  }

  if (/^(?:restart|reboot|genstart)(?: (?:the )?(?:pc|computer))?[.!?]*$/i.test(text)) {
    execFile('shutdown', ['/r', '/t', '30'], { windowsHide: true }, () => {});
    return { handled: true, say: sayBoth('Restarting in thirty seconds.', 'Genstarter om tredive sekunder.') };
  }

  const volume = text.match(/^(?:volume|lydstyrke)\s+(up|op|down|ned|mute|lydløs)[.!?]*$/i);
  if (volume) {
    const direction = volume[1].toLowerCase();
    if (direction === 'mute' || direction === 'lydløs') {
      sendKeys(173);
      return { handled: true, say: sayBoth('Sound off.', 'Lyd fra.') };
    }
    const up = direction === 'up' || direction === 'op';
    sendKeys(up ? 175 : 174);
    if (up) sendKeys(175);
    return { handled: true, say: sayBoth(up ? 'Louder.' : 'Quieter.', up ? 'Højere.' : 'Lavere.') };
  }

  if (/^(?:screenshot|skærmbillede|capture the screen|tag et skærmbillede)[.!?]*$/i.test(text)) {
    shell.openExternal('ms-screenclip:');
    return { handled: true, say: sayBoth('The snipping tool is up.', 'Klippeværktøjet er fremme.') };
  }

  if (/^(?:what(?:'s| is) the time|what time is it|hvad er klokken|hvad er tiden)[?.!]*$/i.test(text)) {
    const now = new Date();
    const time = now.toLocaleTimeString(answerDanish ? 'da-DK' : 'en-GB', {
      hour: '2-digit',
      minute: '2-digit',
    });
    return { handled: true, say: sayBoth(`It is ${time}.`, `Klokken er ${time}.`) };
  }

  const openMatch = text.match(
    /^(?:please\s+)?(?:open|launch|start|run|åbn|vis)\s+(?:op\s+)?(?:the\s+|my\s+|min\s+|mit\s+|en\s+)?(.+?)[.!?]*$/i,
  );
  if (openMatch) {
    const said = await openSomething(openMatch[1]);
    // Nothing by that name: leave it unhandled so "open brave and google the
    // weather" can be split into the two orders it really is.
    if (said) return { handled: true, say: said };
    return { handled: false, missed: openMatch[1].trim() };
  }

  const searchMatch = text.match(
    /^(?:search|look up|google|søg(?:\s+efter)?)\s+(?:on\s+|på\s+)?(youtube|google|github|wikipedia)?\s*(?:for\s+|efter\s+)?(.+?)[.!?]*$/i,
  );
  if (searchMatch) {
    const where = String(searchMatch[1] || 'google').toLowerCase();
    const query = searchMatch[2].trim();
    const urls = {
      youtube: `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`,
      google: `https://www.google.com/search?q=${encodeURIComponent(query)}`,
      github: `https://github.com/search?q=${encodeURIComponent(query)}`,
      wikipedia: `https://en.wikipedia.org/w/index.php?search=${encodeURIComponent(query)}`,
    };
    shell.openExternal(urls[where] || urls.google);
    const label = where.charAt(0).toUpperCase() + where.slice(1);
    return {
      handled: true,
      say: sayBoth(`Searching ${label} for ${query}.`, `Søger på ${label} efter ${query}.`),
    };
  }

  const playMatch = text.match(/^(?:play|afspil|spil)\s+(.+?)[.!?]*$/i);
  if (playMatch) {
    const query = playMatch[1].trim();
    if (/^(music|musik|something|noget)$/i.test(query)) {
      shell.openExternal('https://open.spotify.com');
      return { handled: true, say: sayBoth('Opening Spotify.', 'Åbner Spotify.') };
    }
    shell.openExternal(`https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`);
    return { handled: true, say: sayBoth(`Playing ${query} on YouTube.`, `Spiller ${query} på YouTube.`) };
  }

  return { handled: false };
}

async function performAssistantAction(rawText, replyText = '') {
  const text = cleanOrder(rawText);
  if (!text) return { handled: false };
  answerDanish = settingsInDanish() || looksDanish(text);
  let missed = '';

  // The model ends a code reply with [[write: my_script.py]], and asks for a
  // folder with [[mkdir: my folder]]; the code it wants saved is the reply it
  // just wrote, so both are done here where that reply is still in hand.
  const saveOrder = text.match(/^save\s+(.+?)[.!?]*$/i);
  if (saveOrder) {
    const { language, code } = splitReplyCode(replyText);
    const result = saveFileAt(saveOrder[1], code, language ? codeFileName(saveOrder[1], language) : '');
    if (!result.ok) return { handled: true, say: sayBoth('That file could not be written.', 'Den fil kunne ikke skrives.') };
    return {
      handled: true,
      say: sayBoth(`Saved ${displayPath(result.path)}.`, `Gemt ${displayPath(result.path)}.`),
    };
  }

  const folderOrder = text.match(/^(?:folder|mkdir|make folder|new folder)\s+(.+?)[.!?]*$/i);
  if (folderOrder) {
    const result = makeFolderAt(folderOrder[1]);
    if (!result.ok) return { handled: true, say: sayBoth('That folder could not be made.', 'Den mappe kunne ikke oprettes.') };
    return {
      handled: true,
      say: sayBoth(`Made the folder ${displayPath(result.path)}.`, `Oprettede mappen ${displayPath(result.path)}.`),
    };
  }

  // "open brave and google the weather" is two orders in one breath, and a
  // person speaks them that way, so they are taken one at a time.
  const joined = /\b(?:and|then|og)\s+(?:open|launch|start|run|play|search|google|look)\b/i.test(text);
  if (joined) {
    const said = [];
    for (const part of text.split(/\s*(?:,|;|\band\b|\bthen\b|\bog\b)\s+/i).filter(Boolean)) {
      const result = await runAction(cleanOrder(part));
      if (result.handled) said.push(result.say || 'Done.');
      else if (result.missed) missed = result.missed;
    }
    if (said.length) return { handled: true, say: said.join(' ') };
  }

  const first = await runAction(text);
  if (first.handled) return first;
  if (first.missed) missed = first.missed;

  if (missed) {
    return {
      handled: true,
      say: sayBoth(
        `I could not find “${missed}” on this machine.`,
        `Jeg kunne ikke finde “${missed}” på denne computer.`,
      ),
    };
  }
  return { handled: false };
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

// --------------------------------------------------------------- first run

function wingetAvailable() {
  try {
    execFileSync('winget', ['--version'], { windowsHide: true, timeout: 10000, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

async function waitForOllama(limitMs = 45000) {
  const until = Date.now() + limitMs;
  while (Date.now() < until) {
    const status = await assistantStatus();
    if (status.running) return status;
    await new Promise((resolve) => setTimeout(resolve, 800));
  }
  return assistantStatus();
}

let installTask = null;

// One click gets a working assistant: winget installs Ollama into the user
// profile (no admin prompt), it is started, and the renderer then pulls the
// model this machine was sized for.
function installOllama(sender) {
  if (installTask) return installTask;
  const emit = (data) => sendTo(sender, 'assistant:install', data);
  const task = (async () => {
    if (findOllamaBinary()) {
      emit({ stage: 'start', message: 'Ollama is installed — starting it…' });
      startOllama();
      const status = await waitForOllama(20000);
      emit({ stage: 'ready', message: status.running ? 'Ollama is running.' : 'Ollama is not answering.' });
      return { ok: status.running, installed: true, already: true };
    }
    if (!wingetAvailable()) {
      emit({ stage: 'error', message: 'The Windows Package Manager is not available.' });
      return { ok: false, installed: false, reason: 'winget', url: 'https://ollama.com/download/windows' };
    }
    emit({ stage: 'install', message: 'Downloading Ollama…', pct: 2 });
    const code = await new Promise((resolve) => {
      let child;
      try {
        child = spawn(
          'winget',
          [
            'install',
            '--id',
            'Ollama.Ollama',
            '-e',
            '--silent',
            '--accept-package-agreements',
            '--accept-source-agreements',
            '--disable-interactivity',
          ],
          { windowsHide: true },
        );
      } catch {
        resolve(-1);
        return;
      }
      // winget redraws a progress bar with \r; only the percentage matters.
      const scan = (chunk) => {
        const match = /(\d{1,3})\s?%/.exec(String(chunk));
        if (match) emit({ stage: 'install', message: 'Downloading Ollama…', pct: Number(match[1]) });
      };
      child.stdout.on('data', scan);
      child.stderr.on('data', scan);
      child.on('error', () => resolve(-1));
      child.on('exit', (value) => resolve(value === null ? -1 : value));
    });
    const binary = findOllamaBinary();
    if (!binary && code !== 0) {
      emit({ stage: 'error', message: 'The installer did not finish.' });
      return { ok: false, installed: false, reason: 'installer', url: 'https://ollama.com/download/windows' };
    }
    emit({ stage: 'start', message: 'Installed — starting Ollama…', pct: 100 });
    startOllama();
    const status = await waitForOllama();
    emit({ stage: 'ready', message: status.running ? 'Ollama is running.' : 'Ollama is not answering yet.' });
    return { ok: status.running, installed: true, already: false };
  })();
  installTask = task.finally(() => {
    installTask = null;
  });
  return installTask;
}

ipcMain.handle('assistant:install', (event) => installOllama(event.sender));

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
      // The wake chime and spoken replies play while the window is hidden, so
      // audio must not wait for a click the user never made.
      autoplayPolicy: 'no-user-gesture-required',
      // The wake word is a timer that samples the microphone every tenth of a
      // second. Chromium throttles timers in a hidden window, and after a few
      // minutes on this PC it slowed them to once a minute — which is exactly
      // why "hey jarvis" almost never worked. This window must not be throttled.
      backgroundThrottling: false,
    },
  });
  jarvisWin.setMenu(null);
  protectSurface(jarvisWin);
  jarvisWin.loadFile(path.join(__dirname, 'src', 'assistant.html'));
  jarvisWin.on('hide', stopJarvisBackdrop);
  jarvisWin.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      jarvisWin.hide();
      stopJarvisBackdrop();
    }
  });
  jarvisWin.on('closed', () => {
    jarvisWin = null;
  });
  return jarvisWin;
}

// Jarvis wears the same lens as the notch, so it samples the desktop behind
// itself while it is on screen and stops the moment it hides.
let jarvisBackdropTimer = 0;

function stopJarvisBackdrop() {
  clearInterval(jarvisBackdropTimer);
  jarvisBackdropTimer = 0;
}

function startJarvisBackdrop(window) {
  stopJarvisBackdrop();
  if (!window || window.isDestroyed()) return;
  sendRegionShot(window, 'jarvis:backdrop');
  jarvisBackdropTimer = setInterval(() => {
    if (gameMode || !jarvisWin || jarvisWin.isDestroyed() || !jarvisWin.isVisible()) {
      stopJarvisBackdrop();
      return;
    }
    sendRegionShot(jarvisWin, 'jarvis:backdrop');
  }, 2600);
}

function showJarvis() {
  const window = createJarvis();
  if (!window) return;
  if (!window.isVisible()) window.setBounds(jarvisBounds());
  window.show();
  window.focus();
  startJarvisBackdrop(window);
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

// ---------------------------------------------------------------- neural voice

// Piper runs a small neural voice locally: a British male that sounds like a
// person instead of a screen reader, with nothing sent to a server. The binary
// and the voice live next to the app's data, and the process stays warm so a
// reply does not wait for the model to load.
// The voice travels inside the packaged app, so a fresh machine speaks without
// downloading anything; a copy in the data folder serves a dev checkout.
const PIPER_DIR = (() => {
  const bundled = path.join(process.resourcesPath || '', 'tts');
  try {
    if (app.isPackaged && fs.existsSync(path.join(bundled, 'piper', 'piper.exe'))) return bundled;
  } catch {
    /* fall through to the data folder */
  }
  return path.join(process.env.LOCALAPPDATA || app.getPath('userData'), 'notch', 'tts');
})();
const PIPER_BIN = path.join(PIPER_DIR, 'piper', 'piper.exe');

const NEURAL_VOICES = [
  {
    id: 'en_GB-alan-medium',
    label: 'Jarvis',
    note: 'British male · calm',
    file: 'en_GB-alan-medium.onnx',
    // Rendered a touch quicker than it is played back: the window drops the
    // pitch about a semitone on playback (see assistant.js), which is what gives
    // the voice its chest, and rendering 5% fast keeps the pace where it was.
    length: 0.78,
    // Less generator noise than the model's default: the shimmer on long vowels
    // is the main thing that makes a neural voice sound synthetic.
    noise: 0.45,
    noiseW: 0.65,
    // A breathing space between sentences, so a reply is not one run-on line.
    silence: 0.22,
  },
  {
    id: 'da_DK-talesyntese-medium',
    label: 'Jarvis · dansk',
    note: 'Dansk · rolig',
    file: 'da_DK-talesyntese-medium.onnx',
    lang: 'da',
    // Danish is spoken with rounder vowels and longer syllables than the model's
    // default gives it, so it is left slightly slower than the British voice.
    length: 0.94,
    noise: 0.5,
    noiseW: 0.7,
    silence: 0.24,
  },
];

// Danish can be recognised from its letters alone most of the time, and from its
// small words when a sentence happens to use none of them.
const DANISH_LETTERS = /[æøåÆØÅ]/;
const DANISH_WORDS =
  /\b(og|ikke|jeg|det|der|er|til|med|på|for|af|du|vi|kan|hvad|hvor|hvordan|hvorfor|gerne|tak|hej|nu|så|også|men|har|skal|vil|mig|dig|den|dette|klokken|vejret|åbn|åbne|spil|søg|dansk|godaften|godmorgen|godnat|hr)\b/gi;

function looksDanish(text) {
  const value = String(text || '');
  if (DANISH_LETTERS.test(value)) return true;
  const words = value.trim().split(/\s+/).filter(Boolean);
  if (words.length < 4) return false;
  const hits = (value.match(DANISH_WORDS) || []).length;
  return hits >= 2;
}

// The studio voice: a bigger neural reader that only makes sense with a real
// graphics card behind it. It is not used unless it is chosen, and the machine
// that suits it is offered it first.
const STUDIO_VOICES = [
  { id: 'bm_george', label: 'Jarvis · studio', note: 'British male · warm and unhurried' },
  { id: 'bm_lewis', label: 'Jarvis · studio deep', note: 'British male · low and deliberate' },
  { id: 'bm_fable', label: 'Jarvis · studio bright', note: 'British male · lighter, quicker' },
  { id: 'bf_emma', label: 'Jarvis · studio alto', note: 'British female · clear' },
];

const STUDIO_BUNDLE = () => path.join(__dirname, 'node_modules', 'kokoro-js', 'dist', 'kokoro.web.js');

function studioAvailable() {
  try {
    return fs.existsSync(STUDIO_BUNDLE());
  } catch {
    return false;
  }
}

// One process per language: the model is fixed when piper starts, and a reply in
// Danish cannot be read by the English voice.
const piperProcs = new Map();
let piperQueue = Promise.resolve();
let piperIdleTimer = 0;
let piperSeq = 0;
// The model itself only loads when the first line arrives, which costs a second
// or more; a throwaway line at startup pays that once, out of sight.
const piperWarmed = new Set();

function voiceById(id) {
  return NEURAL_VOICES.find((voice) => voice.id === id) || null;
}

function danishVoice() {
  return NEURAL_VOICES.find((voice) => voice.lang === 'da') || null;
}

function neuralVoice() {
  const wanted = assistantSettings().neuralVoice;
  return voiceById(wanted) || NEURAL_VOICES[0];
}

function voiceAvailable(voice) {
  try {
    return !!voice && fs.existsSync(PIPER_BIN) && fs.existsSync(path.join(PIPER_DIR, voice.file));
  } catch {
    return false;
  }
}

function neuralVoiceAvailable() {
  return voiceAvailable(neuralVoice());
}

// Danish text goes to the Danish voice even when the chosen voice is the British
// one: reading Danish with an English model is not an accent, it is nonsense.
function voiceForText(text, wantedId) {
  const wanted = wantedId ? voiceById(wantedId) : null;
  if (wanted && voiceAvailable(wanted)) return wanted;
  const chosen = neuralVoice();
  if (chosen && voiceAvailable(chosen) && (chosen.lang === 'da' || !looksDanish(text))) return chosen;
  const danish = danishVoice();
  if (looksDanish(text) && voiceAvailable(danish)) return danish;
  return chosen;
}

function stopPiper(id) {
  clearTimeout(piperIdleTimer);
  const keys = id ? [id] : [...piperProcs.keys()];
  for (const key of keys) {
    piperWarmed.delete(key);
    const child = piperProcs.get(key);
    piperProcs.delete(key);
    if (!child) continue;
    try {
      child.stdin.end();
      child.kill();
    } catch {
      /* already gone */
    }
  }
}

function piperProcess(voice) {
  if (!voice) return null;
  const running = piperProcs.get(voice.id);
  if (running && !running.killed) return running;
  if (!voiceAvailable(voice)) return null;
  try {
    const child = spawn(
      PIPER_BIN,
      [
        '--model',
        path.join(PIPER_DIR, voice.file),
        '--json-input',
        '--length_scale',
        String(voice.length || 1.04),
        '--noise_scale',
        String(voice.noise || 0.55),
        '--noise_w',
        String(voice.noiseW || 0.8),
        '--sentence_silence',
        String(voice.silence == null ? 0.2 : voice.silence),
      ],
      { cwd: PIPER_DIR, windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] },
    );
    child.stdin.on('error', () => {});
    child.on('error', () => {
      if (piperProcs.get(voice.id) === child) piperProcs.delete(voice.id);
    });
    child.on('exit', () => {
      if (piperProcs.get(voice.id) === child) piperProcs.delete(voice.id);
    });
    piperProcs.set(voice.id, child);
    return child;
  } catch {
    return null;
  }
}

function warmVoiceLine(voice, text) {
  if (!voice || piperWarmed.has(voice.id)) return;
  piperWarmed.add(voice.id);
  speakNeural(text, voice.id).catch(() => {});
}

// Warms the model in the background so the first spoken reply is not slow.
function warmPiper() {
  const voice = neuralVoice();
  if (!voiceAvailable(voice)) return;
  const child = piperProcess(voice);
  if (!child) return;
  clearTimeout(piperIdleTimer);
  piperIdleTimer = setTimeout(() => stopPiper(), 12 * 60 * 1000);
  warmVoiceLine(voice, 'Ready.');

  // The Danish model is loaded quietly a little later: the first Danish reply
  // should not be the slow one either, and nothing waits on it.
  const danish = danishVoice();
  if (danish && danish.id !== voice.id && voiceAvailable(danish)) {
    setTimeout(() => warmVoiceLine(danish, 'Klar.'), 8000);
  }
}

function speakNeural(text, voiceId) {
  const value = String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 900);
  if (!value) return Promise.resolve({ ok: false, reason: 'empty' });
  const voice = voiceForText(value, voiceId);
  const child = piperProcess(voice);
  if (!child) return Promise.resolve({ ok: false, reason: 'missing' });
  clearTimeout(piperIdleTimer);
  piperIdleTimer = setTimeout(() => stopPiper(), 12 * 60 * 1000);
  const file = path.join(os.tmpdir(), `notch-voice-${Date.now()}-${(piperSeq += 1)}.wav`);
  // One line at a time: piper answers in order, and the queue keeps the
  // filenames from colliding when two replies land together.
  piperQueue = piperQueue.then(
    () =>
      new Promise((resolve) => {
        const started = Date.now();
        try {
          child.stdin.write(`${JSON.stringify({ text: value, output_file: file })}\n`);
        } catch {
          resolve({ ok: false, reason: 'stdin' });
          return;
        }
        const tick = setInterval(() => {
          try {
            if (fs.existsSync(file) && fs.statSync(file).size > 800) {
              clearInterval(tick);
              resolve({ ok: true, file, url: `file:///${file.replace(/\\/g, '/')}`, voice: voice ? voice.id : '' });
              return;
            }
          } catch {
            /* file still being written */
          }
          if (Date.now() - started > 25000) {
            clearInterval(tick);
            resolve({ ok: false, reason: 'timeout' });
          }
        }, 40);
      }),
  );
  return piperQueue;
}

ipcMain.handle('assistant:speak-neural', async (_event, text, voiceId) => {
  const result = await speakNeural(text, voiceId);
  if (!result.ok) return result;
  return { ok: true, url: result.url, voice: result.voice };
});

ipcMain.handle('assistant:warm-voice', () => {
  warmPiper();
  return { ok: true };
});

// ------------------------------------------------------------------ voice HUD

// A small presence at the bottom of the screen: it appears the moment Jarvis
// hears its name, breathes with the microphone, and turns into a wave while it
// talks. Click-through, no focus, gone again when the moment is over.
// Square: the presence is a ring of light, not a strip of text.
const VOICE_HUD_W = 360;
const VOICE_HUD_H = 360;

let voiceHudWin = null;
let voiceHudTimer = 0;
let voiceHudState = { state: 'idle', level: 0 };

function voiceHudBounds() {
  const display = screen.getPrimaryDisplay();
  const width = Math.min(VOICE_HUD_W, display.workAreaSize.width - 40);
  const height = Math.min(VOICE_HUD_H, display.workAreaSize.height - 40);
  return {
    x: Math.round(display.workArea.x + (display.workAreaSize.width - width) / 2),
    y: Math.round(display.workArea.y + 24),
    width,
    height,
  };
}

function createVoiceHud() {
  if (voiceHudWin) return voiceHudWin;
  voiceHudWin = new BrowserWindow({
    ...voiceHudBounds(),
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
    title: 'Jarvis voice',
    webPreferences: {
      preload: path.join(__dirname, 'voicehud-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  voiceHudWin.setMenu(null);
  voiceHudWin.setAlwaysOnTop(true, 'screen-saver');
  voiceHudWin.setSkipTaskbar(true);
  voiceHudWin.setIgnoreMouseEvents(true, { forward: true });
  voiceHudWin.loadFile(path.join(__dirname, 'src', 'voicehud.html'));
  voiceHudWin.webContents.on('did-finish-load', () => {
    if (voiceHudWin) voiceHudWin.webContents.send('voicehud:state', voiceHudState);
  });
  voiceHudWin.on('closed', () => {
    voiceHudWin = null;
  });
  return voiceHudWin;
}

function hudWatchdog() {
  clearTimeout(voiceHudTimer);
  voiceHudTimer = setTimeout(() => {
    if (!voiceHudWin || voiceHudWin.isDestroyed()) return;
    voiceHudState = { state: 'idle', level: 0 };
    voiceHudWin.hide();
  }, 45000);
}

function showVoiceHud(state, level) {
  voiceHudState = { state, level };
  const hud = createVoiceHud();
  if (!hud.isVisible()) {
    hud.setBounds(voiceHudBounds());
    hud.showInactive();
  }
  if (!hud.webContents.isLoading()) hud.webContents.send('voicehud:state', voiceHudState);
  hudWatchdog();
}

function hideVoiceHud(delay = 0) {
  clearTimeout(voiceHudTimer);
  const shut = () => {
    voiceHudState = { state: 'idle', level: 0 };
    if (voiceHudWin && !voiceHudWin.isDestroyed()) {
      if (!voiceHudWin.webContents.isLoading()) voiceHudWin.webContents.send('voicehud:state', voiceHudState);
      setTimeout(() => {
        if (voiceHudWin && !voiceHudWin.isDestroyed()) voiceHudWin.hide();
      }, 260);
    }
  };
  if (delay > 0) voiceHudTimer = setTimeout(shut, delay);
  else shut();
}

ipcMain.on('voice:hud', (_event, payload) => {
  const state = String((payload && payload.state) || 'idle');
  if (state === 'idle') {
    hideVoiceHud(600);
    return;
  }
  showVoiceHud(state, 0);
});

ipcMain.on('voice:level', (_event, value) => {
  if (!voiceHudWin || voiceHudWin.isDestroyed() || !voiceHudWin.isVisible()) return;
  if (voiceHudState.state === 'idle') return;
  voiceHudState.level = Math.max(0, Math.min(1, Number(value) || 0));
  voiceHudWin.webContents.send('voicehud:level', voiceHudState.level);
  hudWatchdog();
});

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
  const hardware = detectHardware();
  const recommended = recommendModel(hardware);
  const free = recommendFreeModel(hardware);
  const plan = recommendPlan(hardware);
  // The three picks are tagged on their preset cards, so the model manager can
  // say which one answers, which one thinks and which one writes code.
  const planRoles = new Map(plan.picks.map((pick) => [pick.name, pick.role]));
  const settings = assistantSettings();
  // A card that can read the studio voice starts on it: it is the voice that
  // sounds recorded, and the light one is the fallback, not the point. Picking
  // another engine in Settings writes a choice, and that choice always wins.
  const chosen = (prefs.settings.assistant || {}).engine;
  if (hardware.tier === 'studio' && !chosen && studioAvailable()) settings.engine = 'studio';
  return {
    settings,
    status,
    voices: await listVoices(),
    presets: OLLAMA_PRESETS.map((preset) => ({
      ...preset,
      recommendedFree: preset.name === free.name,
      role: planRoles.get(preset.name) || '',
    })),
    hardware,
    recommended,
    free,
    plan,
    stt: recommendStt(hardware),
    neural: { available: neuralVoiceAvailable(), voices: NEURAL_VOICES.map(({ id, label, note }) => ({ id, label, note })) },
    studio: {
      available: studioAvailable(),
      recommended: hardware.tier === 'studio',
      voices: STUDIO_VOICES,
      note:
        hardware.tier === 'studio'
          ? `${hardware.gpu} is enough for the studio voice: it reads like a recording rather than a synthesiser.`
          : 'The studio voice needs a dedicated graphics card — on this machine it would take several seconds per sentence.',
    },
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
  const lastUser = [...messages].reverse().find((message) => message.role === 'user');
  const lastUserText = lastUser ? String(lastUser.content || '') : '';
  // A file or folder order is a disk call rather than a conversation: it is
  // done here and answered straight away, so it works even before a model has
  // been downloaded.
  const direct = directFileOrder(lastUserText);
  if (direct) {
    sendTo(event.sender, 'assistant:delta', direct.say);
    sendTo(event.sender, 'assistant:done', { text: direct.say, model: 'local' });
    return { ok: true };
  }
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
      // keep_alive holds the weights in video memory between orders, so the second
      // question does not pay for loading a 4.7 GB model again. A short answer is
      // capped rather than cut off: Jarvis speaks in two or three sentences, and a
      // model that is allowed to ramble costs the user a dozen seconds a reply.
      body: JSON.stringify({
        model,
        messages,
        stream: true,
        keep_alive: '30m',
        options: {
          temperature: 0.6,
          top_p: 0.9,
          num_ctx: 4096,
          num_predict: 320,
        },
      }),
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
    // A code request ends with the code in a file. The model may name one with
    // [[write: ...]] — the window saves that — and when it did not, the fenced
    // block is saved here under a name taken from the question.
    if (full && isCodeRequest(lastUserText) && !/\[\[\s*(?:write|save)\s*:/i.test(full)) {
      const { language, code } = splitReplyCode(full);
      const saved = /```/.test(full) && code.trim() ? saveFileAt(codeFileName(lastUserText, language), code) : null;
      if (saved && saved.ok) {
        const line = `\n\n${sayBoth(`Saved it as ${displayPath(saved.path)}.`, `Gemt som ${displayPath(saved.path)}.`)}`;
        full += line;
        sendTo(event.sender, 'assistant:delta', line);
      }
    }
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

// Loading the model is most of the wait before a first word. The window asks for
// this as soon as it opens, so the weights are already on the card when the user
// gives an order instead of being read from disk at that moment.
ipcMain.handle('assistant:warm', async () => {
  const model = String(assistantSettings().model || '').trim();
  if (!model) return { ok: false, reason: 'no-model' };
  try {
    const response = await fetch(ollamaEndpoint('/api/generate'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, prompt: '', keep_alive: '30m', options: { num_ctx: 4096 } }),
      signal: AbortSignal.timeout(120000),
    });
    return { ok: response.ok };
  } catch {
    return { ok: false, reason: 'offline' };
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

ipcMain.handle('assistant:settings', (_event, patch) => {
  const before = assistantSettings();
  const settings = setAssistantSettings(patch);
  // A different voice model cannot be swapped inside a running piper process.
  if (patch && patch.neuralVoice && patch.neuralVoice !== before.neuralVoice) stopPiper();
  if (patch && patch.language && patch.language !== before.language) warmPiper();
  // The wake word lives in the window, so turning it on has to bring the
  // window into existence (hidden) rather than wait for the hotkey.
  if (settings.wake && !jarvisWin) createJarvis();
  return settings;
});

ipcMain.handle('assistant:act', (_event, text, content) => performAssistantAction(text, content));

ipcMain.handle('assistant:hardware', () => {
  const hardware = detectHardware();
  return { hardware, recommended: recommendModel(hardware) };
});

ipcMain.handle('assistant:open', (_event, url) => {
  const target = String(url || '');
  if (!/^https:\/\/(ollama\.com|github\.com|huggingface\.co)\//.test(target)) return { ok: false };
  shell.openExternal(target);
  return { ok: true };
});

ipcMain.on('assistant:hide', () => {
  if (jarvisWin && !jarvisWin.isDestroyed()) jarvisWin.hide();
  stopJarvisBackdrop();
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
let hookReady = false;
let hookRetryTimer = null;
// When the sheet was put up. A blur in the first moment after that is Windows
// finishing its foreground handover, not the user clicking somewhere else.
let launcherShownAt = 0;
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

// The executable a shortcut points at, empty for anything else. A pin carries it
// so the bar can tell that the pin and the window it opened are the same app.
async function shortcutExecutable(target) {
  const file = String(target || '');
  if (!/\.lnk$/i.test(file)) return '';
  const infos = await readShortcutInfo([file]);
  const info = infos.get(file);
  return info ? String(info.target || '') : '';
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
    // The executable a shortcut points at, so a pin and the window it opens are
    // one button instead of two.
    exe: pin.exe || '',
  }));
}

function broadcastPinned() {
  if (launcherWin && !launcherWin.isDestroyed()) {
    launcherWin.webContents.send('launcher:pinned', pinnedEntries());
  }
  refreshTaskbar();
}

// The pin array is both what the bar shows and the order it shows it in, so
// pinning, unpinning and dragging all end here.
async function addPinnedApp(entry) {
  const id = String(entry?.id || entry?.target || '').trim();
  if (!id) return false;
  const pins = Array.isArray(prefs.pinned) ? prefs.pinned.slice() : [];
  if (pins.length >= 12) return false;
  const target = String(entry?.target || id);
  // The executable a shortcut points at, so a pin and the window it opens are
  // one button instead of two.
  const exe = entry?.exe || (await shortcutExecutable(target));
  // One pin per app, whichever side made it: pinning a window whose app the
  // launcher already pinned must not put a second button beside it.
  const key = (value) => String(value || '').replace(/\//g, '\\').toLowerCase();
  const idKey = key(id);
  const targetKey = key(target);
  const exeKey = key(exe);
  const known = pins.some(
    (pin) =>
      key(pin.id) === idKey ||
      key(pin.target) === targetKey ||
      (!!exeKey && key(pin.exe) === exeKey),
  );
  if (known) return false;
  pins.push({
    id,
    name: String(entry?.name || 'App').slice(0, 60),
    target,
    icon: entry?.icon || (await iconForTarget(target)),
    exe,
  });
  prefs.pinned = pins;
  savePrefs();
  broadcastPinned();
  return true;
}

function removePinnedApp(id) {
  const key = String(id || '');
  if (!key) return false;
  const pins = Array.isArray(prefs.pinned) ? prefs.pinned : [];
  const next = pins.filter((pin) => pin.id !== key);
  if (next.length === pins.length) return false;
  prefs.pinned = next;
  savePrefs();
  broadcastPinned();
  return true;
}

// A drag ends with the bar's pins in the order they were left in: the ids it
// names are put in that order and any pin it did not know about keeps the end.
function reorderPinnedApps(ids) {
  const order = Array.isArray(ids) ? ids.map(String) : [];
  if (!order.length) return false;
  const pins = Array.isArray(prefs.pinned) ? prefs.pinned.slice() : [];
  const byId = new Map(pins.map((pin) => [pin.id, pin]));
  const next = [];
  for (const id of order) {
    const pin = byId.get(id);
    if (!pin) continue;
    byId.delete(id);
    next.push(pin);
  }
  for (const pin of pins) if (byId.has(pin.id)) next.push(pin);
  const same = next.length === pins.length && next.every((pin, index) => pin === pins[index]);
  if (same) return false;
  prefs.pinned = next;
  savePrefs();
  broadcastPinned();
  return true;
}

// A bar with nothing pinned is only whatever happens to be open. The first run
// takes the handful of apps Windows starts with, out of the Start menu itself,
// so every pin is a real shortcut with its real icon.
let pinSeedRunning = false;
async function seedPinnedApps() {
  if (pinSeedRunning || prefs.pinsSeeded) return;
  if (Array.isArray(prefs.pinned) && prefs.pinned.length) {
    prefs.pinsSeeded = true;
    savePrefs();
    return;
  }
  pinSeedRunning = true;
  try {
    const rows = await buildAppIndex();
    const one = async (pattern) => {
      const row = rows.find((entry) => pattern.test(entry.name));
      if (!row) return null;
      return { id: row.id, name: row.name, target: row.target, icon: await iconForTarget(row.target) };
    };
    const picks = [];
    const browser = await one(/^(microsoft edge|google chrome|firefox|brave)$/i);
    if (browser) picks.push(browser);
    for (const pattern of [
      /^(windows )?terminal$/i,
      /^file explorer$/i,
      /^notepad$/i,
      /^settings$/i,
      /^paint$/i,
    ]) {
      if (picks.length >= 5) break;
      const pin = await one(pattern);
      if (pin && !picks.some((entry) => entry.name.toLowerCase() === pin.name.toLowerCase())) picks.push(pin);
    }
    // The executable behind each shortcut, so the pin merges with its own
    // window on the bar instead of standing beside it.
    const infos = await readShortcutInfo(picks.map((pin) => pin.target));
    for (const pin of picks) {
      const info = infos.get(pin.target);
      if (info && info.target) pin.exe = info.target;
    }
    if (picks.length) {
      prefs.pinned = picks.slice(0, 5);
      broadcastPinned();
    }
    prefs.pinsSeeded = true;
    savePrefs();
  } catch {
    /* no Start menu to read: the bar starts with no pins */
  } finally {
    pinSeedRunning = false;
  }
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
      // The sheet waits hidden between presses; a throttled renderer answers the
      // first keystroke late, so it is kept awake.
      backgroundThrottling: false,
    },
  });
  launcherWin.setMenu(null);
  launcherWin.setAlwaysOnTop(true, 'screen-saver');
  launcherWin.loadFile(path.join(__dirname, 'src', 'launcher.html'));
  launcherWin.webContents.on('did-finish-load', sendLauncherState);
  launcherWin.on('blur', () => {
    // The sheet used to vanish the instant it appeared when Windows handed the
    // foreground back late, which reads as the Windows key doing nothing at all.
    // Only a blur once the sheet has settled is the user clicking elsewhere.
    if (Date.now() - launcherShownAt < 350) return;
    if (launcherWin && launcherWin.isVisible()) hideLauncher();
  });
  launcherWin.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      hideLauncher();
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
  // The sheet is drawn into a window that spends its life hidden, and a
  // transparent window can hand back the frame it had before: ask for the whole
  // frame now, and once more after the sheet has dropped in, so the first press
  // cannot open an invisible sheet.
  if (typeof window.webContents.invalidate === 'function') window.webContents.invalidate();
  setTimeout(() => {
    if (!launcherWin || launcherWin.isDestroyed() || !launcherWin.isVisible()) return;
    if (typeof launcherWin.webContents.invalidate === 'function') {
      launcherWin.webContents.invalidate();
    }
  }, 170);
  const display = screen.getPrimaryDisplay();
  const held = launcherBackdrop ? launcherBackdrop.payload : null;
  const payload =
    held && held.width === display.bounds.width && held.height === display.bounds.height ? held : null;
  if (payload) window.webContents.send('launcher:backdrop', payload);
  warmLauncherBackdrop();
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
  // A second press while the sheet is still dismissing opens it again instead of
  // letting the pending take-down win.
  cancelLauncherHide();
  revealTaskbar();
  window.setBounds(launcherBounds());
  window.show();
  launcherShownAt = Date.now();
  window.moveTop();
  // The sheet has to be taking keys the instant it is up, so the show path does no
  // work that could hold the keyboard up: the glass image is the one encoded after
  // the last show, and the focus is taken here, in-process.
  window.focus();
  window.webContents.focus();
  app.focus({ steal: true });
  sendLauncherState();
  // Windows hands the foreground back a beat after a window appears, so if the sheet
  // is still not focused a moment later, the keyboard helper is asked to hand it
  // over — it can attach to the thread that owns the foreground — and after that the
  // focus is taken again in-process.
  const started = Date.now();
  let nudged = false;
  const poll = setInterval(() => {
    if (!window || window.isDestroyed() || window.webContents.isFocused()) {
      clearInterval(poll);
      return;
    }
    const waited = Date.now() - started;
    if (waited > 800) {
      clearInterval(poll);
      return;
    }
    if (waited > 220) {
      window.focus();
      window.webContents.focus();
    } else if (waited > 60 && !nudged) {
      nudged = true;
      stealLauncherFocus(window);
    }
  }, 20);
}

ipcMain.on('launcher:ready', sendLauncherState);

// The sheet animates itself out and says so; the window then goes away with a
// transparent frame on screen, which is also what the next show presents. The
// timer is only a guard for a renderer that never answers.
const LAUNCHER_CLOSE_MS = 420;
let launcherHide = null;

function cancelLauncherHide() {
  if (!launcherHide) return;
  clearTimeout(launcherHide.timer);
  launcherHide = null;
}

function hideLauncher() {
  const window = launcherWin;
  if (!window || window.isDestroyed() || !window.isVisible()) return;
  if (launcherHide) return;
  const takeDown = () => {
    if (!launcherHide || launcherHide.takeDown !== takeDown) return;
    clearTimeout(launcherHide.timer);
    launcherHide = null;
    if (window && !window.isDestroyed() && window.isVisible()) window.hide();
  };
  launcherHide = { takeDown, timer: setTimeout(takeDown, LAUNCHER_CLOSE_MS) };
  window.webContents.send('launcher:dismiss');
}

ipcMain.on('launcher:hidden', (event) => {
  if (!launcherHide) return;
  if (!launcherWin || launcherWin.isDestroyed() || event.sender !== launcherWin.webContents) return;
  launcherHide.takeDown();
});

function toggleLauncher() {
  if (launcherWin && !launcherWin.isDestroyed() && launcherWin.isVisible()) hideLauncher();
  else showLauncher();
}

// One tiny PowerShell host watches the Windows key: a lone tap is swallowed so
// the built-in Start never opens, chords pass through untouched.
function stopWinHook() {
  if (hookRetryTimer) clearTimeout(hookRetryTimer);
  hookRetryTimer = null;
  hookReady = false;
  if (!hookProc) return;
  const proc = hookProc;
  hookProc = null;
  try {
    proc.kill();
  } catch {
    /* already gone */
  }
}

// A helper that dies is restarted, not given up on: the Windows key is the only
// way into the launcher, and a machine left running for a week should still answer
// it. The wait grows so a PowerShell that keeps failing cannot spin, and a `ready`
// line from a healthy one resets the ladder.
function scheduleWinHookRetry() {
  if (hookRetryTimer || !prefs.settings.windowsKey || !isWin) return;
  const wait = Math.min(60000, 1500 * (hookFailures + 1));
  hookRetryTimer = setTimeout(() => {
    hookRetryTimer = null;
    startWinHook();
  }, wait);
}

// Where the helper is started from matters as much as the helper itself.
// -ExecutionPolicy only sets the policy for this one process; a policy handed
// down by Group Policy outranks it, so on managed and school machines the file is
// refused and the Windows key never answers. The same text read into a script
// block is not a script file, so the policy does not apply to it — and stdin
// stays free for the helper's commands. A start that never reports `ready`
// switches to that way in from then on.
let hookNeedsBlock = false;

function powershellExe() {
  try {
    const local = path.join(
      process.env.SystemRoot || 'C:\\Windows',
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe',
    );
    if (fs.existsSync(local)) return local;
  } catch {
    /* fall back to the PATH */
  }
  return 'powershell';
}

function winHookArgs(script) {
  if (!hookNeedsBlock) {
    return ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script];
  }
  const quoted = script.replace(/'/g, "''");
  return [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `& ([scriptblock]::Create((Get-Content -Raw -Encoding UTF8 -LiteralPath '${quoted}')))`,
  ];
}

function startWinHook() {
  if (hookProc || !prefs.settings.windowsKey || !isWin) return;
  const script = path.join(__dirname, 'winhook.ps1');
  let proc = null;
  try {
    proc = spawn(powershellExe(), winHookArgs(script), {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
  } catch {
    hookFailures += 1;
    hookNeedsBlock = true;
    scheduleWinHookRetry();
    return;
  }
  hookProc = proc;
  hookReady = false;
  // Compiled PowerShell takes a moment to start; one that never reports `ready`
  // never installed the hook, so it is replaced instead of leaving the key dead.
  let watchdog = null;
  // A helper that cannot be started at all reports it here. Left unhandled, that
  // error event would take the whole app down with it.
  proc.on('error', () => {
    if (hookProc !== proc) return;
    hookProc = null;
    hookReady = false;
    hookFailures += 1;
    hookNeedsBlock = true;
    nativeTaskbarHidden = false;
    if (watchdog) clearTimeout(watchdog);
    watchdog = null;
    scheduleWinHookRetry();
  });
  if (proc.stdin) proc.stdin.on('error', () => {});
  let buffer = '';
  proc.stdout.on('data', (chunk) => {
    buffer += String(chunk);
    let line = buffer.indexOf('\n');
    while (line >= 0) {
      const text = buffer.slice(0, line).trim();
      buffer = buffer.slice(line + 1);
      if (gpuRequest && text.startsWith('GPU\t')) {
        const pending = gpuRequest;
        gpuRequest = null;
        gpuBusy = false;
        pending(Number(text.slice(4)));
      } else if (iconRequest && text.startsWith(iconRequest.prefix)) {
        const pending = iconRequest;
        iconRequest = null;
        pending.resolve(text.slice(pending.prefix.length).trim());
      } else if (trayShotRequest && text.startsWith('IMG\t')) {
        const [, shotW, shotH, shotData] = text.split('\t');
        const pending = trayShotRequest;
        trayShotRequest = null;
        pending.resolve(
          shotData ? { width: Number(shotW) || 0, height: Number(shotH) || 0, data: shotData } : null,
        );
      } else if (trayListBuffer) {
        if (text === 'TE') {
          const rows = trayListBuffer;
          trayListBuffer = null;
          if (trayRequest) trayRequest.finish(rows);
        } else if (text === 'win') {
          toggleLauncher();
        } else if (text.startsWith('slot ')) {
          activateTaskbarSlot(Number(text.slice(5)));
        } else if (text.includes('\t')) {
          trayListBuffer.push(text);
        }
      } else if (text === 'TB') {
        trayListBuffer = [];
      } else if (windowListBuffer) {
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
      else if (text === 'ready') {
        hookFailures = 0;
        hookReady = true;
        if (watchdog) clearTimeout(watchdog);
        watchdog = null;
        // A helper that has just come up knows nothing about the shell's bar:
        // say what it should be, so one left hidden by an earlier helper — or by
        // an explorer restart — is put back or taken away as the setting says.
        sendNativeTaskbarState(true);
      } else if (text.startsWith('fail')) {
        hookFailures += 1;
        stopWinHook();
        scheduleWinHookRetry();
      }
      line = buffer.indexOf('\n');
    }
  });
  // PowerShell compiles the helper's C# on the way up, and a cold start on a slow
  // disk can take ten seconds or more. The hook only says `ready` once it is
  // installed, so a short watchdog killed helpers that were merely slow — and on
  // those machines the Windows key never worked at all.
  watchdog = setTimeout(() => {
    if (hookProc !== proc || hookReady) return;
    hookFailures += 1;
    hookProc = null;
    nativeTaskbarHidden = false;
    try {
      proc.kill();
    } catch {
      /* already gone */
    }
    scheduleWinHookRetry();
  }, 30000);
  proc.on('exit', () => {
    if (hookProc !== proc) return; // stopped on purpose
    hookProc = null;
    hookReady = false;
    hookFailures += 1;
    nativeTaskbarHidden = false;
    // It went away without reporting `ready`, so how it was started is the first
    // thing to change: the next attempt runs the file as a script block.
    hookNeedsBlock = true;
    if (watchdog) clearTimeout(watchdog);
    watchdog = null;
    scheduleWinHookRetry();
  });
}

function syncWinHook() {
  if (prefs.settings.windowsKey) startWinHook();
  else stopWinHook();
}

// What the Settings row says: a hook that is running, one on its way up, or one
// this machine will not let start — the difference between a key that is off and
// a key that is being refused.
function winHookStatus() {
  if (!isWin) return 'not on this system';
  if (!prefs.settings.windowsKey) return 'off';
  if (hookReady) return 'running';
  if (hookProc) return 'starting';
  return hookFailures > 1 ? 'not starting' : 'starting';
}

ipcMain.handle('notch:winhook', () => winHookStatus());

ipcMain.handle('launcher:boot', async () => ({
  index: await buildAppIndex(),
  pinned: pinnedEntries(),
  settings: { windowsKey: !!prefs.settings.windowsKey, animations: prefs.settings.animations },
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
  const pins = Array.isArray(prefs.pinned) ? prefs.pinned : [];
  if (pins.some((pin) => pin.id === id)) removePinnedApp(id);
  else await addPinnedApp(entry);
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
        {
          label: newerVersion(updateState.latest, updateState.current)
            ? `Update to Notch ${updateState.latest}…`
            : 'Check for updates…',
          click: () => {
            openUpdateSettings();
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
      // A portable build unpacks itself to a temp folder, so the launcher exe is
      // the stable path for a login shortcut.
      path: process.env.PORTABLE_EXECUTABLE_FILE || process.execPath,
      args: app.isPackaged ? [] : [path.join(__dirname)],
    });
  } catch {
    /* unsupported */
  }
}

// ------------------------------------------------------------------ screenshot

// One capture is held at a time. The panel asks, the desktop is photographed with
// the shell taken out of the frame, and the PNG stays on disk so the three things
// offered under the preview — save it, read it, name the typeface — all work from
// the same pixels.
let shot = null; // { file, width, height }

// Two independent ways to photograph the screen. The helper's GDI grab is the
// cheap one, and the tray icons already rely on it — but it answers nothing at
// all for a rectangle it does not like (4096 a side, nine megapixels), and GDI is
// not DPI-aware, so a scaled or very large display can be refused by it while
// Chromium's own capturer still sees the screen perfectly well.
async function captureScreen(display) {
  const scale = display.scaleFactor || 1;
  const physical = {
    x: Math.round(display.bounds.x * scale),
    y: Math.round(display.bounds.y * scale),
    width: Math.round(display.bounds.width * scale),
    height: Math.round(display.bounds.height * scale),
  };
  const dip = {
    x: Math.round(display.bounds.x),
    y: Math.round(display.bounds.y),
    width: Math.round(display.bounds.width),
    height: Math.round(display.bounds.height),
  };
  const within = (rect) =>
    rect.width > 0 &&
    rect.height > 0 &&
    rect.width <= 4096 &&
    rect.height <= 4096 &&
    rect.width * rect.height <= 9000000;
  const rects = [];
  if (within(physical)) rects.push(physical);
  if (within(dip) && (dip.width !== physical.width || dip.height !== physical.height)) rects.push(dip);
  // A helper that has not reported itself ready yet would swallow the request
  // until the timeout: Chromium answers in that time, so it is asked first-hand.
  if (hookProc && hookReady) {
    for (const rect of rects) {
      const grab = await requestScreenShot(rect, 6000);
      if (grab && grab.data) return grab;
    }
  }
  return captureWithChromium(display);
}

// The Electron capturer asks the desktop compositor for a frame instead of
// reading the display with GDI, which works where the helper is refused — and
// where the helper is not running at all.
async function captureWithChromium(display) {
  const scale = display.scaleFactor || 1;
  const width = Math.min(8192, Math.round(display.bounds.width * scale));
  const height = Math.min(8192, Math.round(display.bounds.height * scale));
  const grab = () =>
    desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width, height },
      fetchWindowIcons: false,
    });
  try {
    let sources = await grab();
    let source =
      sources.find((entry) => String(entry.display_id) === String(display.id)) || sources[0];
    if (!source || source.thumbnail.isEmpty()) {
      // A frame right after the windows were made transparent can still be the
      // old one, or none at all.
      await new Promise((resolve) => setTimeout(resolve, 160));
      sources = await grab();
      source = sources.find((entry) => String(entry.display_id) === String(display.id)) || sources[0];
    }
    if (!source || source.thumbnail.isEmpty()) return null;
    const size = source.thumbnail.getSize();
    return {
      width: size.width,
      height: size.height,
      data: source.thumbnail.toPNG().toString('base64'),
    };
  } catch {
    return null;
  }
}

// The shot should not contain the shell. Hiding the windows would take the
// pointer off the pill mid-click and close the panel, so they are made fully
// transparent for the frame instead and put back straight after. The picker
// needs them gone for as long as it is up, so this is a function of its own.
//
// Fades can overlap — a picker still up when something else asks for the shell to
// step aside — and a second fade that stored the opacity it found would restore
// the zero the first one left behind. The surfaces are remembered once, and put
// back when the last fade ends.
let fadeDepth = 0;
let fadedOpacities = null;

function fadeShell() {
  if (fadeDepth === 0) {
    fadedOpacities = new Map();
    for (const surface of shellSurfaces()) {
      if (!surface.isVisible()) continue;
      try {
        const was = typeof surface.getOpacity === 'function' ? surface.getOpacity() : 1;
        fadedOpacities.set(surface, Number.isFinite(was) && was > 0 ? was : 1);
        surface.setOpacity(0);
      } catch {
        /* already gone */
      }
    }
  }
  fadeDepth += 1;
  let done = false;
  return () => {
    if (done) return;
    done = true;
    fadeDepth = Math.max(0, fadeDepth - 1);
    if (fadeDepth > 0 || !fadedOpacities) return;
    const surfaces = fadedOpacities;
    fadedOpacities = null;
    for (const [surface, was] of surfaces) {
      if (surface.isDestroyed()) continue;
      try {
        surface.setOpacity(was);
        // A window that spent time at zero alpha can be left holding the frame
        // from before the fade: the paint that brings the panel back is asked
        // for, so what comes after a shot is never an empty window.
        if (surface.webContents && typeof surface.webContents.invalidate === 'function') {
          surface.webContents.invalidate();
        }
      } catch {
        /* already gone */
      }
    }
    if (win && !win.isDestroyed()) {
      try {
        win.showInactive();
        win.moveTop();
      } catch {
        /* the window is on its way out */
      }
    }
  };
}

// A display-sized frame is photographed whole and cut afterwards, so the region
// keeps the pixels the full screen would have had whichever capture answered.
// The scale comes from the picture itself, which is what makes a physical grab
// and a DIP grab crop correctly with the same arithmetic.
function cropToRect(image, rect, display) {
  const full = image.getSize();
  const scale = display.bounds.width > 0 ? full.width / display.bounds.width : 1;
  const box = {
    x: Math.round((rect.x - display.bounds.x) * scale),
    y: Math.round((rect.y - display.bounds.y) * scale),
    width: Math.round(rect.width * scale),
    height: Math.round(rect.height * scale),
  };
  box.x = Math.max(0, Math.min(box.x, full.width - 1));
  box.y = Math.max(0, Math.min(box.y, full.height - 1));
  box.width = Math.max(1, Math.min(box.width, full.width - box.x));
  box.height = Math.max(1, Math.min(box.height, full.height - box.y));
  if (box.width < 4 || box.height < 4) return null;
  return image.crop(box);
}

async function captureScreenshot(rect = null, options = {}) {
  if (!win || win.isDestroyed()) return { ok: false, error: 'Nothing to capture' };
  if (gameMode) return { ok: false, error: 'A game has the screen' };
  const display = screen.getPrimaryDisplay();
  const restore = options.faded ? () => {} : fadeShell();
  let grab = null;
  try {
    await new Promise((resolve) => setTimeout(resolve, 120));
    grab = await captureScreen(display);
  } finally {
    restore();
  }
  if (!grab || !grab.data) {
    return { ok: false, error: 'The screen could not be read — Windows refused the capture' };
  }
  const png = Buffer.from(grab.data, 'base64');
  const whole = nativeImage.createFromBuffer(png);
  if (whole.isEmpty()) return { ok: false, error: 'The screen came back empty' };
  const image = rect ? cropToRect(whole, rect, display) : whole;
  if (!image || image.isEmpty()) return { ok: false, error: 'That part of the screen came back empty' };
  const size = image.getSize();
  const data = image === whole ? png : image.toPNG();
  const file = path.join(app.getPath('temp'), `notch-shot-${Date.now()}.png`);
  try {
    fs.writeFileSync(file, data);
  } catch {
    return { ok: false, error: 'Could not keep the picture' };
  }
  shot = { file, width: size.width, height: size.height };
  // A preview the panel can paint at its own width; the file keeps every pixel
  // for the reader and for saving.
  const preview = image.resize({ width: Math.min(1024, size.width), quality: 'good' }).toDataURL();
  return { ok: true, width: size.width, height: size.height, preview };
}

// ------------------------------------------------------------------ picker

let regionWin = null;
let regionResolve = null;

function closeRegion(rect) {
  const resolve = regionResolve;
  regionResolve = null;
  if (regionWin && !regionWin.isDestroyed()) regionWin.destroy();
  regionWin = null;
  if (resolve) resolve(rect || null);
}

// A sheet of glass over the whole display with nothing on it but a dimmed veil
// and a drag: the screen underneath is left exactly as it is, so what is chosen
// is what is there. Returns the chosen rectangle in screen coordinates, or null.
function pickRegion() {
  closeRegion(null);
  return new Promise((resolve) => {
    const display = screen.getPrimaryDisplay();
    regionResolve = resolve;
    const overlay = new BrowserWindow({
      x: display.bounds.x,
      y: display.bounds.y,
      width: display.bounds.width,
      height: display.bounds.height,
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
      title: 'Notch screenshot',
      webPreferences: {
        preload: path.join(__dirname, 'region-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        spellcheck: false,
        backgroundThrottling: false,
      },
    });
    regionWin = overlay;
    overlay.setMenu(null);
    overlay.setAlwaysOnTop(true, 'screen-saver');
    overlay.setSkipTaskbar(true);
    overlay.loadFile(path.join(__dirname, 'src', 'region.html'));
    overlay.once('ready-to-show', () => {
      if (overlay.isDestroyed()) return;
      overlay.setBounds(display.bounds, false);
      overlay.show();
      overlay.focus();
    });
    // Esc closes it even if the page never got the keystroke.
    overlay.webContents.on('before-input-event', (_event, input) => {
      if (input.type === 'keyDown' && input.key === 'Escape') closeRegion(null);
    });
    overlay.on('closed', () => {
      if (regionWin === overlay) regionWin = null;
      const pending = regionResolve;
      regionResolve = null;
      if (pending) pending(null);
    });
  });
}

// The picker is the first half of a shot: the shell steps out for it, and the
// frame taken afterwards is cut to the rectangle it hands back.
async function regionShot() {
  if (!win || win.isDestroyed()) return { ok: false, error: 'Nothing to capture' };
  if (gameMode) return { ok: false, error: 'A game has the screen' };
  const restore = fadeShell();
  let rect = null;
  try {
    rect = await pickRegion();
  } catch {
    rect = null;
  }
  if (!rect) {
    restore();
    return { ok: false, cancelled: true, error: '' };
  }
  try {
    // The overlay has to be off the screen before the frame is taken.
    await new Promise((resolve) => setTimeout(resolve, 90));
    return await captureScreenshot(rect, { faded: true });
  } finally {
    restore();
  }
}

ipcMain.on('region:pick', (_event, payload) => {
  const box = payload || {};
  const rect = {
    x: Math.round(Number(box.x) || 0),
    y: Math.round(Number(box.y) || 0),
    width: Math.round(Number(box.width) || 0),
    height: Math.round(Number(box.height) || 0),
  };
  if (rect.width < 4 || rect.height < 4) {
    closeRegion(null);
    return;
  }
  // The overlay covers the primary display, so its window coordinates are screen
  // coordinates less the corner it starts at.
  const origin =
    regionWin && !regionWin.isDestroyed() ? regionWin.getBounds() : screen.getPrimaryDisplay().bounds;
  closeRegion({ x: origin.x + rect.x, y: origin.y + rect.y, width: rect.width, height: rect.height });
});

ipcMain.on('region:cancel', () => closeRegion(null));

function shotFolder() {
  return path.join(app.getPath('pictures'), 'Notch', 'Screenshots');
}

function saveScreenshot() {
  if (!shot) return { ok: false, error: 'Nothing to save' };
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  const name =
    `Notch ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
    `${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}.png`;
  const folder = shotFolder();
  const target = path.join(folder, name);
  try {
    fs.mkdirSync(folder, { recursive: true });
    fs.copyFileSync(shot.file, target);
  } catch {
    return { ok: false, error: 'Could not write to Pictures' };
  }
  return { ok: true, path: target };
}

// Reading the picture is PowerShell's job: Windows ships an OCR engine that needs
// no download, and the same helper compares installed typefaces against the
// largest line in the shot. It runs in its own process, so a bad image cannot take
// the keyboard hook down with it.
function runShotTool(mode, timeout) {
  return new Promise((resolve) => {
    if (!shot) {
      resolve({ ok: false, error: 'Nothing to read' });
      return;
    }
    execFile(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        path.join(__dirname, 'shot-tools.ps1'),
        '-Image',
        shot.file,
        '-Mode',
        mode,
      ],
      { windowsHide: true, timeout, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout) => {
        const raw = String(stdout || '');
        const at = raw.indexOf('{');
        let answer = null;
        try {
          answer = at >= 0 ? JSON.parse(raw.slice(at)) : null;
        } catch {
          answer = null;
        }
        if (!answer || answer.ok === false) {
          resolve({
            ok: false,
            error:
              (answer && answer.error) ||
              (error && error.killed ? 'It took too long' : 'The reader did not answer'),
          });
          return;
        }
        resolve(answer);
      },
    );
  });
}

async function readShotText() {
  const answer = await runShotTool('text', 30000);
  if (!answer.ok) return answer;
  const text = String(answer.text || '');
  if (text) {
    try {
      clipboard.writeText(text);
    } catch {
      /* the clipboard is busy elsewhere */
    }
  }
  return { ok: true, text };
}

async function guessShotFont() {
  return runShotTool('font', 60000);
}

// One place hands a finished shot to the panel: the picture and the page that
// carries its three actions go together, so the panel opens on the shot whatever
// asked for it. Choosing a region closes the panel on the way out, so this may not
// be left to whoever asked — a request that comes back after that would otherwise
// finish with nothing on screen.
function deliverShot(result) {
  if (!result || !result.ok) return false;
  if (!win || win.isDestroyed() || gameMode) return false;
  win.webContents.send('notch:shot', result);
  return showNotchPanel('shot');
}

// The shortcut goes through the panel, so the shot opens where its actions are.
async function takeScreenshot() {
  const result = await regionShot();
  deliverShot(result);
  return result;
}

ipcMain.handle('notch:shot-capture', async () => {
  const result = await regionShot();
  deliverShot(result);
  return result;
});
ipcMain.handle('notch:shot-save', () => saveScreenshot());
ipcMain.handle('notch:shot-text', () => readShotText());
ipcMain.handle('notch:shot-font', () => guessShotFont());

// -------------------------------------------------------------------- updates

// Notch updates itself from its own releases. The check is one small request to
// GitHub; the release already carries the installer, so updating is a download to
// temp and a silent install instead of hunting the release page by hand.
const UPDATE_REPO = 'Viggoo5555/Notch-For_Windows';
const UPDATE_EVERY_MS = 6 * 60 * 60 * 1000;

const updateState = {
  current: app.getVersion(),
  latest: '',
  notes: '',
  page: '',
  url: '',
  name: '',
  size: 0,
  checkedAt: 0,
  error: '',
  busy: false,
  percent: 0,
};

function newerVersion(latest, current) {
  const parse = (value) =>
    String(value || '\u0000')
      .replace(/^v/i, '')
      .split(/[.+-]/)
      .map((part) => parseInt(part, 10) || 0);
  const next = parse(latest);
  const now = parse(current);
  for (let i = 0; i < Math.max(next.length, now.length); i += 1) {
    const left = next[i] || 0;
    const right = now[i] || 0;
    if (left !== right) return left > right;
  }
  return false;
}

function publicUpdate() {
  return {
    current: updateState.current,
    latest: updateState.latest,
    newer: newerVersion(updateState.latest, updateState.current),
    url: updateState.url,
    page: updateState.page,
    notes: String(updateState.notes || '').slice(0, 1500),
    checkedAt: updateState.checkedAt,
    error: updateState.error,
    busy: updateState.busy,
    percent: updateState.percent,
  };
}

function sendUpdate() {
  if (win && !win.isDestroyed()) win.webContents.send('notch:update', publicUpdate());
}

// The API is the rich answer — the release notes, and the asset's own size and
// address. It is rate limited per address, though, and a shared one runs out
// (403). The releases page redirects to the newest tag and is not limited, so a
// blocked API still finds the update; the installer's address follows from the tag.
async function latestReleaseFromApi() {
  const response = await net.fetch(`https://api.github.com/repos/${UPDATE_REPO}/releases/latest`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': `Notch/${updateState.current}` },
  });
  if (!response.ok) return null;
  const release = await response.json();
  const latest = String(release.tag_name || '').replace(/^v/i, '');
  if (!latest) return null;
  const asset = (release.assets || []).find((entry) => /^Notch-Setup-.*\.exe$/i.test(entry.name));
  return {
    latest,
    notes: release.body || '',
    page: release.html_url || `https://github.com/${UPDATE_REPO}/releases/tag/v${latest}`,
    url: asset ? asset.browser_download_url : '',
    name: asset ? asset.name : '',
    size: asset ? asset.size : 0,
  };
}

async function latestReleaseFromPage() {
  const response = await net.fetch(`https://github.com/${UPDATE_REPO}/releases/latest`, {
    headers: { Accept: 'text/html', 'User-Agent': `Notch/${updateState.current}` },
  });
  if (!response.ok) return null;
  // Following the redirect lands on /releases/tag/vX.Y.Z, which names the version.
  const where = `${response.url || ''} ${response.headers.get('location') || ''}`;
  const tag = (where.match(/\/tag\/([^/\s?#]+)/) || [])[1] || '';
  const latest = tag.replace(/^v/i, '');
  if (!latest) return null;
  const name = `Notch-Setup-${latest}.exe`;
  return {
    latest,
    notes: '',
    page: `https://github.com/${UPDATE_REPO}/releases/tag/${tag}`,
    url: `https://github.com/${UPDATE_REPO}/releases/download/${tag}/${name}`,
    name,
    size: 0,
  };
}

// One check at a time: the start-up check, the six-hour check and the one the
// tray or the drawer asks for can otherwise land on top of each other, and a
// check already in flight answers them all.
let updateCheckInFlight = null;

async function checkForUpdates() {
  if (updateState.busy) return publicUpdate();
  if (updateCheckInFlight) return updateCheckInFlight;
  updateCheckInFlight = (async () => {
    let release = null;
    try {
      release = await latestReleaseFromApi();
    } catch {
      release = null;
    }
    if (!release) {
      try {
        release = await latestReleaseFromPage();
      } catch {
        release = null;
      }
    }
    updateState.checkedAt = Date.now();
    if (release) {
      updateState.latest = release.latest;
      updateState.notes = release.notes;
      updateState.page = release.page;
      updateState.url = release.url;
      updateState.name = release.name;
      updateState.size = release.size;
      updateState.error = '';
    } else {
      updateState.error = 'GitHub could not be reached';
    }
    sendUpdate();
    globalThis.__rebuildTray?.();
    return publicUpdate();
  })();
  try {
    return await updateCheckInFlight;
  } finally {
    updateCheckInFlight = null;
  }
}

// Written straight to disk in chunks: a 350 MB installer has no business sitting in
// memory, and the panel shows the percentage as it arrives.
async function downloadInstaller(target) {
  const response = await net.fetch(updateState.url);
  if (!response.ok || !response.body) throw new Error(`download ${response.status}`);
  // The size the release reports is the file's real length; content-length can be the
  // compressed length, so it is only good enough to draw a percentage from.
  const expected = updateState.size || 0;
  const total = expected || Number(response.headers.get('content-length')) || 0;
  const reader = response.body.getReader();
  const out = fs.createWriteStream(target);
  let received = 0;
  let sentAt = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (!out.write(Buffer.from(value))) await new Promise((resolve) => out.once('drain', resolve));
      const now = Date.now();
      if (total && now - sentAt > 250) {
        sentAt = now;
        updateState.percent = Math.min(99, Math.round((received / total) * 100));
        if (win && !win.isDestroyed()) {
          win.webContents.send('notch:update-progress', {
            percent: updateState.percent,
            received,
            total,
          });
        }
      }
    }
  } finally {
    await new Promise((resolve) => out.end(resolve));
  }
  const size = fs.statSync(target).size;
  if (expected && size !== expected) throw new Error('download was incomplete');
  return size;
}

async function installUpdate() {
  if (updateState.busy) return { ok: false, error: 'Already updating' };
  if (!updateState.url) return { ok: false, error: 'Nothing to download' };
  // A checkout is not an installation: replacing files under a running source tree
  // is how a dev machine loses its work.
  if (!app.isPackaged) return { ok: false, error: 'Run the installed Notch to update' };
  updateState.busy = true;
  updateState.percent = 0;
  updateState.error = '';
  sendUpdate();
  const target = path.join(
    app.getPath('temp'),
    updateState.name || `Notch-Setup-${updateState.latest}.exe`,
  );
  try {
    fs.rmSync(target, { force: true });
  } catch {
    /* nothing there */
  }
  try {
    await downloadInstaller(target);
  } catch {
    updateState.busy = false;
    updateState.percent = 0;
    updateState.error = 'Download failed';
    sendUpdate();
    return { ok: false, error: 'Download failed' };
  }
  updateState.percent = 100;
  sendUpdate();
  // The app cannot stay open while its own files are replaced. The command waits
  // four seconds first — long enough for this process to be gone, so the silent
  // install is not fighting a locked file — then installs without a window and
  // starts the new build itself. This process quits at once rather than sitting
  // on an installer it will not live to see.
  const exe = app.getPath('exe');
  try {
    spawn('cmd.exe', ['/c', `ping -n 5 127.0.0.1 >nul & "${target}" /S & start "" "${exe}"`], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    }).unref();
    app.isQuitting = true;
    setTimeout(() => app.quit(), 400);
    return { ok: true };
  } catch {
    updateState.busy = false;
    updateState.error = 'Could not start the installer';
    sendUpdate();
    return { ok: false, error: updateState.error };
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

// The glass needs to know where the pointer is to keep it out of the picture.
ipcMain.handle('notch:cursor', () => screen.getCursorScreenPoint());

ipcMain.handle('notch:update-check', () => checkForUpdates());
ipcMain.handle('notch:update-install', () => installUpdate());
ipcMain.on('notch:update-page', () => {
  const page = updateState.page || `https://github.com/${UPDATE_REPO}/releases`;
  shell.openExternal(page).catch(() => {});
});

// Which screen the glass should stream, plus where it starts: the panel maps its
// own slice of the picture with this.
ipcMain.handle('notch:capture-source', async () => {
  const display = panelDisplay();
  try {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 1, height: 1 },
    });
    const pick = sources.find((entry) => String(entry.display_id) === String(display.id)) || sources[0];
    return pick ? { id: pick.id, bounds: display.bounds } : null;
  } catch {
    return null;
  }
});

ipcMain.on('notch:live-active', (_event, active) => {
  streamActive = !!active;
  // The stream is doing the work now, so the grab loop can rest; if it stops or
  // never started, the loop takes over again.
  if (streamActive) stopDesktopSampling();
  else if (samplingWanted()) startDesktopSampling();
});

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
  } else {
    stopLiveData();
    // Let the close animation finish before the next sample lands.
    setTimeout(syncDesktopSampling, 700);
  }
  syncDesktopSampling();
});

// The width setting is a floor, not a ceiling: the folded pill is composed from
// whatever pieces are switched on, and the renderer measures what they need. The
// hover rect has to be as wide as the pill it is guarding, or the pieces that
// made it grow would be the ones that cannot open it.
let pillContentW = 0;
ipcMain.on('notch:pill-width', (_event, value) => {
  const next = Math.round(Number(value) || 0);
  if (next === pillContentW) return;
  pillContentW = Math.max(0, Math.min(320, next));
});

// The close is an animation, not an instant. The renderer knows how long its
// own clip transition runs (it follows the animation-speed setting), so it says
// so and the hover rect follows, rather than assuming a duration here.
ipcMain.on('notch:collapsing', (_event, ms) => {
  const wait = Math.max(0, Math.min(2000, Number(ms) || 0));
  collapsesUntil = wait ? Date.now() + wait : 0;
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

// One way in for a settings change, whether the sheet's switches made it or
// Jarvis did: saved, applied to every surface, and handed back to the panel so
// what it shows matches what was asked for.
function applySettingsPatch(patch) {
  prefs.settings = { ...DEFAULT_SETTINGS, ...prefs.settings, ...(patch || {}) };
  savePrefs();
  // The launcher window is loaded already, so its motion choice arrives by message.
  if (launcherWin && !launcherWin.isDestroyed()) {
    launcherWin.webContents.send('launcher:motion', prefs.settings.animations);
  }
  if (!usesLiveBackdrop()) {
    // Pinned image: stop sampling entirely (also the cheapest idle state) and
    // hand the renderer the wallpaper slice in place of the desktop.
    syncDesktopSampling();
    desktopFrame = null;
    launcherBackdrop = null;
    const url = panelBackdrop();
    if (url && win && !win.isDestroyed()) win.webContents.send('notch:backdrop', url);
    sendWidgetBackdrop();
  }
  refreshTaskbar();
  syncDesktopSampling();
  sendWidgetSurface();
  syncWinHook();
  if (win && !win.isDestroyed()) win.webContents.send('notch:settings', prefs.settings);
  // The renderer applies the patch when the message arrives; ask for the frame
  // once it has, so a new accent is drawn instead of the one the cached frame
  // already holds.
  repaintShell(180);
  return prefs.settings;
}

ipcMain.handle('notch:set-settings', (_event, patch) => applySettingsPatch(patch));

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
  launcherBackdrop = null;

  syncDesktopSampling();
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

// --------------------------------------------------------------- the store

// The shop in the library is drawn by Notch, not handed to a browser. SteamDB
// is where the prices are read about, but it has no public API and its terms
// forbid scraping it, so the numbers come from the same place SteamDB gets
// them: Steam's own storefront, whose featured list is public JSON with prices
// in the buyer's currency.
const STORE_TTL = 10 * 60 * 1000;
// The store pages through Steam's own search rather than fetching one fixed list:
// a hundred rows per answer, in the order the view asked for, one answer per
// screenful. The panel only draws the rows around the pointer, so the list can be
// as long as Steam is willing to keep answering.
const STORE_PAGE_SIZE = 100;
const storePageCache = new Map();
let storeCurrencyCache = null;

function storeCountry() {
  try {
    const code = String(app.getLocaleCountryCode() || '').toLowerCase();
    if (/^[a-z]{2}$/.test(code)) return code;
  } catch {
    /* older Electron */
  }
  return 'us';
}

function decodeSteam(text) {
  return String(text || '')
    .replace(/&lt;br\s*\/?&gt;/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

// One row of Steam's own search results: appid, title, the price in the smallest
// unit of the local currency, the discount, and what players made of it.
function parseSteamRows(html) {
  const rows = [];
  const chunks = String(html || '').split('<a href="https://store.steampowered.com/app/');
  for (const chunk of chunks.slice(1)) {
    const appid = Number((chunk.match(/data-ds-appid="(\d+)"/) || [])[1] || 0);
    const name = decodeSteam((chunk.match(/<span class="title">([\s\S]*?)<\/span>/) || [])[1] || '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!appid || !name) continue;
    const priceMatch = chunk.match(
      /class="search_price_discount_combined[^"]*"[^>]*data-price-final="(\d+)"/,
    );
    const discount = Math.max(0, Math.min(100, Number((chunk.match(/data-discount="(\d+)"/) || [])[1] || 0)));
    const reviewMatch = chunk.match(
      /class="search_review_summary[^"]*"[^>]*data-tooltip-html="([^"]*)"/,
    );
    let label = '';
    let percent = 0;
    let count = 0;
    if (reviewMatch) {
      const text = decodeSteam(reviewMatch[1]);
      label = text
        .split('\n')[0]
        .replace(/\s*\d{1,3}%[\s\S]*$/, '')
        .replace(/\s+reviews?[\s\S]*$/i, '')
        .trim();
      const score = text.match(/(\d{1,3})%\s+of\s+the\s+([\d.,]+)/i);
      if (score) {
        percent = Math.min(100, Number(score[1]));
        count = Number(score[2].replace(/[^\d]/g, '')) || 0;
      }
    }
    const final = priceMatch ? Number(priceMatch[1]) || 0 : null;
    const original =
      final !== null && discount
        ? Math.round(final / Math.max(0.05, 1 - discount / 100))
        : final;
    rows.push({ appid, name, discount, final, original, label, percent, count });
  }
  return rows;
}

// Which of Steam's orders answers each sort the store offers. It has no "most
// reviewed" or "biggest discount" order of its own, so those ride on its review
// ranking; the deals chip asks Steam for the sale list on top of that.
const STORE_SORT_BY = {
  reviews: 'Reviews_DESC',
  popular: 'Reviews_DESC',
  discount: 'Reviews_DESC',
  price: 'Price_ASC',
  pricey: 'Price_DESC',
  name: 'Name_ASC',
};

// The currency is only how a price is written, so it is asked for once and kept.
async function storeCurrency() {
  if (storeCurrencyCache && Date.now() - storeCurrencyCache.at < STORE_TTL) {
    return storeCurrencyCache.currency;
  }
  let currency = 'USD';
  try {
    const response = await net.fetch(
      `https://store.steampowered.com/api/featuredcategories/?cc=${storeCountry()}&l=en`,
    );
    if (response.ok) {
      const data = await response.json();
      const first =
        (data.specials && data.specials.items && data.specials.items[0]) ||
        (data.top_sellers && data.top_sellers.items && data.top_sellers.items[0]) ||
        null;
      if (first && first.currency) currency = String(first.currency);
    }
  } catch {
    /* the rows still carry their prices; only the symbol would be a guess */
  }
  storeCurrencyCache = { at: Date.now(), currency };
  return currency;
}

function storeItem(row, currency) {
  const priced = row.final !== null;
  const final = priced ? row.final : 0;
  return {
    appid: row.appid,
    name: row.name,
    source: row.discount > 0 ? 'deal' : 'top',
    discount: row.discount,
    original: priced ? Math.max(row.original || 0, final) : 0,
    final,
    priced,
    free: priced && final === 0,
    currency,
    review: row.percent ? { label: row.label, percent: row.percent, count: row.count } : null,
    art: `https://cdn.cloudflare.steamstatic.com/steam/apps/${row.appid}/header.jpg`,
  };
}

// One page of Steam's search, in the order the store asked for it. Answers are
// kept for the same ten minutes the old single fetch was: scrolling back up a
// list should not ask Steam for rows it has already given.
async function fetchStorePage(options = {}) {
  const start = Math.max(0, Math.trunc(Number(options.start) || 0));
  const term = String(options.term || '').trim().slice(0, 80);
  const sort = STORE_SORT_BY[String(options.sort || '')] || STORE_SORT_BY.reviews;
  const maxprice = Math.max(0, Number(options.maxprice) || 0);
  const query = new URLSearchParams({
    start: String(start),
    count: String(STORE_PAGE_SIZE),
    sort_by: sort,
    infinite: '1',
    cc: storeCountry(),
    l: 'en',
  });
  if (term) query.set('term', term);
  // The sale list is the one filter Steam can answer for itself; a threshold
  // inside it (25 % or more) is left to the view.
  if (options.deals) query.set('specials', '1');
  if (maxprice) query.set('maxprice', String(maxprice));

  const key = query.toString();
  const hit = storePageCache.get(key);
  if (hit && Date.now() - hit.at < STORE_TTL) return hit;

  let rows = null;
  try {
    const response = await net.fetch(`https://store.steampowered.com/search/results/?${query}`);
    if (response.ok) {
      const data = await response.json();
      rows = parseSteamRows(data && data.results_html);
    }
  } catch {
    rows = null;
  }
  if (!rows) return { items: [], more: false, error: 'unreachable' };

  const currency = await storeCurrency();
  const result = {
    at: Date.now(),
    items: rows.map((row) => storeItem(row, currency)),
    // A full page means there is another behind it; Steam answers with what it
    // has left on the last one.
    more: rows.length >= STORE_PAGE_SIZE,
  };
  storePageCache.set(key, result);
  if (storePageCache.size > 80) {
    let oldestKey = null;
    let oldestAt = Infinity;
    for (const [cacheKey, value] of storePageCache) {
      if (value.at < oldestAt) {
        oldestAt = value.at;
        oldestKey = cacheKey;
      }
    }
    if (oldestKey) storePageCache.delete(oldestKey);
  }
  return result;
}

ipcMain.handle('notch:store-page', (_event, options) => fetchStorePage(options || {}));

// Buying is still Steam's: a row opens the game's own page.
ipcMain.handle('notch:store-open', (_event, appid) => {
  const id = Math.trunc(Number(appid) || 0);
  if (id <= 0) return false;
  shell.openExternal(`https://store.steampowered.com/app/${id}/`);
  return true;
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

// Removing a game never touches a file on disk: it is taken out of the library,
// and the scan is asked not to bring it back. A game added by hand also leaves
// the list of shortcuts, since that list is where it came from.
ipcMain.handle('notch:remove-game', (_event, id) => {
  const key = String(id || '');
  if (!key) return games;
  const game = games.find((entry) => entry.id === key) || null;
  if (game && game.kind === 'local' && game.path) {
    const wanted = String(game.path).toLowerCase();
    prefs.customGames = (prefs.customGames || []).filter(
      (entry) => String((entry && entry.path) || '').toLowerCase() !== wanted,
    );
  }
  const hidden = new Set(Array.isArray(prefs.hiddenGames) ? prefs.hiddenGames : []);
  hidden.add(key);
  // Bounded, so a long-lived settings file cannot grow forever.
  prefs.hiddenGames = [...hidden].slice(-500);
  savePrefs();
  const list = rescanGames();
  if (win && !win.isDestroyed()) win.webContents.send('notch:games', list);
  return list;
});

// Launching a game is the same work from the library's click and from Jarvis's
// order, so it lives here once.
async function launchGameRecord(game) {
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
}

ipcMain.handle('notch:launch', async (_event, id) => {
  const game = games.find((g) => g.id === id);
  return launchGameRecord(game);
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
// Every tile can be pulled out of the panel into its own card, so there is one
// window per tile instead of a single System widget.
const WIDGET_TILES = new Set(['system', 'focus', 'library', 'clip', 'perf']);
const widgetWins = new Map();
let widgetExpanded = false;
let widgetDragTimer = null;
let widgetDragOrigin = null;
let widgetDragWin = null;
let widgetStatsTimer = null;
let widgetProcTimer = null;
let procBusy = false;
let procPrev = new Map();
let procPrevAt = 0;
let panelSystemDetail = false;
// The focus timer is owned by the panel; this mirrors its last state so a
// detached Focus card shows the same clock and drives the same timer.
let focusState = {
  minutes: 25,
  total: 25 * 60000,
  remaining: 25 * 60000,
  endsAt: 0,
  running: false,
};

function widgetSize(tile, expanded) {
  // The performance overlay is the one card with no surface at all: three numbers
  // floating over the game, the way a driver overlay looks.
  if (tile === 'perf') return { width: 212, height: 44 };
  if (tile === 'focus') return { width: 176, height: 190 };
  if (tile === 'library') return { width: 268, height: 300 };
  if (tile === 'clip') return { width: 268, height: 220 };
  return { width: WIDGET_W, height: expanded ? 276 : 116 };
}

function widgetTitle(tile) {
  return (
    { system: 'System', focus: 'Focus', library: 'Library', clip: 'Clipboard', perf: 'Performance' }[tile] ||
    'System'
  );
}

function widgetsFor(tile) {
  const card = widgetWins.get(tile);
  return card && !card.isDestroyed() ? card : null;
}

function eachWidget(callback) {
  for (const [tile, card] of widgetWins) {
    if (card && !card.isDestroyed()) callback(card, tile);
  }
}

function hasWidgets() {
  for (const card of widgetWins.values()) if (card && !card.isDestroyed()) return true;
  return false;
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
function startWidgetDrag(target, grab) {
  stopWidgetDrag();
  if (!target || target.isDestroyed()) return;
  widgetDragWin = target;
  widgetDragOrigin = grab;
  widgetDragTimer = setInterval(() => {
    if (!widgetDragWin || widgetDragWin.isDestroyed()) {
      stopWidgetDrag();
      return;
    }
    const point = cursorDip();
    const tile = widgetDragWin.__tile || 'system';
    const size = widgetSize(tile, tile === 'system' && widgetExpanded);
    // setBounds, not setPosition: on scaled Windows displays a bare
    // setPosition can make the transparent window creep wider on every call.
    widgetDragWin.setBounds({
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
  widgetDragWin = null;
}

function finishWidgetDrag() {
  const target = widgetDragWin;
  if (!target || target.isDestroyed()) {
    stopWidgetDrag();
    return;
  }
  const bounds = target.getBounds();
  const pos = clampWidget(bounds.x, bounds.y, bounds.width, bounds.height);
  stopWidgetDrag();
  target.setPosition(pos.x, pos.y);
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

// The surface alone, for when the material changes but the backdrop does not:
// a dragged-out card has to follow the panel without re-sampling the desktop.
function sendWidgetSurface() {
  const surface = prefs.settings.material === 'black' ? 'black' : 'glass';
  eachWidget((card) => card.webContents.send('widget:backdrop', { surface }));
}

function sendWidgetBackdrop() {
  const backdrop = widgetBackdrop();
  // A dragged-out card follows the panel's surface too, so the material still
  // reaches it when there is no image to refract.
  const surface = prefs.settings.material === 'black' ? 'black' : 'glass';
  const payload = backdrop ? { ...backdrop, surface } : { surface };
  eachWidget((card) => card.webContents.send('widget:backdrop', payload));
}

// ------------------------------------------------------------------ taskbar

// A thin strip of the windows you have open, pinned to the bottom edge. It can
// be one glass bar, one glass island per app, or nothing but the icons.
const TASKBAR_H = 52;
const TASKBAR_LIFT = 10;
const TASKBAR_ITEM = 40;
const TASKBAR_SEP = 6;
const TASKBAR_PAD = 8;

let taskbarWin = null; // apps island, or the whole bar when attached
let taskbarTrayWin = null; // tray island, islands shape only
let taskbarBuiltShape = '';
let taskbarTimer = null;
let taskbarItems = [];
let taskbarApps = [];
let taskbarBusy = false;
let taskbarPeekTimer = null;
let taskbarRevealed = false;
let taskbarLeaveTimer = null;
// Mid-slide height of the bar, null when it is parked; the islands share it so
// they always move as one.
let taskbarY = null;
let taskbarSlideTimer = null;
// Each window measures itself: the apps island in the middle, the tray island on
// the right, and one bar when the shape is attached.
let taskbarWidths = { apps: 300, tray: 250, both: 620 };
// The bar sits along the bottom edge, exactly where Windows keeps its own
// taskbar, so a window that covers the whole strip would be a wall over it. Each
// window reports the boxes it actually paints; the pointer decides whether that
// window takes the click or lets it fall through.
let taskbarHitRects = new Map(); // window id -> drawn boxes, window coordinates
let taskbarIgnoring = new Map(); // window id -> whether clicks pass through
let taskbarMouseTimer = null;

// ------------------------------------------------------------------ tray

let trayItems = [];
let trayTimer = null;
let trayBusy = false;
let trayListBuffer = null;
let trayRequest = null;
let traySignature = '';
let trayBattery = null;
let trayShotRequest = null;
let iconRequest = null;
const hwndIconCache = new Map();
// Icon pictures, kept by name. With the Windows bar hidden there are no pixels
// left to lift an icon from, so a name seen once still knows what it looked like.
const trayIconByName = new Map();

// Hover list for an app with several windows, the way the Windows taskbar
// stacks its thumbnails under one button.
let flyoutWin = null;
let flyoutKey = null;
let flyoutPoll = null;
let flyoutOutside = 0;
let flyoutBounds = null;
let flyoutLeft = 0;
// True while the bar's own right-click menu is open, so auto-hide leaves the bar
// alone underneath it.
let taskbarMenuOpen = false;


function taskbarOn() {
  return !!prefs.settings.taskbar;
}

// The bar wears the same surface as the notch: black when the panel is black,
// glass when it is glass, and nothing but icons when it is set to invisible.
function taskbarMode() {
  const hidden = prefs.settings.taskbarStyle === 'hidden';
  const black = prefs.settings.material === 'black';
  return {
    style: hidden ? 'hidden' : black ? 'black' : 'glass',
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

// Islands put the apps in the middle of the screen and the tray against the
// right edge; attached is one bar holding both.
function taskbarGeometry(hidden, zone = 'both') {
  const display = screen.getPrimaryDisplay();
  // Attached is one bar along the whole bottom edge, the way Windows has one: that
  // is what puts the clock and the notification tray against the right side of the
  // screen instead of against the edge of a floating strip near the middle.
  const attached = zone === 'both' && taskbarMode().shape !== 'islands';
  const width = attached
    ? display.bounds.width
    : Math.min(
        display.bounds.width - 40,
        Math.max(zone === 'tray' ? 140 : 200, Math.round(taskbarWidths[zone] || 300)),
      );
  const height = TASKBAR_H + TASKBAR_LIFT;
  const bottom = display.bounds.y + display.bounds.height;
  const x = attached
    ? display.bounds.x
    : zone === 'tray'
      ? display.bounds.x + display.bounds.width - width - 10
      : display.bounds.x + (display.bounds.width - width) / 2;
  return {
    x: Math.round(x),
    y: hidden ? bottom : bottom - height,
    width,
    height,
    bottom,
  };
}

function taskbarBounds(zone = 'both') {
  return taskbarGeometry(taskbarAutoHide() && !taskbarRevealed, zone);
}

// The windows the bar currently lives in, with the zone each one draws.
function taskbarZones() {
  const islands = taskbarMode().shape === 'islands';
  return [
    { zone: islands ? 'apps' : 'both', win: taskbarWin },
    { zone: 'tray', win: islands ? taskbarTrayWin : null },
  ];
}

// One place for every window move, so a slide in progress is not undone by the
// next content update.
function applyTaskbarBounds(zone, win) {
  if (!win || win.isDestroyed()) return;
  const box = taskbarBounds(zone);
  if (taskbarY !== null) box.y = taskbarY;
  // Every content update runs through here; a window already where it belongs
  // is left alone, so a poll does not re-enter the renderer's layout each time.
  const now = win.getBounds();
  if (now.x === box.x && now.y === box.y && now.width === box.width && now.height === box.height) {
    return;
  }
  win.setBounds(box, false);
}

// Where nothing is drawn, nothing is taken: the bar's empty stretches belong to
// whatever is behind them, which on the bottom edge is the real taskbar.
function syncTaskbarMouse(point) {
  for (const { win } of taskbarZones()) {
    if (!win || win.isDestroyed()) continue;
    const box = win.getBounds();
    const reported = taskbarHitRects.get(win.id);
    // Until the surface has been measured the whole window counts as drawn,
    // which is what it did before it reported anything.
    const rects = reported || [{ x: 0, y: 0, width: box.width, height: box.height }];
    const inside = rects.some(
      (r) =>
        point.x >= box.x + r.x &&
        point.x <= box.x + r.x + r.width &&
        point.y >= box.y + r.y &&
        point.y <= box.y + r.y + r.height,
    );
    const ignore = !inside;
    if (taskbarIgnoring.get(win.id) === ignore) continue;
    taskbarIgnoring.set(win.id, ignore);
    win.setIgnoreMouseEvents(ignore, { forward: true });
  }
}

function startTaskbarMouseSync() {
  if (taskbarMouseTimer) return;
  // A cursor read on the same slow beat as the auto-hide peek: this is a
  // question only the pointer can answer, and it repaints nothing.
  taskbarMouseTimer = setInterval(() => {
    if (!taskbarOn() || gameMode) return;
    syncTaskbarMouse(cursorDip());
  }, 40);
}

function stopTaskbarMouseSync() {
  if (taskbarMouseTimer) clearInterval(taskbarMouseTimer);
  taskbarMouseTimer = null;
}

// Auto-hide slides the islands out of the bottom edge: ease out on the way up,
// ease in on the way down, and both islands on the same clock.
function slideTaskbar(revealed) {
  const zones = taskbarZones().filter(({ win }) => win && !win.isDestroyed());
  if (!zones.length) return;
  if (taskbarSlideTimer) clearInterval(taskbarSlideTimer);
  taskbarSlideTimer = null;
  const shownY = taskbarGeometry(false, 'both').y;
  const offY = taskbarGeometry(true, 'both').y;
  const from = taskbarY === null ? (revealed ? offY : shownY) : taskbarY;
  const to = revealed ? shownY : offY;
  const duration = revealed ? 200 : 150;
  if (from === to) {
    taskbarY = null;
    for (const { zone, win } of zones) applyTaskbarBounds(zone, win);
    return;
  }
  const started = Date.now();
  const step = () => {
    const t = Math.min(1, (Date.now() - started) / duration);
    const eased = revealed ? 1 - Math.pow(1 - t, 3) : t * t * t;
    taskbarY = Math.round(from + (to - from) * eased);
    for (const { zone, win } of zones) applyTaskbarBounds(zone, win);
    if (t >= 1) {
      clearInterval(taskbarSlideTimer);
      taskbarSlideTimer = null;
      taskbarY = null;
      for (const { zone, win } of zones) applyTaskbarBounds(zone, win);
    }
  };
  taskbarSlideTimer = setInterval(step, 16);
  step();
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

// The icon a window draws for itself. Reading one out of the executable needs a
// path, and packaged apps (the Store Notepad, Settings, anything UWP) refuse to
// hand one out, which left those buttons showing initials.
// One question at a time on the helper's stdin: its answers are a single line
// each, and two requests in flight used to answer the wrong question.
let hookAskChain = Promise.resolve();

function askHook(command, prefix, timeout = 1500) {
  const run = () =>
    new Promise((resolve) => {
      const proc = hookProc;
      if (!proc || proc.killed || !proc.stdin || proc.stdin.destroyed) {
        resolve('');
        return;
      }
      let done = false;
      const finish = (value) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (iconRequest === request) iconRequest = null;
        resolve(value);
      };
      const timer = setTimeout(() => finish(''), timeout);
      const request = { resolve: finish, prefix };
      iconRequest = request;
      try {
        proc.stdin.write(`${command}\n`);
      } catch {
        finish('');
      }
    });
  const next = hookAskChain.then(run, run);
  hookAskChain = next.catch(() => '');
  return next;
}

function requestWindowIcon(hwnd, timeout = 1500) {
  return askHook(`icons ${Math.trunc(Number(hwnd) || 0)}`, 'ICO\t', timeout);
}

function requestHostExe(hwnd) {
  return askHook(`hostexe ${Math.trunc(Number(hwnd) || 0)}`, 'EXE\t');
}

function requestExeIcon(path) {
  return askHook(`exeicon ${path}`, 'ICO\t');
}

// The icon inside an executable's resource. Electron's own file-icon call hands
// back the generic application bitmap for some apps that do ship an icon, so the
// resource is read directly and only then falls back.
const resourceIconCache = new Map();

async function exeResourceIcon(path) {
  const key = String(path || '').toLowerCase();
  if (!key || !/[\\/]/.test(key)) return null;
  if (resourceIconCache.has(key)) return resourceIconCache.get(key);
  const data = await requestExeIcon(path);
  const icon = data && data !== '-' ? `data:image/png;base64,${data}` : null;
  if (resourceIconCache.size > 160) resourceIconCache.clear();
  resourceIconCache.set(key, icon);
  return icon;
}

async function windowIcon(hwnd) {
  if (!Number.isFinite(hwnd) || hwnd <= 0) return null;
  if (hwndIconCache.has(hwnd)) return hwndIconCache.get(hwnd);
  const found = await requestWindowIcon(hwnd);
  const icon = found && found !== '-' ? `data:image/png;base64,${found}` : null;
  if (hwndIconCache.size > 240) hwndIconCache.clear();
  hwndIconCache.set(hwnd, icon);
  return icon;
}

// The executable of the app inside a packaged window, which is the one that has
// the app's icon rather than the shared host's blank window.
const hostExeCache = new Map();

async function hostExe(hwnd) {
  if (!Number.isFinite(hwnd) || hwnd <= 0) return '';
  if (hostExeCache.has(hwnd)) return hostExeCache.get(hwnd);
  const path = (await requestHostExe(hwnd)) || '';
  if (hostExeCache.size > 120) hostExeCache.clear();
  hostExeCache.set(hwnd, path);
  return path;
}

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

// A window with no document title reports its own path (cmd.exe shows up as
// C:\WINDOWS\system32\cmd.exe). The bar should say "cmd", not the path.
function friendlyTitle(title, exe) {
  const value = String(title || '').trim();
  if (!/[\\/]/.test(value) || !/\.exe$/i.test(value)) return value;
  const fromTitle = value.split(/[\\/]/).pop().replace(/\.exe$/i, '');
  const fromExe = String(exe || '').split(/[\\/]/).pop().replace(/\.exe$/i, '');
  return fromTitle || fromExe || value;
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
    // A bare process name (no directory) means the path could not be read, so
    // the file icon is out of reach: ask the window for the icon it paints.
    // Store apps run inside a shared host, whose path and icon belong to the
    // host rather than the app, so they take the same route.
    const hosted = base === 'applicationframehost.exe';
    const hasPath = /[\\/]/.test(String(exe || '')) && !hosted;
    const appExe = hasPath ? '' : hosted ? await hostExe(hwnd) : '';
    // The executable's own resource first: it is the icon the app was built
    // with, where Chromium's file icon can be the generic blank window.
    const icon =
      (hasPath ? (await exeResourceIcon(exe)) || (await iconForExe(exe)) : null) ||
      (appExe ? (await exeResourceIcon(appExe)) || (await iconForExe(appExe)) : null) ||
      (await windowIcon(hwnd)) ||
      // A packaged window whose app process cannot be found still gets a
      // picture rather than initials.
      (String(exe || '').includes('\\') ? await iconForExe(exe) : null);
    items.push({
      hwnd,
      title: friendlyTitle(title, exe),
      icon,
      exe: hosted ? '' : String(exe || ''),
    });
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

// Encoding a full-screen frame for the sheet's glass blocks this thread for a tenth
// of a second or more, and Chromium hands the keyboard over from here too — so a
// show never waits for it. Each frame is encoded once, kept, and a fresh one is
// prepared right after the sheet is up, ready for the next press.
const backdropEncodings = new WeakMap();
let launcherBackdrop = null;
let backdropWarming = false;

function backdropImage() {
  const display = screen.getPrimaryDisplay();
  if (usesLiveBackdrop() && desktopFrame) return desktopFrame.image;
  return wallpaperFitted(display);
}

function encodeBackdrop(image) {
  const hit = backdropEncodings.get(image);
  if (hit) return hit;
  const display = screen.getPrimaryDisplay();
  const payload = {
    url: `data:image/jpeg;base64,${image.toJPEG(72).toString('base64')}`,
    width: display.bounds.width,
    height: display.bounds.height,
    x: display.bounds.x,
    y: display.bounds.y,
  };
  backdropEncodings.set(image, payload);
  return payload;
}

function taskbarBackdrop() {
  const image = backdropImage();
  return image ? encodeBackdrop(image) : null;
}

function warmLauncherBackdrop() {
  if (backdropWarming) return;
  backdropWarming = true;
  setImmediate(() => {
    try {
      const image = backdropImage();
      if (image) launcherBackdrop = { image, payload: encodeBackdrop(image) };
    } catch {
      /* the frame can be mid-swap; the one from last time still fits */
    }
    backdropWarming = false;
  });
}

// The islands refract the desktop right behind them. A strip per window costs a
// few kilobytes and no compositor frame, so it can be taken often enough to be
// live: the windows are excluded from captures, so the strip is the bare desktop.
let taskbarBackdropTimer = null;

async function sendTaskbarBackdrop() {
  const zones = taskbarZones().filter(({ win }) => win && !win.isDestroyed() && win.isVisible());
  if (!zones.length) return;
  if (usesLiveBackdrop()) {
    if (protectSurfaces()) await new Promise((resolve) => setTimeout(resolve, 80));
    // A grab can come back empty — a locked desktop, a display that is asleep,
    // content the shell will not hand over. The lens still has to refract
    // something, so the wallpaper (or the last desktop frame) stands in rather
    // than leaving the bar with no picture at all.
    const fallback = taskbarBackdrop();
    for (const { win } of zones) {
      if (win.isDestroyed() || !win.isVisible()) continue;
      const box = win.getBounds();
      const strip = await requestScreenShot({
        x: box.x,
        y: box.y,
        width: box.width,
        height: box.height,
      });
      if (win.isDestroyed()) continue;
      if (!strip || !strip.data) {
        if (fallback) win.webContents.send('taskbar:backdrop', fallback);
        continue;
      }
      win.webContents.send('taskbar:backdrop', {
        url: `data:image/png;base64,${strip.data}`,
        width: box.width,
        height: box.height,
        x: box.x,
        y: box.y,
      });
    }
    return;
  }
  const backdrop = taskbarBackdrop();
  if (!backdrop) return;
  for (const { win } of zones) win.webContents.send('taskbar:backdrop', backdrop);
}

// A strip of the desktop behind one of our windows, for a surface that wears the
// liquid-glass lens: the pane refracts what is really there, not a wallpaper.
async function sendRegionShot(win, channel) {
  if (!win || win.isDestroyed() || !win.isVisible()) return;
  protectSurface(win);
  const box = win.getBounds();
  const strip = await requestScreenShot({
    x: box.x,
    y: box.y,
    width: box.width,
    height: box.height,
  });
  if (!strip || !strip.data || win.isDestroyed()) return;
  win.webContents.send(channel, {
    url: `data:image/png;base64,${strip.data}`,
    width: box.width,
    height: box.height,
  });
}

function startTaskbarBackdropLoop() {
  if (taskbarBackdropTimer) return;
  sendTaskbarBackdrop();
  taskbarBackdropTimer = setInterval(() => {
    if (gameMode || !taskbarOn() || !usesLiveBackdrop()) return;
    sendTaskbarBackdrop();
  }, 1500);
}

function stopTaskbarBackdropLoop() {
  clearInterval(taskbarBackdropTimer);
  taskbarBackdropTimer = null;
}

// ------------------------------------------------------------- taskbar tray

function requestTrayList(timeout = 2500) {
  const proc = hookProc;
  if (!proc || proc.killed || !proc.stdin || proc.stdin.destroyed) return Promise.resolve(null);
  if (trayRequest) return trayRequest.promise;
  const request = { promise: null, finish: null, done: false };
  request.promise = new Promise((resolve) => {
    const timer = setTimeout(() => finish(null), timeout);
    function finish(value) {
      if (request.done) return;
      request.done = true;
      clearTimeout(timer);
      if (trayRequest === request) {
        trayRequest = null;
        // A list that timed out leaves its buffer behind, and every line after it —
        // the Windows key included — would be read as a row of a list that is gone.
        trayListBuffer = null;
      }
      resolve(value);
    }
    request.finish = finish;
    trayRequest = request;
    trayListBuffer = [];
    try {
      proc.stdin.write('tray\n');
    } catch {
      finish(null);
    }
  });
  return request.promise;
}

// The helper grabs a rectangle of the desktop with GDI. Ask it for the strip
// that holds the tray icons; it answers with a base64 PNG.
// The helper answers one grab at a time on its stdout, so requests queue: the
// tray icons and the islands both ask for strips, and an overlapping request
// used to swallow the other one's image.
let shotChain = Promise.resolve();

function requestScreenShot(rect, timeout = 2500) {
  const run = () =>
    new Promise((resolve) => {
      const proc = hookProc;
      if (!proc || proc.killed || !proc.stdin || proc.stdin.destroyed) {
        resolve(null);
        return;
      }
      let done = false;
      const finish = (value) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (trayShotRequest === request) trayShotRequest = null;
        resolve(value);
      };
      const timer = setTimeout(() => finish(null), timeout);
      const request = { resolve: finish };
      trayShotRequest = request;
      try {
        proc.stdin.write(`shot ${rect.x} ${rect.y} ${rect.width} ${rect.height}\n`);
      } catch {
        finish(null);
      }
    });
  const next = shotChain.then(run, run);
  shotChain = next.catch(() => null);
  return next;
}

// Icons are pixels, not API: the notification area draws them itself, so take
// them off the screen once per change instead of asking for something Windows
// does not hand out.
async function captureTrayIcons() {
  // Only icons that are on screen have pixels to lift; the rest keep whatever
  // picture they were last seen with.
  const pictured = trayItems.filter((row) => row.w > 0 && row.h > 0 && !row.icon);
  if (!pictured.length) return;
  const display = screen.getPrimaryDisplay();
  const scale = display.scaleFactor || 1;
  // The tray island sits over the notification area, and the capture is the
  // composited desktop: any window of ours covering the icons has to step aside
  // for the moment the screen is read, or we photograph our own bar.
  const box = {
    left: Math.min(...pictured.map((row) => row.x)) - 2,
    top: Math.min(...pictured.map((row) => row.y)) - 2,
    right: Math.max(...pictured.map((row) => row.x + row.w)) + 2,
    bottom: Math.max(...pictured.map((row) => row.y + row.h)) + 2,
  };
  const stepped = [];
  for (const { win } of taskbarZones()) {
    if (!win || win.isDestroyed() || !win.isVisible()) continue;
    const bounds = win.getBounds();
    const x = bounds.x * scale;
    const y = bounds.y * scale;
    const w = bounds.width * scale;
    const h = bounds.height * scale;
    if (x < box.right && x + w > box.left && y < box.bottom && y + h > box.top) stepped.push(win);
  }
  for (const win of stepped) win.hide();
  if (stepped.length) await new Promise((resolve) => setTimeout(resolve, 70));
  try {
    const strip = await requestScreenShot({
      x: Math.round(box.left),
      y: Math.round(box.top),
      width: Math.round(box.right - box.left),
      height: Math.round(box.bottom - box.top),
    });
    if (!strip || !strip.data) return;
    const image = nativeImage.createFromBuffer(Buffer.from(strip.data, 'base64'));
    if (image.isEmpty()) return;
    const size = image.getSize();
    // The strip comes back in the same space as the rects it was cut from; the
    // ratio only guards against a scaled bitmap.
    const ratioX = size.width / Math.max(1, strip.width);
    const ratioY = size.height / Math.max(1, strip.height);
    for (const item of pictured) {
      const side = Math.max(8, Math.round(Math.min(item.w, item.h, 32) * ratioX));
      const x = Math.round((item.x - box.left + item.w / 2) * ratioX - side / 2);
      const y = Math.round((item.y - box.top + item.h / 2) * ratioY - side / 2);
      if (x < 0 || y < 0 || x + side > size.width || y + side > size.height) continue;
      const crop = image.crop({ x, y, width: side, height: side });
      if (crop && !crop.isEmpty()) {
        item.icon = crop.resize({ width: 36, height: 36 }).toDataURL();
        trayIconByName.set(item.name, item.icon);
      }
    }
  } catch {
    /* no capture rights: the tray falls back to tooltips only */
  } finally {
    for (const win of stepped) if (!win.isDestroyed() && !win.isVisible()) win.showInactive();
  }
}

async function refreshTray(force) {
  if (gameMode || trayBusy) return;
  trayBusy = true;
  try {
    const raw = await requestTrayList();
    if (!raw) return;
    // Keep the icons already in hand: a capture can fail (a busy desktop, a
    // moment where the screen is not readable), and a dot is worse than a
    // picture that is a second old.
    const previous = new Map(trayItems.map((row) => [`${row.name}|${row.x}|${row.y}`, row.icon]));
    const rows = [];
    let clockLeft = null;
    for (const line of raw) {
      const [index, x, y, w, h, cls, ...rest] = String(line).split('\t');
      const name = rest.join(' ').trim();
      if (cls === 'SystemTray.OmniButton') {
        // The chevron's own place marks the clock; with the bar hidden it has no
        // place, and guessing one would make every icon look like the battery.
        if (Number(w) > 0 && Number(h) > 0) clockLeft = Number(x);
        continue;
      }
      if (cls === 'SystemTray.ShowDesktopButton') continue;
      rows.push({
        i: Number(index),
        x: Number(x),
        y: Number(y),
        w: Number(w),
        h: Number(h),
        name: name.split(/\s{2,}/)[0],
      });
    }
    // The battery lives in the tray. Its tooltip carries the charge, and the bar
    // draws that as its own chip instead of a second battery icon. Find it by
    // what it says, not by where it sits: the notification area moves with the
    // Windows taskbar, and the old "left of the clock" rule left a duplicate
    // battery on a vertical bar.
    const byName = rows.filter(
      (row) => /\d{1,3}\s*%/.test(row.name) && /batter|akku|kraft|batteri/i.test(row.name),
    );
    const power = byName.length
      ? byName
      : clockLeft === null
        ? []
        : rows.filter((row) => Math.abs(row.x + row.w - clockLeft) <= 18);
    for (const row of power) {
      const match = /(\d{1,3})\s*%/.exec(row.name);
      if (match) trayBattery = Number(match[1]);
    }
    trayItems = rows
      .filter((row) => !power.includes(row))
      .map((row) => ({
        ...row,
        icon: previous.get(`${row.name}|${row.x}|${row.y}`) || trayIconByName.get(row.name) || null,
      }));
    // The charge comes from the battery icon's tooltip, so it belongs in the
    // signature: the chip has to change when the percentage does.
    const signature = `${trayBattery}|${trayItems.map((row) => `${row.i}:${row.x}:${row.name}`).join('|')}`;
    if (signature !== traySignature) {
      traySignature = signature;
      await captureTrayIcons();
      sendTaskbarUpdate();
    } else if (force) {
      sendTaskbarUpdate();
    }
  } finally {
    trayBusy = false;
  }
}

function startTrayPolling() {
  if (trayTimer) return;
  refreshTray();
  trayTimer = setInterval(refreshTray, 6000);
}

function stopTrayPolling() {
  clearInterval(trayTimer);
  trayTimer = null;
  trayItems = [];
  traySignature = '';
}

// ------------------------------------------------------------ taskbar flyout

function findTaskbarApp(key) {
  if (!key) return null;
  return taskbarApps.find((app) => app.key === key) || null;
}

function createFlyout() {
  if (flyoutWin && !flyoutWin.isDestroyed()) return flyoutWin;
  flyoutWin = new BrowserWindow({
    width: 240,
    height: 120,
    x: 0,
    y: 0,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    thickFrame: false,
    roundedCorners: false,
    // Resizable so the list can size itself to its rows; there is no frame to
    // drag, so the user never sees that.
    resizable: true,
    movable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: false,
    show: false,
    title: 'Taskbar menu',
    webPreferences: {
      preload: path.join(__dirname, 'taskbar-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });
  flyoutWin.setMenu(null);
  flyoutWin.setAlwaysOnTop(true, 'screen-saver');
  flyoutWin.setSkipTaskbar(true);
  flyoutWin.setFocusable(false);
  // Its own glass needs the desktop behind it, never its previous frame.
  protectSurface(flyoutWin);
  flyoutWin.loadFile(path.join(__dirname, 'src', 'taskbar-flyout.html'));
  flyoutWin.on('closed', () => {
    flyoutWin = null;
    stopFlyoutPoll();
  });
  return flyoutWin;
}

function stopFlyoutPoll() {
  if (flyoutPoll) clearInterval(flyoutPoll);
  flyoutPoll = null;
  flyoutOutside = 0;
}

function hideFlyout() {
  stopFlyoutPoll();
  flyoutKey = null;
  flyoutBounds = null;
  if (flyoutWin && !flyoutWin.isDestroyed() && flyoutWin.isVisible()) flyoutWin.hide();
}

// The pointer decides: it stays while it is over the button or the list, and
// closes a moment after it leaves both.
function startFlyoutPoll() {
  if (flyoutPoll) return;
  flyoutOutside = 0;
  flyoutPoll = setInterval(() => {
    if (gameMode || !flyoutWin || flyoutWin.isDestroyed() || !flyoutWin.isVisible() || !flyoutBounds) {
      stopFlyoutPoll();
      return;
    }
    const point = cursorDip();
    const box = flyoutBounds;
    const inList =
      point.x >= box.x - 6 &&
      point.x <= box.x + box.width + 6 &&
      point.y >= box.y - 4 &&
      point.y <= box.y + box.height + 10;
    // Only the button that opened the list keeps it alive under the bar: moving
    // along the bar to another button closes it, the way Windows does. Five
    // polls give the pointer time to cross the gap up into the list.
    const bar = taskbarWin && !taskbarWin.isDestroyed() ? taskbarWin.getBounds() : null;
    const inButton =
      bar &&
      point.x >= bar.x + flyoutLeft - 24 &&
      point.x <= bar.x + flyoutLeft + 24 &&
      point.y >= bar.y - 4 &&
      point.y <= bar.y + bar.height;
    if (inList || inButton) {
      flyoutOutside = 0;
      return;
    }
    flyoutOutside += 1;
    if (flyoutOutside >= 5) hideFlyout();
  }, 80);
}

function showFlyout(app, left) {
  if (!app || app.windows.length < 2 || !taskbarWin || taskbarWin.isDestroyed()) {
    hideFlyout();
    return;
  }
  const bar = taskbarWin.getBounds();
  const rows = app.windows.slice(0, 8).map((item) => ({
    hwnd: item.hwnd,
    title: item.title,
    icon: app.icon || null,
  }));
  const longest = rows.reduce((max, row) => Math.max(max, String(row.title || '').length), 0);
  const width = Math.max(196, Math.min(320, 64 + longest * 6.4));
  const height = 10 + rows.length * 36;
  const x = Math.round(Math.min(Math.max(bar.x + left - width / 2, bar.x), bar.x + bar.width - width));
  const y = Math.round(bar.y - height - 6);
  const win = createFlyout();
  flyoutBounds = { x, y, width, height };
  flyoutKey = app.key;
  flyoutLeft = left;
  win.setBounds({ x, y, width, height }, false);
  if (!win.isVisible()) win.showInactive();
  const mode = taskbarMode();
  win.webContents.send('flyout:rows', { rows, width, style: mode.style });
  // The glass refracts the strip behind the list; the solid fallback covers the
  // moment before it arrives.
  if (mode.style === 'glass') sendRegionShot(win, 'flyout:backdrop');
  startFlyoutPoll();
}

// A pin and a running app are one button, and several windows of the same app
// are one button with a list, exactly like the Windows taskbar.
function appLabel(item) {
  const exe = String(item.exe || '')
    .split(/[\\/]/)
    .pop()
    .replace(/\.exe$/i, '');
  if (exe) return exe.charAt(0).toUpperCase() + exe.slice(1);
  return String(item.title || 'App');
}

function groupTaskbarApps(items, pins) {
  const groups = [];
  const byKey = new Map();
  for (const item of items) {
    const key = String(item.exe || item.title || item.hwnd).toLowerCase();
    let group = byKey.get(key);
    if (!group) {
      group = {
        key,
        exe: String(item.exe || ''),
        name: appLabel(item),
        icon: item.icon || null,
        pin: null,
        windows: [],
      };
      byKey.set(key, group);
      groups.push(group);
    }
    if (!group.icon && item.icon) group.icon = item.icon;
    group.windows.push({ hwnd: item.hwnd, title: item.title });
  }
  const used = new Set();
  const apps = [];
  for (const pin of pins) {
    const base = String(pin.target || '')
      .split(/[\\/]/)
      .pop()
      .replace(/\.exe$/i, '')
      .toLowerCase();
    let match = null;
    if (base) {
      match = groups.find(
        (group) =>
          !used.has(group) &&
          String(group.exe)
            .split(/[\\/]/)
            .pop()
            .replace(/\.exe$/i, '')
            .toLowerCase() === base,
      );
    }
    if (!match && pin.exe) {
      const pinExe = String(pin.exe)
        .split(/[\\/]/)
        .pop()
        .replace(/\.exe$/i, '')
        .toLowerCase();
      match = groups.find(
        (group) =>
          !used.has(group) &&
          String(group.exe)
            .split(/[\\/]/)
            .pop()
            .replace(/\.exe$/i, '')
            .toLowerCase() === pinExe,
      );
    }
    if (!match) {
      // Shortcut names and process names rarely agree ("File Explorer" against
      // "Explorer", "Settings" against "Systemsettings"), so the last try is one
      // name inside the other.
      const pinName = String(pin.name || '')
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '');
      if (pinName) {
        match = groups.find((group) => {
          if (used.has(group)) return false;
          const groupName = String(group.name || '')
            .toLowerCase()
            .replace(/[^a-z0-9]/g, '');
          return !!groupName && (groupName === pinName || groupName.includes(pinName) || pinName.includes(groupName));
        });
      }
    }
    if (match) {
      used.add(match);
      apps.push({ ...match, pin, name: pin.name || match.name, icon: match.icon || pin.icon });
    } else {
      apps.push({ key: `pin:${pin.id}`, name: pin.name, icon: pin.icon, pin, windows: [] });
    }
  }
  for (const group of groups) if (!used.has(group)) apps.push({ ...group, pin: null });
  return apps;
}

function taskbarBattery() {
  let charging = true;
  try {
    charging = !powerMonitor.isOnBatteryPower();
  } catch {
    /* keep the default */
  }
  const percent = Number.isFinite(trayBattery) ? trayBattery : battery;
  return { percent: Number.isFinite(percent) ? percent : null, charging };
}

function taskbarPayload() {
  const items = taskbarOpenItems();
  const pinned = taskbarPinned();
  taskbarApps = groupTaskbarApps(items, pinned);
  return {
    apps: taskbarApps,
    tray: trayItems.map((row) => ({ i: row.i, name: row.name, icon: row.icon || null })),
    battery: taskbarBattery(),
    ...taskbarMode(),
  };
}

function sendTaskbarUpdate() {
  if (!taskbarWin || taskbarWin.isDestroyed()) return;
  const payload = taskbarPayload();
  for (const { zone, win } of taskbarZones()) {
    if (!win || win.isDestroyed()) continue;
    win.webContents.send('taskbar:update', payload);
    applyTaskbarBounds(zone, win);
  }
  // The apps island stays even with nothing on it now: the Start button lives
  // there, and a Start menu that comes and goes is not a taskbar. The tray
  // island keeps the clock, and the attached bar holds both.
  if (!taskbarApps.length) hideFlyout();
  if (!taskbarWin.isVisible()) {
    taskbarWin.showInactive();
    sendTaskbarBackdrop();
  }
  if (taskbarTrayWin && !taskbarTrayWin.isDestroyed() && !taskbarTrayWin.isVisible()) {
    taskbarTrayWin.showInactive();
    sendTaskbarBackdrop();
  }
  if (!taskbarBackdropTimer && taskbarOn()) startTaskbarBackdropLoop();
}

async function pollTaskbar() {
  if (gameMode || !taskbarWin || taskbarWin.isDestroyed() || taskbarBusy) return;
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
  startTrayPolling();
}

function stopTaskbarPolling() {
  clearInterval(taskbarTimer);
  taskbarTimer = null;
  taskbarBusy = false;
  stopTrayPolling();
}

function createTaskbarWindow(zone) {
  const win = new BrowserWindow({
    ...taskbarBounds(zone),
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
  win.setMenu(null);
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setSkipTaskbar(true);
  win.setFocusable(false);
  win.loadFile(path.join(__dirname, 'src', 'taskbar.html'), { query: { zone } });
  win.once('ready-to-show', () => {
    if (!win || win.isDestroyed()) return;
    win.setBounds(taskbarBounds(zone), false);
    win.showInactive();
    const backdrop = taskbarBackdrop();
    if (backdrop) win.webContents.send('taskbar:backdrop', backdrop);
  });
  win.on('closed', () => {
    if (taskbarWin === win) taskbarWin = null;
    if (taskbarTrayWin === win) taskbarTrayWin = null;
    taskbarHitRects.delete(win.id);
    taskbarIgnoring.delete(win.id);
  });
  return win;
}

function createTaskbar() {
  const islands = taskbarMode().shape === 'islands';
  taskbarBuiltShape = taskbarMode().shape;
  if (!taskbarWin || taskbarWin.isDestroyed()) taskbarWin = createTaskbarWindow(islands ? 'apps' : 'both');
  if (islands) {
    if (!taskbarTrayWin || taskbarTrayWin.isDestroyed()) taskbarTrayWin = createTaskbarWindow('tray');
  } else if (taskbarTrayWin && !taskbarTrayWin.isDestroyed()) {
    taskbarTrayWin.destroy();
    taskbarTrayWin = null;
  }
  startTaskbarPolling();
  seedPinnedApps();
  startTaskbarMouseSync();
}

function destroyTaskbar() {
  hideFlyout();
  stopTaskbarPolling();
  stopTaskbarMouseSync();
  if (taskbarPeekTimer) clearInterval(taskbarPeekTimer);
  taskbarPeekTimer = null;
  if (taskbarLeaveTimer) clearTimeout(taskbarLeaveTimer);
  taskbarLeaveTimer = null;
  taskbarRevealed = false;
  taskbarItems = [];
  if (taskbarWin && !taskbarWin.isDestroyed()) taskbarWin.destroy();
  taskbarWin = null;
  if (taskbarTrayWin && !taskbarTrayWin.isDestroyed()) taskbarTrayWin.destroy();
  taskbarTrayWin = null;
  taskbarBuiltShape = '';
  if (taskbarSlideTimer) clearInterval(taskbarSlideTimer);
  taskbarSlideTimer = null;
  taskbarY = null;
  stopTaskbarBackdropLoop();
}

// Notch's bar is meant to be the taskbar, so the real one can be taken out of
// the way while it is on. The shell's bar is only hidden, never removed, and it
// is put back on every way out: the setting off, Notch's bar off, a game taking
// the screen, or the app quitting. A helper that dies leaves the bar where it
// was, so the next one is told the wanted state the moment it reports ready.
let nativeTaskbarHidden = false;
let quitBarRestored = false;

function nativeTaskbarWanted() {
  return isWin && !gameMode && taskbarOn() && !!prefs.settings.hideWinTaskbar;
}

async function sendNativeTaskbarState(force = false) {
  const want = nativeTaskbarWanted();
  if (!force && want === nativeTaskbarHidden) return;
  if (!hookProc || !hookProc.stdin || hookProc.stdin.destroyed) return;
  // The notification area's icons are pixels on Windows' own bar, so once it is
  // hidden there is nothing to photograph. Take the pictures first, while they
  // are still on screen, and the tray Notch draws keeps them.
  if (want && !nativeTaskbarHidden && !trayBusy && !trayItems.some((row) => row.icon)) {
    try {
      traySignature = '';
      await refreshTray(true);
    } catch {
      /* no answer: the tray falls back to names and dots */
    }
    if (!hookProc || !hookProc.stdin || hookProc.stdin.destroyed) return;
  }
  try {
    hookProc.stdin.write(want ? 'taskbarhide\n' : 'taskbarshow\n');
    nativeTaskbarHidden = want;
  } catch {
    /* the next helper is told again when it reports ready */
  }
}

function refreshTaskbar() {
  sendNativeTaskbarState();
  if (!taskbarOn()) {
    destroyTaskbar();
    return;
  }
  // Switching shape moves the bar between one window and two, so rebuild.
  if (taskbarWin && !taskbarWin.isDestroyed() && taskbarBuiltShape !== taskbarMode().shape) {
    if (taskbarTrayWin && !taskbarTrayWin.isDestroyed()) taskbarTrayWin.destroy();
    taskbarTrayWin = null;
    taskbarWin.destroy();
    taskbarWin = null;
    taskbarBuiltShape = '';
  }
  if (!taskbarWin || taskbarWin.isDestroyed()) createTaskbar();
  else sendTaskbarUpdate();
  syncTaskbarPeek();
  syncDesktopSampling();
}

// Auto-hide: the bar waits just past the bottom edge and comes up when the
// pointer touches that edge, or when the launcher opens. The poll only runs
// while the setting is on, and it is a single cursor read every 120 ms.
function setTaskbarRevealed(revealed) {
  if (taskbarRevealed === revealed) return;
  taskbarRevealed = revealed;
  if (!taskbarOn()) return;
  slideTaskbar(revealed);
}

function revealTaskbar() {
  if (gameMode || !taskbarAutoHide() || !taskbarOn()) return;
  if (taskbarLeaveTimer) clearTimeout(taskbarLeaveTimer);
  taskbarLeaveTimer = null;
  setTaskbarRevealed(true);
}

function tickTaskbarPeek() {
  if (gameMode || !taskbarWin || taskbarWin.isDestroyed() || !taskbarOn() || !taskbarAutoHide()) return;
  // While the Start sheet is open the bar stays out, the way Windows keeps its
  // taskbar up until Start closes again.
  if (launcherWin && !launcherWin.isDestroyed() && launcherWin.isVisible()) {
    if (taskbarLeaveTimer) clearTimeout(taskbarLeaveTimer);
    taskbarLeaveTimer = null;
    return;
  }
  // A menu the bar opened, or the window list above it, is an anchor: sliding
  // the bar away would take it out from under the pointer and the menu with it.
  if (taskbarMenuOpen || (flyoutWin && !flyoutWin.isDestroyed() && flyoutWin.isVisible())) {
    if (taskbarLeaveTimer) clearTimeout(taskbarLeaveTimer);
    taskbarLeaveTimer = null;
    return;
  }
  const zones = taskbarZones();
  const shown = zones.map(({ zone }) => taskbarGeometry(false, zone));
  const point = cursorDip();
  const atEdge = point.y >= shown[0].bottom - 2;
  const over = shown.some(
    (box) => point.x >= box.x - 6 && point.x <= box.x + box.width + 6 && point.y >= box.y - 2 && point.y <= box.bottom,
  );
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
  // Eight times a second is the price of a taskbar that appears the moment the
  // cursor touches the edge; a game should not pay it.
  const wanted = taskbarOn() && taskbarAutoHide() && !gameMode;
  if (!wanted) {
    if (taskbarPeekTimer) clearInterval(taskbarPeekTimer);
    taskbarPeekTimer = null;
    if (taskbarLeaveTimer) clearTimeout(taskbarLeaveTimer);
    taskbarLeaveTimer = null;
    taskbarRevealed = false;
  } else if (!taskbarPeekTimer) {
    taskbarPeekTimer = setInterval(tickTaskbarPeek, 120);
  }
  for (const { zone, win } of taskbarZones()) applyTaskbarBounds(zone, win);
}

// The button left of the pins is the Start menu's job: the launcher already is
// the list of everything installed, so it is what opens.
ipcMain.on('taskbar:start', () => showLauncher());

// The right end of the bar without the notification-area helper: the three
// things a tray is reached for open their Windows pages directly.
const TASKBAR_SYSTEM_URIS = {
  network: 'ms-availablenetworks:',
  sound: 'ms-settings:sound',
  settings: 'ms-settings:',
};

ipcMain.on('taskbar:system', (_event, kind) => {
  const uri = TASKBAR_SYSTEM_URIS[String(kind || '')];
  if (uri) shell.openExternal(uri);
});

ipcMain.on('taskbar:ready', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win && !win.isDestroyed()) {
    win.webContents.send('taskbar:update', taskbarPayload());
    const backdrop = taskbarBackdrop();
    if (backdrop) win.webContents.send('taskbar:backdrop', backdrop);
  }
  sendTaskbarUpdate();
  refreshTray(true);
});

// Each island measures what it needs, so its window is exactly as wide as its
// contents: the apps in the middle, the tray and clock against the right edge.
ipcMain.on('taskbar:size', (event, payload) => {
  const zone = payload && (payload.zone === 'tray' || payload.zone === 'apps' || payload.zone === 'both')
    ? payload.zone
    : 'both';
  const next = Math.round(Number(payload && payload.width) || 0);
  if (next < 120) return;
  if (Math.abs(next - taskbarWidths[zone]) < 3) return;
  taskbarWidths[zone] = next;
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win && !win.isDestroyed()) win.setBounds(taskbarBounds(zone), false);
});

// The surface says which boxes it paints, and keeps saying it after every
// layout: a bar that moved or emptied must not keep hold of a stretch it no
// longer covers.
ipcMain.on('taskbar:hit', (event, payload) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed()) return;
  const rows = Array.isArray(payload && payload.rects) ? payload.rects : [];
  taskbarHitRects.set(
    win.id,
    rows
      .map((row) => ({
        x: Math.round(Number(row && row.x) || 0),
        y: Math.round(Number(row && row.y) || 0),
        width: Math.round(Number(row && row.width) || 0),
        height: Math.round(Number(row && row.height) || 0),
      }))
      .filter((row) => row.width > 0 && row.height > 0),
  );
  syncTaskbarMouse(cursorDip());
});

ipcMain.on('taskbar:hover', (_event, payload) => {
  const key = payload && payload.key;
  const left = Number(payload && payload.left) || 0;
  showFlyout(findTaskbarApp(key), left);
});

// Leaving a button no longer takes the window list with it: the list sits above
// the bar, so the pointer has to cross the gap to reach it. Its own poll closes
// it once the pointer is really away, or over a different button.
ipcMain.on('taskbar:hover-end', () => {});

ipcMain.on('taskbar:group', (_event, key) => {
  const app = findTaskbarApp(key);
  if (!app) return;
  hideFlyout();
  if (app.windows.length) pressTaskbarWindows(app.windows.map((row) => row.hwnd));
  else if (app.pin) launchTarget(app.pin.target);
});

ipcMain.on('taskbar:tray', (_event, index) => {
  if (!hookProc || !hookProc.stdin || hookProc.stdin.destroyed) return;
  try {
    hookProc.stdin.write(`trayclick ${Math.trunc(Number(index) || 0)}\n`);
  } catch {
    /* the helper is gone */
  }
});

// Right-click on a button is where a pin is made or broken, the way Windows'
// own bar offers it. A pin takes the executable it was pinned from, so it stays
// one button with the window it opens instead of a second one beside it.
ipcMain.on('taskbar:context', (event, payload) => {
  const app = findTaskbarApp(payload && payload.key);
  if (!app) return;
  const template = [];
  if (app.pin) {
    template.push({
      label: 'Unpin from taskbar',
      click: () => removePinnedApp(app.pin.id),
    });
  } else if (app.exe) {
    template.push({
      label: 'Pin to taskbar',
      click: () =>
        addPinnedApp({
          id: app.exe,
          name: app.name,
          target: app.exe,
          icon: app.icon || null,
          exe: app.exe,
        }),
    });
  }
  if (!template.length) return;
  const win = BrowserWindow.fromWebContents(event.sender);
  // Auto-hide stands down while the menu is up, or the poll would slide the bar
  // (and the menu's anchor) off the screen as the pointer leaves the bar.
  taskbarMenuOpen = true;
  try {
    Menu.buildFromTemplate(template).popup({
      window: win && !win.isDestroyed() ? win : undefined,
      callback: () => {
        taskbarMenuOpen = false;
      },
    });
  } catch {
    taskbarMenuOpen = false;
  }
});

// Dragging a pinned button ends with the pins in the order it left them in.
ipcMain.on('taskbar:reorder', (_event, payload) => {
  reorderPinnedApps(payload && payload.order);
});

// The chevron opens Windows' own panel of hidden notification icons: the shell
// draws those icons and hangs their menus off them, so pressing the shell's
// chevron is what gives every one of them back.
ipcMain.on('taskbar:overflow', () => {
  if (hookProc && hookProc.stdin && !hookProc.stdin.destroyed) {
    try {
      hookProc.stdin.write('trayoverflow\n');
      return;
    } catch {
      /* fall through to the helper process */
    }
  }
  // No keyboard hook to ask: the same script presses the chevron on its own.
  execFile(
    'powershell',
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      path.join(__dirname, 'winhook.ps1'),
      '-Overflow',
    ],
    { windowsHide: true, timeout: 12000 },
    () => {},
  );
});

ipcMain.on('flyout:pick', (_event, hwnd) => {
  hideFlyout();
  activateTaskbarWindow(Number(hwnd));
});

ipcMain.on('flyout:ready', () => {
  if (flyoutKey) {
    const app = findTaskbarApp(flyoutKey);
    if (app) showFlyout(app, flyoutLeft);
  }
});

// Bring a window forward: restore it if minimised, then focus it.
function focusTaskbarWindow(hwnd) {
  if (!Number.isFinite(hwnd) || hwnd <= 0) return;
  if (hookProc && hookProc.stdin && !hookProc.stdin.destroyed) {
    try {
      // The hook knows what is in front: the click that brings an app up also
      // puts it away again, the way the Windows taskbar behaves.
      hookProc.stdin.write(`toggle ${Math.trunc(hwnd)}\n`);
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

// One press on a taskbar button, the way Windows reads it: the app in front is
// put away, an app behind comes forward, and a group moves through its windows
// before any of them is minimised. The helper owns the foreground, so it is the
// one that decides.
function pressTaskbarWindows(handles) {
  const list = (Array.isArray(handles) ? handles : [])
    .map((value) => Number(value) || 0)
    .filter((value) => value > 0);
  if (!list.length) return;
  if (hookProc && hookProc.stdin && !hookProc.stdin.destroyed) {
    try {
      hookProc.stdin.write(`group ${list.join(' ')}\n`);
      return;
    } catch {
      /* fall through to the helper process below */
    }
  }
  focusTaskbarWindow(list[0]);
}

// Picking a window out of the list is a choice, not a second press: it comes
// forward, it is never put away.
function activateTaskbarWindow(hwnd) {
  if (!Number.isFinite(hwnd) || hwnd <= 0) return;
  if (hookProc && hookProc.stdin && !hookProc.stdin.destroyed) {
    try {
      hookProc.stdin.write(`activate ${Math.trunc(hwnd)}\n`);
      return;
    } catch {
      /* fall through to the helper process below */
    }
  }
  focusTaskbarWindow(hwnd);
}

// Win+<number> opens whatever the bar shows under that number: pins first, then
// running windows, exactly like the buttons left to right.
function activateTaskbarSlot(slot) {
  if (!Number.isFinite(slot) || slot < 1 || slot > 10) return;
  const app = groupTaskbarApps(taskbarOpenItems(), taskbarPinned())[slot - 1];
  if (!app) return;
  hideLauncher();
  if (app.windows.length) pressTaskbarWindows(app.windows.map((row) => row.hwnd));
  else if (app.pin) launchTarget(app.pin.target);
}

// The GPU reading is asked of the helper only while the overlay is on screen: it
// is a performance counter, and there is no reason to pay for it otherwise.
let gpuPercent = null;
let gpuBusy = false;
let gpuRequest = null;
let gpuAskedAt = 0;

function sampleGpu() {
  // The counter read is a few milliseconds in the helper: asked for at the same
  // pace as the card, and a third as often while a game is running.
  if (!hookProc || gpuBusy || Date.now() - gpuAskedAt < (gameMode ? 4000 : 1200)) return;
  gpuAskedAt = Date.now();
  gpuBusy = true;
  gpuRequest = (value) => {
    gpuPercent = Number.isFinite(value) && value >= 0 ? value : null;
  };
  try {
    hookProc.stdin.write('gpu\n');
  } catch {
    gpuBusy = false;
    gpuRequest = null;
  }
}

// 1.5 s normally; during a game the overlay and an open System card share a
// 3 s tick, which is still live on screen and half the wake-ups.
function gameStatsInterval() {
  return gameMode ? 3000 : 1500;
}

function sendWidgetStats() {
  // During a game everything else stands still, but the overlay is still being
  // watched: three readings from memory every 3 seconds cost nothing measurable.
  if (!hasWidgets() || (gameMode && !widgetsFor('perf') && !widgetsFor('system'))) return;
  const stats = currentStats();
  if (widgetsFor('perf')) sampleGpu();
  const payload = {
    cpu: Math.round(stats.cpu),
    ram: stats.ram,
    disk: stats.disk,
    focus: focusState,
    gpu: gpuPercent,
  };
  eachWidget((card) => card.webContents.send('widget:stats', payload));
}

function startWidgetStats() {
  sendWidgetStats();
  if (widgetStatsTimer) return;
  widgetStatsTimer = setInterval(sendWidgetStats, gameStatsInterval());
}

function stopWidgetStats() {
  if (hasWidgets()) return;
  clearInterval(widgetStatsTimer);
  widgetStatsTimer = null;
  stopProcSampling();
}

// The process list only runs while something is showing it: an opened System
// card, or the System view inside the panel.
function wantsProcesses() {
  return panelSystemDetail || (!!widgetsFor('system') && widgetExpanded);
}

function syncProcSampling() {
  if (wantsProcesses()) startProcSampling();
  else stopProcSampling();
}

// 3 s normally; 6 s while a game runs. The card is one of the surfaces a game
// deliberately keeps, so the list under it has to keep being filled — at half the
// wake-ups, but filled. Drawn from nothing it shows zeros, which is what a game's
// own row used to read.
function procInterval() {
  return gameMode ? 6000 : 3000;
}

function startProcSampling() {
  if (widgetProcTimer) return;
  sampleProcesses();
  widgetProcTimer = setInterval(sampleProcesses, procInterval());
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
  if (procBusy || !wantsProcesses()) return;
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
      const payload = { cpu: topCpu, ram: topRam };
      const systemCard = widgetsFor('system');
      if (systemCard && widgetExpanded) systemCard.webContents.send('widget:processes', payload);
      if (panelSystemDetail && win && !win.isDestroyed()) {
        win.webContents.send('notch:processes', payload);
      }
    },
  );
}

function setWidgetExpanded(value) {
  widgetExpanded = !!value;
  const card = widgetsFor('system');
  if (!card) return;
  const bounds = card.getBounds();
  const size = widgetSize('system', widgetExpanded);
  const pos = clampWidget(bounds.x, bounds.y, size.width, size.height);
  // setContentSize keeps the page exactly the size the layout expects; window
  // bounds on a transparent Windows window can carry invisible frame insets.
  card.setContentSize(size.width, size.height);
  card.setPosition(pos.x, pos.y);
  card.webContents.send('widget:expanded-state', widgetExpanded);
  syncProcSampling();
}

function sendTileData(tile) {
  const card = widgetsFor(tile);
  if (!card) return;
  if (tile === 'focus') card.webContents.send('widget:focus', focusState);
  else if (tile === 'clip') card.webContents.send('widget:clips', clips);
  else if (tile === 'library') card.webContents.send('widget:games', games);
  else sendWidgetStats();
}

function createWidget(tile, options = {}) {
  const card = new BrowserWindow({
    ...widgetSize(tile, tile === 'system' && widgetExpanded),
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
    title: widgetTitle(tile),
    webPreferences: {
      preload: path.join(__dirname, 'widget-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      // Warmed cards sit hidden for a long time; a shown card is never throttled.
      backgroundThrottling: true,
    },
  });
  card.__tile = tile;
  // Warmed on the way into a drag: the window is built and loaded but stays off
  // screen until the tile is actually pulled out, so it appears on the first move
  // instead of after a page load.
  card.__warm = !!options.warm;
  card.setMenu(null);
  card.setAlwaysOnTop(true, 'screen-saver');
  card.setSkipTaskbar(true);
  card.loadFile(path.join(__dirname, 'src', 'widget.html'), { query: { tile } });
  widgetWins.set(tile, card);
  // A hidden window does not paint, so ready-to-show may never come while it is
  // only warmed; a finished load is what tells us it can appear at once.
  card.webContents.once('did-finish-load', () => {
    card.__loaded = true;
  });
  card.once('ready-to-show', () => {
    if (card.isDestroyed()) return;
    card.__loaded = true;
    const size = widgetSize(tile, tile === 'system' && widgetExpanded);
    card.setContentSize(size.width, size.height);
    if (card.__warm) return;
    card.showInactive();
    card.moveTop();
    startWidgetStats();
    sendWidgetBackdrop();
    sendTileData(tile);
  });
  card.on('closed', () => {
    if (widgetWins.get(tile) === card) widgetWins.delete(tile);
    if (tile === 'system') widgetExpanded = false;
    stopWidgetDrag();
    stopWidgetStats();
    syncProcSampling();
  });
  return card;
}

// A window created while the desktop is being captured can take a very long time to
// come up (the stream holds the compositor), which is exactly when a card is pulled
// out. So the draggable cards are built and loaded while nothing is being captured,
// and pulling one out only has to show a window that is already there.
const WARM_TILES = ['perf', 'focus', 'library', 'clip'];

function warmWidgetWindows() {
  for (const tile of WARM_TILES) {
    if (!widgetsFor(tile)) createWidget(tile, { warm: true });
  }
}

function openWidget(tile, at) {
  const size = widgetSize(tile, tile === 'system' && widgetExpanded);
  const pos = clampWidget(
    Math.round(at.x - size.width / 2),
    Math.round(at.y - 26),
    size.width,
    size.height,
  );
  const card = widgetsFor(tile) || createWidget(tile);
  if (!card) return;
  card.__warm = false;
  card.setContentSize(size.width, size.height);
  card.setPosition(pos.x, pos.y);
  // On screen from the first move, not after a page load: the window is there and
  // follows the pointer, and its glass fills in as soon as the page has painted.
  card.showInactive();
  card.moveTop();
  startWidgetStats();
  sendWidgetBackdrop();
  sendTileData(tile);
  startWidgetStats();
  sendWidgetBackdrop();
  startWidgetDrag(card, { dx: size.width / 2, dy: 26 });
}

// Dropped exactly where it is asked for, without a drag of its own: this is how the
// overlay hands the screen back to the System card it came from.
function showWidgetAt(tile, at) {
  const size = widgetSize(tile, tile === 'system' && widgetExpanded);
  const card = widgetsFor(tile) || createWidget(tile);
  if (!card) return null;
  const place = () => {
    if (card.isDestroyed()) return;
    card.setContentSize(size.width, size.height);
    card.setPosition(at.x, at.y);
    card.showInactive();
    card.moveTop();
  };
  if (card.isVisible()) place();
  else card.once('ready-to-show', place);
  startWidgetStats();
  sendWidgetBackdrop();
  sendTileData(tile);
  return card;
}

// The performance overlay is not dragged out of the panel like the other cards: it
// appears in the corner and stays there until it is switched off, remembering where
// it was put.
let overlayPos = null;

function showOverlayAt(at) {
  const size = widgetSize('perf', false);
  const existing = widgetsFor('perf');
  if (existing) {
    existing.setContentSize(size.width, size.height);
    existing.setPosition(at.x, at.y);
    existing.moveTop();
    return existing;
  }
  const card = createWidget('perf');
  if (!card) return null;
  const place = () => {
    if (card.isDestroyed()) return;
    card.setContentSize(size.width, size.height);
    card.setPosition(at.x, at.y);
    // Shown without taking the keyboard: an overlay that steals focus from a game
    // is worse than no overlay.
    card.showInactive();
    card.moveTop();
  };
  card.once('ready-to-show', place);
  card.on('move', () => {
    if (card.isDestroyed()) return;
    const bounds = card.getBounds();
    overlayPos = { x: bounds.x, y: bounds.y };
  });
  return card;
}

function togglePerformanceOverlay() {
  const existing = widgetsFor('perf');
  if (existing) {
    existing.close();
    return { open: false };
  }
  const size = widgetSize('perf', false);
  const display = screen.getDisplayNearestPoint(cursorDip());
  const at = overlayPos
    ? clampWidget(overlayPos.x, overlayPos.y, size.width, size.height)
    : {
        x: display.workArea.x + display.workAreaSize.width - size.width - 24,
        y: display.workArea.y + 24,
      };
  showOverlayAt(at);
  return { open: true };
}

// The System card's minimise button hands its place over to the overlay: the same
// four readings, with no card behind them, where the card was standing.
ipcMain.on('widget:minimize', (event) => {
  const card = BrowserWindow.fromWebContents(event.sender);
  if (!card || card.isDestroyed()) return;
  const bounds = card.getBounds();
  const size = widgetSize('perf', false);
  const at = clampWidget(bounds.x, bounds.y, size.width, size.height);
  if (card.__tile === 'system') {
    setWidgetExpanded(false);
    card.close();
  }
  showOverlayAt(at);
});

// ... and its own button folds it back out into the System card, in the same place.
ipcMain.on('widget:restore', (event) => {
  const card = BrowserWindow.fromWebContents(event.sender);
  if (!card || card.isDestroyed() || card.__tile !== 'perf') return;
  const bounds = card.getBounds();
  const size = widgetSize('system', false);
  const at = clampWidget(bounds.x, bounds.y, size.width, size.height);
  card.close();
  showWidgetAt('system', at);
});

ipcMain.handle('notch:overlay', () => togglePerformanceOverlay());

// The System tile is the performance overlay: pulling it out puts the four readings
// on the screen with no card behind them, the way a driver overlay looks. The card
// is still one click away, on the overlay's own ↗ button.
ipcMain.on('notch:prewarm-tile', (_event, tile) => {
  const wanted = tile === 'system' ? 'perf' : tile;
  if (!WIDGET_TILES.has(wanted) || widgetsFor(wanted)) return;
  createWidget(wanted, { warm: true });
});

ipcMain.on('notch:detach', (_event, payload) => {
  const at = payload && Number.isFinite(payload.x) ? { x: payload.x, y: payload.y } : cursorDip();
  const tile = payload && WIDGET_TILES.has(payload.tile) ? payload.tile : 'system';
  openWidget(tile === 'system' ? 'perf' : tile, at);
});

ipcMain.on('notch:detach-end', () => finishWidgetDrag());

// The panel says when the System view is open, so the process list only runs
// while somebody is actually looking at it.
ipcMain.on('notch:detail', (_event, kind) => {
  panelSystemDetail = kind === 'system';
  syncProcSampling();
});

// The timer lives in the panel; it reports every tick, and a detached Focus
// card sends its buttons back through the same hop.
ipcMain.on('focus:state', (_event, next) => {
  if (!next || !Number.isFinite(next.remaining)) return;
  focusState = {
    minutes: Number(next.minutes) || 25,
    total: Number(next.total) || 0,
    remaining: Number(next.remaining) || 0,
    endsAt: Number(next.endsAt) || 0,
    running: !!next.running,
  };
  const card = widgetsFor('focus');
  if (card) card.webContents.send('widget:focus', focusState);
});

ipcMain.on('focus:action', (_event, action) => {
  if (!win || win.isDestroyed()) return;
  win.webContents.send('notch:focus-action', action);
});

ipcMain.on('widget:drag-start', (event) => {
  const card = BrowserWindow.fromWebContents(event.sender);
  if (!card || card.isDestroyed()) return;
  const point = cursorDip();
  const bounds = card.getBounds();
  startWidgetDrag(card, { dx: point.x - bounds.x, dy: point.y - bounds.y });
});

ipcMain.on('widget:drag-end', () => finishWidgetDrag());

ipcMain.on('widget:close', (event) => {
  const card = BrowserWindow.fromWebContents(event.sender);
  if (card && !card.isDestroyed()) card.close();
});

ipcMain.on('widget:expanded', (_event, value) => setWidgetExpanded(value));

ipcMain.on('widget:ready', (event) => {
  const card = BrowserWindow.fromWebContents(event.sender);
  const tile = card && card.__tile ? card.__tile : 'system';
  // The page says when it is up, which is the signal a warmed card waits for.
  if (card) card.__loaded = true;
  startWidgetStats();
  sendWidgetBackdrop();
  sendTileData(tile);
  if (tile === 'system') card.webContents.send('widget:expanded-state', widgetExpanded);
  syncProcSampling();
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
    // Built while the desktop is not being captured, then simply shown on a drag.
    setTimeout(warmWidgetWindows, 6000);
    // The assistant listens through the microphone; Chromium asks us first.
    try {
      // 'display-capture' is what Chromium asks before handing out a screen
      // stream; the glass samples the desktop through it.
      const allowed = new Set([
        'media',
        'display-capture',
        'notifications',
        'clipboard-read',
        'clipboard-sanitized-write',
      ]);
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
    // One quiet check a few seconds in, then every six hours. The panel only says
    // anything when a newer release is there to install.
    setTimeout(() => checkForUpdates().catch(() => {}), 9000);
    setInterval(() => checkForUpdates().catch(() => {}), UPDATE_EVERY_MS);
    applyLogin();
    refreshTaskbar();
    syncWinHook();
    // Warm the launcher, its app index and its glass frame so the first Windows
    // key is instant.
    createLauncher();
    setTimeout(warmLauncherBackdrop, 2500);
    buildAppIndex().catch(() => {});
    // A fullscreen game takes the whole machine, including this shell.
    watchForGames();
    // With the wake word on, Jarvis has to exist (hidden) to keep listening.
    if (assistantSettings().wake) createJarvis();
    // Load the voice model in the background so the first reply is not slow.
    setTimeout(warmPiper, 4000);
    // Spoken replies leave wav files behind; old ones are of no use to anyone.
    try {
      const temp = os.tmpdir();
      const cutoff = Date.now() - 60 * 60 * 1000;
      for (const name of fs.readdirSync(temp)) {
        if (!name.startsWith('notch-voice-')) continue;
        const file = path.join(temp, name);
        if (fs.statSync(file).mtimeMs < cutoff) fs.unlinkSync(file);
      }
    } catch {
      /* a locked file just waits for the next start */
    }

    globalShortcut.register('Control+Alt+Space', () => toggleLauncher());
    globalShortcut.register('Control+Alt+N', () => {
      if (win && !win.isDestroyed()) win.webContents.send('notch:toggle-pin');
    });
    globalShortcut.register('Control+Alt+J', () => toggleJarvis());
    globalShortcut.register('Control+Alt+Q', () => app.quit());
    globalShortcut.register('Control+Alt+S', () => takeScreenshot());

    setInterval(readBattery, 15 * 60 * 1000);
    // The shell can come back on its own — an explorer restart makes a fresh,
    // visible taskbar — so the wanted state is asked for on a slow beat while it
    // is meant to be away.
    setInterval(() => {
      if (nativeTaskbarWanted()) sendNativeTaskbarState(true);
    }, 20000);
    // The update check runs by itself: shortly after the panel is up, and every
    // six hours after that. Nothing has to be opened for the answer to exist.
    setTimeout(checkForUpdates, 5000);
    setInterval(checkForUpdates, UPDATE_EVERY_MS);
  });

  app.on('before-quit', (event) => {
    app.isQuitting = true;
    // The shell's bar is put back before the helper that hid it goes away: a
    // hidden Windows taskbar with no app left to bring it back is a machine with
    // no taskbar at all. The quit is held for the moment that write needs.
    if (
      nativeTaskbarHidden &&
      !quitBarRestored &&
      hookProc &&
      hookProc.stdin &&
      !hookProc.stdin.destroyed
    ) {
      quitBarRestored = true;
      nativeTaskbarHidden = false;
      try {
        hookProc.stdin.write('taskbarshow\n');
      } catch {
        /* already gone: nothing left to hold the bar */
      }
      event.preventDefault();
      setTimeout(() => app.quit(), 260);
      return;
    }
    stopWinHook();
    stopPiper();
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
