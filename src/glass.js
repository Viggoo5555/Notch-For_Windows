// Real liquid glass, ported from ybouane/liquidglass (MIT).
// One WebGL pass renders refraction, chromatic aberration, Fresnel, specular
// and the inner rim over the backdrop image; CSS only clips it into shape.
// Two panes share the pass: the panel and the folded pill.

import { LiquidGlass } from './vendor/liquidglass.js';

const root = document.querySelector('#glassRoot');
const pane = document.querySelector('#glassPane');
const pillPane = document.querySelector('#glassPillPane');
const source = document.querySelector('#glassSource');
const live = document.querySelector('#glassLive');
const notch = document.querySelector('#notch');

// The repo's "hero" glass — the glassiest preset in its demo.
const CONFIG = {
  cornerRadius: 28,
  zRadius: 58,
  refraction: 1.2,
  chromAberration: 0.16,
  edgeHighlight: 0.12,
  specular: 0.34,
  fresnel: 1,
  distortion: 0.015,
  blurAmount: 0.24,
  tintStrength: 0.18,
  saturation: 0.2,
  brightness: -0.1,
  shadowOpacity: 0,
  shadowSpread: 0,
  shadowOffsetY: 0,
};

// The pill is the same glass, only fitted to a 26px band. A 26px lens has no
// room for a deep bevel: the curve is shallower, the rim quieter and the glass
// darker, or the whole capsule turns into one bright highlight.
const PILL = {
  ...CONFIG,
  cornerRadius: 13,
  zRadius: 4,
  refraction: 0.8,
  chromAberration: 0.09,
  edgeHighlight: 0.05,
  specular: 0.07,
  fresnel: 0.45,
  distortion: 0.008,
  blurAmount: 0.34,
  tintStrength: 0.34,
  brightness: -0.16,
};

let instance = null;
let starting = false;
let current = '';
let pulseFrames = 0;
// Why the glass is or is not drawing, so Settings can say it out loud instead of
// leaving a flat panel to be guessed at.
let mode = 'pending';
let reason = '';

function pillConfig(overrides = {}) {
  return { ...PILL, ...overrides };
}

function isSolid() {
  return !!document.querySelector('.notch.solid');
}

async function start() {
  if (instance || starting) return;
  if (!source.getAttribute('src')) {
    mode = 'flat';
    reason = 'no-backdrop';
    return;
  }
  starting = true;
  try {
    await source.decode().catch(() => {});
    pane.dataset.config = JSON.stringify(CONFIG);
    pillPane.dataset.config = JSON.stringify(pillConfig());
    instance = await LiquidGlass.init({
      root,
      glassElements: [pane, pillPane],
      defaults: CONFIG,
    });
    notch.classList.add('gl');
    mode = 'shader';
    reason = '';
    if (isSolid()) instance.setPaused(true);
    else if (notch.classList.contains('open')) instance.setPaused(false);
    else pulse();
  } catch (error) {
    mode = 'flat';
    reason = 'no-webgl';
    console.warn('Liquid glass unavailable, keeping the CSS material', error);
  } finally {
    starting = false;
  }
}

// A new desktop frame arrives while the previous one may still be decoding. The
// picture is decoded off the page first and only then swapped in, so a half-decoded
// frame is never what the shader samples, and a frame that lost the race is dropped
// instead of drawn a moment late.
async function setSource(url) {
  if (!url || url === current) return;
  current = url;
  const next = new Image();
  next.src = url;
  await next.decode().catch(() => {});
  if (current !== url) return;
  source.src = url;
  if (instance) {
    instance.markChanged(source);
    pulse();
  } else {
    start();
  }
}

function apply({ tint, blur } = {}) {
  if (!instance) return;
  const tintStrength = Math.max(0, Math.min(1, (Number(tint) || 0) / 100 * 0.6));
  const blurAmount = Math.max(0, Math.min(1, (Number(blur) || 0) / 100 * 0.6));
  pane.dataset.config = JSON.stringify({
    ...CONFIG,
    tintStrength,
    blurAmount,
  });
  pillPane.dataset.config = JSON.stringify(
    pillConfig({
      tintStrength,
      blurAmount,
    }),
  );
}

// --------------------------------------------------------------- live desktop

// Refreshing the glass used to mean grabbing the whole screen again and again: a
// fresh capture costs about a third of a second here, so the picture was always
// seconds old. Instead the desktop is streamed once — the same capture Windows
// already runs for screen recording — and each new frame is copied straight into
// a canvas the shader samples. No grab, no JPEG, no IPC per frame: the glass
// moves with whatever is behind it.
let liveStream = null;
let liveVideo = null;
let liveBounds = null;
let liveOn = false;
let liveTime = -1;
let liveFrame = 0;
let liveFailedAt = 0;
let liveWanted = false;

// Cut this window's slice out of the streamed display and put it on the canvas.
function paintLive() {
  if (!liveVideo || !liveBounds || liveVideo.readyState < 2) return false;
  const rect = live.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) return false;
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.round(rect.width * dpr));
  const height = Math.max(1, Math.round(rect.height * dpr));
  if (live.width !== width || live.height !== height) {
    live.width = width;
    live.height = height;
  }
  const context = live.getContext('2d');
  if (!context) return false;
  // The window's own position on the display says which part of the picture is
  // under the lens, so the canvas ends up pixel-aligned with the desktop.
  const scaleX = liveVideo.videoWidth / liveBounds.width;
  const scaleY = liveVideo.videoHeight / liveBounds.height;
  const sx = (window.screenX + rect.left - liveBounds.x) * scaleX;
  const sy = (window.screenY + rect.top - liveBounds.y) * scaleY;
  try {
    context.drawImage(
      liveVideo,
      sx,
      sy,
      rect.width * scaleX,
      rect.height * scaleY,
      0,
      0,
      width,
      height,
    );
  } catch {
    return false;
  }
  return true;
}

// One redraw per captured frame, not one per screen refresh: the shader only runs
// when there are pixels it has not seen.
function liveTick() {
  if (!liveOn) return;
  liveFrame = requestAnimationFrame(liveTick);
  if (!liveVideo || liveVideo.readyState < 2) return;
  if (liveVideo.currentTime === liveTime) return;
  liveTime = liveVideo.currentTime;
  if (!paintLive()) return;
  if (instance) instance.markChanged(live);
}

async function startLive() {
  if (liveOn || starting || liveFailedAt && Date.now() - liveFailedAt < 20000) return;
  const api = window.notchAPI;
  if (!api || !api.captureSource) return;
  let spot = null;
  try {
    spot = await api.captureSource();
  } catch {
    spot = null;
  }
  if (!spot || !spot.id) return;
  try {
    const dpr = window.devicePixelRatio || 1;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: spot.id,
          maxWidth: Math.round(spot.bounds.width * dpr),
          maxHeight: Math.round(spot.bounds.height * dpr),
          maxFrameRate: 30,
        },
      },
    });
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.style.cssText =
      'position:fixed;left:-4px;top:-4px;width:2px;height:2px;opacity:0;pointer-events:none';
    video.srcObject = stream;
    document.body.append(video);
    await video.play().catch(() => {});
    liveStream = stream;
    liveVideo = video;
    liveBounds = spot.bounds;
    liveOn = true;
    liveTime = -1;
    live.classList.add('on');
    if (liveWanted) setPaused(false);
    api.liveActive(true);
    liveFrame = requestAnimationFrame(liveTick);
  } catch (error) {
    liveFailedAt = Date.now();
    api.liveActive(false);
    console.warn('Live glass unavailable, falling back to sampled frames', error);
  }
}

function stopLive() {
  if (!liveOn && !liveVideo && !liveStream) return;
  liveOn = false;
  if (liveFrame) cancelAnimationFrame(liveFrame);
  liveFrame = 0;
  // Hand the last streamed frame to the still image, so the next unfold shows the
  // desktop the way it was left rather than a frame from minutes ago.
  try {
    if (live.width > 1 && live.height > 1) {
      current = live.toDataURL('image/jpeg', 0.82);
      source.src = current;
      if (instance) instance.markChanged(source);
    }
  } catch {
    /* the still image that was already there stays */
  }
  live.classList.remove('on');
  if (liveStream) {
    for (const track of liveStream.getTracks()) track.stop();
    liveStream = null;
  }
  if (liveVideo) {
    liveVideo.srcObject = null;
    liveVideo.remove();
    liveVideo = null;
  }
  liveBounds = null;
  liveTime = -1;
  if (window.notchAPI && window.notchAPI.liveActive) window.notchAPI.liveActive(false);
  pulse();
}

// Collapsed: render a couple of frames, then stop. The pill holds its last
// frame, so the glass costs nothing while the cursor is away.
function pulse() {
  if (!instance) return;
  // The black surface draws no glass, so the shader stays parked.
  if (isSolid()) {
    instance.setPaused(true);
    return;
  }
  if (liveOn) {
    instance.setPaused(false);
    return;
  }
  if (notch.classList.contains('open') || notch.classList.contains('closing')) {
    instance.setPaused(false);
    return;
  }
  instance.setPaused(false);
  pulseFrames = 0;
  const step = () => {
    if (!instance) return;
    if (liveOn || notch.classList.contains('open') || notch.classList.contains('closing')) return;
    pulseFrames += 1;
    if (pulseFrames < 3) requestAnimationFrame(step);
    else instance.setPaused(true);
  };
  requestAnimationFrame(step);
}

function setPaused(value) {
  const paused = isSolid() ? true : !!value;
  if (instance && typeof instance.setPaused === 'function') instance.setPaused(paused);
  if (!paused) pulseFrames = 0;
}

window.notchGlass = {
  setSource,
  apply,
  setPaused,
  refresh: pulse,
  status: () => ({ mode, reason, live: liveOn }),
};

if (window.__backdrop) setSource(window.__backdrop);

// Main decides when the glass needs a live desktop — the panel is open, or the
// pointer is close enough that it is about to be — and says so.
if (window.notchAPI && window.notchAPI.onLive) {
  window.notchAPI.onLive((wanted) => {
    liveWanted = !!wanted;
    if (liveWanted) startLive();
    else stopLive();
  });
}
