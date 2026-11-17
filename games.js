'use strict';

// Finds games from Steam libraries, Epic installs and user-added shortcuts.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function regQuery(key, value) {
  try {
    const out = execFileSync('reg', ['query', key, '/v', value], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 4000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const match = out.match(/REG_SZ\s+(.+?)\s*$/m);
    return match ? match[1].trim() : null;
  } catch {
    return null;
  }
}

function readSteamLibraries() {
  const roots = new Set();
  const add = (candidate) => {
    if (!candidate) return;
    try {
      roots.add(path.resolve(candidate.replace(/"/g, '')));
    } catch {
      /* unusable path */
    }
  };

  add(regQuery('HKCU\\Software\\Valve\\Steam', 'SteamPath'));
  add(regQuery('HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam', 'InstallPath'));
  add(process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Steam'));
  add(process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Steam'));
  add(process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'Steam'));

  const libraries = new Set(roots);
  for (const root of roots) {
    let vdf = '';
    try {
      vdf = fs.readFileSync(path.join(root, 'steamapps', 'libraryfolders.vdf'), 'utf8');
    } catch {
      continue;
    }
    for (const match of vdf.matchAll(/"path"\s+"([^"]+)"/g)) {
      const clean = match[1].replace(/\\\\/g, '\\');
      if (clean) libraries.add(clean);
    }
  }
  return [...libraries];
}

function scanSteam() {
  const found = new Map();
  for (const library of readSteamLibraries()) {
    const apps = path.join(library, 'steamapps');
    let entries = [];
    try {
      entries = fs.readdirSync(apps).filter((file) => /^appmanifest_\d+\.acf$/.test(file));
    } catch {
      continue;
    }
    for (const entry of entries) {
      try {
        const text = fs.readFileSync(path.join(apps, entry), 'utf8');
        const appid = (text.match(/"appid"\s+"(\d+)"/) || [])[1];
        const name = (text.match(/"name"\s+"([^"]+)"/) || [])[1];
        if (!appid || !name) continue;
        if (/^(steamworks|proton|steam linux runtime|steamvr)/i.test(name)) continue;
        found.set(appid, { id: `steam:${appid}`, name, source: 'Steam', kind: 'steam', appid });
      } catch {
        /* unreadable manifest */
      }
    }
  }
  return [...found.values()];
}

function scanEpic() {
  const dat = path.join(
    process.env.ProgramData || 'C:\\ProgramData',
    'Epic',
    'UnrealEngineLauncher',
    'LauncherInstalled.dat',
  );
  try {
    const data = JSON.parse(fs.readFileSync(dat, 'utf8'));
    const list = Array.isArray(data.InstallationList) ? data.InstallationList : [];
    const seen = new Set();
    const out = [];
    for (const item of list) {
      if (!item || !item.AppName || seen.has(item.AppName)) continue;
      seen.add(item.AppName);
      const name = String(item.AppDisplayName || item.AppName).replace(/\s+/g, ' ').trim();
      if (!name) continue;
      out.push({
        id: `epic:${item.AppName}`,
        name,
        source: 'Epic',
        kind: 'epic',
        appName: item.AppName,
        path: item.InstallLocation || null,
      });
    }
    return out;
  } catch {
    return [];
  }
}

function scanLocal(list) {
  return (Array.isArray(list) ? list : [])
    .filter((entry) => entry && entry.path)
    .map((entry, index) => ({
      id: `local:${index}:${entry.path}`,
      name: entry.name || path.basename(entry.path, path.extname(entry.path)),
      source: 'Local',
      kind: 'local',
      path: entry.path,
    }));
}

function scanGames(localGames) {
  const merged = new Map();
  for (const game of [...scanSteam(), ...scanEpic(), ...scanLocal(localGames)]) {
    if (!merged.has(game.id)) merged.set(game.id, game);
  }
  return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name)).slice(0, 200);
}

module.exports = { scanGames };
