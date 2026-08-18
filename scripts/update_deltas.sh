#!/usr/bin/env bash
# Verify the reviewed 2.2.8.4 firmware package, then regenerate the app's
# embedded offset/old/new patch set from its cross-compiled source.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
FW_DIR="${G2_FIRMWARE_DIR:-"$APP_DIR/../even-g2-cfw-8.4-verification"}"
PATCHER="$FW_DIR/sources/patch_compress.py"
STOCK="$FW_DIR/firmware/g2_2.2.8.4_stock.bin"
FIXED="$FW_DIR/firmware/g2_2.2.8.4_cfw_FIXED.bin"
OUTPUT_TS="$APP_DIR/app/g2/firmware/cfw-patches.ts"

for required in "$PATCHER" "$STOCK" "$FIXED" "$FW_DIR/scripts/verify_package.py"; do
  if [ ! -f "$required" ]; then
    printf 'error: missing firmware input: %s\n' "$required" >&2
    exit 1
  fi
done

(
  cd "$FW_DIR"
  python3 scripts/verify_package.py
)

python3 - "$PATCHER" "$STOCK" "$FIXED" "$OUTPUT_TS" <<'PY'
import hashlib
import importlib.util
import json
from pathlib import Path
import sys

patcher_path, stock_path, fixed_path, output_path = map(Path, sys.argv[1:])
spec = importlib.util.spec_from_file_location("hermes_g2_patch_compress", patcher_path)
if spec is None or spec.loader is None:
    raise SystemExit("error: cannot import firmware patcher")
module = importlib.util.module_from_spec(spec)
sys.path.insert(0, str(patcher_path.parent))
spec.loader.exec_module(module)
stock = stock_path.read_bytes()
fixed = fixed_path.read_bytes()
generated, operations = module.build_patch_ops(stock)
if generated != fixed:
    raise SystemExit("error: source rebuild does not match reviewed fixed artifact")
patch_set = {
    "base": "g2_2.2.8.4_stock.bin",
    "baseSha256": hashlib.sha256(stock).hexdigest(),
    "outputSha256": hashlib.sha256(fixed).hexdigest(),
    "patches": operations,
}
serialized = json.dumps(patch_set, indent=2, ensure_ascii=False)
content = f"""// AUTO-GENERATED from the reviewed Even G2 2.2.8.4 verification package.
// Regenerate with scripts/update_deltas.sh.
// Turns stock G2 2.2.8.4 into the statically verified Hermes G2 candidate.
// Hardware installation remains disabled until recovery validation is complete.

export type FirmwarePatchOp = {{
  offset: number;
  old: string;
  new: string;
  desc?: string;
}};

export type FirmwarePatchSet = {{
  base: string;
  baseSha256: string;
  outputSha256: string;
  patches: FirmwarePatchOp[];
}};

export const CFW_PATCH_SET: FirmwarePatchSet = {serialized};
"""
old = output_path.read_text(encoding="utf-8") if output_path.exists() else None
if old != content:
    output_path.write_text(content, encoding="utf-8")
print(
    f"Embedded {len(operations)} reviewed 2.2.8.4 patch operations; "
    f"output SHA-256 {patch_set['outputSha256']}"
)
PY
