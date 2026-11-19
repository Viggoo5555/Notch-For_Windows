// Real liquid glass, ported from ybouane/liquidglass (MIT).
// One WebGL pass renders refraction, chromatic aberration, Fresnel, specular
// and the inner rim over the backdrop image; CSS only clips it into shape.
// Two panes share the pass: the panel and the folded pill.

import { LiquidGlass } from './vendor/liquidglass.js';

const root = document.querySelector('#glassRoot');
const pane = document.querySelector('#glassPane');
const pillPane = document.querySelector('#glassPillPane');
const source = document.querySelector('#glassSource');
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

async function setSource(url) {
  if (!url || url === current) return;
  current = url;
  source.src = url;
  await source.decode().catch(() => {});
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

// Collapsed: render a couple of frames, then stop. The pill holds its last
// frame, so the glass costs nothing while the cursor is away.
function pulse() {
  if (!instance) return;
  // The black surface draws no glass, so the shader stays parked.
  if (isSolid()) {
    instance.setPaused(true);
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
    if (notch.classList.contains('open') || notch.classList.contains('closing')) return;
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
  status: () => ({ mode, reason }),
};

if (window.__backdrop) setSource(window.__backdrop);
