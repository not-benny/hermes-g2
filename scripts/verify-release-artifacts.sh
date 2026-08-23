#!/usr/bin/env bash
set -euo pipefail

if [[ $# -gt 0 ]]; then
  APK=$1
else
  mapfile -t apks < <(find platforms/android/app/build/outputs/apk -type f -name '*.apk' -print | sort)
  if [[ ${#apks[@]} -ne 1 ]]; then printf 'expected exactly one APK, found %s\n' "${#apks[@]}" >&2; exit 1; fi
  APK=${apks[0]}
fi
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
names=[line.strip() for line in sys.stdin]
bad=[line for line in names if any(item.lower() in line.lower() for item in blocked)]
if bad:
    print("private path names in APK", file=sys.stderr)
    raise SystemExit(1)
required={"lib/arm64-v8a/libNativeScript.so","lib/arm64-v8a/libfaceclaw_lc3.so","lib/arm64-v8a/libfaceclaw_llama.so","lib/arm64-v8a/libonnxruntime.so","lib/arm64-v8a/libsherpa-onnx-jni.so"}
actual={name for name in names if name.startswith("lib/") and name.endswith(".so")}
if actual != required or "assets/whatsapp-node.zip" in names:
    print("unexpected native or WhatsApp artifact inventory", file=sys.stderr)
    raise SystemExit(1)'

SDK_ROOT=${ANDROID_SDK_ROOT:-${ANDROID_HOME:-}}
BUILD_TOOLS="$SDK_ROOT/build-tools/35.0.1"
ZIPALIGN="$BUILD_TOOLS/zipalign"
AAPT="$BUILD_TOOLS/aapt"
APKSIGNER="$BUILD_TOOLS/apksigner"
for tool in "$ZIPALIGN" "$AAPT" "$APKSIGNER"; do
  if [[ ! -x "$tool" ]]; then printf 'required Android build tool not found: %s\n' "$tool" >&2; exit 1; fi
done

EXPECTED_CERT_SHA256=f64ccdb8d462b42c6d143cb1323350b052acebc0a5023e14d05fea86ef7766d4
signing_mode=${HERMES_SIGNING_MODE:-protected}
artifact_variant=${HERMES_ARTIFACT_VARIANT:-release}
actual_cert=
case "$signing_mode" in
  protected|untrusted)
    if ! "$APKSIGNER" verify --verbose "$APK" >/dev/null; then
      printf 'signed APK verification failed\n' >&2
      exit 1
    fi
    actual_cert=$($APKSIGNER verify --print-certs "$APK" | python3 -c 'import sys
for line in sys.stdin:
    if "certificate SHA-256 digest:" in line:
        print(line.rsplit(":",1)[1].strip()); break')
    ;;
  unsigned)
    if "$APKSIGNER" verify --verbose "$APK" >/dev/null 2>&1; then
      printf 'unsigned verification APK must not carry a signing certificate\n' >&2
      exit 1
    fi
    ;;
  *)
    printf 'unknown signing verification mode\n' >&2
    exit 1
    ;;
esac
case "$signing_mode" in
  protected)
    if [[ "$actual_cert" != "$EXPECTED_CERT_SHA256" ]]; then
      printf 'unexpected APK signing certificate\n' >&2
      exit 1
    fi
    ;;
  untrusted)
    if [[ "$actual_cert" == "$EXPECTED_CERT_SHA256" ]]; then
      printf 'untrusted validation APK must not use the protected signing certificate\n' >&2
      exit 1
    fi
    ;;
esac
badging=$($AAPT dump badging "$APK")
if [[ "$badging" != *"package: name='com.faceclaw.app' versionCode='1000002' versionName='1.0.0-preview.2'"* ]]; then
  printf 'unexpected APK package identity or version\n' >&2
  exit 1
fi
case "$artifact_variant" in
  debug) ;;
  release)
    manifest=$($AAPT dump xmltree "$APK" AndroidManifest.xml)
    for marker in FaceclawDebugControlReceiver com.faceclaw.app.DEBUG_CONTROL_V1 android.permission.DUMP; do
      if [[ "$manifest" == *"$marker"* ]]; then
        printf 'release APK exposes debug-only manifest surface: %s\n' "$marker" >&2
        exit 1
      fi
    done
    if [[ "$badging" == *"application-debuggable"* ]] ||
       [[ "$manifest" =~ android:debuggable.*0xffffffff ]]; then
      printf 'release APK is debuggable\n' >&2
      exit 1
    fi
    python3 - "$APK" <<'PY'
import sys, zipfile
blocked = (b"FaceclawDebugControlReceiver", b"com.faceclaw.app.DEBUG_CONTROL_V1")
with zipfile.ZipFile(sys.argv[1]) as archive:
    for name in archive.namelist():
        if name.startswith("classes") and name.endswith(".dex"):
            data = archive.read(name)
            for marker in blocked:
                if marker in data:
                    print("release APK contains debug-only code surface", file=sys.stderr)
                    raise SystemExit(1)
PY
    ;;
  *)
    printf 'unknown APK artifact variant\n' >&2
    exit 1
    ;;
esac

"$ZIPALIGN" -c -P 16 -v 4 "$APK" >> "$REPORT"

READELF="${ANDROID_NDK_HOME:-$SDK_ROOT/ndk/27.2.12479018}/toolchains/llvm/prebuilt/linux-x86_64/bin/llvm-readelf"
if [[ ! -x "$READELF" ]]; then
  printf 'llvm-readelf not found\n' >&2
  exit 1
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
unzip -qq "$APK" -d "$tmp"
python3 -c 'import os,sys
blocked=(os.getcwd().encode(),)
for root,_,files in os.walk(sys.argv[1]):
    for name in files:
        path=os.path.join(root,name)
        with open(path,"rb") as source:
            data=source.read()
        if any(marker in data for marker in blocked):
            print("private content in APK", file=sys.stderr)
            raise SystemExit(1)' "$tmp"

while IFS= read -r so; do
  "$READELF" -lW "$so" >> "$REPORT"
  if ! "$READELF" -lW "$so" | python3 -c 'import re,sys
loads=[]
for line in sys.stdin:
    if re.match(r"\s*LOAD\s", line):
        loads.append(int(line.split()[-1], 16))
raise SystemExit(0 if loads and min(loads) >= 0x4000 else 1)'; then
    printf 'native library is not 16 KiB aligned: %s\n' "$so" >&2
    exit 1
  fi
done < <(find "$tmp/lib" -type f -name '*.so' -print | sort)

printf 'verified_apk=%s\nsigning_mode=%s\nartifact_variant=%s\nsha256=' "$APK" "$signing_mode" "$artifact_variant"
sha256sum "$APK" | cut -d' ' -f1
