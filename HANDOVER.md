# Hermes G2 handover (2026-08-20)

A snapshot of project state, what was accomplished, what is pending, and how to
pick the work back up on a new machine. Pairs with the in-repo `ROADMAP.md` and
the private `DECODE-SPEC.md` (see "Out-of-repo data").

## 0. Latest continuation (2026-08-20)

### Direct-R1 worker isolation candidate (2026-08-21)

- Local rework branch `work/t_535a9f1f-ring-worker-rework` now has candidate
  commits `0accf5f`, `0475383`, `abd7787`, `680dbf1`, `aaef1af`, and callback
  identity/dispatch fixes `9671839`, `f0f4892`, `a46cb12`, and `58bd941` (not
  pushed; no PR).
  Every optional direct-R1 connect,
  discovery/MTU/subscription wait, battery read, health poll, packetAck drain,
  and ring write runs on the single `FaceclawRingLink` worker. The glasses
  `FaceclawBleCommunicator` loop and initial glasses connect path perform no
  direct-ring work.
- Direct-ring lifecycle, timers, generation, battery, and bounded packetAck
  state are protected by a distinct `ringLock`. Following the first independent
  review, teardown now installs a durable `stopping` gate before the framebuffer
  release wait, wakes and interrupts the ring worker immediately, and revalidates
  that gate at every direct-ring entry/GATT stage/final write. A separate
  lifecycle lock serializes `start()` across the complete teardown. Both bounded
  joins must report their workers dead before thread fields or session state are
  reset or the BLE manager is closed; a live/timed-out worker leaves the object
  fail-closed in stopping state for a later teardown retry. Delayed writes and
  probe gaps still revalidate the captured ring generation and stop on cancellation.
- A second independent review found that the per-stage stopping checks still had
  check-then-act gaps before manager calls. `aaef1af` replaces them with one
  `withRingManagerOperation` barrier that holds `ringLock` from the final
  stopping/session/generation check through every direct-R1 manager operation:
  recovery disconnect, connect, discovery, priority/MTU, subscriptions, battery
  read, service diagnostics, and writes. Since teardown publishes volatile
  `stopping` before taking the same barrier, no new R1 manager side effect can
  begin after teardown starts; an already in-flight operation must unwind before
  teardown can pass the barrier.
- `FaceclawBleManager` now serializes complete operations per address while a
  short static Bluetooth API lock protects only immediate Android GATT API
  initiation. Different-address callback waits no longer block glasses writes,
  and callbacks from an obsolete GATT are ignored. A third independent review
  found the original standalone current-GATT check was still check-then-act:
  callback A could pass it, then publish into address-keyed latch/result state
  created for replacement GATT B. `9671839` replaces those maps with an
  Android-free identity registry. Current GATT identity, exact-GATT operation
  context, result/value publication, latch completion, connected/disconnected
  notification, and data dispatch are validated under one short callback-state
  protocol. Every callback operation timeout retires/closes that GATT before a
  same-address replacement can start, so an untagged late Android callback can
  never be mistaken for a later operation on the same object. Weak identity
  tombstones preserve callback-before-wait handling without retaining closed
  GATT objects indefinitely.
- A fourth independent review reproduced a registry-monitor ↔ `ringLock`
  inversion because accepted callbacks invoked external listeners while still
  holding the callback registry monitor. `f0f4892` now completes callback state
  atomically and returns a one-shot exact-generation dispatch token without
  invoking external code. Each BLE listener acquires its own state lock first
  and claims that token before any listener state mutation. A replacement
  generation invalidates blocked connected, disconnected, and notification
  tokens; a current disconnect remains dispatchable. The registry monitor is
  therefore never held while a callback waits for `ringLock`, and callback token
  claim follows the same state-lock → registry-lock order as ring manager
  operations.
- A fifth independent review found that a current direct-R1 notification token
  queued behind `ringLock` could still be claimed after teardown published
  `stopping`. `a46cb12` records ring callback identity before selecting the
  callback lock and, once it acquires `ringLock`, rejects stopped/not-running
  communicator state before token claim or legacy notification dispatch. The
  glasses callback path retains `lock`, so framebuffer-release notifications
  needed during teardown remain available. A precise regression pins the
  callback-waits-behind-`ringLock` ordering and fail-closed gate.
- A sixth independent review found that the accepted direct-R1 callback still
  called its legacy handler while holding `ringLock`; that handler acquired the
  display `lock` and forwarded health/gesture state, creating a hidden
  `ringLock` -> `lock` edge. `58bd941` now claims the exact-GATT token and copies
  notification bytes plus the volatile ring generation under `ringLock`, then
  releases it before decoding or touching display state. Display mutations,
  packetAck enqueue, log forwarding, health forwarding, and gesture forwarding
  revalidate stopping/running/generation state; main-thread health, gesture, and
  log callbacks also drop retired generations. PacketAck cursors retain the
  accepted generation instead of adopting a replacement session. The source
  contract now rejects transitive lock nesting and stale downstream dispatch.
- Final rework verification on `58bd941`: callback concurrency plus focused ring
  contracts 21/21 and full suite 152/152 passed; `npm run typecheck` passed after
  linking the existing ignored dependency tree into the isolated worktree; and
  the JDK 21 / Android SDK 35 debug build passed. APK:
  `platforms/android/app/build/outputs/apk/debug/app-debug.apk` (336,310,280 bytes,
  SHA-256 `da78a81b867fd51ce7c324ab39be09c4e33f723af3993f2e8766edd46a147e29`).
  `git diff --check` passed and the added-line hardcoded-secret, shell-injection,
  eval/exec, and unsafe-deserialization scan found zero matches.
- Rework install/launch passed on the USB A32 (`SM_A326B`, serial recorded only in
  the task handoff). A natural, non-induced initial R1 connection failure lasted
  2.557 seconds on ring TID 25864; 43 glasses frame/write log lines completed on
  display TID 25863 inside that exact failure window. Automatic retry then reached
  ready with MTU 247 and both notifications, followed by 13 CRC-valid read-only
  responses, one full health poll, and three 15-second current-HR requests. The
  phone UI showed Hermes and `Connected`; no fatal runtime error or incomplete
  teardown was logged. Frame timings were pulled to
  `/tmp/t_535a9f1f-rework-frame-timings.txt` (23,289 bytes).
- The `aaef1af` APK was then installed/launched again on the USB A32. A bounded
  35-second smoke run showed distinct display/ring worker TIDs, direct R1 ready,
  11 CRC-valid read-only responses, one full health poll, and one current-HR
  request, with zero fatal exceptions or incomplete-teardown logs. A reversible
  app force-stop removed the process and relaunch restored it. The untracked raw
  smoke log is `/tmp/t_535a9f1f-atomic-gate-logcat.txt`; it may contain private
  MAC/health material and must not be committed or published.
- The `9671839` APK was installed and relaunched on the same USB A32 for a
  bounded 45-second reconnect smoke. The process remained alive; display TID
  1336 (`FaceclawBleComm`) and ring TID 1337 (`FaceclawRingLin`) were distinct;
  direct R1 reached ready with MTU 247 and both notification subscriptions;
  11 CRC-valid read-only notifications, five health GET writes, one current-HR
  write, and 52 glasses frame/write lines were observed. There were zero fatal
  exceptions and zero incomplete-teardown logs. The untracked raw log is
  `/tmp/t_535a9f1f-callback-registry-logcat.txt`; it may contain private
  MAC/health material and must not be committed or published.
- The final dispatch-token code was installed and relaunched on the USB A32.
  A bounded 45-second final-artifact capture kept the process alive with exactly
  one `FaceclawBleComm` and one `FaceclawRingLin` thread. Direct R1 reached ready
  with MTU 247; 12 CRC-valid/read-only notifications, one full health poll, and
  14 glasses frame-timing lines were observed, with zero fatal exceptions and
  zero incomplete-teardown logs. The earlier natural 2.557-second failure
  interleaving remains the stronger timeout evidence. Raw final logs remain
  untracked at `/tmp/t_535a9f1f-dispatch-token-final-logcat.txt` and must not be
  committed or published.
- The `a46cb12` APK was installed and relaunched on the USB A32 for a bounded
  final smoke. The app process remained alive with exactly one display worker
  (`FaceclawBleComm`, TID 14864) and one ring worker (`FaceclawRingLin`, TID
  14865). Two natural, non-induced direct-R1 failures lasted 2.741 s and 2.685 s;
  one glasses frame completed on a separate display TID inside the first failure
  interval. The subsequent safe force-stop/relaunch reconnect reached direct-R1
  ready with MTU 247, three CRC-valid/read-only health notifications, one full
  health poll, and 23 frame-timing lines. The phone UI showed Hermes and
  `Connected`; no fatal exception or incomplete teardown was logged. Raw logs
  remain untracked at `/tmp/t_535a9f1f-fifth-review-logcat.txt` and must not be
  committed or published.
- The final `58bd941` APK was installed with `adb install --no-streaming -r` and relaunched
  on the USB A32 for 45 seconds. Exactly one display worker (TID 9987) and one
  ring worker (TID 9988) remained alive. A natural, non-induced direct-R1 failure
  lasted 2.570 seconds while one glasses frame completed on the separate display
  TID; automatic retry reached ready over 3.515 seconds with another frame inside
  that connection interval. Four CRC-valid read-only notifications and 13 frame
  timing lines followed, with zero fatal exceptions and zero incomplete-teardown
  logs. Raw output is untracked at
  `/tmp/t_535a9f1f-sixth-review-final-logcat.txt`; it may contain MAC/health data
  and must not be committed or published.
- No timeout was fabricated and no pairing/ownership, permission, MAC,
  firmware/DFU, reset, power, or destructive operation was attempted; Even
  Bluetooth remained revoked. The MAC/raw-health log remains untracked under
  `/tmp` and must not be committed.
- Review state: six GPT-5.6 Sol medium-effort reviews requested lifecycle,
  atomic ring-side-effect, stale-GATT callback, cross-lock dispatch, and queued
  teardown-notification plus transitive-lock rework. `680dbf1`, `aaef1af`,
  `9671839`, `f0f4892`, `a46cb12`, and `58bd941` address those findings
  respectively; the new frozen candidate is pending mandatory re-review. Only a
  reviewer-created delivery card may authorize push/PR. Remaining latency
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
