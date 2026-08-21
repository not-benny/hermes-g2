# Hermes G2 handover (2026-08-20)

## Generation-safe app-tool teardown (2026-08-21)

The focused successor candidate makes app-tool registration leases opaque and
generation-specific. Stale or repeated teardown cannot remove a same-windowId
replacement; replacing an open worker window releases its still-current lease
before installing the new lifecycle state, including when the replacement closes
before declaring tools. Focused registry/in-process tests pass on this frozen
stack. `npm run typecheck` and configured `npm run build` currently fail on the
repository's 35 inherited NativeScript Android/AndroidX/Java and `Array.create`
diagnostics; no changed-file diagnostic was reported and no APK was produced or
installed. No hardware verification was needed for this registry lifecycle
change.

## BLE callback identity gate (2026-08-21)

Delivered branch: `wt/t_5e85b756`; implementation commit is
`993139f859964fec3aa4a408a5c9abb94a0bb501`; the GPT-5.6 Sol medium-effort
approved review HEAD and GitHub PR head are
`4258fc1649016eb0c5f04d1d6241b7c325f7cdb1`. PR #6 is open against
`hermes-g2`: https://github.com/not-benny/hermes-g2/pull/6. The delivered
commit is pushed without force. This handover update is intentionally local
until the changed commit receives a fresh review; no hardware reconnect
interleaving was exercised and operational verification remains NO-GO.

FaceclawBleManager now carries the source BluetoothGatt through both
characteristic-change callback overloads and rejects callbacks whose object is
not the current address entry. Connection callbacks use the same identity gate:
stale CONNECTED callbacks cannot publish or release latches, while stale
DISCONNECTED callbacks only close their own GATT. Same-address callers share the
owning exact-GATT attempt; explicit disconnect and owner timeout fail and release
pending waiters without retiring a replacement attempt. A per-address reentrant
callback boundary serializes identity retirement/replacement with listener side
effects without holding the process-wide Bluetooth API lock through listeners;
the retiring current GATT remains valid through its DISCONNECTED delivery.
Communicator state retirement now completes before synchronous manager teardown,
removing the communicator-monitor to BLE callback-boundary lock inversion without
leaving an unversioned delayed address-only teardown that could close a replacement.
Focused source-contract tests pass 6/6 and the full Node suite passes 163/163.
Direct javac of FaceclawBleManager, FaceclawBleListener, BleProtocol, and
CollectionUtils against Android-35 passes with deprecation warnings. Typecheck
and Android build remain blocked by the unchanged 35 NativeScript
Android/JavaScript namespace errors (`android`, `androidx`, `java`, and
`Array.create`); no hardware reconnect interleaving was attempted, so
operational verification remains NO-GO.

## WhatsApp pairing options evaluation (2026-08-21)

Added `notes/whatsapp-pairing-options-2026-08.md`. The safe recommendation is to
shelve live WhatsApp pairing and keep batches 3–6 paused while monitoring the
embedded link-code repair path; the existing Hermes Agent bridge is not a
WhatsApp bridge and cannot be reused as a QR shortcut. A host-side QR bridge is
technically feasible only as a new, separately authorized service with its own
session custody, authenticated encrypted transport, QR/status relay, and
validation gates. No production pairing, live-link batch, credential migration,
or bridge enablement was performed.

## WhatsApp link-code regression investigation (2026-08-21)

Added `notes/whatsapp-link-code-regression-2026-08.md` and reconciled the WhatsApp blocker in `ROADMAP.md`.
The embedded rc13 client deterministically emits `Chrome (Hermes G2)`, which matches upstream's documented
April `400 bad-request` failure for non-canonical pairing displays; rc13 also returns one code before the
later IQ error, so its retry loop cannot observe or repair that asynchronous rejection. Upstream PR #2559
is an actionable but unreleased fix. Issue #2488's original missing-success report was retracted after the
required 515 reconnect was added. Later #2737 confirms a `companion_reg_refresh` change after QR scans, but
its link-code attempt stops at the separate stage-1 400; its impact on canonicalized link-code pairing is
unknown. No live-link batches were started; batches 3–6 stay gated pending safe validation. No confirmed
upstream release/timeline restores the full pairing path yet, although the April failure has a viable patch
path.

## G2 protobuf transport primitives (2026-08-21)

Added descriptor-accurate, non-negative-validated G2Setting X distance/Y height encoders and package-internal ACK-tracked `MessageBuilder` wrappers. Added an internal-only DeviceSettings quick-restart encoder; it is not queued or exposed through the communicator/UI. Provenance and exact vectors are recorded in `notes/g2-proto-transport.md`, and `ROADMAP.md` now separates implemented transport from unresolved coordinate-range and reboot authorization gates.

Verification update: `node --test tests/g2-proto-transport.test.mjs` passes behavioral zero/multi-byte-varint/quick-restart vectors, both package-internal `MessageBuilder` wrappers (distinct kind/label, sid/flag, allocated magic in payload, and 3500 ms ACK timeout), all negative-input boundaries, and no-runtime-surface contracts. The date-sensitive activity fixtures now inject a matching current-day clock without weakening production validation; `npm run test` passes 157/157, `npm run typecheck` passes, `JAVA_HOME=/usr/lib/jvm/java-21-openjdk ANDROID_HOME=/home/benny/Android/Sdk npm run build` passes, and `git diff --check` passes. The debug APK installed/launched on USB Samsung A32 `RFCR707RQGV` (PID 11481). PID-filtered logcat shows repeated G2 connect failures for `E8:12:4B:04:AF:43` and no normal sid `0x09` settings ACK; the glasses were unavailable, so hardware protocol behavior remains unverified. No sid `0x80` message was sent and quick restart remains **NO-GO**.

## Latest hardening continuation (2026-08-21)

The display/MCP safety follow-up now adds exact-turn-generation revalidation at
the display handler boundary, cancellation propagation through system tools into
alert delivery, post-delivery turn checks, generation-bound compositor waits,
best-effort non-throwing ordinary shell renders, and identity-safe replace-only
shell alerts with owner-specific delivery receipts. Android backups are
disabled and cleartext bridge traffic is blocked by the manifest; the available
sibling bridge has no verified compatible WSS/server-proof path, so external
operation remains NO-GO. No credentials, personal data, hardware claims, or
publication authorization were added.

Verification for this continuation: focused MCP/registry/display tests pass
17/17, `npm run typecheck` passes, and `git diff --check` passes. The Android
debug build passes with JDK 21/SDK 35. The full `npm test` run is 154/156;
the two known date-sensitive activity failures remain at
`tests/ring-health-store.test.mjs:158` and `:190`. The debug APK installed and
launched on USB Samsung A32 `RFCR707RQGV`; package-filtered startup logs show
normal NativeScript startup plus standard platform warnings. Real G2 lens
transport and secure bridge verification remain unavailable/not performed;
A32-only app launch evidence must not be read as glasses-display evidence.

A snapshot of project state, what was accomplished, what is pending, and how to
pick the work back up on a new machine. Pairs with the in-repo `ROADMAP.md` and
the private `DECODE-SPEC.md` (see "Out-of-repo data").

## 0. Latest continuation (2026-08-20)

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

## 8. Direct in-process assistant tool registration (local review candidate)

- Candidate branch: `work/t_2c2d05f9-inprocess-tools-rework`, replacement frozen
  commit chain `4b99bb8` (implementation), `8ba024d` (behavioral coverage),
  and `d5ddd67` (focus-change notifications), based on
  `origin/hermes-g2@ae89fd5e398a78ce9a7d00c66a47d92d02812319`. The in-process
  window adapter accepts optional unprefixed `open`/`foreground` declarations,
  uses the shared `ToolRegistry`, prefixes names as `app.<appId>.*`, and checks
  checks the live shell foreground window at list and call time. Focus changes
  notify the registry so clients refresh foreground-tool availability.
- Closing a window removes its registration once before existing layer, app, and
  surface cleanup; the registry's same-name fallback remains available. The
  behavioral contract test exercises listing, foreground gating, direct
  invocation, notifications, unknown-after-close behavior, and fallback.
- Verification (frozen at `d5ddd67`): focused `node --test tests/in-process-surface.test.mjs
  tests/tool-registry.test.mjs` passes 8/8; `npm run typecheck` passes; Android
  JDK 21 / SDK debug `npm run build` passes. `npm run test` runs 145 tests,
  143 pass, with two existing date-gated activity failures in
  `tests/ring-health-store.test.mjs`. `git diff --check` passes. No hardware,
  BLE, firmware, pairing, reset, wipe, or other destructive operation was
  used; nothing was pushed and no PR is open pending independent
  `g2-reviewer` approval.
