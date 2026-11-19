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

**[Notch-Setup-1.2.13.exe](https://github.com/Viggoo5555/Notch-For_Windows/releases/download/v1.2.13/Notch-Setup-1.2.13.exe)**
— the installer, about 341 MB.

1. Run it. Windows may warn that the publisher is unknown (the build is not
   code-signed): **More info → Run anyway**.
2. Pick a folder — the default is fine — and finish. Choose *Create desktop
   shortcut* if you want it on the desktop; the Start-menu entry is always made.
3. Launch **Notch** from the Start menu or the desktop shortcut. The pill appears
   at the top of the screen and the app sits in the tray.

It installs for your user only, so it never asks for an administrator password.
Remove it from *Settings → Apps → Notch*; your settings in
`%APPDATA%\notch\notch.json` are left in place.

No installer wanted? The portable file is only cut when someone asks for it, so the
newest one is still [Notch-1.2.7.exe](https://github.com/Viggoo5555/Notch-For_Windows/releases/download/v1.2.7/Notch-1.2.7.exe)
(~300 MB) — the same app as a single file, double-click and it runs, without
anything from 1.2.8 onwards.

All releases live at <https://github.com/Viggoo5555/Notch-For_Windows/releases>.

### Upgrading from an earlier version

Run the new installer over the old one; settings, pinned apps, the game library and
the overlay's corner are kept. Nothing else is needed — the first start asks nothing.

## What you get

- **Notch panel** — a 96 px pill (time, date, battery, running focus timer) on the
  top edge. Hover to expand into a glass panel; keep it out with a click on the pin
  icon. The glass is a real liquid-glass treatment: a displacement rim, specular
  edge, chromatic dispersion and grain, sampled from your wallpaper or from the
  live desktop — which it follows frame by frame while you are near it, so what
  moves behind the notch moves inside it too.
- **Launcher** — tap the Windows key and a search sheet drops down over the desktop:
  a fall of 28 px with a slight scale and a couple of pixels of settle, around 200 ms,
  opacity and transform only, so it is taking keys while it is still moving. It closes
  the same way — Esc, the Esc button, opening an app, clicking away and a second press
  of the key all play the fall out upwards before the window goes. It indexes your
  Start-menu apps, filters as you type, and opens with ↑ ↓ ↵ or a click. Pinned apps
  sit in their own row.
- **Taskbar** — two glass islands: the apps in the middle of the screen, the tray,
  battery and clock against the right edge. One button per app with its real icon —
  read from the executable itself, so apps Chromium cannot name still show their
  own mark — and one unbroken line under the icon however many windows the app has.
  Hover a button with several windows and a list of them opens above the bar. Click
  a button to bring that app forward (again to put it away). `Win+1` … `Win+0`
  focus the first ten buttons. Optional auto-hide keeps the bar off-screen until you
  touch the bottom edge or open the launcher.
- **Library and store** — the library scans Steam, Epic and your own shortcuts, shows
  the cover art, and launches a game with a click; add a shortcut by hand if a
  launcher keeps it hidden. The bag icon beside those buttons opens **Store** inside
  the panel: Steam's catalogue with today's discounts, drawn by Notch itself — its own
  search, discount chips (−25 / −50 / −75 %), price ceilings and sorting by discount,
  price or name, all happening in this window. SteamDB has no public API and its terms
  forbid scraping it, so the numbers come from Steam's own storefront, which is where
  SteamDB reads them too; a row opens the game's page when you want to buy.
- **Jarvis works Notch itself** — the assistant owns the app it lives in, not just
  the machine around it: *Jarvis, make it mint*, *frosted glass*, *turn the taskbar
  on*, *open the library*, *show the performance overlay*, *focus for 25 minutes*,
  *launch Hades II*, *rescan the library*, *taskbar auto-hide*, *start with Windows*,
  *quit Notch*. The reply is one short line and the change is already on screen, and
  the model is told the whole list, so it does not say it cannot.
- **Jarvis** — an assistant panel with a chat model picker, push-to-talk, and a
  "Hey Jarvis" wake word that keeps listening while the window is hidden — and the
  name on its own is enough once you have spoken to it in the last five minutes —
  *Jarvis*, *Jarvis, open Brave*. After a longer pause it wants a greeting in
  front: *Hey Jarvis*, *Okay Jarvis*, *Hej Jarvis*. Either way the chime plays and
  it listens for the order that follows. It can
  work the machine: *open Brave*, *open calculator and notepad*, *search Google for
  the weather*, *play Norah Jones*, or a whole sentence asking for one of those. It
  also answers with two voices — a light one that starts in under a second, and a
  studio voice that sounds like a recording on machines with a graphics card. When
  it answers with a question of its own it keeps listening, so the reply can be
  spoken straight back without saying the wake word again. It understands Danish: write or say *åbn lommeregner*, *hvad er klokken*, *søg efter
  vejret*, and it answers in Danish with a Danish voice.
- **Always on top** — the pill sits over the desktop, a maximised window and the
  taskbar alike, and asks for the front of the stack again whenever it is shown. The
  one thing it steps aside for is a fullscreen app: that is game mode, and it is now
  asked every two seconds instead of six, so the pill is out of the way almost as
  soon as something goes fullscreen and back as soon as it stops.
- **Game mode** — when a game takes the full screen, the whole shell stands down:
  windows hidden, captures and scans stopped, the microphone released, Chromium
  windows parked, and every process of the app dropped to idle priority so the game
  is never waiting behind it. Nothing is polled faster than two seconds, and the
  performance overlay and an opened System card are the only things that keep
  moving. Measured here: 150–180 % of one core while listening falls to 2–17 % of
  one, and roughly 1.7 GB of memory to 1.1–1.4 GB. It comes back by itself when you
  leave the game. What is left is the speech model itself: it is a few hundred
  megabytes of weights in the listening window, and the only way to give those back
  is to let go of the model entirely — which then has to be loaded again (about ten
  seconds) before the wake word works.
- **Widget** — drag the panel away from the notch and it becomes a floating card you
  can drop anywhere and keep open.
- **Performance overlay** — *menu → Performance overlay* puts four numbers on the
  screen with no card behind them: frames per second, CPU, GPU and RAM, the way a
  driver overlay looks. A dragged-out System card has the same thing one click
  away: its **–** button, next to the ✕, folds the whole card down into the
  overlay where the card was standing — and the overlay's **↗** button, next to
  its own ✕, opens the System card again in that same place. So the two are one
  widget in two sizes, and the way between them is one click either way. GPU is the graphics card's 3D engine load summed across
  everything drawing on it, which is what a game shows up as. It stays above
  everything, including a running game, never takes the keyboard, and remembers
  where you dragged it. The frame rate is the rate the
  desktop compositor delivers frames to that little window — your monitor's refresh
  when idle, and what a game is actually being shown at when it runs in a window or
  borderless, capped by the monitor. A game in exclusive fullscreen has no such
  hand-off, and its own internal frame counter is not something Windows gives a
  normal app; that needs PresentMon, which asks for an administrator prompt.

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

### Danish

Jarvis follows the language it is spoken to in. Set **Settings → Voice → Language**
to *Match what I write* (the default) and it answers in Danish when you use Danish,
in English otherwise; force *Dansk* to have it answer in Danish whatever you type.
The short commands work in both languages, and their answers come back in the
language you asked in — *åbn lommeregner* → "Åbner Lommeregner.", *hvad er klokken*
→ "Klokken er 19.14.".

The two voices follow the text: a Danish reply is read by the bundled Danish Piper
voice (`da_DK-talesyntese-medium`, ships in the package), an English one by the
British voice. The studio voice is English only, so Danish lines fall back to Piper
automatically, and a Danish line plays at its own pace instead of being slowed down
the way the British voice deliberately is. Nothing is sent anywhere.

Listening is the hard part, and it is worth being plain about it. Choosing *Dansk*
switches to a multilingual Whisper, because the small English model turns Danish
into English-sounding nonsense: without it *"Åbn lommeregner"* came back as *"Open
the door"*, and *"Hvad er klokken?"* as *"We're clopping."*. Two changes were made
and measured on the same four recorded phrases:

| | before | after |
| --- | --- | --- |
| Åbn lommeregner. | Open the door. | Open DOM 1 |
| Hvad er klokken? | We're clopping. | Hver kloppen? |
| Hvad er vejret i dag i Aarhus? | What is your day at home? | Hvad værdede de i jer huset? |
| Hej Jarvis. | Hi guys | Hej Guys! |

The first is that Danish is *named* to the model instead of letting it guess the
language from a one-second clip; the second is the model itself, sized to the
machine — Whisper base on a processor, Whisper small on a 4 GB graphics card, where
it is also fast enough to be worth it (small took 20–44 seconds per phrase on this
processor, which is not a conversation; base takes six to eight). Four threads are
given to Whisper and withheld from Moonshine: the tiny English model is small enough
that threading costs more than it saves, so English stays where it was — about a
quarter of a second.

It is still the weakest link in Danish: a short command comes back close but not
clean, and the name on its own survives while *"hej Jarvis"* spoken in Danish is
sometimes heard as *"Hej Guys!"*. Saying *"hey Jarvis"* the English way is
recognised reliably. Beyond that, the accuracy questions is answered by hardware:
on a graphics card Whisper small hears Danish properly.

### Build the download

```bash
npm run dist
```

writes two files into `dist/`: `Notch-Setup-1.2.13.exe`, the installer said above,
and `Notch-1.2.13.exe`, the same app as one portable file. Neither needs Node.js on
the target machine. `npm run dist:installer` builds only the installer, which is what
every release ships unless a portable has been asked for.

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
- **Motion** — whether animations follow Windows or always play (the override for a
  machine that has them switched off), animation speed, easing, hover delay
- **Notch** — attached or island shape, pill width
- **Backdrop** — follow the live desktop or pin a wallpaper image, and what the
  glass ended up doing (`WebGL`, `flat — no WebGL`, `flat — no image`)
- **Taskbar** — show it, glass or invisible surface, attached or island layout,
  items (both, open windows only, pins only), auto-hide
- **Voice** — speak replies, language (match what I write, Danish, English), the
  voice itself (studio, fast, or a Windows voice), speed, test button, and the
  "Hey Jarvis" wake word
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
src/vendor/                ybouane/liquidglass build, used as-is
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
- While the pointer rests near the notch with the live backdrop on, the desktop is
  streamed at 30 fps so the glass follows whatever moves behind it — a video, a
  dragged window, a scrolling page. The stream stops the moment the pointer leaves;
  if a machine refuses to hand one out, the glass falls back to a still sample
  refreshed every few seconds.

## Credits

The liquid glass on every surface — panel, taskbar, Start sheet, widgets and the
assistant lens — is [ybouane/liquidglass](https://github.com/ybouane/liquidglass)
(MIT): a copy of it sits in `src/vendor/liquidglass.js` and `src/glass.js` drives it,
so the glass is one library everywhere and never a hand-rolled shader. The technique
under it — an SVG displacement rim with a specular edge and chromatic dispersion —
was explored by [shuding/liquid-glass](https://github.com/shuding/liquid-glass) and
[ccl125/liquid-glass](https://github.com/ccl125/liquid-glass), whose pens informed
the look. The voices are
[Piper](https://github.com/rhasspy/piper) and [Kokoro](https://github.com/hexgrad/kokoro);
listening is [Whisper](https://github.com/openai/whisper) run through
[Transformers.js](https://github.com/huggingface/transformers.js).

## Release

**v1.2.13** — the bag in the library opens the store again. Pulling a tile out gave
the tile's own controls too much: the pointer was captured on every press, which hands
the click that follows to the tile, so the bag (and the rescan and add buttons) never
heard their own click and the panel simply opened the library. Capture now waits until
six pixels of movement have made the press a real pull, so taps belong to their
button and dragging out still works from anywhere on the tile.

**v1.2.12** — the glass shows the desktop and not the pointer: Windows paints the
cursor into every captured frame and Chromium cannot be asked to leave it out, so the
few pixels it covers are filled from the desktop beside them and softened. Cards come
out the moment they are pulled — the four draggable ones are built and loaded while
nothing is being captured, a few seconds after launch, so a drag only has to show a
window that is already there, and it starts after 6 px instead of 14. The focus dial
takes any length of session: press it, type the minutes (1–180), Enter.

**v1.2.11** — it updates itself. Notch asks GitHub for the newest release a few
seconds after it starts and then every six hours; when there is one, a toast says so
and **Settings → Update** reads *1.2.11 available* with a single **Update** button.
One press downloads that release's installer to the temp folder, showing the
percentage as it arrives, runs it silently and comes back as the new build — no
release page, no hunting for the file. The check is one small request; nothing is
downloaded until the button is pressed. On a machine that cannot reach GitHub the row
says so and the rest of the app is untouched, and a source checkout refuses to
self-replace.

**v1.2.10** — the installer actually contains the panel. The package listed its
preload scripts with the glob `*-preload.js`, which matches `launcher-preload.js` and
`widget-preload.js` but not the panel's own `preload.js`: every installed copy was
missing its bridge, so the window came up saying *"Notch is not connected here — start
the app from Notch.exe"* and the glass fell back to the flat material. The glob is now
`*preload.js`, and the installer carries the panel. Running from source was never
affected, which is why the app looked right there and wrong once installed.

**v1.2.9** — the glass follows the desktop, live. What sat behind the notch used to
be a photograph: the screen was grabbed whole, and one grab costs about a third of a
second on a normal PC, so the picture was refreshed every three and a half seconds and
the glass was always a little behind whatever moved behind it. The panel now opens one
continuous capture — the same one Windows runs for screen recording — and copies its own
slice of every frame straight into the glass, at screen rate, while you are near the
notch. A video, a dragged window or a scrolling page refracts as it happens. The stream
starts on the way in and stops the moment the pointer leaves, costs nothing when the
notch is untouched, and falls back to the old still sample on a machine that refuses to
hand one out. The notch and its windows stay out of their own picture, so the glass
never shows itself.

**v1.2.8** — a store, a butler, and a pill that stays on top.

The pill is raised again whenever it is shown and checked on the cursor poll, so a
window that takes the front of the stack cannot end up over it; a maximised app with
the taskbar auto-hidden no longer counts as fullscreen, which used to put the pill away
over an ordinary window; and the fullscreen question is asked every two seconds instead
of six, so the pill leaves a video or a game almost at once and is back the moment it
stops.

Jarvis works the app itself now, not just the machine around it: *make it mint*,
*frosted glass*, *taskbar auto-hide*, *open the library*, *show the performance
overlay*, *focus for 25 minutes*, *launch Hades II*, *rescan the library*, *start with
Windows*, *quit Notch*. What it changes is pushed to an open panel, so the drawer
matches the app, and its prompt lists everything Notch answers to, in English and
Danish.

The bag in the library opens **Store** inside the panel: Steam's own catalogue with
today's discounts, drawn by Notch with its own search, discount chips, price ceilings
and sorting, with nothing refetched for a filter change. SteamDB has no public API and
forbids scraping, so the prices come from Steam's storefront — which is where SteamDB
reads them too.

**v1.2.7** — motion and glass on machines that have neither. A school or work PC
usually arrives with Windows' animations switched off and no usable GPU, and Notch
obeyed both silently: the sheet appeared instead of dropping, the glass was a flat
panel, and nothing said why. **Settings → Motion → Animations: Windows / Always** now
lets the app play the drop, the fall back and the panel's transitions even where the
system setting is off for you, and the Start window is told the moment it changes.
Chromium's software rasterizer is enabled for WebGL, so the real shader runs on a
machine with no graphics hardware instead of falling back to the flat material —
slower, but glass, and it still parks itself while the panel is closed. The shader
also says what it is doing: *Settings → Backdrop → Glass* reads `WebGL`, `flat — no
WebGL` or `flat — no image`, and the last one is fixed with **Image → Choose…**.

**v1.2.6** — the panel page stops pretending to be a demo. Opening `src/index.html`
on its own — in a browser, or served by hand — put the panel into its browser-demo
mode: a dark demo gradient across the window, invented data, no glass and no
launcher, which reads exactly like a broken Notch. So did an app whose shell failed
to load, because the demo is what the page falls back to when it cannot find one.
Demo mode now has to be a page actually served by the dev server; anything else says
**"Notch is not connected here — start the app from Notch.exe"** at the bottom of the
window and draws no backdrop at all. The real app is unchanged — it is the installer or
`Notch-1.2.6.exe`, never the HTML file.

**v1.2.5** — the Start sheet opens and closes. 1.2.4's drop never really played: the
window was shown before the sheet started moving, so the motion was spent while the
renderer had nothing on screen and the sheet simply blinked into place. The sheet now
waits painted in its dismissed state, so the first frame the window presents is
transparent and the drop runs where it can be seen: a fall of 28 px with a slight
scale, a couple of pixels of overshoot and a settle, about 200 ms of eased motion
with the search box, results and footer rising 50 ms behind the glass. Closing is the
same state played backwards in about 190 ms, and every way out animates — Esc, the Esc
button, opening an app, clicking away, a second press of the Windows key — with the
window taken down only once the faded frame is on screen, which is also the frame the
next press starts from, so it no longer flashes the old picture. A press during the
dismissal re-opens the sheet from wherever it had got to. Only opacity and transform
move, so the sheet is still taking keys as it drops, and reduced-motion turns both
directions off.

**v1.2.4** — the Start sheet moves. Press the Windows key and the sheet now falls out
from under the notch instead of blinking into place: 26 px of travel with a slight
scale, a small overshoot and a settle, 240 ms of eased motion with the contents
rising a beat behind it. Only transform and opacity are animated, so the movement is
composited and the sheet is taking keys while it is still dropping; the reduced-motion
setting turns it off, and no fill mode is used, so if the motion is ever skipped the
sheet simply stands at rest rather than being left invisible at its first frame.

**v1.2.3** — the Start sheet types the moment it appears. Pressing the Windows key
and typing straight away could land letters in the previous window, or leave them
sitting in a queue for a third of a second, because the show path still did work
while it was coming up: it encoded a full-screen JPEG for the glass on every press
(a measured 78–113 ms of blocking work on this machine) and asked the keyboard
helper for the focus before trying the cheap in-process path. The glass image is now
encoded once and reused, prepared in the background after each show, the focus is
taken in-process first, the helper is only asked if the sheet is still not taking
keys a moment later, and the hidden sheet's renderer is no longer throttled. Ten
presses against the same ten before: typing-ready in 31–122 ms (median ~95 ms)
instead of 64–472 ms (median ~141 ms), with no press left waiting past 130 ms in the
common case.

**v1.2.2** — a performance overlay. *Menu → Performance overlay* puts four numbers on
the screen with nothing behind them — frames per second, CPU, GPU and RAM — always
above a running game and never taking the keyboard; the GPU figure is the card's 3D
engine load summed across everything drawing on it. A dragged-out System card folds
down to it with the **–** button beside its ✕, and the overlay's **↗** unfolds the
card again in the same place, so the two are one widget in two sizes and the way
between them is one click. Game mode became much cheaper: every process of the app
is dropped to idle priority so a game never waits behind it, an open System card
stays on screen on a three-second tick instead of a half-second one, and the
listening window is no longer parked by it — 150–180 % of one core while listening
falls to a single-digit share of one. Danish listening got faster as well: Whisper
runs on four threads instead of one, which took a short Danish phrase from 8–9 s to
6–8 s, with English untouched at a quarter of a second.

**v1.2.1** — Danish. Jarvis answers in Danish, reads it aloud in a bundled Danish
voice, runs the short commands in Danish and answers them in Danish, and listens
with a model that is told the language instead of guessing it. Language is a setting
of its own (match what I write, Dansk, English) and the listening model follows it,
sized to the machine. The wake word lost its training wheels: after five minutes
away it wants a greeting in front of the name — *hey Jarvis*, *okay Jarvis*, *hej
Jarvis* — and within a conversation the name alone will do, at a gate low enough
that a quick *"Jarvis"* is not swallowed. When its own answer ends in a question it
keeps listening for the reply, and returns quietly to waiting if none comes.

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
