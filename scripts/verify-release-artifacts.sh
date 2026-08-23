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

signing_mode=${HERMES_SIGNING_MODE:-protected}
artifact_variant=${HERMES_ARTIFACT_VARIANT:-release}
LEGACY_DEVELOPMENT_CERT_SHA256=f64ccdb8d462b42c6d143cb1323350b052acebc0a5023e14d05fea86ef7766d4
actual_cert=
actual_subject=
case "$signing_mode" in
  protected|untrusted)
    if ! "$APKSIGNER" verify --verbose "$APK" >/dev/null; then
      printf 'signed APK verification failed\n' >&2
      exit 1
    fi
    cert_report=$($APKSIGNER verify --verbose --print-certs "$APK")
    if ! parsed_cert=$(python3 scripts/parse-apksigner-cert-report.py <<< "$cert_report"); then
      printf 'APK must contain exactly one signing identity\n' >&2
      exit 1
    fi
    mapfile -t cert_fields <<< "$parsed_cert"
    if [[ ${#cert_fields[@]} -ne 2 ]]; then
      printf 'APK must contain exactly one signing identity\n' >&2
      exit 1
    fi
    actual_cert=${cert_fields[0]}
    actual_subject=${cert_fields[1]}
    ;;
  unsigned)
    python3 - "$APK" <<'PY'
import struct, sys, zipfile
path = sys.argv[1]
with zipfile.ZipFile(path) as archive:
    entries = archive.infolist()
    for name in archive.namelist():
        upper = name.upper()
        if upper.startswith("META-INF/") and (
            upper == "META-INF/MANIFEST.MF" or upper.endswith((".SF", ".RSA", ".DSA", ".EC"))
        ):
            raise SystemExit("unsigned verification APK contains a v1 signature entry")
with open(path, "rb") as source:
    source.seek(0, 2)
    size = source.tell()
    start = max(0, size - 65557)
    source.seek(start)
    tail = source.read()
    index = tail.rfind(b"PK\x05\x06")
    if index < 0 or index + 20 > len(tail):
        raise SystemExit("APK end-of-central-directory record is missing")
    central_offset = struct.unpack_from("<I", tail, index + 16)[0]
    if not entries:
        raise SystemExit("unsigned verification APK is empty")
    last = max(entries, key=lambda entry: entry.header_offset)
    source.seek(last.header_offset)
    header = source.read(30)
    if len(header) != 30 or header[:4] != b"PK\x03\x04":
        raise SystemExit("unsigned verification APK has an invalid local header")
    name_length, extra_length = struct.unpack_from("<HH", header, 26)
    data_end = last.header_offset + 30 + name_length + extra_length + last.compress_size
    if last.flag_bits & 0x08:
        source.seek(data_end)
        descriptor_signature = source.read(4)
        zip64 = last.compress_size > 0xFFFFFFFF or last.file_size > 0xFFFFFFFF
        data_end += (24 if zip64 else 16) if descriptor_signature == b"PK\x07\x08" else (20 if zip64 else 12)
    if data_end != central_offset:
        raise SystemExit("unsigned verification APK has pre-central-directory signing material")
PY
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
    expected_cert=${HERMES_PROTECTED_CERT_SHA256:-}
    if [[ ! "$expected_cert" =~ ^[[:xdigit:]]{64}$ ]]; then
      printf 'protected certificate fingerprint is not configured\n' >&2
      exit 1
    fi
    expected_cert=${expected_cert,,}
    if [[ -z "$actual_subject" ]]; then
      printf 'APK signing certificate subject is unavailable\n' >&2
      exit 1
    fi
    if [[ "${actual_subject,,}" == *"cn=android debug"* ]]; then
      printf 'development signing identity cannot protect a production release\n' >&2
      exit 1
    fi
    if [[ "$actual_cert" != "$expected_cert" ]]; then
      printf 'unexpected APK signing certificate\n' >&2
      exit 1
    fi
    ;;
  untrusted)
    protected_cert=${HERMES_PROTECTED_CERT_SHA256:-}
    if [[ "$actual_cert" == "$LEGACY_DEVELOPMENT_CERT_SHA256" &&
          "${HERMES_ALLOW_LEGACY_DEVELOPMENT_CERT:-false}" != "true" ]]; then
      printf 'untrusted validation must not use the owner development certificate\n' >&2
      exit 1
    fi
    if [[ -n "$protected_cert" && "$actual_cert" == "${protected_cert,,}" ]]; then
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
blocked_dex = (b"FaceclawDebugControlReceiver", b"com.faceclaw.app.DEBUG_CONTROL_V1")
blocked_js = (b"HERMES_DEBUG_CONTROL_RUNTIME_V1", b"voice.fixture", b"capture-offline", b"DebugControlHarness")
with zipfile.ZipFile(sys.argv[1]) as archive:
    for name in archive.namelist():
        if name.startswith("classes") and name.endswith(".dex"):
            data = archive.read(name)
            for marker in blocked_dex:
                if marker in data:
                    print("release APK contains debug-only code surface", file=sys.stderr)
                    raise SystemExit(1)
        if name.startswith("assets/app/") and name.endswith(".mjs"):
            data = archive.read(name)
            for marker in blocked_js:
                if marker in data:
                    print("release APK contains debug-control JavaScript", file=sys.stderr)
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
