// In-app WhatsApp engine for Hermes G2. Runs on the embedded nodejs-mobile
// runtime and links Ben's WhatsApp as a companion device ("Hermes G2") via the
// multi-device pairing-code flow. Forked from the proven ~/.hermes whatsapp
// bridge, adapted for in-app use: app-private session dir, 127.0.0.1 loopback
// bound + bearer-token guarded, pairing code instead of QR, SSE event stream.
//
// Args: node main.js --port <p> --token <t> --session <dir>
import { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import express from 'express';
import pino from 'pino';
import fs from 'fs';
import path from 'path';

function getArg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const PORT = parseInt(getArg('port', '8799'), 10);
const TOKEN = getArg('token', '');
const SESSION_DIR = getArg('session', path.join(process.env.HOME || '.', 'whatsapp', 'session'));
fs.mkdirSync(SESSION_DIR, { recursive: true });

const logger = pino({ level: 'warn' });

let sock = null;
let connectionState = 'idle';      // idle | connecting | connected | disconnected | logged_out
let connectedUser = null;
let lastError = null;
let pairing = { phone: null, code: null, at: 0 };

// --- SSE event stream --------------------------------------------------------
const sseClients = new Set();
function emit(event) {
  const line = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of sseClients) { try { res.write(line); } catch {} }
}

// --- Baileys socket ----------------------------------------------------------
async function startSocket() {
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
  let version;
  try { ({ version } = await fetchLatestBaileysVersion()); } catch {}

  connectionState = 'connecting';
  sock = makeWASocket({
    ...(version ? { version } : {}),
    auth: state,
    logger,
    printQRInTerminal: false,
    browser: ['Hermes G2', 'Chrome', '120.0'],
    syncFullHistory: false,
    markOnlineOnConnect: false,
    // Baileys 7 needs this or messages needing E2EE re-establishment are dropped.
    getMessage: async () => ({ conversation: '' }),
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect } = update;
    if (connection === 'connecting') {
      connectionState = 'connecting';
      emit({ event: 'connecting' });
    } else if (connection === 'open') {
      connectionState = 'connected';
      connectedUser = sock?.user ? { id: sock.user.id || null, name: sock.user.name || sock.user.verifiedName || null } : null;
      pairing.code = null;
      emit({ event: 'connected', user: connectedUser });
      console.log('[wa] connected as ' + (connectedUser?.id || '?'));
    } else if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        connectionState = 'logged_out';
        lastError = 'logged_out';
        emit({ event: 'logged_out' });
        console.log('[wa] logged out');
      } else {
        connectionState = 'disconnected';
        emit({ event: 'disconnected', code });
        console.log('[wa] closed (' + code + '), reconnecting');
        setTimeout(() => { startSocket().catch((e) => { lastError = String(e); }); }, code === 515 ? 1000 : 3000);
      }
    }
  });

  sock.ev.on('messages.upsert', ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const m of messages) {
      const from = m.key?.remoteJid || '?';
      const text = m.message?.conversation || m.message?.extendedTextMessage?.text || '[non-text]';
      emit({ event: 'message', from, fromMe: !!m.key?.fromMe, text: String(text).slice(0, 200), ts: Number(m.messageTimestamp) || 0 });
      console.log('[wa] msg from ' + from + ': ' + String(text).slice(0, 80));
    }
  });

  return sock;
}

async function requestPairing(phoneNumber) {
  const digits = String(phoneNumber).replace(/[^0-9]/g, '');
  if (!digits) throw new Error('invalid phone number');
  if (!sock) await startSocket();
  // requestPairingCode must run once the socket is up but before registration.
  for (let i = 0; i < 20; i++) {
    try {
      const code = await sock.requestPairingCode(digits);
      pairing = { phone: digits, code, at: Date.now() };
      emit({ event: 'pairing_code', code, phone: digits });
      console.log('[wa] pairing code for ' + digits + ': ' + code);
      return code;
    } catch (e) {
      lastError = String(e?.message || e);
      await delay(500);
    }
  }
  throw new Error('could not obtain pairing code: ' + lastError);
}

// --- loopback HTTP API -------------------------------------------------------
const app = express();
app.use(express.json());
app.use((req, res, next) => {
  if (TOKEN && req.headers['authorization'] !== 'Bearer ' + TOKEN) return res.status(401).end('unauthorized');
  next();
});

app.get('/health', (req, res) => {
  res.json({ ok: true, engine: 'faceclaw-whatsapp', milestone: '1b', node: process.version, arch: process.arch, baileys: true, state: connectionState });
});
app.get('/status', (req, res) => {
  res.json({ state: connectionState, user: connectedUser, pairingCode: pairing.code, lastError });
});
app.post('/pair', async (req, res) => {
  try {
    const code = await requestPairing(req.body?.phoneNumber);
    res.json({ ok: true, code });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});
app.post('/connect', async (req, res) => {
  try { if (!sock) await startSocket(); res.json({ ok: true, state: connectionState }); }
  catch (e) { res.status(500).json({ ok: false, error: String(e?.message || e) }); }
});
app.get('/events', (req, res) => {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  res.write(`data: ${JSON.stringify({ event: 'hello', state: connectionState })}\n\n`);
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

app.listen(PORT, '127.0.0.1', () => {
  console.log('[wa] engine listening on 127.0.0.1:' + PORT + ' node=' + process.version);
});

// If a session already exists (previously linked), auto-connect on boot.
if (fs.existsSync(path.join(SESSION_DIR, 'creds.json'))) {
  startSocket().catch((e) => { lastError = String(e); console.error('[wa] auto-connect failed: ' + e); });
}

process.on('uncaughtException', (e) => console.error('[wa] uncaught: ' + (e?.stack || e)));
process.on('unhandledRejection', (e) => console.error('[wa] unhandled: ' + (e?.stack || e)));
