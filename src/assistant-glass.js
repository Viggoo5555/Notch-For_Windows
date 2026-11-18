// Jarvis wears the same lens as the notch: the desktop strip the main process
// samples behind the window is refracted by the library, and the chat paints on
// top of it. With no sample (or no WebGL) the card keeps its own painted surface.

import { LiquidGlass } from './vendor/liquidglass.js';

const api = window.jarvis;
const root = document.querySelector('#jGlass');
const pane = document.querySelector('#jPane');
const source = document.querySelector('#jSource');

const CONFIG = {
  cornerRadius: 26,
  zRadius: 46,
  refraction: 1.18,
  chromAberration: 0.14,
  edgeHighlight: 0.12,
  specular: 0.3,
  fresnel: 1,
  distortion: 0.014,
  blurAmount: 0.3,
  tintStrength: 0.24,
  saturation: 0.14,
  brightness: -0.12,
  shadowOpacity: 0,
  shadowSpread: 0,
  shadowOffsetY: 0,
};

let instance = null;
let starting = false;

async function start() {
  if (instance || starting) return;
  if (!source.getAttribute('src')) return;
  starting = true;
  try {
    await source.decode().catch(() => {});
    pane.dataset.config = JSON.stringify(CONFIG);
    instance = await LiquidGlass.init({ root, glassElements: [pane], defaults: CONFIG });
    document.body.classList.add('gl');
    instance.markChanged(source);
  } catch (error) {
    console.warn('Liquid glass unavailable in Jarvis', error);
  } finally {
    starting = false;
  }
}

function backdrop(data) {
  if (!data || !data.url) return;
  source.src = data.url;
  source.style.width = data.width ? `${data.width}px` : '100%';
  source.style.height = data.height ? `${data.height}px` : '100%';
  if (instance) instance.markChanged(source);
  else start();
}

if (api && api.onBackdrop) api.onBackdrop(backdrop);
