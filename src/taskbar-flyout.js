// The hover list for an app with several windows: one row per window, like the
// thumbnails the Windows taskbar stacks above a grouped button.

const list = document.querySelector('#fxList');
const api = window.taskbarAPI;
let rows = [];

function initials(text) {
  return String(text || '?')
    .replace(/\.exe$/i, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .slice(0, 2)
    .toUpperCase();
}

function render() {
  list.replaceChildren();
  for (const row of rows) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'fx-row';
    button.title = row.title || 'Window';
    if (row.icon) {
      const img = document.createElement('img');
      img.src = row.icon;
      img.alt = '';
      button.appendChild(img);
    } else {
      const label = document.createElement('span');
      label.className = 'fx-letters';
      label.textContent = initials(row.title);
      button.appendChild(label);
    }
    const title = document.createElement('span');
    title.className = 'fx-title';
    title.textContent = row.title || 'Window';
    button.appendChild(title);
    button.addEventListener('click', () => {
      if (api) api.pick(row.hwnd);
    });
    list.appendChild(button);
  }
}

if (api) {
  api.onRows((data) => {
    rows = data && Array.isArray(data.rows) ? data.rows : [];
    render();
  });
  api.flyoutReady();
}
