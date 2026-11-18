# Notch

A glass notch for Windows. The top of your screen becomes a slim pill showing the
time and battery; hover it and it unfolds into a panel. The Windows key opens a
search launcher instead of Start, and the taskbar lists everything you have open.

Frameless, transparent, always on top, and built as a single Electron app — no
installer, no browser, no web service.

## What you get

- **Notch panel** — a 96 px pill (time, date, battery, running focus timer) on the
  top edge. Hover to expand into a glass panel; keep it out with a click on the pin
  icon. The glass is a real liquid-glass treatment: a displacement rim, specular
  edge, chromatic dispersion and grain, sampled from your wallpaper (or the live
  desktop) behind it.
- **Launcher** — tap the Windows key and a search sheet drops down over the desktop.
  It indexes your Start-menu apps, filters as you type, and opens with ↑ ↓ ↵ or a
  click. Pinned apps sit in their own row.
- **Taskbar** — a floating bar with your pins plus every window that is open, in the
  order they appeared, with their real icons. Click one to bring it forward. The
  number badge on each button is its shortcut: `Win+1` … `Win+9`, `Win+0` for the
  tenth. Optional auto-hide keeps it off-screen until you touch the bottom edge or
  open the launcher.
- **Library** — scans Steam, Epic and your own shortcuts, shows the cover art, and
  launches a game with a click. Add a shortcut by hand if a launcher keeps it hidden.
- **Jarvis** — an assistant panel with a chat model picker and push-to-talk voice
  input transcribed on-device (Whisper, via `@huggingface/transformers`; the model
  downloads on first use).
- **Widget** — drag the panel away from the notch and it becomes a floating card you
  can drop anywhere and keep open.

## Requirements

- Windows 10 or 11 (the window helper and the key hook are PowerShell + Win32 calls)
- Node.js 18 or newer, for development only — the packaged executable needs
  nothing installed
- PowerShell 5.1, which ships with Windows

## Run it

```bash
npm install
npm start
```

The app starts with the pill on the top edge and sits in the tray. Nothing else is
needed: no build step, no API keys.

### A single executable

```bash
npm run dist
```

writes `dist/Notch-1.0.0.exe` — one portable file with no installer and no Node.js
on the target machine. It carries Electron, the Whisper loader and the Piper
voice, so speech works offline out of the box. Ollama and the speech model are
downloaded on first use, and the Jarvis setup card offers to install Ollama for
you. The voice files it bundles come from `tts/` (not in the repository; copy
`piper/` and the `.onnx` voice there before building if you want it included).

To check the interface without starting Electron — every window is a normal HTML
page — run the small static server and open <http://localhost:4173>:

```bash
npm run dev            # PORT=4173 by default
```

## Shortcuts

| Keys | Action |
| --- | --- |
| `Win` (tap) | open / close the launcher |
| `Ctrl+Alt+Space` | open / close the launcher |
| `Win+1` … `Win+9`, `Win+0` | open or focus the matching taskbar button |
| `Ctrl+Alt+N` | pin the notch panel open |
| `Ctrl+Alt+J` | open / close Jarvis |
| `Ctrl+Alt+Q` | quit |
| `↑` `↓` `↵` `Esc` | move, open, close inside the launcher |

The Windows key keeps its normal job for chords: `Win+E` and `Win+R` still reach
Explorer and Run, because the hook only swallows a tap on its own and any digit
chord the taskbar owns.

## Settings

Panel → menu (the sliders icon) → Settings. Everything is stored in
`%APPDATA%\notch\notch.json` and applied live:

- **Look** — accent colour, glass (liquid or frosted), tint, blur, grain, pill glow
- **Motion** — animation speed, easing, hover delay
- **Notch** — attached or island shape, pill width
- **Backdrop** — sample the live desktop or a fixed wallpaper image
- **Taskbar** — show it, glass or invisible surface, attached or island layout,
  items (both, open windows only, pins only), auto-hide
- **Start menu** — whether the Windows key opens this launcher
- **Start with Windows** — run at login (from the panel menu)

## How it works

```
main.js            owns all windows, settings, polling and IPC
winhook.ps1        keyboard hook + native window helper (one PowerShell process)
games.js           Steam / Epic / local game scanners
preload.js         `api` bridge for the notch, launcher and widget windows
src/index.html     notch pill + expanded panel (src/app.js, src/styles.css)
src/launcher.html  the search sheet (src/launcher.js, src/launcher.css)
src/taskbar.html   pins and open windows (src/taskbar.js, src/taskbar.css)
src/widget.html    the detached floating card
src/assistant.html Jarvis chat and voice UI (src/assistant*.js)
src/glass.js       wallpaper/live backdrop sampling for the glass layers
src/vendor/        liquid-glass shader helper
```

Two details are worth knowing because they explain the odd bits:

- **The key hook** (`winhook.ps1`) is a low-level `WH_KEYBOARD_LL` hook. It lets the
  Win key down through so chords work, swallows only the key-up of a tap, then
  injects a bracketed release (`Shift` down, `Win` up, `Shift` up) so the OS never
  leaves the modifier latched — without that, every later keystroke becomes a Win
  shortcut and typing appears to break.
- **The taskbar list is native.** Chromium's `desktopCapturer` leaves out whole apps
  (Windows Terminal, Explorer), so the same helper enumerates top-level windows with
  `EnumWindows` and reports handle, PID, title and executable. Icons come from
  `app.getFileIcon`, cached per executable. `desktopCapturer` stays as a fallback for
  when the helper isn't running.

The taskbar refreshes every 2.5 s and only re-sends when the list actually changes.
The auto-hide poll runs at 8 Hz and is a single cursor read, and only while the
option is on.

## Notes and limits

- The notch, launcher and taskbar live on the primary display.
- The taskbar lists top-level windows of the current desktop session; elevated apps
  are listed but may refuse focus, the same as Windows' own taskbar.
- The key hook is per-session. If it dies, the pill and shortcuts keep working but
  the Windows key falls back to Start until the app is restarted.
- Speech-to-text downloads its first model to `%APPDATA%\notch`; nothing is uploaded.

## Credits

The liquid-glass technique follows [shuding/liquid-glass](https://github.com/shuding/liquid-glass)
and [ccl125/liquid-glass](https://github.com/ccl125/liquid-glass) — an SVG
displacement rim with a specular edge and chromatic dispersion.

## Release

**v1.0.0** — first release: notch panel, launcher, taskbar with shortcuts and
auto-hide, game library, Jarvis assistant, detached widget, Windows-key hook.
