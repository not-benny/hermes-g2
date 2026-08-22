#!/usr/bin/env bash
# Rebuild the WhatsApp engine zip asset after editing main.js (or bumping deps).
set -euo pipefail
cd "$(dirname "$0")"
npm ci --omit=dev --omit=optional --no-audit --no-fund
# WASM crypto lib crashes on the embedded Node; use the pure-JS shim.
cp patches/whatsapp-rust-bridge-shim.js node_modules/whatsapp-rust-bridge/dist/index.js
python3 - <<'PY'
import zipfile, os
out='../src/main/assets/whatsapp-node.zip'
with zipfile.ZipFile(out,'w',zipfile.ZIP_DEFLATED,compresslevel=6) as z:
    for root,dirs,files in os.walk('.'):
        dirs.sort()
        for f in sorted(files):
            if f == 'build-zip.sh': continue
            p=os.path.join(root,f)
            name=os.path.relpath(p,'.')
            info=zipfile.ZipInfo(name, (1980,1,1,0,0,0))
            info.compress_type=zipfile.ZIP_DEFLATED
            info.external_attr=(0o100644 << 16)
            with open(p,'rb') as source:
                z.writestr(info, source.read(), compress_type=zipfile.ZIP_DEFLATED, compresslevel=6)
print('wrote', out)
PY
