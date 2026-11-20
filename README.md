# Notch

A glass notch for Windows. The top of your screen becomes a slim pill showing the
time and battery; hover it and it unfolds into a panel. The Windows key opens a
search launcher instead of Start, the taskbar lists everything you have open, and
Jarvis sits in a small window: it listens for its name, answers with a local model
and does what you ask.

Frameless, transparent, always on top, and built as a single Electron app —
installed in a few clicks, no browser, no web service.

## Download

**[Notch-Setup-1.2.33.exe](https://github.com/Viggoo5555/Notch-For_Windows/releases/download/v1.2.33/Notch-Setup-1.2.33.exe)**
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

Every release carries the installer and nothing else: one file to download, one thing
to uninstall, and no 300 MB portable build beside it. Settings still live in
`%APPDATA%\notch`, so an install over an older copy keeps everything.

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
  touch the bottom edge or open the launcher. Attached is one bar along the whole
  bottom edge: the apps stay centred on the screen while the notification tray,   the battery and the clock hold the right edge, the way a taskbar should, and a click on
  a tray icon is passed to that icon. A chevron leads the tray, as on Windows: it opens
  the notification icons the shell keeps hidden, every one of them clickable there.
  Right-click a button to pin it to the bar or take it off again, and drag a pin to
  put it where you want it — the order is kept between restarts.
- **Library and store** — the library scans Steam, Epic and your own shortcuts, shows
  the cover art, and launches a game with a click; add a shortcut by hand if a
  launcher keeps it hidden, and a hovered card has a small cross that takes a game
  out of the library for good (a rescan will not bring it back). The bag icon beside
  those buttons opens **Store** inside
  the panel: the top of Steam's whole catalogue, best reviewed first, with what players
  said about each game on the row ("Overwhelmingly Positive · 99%"), today's discounts,
  its own search, discount chips (−25 / −50 / −75 %), price ceilings and sorting by
  review score, number of reviews, discount, price or name — all happening in this
  window.   Steam's search answers a hundred games at a time and the list asks for the next
  hundred as you reach the bottom, so it scrolls forever; each row carries the
  game's own header art, and only the handful of rows around the pointer is ever
  drawn, so a list thousands long stays as light as a list of ten. SteamDB has no public API and
  its terms forbid scraping it, so the numbers come from Steam's own storefront, which
  is where SteamDB reads them too; a row opens the game's page when you want to buy.
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
  the weather*, *play Norah Jones*, *run ipconfig*, *volume up*, *lock the PC* — or a
  whole sentence asking for one of those. Anything with a command is allowed: an
  order that starts with *run* is handed to cmd exactly as spoken. It is also quick
  to think: the model is loaded into video memory when the window opens rather than
  when you ask, kept there between orders, and told to answer in two or three
  sentences with the answer first. It
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
- **Performance overlay** — pull the System tile out of the panel and the card you
  get is the overlay: four numbers with no card behind them — frames per second,
  CPU, GPU and RAM — the way a driver overlay looks. There is no menu switch for it,
  because the tile is the switch. Its **↗** button, next to the ✕, opens the full
  System card in the same place, and the card's **–** button folds it back down into
  the overlay. So the two are one widget in two sizes. GPU is the graphics card's 3D engine load summed across
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

writes `dist/Notch-Setup-1.2.15.exe`, the installer said above; it needs no Node.js on
the target machine. `npm run dist:installer` is the same build when the portable is
not wanted, and releases carry only the installer.

Pushing a version bump to `main` does that build on GitHub's Windows runner
(`.github/workflows/release.yml`), fetches the Piper voice it is not allowed to carry
in the repository, and publishes the result as `v<version>` — so a release is one
commit away and no Windows machine is needed here. A version that already has a
release is left alone.

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

**v1.2.33** — the pill keeps every piece you switch on. Its layout comes from
the editor, but the stylesheet still hid three of the pieces outright — **Date**,
**Battery** and the marks between them were `display: none` whatever the switches
said, so turning them on changed the saved order and nothing on screen (the
editor's preview hid them too, for the same reason). The layout is the only thing
that decides now. The pill is also no longer narrower than its pieces: the width
setting is a *floor*, not a ceiling, so switching Date on widens the pill — and
the hover rect behind it — to hold it, instead of pushing it out of the clip. The
preview in the editor grows the same way.

**v1.2.32** — the camera asks first. Pressing it (or Ctrl+Alt+S) no longer
photographs the whole screen: the shell steps aside, the display dims behind a
crosshair, and a drag picks the part to take — the size follows the corner while
you drag, everything outside the rectangle stays dark, and only what is inside
comes back. Esc or a right-click calls it off, and a drag under eight pixels is
treated as a stray click rather than a photograph of nothing. The frame is still
taken whole and cut to the rectangle afterwards, so both capture paths behave
exactly as before and the cut is scaled from the picture itself: on a display at
150%, a 640×360 drag saves 960×540 of real pixels. **Save**, **Text** and
**Font** work on the cut picture just as they did on the full screen.

**v1.2.31** — the bar gives the bottom edge back. The taskbar's window is a
strip along the bottom of the screen, exactly where Windows keeps its own, and
it took every click in that strip — including the stretches it never draws, so a
bar with no surface of its own left the real taskbar unclickable from end to end.
Each window now reports the boxes it actually paints: the slab, or the two
islands, or just the icons and the clock when the surface is invisible. The
pointer is read 25 times a second and the window takes a click only over one of
those boxes; everywhere else the click falls through to whatever is behind it.

**v1.2.30** — the camera reads the screen again. The shot went through the
keyboard helper's GDI grab, which answers *nothing at all* for a rectangle it does
not like — wider or taller than 4096 px, more than nine megapixels, or refused
because a DPI-unaware PowerShell sees a scaled desktop — and "nothing at all"
surfaced as "the screen could not be read". There are now two independent
captures: the helper at its own limits, with the display's DIP size as a second
try when the scaled size is out of reach, and Chromium's desktop capturer, which
is the path the glass backdrop already uses — so a machine whose glass works can
photograph its screen even when the helper cannot. The message now says Windows
refused the capture instead of pretending the screen came back empty.

**v1.2.29** — the pill is yours to arrange. Settings → Pill → **Customise…** opens a
stage showing the top of the screen with the pill hanging in it, and that pill is
the thing you edit: drag it left or right and that is where it hangs — the
window's hover rect moves with it, so it opens exactly where it looks. Width and
height are sliders underneath, and **Widgets** lists every piece the pill can
carry — status dot, clock, focus timer, date, battery — each with a switch to
show or hide it and a grip to drag into any order. The folded pill is rebuilt in
that order from the same elements, so the clock keeps ticking and the battery
keeps charging into it, and the separators work themselves out.

**v1.2.28** — a camera in the notch. Press it (or Ctrl+Alt+S) and the screen is
photographed with the shell left out of the frame: the windows go fully
transparent for the moment of the grab instead of hiding, so the panel does not
lose the pointer and close under itself. The picture opens as a preview with its
size in the corner, and three things sit under it. **Save** writes it to
`Pictures\Notch\Screenshots` as `Notch 2026-11-20 15-04-12.png`. **Text** reads it
with the OCR engine Windows already ships, shows what it found and puts it on the
clipboard. **Font** takes the biggest line of that text, draws it in every
installed typeface and ranks them by how much of the ink lands in the same place —
a best guess with a percentage, not a certificate. The reading runs in its own
PowerShell process (`shot-tools.ps1`), so a picture that will not open cannot take
the keyboard hook down with it.

**v1.2.27** — the System card keeps counting through a game. Game mode kept the
card on screen and kept sending it CPU, memory and disk, but the process list
underneath it is built by a sampler that returned immediately whenever a game was
running — so the card whose whole point is watching the game showed every row at
zero. The sampler now runs through a game at half its usual rate (6 s rather than
3 s), and its timer is re-armed when game mode starts or ends. Detection of
windowed fullscreen is fixed too: the geometry now measures the display the
foreground window is actually on instead of the primary one, so a borderless game
on a second monitor counts, and the "maximised app, not a game" rule only applies
to windows wearing a title bar and a resizable frame — a borderless window filling
its screen is a game whether or not it carries the maximized flag.

**v1.2.26** — the panel stays hoverable while it closes. Its hover rect dropped
back to the pill on a fixed 380 ms timer, whatever the close was doing — at an
animation speed above ~112% that is before the shape has finished shrinking, so
pointing at a panel that was visibly still there did nothing and you had to reach
for the pill. The drawer now reports its own clip duration (it follows the
animation-speed setting) and the hit rect follows it, ending on the transition's
own `transitionend` with the timer only as a net. The same number drives the
`closing` class and the shader pause, so the panel's contents no longer vanish
mid-shrink at slower animation speeds.

**v1.2.25** — the update check runs by itself, and shows what it found. It used to
be asked only when the drawer's Update row was pressed, so unless you went looking
nothing ever happened; it now runs five seconds after launch and every six hours,
and one request answers every asker. GitHub's API is rate limited per address, and
a shared one answers 403 — which used to end the check with "GitHub could not be
reached". It now falls back to the releases page's own redirect, which is not
limited, and builds the installer's address from the tag, so the update is found
either way. The answer is visible: the pill's dot turns green and says which build
is ready, the menu's foot reads v1.2.25 → v1.2.26, the tray menu carries
**Check for updates**, and the drawer's Update row names the newest version and
when it last asked. Installing shows the download as a percentage, waits four
seconds for Notch to be gone — so the silent install is not fighting a locked
file — then installs and starts the new build. Releases carry the installer only.

**v1.2.24** — a store you can fall down, with the games' own art, and a library
you can prune. Every row in the store carries the game's header picture now: the
panel's content policy was quietly refusing Steam's image host, so the rows were
text only. The list no longer stops at a fixed four hundred — it asks Steam's own
search for the next hundred as you reach the bottom, and only the rows around the
viewport are in the document, two above and two below, with spacers keeping the
scrollbar honest about the whole length. Search, the discount and price chips and
the six orders restart the list against Steam instead of filtering one fixed
fetch. In the library, hovering a game shows a small cross in its corner: it takes
the game out of the library, a rescan leaves it out, and nothing on disk is
deleted. Releases carry the installer only.

**v1.2.23** — the bar is the library's glass in every state. When the strip of
desktop behind the bar cannot be read — a locked screen, a display that is asleep,
a grab that comes back empty — the bar now refracts the wallpaper, or the last
frame it had, instead of dropping to a flat panel. The bar, the window list that
opens above it, the panel, the Start sheet, the widgets and the assistant lens all
go through the same copy of ybouane/liquidglass in `src/vendor/liquidglass.js`;
there is no second glass renderer anywhere, and the only painted surfaces left are
the ones chosen on purpose: the black material, and the single frame before the
lens has its first picture. Releases carry the installer only.

**v1.2.22** — the bar behaves like the one it replaces. The glass can no longer
go flat white: the strip of desktop the lens refracts is now decoded before it is
handed over, a failed grab keeps the picture that was already there, and a bar
with nothing to refract falls back to its dark surface instead of a white one.
The window list above a grouped button can actually be reached now — leaving the
button no longer closes it, so the pointer has time to cross the gap into the
list, and moving along the bar to another button closes it the way Windows does.
Auto-hide stands down while the bar's own right-click menu or that list is open,
so neither can be yanked off the screen. Pins are one per app whichever side made
them, so pinning a window the launcher already pinned no longer adds a second
button beside it, and a pin dragged anywhere onto the bar — the end of the row,
the tray side, a running app's button — lands at the end of the row instead of
snapping back. Releases carry the installer only.

**v1.2.21** — the bar is yours to arrange. Right-click any button and the bar offers
the one thing Windows' own menu leads with: pin a running app to the taskbar, or
unpin one that is already there — the pin takes the executable behind the window, so
it stays a single button with the app it opens instead of standing beside it. Drag a
pin and it follows the pointer: a light line shows the side it will land on, and the
new order is written down at once, so the bar comes back the way you left it after a
restart. Dragging only moves pins, never the windows that happen to be open, and the
chevron that opens Windows' hidden notification icons is still at the head of the
tray. Releases carry the installer only.

**v1.2.20** — the hidden icons, one click away. A chevron now leads the tray, where
Windows keeps it: it opens the panel of notification icons the shell holds back —
Discord, Steam, your sync clients, everything that sits behind the ^ — and each of
them can be clicked, hovered and right-clicked exactly as on the real bar. The panel
is Windows' own, so it carries the real icons, tooltips and menus, and it is asked
for the way a click on the shell's chevron asks for it, so its state never falls out
of step with the taskbar. The chevron shows in the attached bar and in the tray
island alike, and when the keyboard helper is off the bar presses the chevron in a
one-off process instead. Releases carry the installer only.

**v1.2.19** — a taskbar that works like the one it replaces, and no ghost mouse in
the glass. The bar now starts with the pins Windows does — the browser, Terminal,
File Explorer, Notepad and Settings, taken out of the Start menu with their real
icons — and a pin and the window it opens are one button instead of two, matched by
the executable behind the shortcut. A Start button left of the pins opens the
launcher's list of everything installed, so any app on the machine is reachable from
the bar. The right end keeps the notification area, battery and clock, and when the
tray helper cannot read the real icons it falls back to Network, Sound and Settings
buttons that open their Windows pages. The glass also stopped keeping a ghost of the
pointer: Windows draws the mouse into the screen capture, so the patch it covered is
healed with the colour around it before the frame reaches the glass. Releases carry
the installer only.

**v1.2.18** — files and code, and a trio that fits an integrated GPU. Jarvis makes
things now instead of only describing them: "create a folder called Projects on the
desktop" and "create a file called notes.txt with …" are carried out on disk before
a model is even asked, and when you ask it to write a script, a program or code it
answers with the whole code in one block and saves it beside you — on the Desktop,
or in the folder the path names — then says where it wrote it. The model can ask for
the same with `[[write: projects/app.py]]`, which makes the folder too, and
`[[mkdir: name]]` for an empty folder; nothing is written outside the folder or path
the order names, and `..` is refused. The three-model plan is also sized for a
machine with no dedicated card: the processor and RAM choose the rung, so 32 GB gets
the 3B / DeepSeek R1 8B / Coder 7B set, 16 GB gets 3B / R1 7B / Coder 3B, and 8 GB
with four cores gets the 1.5B trio — and the panel says plainly that those run on
the processor. Releases carry the installer only.

**v1.2.17** — three brains instead of one. The machine is read once and Jarvis
picks three models that fit it together: a small one that answers in about a
second, a reasoning model that thinks the harder questions through before it
answers, and a Qwen 2.5 Coder for code. On an 8 GB card that is Qwen 2.5 3B,
DeepSeek R1 8B and Qwen 2.5 Coder 7B — 11.8 GB in total; a 12 GB card gets 14B
for the thinking and the code, a 24 GB one gets 32B, and a small laptop gets the
1.5B/3B rung. One button in the model manager (`Install all three`) downloads
them one after another, the first-run card installs whichever are missing, and
the fast one is what starts awake. Releases carry the installer only.

**v1.2.16** — no-restriction models, and the Windows key again. The model manager
now lists abliterated and uncensored builds beside the ordinary ones —
`huihui_ai/qwen2.5-abliterate` at 1.5B, 3B, 7B, 14B and 32B, and Dolphin 3 8B — and
names the one that fits this machine next to the suggested brain: abliteration only
takes the refusal habit out, so the uncensored twin of the recommended size runs at
the same speed in the same memory. The Windows key is no longer a one-shot either: a
keyboard helper that dies, or never finishes starting, is brought back with a growing
wait instead of being given up on, an exception inside it now hands the key back to
Windows rather than ending the process, and the Start sheet no longer closes itself
when Windows hands the foreground over a beat late. Releases carry the installer only.

**v1.2.15** — the installer only, and a faster, larger Jarvis. The graphics card is
now measured by the driver's own registry figure instead of the 32-bit one Windows
reports, so an 8 GB card is seen as 8 GB and gets the 7B brain, whisper-small on the
GPU and the studio voice instead of the smaller tier. The model is loaded when the
assistant opens and kept in video memory (`keep_alive`), the reply is capped at two or
three sentences, and answers lead with the answer — the first word now arrives when
the question ends rather than after a 4.7 GB load. Jarvis also does more: `run`
hands any command to cmd, and lock, sleep, shutdown, restart, volume and screenshots
are orders of their own, alongside Settings, Camera, Photos, Device Manager and the
rest of Windows' own apps. The store is the top four hundred of Steam's catalogue
instead of thirty games, sorted by review score with each game's verdict on the row.
The taskbar attached is one bar along the whole bottom edge, so the tray, battery and
clock sit on the right of the screen and the tray icons are clickable; the bar no
longer disappears when nothing is open. Dragging the System tile out now gives the
performance overlay, and the menu item that used to switch it on is gone. Releases
carry the installer only.

**v1.2.14** — both downloads again. Every release now carries the installer *and*
the single-file portable build (`Notch-1.2.14.exe`), so Notch can be run without
installing anything. The app itself is 1.2.13's: the library's bag opens the store,
the glass hides the pointer and cards come out on the first move.

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
