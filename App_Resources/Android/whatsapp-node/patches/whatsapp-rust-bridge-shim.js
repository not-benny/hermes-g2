// Pure-JS replacement for whatsapp-rust-bridge (a Rust/WASM crypto lib that
// crashes on the embedded nodejs-mobile runtime - WASM threads / a missing
// pkg .js). Baileys 7 only uses md5, hkdf, expandAppStateKeys and
// LTHashAntiTampering from it; these all have deterministic pure-JS forms
// (the same ones Baileys 6.x shipped). Applied over node_modules/
// whatsapp-rust-bridge/dist/index.js by whatsapp-node/build-zip.sh.
import { createHash, createHmac } from 'crypto';

export const __wasmSimdActive = false;

const HASH_LEN = 32;

export function md5(data) {
  return createHash('md5').update(toBuf(data)).digest();
}

function toBuf(x) {
  return Buffer.isBuffer(x) ? x : Buffer.from(x);
}

// HKDF (RFC 5869, SHA-256), synchronous. Baileys calls hkdf(ikm, len, {salt?, info?}).
export function hkdf(buffer, expandedLength, info = {}) {
  const ikm = toBuf(buffer);
  const salt = info.salt ? toBuf(info.salt) : Buffer.alloc(HASH_LEN);
  const prk = createHmac('sha256', salt).update(ikm).digest();
  const infoBuf = info.info != null ? toBuf(info.info) : Buffer.alloc(0);
  const n = Math.ceil(expandedLength / HASH_LEN);
  const chunks = [];
  let prev = Buffer.alloc(0);
  for (let i = 0; i < n; i++) {
    prev = createHmac('sha256', prk)
      .update(Buffer.concat([prev, infoBuf, Buffer.from([i + 1])]))
      .digest();
    chunks.push(prev);
  }
  return Buffer.concat(chunks).subarray(0, expandedLength);
}

// App-state key expansion: hkdf to 160 bytes, sliced into the five WA keys.
export function expandAppStateKeys(appStateKey) {
  const k = hkdf(appStateKey, 160, { info: 'WhatsApp Mutation Keys' });
  return {
    indexKey: k.subarray(0, 32),
    valueEncryptionKey: k.subarray(32, 64),
    valueMacKey: k.subarray(64, 96),
    snapshotMacKey: k.subarray(96, 128),
    patchMacKey: k.subarray(128, 160),
  };
}

// LT-hash: a summation hash over app-state mutations. Each item is HKDF-expanded
// to 128 bytes, then combined pointwise as little-endian uint16 with mod-2^16
// overflow. Order-independent (add/subtract commute). Matches Baileys 6.x.
const LT_O = 128;

export class LTHashAntiTampering {
  constructor(salt = 'WhatsApp Patch Integrity') {
    this.salt = salt;
  }

  _combine(base, item, op) {
    const derived = hkdf(toBuf(item), LT_O, { info: this.salt });
    let baseBuf = base == null ? Buffer.alloc(0) : toBuf(base);
    if (baseBuf.length === 0) baseBuf = Buffer.alloc(derived.length);
    const out = Buffer.alloc(baseBuf.length);
    for (let i = 0; i + 1 < baseBuf.length; i += 2) {
      out.writeUInt16LE(op(baseBuf.readUInt16LE(i), derived.readUInt16LE(i)) & 0xffff, i);
    }
    return out;
  }

  add(base, items) {
    let r = base;
    for (const it of items) r = this._combine(r, it, (a, b) => a + b);
    return r;
  }

  subtract(base, items) {
    let r = base;
    for (const it of items) r = this._combine(r, it, (a, b) => a - b);
    return r;
  }

  subtractThenAdd(base, subtractItems, addItems) {
    return this.add(this.subtract(base, subtractItems), addItems);
  }
}
