# Notch

A glass notch for Windows. The top of your screen becomes a slim pill showing the
time and battery; hover it and it unfolds into a panel. The Windows key opens a
search launcher instead of Start, the taskbar lists everything you have open, and
Jarvis sits in a small window: it listens for its name, answers with a local model
and does what you ask.

Frameless, transparent, always on top, and built as a single Electron app —
installed in a few clicks or run as one portable file, no browser, no web
service.

## Download

**[Notch-Setup-1.2.0.exe](https://github.com/Viggoo5555/Notch-For_Windows/releases/download/v1.2.0/Notch-Setup-1.2.0.exe)**
— the installer, about 300 MB.

1. Run it. Windows may warn that the publisher is unknown (the build is not
   code-signed): **More info → Run anyway**.
2. Pick a folder — the default is fine — and finish. Choose *Create desktop
   shortcut* if you want it on the desktop; the Start-menu entry is always made.
3. Launch **Notch** from the Start menu or the desktop shortcut. The pill appears
   at the top of the screen and the app sits in the tray.

It installs for your user only, so it never asks for an administrator password.
Remove it from *Settings → Apps → Notch*; your settings in
`%APPDATA%\notch\notch.json` are left in place.

No installer wanted? [Notch-1.2.0.exe](https://github.com/Viggoo5555/Notch-For_Windows/releases/download/v1.2.0/Notch-1.2.0.exe)
is the same app as a single portable file (~270 MB) — double-click and it runs.

All releases live at <https://github.com/Viggoo5555/Notch-For_Windows/releases>.

### Upgrading from 1.1.0

Run the new installer over the old one; settings, pinned apps and the game
library are kept. Nothing else is needed — the first start asks nothing.

## What you get

- **Notch panel** — a 96 px pill (time, date, battery, running focus timer) on the
  top edge. Hover to expand into a glass panel; keep it out with a click on the pin
  icon. The glass is a real liquid-glass treatment: a displacement rim, specular
  edge, chromatic dispersion and grain, sampled from your wallpaper (or the live
  desktop) behind it.
- **Launcher** — tap the Windows key and a search sheet drops down over the desktop.
  It indexes your Start-menu apps, filters as you type, and opens with ↑ ↓ ↵ or a
  click. Pinned apps sit in their own row.
- **Taskbar** — two glass islands: the apps in the middle of the screen, the tray,
  battery and clock against the right edge. One button per app with its real icon —
  read from the executable itself, so apps Chromium cannot name still show their
  own mark — and one unbroken line under the icon however many windows the app has.
  Hover a button with several windows and a list of them opens above the bar. Click
  a button to bring that app forward (again to put it away). `Win+1` … `Win+0`
  focus the first ten buttons. Optional auto-hide keeps the bar off-screen until you
  touch the bottom edge or open the launcher.
- **Library** — scans Steam, Epic and your own shortcuts, shows the cover art, and
  launches a game with a click. Add a shortcut by hand if a launcher keeps it hidden.
- **Jarvis** — an assistant panel with a chat model picker, push-to-talk, and a
  "Hey Jarvis" wake word that keeps listening while the window is hidden. It can
  work the machine: *open Brave*, *open calculator and notepad*, *search Google for
  the weather*, *play Norah Jones*, or a whole sentence asking for one of those. It
  also answers with two voices — a light one that starts in under a second, and a
  studio voice that sounds like a recording on machines with a graphics card.
- **Game mode** — when a game takes the full screen, the whole shell stands down:
  windows hidden, captures and scans stopped, the microphone released, Chromium
  windows parked. The cost falls from a third of a core to about a tenth of one, and
  it comes back by itself when you leave the game.
- **Widget** — drag the panel away from the notch and it becomes a floating card you
  can drop anywhere and keep open.

## Requirements

- Windows 10 or 11 (the window helper and the key hook are PowerShell + Win32 calls)
- Node.js 18 or newer, for development only — the packaged executable needs
  nothing installed
- PowerShell 5.1, which ships with Windows
- Optional: a discrete graphics card (6 GB or more) for the studio voice and the
  larger speech models; everything else works on integrated graphics

## Run it

```bash
npm install
npm start
```

`npm install` brings Electron plus the three things speech needs:
`@huggingface/transformers` (listening), `kokoro-js` (the studio voice) and the
Electron build itself. The app starts with the pill on the top edge and sits in the
tray: no build step, no API keys.

First use downloads what it needs, once, into `%APPDATA%\notch`: the Whisper
listening model (~80 MB), the Ollama model you pick (4–5 GB for 7B), and the studio
voice if you choose it (~90 MB). The fast voice ships inside the app and needs
nothing.

### Voice

Jarvis asks the machine what it can carry and recommends accordingly:

| | CPU / integrated graphics | 4 GB+ GPU | 6 GB+ GPU, 6+ cores |
| --- | --- | --- | --- |
| Voice | Jarvis (Piper, bundled) | Jarvis | Studio voice (Kokoro) offered first |
| Listening | Moonshine tiny | Whisper base on the GPU | Whisper small on the GPU |
| Brain | Qwen 2.5 1.5B | Qwen 2.5 3B | Qwen 2.5 7B (14B beyond 12 GB) |

Everything is a choice in Settings → Voice and Settings → models; the
recommendation is only a default. Model files for the other tiers download on first
use.

### Build the download

```bash
npm run dist
```

writes two files into `dist/`: `Notch-Setup-1.2.0.exe`, the installer said above,
and `Notch-1.2.0.exe`, the same app as one portable file. Neither needs Node.js on
the target machine. `npm run dist:installer` builds only the installer.

The package carries Electron, the Whisper loader, `kokoro-js` and the Piper voice,
so speech works offline out of the box. The Piper files it bundles come from `tts/`
(not in the repository; copy `piper/` and the `.onnx` voice there before building
if you want it included).

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
- **Voice** — speak replies, the voice itself (studio, fast, or a Windows voice),
  speed, test button, and the "Hey Jarvis" wake word
- **Start menu** — whether the Windows key opens this launcher
- **Start with Windows** — run at login (from the panel menu)

## How it works

```
main.js                    owns all windows, settings, polling and IPC
winhook.ps1                keyboard hook + native window helper (one PowerShell process)
games.js                   Steam / Epic / local game scanners
preload.js                 `api` bridge for the notch, launcher and widget windows
assistant-preload.js       `jarvis` bridge for the assistant window
taskbar-preload.js         bridge for the taskbar islands
src/index.html             notch pill + expanded panel (src/app.js, src/styles.css)
src/launcher.html          the search sheet (src/launcher.js, src/launcher.css)
src/taskbar.html           pins and open windows (src/taskbar.js, src/taskbar.css)
src/taskbar-flyout.html    the list of an app's windows, in liquid glass
src/widget.html            the detached floating card
src/assistant.html         Jarvis chat and voice UI (src/assistant*.js)
src/assistant-stt.worker.js  Whisper in a worker, on WebGPU or WASM
src/assistant-tts.worker.js  the studio voice in a worker, on WebGPU or WASM
src/voicehud.html          the ring visualiser drawn while Jarvis listens
src/glass.js               liquid-glass presets for every surface
src/vendor/                liquid-glass shader helper
```

Four details are worth knowing because they explain the odd bits:

- **The key hook** (`winhook.ps1`) is a low-level `WH_KEYBOARD_LL` hook. It lets the
  Win key down through so chords work, swallows only the key-up of a tap, then
  injects a bracketed release (`Shift` down, `Win` up, `Shift` up) so the OS never
  leaves the modifier latched — without that, every later keystroke becomes a Win
  shortcut and typing appears to break.
- **The taskbar list is native.** Chromium's `desktopCapturer` leaves out whole apps
  (Windows Terminal, Explorer), so the same helper enumerates top-level windows with
  `EnumWindows` and reports handle, PID, title and executable. Icons come from the
  executable's own resource first (Chromium hands back the generic page icon for
  apps that do ship one, which is why Freebuff showed a blank window), then from the
  window icon. `desktopCapturer` stays as a fallback for when the helper is not
  running.
- **Speech is chunked and rendered ahead.** Piper reads a whole request before it
  writes a note, so a reply is split into sentences (~120 characters, 60 for the
  first) and the next one is rendered while the current one plays. That is what
  brings the first word down from ten seconds to about two on an old laptop.
- **Game mode is asked, not guessed.** The helper reports Windows' own
  "something owns the display" state, plus whether a foreground window covers the
  screen without leaving room for the taskbar, so borderless games count too. While
  it holds, one check every six seconds is the only work the shell does.

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
- The studio voice needs a real graphics card. On a CPU it works but takes seconds
  per sentence, so it is not offered as the default there.
- While the pointer rests near the notch with the live backdrop on, the capture
  layer occasionally logs a DXGI warning. It is cosmetic and stops when the pointer
  moves away.

## Credits

The liquid-glass technique follows [shuding/liquid-glass](https://github.com/shuding/liquid-glass)
and [ccl125/liquid-glass](https://github.com/ccl125/liquid-glass) — an SVG
displacement rim with a specular edge and chromatic dispersion. The voices are
[Piper](https://github.com/rhasspy/piper) and [Kokoro](https://github.com/hexgrad/kokoro);
listening is [Whisper](https://github.com/openai/whisper) run through
[Transformers.js](https://github.com/huggingface/transformers.js).

## Release

**v1.2.0** — Jarvis can work the computer: open apps and browsers, search, play, or
do several of those from one sentence, with the model itself able to ask for an
action. A studio voice (Kokoro) joins the fast one, with the listening model and
brain sized to the machine — Whisper small and a 7B model on a real GPU. Game mode
stands the whole shell down while a game owns the screen, microphone included. Every
taskbar button now shows the icon from its executable (Freebuff, Calculator among
them) and one unbroken line under it instead of the split group bar; the shortcut
numbers in the corners are gone. The voice itself is deeper, cleaner, and starts
speaking in about two seconds instead of ten.

**v1.1.0** — the taskbar split into two islands (apps centred, tray, battery and
clock on the right), one button per app with a hover list of its windows, tray
icons read off the notification area, and the glass following the live desktop.
Shipped as a user-level installer with a Start-menu and desktop shortcut, plus
the portable exe.

**v1.0.0** — first release: notch panel, launcher, taskbar with shortcuts and
auto-hide, game library, Jarvis assistant, detached widget, Windows-key hook.
