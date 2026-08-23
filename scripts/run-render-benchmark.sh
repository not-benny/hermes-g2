#!/usr/bin/env bash
set -euo pipefail

# Non-destructive, fixed-duration A32 renderer observation. "warm" requires an
# already-connected/warmed G2 session; "idle" records the foreground phone UI
# without generating display input. The script never pairs, reconnects, clears
# app data, changes Bluetooth state, or sends a device command.
SERIAL="${SERIAL:-$(adb devices -l | awk '/ usb:/{print $1; exit}')}"
PKG="${PKG:-com.faceclaw.app}"
ACTIVITY="${ACTIVITY:-com.tns.NativeScriptActivity}"
DURATION_SECONDS=60
SCENARIO="${1:-idle}"
OUTPUT_DIR="${2:-/tmp/hermes-g2-render-${SCENARIO}-$(date +%Y%m%dT%H%M%S)}"

if [[ "$SCENARIO" != "warm" && "$SCENARIO" != "idle" ]]; then
  printf 'usage: %s warm|idle [output-directory]\n' "$0" >&2
  exit 2
fi

mkdir -p "$OUTPUT_DIR"
if [[ -z "$SERIAL" ]]; then
  printf 'No USB Android device found; set SERIAL explicitly to use an existing transport.\n' >&2
  exit 1
fi
adb -s "$SERIAL" get-state >/dev/null
MODEL="$(adb -s "$SERIAL" shell getprop ro.product.model | tr -d '\r')"
PID="$(adb -s "$SERIAL" shell pidof "$PKG" | tr -d '\r')"
if [[ -z "$PID" ]]; then
  printf 'The app must already be running; refusing to restart or clear its state.\n' >&2
  exit 1
fi

adb -s "$SERIAL" shell am start -n "$PKG/$ACTIVITY" >/dev/null
adb -s "$SERIAL" shell dumpsys gfxinfo "$PKG" reset >/dev/null
adb -s "$SERIAL" shell dumpsys meminfo "$PKG" >"$OUTPUT_DIR/meminfo-before.txt"
START_EPOCH="$(date +%s)"

: >"$OUTPUT_DIR/pss-samples.txt"
for ((sample = 0; sample <= DURATION_SECONDS / 5; sample++)); do
  adb -s "$SERIAL" shell dumpsys meminfo "$PKG" \
    | tr -d '\r' \
    | grep -E 'TOTAL PSS:|TOTAL RSS:|Java Heap:|Native Heap:' \
    >>"$OUTPUT_DIR/pss-samples.txt" || true
  if (( sample < DURATION_SECONDS / 5 )); then
    sleep 5
  fi
done

adb -s "$SERIAL" shell dumpsys gfxinfo "$PKG" framestats >"$OUTPUT_DIR/gfxinfo-framestats.txt"
adb -s "$SERIAL" shell dumpsys meminfo "$PKG" >"$OUTPUT_DIR/meminfo-after.txt"
adb -s "$SERIAL" shell logcat -d -T "$START_EPOCH.000" --pid "$PID" \
  | tr -d '\r' \
  | grep -E 'FrameTimings|[[:space:]]art[[:space:]].*(GC|Alloc)' \
  >"$OUTPUT_DIR/runtime-hotpath.txt" || true
adb -s "$SERIAL" pull "/sdcard/Android/data/$PKG/files/frame-timings.txt" \
  "$OUTPUT_DIR/frame-timings.txt" >/dev/null || true

python3 - "$SCENARIO" "$MODEL" "$DURATION_SECONDS" "$OUTPUT_DIR" <<'PY'
import csv
import json
import math
import re
import sys
from pathlib import Path

scenario, model, duration, output = sys.argv[1:]
root = Path(output)
text = (root / "gfxinfo-framestats.txt").read_text(errors="replace")
rows = []
in_data = False
header = None
for line in text.splitlines():
    if line.strip() == "---PROFILEDATA---":
        in_data = not in_data
        header = None
        continue
    if not in_data or not line.strip():
        continue
    if line.startswith("Flags,"):
        header = next(csv.reader([line]))
        continue
    if header is None or not line[0].isdigit():
        continue
    values = next(csv.reader([line]))
    if len(values) != len(header):
        continue
    row = dict(zip(header, values))
    try:
        if int(row["Flags"]) == 0:
            rows.append((int(row["FrameCompleted"]) - int(row["IntendedVsync"])) / 1_000_000)
    except (KeyError, ValueError):
        pass

rows.sort()
def percentile(values, value):
    if not values:
        return None
    return round(values[max(0, math.ceil(len(values) * value / 100) - 1)], 3)

def pss(path):
    body = path.read_text(errors="replace")
    match = re.search(r"TOTAL PSS:\s*([0-9,]+)", body)
    return int(match.group(1).replace(",", "")) if match else None

frame_text = (root / "frame-timings.txt").read_text(errors="replace") if (root / "frame-timings.txt").exists() else ""
summary = next((line for line in frame_text.splitlines() if line.startswith("frames started=")), "")
acks = len(re.findall(r"outcome sent", frame_text))
runtime = (root / "runtime-hotpath.txt").read_text(errors="replace")
report = {
    "schema_version": 1,
    "scenario": scenario,
    "duration_seconds": int(duration),
    "device": {"transport": "usb", "model": model},
    "phone_frames": {
        "count": len(rows),
        "janky": sum(value > 16.666667 for value in rows),
        "jank_percent": round(100 * sum(value > 16.666667 for value in rows) / len(rows), 3) if rows else None,
        "p90_ms": percentile(rows, 90),
        "p99_ms": percentile(rows, 99),
        "max_ms": round(rows[-1], 3) if rows else None,
    },
    "memory": {
        "pss_start_kb": pss(root / "meminfo-before.txt"),
        "pss_end_kb": pss(root / "meminfo-after.txt"),
        "pss_sample_count": len(re.findall(r"TOTAL PSS:", (root / "pss-samples.txt").read_text(errors="replace"))),
    },
    "pipeline": {
        "frame_summary": summary,
        "exported_real_g2_final_ack_landmarks": acks,
        "gc_log_lines": len(re.findall(r"\bGC\b", runtime)),
        "stage_evidence": ["paint", "fingerprint", "to8bpp", "composite", "pack-4bpp", "compress-and-plan", "bluetooth-send", "application-ack"],
    },
}
(root / "report.json").write_text(json.dumps(report, indent=2) + "\n")
print(json.dumps(report, indent=2))
PY

printf 'Benchmark artifacts: %s\n' "$OUTPUT_DIR"
