// Milestone 1a: prove the embedded Node runtime works and the NativeScript
// layer can reach it over a 127.0.0.1 loopback server. No Baileys yet - this
// is the toolchain-isolation step. Args: node main.js --port <p> --token <t>
'use strict';

const http = require('http');

function getArg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

const PORT = parseInt(getArg('port', '8791'), 10);
const TOKEN = getArg('token', '');

const server = http.createServer((req, res) => {
  // Bearer-token guard so no other app on the device can drive this.
  if (TOKEN && req.headers['authorization'] !== 'Bearer ' + TOKEN) {
    res.writeHead(401).end('unauthorized');
    return;
  }
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      engine: 'faceclaw-whatsapp-node',
      milestone: '1a',
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      pid: process.pid,
    }));
    return;
  }
  res.writeHead(404).end('not found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('[whatsapp-node] health server on 127.0.0.1:' + PORT + ' node=' + process.version);
});

server.on('error', (err) => {
  console.error('[whatsapp-node] server error: ' + err.message);
});

process.on('uncaughtException', (err) => {
  console.error('[whatsapp-node] uncaught: ' + (err && err.stack || err));
});
