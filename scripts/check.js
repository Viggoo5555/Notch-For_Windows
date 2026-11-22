#!/usr/bin/env node
'use strict';

// Wiring checks that a compiler cannot make for this app: every renderer call
// has a bridge behind it, every channel a preload sends has a listener in main,
// every element a renderer asks for exists in its page, and the glass is only
// ever ybouane/liquidglass. It reads the files as text on purpose — no Electron,
// no browser, no dependencies — so it runs on any machine and in CI.
//
//   node scripts/check.js          report findings, exit 1 on an error
//   node scripts/check.js --warn   report findings, exit 0 (advisory)

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const strict = !process.argv.includes('--warn');
const problems = [];
const warnings = [];

const rel = (file) => path.relative(root, file).split(path.sep).join('/');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

function fail(file, line, message) {
  problems.push(`${file}:${line} ${message}`);
}
function warn(file, line, message) {
  warnings.push(`${file}:${line} ${message}`);
}

// ---------------------------------------------------------------- every script
// A file with a syntax error is not worth checking for anything else.
// Every path in here is relative to the repository and written with forward
// slashes, so the checks mean the same thing on Windows as on anything else.
const scripts = [];
(function walk(dir) {
  const here = dir ? path.join(root, dir) : root;
  for (const entry of fs.readdirSync(here, { withFileTypes: true })) {
    const full = dir ? `${dir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (/^(node_modules|dist|tts|\.git|\.github|src\/vendor)$/.test(full)) continue;
      walk(full);
      continue;
    }
    if (/\.(js|mjs)$/.test(entry.name)) scripts.push(full);
  }
})('');

// Parsed as a module, whichever file it is: a page script is a `type="module"`
// document, and checking one of those as CommonJS rejects every `import` in it.
// A `.mjs` copy in a temporary folder is the same syntax to Node, and it does not
// depend on the Node version's idea of a `.js` file.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'notch-check-'));
try {
  scripts.sort().forEach((file, index) => {
    const copy = path.join(scratch, `m${index}.mjs`);
    try {
      fs.copyFileSync(path.join(root, file), copy);
      execFileSync(process.execPath, ['--check', copy], { stdio: 'pipe' });
    } catch (error) {
      const output = String((error.stderr || error.stdout || '') + '')
        .split('\n')
        .filter((line) => line.trim())
        .slice(0, 3)
        .join(' ');
      problems.push(`${file} does not parse: ${output}`);
    }
  });
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}

// ------------------------------------------------------------------- the glass
// One library, one copy: anything else is a second renderer wearing the same
// name, which is exactly what the project notes forbid.
const GLASS_OK = new Set(['glass.js', 'widget-glass.js', 'assistant-glass.js', 'vendor/liquidglass.js']);
for (const file of scripts.filter((entry) => entry.startsWith('src/'))) {
  const text = read(file);
  const imports = text.matchAll(/from\s+['"]([^'"]*glass[^'"]*)['"]/g);
  for (const [, from] of imports) {
    const named = from.replace(/^\.\//, '');
    if (!GLASS_OK.has(named)) {
      fail(rel(file), text.slice(0, text.indexOf(from)).split('\n').length, `imports ${from}, not the vendored liquid glass`);
    }
  }
}

// ------------------------------------------------------------ preload surfaces
const preloads = scripts.filter((file) => /-preload\.js$/.test(file) || file === 'preload.js');
const surfaces = new Map();
for (const file of preloads) {
  const text = read(file);
  const open = text.match(/exposeInMainWorld\(\s*['"](\w+)['"]\s*,\s*\{/);
  if (!open) {
    // A preload that exposes nothing is not a preload.
    fail(rel(file), 1, 'no contextBridge.exposeInMainWorld');
    continue;
  }
  const start = open.index + open[0].length;
  const end = text.lastIndexOf('});');
  const body = text.slice(start, end > start ? end : undefined);
  const keys = new Set();
  let line = text.slice(0, start).split('\n').length;
  for (const row of body.split('\n')) {
    line += 1;
    const key = row.match(/^\s{2}(['"]?)([A-Za-z_$][\w$]*)\1\s*:/);
    if (key) keys.add(key[2]);
  }
  surfaces.set(open[1], { file: rel(file), keys });
}

// Every `api.x` a renderer calls must be a key of the bridge it was handed.
const renderers = scripts.filter(
  (file) => file.startsWith('src/') && !/vendor|worker|glass|core\//.test(file),
);
for (const file of renderers) {
  const text = read(file);
  const bridge = text.match(/const\s+\w+\s*=\s*window\.(\w+)/);
  if (!bridge) continue;
  const surface = surfaces.get(bridge[1]);
  if (!surface) {
    fail(rel(file), text.slice(0, bridge.index).split('\n').length, `uses window.${bridge[1]} but no preload exposes it`);
    continue;
  }
  const named = text.match(new RegExp(`const\\s+(\\w+)\\s*=\\s*window\\.${bridge[1]}`));
  const alias = named ? named[1] : 'api';
  for (const [, method] of text.matchAll(new RegExp(`\\b${alias}\\.(\\w+)\\s*\\(`, 'g'))) {
    if (!surface.keys.has(method)) {
      fail(rel(file), text.slice(0, text.indexOf(method)).split('\n').length, `calls api.${method}, which ${surface.file} does not expose`);
    }
  }
}

// ------------------------------------------------------------- ipc channels
// A send with no listener is a silent no-op, which reads as a dead button.
const mainText = read('main.js');
const handled = new Set();
const registrations = new Map();
for (const [, channel] of mainText.matchAll(/ipcMain\.(?:on|handle|handleOnce|once)\(\s*['"]([^'"]+)['"]/g)) {
  handled.add(channel);
  registrations.set(channel, (registrations.get(channel) || 0) + 1);
}
// Two handlers for one channel is a listener leak at best and two answers at
// worst; one of the two is almost always a rename that missed a call.
for (const [channel, count] of registrations) {
  if (count > 1) warn('main.js', 1, `"${channel}" is handled ${count} times`);
}
// Channels main answers from a loop are still channels.
for (const file of preloads) {
  const text = read(file);
  let line = 0;
  for (const row of text.split('\n')) {
    line += 1;
    for (const [, channel] of row.matchAll(/ipcRenderer\.(?:send|invoke)\(\s*['"]([^'"]+)['"]/g)) {
      if (channel.startsWith('test:')) continue;
      if (!handled.has(channel)) fail(rel(file), line, `sends "${channel}", which main never answers`);
    }
  }
}

// ------------------------------------------------------------------ element ids
// A getElementById for an id the page does not have is a null, and a null is a
// feature that quietly did nothing.
const PAGES = [
  ['src/index.html', ['src/app.js']],
  ['src/launcher.html', ['src/launcher.js']],
  ['src/taskbar.html', ['src/taskbar.js']],
  ['src/taskbar-flyout.html', ['src/taskbar-flyout.js']],
  ['src/assistant.html', ['src/assistant.js']],
  ['src/region.html', ['src/region.js']],
  ['src/widget.html', ['src/widget.js']],
  ['src/voicehud.html', ['src/voicehud.js']],
];
for (const [page, rendererFiles] of PAGES) {
  if (!fs.existsSync(path.join(root, page))) continue;
  const html = read(page);
  const ids = new Set([...html.matchAll(/\bid=["']([^"']+)["']/g)].map((match) => match[1]));
  for (const file of rendererFiles) {
    if (!fs.existsSync(path.join(root, file))) continue;
    const text = read(file);
    // Ids the renderer builds itself, before or while it looks for them.
    const built = new Set([
      ...[...text.matchAll(/\.id\s*=\s*['"`]([\w-]+)['"`]/g)].map((match) => match[1]),
      ...[...text.matchAll(/\bid\s*:\s*['"`]([\w-]+)['"`]/g)].map((match) => match[1]),
      ...[...text.matchAll(/\bid=["']([\w-]+)["']/g)].map((match) => match[1]),
    ]);
    // Ids built from a template (`dVal${key}`) or a concatenation (`'top-' + id`)
    // cannot be listed, but their prefix says which lookups they answer.
    const prefixes = new Set([
      ...[...text.matchAll(/`([A-Za-z][\w-]{2,})\$\{/g)].map((match) => match[1]),
      ...[...text.matchAll(/['"]([A-Za-z][\w-]{2,})['"]\s*\+/g)].map((match) => match[1]),
    ]);
    let line = 0;
    for (const row of text.split('\n')) {
      line += 1;
      const lookups = [
        ...row.matchAll(/getElementById\(\s*['"]([^'"]+)['"]/g),
        ...row.matchAll(/(?:^|[^.\w])\$\(\s*['"]([^'"]+)['"]/g),
        ...row.matchAll(/querySelector\(\s*['"]#([\w-]+)['"]/g),
      ];
      for (const [, found] of lookups) {
        // Only a plain id selector is a request for an element: `.class`, `[attr]`
        // and descendant selectors are not, and an id the same file builds before
        // it looks is a request the page does not have to answer.
        if (!/^#?[A-Za-z][\w-]*$/.test(found)) continue;
        const id = found.replace(/^#/, '');
        if (ids.has(id) || built.has(id)) continue;
        if ([...prefixes].some((prefix) => id.startsWith(prefix))) continue;
        warn(rel(file), line, `asks for #${id}, which ${page} does not have`);
      }
    }
  }
}

// ---------------------------------------------------------------------- report
for (const line of problems) console.log(`error   ${line}`);
for (const line of warnings) console.log(`warning ${line}`);
const counts = `${problems.length} error${problems.length === 1 ? '' : 's'}, ${warnings.length} warning${warnings.length === 1 ? '' : 's'}`;
console.log(`\ncheck: ${counts} in ${scripts.length} scripts`);
if (problems.length && strict) process.exit(1);
