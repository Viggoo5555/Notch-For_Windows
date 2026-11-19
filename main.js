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
    desktopFrame = { image: source.thumbnail, display };
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

function detectHardware() {
  if (hardwareCache) return hardwareCache;
  const cpus = os.cpus();
  const cores = cpus.length || 1;
  const ramGb = Math.round((os.totalmem() / 1024 ** 3) * 10) / 10;
  const cpu = String((cpus[0] && cpus[0].model) || '').replace(/\s+/g, ' ').trim();
  let gpu = '';
  let vramGb = 0;
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
      vramGb = Math.round(((Number(parsed.vram) || 0) / 1024 ** 3) * 10) / 10;
    }
  } catch {
    /* no video controller info: treat it as CPU only */
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
        ? `${gpu} with ${gpuMemoryGb} GB of video memory: the studio voice, the larger listening model and a 7B brain all fit at once.`
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
  [/^(task manager|aktivitetsstyring)$/i, 'taskmgr.exe', 'Task Manager'],
  [/^(control panel|kontrolpanel)$/i, 'control.exe', 'Control Panel'],
  [/^(snipping tool|klippeværktøj)$/i, 'snippingtool.exe', 'Snipping Tool'],
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
  if (/^(settings|indstillinger)$/i.test(asked)) {
    shell.openExternal('ms-settings:');
    return sayBoth('Opening Settings.', 'Åbner Indstillinger.');
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
  win.webContents.send('notch:open');
  setTimeout(
    () => {
      if (win && !win.isDestroyed()) win.webContents.send('notch:view', kind || 'panel');
    },
    kind ? 320 : 0,
  );
  return true;
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

async function runAction(text) {
  const notch = await runNotchAction(text);
  if (notch) return { handled: true, say: notch };

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

async function performAssistantAction(rawText) {
  const text = cleanOrder(rawText);
  if (!text) return { handled: false };
  answerDanish = settingsInDanish() || looksDanish(text);
  let missed = '';

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
  return {
    settings: assistantSettings(),
    status,
    voices: await listVoices(),
    presets: OLLAMA_PRESETS.map((preset) => ({
      ...preset,
      recommended: preset.name === recommended.name,
    })),
    hardware,
    recommended,
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

ipcMain.handle('assistant:act', (_event, text) => performAssistantAction(text));

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
      // A portable build unpacks itself to a temp folder, so the launcher exe is
      // the stable path for a login shortcut.
      path: process.env.PORTABLE_EXECUTABLE_FILE || process.execPath,
      args: app.isPackaged ? [] : [path.join(__dirname)],
    });
  } catch {
    /* unsupported */
  }
}

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

async function checkForUpdates() {
  try {
    const response = await net.fetch(`https://api.github.com/repos/${UPDATE_REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': `Notch/${updateState.current}` },
    });
    if (!response.ok) throw new Error(`GitHub ${response.status}`);
    const release = await response.json();
    const asset = (release.assets || []).find((entry) => /^Notch-Setup-.*\.exe$/i.test(entry.name));
    updateState.latest = String(release.tag_name || '').replace(/^v/i, '');
    updateState.notes = release.body || '';
    updateState.page = release.html_url || `https://github.com/${UPDATE_REPO}/releases`;
    updateState.url = asset ? asset.browser_download_url : '';
    updateState.name = asset ? asset.name : '';
    updateState.size = asset ? asset.size : 0;
    updateState.checkedAt = Date.now();
    updateState.error = '';
  } catch {
    updateState.error = 'GitHub could not be reached';
    updateState.checkedAt = Date.now();
  }
  sendUpdate();
  return publicUpdate();
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
  // The app cannot stay open while its own files are replaced: the installer runs
  // silently, and when it is done the installed build comes back by itself.
  const exe = app.getPath('exe');
  try {
    spawn('cmd.exe', ['/c', `"${target}" /S && start "" "${exe}"`], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    }).unref();
    app.isQuitting = true;
    setTimeout(() => app.quit(), 900);
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
let storeCache = null;
let storeAt = 0;

function storeCountry() {
  try {
    const code = String(app.getLocaleCountryCode() || '').toLowerCase();
    if (/^[a-z]{2}$/.test(code)) return code;
  } catch {
    /* older Electron */
  }
  return 'us';
}

async function fetchStore() {
  if (storeCache && Date.now() - storeAt < STORE_TTL) return storeCache;
  const url = `https://store.steampowered.com/api/featuredcategories/?cc=${storeCountry()}&l=en`;
  let data = null;
  try {
    const response = await net.fetch(url);
    if (response.ok) data = await response.json();
  } catch {
    /* offline, or Steam is having a day */
  }
  if (!data) return storeCache || { at: Date.now(), items: [], error: 'offline' };

  const seen = new Set();
  const items = [];
  const sections = [
    ['deal', data.specials],
    ['top', data.top_sellers],
    ['new', data.new_releases],
  ];
  for (const [source, section] of sections) {
    for (const item of (section && section.items) || []) {
      const appid = Number(item.id);
      if (!appid || seen.has(appid)) continue;
      seen.add(appid);
      const final = Math.max(0, Number(item.final_price) || 0);
      items.push({
        appid,
        name: String(item.name || '').trim(),
        source,
        discount: Math.max(0, Number(item.discount_percent) || 0),
        original: Math.max(0, Number(item.original_price) || 0),
        final,
        free: final === 0,
        currency: String(item.currency || 'USD'),
        art: `https://cdn.cloudflare.steamstatic.com/steam/apps/${appid}/header.jpg`,
      });
    }
  }
  if (!items.length) return storeCache || { at: Date.now(), items: [], error: 'empty' };
  storeCache = { at: Date.now(), items };
  storeAt = Date.now();
  return storeCache;
}

ipcMain.handle('notch:store', () => fetchStore());

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

// Hover list for an app with several windows, the way the Windows taskbar
// stacks its thumbnails under one button.
let flyoutWin = null;
let flyoutKey = null;
let flyoutPoll = null;
let flyoutOutside = 0;
let flyoutBounds = null;
let flyoutLeft = 0;


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
  const width = Math.min(
    display.bounds.width - 40,
    Math.max(zone === 'tray' ? 140 : 200, Math.round(taskbarWidths[zone] || 300)),
  );
  const height = TASKBAR_H + TASKBAR_LIFT;
  const bottom = display.bounds.y + display.bounds.height;
  const x =
    zone === 'tray'
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
  win.setBounds(box, false);
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
    for (const { win } of zones) {
      if (win.isDestroyed() || !win.isVisible()) continue;
      const box = win.getBounds();
      const strip = await requestScreenShot({
        x: box.x,
        y: box.y,
        width: box.width,
        height: box.height,
      });
      if (!strip || !strip.data || win.isDestroyed()) continue;
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
      if (trayRequest === request) trayRequest = null;
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
  if (!trayItems.length) return;
  const display = screen.getPrimaryDisplay();
  const scale = display.scaleFactor || 1;
  // The tray island sits over the notification area, and the capture is the
  // composited desktop: any window of ours covering the icons has to step aside
  // for the moment the screen is read, or we photograph our own bar.
  const box = {
    left: Math.min(...trayItems.map((row) => row.x)) - 2,
    top: Math.min(...trayItems.map((row) => row.y)) - 2,
    right: Math.max(...trayItems.map((row) => row.x + row.w)) + 2,
    bottom: Math.max(...trayItems.map((row) => row.y + row.h)) + 2,
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
    for (const item of trayItems) {
      if (item.icon) continue;
      const side = Math.max(8, Math.round(Math.min(item.w, item.h, 32) * ratioX));
      const x = Math.round((item.x - box.left + item.w / 2) * ratioX - side / 2);
      const y = Math.round((item.y - box.top + item.h / 2) * ratioY - side / 2);
      if (x < 0 || y < 0 || x + side > size.width || y + side > size.height) continue;
      const crop = image.crop({ x, y, width: side, height: side });
      if (crop && !crop.isEmpty()) item.icon = crop.resize({ width: 36, height: 36 }).toDataURL();
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
        clockLeft = Number(x);
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
      .map((row) => ({ ...row, icon: previous.get(`${row.name}|${row.x}|${row.y}`) || null }));
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
    const bar = taskbarWin && !taskbarWin.isDestroyed() ? taskbarWin.getBounds() : null;
    const inBar =
      bar && point.y >= bar.y && point.y <= bar.y + bar.height && point.x >= bar.x && point.x <= bar.x + bar.width;
    if (inList || inBar) {
      flyoutOutside = 0;
      return;
    }
    flyoutOutside += 1;
    if (flyoutOutside >= 4) hideFlyout();
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
    if (!match) {
      match = groups.find(
        (group) => !used.has(group) && group.name.toLowerCase() === String(pin.name || '').toLowerCase(),
      );
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
  // The apps island goes away when there is nothing on it; the tray island
  // stays, because the clock lives there.
  if (!taskbarApps.length) {
    hideFlyout();
    if (taskbarWin.isVisible()) taskbarWin.hide();
  } else if (!taskbarWin.isVisible()) {
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
}

function destroyTaskbar() {
  hideFlyout();
  stopTaskbarPolling();
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

function refreshTaskbar() {
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

ipcMain.on('taskbar:hover', (_event, payload) => {
  const key = payload && payload.key;
  const left = Number(payload && payload.left) || 0;
  showFlyout(findTaskbarApp(key), left);
});

ipcMain.on('taskbar:hover-end', () => hideFlyout());

ipcMain.on('taskbar:group', (_event, key) => {
  const app = findTaskbarApp(key);
  if (!app) return;
  hideFlyout();
  if (app.windows.length) focusTaskbarWindow(app.windows[0].hwnd);
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

ipcMain.on('flyout:pick', (_event, hwnd) => {
  hideFlyout();
  focusTaskbarWindow(Number(hwnd));
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

// Win+<number> opens whatever the bar shows under that number: pins first, then
// running windows, exactly like the buttons left to right.
function activateTaskbarSlot(slot) {
  if (!Number.isFinite(slot) || slot < 1 || slot > 10) return;
  const app = groupTaskbarApps(taskbarOpenItems(), taskbarPinned())[slot - 1];
  if (!app) return;
  hideLauncher();
  if (app.windows.length) focusTaskbarWindow(app.windows[0].hwnd);
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
  if (gameMode || procBusy || !wantsProcesses()) return;
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

function createWidget(tile) {
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
      backgroundThrottling: false,
    },
  });
  card.__tile = tile;
  card.setMenu(null);
  card.setAlwaysOnTop(true, 'screen-saver');
  card.setSkipTaskbar(true);
  card.loadFile(path.join(__dirname, 'src', 'widget.html'), { query: { tile } });
  widgetWins.set(tile, card);
  card.once('ready-to-show', () => {
    if (card.isDestroyed()) return;
    const size = widgetSize(tile, tile === 'system' && widgetExpanded);
    card.setContentSize(size.width, size.height);
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
  card.setContentSize(size.width, size.height);
  card.setPosition(pos.x, pos.y);
  if (card.isVisible()) {
    card.showInactive();
    card.moveTop();
  } else {
    card.once('ready-to-show', () => card.moveTop());
  }
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

ipcMain.on('notch:detach', (_event, payload) => {
  const at = payload && Number.isFinite(payload.x) ? { x: payload.x, y: payload.y } : cursorDip();
  const tile = payload && WIDGET_TILES.has(payload.tile) ? payload.tile : 'system';
  openWidget(tile, at);
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

    setInterval(readBattery, 15 * 60 * 1000);
  });

  app.on('before-quit', () => {
    app.isQuitting = true;
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
