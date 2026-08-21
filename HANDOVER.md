# Hermes G2 handover (2026-08-21)

## BLE callback identity gate (2026-08-21)

Candidate commit: `9698cab3fbd70c756c8bbf2bb86006388a8f0397` on branch `wt/t_5e85b756`; clean, committed, unpushed, and no PR opened.

FaceclawBleManager now carries the source BluetoothGatt through both
characteristic-change callback overloads and rejects callbacks whose object is
not the current address entry. Connection callbacks use the same identity gate:
stale CONNECTED callbacks cannot publish or release latches, while stale
DISCONNECTED callbacks only close their own GATT. Same-address callers share the
owning exact-GATT attempt; explicit disconnect and owner timeout fail and release
pending waiters without retiring a replacement attempt. Listener delivery occurs
outside the Bluetooth API lock and carries the exact GATT identity across the
boundary. Focused source-contract tests pass 4/4 and the full Node suite passes
161/161. Direct javac of FaceclawBleManager, FaceclawBleListener, BleProtocol,
and CollectionUtils against Android-35 passes. Typecheck and Android build remain
blocked by the existing 35 NativeScript Android/JavaScript namespace errors
(`android`, `androidx`, `java`, and `Array.create`); no hardware reconnect
interleaving was attempted, so operational verification remains NO-GO.

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
  MCP/skill publication is NO-GO. The complete matrix now classifies every tool,
  the bridge/server, in-process surface, APK, render design, future skill, and
  sibling adapter; no row is release-ready. The bridge still lacks
  authenticated secure transport/server proof, per-turn generation
  authorization, and cancellable/idempotent side effects. A bounded shell-owned
  `glasses.render_view` v1 and `hermes-g2-glasses` skill remain blocked. See
  `notes/mcp-skill-publish-audit-2026-08-20.md`.
- **Bridge/MCP hardening pass 1:** privileged frames now require current-generation
  authentication; stale socket callbacks are ignored; schemas are enforced;
  app-tool ownership is window-safe; availability failures fail closed; MCP
  initialization/errors and side-effecting notification rejection are covered;
  proactive quota follows preflight. MCP lifecycle/replies are connection-bound;
  duplicate IDs and late replies are suppressed; unsupported schemas fail closed;
  array bounds/schema-valued extra properties are enforced; owner fallback,
  top-level protocol-version/socket closure, and auth timeout are covered.
  Targeted MCP/bridge/registry/in-process validation passes 19/19; the full
  repository run currently reports 143 passed and 2 pre-existing ring activity
  failures. These results are static/unit evidence only and do not close
  hardware, credential, generic-client, or release gates.
- **MCP glasses-display threat model:** added `notes/mcp-glasses-display-threat-model-2026-08-21.md`
  with the end-to-end asset/trust-boundary model, threat register, safe-failure contract, exact P0/P1/P2
  backlog, and STATIC/SIMULATED/A32-ONLY/A32+REAL-G2 evidence ledger. Static review remains **FAIL for
  publication** and operational authorization remains **NO-GO**; no render implementation, publication,
  or hardware claim was added.
- **MCP display safety hardening:** added a pure display-text policy and focused
  tests. `glasses.show_alert` now enforces a 160-character inert-text bound,
  rejects control characters/markup/URLs, rejects off/disconnected sessions,
  awaits the real shell transport result, and removes the alert on compositor
  failure instead of reporting false success. Behavioral tests cover rejected
  content, privacy-sensitive sentinels, unavailable display, transport failure,
  and ordinary success. Proactive bridge actions now default off. Added
  `docs/mcp-glasses-display.md` with configuration, privacy, troubleshooting,
  disable/rollback, and honest hardware-evidence limits. This does not close the
 secure transport, turn-generation, idempotency, licensing, generic-client, or
 real-G2 publication gates.

Verification for this hardening candidate: focused display handler checks pass
4/4; prior MCP/registry/in-process checks pass 13/13; the full repository run
still reports 147 passed and 2 known
date-sensitive ring activity failures at `tests/ring-health-store.test.mjs:158`
and `:190`. TypeScript typechecking passed, and a debug Android build completed
with Android SDK 35 and JDK 21 at
`platforms/android/app/build/outputs/apk/debug/app-debug.apk`. Debug APK builds
are not reproducible, so no build-instance hash is treated as a canonical release
identity.
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

- `../ground-truth-private/` — Even health-export CSVs, btsnoop captures, an
  **unverified** R1 ring-firmware candidate (zip + extracted `application.bin`),
  the RE harness `fwre.py`, and the full `DECODE-SPEC.md`. Personal health data +
  proprietary firmware. Copy by hand when moving machines; the candidate is not
  an approved image and must not be treated as one.
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

### 4a. Ring firmware consent gate (current NO-GO)

- `notes/ring-firmware-consent-gate.md` is the reusable documentation-only informed-consent
  gate for any future R1 firmware investigation or sacrificial-device test. It requires a
  scope-limited phase approval plus a separately recorded per-run GO/NO-GO, with distinct
  owner/custodian, hands-on operator, Benny as Hermes G2 safety approver, and (for destructive
  work) an independent recovery lead/witness. Missing, stale, expanded, or revoked approval
  fails closed; any signatory may stop and the owner may revoke future consent.
- Operational authorization remains **NO-GO / BLOCKED / DO NOT BUILD**. The gate does not
  establish protocol intelligence, a genuine vendor-signed hash-pinned image, Hermes-owned
  pairing authority, or independent recovery. It never authorizes Secure DFU bypass, key
  extraction, validation weakening, bootloader patching, downgrade/exploit paths, or device
  modification. Private approvals, exact identifiers, captures, and raw logs belong under
  `../ground-truth-private/firmware/approvals/<approval-id>/`; public records retain only
  redacted aliases, approval IDs, statuses, hashes, and dates.
- Next review trigger: only reassess after every independent gate is evidenced and a fresh
  completed phase approval and per-run record are available for the specifically named scope,
  device, artifact, procedure revision, and UTC window. No approval transfers to another run.

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

## 9. Non-blocking wake barrier (2026-08-21)

- Implemented a worker-owned, generation/token-tagged wake barrier in
  `FaceclawBleCommunicator.java`. Wake lease, readiness, and resume APIs now
  register and return promptly; CLAIM/prelude/READY progression stays on the
  communicator worker, with two-arm delivery counting, stale-generation
  rejection, bounded deadlines, and disconnect/reset failure completion.
- Added `onWakeBarrierComplete` through the Java listener and NativeScript bridge,
  including bounded completion retention and timeout cleanup so a completion that
  races waiter registration cannot settle a newer request.
- Focused source-contract coverage is in `tests/wake-barrier.test.mjs` (2/2).
  `npm run typecheck` passes and the JDK 21 / Android SDK debug build passes.
  The full `npm test` baseline remains 143 passed / 2 existing date-gated ring
  activity failures in `tests/ring-health-store.test.mjs`; no new failures were
  observed. A32 USB serial `RFCR707RQGV` was used for a non-destructive debug APK
  install and launch (`com.faceclaw.app`); bounded package-filtered logcat showed
  normal NativeScript/node startup and no `AndroidRuntime`/`FATAL EXCEPTION`.
- No firmware bytes, BLE framing, pairing, reset, wipe, or destructive device
  operation was changed or used. Nothing has been pushed and no PR is open.

## 10. Authorization-gated assistant and Terminal hardware matrix

- The executable, authorization-gated runbook is
  `notes/direct-assistant-app-tools-hardware-test-matrix.md`. It covers direct
  calendar/provider behavior, wakeword policy, and the background Terminal
  `list_sessions`, `send_input`, `read_screen`, and no-active-view cases.
- No hardware or device-connected service result was produced. Execution is
  unverified and pending an explicit, separately recorded GO naming the
  authorized phone/G2, data/actions, disposable Terminal session, commands,
  evidence scope, expiry, and exclusions.

## 11. Held awesome-list submissions inventory (2026-08-21)

- There is one target repository and two intended, separate suggestions:
  `pangoleen/awesome-even-realities-g2` (`https://github.com/pangoleen/awesome-even-realities-g2`).
  The contributor guide is `contributing.md` and requires one PR per suggestion,
  appending to the appropriate category, the format
  `- [Name](link) - Description.`, concise present-tense descriptions, a
  canonical working link, and `npx awesome-lint`.
- Suggestion 1 is the ring-health reverse-engineering material under
  **Protocol and Reverse Engineering**. Intended public link:
  `https://github.com/not-benny/hermes-g2/tree/main/docs/ring-health`.
  The concrete scrubbed submission artifact is
  `docs/ring-health/{README.md,capture-method.md,ring-frame-decoder.py}` on
  `origin/main` at `f60bf48138e6e259ddf6d9d6b783a588c4f59ccb`; those files were
  added in historical commit `af0362519045c1006c587b78738d7b1337c402b7`.
  The current task ancestry's `notes/ring-health-protocol-2026-08-19.md` is a
  working note containing private/raw-evidence references and is not the
  publication source. Exact proposed entry:
  `- [Hermes G2 Ring Health](https://github.com/not-benny/hermes-g2/tree/main/docs/ring-health) - Reverse-engineered R1 ring-health BLE protocol documentation with capture methods and a self-testing frame decoder.`
- Suggestion 2 is **Hermes G2** under **AI and Agent Integrations**:
  `https://github.com/not-benny/hermes-g2`. Intended description: an unofficial
  Android companion for Even Realities G2 glasses, built around Hermes Agent,
  with voice interaction, notifications, media, navigation, terminal mirroring,
  and R1/glasses controls. Exact proposed entry:
  `- [Hermes G2](https://github.com/not-benny/hermes-g2) - Unofficial Android companion for Even Realities G2 glasses, built around Hermes Agent, with voice interaction, notifications, media, navigation, terminal mirroring, and R1/glasses controls.`
- The contributor fork exists at
  `https://github.com/not-benny/awesome-even-realities-g2`. Its only branch is
  `main` at `9c7ae1b`; no topic branch, draft commit, or persisted two-entry
  patch was found. The fork's README does not contain either entry. The parent
  currently has only unrelated open PR #1 (`add-er-studio`), and GitHub search
  found no related issue or PR in either repository.
- Publication is **NOT READY**: `not-benny/hermes-g2` is currently private,
  unauthenticated requests to its root and intended ring-health URL return 404,
  and its releases/tags API is empty. Therefore both intended links fail the
  list's public-link/release gate and the exact release snapshot path must be
  revalidated before preparing the entries. The public release, stable URLs,
  and a durable fork patch are blockers; no awesome-list PR has been opened.
- GitHub authentication is available as `not-benny` with `repo` scope and the
  fork is owned by that account. Parent-repository collaborator permission
  could not be queried (GitHub returned 403 because the account is not a
  collaborator), so push access to `pangoleen/awesome-even-realities-g2` is
  unconfirmed. A PR from the owned fork may be possible after the release gate,
  but must be handled as reviewed delivery and not inferred from this inventory.
