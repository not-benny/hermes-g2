#!/usr/bin/env bash
# Rebuild the WhatsApp engine zip asset after editing main.js (or bumping deps).
set -euo pipefail
cd "$(dirname "$0")"
[ -d node_modules/@whiskeysockets ] || npm install --omit=dev --omit=optional --no-audit --no-fund
# WASM crypto lib crashes on the embedded Node; use the pure-JS shim.
cp patches/whatsapp-rust-bridge-shim.js node_modules/whatsapp-rust-bridge/dist/index.js
python3 - <<'PY'
import zipfile, os
out='../src/main/assets/whatsapp-node.zip'
with zipfile.ZipFile(out,'w',zipfile.ZIP_DEFLATED,compresslevel=6) as z:
    for root,_,files in os.walk('.'):
        for f in files:
            if f == 'build-zip.sh': continue
            p=os.path.join(root,f); z.write(p, os.path.relpath(p,'.'))
print('wrote', out)
PY
