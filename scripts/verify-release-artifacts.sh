#!/usr/bin/env bash
set -euo pipefail

APK=${1:-$(find platforms/android/app/build/outputs/apk -type f -name '*.apk' -print -quit)}
if [[ -z "${APK:-}" || ! -f "$APK" ]]; then
  printf 'APK not found\n' >&2
  exit 1
fi

mkdir -p build/reports
REPORT=build/reports/native-alignment.txt
: > "$REPORT"
unzip -t "$APK" >/dev/null

unzip -Z1 "$APK" | python3 -c 'import sys
blocked=("/home/", "/Users/", ".hermes", "ground-truth-private", ".env", "bluetooth-capture")
bad=[line.strip() for line in sys.stdin if any(item.lower() in line.lower() for item in blocked)]
if bad:
    print("private path names in APK", file=sys.stderr)
    raise SystemExit(1)'

ZIPALIGN=$(find "${ANDROID_SDK_ROOT:-${ANDROID_HOME:-}}/build-tools" -name zipalign -print | sort -V | tail -n 1)
if [[ -z "$ZIPALIGN" ]]; then
  printf 'zipalign not found\n' >&2
  exit 1
fi
"$ZIPALIGN" -c -P 16 -v 4 "$APK" >> "$REPORT"

READELF=$(find "${ANDROID_NDK_HOME:-${ANDROID_SDK_ROOT:-${ANDROID_HOME:-}}/ndk}" -name llvm-readelf -print | sort -V | tail -n 1)
if [[ -z "$READELF" ]]; then
  printf 'llvm-readelf not found\n' >&2
  exit 1
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
unzip -qq "$APK" 'lib/*.so' -d "$tmp"
node_waived=0
while IFS= read -r so; do
  "$READELF" -lW "$so" >> "$REPORT"
  if ! "$READELF" -lW "$so" | python3 -c 'import re,sys
loads=[]
for line in sys.stdin:
    if re.match(r"\s*LOAD\s", line):
        loads.append(int(line.split()[-1], 16))
raise SystemExit(0 if loads and min(loads) >= 0x4000 else 1)'; then
    if [[ $(basename "$so") == libnode.so ]]; then
      node_waived=1
      printf 'WAIVED (feature disabled): %s has sub-16-KiB LOAD alignment\n' "$so" >> "$REPORT"
    else
      printf 'native library is not 16 KiB aligned: %s\n' "$so" >&2
      exit 1
    fi
  fi
done < <(find "$tmp/lib" -type f -name '*.so' -print | sort)

if [[ $node_waived -eq 1 ]]; then
  node --test tests/security-release.test.mjs >/dev/null
  printf 'Embedded Node exception accepted only because WhatsApp startup and pairing UI are release-disabled.\n' >> "$REPORT"
fi

printf 'verified_apk=%s\nsha256=' "$APK"
sha256sum "$APK" | cut -d' ' -f1
