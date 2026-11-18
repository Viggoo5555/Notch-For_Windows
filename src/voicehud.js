// The presence that appears when Jarvis hears its name: concentric rings of
// light on nothing at all — no card, no text, no background. They breathe with
// the microphone, turn slowly while the model thinks, and race while it talks.

const api = window.voiceHud;
const canvas = document.getElementById('ring');
const ctx = canvas.getContext('2d');

const TAU = Math.PI * 2;

let level = 0;
let target = 0;
let lastMessage = 0;
let own = 0;
let state = 'idle';
let size = 0;

const RINGS = [
  // Broken red strands on the outside, the way the reference trails off.
  { r: 0.717, w: 0.0032, rgb: '255,64,74', alpha: 0.36, glow: 3.4, span: 0.42, count: 3, gap: 0.9, spin: 0.05, grow: 0.25 },
  { r: 0.678, w: 0.0038, rgb: '255,72,84', alpha: 0.48, glow: 4.2, span: 0.62, count: 2, gap: 1.5, spin: -0.08, grow: 0.3 },
  { r: 0.632, w: 0.0055, rgb: '255,58,70', alpha: 0.44, glow: 5, span: 3.4, count: 1, gap: 0, spin: 0.03, grow: 0.4 },
  // The depth: a dark blue ring that sits under the cyan.
  { r: 0.564, w: 0.013, rgb: '58,92,214', alpha: 0.52, glow: 4.4, span: 4.1, count: 1, gap: 0, spin: 0.12, grow: 0.5 },
  { r: 0.528, w: 0.007, rgb: '86,132,255', alpha: 0.4, glow: 4, span: 2.3, count: 2, gap: 1.2, spin: -0.16, grow: 0.5 },
  // The bright current running around it.
  { r: 0.552, w: 0.019, rgb: '126,246,255', alpha: 0.95, glow: 8.5, span: 3.05, count: 1, gap: 0, spin: -0.22, grow: 0.55 },
  { r: 0.603, w: 0.0045, rgb: '168,252,255', alpha: 0.8, glow: 6, span: 2.1, count: 1, gap: 0, spin: -0.3, grow: 0.45 },
  // Embers inside the eye.
  { r: 0.453, w: 0.003, rgb: '255,70,82', alpha: 0.3, glow: 3, span: 2, count: 2, gap: 1.1, spin: 0.18, grow: 0.4 },
  { r: 0.366, w: 0.0024, rgb: '255,88,96', alpha: 0.22, glow: 2.4, span: 1.5, count: 2, gap: 1.4, spin: -0.24, grow: 0.35 },
];

for (const ring of RINGS) ring.angle = Math.random() * TAU;

function resize() {
  size = Math.min(window.innerWidth, window.innerHeight);
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.round(size * dpr));
  canvas.height = Math.max(1, Math.round(size * dpr));
  canvas.style.width = `${size}px`;
  canvas.style.height = `${size}px`;
}

window.addEventListener('resize', resize);
resize();

if (api) {
  api.onState((payload) => {
    state = (payload && payload.state) || 'idle';
    document.body.dataset.state = state;
    lastMessage = performance.now();
    if (payload && typeof payload.level === 'number') target = payload.level;
    own = 0;
  });
  api.onLevel((value) => {
    lastMessage = performance.now();
    target = Number(value) || 0;
    own = 0;
  });
}

function drawRing(ring, index, time) {
  const cx = canvas.width / 2;
  const cy = canvas.height / 2;
  const radius = (size / 2) * ring.r * (window.devicePixelRatio || 1);
  const spin = state === 'thinking' ? 0.45 : state === 'speaking' ? 1.7 : 1;
  const bright = state === 'speaking' ? 1.15 : state === 'thinking' ? 0.75 : 1;
  const breathe = 0.86 + level * 0.5;
  const width = Math.max(1, radius * ring.w * (1 + level * ring.grow));

  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  ctx.strokeStyle = `rgba(${ring.rgb},${Math.min(1, ring.alpha * bright * breathe)})`;
  ctx.shadowColor = `rgba(${ring.rgb},0.85)`;
  ctx.shadowBlur = radius * ring.glow * 0.1 * (0.7 + level * 0.8);

  const span = ring.span * (state === 'thinking' ? 0.7 : state === 'speaking' ? 1.12 : 1);
  const step = TAU / ring.count;
  for (let i = 0; i < ring.count; i += 1) {
    const start = ring.angle + i * step + time * ring.spin * spin * (1 + index * 0.02);
    ctx.beginPath();
    ctx.arc(cx, cy, radius, start, start + span);
    ctx.stroke();
  }
}

function drawHaze() {
  const cx = canvas.width / 2;
  const cy = canvas.height / 2;
  const radius = (size / 2) * (window.devicePixelRatio || 1) * 0.62;
  const gradient = ctx.createRadialGradient(cx, cy, radius * 0.1, cx, cy, radius);
  const strength = state === 'speaking' ? 0.16 : 0.1;
  gradient.addColorStop(0, `rgba(96,8,18,${strength * (0.6 + level)})`);
  gradient.addColorStop(1, 'rgba(96,8,18,0)');
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, TAU);
  ctx.fill();
}

let started = performance.now();

function frame(now) {
  const time = (now - started) / 1000;
  // Nothing arriving means nobody is speaking: keep a slow breath so the ring
  // never looks switched off.
  if (performance.now() - lastMessage > 420) {
    own += 0.055;
    target = 0.22 + Math.sin(own) * 0.16;
  }
  level += (target - level) * 0.18;

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (state !== 'idle') {
    drawHaze();
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < RINGS.length; i += 1) drawRing(RINGS[i], i, time);
    ctx.globalCompositeOperation = 'source-over';
  }
  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
