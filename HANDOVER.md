# Hermes G2 handover (2026-08-21)

## Current repository outcome

The former PR #1-#9 queue is being consolidated without rewriting reviewed history.
The canonical integration branch is `integration/t_30a956f8`; its final pre-review
code commit is `c4609642025a950f8833bc6c1e10e4d288723576` (the first integrated
implementation freeze was `49c865e7eff398e4de0c76ccc25507b7b74a518f`). The branch is based on
`origin/hermes-g2@ae89fd5e398a78ce9a7d00c66a47d92d02812319` and retains the reviewed
commits by merge ancestry while resolving overlapping health, assistant-tool, GATT,
direct-R1, teardown, packetAck, and release work once.

### Live GitHub queue at the documentation freeze

- PR #1 (`test/activity-stale-day-gate`) was safely fast-forwarded to reviewed
  `41514c508ada1053715c22786d39085874fed4b6`.
- PR #2 (`wt/t_f56ee8c2`) was safely fast-forwarded to reviewed
  `5427dee70b3f4ea07fb1034355b6b8a25f97a2be`.
- PR #3 was previously fast-forwarded to reviewed trusted-health head
  `3381ee1fc98c6a22017abca06b28fbba2286ca16`; the integration branch also
  preserves the separately reviewed fail-closed persistence head
  `9161ea6b781ba11b1a6ab04a154237a11b30d339`.
- PR #4 was safely fast-forwarded to reviewed generation-safe head
  `9ce65d308bb6f15627aded13cda4379ed45fdbae`.
- Old broad PR #5 was closed as superseded. Focused docs-only replacement PR #10
  is https://github.com/not-benny/hermes-g2/pull/10 at reviewed
  `84d5c17a72b6a9c3d5020d76a794221716dc9830`; it excludes stale wake-barrier code.
- PRs #6, #7, and #8 remain preserved at `bf59c2b7`, `c2534b7a`, and `f4f9761f`
  until the canonical integration PR is remotely verified, then they should be
  closed with factual supersession comments. Their reviewed commits are retained
  in the integration ancestry; their overlapping lifecycle implementation is
  represented by the corrected integrated result rather than independent merges.
- PR #9 remains preserved at `9be278fc`; its changelog commit is retained in the
  integration ancestry and must not claim operational BLE evidence.
- GitHub showed no CI check rollups on these PRs at freeze time. Local verification
  below is evidence, not a claim that GitHub checks are green.

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

- Focused BLE/lifecycle suite: 39/39 passed:
  `node --test tests/gatt-callback-registry.test.mjs tests/gatt-callback-identity.test.mjs tests/gatt-callback-dispatch.test.mjs tests/ring-worker-isolation.test.mjs tests/ring-worker-lifecycle.test.mjs tests/communicator-teardown.test.mjs tests/ring-frame.test.mjs tests/ring-packetack-lifecycle.test.mjs`.
- Full host suite: `npm run test` passed 225/225.
- TypeScript: `npm run typecheck` passed after resolving four integration-only
  launch-wrapper signature errors.
- `git diff --check`: passed before the documentation commit.
- Android JDK 21 / SDK 35 build: passed after full Java compilation; debug APK at
  `platforms/android/app/build/outputs/apk/debug/app-debug.apk`.
- Independent adversarial review: the first frozen review found dispatch-gate/
  ring-lock inversion, callback-thread blocking, early-disconnect double-close,
  and delayed ring-connect publication blockers. Those were corrected in
  `2577a838`/`c4609642`; focused 39/39, full 225/225, typecheck, and the Android
  build pass afterward. A second exact-SHA adversarial review is required before push.
- Hardware: the 335,803,763-byte debug APK installed successfully over USB on the
  configured Samsung A32 and launched as PID 26465. Package-filtered logs showed
  both G2 arms CONNECTED, prelude ACK, `session ready`, direct R1 CONNECTED,
  `direct ring ready mtu247Request=ok`, CRC-valid device-info/health responses,
  successful read-only health GET writes, and heartbeat ACKs. No communicator-loop
  error or Android fatal exception appeared in the bounded capture. The R1 lacks
  the optional standard battery characteristic, which remained a safe diagnostic.
  The final `c4609642` APK was then reinstalled and relaunched: one transient
  status-133 left-arm attempt retired and retried, followed by both arms ready,
  direct R1 ready, health/device-info responses, and heartbeat ACKs with no fatal
  or communicator-loop error. This proves startup/retry/connect/read-path behavior,
  but not every stale-callback or concurrent teardown interleaving.

Static review: PENDING — final frozen SHA has not yet completed independent review.
Operational authorization: LIMITED GO for the observed non-destructive startup and
read-only G2/R1 path; NO-GO for unexercised stale-callback/concurrent-teardown cases.
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

## Delivery sequence

1. Commit this HANDOVER/ROADMAP freeze and record the final SHA.
2. Run the final full suite, typecheck, JDK21/SDK35 Android build, diff check, and
   added-line secret/private-data scan.
3. Run independent adversarial review against that exact SHA. Fix blockers and
   re-review a new frozen SHA if needed.
4. Perform safe A32/G2/R1 runtime checks when the devices are available; otherwise
   keep operational authorization NO-GO.
5. Push `integration/t_30a956f8` without force and open the canonical integration PR
   against `hermes-g2`.
6. Read back remote SHA, base/head, files, commits, body, state, mergeability, and
   checks. Only then close overlapping PRs #3/#4/#6/#7/#8/#9 as superseded where
   their work is demonstrably preserved. Keep PRs #1, #2, and #10 independent.
7. A final HANDOVER-only delivery-state commit may use the bounded deterministic
   documentation exception after diff/security checks and exact remote readback.
