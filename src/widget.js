'use strict';

import './widget-glass.js';

const $ = (selector) => document.querySelector(selector);
const api = window.widgetAPI;

const card = $('#card');
let expanded = false;
let drag = null;

// --------------------------------------------------------------- glass backdrop

// The lens samples the whole display under the window, so it is slid by the
// window's screen offset while the widget is dragged.
let panUntil = 0;

function syncBackdrop() {
  if (window.widgetGlass) window.widgetGlass.position(screenX, screenY);
}

function applyBackdrop(data) {
  if (!data || !data.url) return;
  if (window.widgetGlass) window.widgetGlass.backdrop(data);
  syncBackdrop();
}

function panLoop() {
  syncBackdrop();
  if (performance.now() < panUntil) requestAnimationFrame(panLoop);
}

function keepPanning(ms = 700) {
  panUntil = Math.max(panUntil, performance.now() + ms);
  requestAnimationFrame(panLoop);
}

window.addEventListener('resize', syncBackdrop);

function bar(element, value) {
  element.style.width = `${Math.max(0, Math.min(100, value))}%`;
}

function renderMeter(valueId, barId, percent, label) {
  $(valueId).textContent = label;
  bar($(barId), percent);
}

function setMeters(data) {
  const ramPct = data.ram.total ? (data.ram.used / data.ram.total) * 100 : 0;
  const diskPct = data.disk.total ? ((data.disk.total - data.disk.free) / data.disk.total) * 100 : 0;
  renderMeter('#valCpu', '#barCpu', data.cpu, `${Math.round(data.cpu)}%`);
  renderMeter('#valRam', '#barRam', ramPct, `${(data.ram.used / 1073741824).toFixed(1)} GB`);
  renderMeter('#valDisk', '#barDisk', diskPct, `${Math.round(diskPct)}%`);
}

function renderList(element, rows) {
  element.replaceChildren();
  rows.forEach((row, index) => {
    const item = document.createElement('li');
    item.style.setProperty('--i', String(index));

    const name = document.createElement('span');
    name.className = 'pname';
    name.textContent = row.name;
    name.title = row.name;

    const track = document.createElement('span');
    track.className = 'pbar';
    const fill = document.createElement('i');
    fill.style.width = `${Math.max(2, Math.min(100, row.share * 100))}%`;
    track.appendChild(fill);

    const value = document.createElement('b');
    value.textContent = row.label;

    item.append(name, track, value);
    element.appendChild(item);
  });
}

function setExpanded(value) {
  expanded = !!value;
  card.classList.toggle('is-open', expanded);
  $('#breakdown').setAttribute('aria-hidden', expanded ? 'false' : 'true');
  $('#hint').textContent = expanded ? 'Press to collapse · drag to move' : 'Press for details · drag to move';
  keepPanning(800);
}

// ---------------------------------------------------------------- interaction

card.addEventListener('pointerdown', (event) => {
  if (event.button !== 0 || event.target.closest('#close')) return;
  card.setPointerCapture(event.pointerId);
  drag = { x: event.clientX, y: event.clientY, moved: false };
  card.classList.add('press');
});

card.addEventListener('pointermove', (event) => {
  if (!drag || !event.buttons) return;
  if (!drag.moved && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) > 4) {
    drag.moved = true;
    card.classList.add('dragging');
    api.dragStart();
    keepPanning(600);
  }
});

function endPress(cancel) {
  if (!drag) return;
  const moved = drag.moved;
  drag = null;
  card.classList.remove('press', 'dragging');
  if (moved) api.dragEnd();
  else if (!cancel) api.setExpanded(!expanded);
  keepPanning(500);
}

card.addEventListener('pointerup', () => endPress(false));
card.addEventListener('pointercancel', () => endPress(true));

$('#close').addEventListener('click', (event) => {
  event.stopPropagation();
  api.close();
});

// ------------------------------------------------------------------ live data

api.onStats(setMeters);
api.onBackdrop(applyBackdrop);
api.onProcesses((data) => {
  renderList($('#topCpu'), data.cpu);
  renderList($('#topRam'), data.ram);
});
api.onExpanded(setExpanded);

api.ready();
