// Node 18 (nodejs-mobile) does not expose globalThis.crypto (the WebCrypto API)
// by default, but Baileys reads globalThis.crypto.subtle at module load. Install
// it from node:crypto's webcrypto before importing the engine, so this works
// without depending on the --experimental-global-webcrypto flag being compiled in.
import { webcrypto } from 'crypto';

if (!globalThis.crypto) {
  globalThis.crypto = webcrypto;
}

await import('./main.js');
