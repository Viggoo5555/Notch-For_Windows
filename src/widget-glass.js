// The detached widget uses the same liquid-glass pass as the notch panel.
// The pane is the card itself; the source image is the whole display, slid
// under the window so the lens always refracts what is actually behind it.

import { LiquidGlass } from './vendor/liquidglass.js';

const root = document.querySelector('#wgGlass');
const pane = document.querySelector('#wgPane');
const source = document.querySelector('#wgSource');

const CONFIG = {
  cornerRadius: 18,
  zRadius: 40,
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

let instance = null;
let starting = false;
let display = null;
let position = { x: 0, y: 0 };
// 'black' parks the lens and lets the CSS surface show, exactly like the panel.
let surface = 'glass';

function place() {
  if (!display) {
    source.style.width = '100%';
    source.style.height = '100%';
    source.style.transform = 'none';
    return;
  }
  source.style.width = `${display.width}px`;
  source.style.height = `${display.height}px`;
  source.style.transform = `translate3d(${display.x - position.x}px, ${display.y - position.y}px, 0)`;
}

function stop() {
  if (!instance) return;
  try {
    instance.setPaused(true);
  } catch {
    /* already stopped */
  }
  root.classList.remove('gl');
}

async function start() {
  if (instance || starting) return;
  if (surface === 'black') return;
  if (!source.getAttribute('src')) return;
  starting = true;
  try {
    await source.decode().catch(() => {});
    pane.dataset.config = JSON.stringify(CONFIG);
    instance = await LiquidGlass.init({
      root,
      glassElements: [pane],
      defaults: CONFIG,
    });
    root.classList.add('gl');
    instance.markChanged(source);
  } catch (error) {
    console.warn('Liquid glass unavailable in the widget', error);
  } finally {
    starting = false;
  }
}

window.widgetGlass = {
  surface(name) {
    const next = name === 'black' ? 'black' : 'glass';
    if (next === surface) return;
    surface = next;
    document.body.dataset.surface = surface;
    if (surface === 'black') {
      stop();
      return;
    }
    if (instance) {
      try {
        instance.setPaused(false);
      } catch {
        /* the lens may need reseeding below */
      }
      root.classList.add('gl');
      place();
      instance.markChanged(source);
      return;
    }
    start();
  },
  backdrop(data) {
    if (!data || !data.url) return;
    display =
      data.width > 0 && data.height > 0
        ? { width: data.width, height: data.height, x: data.x, y: data.y }
        : null;
    source.src = data.url;
    place();
    if (instance) instance.markChanged(source);
    else start();
  },
  position(x, y) {
    position = { x, y };
    place();
    if (instance) instance.markChanged(source);
  },
};
