# Hermes G2 handover (2026-08-21)

## Current repository outcome

The active outcome branch is `wt/t_273bc0ae`, fast-forwarded without rewriting
history to the latest canonical integration base
`b1150c90e8ce8e55a8a02b957e58eb6fe6380c5e`. The delivered outcome is
PR #12 (`https://github.com/not-benny/hermes-g2/pull/12`), head
`wt/t_273bc0ae`, base `integration/t_30a956f8`. Initial remote readback at
`e252592a8eb002c2ac778ca31f5943fa88411be5` confirmed OPEN, non-draft,
CLEAN/mergeable, the intended 16-file diff and four-commit chain, exact base SHA
`b1150c90e8ce8e55a8a02b957e58eb6fe6380c5e`, no status-check rollup, and no
formal review decision. Live connection recovery is documented and delivered in
follow-up PR #13 (`https://github.com/not-benny/hermes-g2/pull/13`), head
`fix/live-glasses-session`, base `wt/t_273bc0ae`; its implementation commit is
`1c1e271e9cc970a646c71bb29a5ffa5e714472c9`.

### Safe assistant/MCP glasses-display candidate

- `glasses.render_view` is a private-evaluation, conversation-only shell overlay.
  Its imperative V1 policy allows only inert text/key-value/progress/divider
  blocks and bounded action labels. It rejects controls, bidi overrides, URLs,
  markup, unknown fields and all raw rendering primitives before shell mutation.
- Create/update uses a caller operation ID, opaque Android UUID, exact owner,
  revision CAS, one live view, 30-3600 second generation-bound TTL, two accepted
  renders per rolling second, and a strict shell/compositor delivery receipt.
  It never wakes or changes focus. Cancellation, local close, expiry and MCP
  disconnect tombstone exact identities and cannot clear a replacement.
- Scroll changes local selection. Click queues one bounded inert event for the
  exact owner/revision; `glasses.read_view_events` drains it. No gesture invokes
  another tool. Double-click closes the view; long-press closes remote content
  before preserving the shell escape countdown.
- External MCP calls no longer infer authority from whichever turn is current.
  Their bridge envelope must claim the exact originating `turnId` or explicitly
  mark a proactive call. Missing, delayed, stale-turn and stale-connection calls
  fail closed. MCP close aborts connection-owned work and view state. Direct
  provider turns now propagate their own generation and cancellation signal.
- The inbound bridge frame is bounded before JSON parsing and WSS remains the
  only configured scheme. This is not external-operation proof: no licensed
  compatible bridge deployment, certificate/server identity trace, generic MCP
  client, credential run, or real-G2 display evidence exists. Public MCP/skill
  publication and operational authorization remain NO-GO; no `SKILL.md` was added.

Verification on the original PR #12 candidate: final focused render/MCP lifecycle tests
passed 14/14; full `npm run test` passed 246/246; `npm run typecheck` and the
JDK 21 / Android SDK 35 build passed. That candidate was installed on the authorized
A32 but did not retain the controller's live communicator: the Java BLE worker reached
`session ready` while the phone UI remained `Disconnected.` and shell frames were
discarded. It therefore did not provide valid real-G2 display evidence.

### Live glasses connection recovery

Follow-up commit `1c1e271` fixes the startup state race which caused the failed
hardware outcome. `FaceclawBleCommunicator.setListener()` posts its constructor-time
`disconnected` snapshot asynchronously. If that stale snapshot arrived after a fresh
connect began, `DashboardController` treated it as completed teardown, detached the
communicator, and then missed the subsequent native `connected` publication while the
BLE worker continued running. Communicator ownership is now finalized only when an
owned controller is already in `disconnecting` and receives terminal `disconnected`;
a delayed initial snapshot cannot cancel a live connect attempt.

Focused regression coverage first failed because the lifecycle helper was absent, then
passed 5/5 with the existing teardown tests. Full `npm run test` passes 248/248,
`npm run typecheck` passes, and JDK 21 / Android SDK 35 `npm run build` passes. The
exact commit's APK was installed over the existing package on the authorized A32 with
app data retained. After two transient Android GATT-133 retries, both arms connected,
the native worker published `session ready`, framebuffer leases and `create-layout`
were ACKed, the phone UI reported `Connected.`, shell frame 15 completed as `sent`,
and a real glasses input event was consumed by the shell with a chrome render queued.
No pairing, provisioning, firmware, reset, wipe, permission, credential, or ownership
state was changed. This is verified two-arm connection, display delivery, and input
responsiveness evidence; it is not authorization to publish the MCP/skill surface.

Independent adversarial review first reproduced three lifecycle blockers across
the frozen candidates: local close during initial delivery could publish a ghost,
update churn could evict the create-operation tombstone, and disconnect during an
in-flight replacement could restore an orphaned prior shell layer. Focused red/green
regressions now keep pending identities tombstoned, retain create idempotency apart
from bounded update history, and cancel both committed and pending owner revisions.
Final exact-SHA review passed at
`1ca3709ac23408620c7477056fb51f09fe874065`: **Static review: PASS** with no
remaining file/line/interleaving blocker. **Operational authorization: NO-GO**
for public MCP/skill publication and external `render_view` operation pending the
external bridge, licensing, generic-client, credential, and tool-specific hardware
evidence listed above. The later connection recovery proves normal shell transport
and input only; it does not supersede those publication and remote-view gates.

## R1 health and protocol completion candidate

The current task branch is `task/t_41b671d9-r1-health-protocol`, based exactly on
canonical PR #11 head `448b7221310ed696bbbeab4d3b73bfd06f409923`.

- Daily HR/SpO2/temperature/HRV decoding now names and validates the signed timezone,
  local-midnight day base, and independent current-value timestamp. Anchored hourly
  records carry `timestampSec = dayBaseSec + hourIdx*3600`; malformed/zero anchors
  preserve metric/current values with null timestamps and the prior today/yesterday
  persistence fallback.
- `health.store.v1` and consent-bounded health export/query preserve an optional hourly
  `timestampSec` without migrating or invalidating legacy rows. Metric-only updates cannot
  erase an existing anchor.
- Android now builds the captured six-byte `systemTime(0x05)` payload in the Android-free,
  host-tested `FaceclawRingClock` helper and sends one best-effort SET during initial health
  session setup, after health enable and before daily GETs. It is not repeated by 15-second
  or 60-second polls, and failure does not block health reads.
- The public-safe provisioning call trace is consolidated in
  `notes/r1-provisioning-static-analysis-2026-08-21.md`. It is static intelligence only:
  0x0a/0x0c remain blocklisted, Even remains required for first-time provisioning, and
  pairing/unpair UI remains blocked.
- The archived `check_firmware` capture attempt remains incomplete. Its draft harness was
  deliberately omitted after adversarial review found fail-open validation, unenforced Bluetooth
  denial, global-proxy scope, and exact-state-restoration gaps. No watcher, downloader, firmware
  client, replay, credential handling, or capture procedure is shipped.
- The sacrificial recovery protocol is documented, but the recovery and genuine-image gates
  remain BLOCKED/UNKNOWN. A private candidate's existence is not provenance, compatibility,
  signature, rights, or recovery proof. Firmware/DFU/OTA remains NO-GO / DO NOT BUILD.

Verification: focused decoder/persistence/Java/wiring/ring-store coverage passes
70/70; full `npm run test` passes 236/236;
`npm run typecheck` passes after worktree-local `npm ci`; JDK 21 / SDK 35 Android
`npm run build` passes with full Java/native compilation; `git diff --check` and the
added-diff private-data/artifact scans pass.

Bounded A32/R1 evidence used the exact built APK and existing ownership only. Install and
launch passed; the R1 reached MTU-247/notify-ready. Sanitized package logs prove one successful
`systemTime SET` between health enable and the first daily GET, followed by repeated 15-second
HR-only polls with no repeated clock write. Four received daily vital frames had a nonzero,
timezone-aligned day anchor and passed the derived record formula check without recording raw
frames or readings. The phone Health page rendered, but the first one-shot cache handover occurred
before that page's persistence listener was active; after selection the cache was drained, so an
anchored persisted row was **NOT OBSERVED** in this bounded run. Static decoder/persistence tests
pass, but end-to-end anchored persistence remains operationally pending. The first independent
review found missing vital envelope/CRC gates, partial-count acceptance, timestamp/date identity
gaps across timezone changes, plus multiple fail-open capture-harness/privacy blockers. The
candidate now rejects malformed vital envelopes and truncated counts, binds persisted timestamps
to fixed-offset date/hour identity, retains valid anchored rows across phone date-line changes,
and keeps repeated local hours separate by absolute timestamp so metrics never mix identities;
the unsafe capture harness was removed rather than
published, captured vital/activity fixtures were replaced with synthetic builders, and stale
capture/raw-blocklist documentation was corrected. No pairing, permission,
credential, NVM, firmware, recovery, reset, wipe, or private-data state was changed.

Independent adversarial review passed exact implementation SHA
`014736deebf7c111ccbcbe3d3dc30ba7d803221d`: static timestamp/clock review PASS
with no remaining blocker, and privacy/safety review PASS. Operational authorization remains
NO-GO for anchored persistence because that exact end-to-end hardware row was not observed;
firmware/DFU/OTA, pairing/provisioning, recovery, reset, wipe, and private capture/publication
remain NO-GO. The post-review changes are limited to HANDOVER/ROADMAP state updates. The
candidate was delivered by non-force fast-forward to canonical PR #11 head branch
`integration/t_30a956f8`; remote readback at `03c8046f44e95496ace147e88669afb0bd4bce7e`
confirmed OPEN, non-draft, base `hermes-g2`, head `integration/t_30a956f8`, MERGEABLE, the
intended R1 files/body/title, and no reported status checks or formal review decision.

## Integrated behavior

### BLE and direct R1 lifecycle

- All GATT connection and operation completions are bound to exact
  `BluetoothGatt` identity plus a monotonic generation in `GattCallbackRegistry`.
- Disconnect/timeout retires only the owned GATT, fails its waiters closed, and
  cannot retire a same-address replacement.
- Stale CONNECTED and DISCONNECTED callbacks are idempotently retired and close
  only the obsolete exact object.
- External notification/connection listeners run on one ordered manager executor,
  not the Android BLE callback thread. Copied payloads revalidate their exact
  dispatch lease under the per-address retirement gate immediately before mutation.
- Manager close rejects queued effects and shuts down the callback executor.
- Display and ring workers have separate lifecycle ownership. Incomplete bounded
  teardown retains the communicator and subscriptions, blocks replacement, and
  completes manager/GATT, wake-lock, receiver, and thread cleanup exactly once
  after both workers quiesce.
- Glasses connection attempts carry a generation. Arm loss, hard transport failure,
  reset, and user disconnect invalidate a stale attempt before it can republish
  `sessionReady` or start the R1 path.
- packetAck work is queued only for the live ready ring generation, bounded to 16,
  worker-drained, and revalidated under `ringLock` through the final BLE write.
  Ring loss, arm loss, failed ring connect, successful replacement, hard transport
  failure, reset, and disconnect increment generation and clear queued cursors.
- The rejected asynchronous wake-barrier implementation and its disconnected test
  model were removed. The retained PR #7 synchronous wake/readiness contract is
  used by the NativeScript bridge; no stale completion-token map remains.

### Assistant and persistence lifecycle

- Health MCP data remains consent-gated and unavailable to the plaintext external
  bridge. Trusted calls require a live caller, connection generation, turn
  generation, and final pre-load policy check.
- Canonical health persistence is fail-closed: malformed/future data is preserved,
  replacement is read-back verified, partial legacy cleanup is retryable, and
  preview seeding does not claim success after failed persistence.
- In-process tool registration and teardown use generation-specific leases.
  Window close/replacement aborts only owned calls and prevents stale cleanup from
  deleting or cancelling a replacement.
- Cancellation reaches worker terminal input, timer mutations, Roam writes,
  navigation/timer launch wrappers, and the final delayed alert delivery predicate.

## Verification on the integrated code commit

- Focused BLE/lifecycle suite: 40/40 passed:
  `node --test tests/gatt-callback-registry.test.mjs tests/gatt-callback-identity.test.mjs tests/gatt-callback-dispatch.test.mjs tests/ring-worker-isolation.test.mjs tests/ring-worker-lifecycle.test.mjs tests/communicator-teardown.test.mjs tests/ring-frame.test.mjs tests/ring-packetack-lifecycle.test.mjs`.
- Full host suite: `npm run test` passed 226/226.
- TypeScript: `npm run typecheck` passed after resolving four integration-only
  launch-wrapper signature errors.
- `git diff --check`: passed before the documentation commit.
- Android JDK 21 / SDK 35 build: passed after full Java compilation; debug APK at
  `platforms/android/app/build/outputs/apk/debug/app-debug.apk`.
- Independent adversarial review: the first frozen review found dispatch-gate/
  ring-lock inversion, callback-thread blocking, early-disconnect double-close,
  and delayed ring-connect publication blockers. Those were corrected in
  `2577a838`/`c4609642`. Re-review then found non-atomic glasses-generation
  publication and timeout-retirement ownership gaps; `329af655` adds a shared
  generation lock, timeout-boundary completion rechecks, and exact retirement-owned
  close. Focused 40/40, full 226/226, typecheck, and Android build pass afterward.
  Final exact-SHA adversarial review at `46cff6c8`: PASS, with no remaining
  file/line/interleaving blocker.
- Hardware (latest bounded vertical run, 2026-08-21): exact source
  `cdb0b3f9aa78f9912f51cfdca5094a9084bdfc9e` built a 335,799,843-byte debug
  APK (`SHA-256 51b41885eb1f375d8d961fd4f9e49dc9ed8117b66811bf4edbf6199668292863`),
  which installed successfully over the authorized USB Samsung A32 (Android 13,
  API 33) as `com.faceclaw.app` 1.0.0. Two bounded cold app sessions connected
  both G2 arms, received the prelude ACK, and published `session ready`. The first
  session encountered bounded status-133 direct-R1 retries; after the controlled
  app restart, the same candidate recovered to `direct ring ready
  mtu247Request=ok phoneNotify=true dataNotify=true`, sent the session-open and
  device-info/HR/SpO2/HRV/activity/sleep/device-status requests, and received only
  `crc32=OK` command-channel replies, including repeated current-hour HR polls.
  The missing optional standard battery characteristic remained a safe diagnostic.
  No `FATAL EXCEPTION`, `AndroidRuntime`, communicator-loop error, ring-worker
  error, `crc32=BAD`, refusal, or write failure appeared in either package-PID
  capture.
- This run does not close every vertical flow. The glasses reported charging and
  intentionally paused display communication, so Health-card/HUD pixels,
  notification/display behavior, optical clipping/readability, and wearer input
  remain BLOCKED pending a worn, off-charger session. The configured private
  assistant endpoint repeatedly attempted connection but never reached a connected
  state; no direct provider was configured, and no isolated disposable g2mirror
  session was available. Assistant bridge, system-tool, app-tool, wakeword,
  calendar, and Terminal rows therefore remain BLOCKED rather than failed. No
  synthetic notification was posted because this Android build exposes no exact
  package-safe cancel command and temporary notification state had to be restored.
  The app was left foregrounded on the Glasses tab; no permission, credential,
  pairing, ownership, firmware, reset, wipe, or private-data state was changed.

Static review: PASS — exact reviewed and remotely delivered head `46cff6c87d47311140e2f678529561ce30b47009`.
Operational authorization: LIMITED GO for the observed non-destructive install,
startup, reconnect, G2 session, and R1 request/response path; NO-GO for the blocked
wearer/display/assistant cases and unexercised stale-callback/concurrent-teardown
interleavings.
Firmware/DFU authorization: NO-GO / DO NOT BUILD — no firmware, pairing ownership,
provisioning, reset, wipe, or destructive operation is authorized by this queue work.

## Safe hardware boundary

Non-destructive USB debugging on the configured Samsung A32 is permitted: build,
install, launch, package-PID logcat, screenshots, and read-only observation. Do not
clear app/device data, change pairing ownership, provision NVM, flash firmware,
perform DFU/OTA, factory reset, unpair, or publish private captures. If the phone,
G2, or R1 is unavailable, report the missing evidence rather than inferring success.

## Out-of-repo private data

Private health exports, btsnoop captures, firmware binaries, decode notes, device
identifiers, credentials, and approval evidence remain outside the repository under
the existing private project directories. Do not copy them into commits, PR bodies,
CI logs, or public artifacts.

## Next action

Review and merge canonical PR #11 when ready; GitHub currently reports no status checks, so local
verification remains the evidence. Keep cmd=6 sleep separately parked until correlated same-night
evidence exists. Do not expand pairing, ownership, NVM, recovery, firmware, reset, wipe, or
private-data publication authorization.
