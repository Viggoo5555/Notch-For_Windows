// The little presence that appears when Jarvis hears its name. It shows the
// microphone level while listening, a slow pulse while the model thinks, and a
// faster wave while it talks.

const api = window.voiceHud;
const bars = document.getElementById('bars');
const labels = { listening: 'Listening', thinking: 'Thinking', speaking: 'Speaking' };
const LABEL = document.getElementById('label');

for (let i = 0; i < 11; i += 1) {
  const bar = document.createElement('i');
  bar.style.setProperty('--i', String(i));
  bars.appendChild(bar);
}

let level = 0;
let target = 0;
let lastMessage = 0;
let own = 0;

if (api) {
  api.onState((payload) => {
    const state = (payload && payload.state) || 'idle';
    document.body.dataset.state = state;
    LABEL.textContent = labels[state] || '';
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

// Smooth the level so the light breathes instead of flickering.
function frame() {
  // If nothing arrives, invent a gentle motion so it never looks frozen.
  if (performance.now() - lastMessage > 420) {
    own += 0.055;
    target = 0.3 + Math.sin(own) * 0.22;
  }
  level += (target - level) * 0.32;
  document.documentElement.style.setProperty('--level', level.toFixed(3));
  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
