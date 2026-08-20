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
let pairingInFlight = false;
let socketOpenedAt = 0;

async function startSocket() {
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
  let version;
  try {
    const v = await fetchLatestBaileysVersion();
    version = v.version;
    console.log('[wa] WA version ' + JSON.stringify(version) + ' (latest=' + v.isLatest + ')');
  } catch (e) {
    console.log('[wa] fetchLatestBaileysVersion FAILED: ' + (e?.message || e) + ' - using Baileys default');
  }

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

  socketOpenedAt = Date.now();
  sock.ev.on('creds.update', saveCreds);
  try {
    if (sock.ws && typeof sock.ws.on === 'function') {
      sock.ws.on('open', () => console.log('[wa] ws open (+' + (Date.now() - socketOpenedAt) + 'ms)'));
      sock.ws.on('close', (c, r) => console.log('[wa] ws close code=' + c + ' reason=' + (r || '?') + ' (+' + (Date.now() - socketOpenedAt) + 'ms)'));
      sock.ws.on('error', (e) => console.log('[wa] ws error: ' + (e?.message || e)));
    }
  } catch (e) { console.log('[wa] ws hook failed: ' + (e?.message || e)); }

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, isNewLogin } = update;
    const registered = !!sock?.authState?.creds?.registered;
    if (connection === 'connecting') {
      connectionState = 'connecting';
      emit({ event: 'connecting' });
    } else if (connection === 'open') {
      connectionState = 'connected';
      pairingInFlight = false;
      connectedUser = sock?.user ? { id: sock.user.id || null, name: sock.user.name || sock.user.verifiedName || null } : null;
      pairing.code = null;
      emit({ event: 'connected', user: connectedUser });
      console.log('[wa] CONNECTED as ' + (connectedUser?.id || '?') + ' newLogin=' + isNewLogin);
    } else if (connection === 'close') {
      const err = lastDisconnect?.error;
      const code = err?.output?.statusCode;
      const dt = socketOpenedAt ? (Date.now() - socketOpenedAt) : -1;
      console.log('[wa] close code=' + code + ' registered=' + registered +
        ' pairingInFlight=' + pairingInFlight + ' aliveMs=' + dt +
        ' msg=' + (err?.message || '?') +
        ' data=' + JSON.stringify(err?.output?.payload || err?.data || {}));
      if (code === DisconnectReason.loggedOut) {
        // A real logout only makes sense once registered. During pairing an
        // unregistered 401 is a failed attempt - surface it, keep the session so
        // a fresh /pair can retry (don't wipe unless asked).
        connectionState = registered ? 'logged_out' : 'disconnected';
        lastError = registered ? 'logged_out' : 'pairing_failed_401';
        emit({ event: registered ? 'logged_out' : 'pairing_failed', code });
      } else if (code === DisconnectReason.restartRequired || code === 515) {
        // Expected right after a successful pairing: reconnect to finish login.
        connectionState = 'connecting';
        emit({ event: 'restart', code });
        setTimeout(() => { startSocket().catch((e) => { lastError = String(e); }); }, 800);
      } else if (registered) {
        // Normal runtime drop: reconnect.
        connectionState = 'disconnected';
        emit({ event: 'disconnected', code });
        setTimeout(() => { startSocket().catch((e) => { lastError = String(e); }); }, 3000);
      } else {
        // Unregistered transient close DURING pairing: do NOT churn the socket
        // (reconnecting abandons the pairing). Hold; the user still has the code.
        connectionState = 'pairing';
        emit({ event: 'pairing_wait', code });
        console.log('[wa] holding pairing socket (code still valid): ' + (pairing.code || '?'));
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

// True once this device has completed a link (creds carry a registration).
function isRegistered() {
  try {
    const p = path.join(SESSION_DIR, 'creds.json');
    if (!fs.existsSync(p)) return false;
    return !!JSON.parse(fs.readFileSync(p, 'utf8'))?.registered;
  } catch { return false; }
}

// Wipe the auth state so the next pairing starts clean. A prior aborted attempt
// leaves an *unregistered* creds.json (noise keys, no registration); reconnecting
// with it makes WA reject the session with 401 "Connection Failure" seconds after
// the code is minted, before the user can enter it. Only ever called when not
// registered, so a live link is never destroyed.
function clearSession() {
  try {
    for (const f of fs.readdirSync(SESSION_DIR)) {
      fs.rmSync(path.join(SESSION_DIR, f), { recursive: true, force: true });
    }
    console.log('[wa] session cleared for fresh pairing');
  } catch (e) { console.log('[wa] clearSession failed: ' + (e?.message || e)); }
}

async function requestPairing(phoneNumber) {
  const digits = String(phoneNumber).replace(/[^0-9]/g, '');
  if (!digits) throw new Error('invalid phone number');
  if (connectionState === 'connected' && isRegistered()) {
    throw new Error('already linked; unlink first to re-pair');
  }
  // Fresh pairing: tear down any half-open socket and clear stale/partial auth
  // state, otherwise WA 401s the reconnect. This is the fix for the pairing code
  // dying seconds after it is issued.
  if (sock) { try { sock.end?.(new Error('re-pair')); } catch {} sock = null; }
  if (!isRegistered()) clearSession();
  pairingInFlight = true;
  await startSocket();
  // Brief settle for the WS to open before asking for a code (too long and WA
  // closes the unregistered socket first).
  await delay(800);
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
  res.json({ ok: true, engine: 'faceclaw-whatsapp', milestone: '1c', node: process.version, arch: process.arch, baileys: true, state: connectionState });
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

// Auto-connect on boot only when actually linked. An unregistered creds.json is
// a stale/partial pairing attempt: connecting with it would 401, so leave it for
// the next /pair to clear.
if (isRegistered()) {
  console.log('[wa] registered session found, auto-connecting');
  startSocket().catch((e) => { lastError = String(e); console.error('[wa] auto-connect failed: ' + e); });
} else if (fs.existsSync(path.join(SESSION_DIR, 'creds.json'))) {
  console.log('[wa] stale unregistered session on boot, leaving for next /pair to clear');
}

process.on('uncaughtException', (e) => console.error('[wa] uncaught: ' + (e?.stack || e)));
process.on('unhandledRejection', (e) => console.error('[wa] unhandled: ' + (e?.stack || e)));
