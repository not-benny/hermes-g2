#!/bin/bash
# Pull Hermes G2 shared preferences off the attached device.
# Usage: pull_config.sh [output-file]   (default: hermes_g2_settings.xml)
set -euo pipefail

PACKAGE=com.faceclaw.app
PREFS=shared_prefs/faceclaw_settings.xml
OUT="${1:-hermes_g2_settings.xml}"

adb exec-out run-as "$PACKAGE" cat "$PREFS" > "$OUT"
echo "Pulled $PREFS to $OUT"
