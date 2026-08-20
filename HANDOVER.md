# Hermes G2 handover (2026-08-20)

A snapshot of project state, what was accomplished, what is pending, and how to
pick the work back up on a new machine. Pairs with the in-repo `ROADMAP.md` and
the private `DECODE-SPEC.md` (see "Out-of-repo data").

## 0. Latest continuation (2026-08-20)

### Direct-R1 worker isolation candidate (2026-08-21)

- Local branch `work/t_c1971fa9-ring-worker` now has candidate commits
  `0accf5f` and `0475383` (not pushed; no PR). Every optional direct-R1 connect,
  discovery/MTU/subscription wait, battery read, health poll, packetAck drain,
  and ring write runs on the single `FaceclawRingLink` worker. The glasses
  `FaceclawBleCommunicator` loop and initial glasses connect path perform no
  direct-ring work.
- Direct-ring lifecycle, timers, generation, battery, and bounded packetAck
  state are protected by a distinct `ringLock`. Shutdown interrupts both Java
  workers before bounded joins and crosses the final ring-write barrier before
  resetting state or closing BLE. Delayed writes and probe gaps revalidate the
  captured ring generation and stop on cancellation.
- `FaceclawBleManager` now serializes complete operations per address while a
  short static Bluetooth API lock protects only immediate Android GATT API
  initiation. Different-address callback waits no longer block glasses writes,
  and callbacks from an obsolete GATT are ignored.
- Verification on the frozen `0475383` checkout: focused ring contracts 17/17,
  full suite 148/148, `npm run typecheck` PASS, and JDK 21 / Android SDK 35 debug
  build PASS. APK: `platforms/android/app/build/outputs/apk/debug/app-debug.apk`.
  The two initial clean-worktree typecheck/build attempts lacked the ignored
  `node_modules` link and reproduced 35 missing NativeScript ambient-type errors;
  after linking the existing dependency tree into the isolated verification
  worktree, the exact commands passed.
- A32 USB (`SM_A326B`) install and launch passed. Runtime process evidence showed
  `FaceclawBleCommunicator` and `FaceclawRingLink` as separate threads. In the
  connected-R1 run, the ring worker used TID 2486 while glasses display writes
  used TID 2485; a glasses frame completed during the ring connect window. The
  R1 reached ready with MTU 247, returned CRC-valid read-only firmware, health,
  and device-status responses, the full poll completed, the phone UI reported
  `Connected.`, and later 15-second current-HR refresh ran on the ring worker.
  The optional SIG battery characteristic remained absent, preserving the safe
  fallback. Frame timings were pulled to `/tmp/t_535a9f1f-frame-timings.txt` and
  no MAC-bearing/raw health log is tracked.
- A reversible ring timeout could not be safely induced without physical handling
  during this headless run. No pairing/ownership, permission, MAC, firmware/DFU,
  reset, power, or destructive operation was attempted; Even Bluetooth remained
  revoked. Connected-path thread/interleaving evidence is therefore the available
  hardware proof, and timeout/retry hardware proof remains an explicit limitation.
- Review state: implementation is ready for mandatory `g2-reviewer` review.
  Only a reviewer-created delivery card may authorize push/PR. Remaining latency
  siblings are the non-blocking wake barrier and shorter `waitForFrameFinished`.

Seven self-contained items were completed on the `hermes-g2` branch/current
working tree:

- **Raw ring-frame security gate:** `sendRawRingFrame()` now fails closed before
  writing to `bae80012`. It accepts only a complete canonical single-frame
  envelope with a valid declared length and transport CRC, then applies the same
  pairing/host/firmware sub-command blocklist as `buildRingFrame()`. Captured
  `otaStart`, `advStart`, `setAlgoKey`, `nvRecover`, `powerControl`, and
  `pairDelete` frames can no longer bypass the policy gate. Regression coverage
  is in `tests/ring-frame.test.mjs`.
- **Honest setup README / T4:** `README.md` now matches the in-app onboarding:
  provision the G2 and R1 in Even first, explicitly disconnect the glasses,
  release Even's Bluetooth access during Hermes use, and keep Even installed for
  provisioning and official maintenance. This closes the remaining T4 release
  gate.
- **Read-only R1 firmware version:** Hermes now sends `system/deviceInfo(0x02)`
  after session open, decodes the first NUL-padded 16-byte ASCII field from the
  CRC-valid ack, and displays it in phone Glasses Controls. Verified live on the
  A32 with the connected R1 as `2.2.8.0002`. No firmware-write behavior exists.
- **Ring-native activity:** `cmd=5` is confirmed against the capture, firmware
  struct accesses, and matching Even CSV rows. Hermes decodes 10-minute steps,
  active kcal, total kcal, and derived resting kcal; merges and persists buckets
  by local day; uses native active kcal as primary with Keytel as fallback; and
  drains captured `packetAck` cursors through a bounded worker-thread queue.
  Activity ingestion requires the exact daily push envelope, incoming MODBUS
  inner CRC, and current local day. Persisted buckets are canonicalized, and
  packet cursors are generation-bound across reconnects. Explicit test coverage
  proves both stale (previous day) and future day bases are rejected, closing
  the regression-coverage gap from commit `6b812fd`.
- **R1 MTU contract:** direct-ring connect already requested MTU 247 after
  service discovery and before notification subscription/health probing. The
  result is now logged as `ok` or `fallback`, and a source-contract regression
  test pins the constant and ordering without making MTU failure fatal.
- **Fast current HR refresh:** the communicator worker now sends only the
  heart-rate daily/current-hour GET every 15 seconds, matching the observed Even
  cadence. Full HR/SpO2/HRV/activity/sleep/battery polling remains at 60 seconds,
  and a full poll resets the fast timer so it never immediately duplicates HR.
- **Ring-contention recovery UX:** direct R1 connection failures now surface the
  same Even-app warning as glasses write failures. Main, Controls, and Health all
  offer Open Even settings + Retry R1; opening settings starts a bounded release
  poll that clears the warning and retries R1 once Even releases Bluetooth.
- **MCP / skill publish audit:** the phone exposes 24 assistant tools, but public
  MCP/skill publication is NO-GO. The bridge lacks authenticated peer/transport,
  pre-auth and stale-socket rejection, turn-generation authorization, enforced
  schemas, correct lifecycle/errors, safe multi-window ownership, and cancellable/
  idempotent side effects. A bounded shell-owned `glasses.render_view` v1 is
  designed but blocked on that hardening. See
  `notes/mcp-skill-publish-audit-2026-08-20.md`.
- **Bridge/MCP hardening pass 1:** privileged frames now require current-generation
  authentication; stale socket callbacks are ignored; schemas are enforced;
  app-tool ownership is window-safe; availability failures fail closed; MCP
  initialization/errors and side-effecting notification rejection are covered;
  proactive quota follows preflight. MCP lifecycle/replies are connection-bound;
  duplicate IDs and late replies are suppressed; unsupported schemas fail closed;
  array bounds/schema-valued extra properties are enforced; owner fallback,
  top-level protocol-version/socket closure, and auth timeout are covered. Full
  suite: 144 tests.

Verification on the combined continuation checkout: all 133 tests passed,
TypeScript typechecking passed, and a debug Android build completed with Android
SDK 35 and JDK 21 at `platforms/android/app/build/outputs/apk/debug/app-debug.apk`.
Debug APK builds are not reproducible, so no build-instance hash is treated as a
canonical release identity.
JDK 26 is present but fails this Gradle stack's `jlink` step; use
`JAVA_HOME=/usr/lib/jvm/java-21-openjdk` and `ANDROID_HOME=/home/benny/Android/Sdk`.

**Freeze status:** activity ingestion and packetAck lifecycle hardening passed
independent static review, merged with the contention UX, passed 133 tests,
typecheck, and a combined Android build, and was installed on the A32.

**Next recommended item:** continue the external assistant bridge/MCP hardening:
add authenticated secure transport/server proof, then bind MCP calls to unique
live turn generations and add cancellation/idempotency for timed-out mutations.
`glasses.render_view` and its skill stay blocked until those global gates close. After Benny provides a worn
overnight capture, correlate `cmd=6` against the matching export.

## 1. What this project is

Hermes G2 is an unofficial Android interface for the Even Realities G2 glasses
(NativeScript UI + Java BLE), plus a decoder for the Even R1 ring's health data.
It talks directly to the ring over BLE and renders a glasses UI, health cards, a
HUD, voice, notifications, navigation, and more.

## 2. Where things live (READ THIS BEFORE MOVING MACHINES)

The git repo is `hermes-faceclaw` (pushed to the private `not-benny/hermes-g2`).
Two important things live OUTSIDE the repo and do NOT travel via git clone:

- `../ground-truth-private/` — Even health-export CSVs, btsnoop captures, the R1
  ring firmware (zip + extracted `application.bin`), the RE harness `fwre.py`, and
  the full `DECODE-SPEC.md`. Personal health data + proprietary firmware. Copy by
  hand when moving machines.
- `secrets.local.md` — dev identifiers (device IP, BLE MACs, git identity, Even
  API token location). Gitignored; recreate on the new machine.

`ROADMAP.md` is tracked in the repository and is the canonical planning source
that travels with a clone. Treat any older out-of-repo copy as archival unless
it has explicitly newer changes.

In-repo, the ring-health work is:
- `app/health/ring-parser.ts` — frame reassembly, CRC-32C transport, inner-frame
  unwrap, `decodeDailyData` (HR/SpO2/HRV/activity), `decodeRingBattery`.
- `app/health/ring-health-store.ts` — decodes pushes, merges current-day activity
  slots, and rejects malformed/unanchored/non-push activity frames.
- `app/health/health-hourly.ts`, `health-insights.ts`, `health-history.ts`,
  `calories.ts` — hourly persistence, readiness/HR insights, Keytel calorie fallback.
- `app/apps/health/health-app.ts` — the glasses Health side card + HUD heart feed.
- `App_Resources/.../FaceclawBleCommunicator.java` — ring connection, `probeRingHealth`,
  `sendRingCommand`, `buildRingFrame` (CRC-32 correct; do not regress to random bytes).
- `notes/ring-wire-format-2026-08-20.md` — the confirmed BLE wire format (public-safe).
- `notes/ring-groundtruth-2026-08-20.md` — the ground-truth harness + CSV schemas.
- `tests/ring-parser.test.mjs`, `ring-health-store.test.mjs` — decoder regression tests.

## 3. What the ring-health/RE effort accomplished (this session)

- Ring health data DECODED and confirmed by reverse-engineering the ring firmware:
  frame envelope byte-verified (CRC-32C Castagnoli over the transport, inner
  CRC-16/MODBUS), command table confirmed (health module=2; HR=1/SpO2=2/temp=3/
  HRV=4/activity=5/sleep=6), HR/SpO2 = `[hour][avg][max][min]` u8, HRV = u16.
- Live HR resolved: the daily-frame header `current` field (offset 11) is the live
  current-hour reading, routed to `store.currentHr` and the HUD. Finest resolution
  is hourly; there is no per-beat stream. The old "no live HR" was a mix of an
  already-fixed CRC-32 write bug, Even-app ring contention, and a HUD wiring
  regression (all resolved).
- Ground truth captured: the Even app's own 7-CSV health export + a btsnoop of the
  Even<->ring traffic, now the validation harness for every decoder.
- R1 ring firmware extracted (Nordic DFU, nRF52840) and reverse-engineered with a
  capstone harness (`fwre.py`) using format-string anchoring. Full byte-level
  `DECODE-SPEC.md` written (private).
- Activity/steps/calories decoder CONFIRMED and enabled: cmd=5 header carries
  timezone + local-midnight epoch, records are 10-minute slot/steps/active-kcal/
  total-kcal tuples, and resting kcal is derived as total-active. The captured
  slot reproduces the matching Even CSV row exactly; buckets merge and persist.

## 4. What is pending (see ROADMAP.md for the full list)

- `cmd=6` sleep decode is deliberately deferred until Benny wears the ring
  overnight. Schema + stage map known (0=Wake/1=REM/2=Light/3=Deep, 30s
  epochs, total/wake/rem/light/deep seconds, body_temp_delta). Needs a real overnight
  capture correlated to a live DB session. `decodeSleep` stays a throwing stub.
- Request-layer MTU 247, `packetAck`, and the 15-second HR-only current refresh
  are implemented.
- Even firmware auto-track cron: the check_firmware API accepts the account JWT
  (`x-token`) but returns 403 without the app's device-identifying params; finishing
  it needs a one-time TLS intercept (mitmproxy/frida) of the app's real request.

## 5. Resuming the firmware RE on a new machine

1. Copy `../ground-truth-private/` over (it holds the firmware + `fwre.py`).
2. `pip install capstone` (that is the only RE dependency; no Ghidra needed).
3. `cd ground-truth-private/firmware/re && python3 -c "import fwre; print(fwre.find_str('sleep'))"`.
   Technique: firmware log/format strings are referenced from the code that builds
   the matching record; `fwre.xrefs_to_str` -> `fwre.show(func)` reveals struct
   offsets (ldr/str Rx,[Ry,#off]). See `DECODE-SPEC.md` for the confirmed layouts.

## 6. Capturing fresh ground truth (needs the device + Even app)

Full method is in `notes/ring-groundtruth-2026-08-20.md`. Summary: enable full
btsnoop (Samsung path `/data/log/bt/btsnoop_hci.log`), briefly re-enable the Even
app (then re-disable + re-revoke BT per the standing rule), reproduce the metric,
pull the log + the Even app's built-in health-data export zip, and validate.

## 7. Conventions

- The repo is private now; commits use the trailers (Co-Authored-By + Claude-Session)
  and the `not-benny` identity. A fresh PUBLIC repo will be curated later, at which
  point the public scrubbing rules (no personal data, no MACs, no tokens) reapply.
- Even app: disable-don't-uninstall (it owns pairing/firmware/ground-truth). Keep its
  Bluetooth revoked; re-enable on demand only, then re-revoke.
- Never commit `ground-truth-private/`, the Even API JWT, or raw health captures.
