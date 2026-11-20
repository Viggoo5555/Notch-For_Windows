'use strict';

// The overlay in one file: press, drag, release. The rectangle is reported in
// window coordinates, which the main process turns into screen coordinates and
// cuts the capture to.

const api = window.regionAPI;
const veil = document.querySelector('#veil');
const sel = document.querySelector('#sel');
const tag = document.querySelector('#tag');
const lineX = document.querySelector('#lineX');
const lineY = document.querySelector('#lineY');
const hint = document.querySelector('#hint');

// A drag shorter than this on either side is a stray click, not a choice.
const MIN = 8;

let start = null;
let box = null;

function paint() {
  if (!box) {
    sel.hidden = true;
    tag.hidden = true;
    return;
  }
  sel.hidden = false;
  sel.style.left = `${box.x}px`;
  sel.style.top = `${box.y}px`;
  sel.style.width = `${box.width}px`;
  sel.style.height = `${box.height}px`;
  tag.hidden = false;
  tag.textContent = `${Math.round(box.width)} × ${Math.round(box.height)}`;
  // Above the rectangle, unless there is no room up there.
  const above = box.y > 34;
  tag.style.left = `${Math.min(Math.max(box.x, 6), Math.max(6, window.innerWidth - 90))}px`;
  tag.style.top = above ? `${box.y - 27}px` : `${box.y + box.height + 7}px`;
}

function track(event) {
  lineX.hidden = false;
  lineY.hidden = false;
  lineX.style.top = `${event.clientY}px`;
  lineY.style.left = `${event.clientX}px`;
}

function reset() {
  start = null;
  box = null;
  veil.hidden = false;
  lineX.hidden = true;
  lineY.hidden = true;
  hint.classList.remove('gone');
  paint();
}

window.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return;
  hint.classList.add('gone');
  start = { x: event.clientX, y: event.clientY };
  box = { x: start.x, y: start.y, width: 0, height: 0 };
  // The selection carries the dimming now: the veil would darken the choice.
  veil.hidden = true;
  paint();
});

window.addEventListener('pointermove', (event) => {
  track(event);
  if (!start) return;
  box = {
    x: Math.min(start.x, event.clientX),
    y: Math.min(start.y, event.clientY),
    width: Math.abs(event.clientX - start.x),
    height: Math.abs(event.clientY - start.y),
  };
  paint();
});

window.addEventListener('pointerup', (event) => {
  if (!start) return;
  const picked = box;
  start = null;
  box = null;
  if (!picked || picked.width < MIN || picked.height < MIN) {
    if (api) api.cancel();
    return;
  }
  if (api) {
    api.pick({
      x: picked.x,
      y: picked.y,
      width: picked.width,
      height: picked.height,
    });
  }
});

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && api) api.cancel();
});

// A right-click is the other way out, as it is in Windows' own snip.
window.addEventListener('contextmenu', (event) => {
  event.preventDefault();
  if (api) api.cancel();
});

// Nothing starts a drag until the page is the thing under the pointer.
reset();
window.focus();
