# Hermes G2 handover (2026-08-21)

## Current repository outcome

The former PR #1-#9 queue is being consolidated without rewriting reviewed history.
The canonical integration branch is `integration/t_30a956f8`; its final pre-review
code commit is `329af655ae4848a6eabae14e598ffcc2788308ea` (the first integrated
implementation freeze was `49c865e7eff398e4de0c76ccc25507b7b74a518f`). The branch is based on
`origin/hermes-g2@ae89fd5e398a78ce9a7d00c66a47d92d02812319` and retains the reviewed
commits by merge ancestry while resolving overlapping health, assistant-tool, GATT,
direct-R1, teardown, packetAck, and release work once.

### Final live GitHub queue

- PR #1 (`test/activity-stale-day-gate`) was safely fast-forwarded to reviewed
  `41514c508ada1053715c22786d39085874fed4b6`.
- PR #2 (`wt/t_f56ee8c2`) was safely fast-forwarded to reviewed
  `5427dee70b3f4ea07fb1034355b6b8a25f97a2be`.
- Canonical integration PR #11 is https://github.com/not-benny/hermes-g2/pull/11,
  head branch `integration/t_30a956f8`, base `hermes-g2`. Its implementation was
  independently approved at `46cff6c87d47311140e2f678529561ce30b47009`; later
  commits are documentation-only delivery/hardware-state updates. GitHub readback
  must remain OPEN, non-draft, and mergeable with the intended files/body/commits;
  no required status-check rollup or formal review decision is currently present.
- Old broad PR #5 was closed as superseded. Focused docs-only replacement PR #10
  is https://github.com/not-benny/hermes-g2/pull/10 at reviewed
  `84d5c17a72b6a9c3d5020d76a794221716dc9830`; it excludes stale wake-barrier code.
- PRs #3, #4, #6, #7, #8, and #9 are closed with factual #11 supersession
  comments after remote ancestry/readback proved their reviewed heads are retained.
  Their branches and exact SHAs were not deleted or rewritten.
- The remaining open queue is #1, #2, #10, and #11. None currently has visible CI
  check rollups; local verification below is evidence, not a claim of green GitHub CI.

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
- `tools/even-api-capture/` provides the fail-closed, value-redacting capture sanitizer and
  validator for a future official `check_firmware` request. The real request remains
  uncaptured; no watcher, downloader, firmware client, replay, or credential handling was added.
- The sacrificial recovery protocol is documented, but the recovery and genuine-image gates
  remain BLOCKED/UNKNOWN. A private candidate's existence is not provenance, compatibility,
  signature, rights, or recovery proof. Firmware/DFU/OTA remains NO-GO / DO NOT BUILD.

Verification: focused decoder/persistence/Java/wiring/ring-store coverage passes
60/60; the capture sanitizer passes 13/13; full `npm run test` passes 234/234;
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
gaps across timezone changes, dynamic JSON/query-key leakage, false `list_devices` completion,
an unsafe Bluetooth fallback, stale cleanup wording, a committed device identifier, and a
no-write/DFU contradiction. The candidate now rejects malformed vital envelopes and truncated
counts, binds persisted timestamps to fixed-offset date/hour identity, redacts all JSON/query key
text, accepts only `check_firmware`, prohibits Bluetooth fallback, validates the sanitizer schema,
and corrects the safety documentation. No pairing, permission,
credential, NVM, firmware, recovery, reset, wipe, or private-data state was changed.

Independent frozen-SHA review, GitHub delivery, and remote readback remain pending at this checkpoint.

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

Finish the R1 candidate's full validation matrix and bounded non-destructive A32/R1
session-open check, then freeze it for independent adversarial review before updating
canonical PR #11. Keep cmd=6 sleep separately parked until correlated same-night evidence
exists. Do not expand pairing, ownership, NVM, recovery, firmware, reset, wipe, or
private-data publication authorization.
