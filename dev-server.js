'use strict';

// Zero-dependency static server so the notch can be tried in a browser.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, 'src');
const parsedPort = Number.parseInt(process.env.PORT, 10);
const port = Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : 4173;
// Loopback by default; `HOST=0.0.0.0` opens it to a preview proxy or a phone on
// the same network, which is the only reason to bind anything else.
const host = process.env.HOST || '127.0.0.1';

const types = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  // A module script is refused outright if it is not served as JavaScript, and
  // `src/core/*.mjs` are modules the launcher imports.
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

const server = http
  .createServer((req, res) => {
    const url = decodeURIComponent((req.url || '/').split('?')[0]);
    const rel = url === '/' ? '/index.html' : url;
    const file = path.join(root, rel);
    if (!file.startsWith(root)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404).end('not found');
        return;
      }
      res.writeHead(200, {
        'content-type': types[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'cache-control': 'no-store',
      });
      res.end(data);
    });
  })
  .listen(port, host, () => {
    const address = server.address();
    console.log(`notch demo → http://${host}:${address.port}`);
  });
