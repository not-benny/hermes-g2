# Even API capture harness

This tool records protocol **shape**, never request or response values. It accepts only
`api.evenrealities.com/v2/g/check_firmware` and, for context,
`api.evenrealities.com/v2/g/list_devices`. Do not use mitmweb, save-stream files, HAR,
raw logcat, shell tracing, or request replay with this procedure.

This is capture/research only. It does not authorize firmware download, update, OTA,
DFU, pairing, reset, recovery, power, or unpair operations.

## Prerequisites and private baseline

Run from the repository root. Discover the single USB device instead of copying a serial
into files or terminal output. The checks below print only counts/booleans. Abort unless
all checks pass.

```bash
set -eu
PACKAGE=com.even.sg
OUT=scratchpad/even-api-capture/check-firmware.sanitized.json
STATE=scratchpad/even-api-capture/device-restore-state
mkdir -p "$(dirname "$OUT")"
chmod 700 "$(dirname "$OUT")"
USB_COUNT=$(adb devices -l | awk 'NR>1 && $2=="device" && $0 !~ /:/ {n++} END {print n+0}')
[ "$USB_COUNT" -eq 1 ] || { printf 'FAIL: expected one USB Android device\n' >&2; exit 1; }
ADB_SERIAL=$(adb devices | awk 'NR>1 && $2=="device" && $1 !~ /:/ {print $1}')
ADB="adb -s $ADB_SERIAL"
[ "$($ADB shell getprop ro.product.model | tr -d '\r')" = SM-A326B ]
printf 'USB target/model check: PASS\n'
```

Capture the exact pre-run package, proxy, and Bluetooth runtime-permission state in the
ignored owner-only file. Never print or commit this file.

```bash
umask 077
{
  printf 'enabled=%s\n' "$($ADB shell dumpsys package "$PACKAGE" | awk -F= '/^[[:space:]]*enabled=/{print $2; exit}' | tr -d '\r')"
  for KEY in http_proxy global_http_proxy_host global_http_proxy_port global_proxy_pac_url global_http_proxy_exclusion_list; do
    VALUE=$($ADB shell settings get global "$KEY" | tr -d '\r')
    printf 'proxy_%s=%q\n' "$KEY" "$VALUE"
  done
  for PERM in android.permission.BLUETOOTH_SCAN android.permission.BLUETOOTH_CONNECT android.permission.BLUETOOTH_ADVERTISE; do
    if $ADB shell dumpsys package "$PACKAGE" | grep -F "$PERM: granted=true" >/dev/null; then VALUE=granted; else VALUE=revoked; fi
    printf 'perm_%s=%s\n' "${PERM##*.}" "$VALUE"
  done
} >"$STATE"
chmod 600 "$STATE"
printf 'Private restore snapshot: PASS\n'
```

Confirm the app is installed, disabled-user, and stopped before continuing. Check the
presence of user CAs as a boolean only; do not list certificate subjects, fingerprints,
or contents.

```bash
$ADB shell pm path "$PACKAGE" >/dev/null
$ADB shell am force-stop "$PACKAGE"
USER_CA_COUNT=$($ADB shell 'find /data/misc/user/0/cacerts-added -type f 2>/dev/null | wc -l' | tr -d '\r ')
printf 'Official app installed/stopped: PASS; user-CA presence recorded: %s\n' "$([ "$USER_CA_COUNT" -gt 0 ] && printf yes || printf no)"
```

## Unconditional cleanup

Define cleanup before changing the device. The trap restores every captured proxy key
(including absent `null` settings), each Bluetooth grant, disabled-user state, and stops
all temporary tools. The capture operator must additionally remove any CA installed via
Android Settings. A temporary mount-namespace CA overlay must be unmounted; if that
cannot be proved, reboot and verify before declaring cleanup complete.

```bash
MITM_PID=
FRIDA_REMOTE=
CA_INSTALLED_BY_RUN=0
OVERLAY_ACTIVE=0
restore_setting() {
  KEY=$1 VALUE=$2
  if [ "$VALUE" = null ]; then $ADB shell settings delete global "$KEY" >/dev/null
  else $ADB shell settings put global "$KEY" "$VALUE" >/dev/null
  fi
}
cleanup() {
  set +e
  $ADB shell am force-stop "$PACKAGE" >/dev/null
  [ -z "$MITM_PID" ] || kill "$MITM_PID" 2>/dev/null
  [ -z "$FRIDA_REMOTE" ] || $ADB shell su -c "kill '$FRIDA_REMOTE'" >/dev/null 2>&1
  $ADB shell su -c 'rm -f /data/local/tmp/frida-server /data/local/tmp/even-mitm-ca.*' >/dev/null 2>&1
  [ "$OVERLAY_ACTIVE" -eq 0 ] || $ADB shell su -c 'umount /apex/com.android.conscrypt/cacerts' >/dev/null 2>&1
  . "$STATE"
  restore_setting http_proxy "$proxy_http_proxy"
  restore_setting global_http_proxy_host "$proxy_global_http_proxy_host"
  restore_setting global_http_proxy_port "$proxy_global_http_proxy_port"
  restore_setting global_proxy_pac_url "$proxy_global_proxy_pac_url"
  restore_setting global_http_proxy_exclusion_list "$proxy_global_http_proxy_exclusion_list"
  for PERM in BLUETOOTH_SCAN BLUETOOTH_CONNECT BLUETOOTH_ADVERTISE; do
    eval VALUE=\$perm_$PERM
    if [ "$VALUE" = granted ]; then $ADB shell pm grant "$PACKAGE" "android.permission.$PERM" >/dev/null 2>&1
    else $ADB shell pm revoke "$PACKAGE" "android.permission.$PERM" >/dev/null 2>&1
    fi
  done
  $ADB shell pm disable-user --user 0 "$PACKAGE" >/dev/null
  $ADB shell am force-stop "$PACKAGE" >/dev/null
  rm -f scratchpad/even-api-capture/mitmdump.pid
  if [ "$CA_INSTALLED_BY_RUN" -eq 1 ]; then
    printf 'ACTION REQUIRED: remove the run-installed user CA in Android Settings, then verify.\n' >&2
  fi
}
trap cleanup EXIT HUP INT TERM
```

## Start the quiet sanitizer

Determine a host address routable from the phone without saving or printing it. Choose an
unused local port and set the official app version explicitly. `mitmdump` must not save
flows and its console must remain quiet.

```bash
HOST_ADDR=$(ip route get 1.1.1.1 | awk '{for(i=1;i<=NF;i++) if($i=="src") {print $(i+1); exit}}')
PROXY_PORT=18080
export EVEN_CAPTURE_APP_VERSION=2.2.9
rm -f "$OUT"
mitmdump --listen-host 0.0.0.0 --listen-port "$PROXY_PORT" \
  --set flow_detail=0 --set console_eventlog_verbosity=error \
  --set termlog_verbosity=error -s tools/even-api-capture/mitm_addon.py \
  >/dev/null 2>&1 &
MITM_PID=$!
printf '%s\n' "$MITM_PID" >scratchpad/even-api-capture/mitmdump.pid
chmod 600 scratchpad/even-api-capture/mitmdump.pid
kill -0 "$MITM_PID"
$ADB shell settings put global http_proxy "$HOST_ADDR:$PROXY_PORT" >/dev/null
printf 'Quiet proxy configured: PASS\n'
```

## TLS trust ladder

Use only the least-invasive option that works, and clean it before escalating.

1. **Existing normal user CA:** if the host mitm CA is already installed by the owner,
   use it. Otherwise import the host CA through Android's credential-install UI, set
   `CA_INSTALLED_BY_RUN=1`, and remove it during cleanup. Do not print or copy certificate
   bytes into the repo.
2. **Temporary runtime unpinning:** if Flutter/target-SDK policy rejects user trust, use an
   isolated temporary Python virtual environment and an exactly version-matched arm64
   Frida server under `/data/local/tmp`. Spawn only `com.even.sg`; do not patch, re-sign,
   or reinstall its APK. Do not log hooks, arguments, return values, addresses, or TLS
   plaintext. Kill/remove Frida and delete the venv during cleanup.
3. **Temporary process-visible CA overlay:** only if the runtime option is unavailable.
   Use root for a RAM-backed, process-visible Conscrypt CA overlay; never modify boot or
   system partitions and never install a Magisk module. Set `OVERLAY_ACTIVE=1` before
   mounting. Unmount it during cleanup; if unmount verification fails, reboot before
   restoring/declaring success.

Before launching Even, verify interception using a disposable non-sensitive HTTPS client
request containing no account or device state. The addon will write nothing because the
host is outside its exact allowlist. Do not weaken TLS persistently if both temporary
fallbacks fail.

## Capture one official request

Keep Bluetooth denied for the first launch. Enable and launch only the dashboard; never
open or accept firmware/update/DFU UI.

```bash
$ADB shell pm enable --user 0 "$PACKAGE" >/dev/null
$ADB shell monkey -p "$PACKAGE" -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1
```

Wait only long enough for normal cached dashboard startup. Check success structurally,
without dumping the record:

```bash
python tools/even-api-capture/validate_capture.py "$OUT"
```

If no record appears, force-stop. Grant only Bluetooth permissions that the baseline says
were revoked and which Android reports as requested by this package, relaunch once, and
allow only a normal dashboard sync. If update/DFU UI appears, immediately back out or
force-stop. Do not pair, reset, recover, reboot, download firmware, start OTA/DFU, or send
ring/glasses commands.

As soon as validation passes, force-stop; the EXIT trap performs cleanup:

```bash
$ADB shell am force-stop "$PACKAGE"
exit
```

## Post-cleanup proof

In a fresh shell, rediscover the USB device and compare current state to the private
baseline without printing values. Verify all booleans: package is installed,
disabled-user, and stopped; all three Bluetooth grants match; all five proxy/PAC settings
match; temporary Frida/server/cert files and processes are absent; no CA overlay is
mounted; and any run-installed user CA is removed. Keep app data and pairing intact.
Delete the private baseline after comparison.

The only committable capture result is a manually written public-safe protocol note.
Never commit or attach the sanitized record itself when it reflects a real account/device.