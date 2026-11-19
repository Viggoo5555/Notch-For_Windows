# Notch — project notes

## Liquid glass

Always use [ybouane/liquidglass](https://github.com/ybouane/liquidglass) (MIT) for
glass. It is the one renderer behind every surface — panel, taskbar, Start sheet,
detached widgets and the assistant lens — and the copy in `src/vendor/liquidglass.js`
is that library. Drive it through `src/glass.js` (and the per-surface wrappers
`src/widget-glass.js`, `src/assistant-glass.js`, `src/taskbar-flyout.js`) instead of
adding another glass library, a second copy, or a hand-written shader.

Credits for it belong in the README's **Credits** section.

## Releases

Ship the **installer** by default: `npm run dist:installer` builds
`dist/Notch-Setup-<version>.exe`, and that is the artifact the release carries. Build
the portable (`npm run dist`) only when it is asked for — it compresses for minutes on
its own and doubles the download.
