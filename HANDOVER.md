# Hermes G2 handover — 22 August 2026

## Repository state

`main` is the canonical development branch. The original release lineage and the
later Hermes/R1 integration lineage were created as unrelated Git histories;
they have now been joined by an explicit multi-parent consolidation commit.

Audit remediation PR [#28](https://github.com/not-benny/hermes-g2/pull/28)
merged by squash as `24f9525eea8ae120ba98ec756b21b92617eb3551` after the
`release-gate`, `codeql-javascript`, `codeql-java`, and `codeql` checks passed.
GitHub branch protection/rulesets remain unavailable because this repository is
private on a plan without that feature: both protection APIs return HTTP 403 with
"Upgrade to GitHub Pro or make this repository public". Do not make the
repository public merely to bypass this gate without an explicit owner decision.

The resulting tree uses the reviewed cleanup/integration line for application
code and tests, while retaining the original line's maintained public ring-health
documentation, G2 firmware-research archive, and development guide. Divergent PR
and startup-race branch heads are retained as merge ancestry without replacing
the newer implementations in the final tree.

Do not resume work from the old `hermes-g2`, `integration/`, `work/`, `wt/`,
`fix/`, or dated cleanup branches. Create new feature branches from `main`.

## Current verified implementation

The audit remediation delivered from canonical `main` baseline
`f37168cf007450cb2a58513b1f2624aee0b6d6af` adds permanent PR/main CI,
CodeQL, Dependabot, SBOM/provenance and APK checks; Keystore AES-GCM credential
storage with verified plaintext migration and explicit clear; discriminated
calendar failures; exact active-operation foreground-service types; remote
terminal TLS enforcement and launch revalidation; a positive R1 health-session
allowlist; archive hashes and pinned NDK/CMake/NativeScript; and release-safe log
sentinels. WhatsApp pairing/startup is disabled while its live-pair and 16 KiB
runtime gates remain open. See `docs/audit-remediation-2026-08-21.md` and
`docs/release-security.md`.

- Exact-GATT and generation ownership protect BLE connect, operation, timeout,
  disconnect, stale-callback, and replacement lifecycles.
- Display and R1 workers have separate bounded teardown ownership.
- Optional R1 connect/discovery/subscription/health work runs only on
  `FaceclawRingLink`. Blocking Android BLE calls execute outside the short R1
  lifecycle monitor under generation tokens, so connection-health reads stay
  responsive and retired work cannot publish into a replacement generation.
- Phone Controls exposes independent G2 and R1 state, a safe R1 failure class,
  monotonic retry countdown and explicit retry, plus saturating redacted
  reconnect/ACK/timeout/stale-work/lock-latency counters. The fixed-width health
  snapshot contains no identifier, UUID, payload, or exception text.
- The constructor-time disconnected-state race no longer tears down a live
  connection; the final implementation was verified on both G2 arms with the
  phone reporting Connected, frame delivery acknowledged, and wearer input
  consumed by the shell.
- R1 health supports battery, read-only firmware version, live/current-hour HR,
  hourly HR/SpO2/HRV, and confirmed 10-minute activity and calorie buckets.
- Daily vital timestamps are anchored only when timezone and local-midnight
  metadata validate; malformed and stale data fails closed.
- A best-effort one-shot R1 system-time write runs during health-session setup,
  before daily GETs and outside the recurring HR-only poll.
- The private-evaluation `glasses.render_view` implementation is owner,
  revision, operation-ID, TTL, rate, content, and compositor-receipt bounded.
  It never wakes or changes focus.
- External MCP calls require a live connection and exact originating turn (or an
  explicitly gated proactive call); cancellation reaches delayed side effects.

Current reliability-candidate verification uses deterministic Java harnesses:
the R1 state snapshot completes below 100 ms while synthetic BLE work is blocked,
retirement rejects that completion, and the display worker source contract has no
R1 connect call. The complete host suite passes 265/265, TypeScript typechecking
passes, and the JDK 21 / SDK 35 Android debug build passes. Two stale
source-contract expectations that required the old blocking monitor design were
replaced with generation-token and non-blocking-monitor assertions.

The first frozen adversarial review found and blocked two issues: a G2 arm loss
retired the R1 generation without retiring its ready flags/GATT, and diagnostics
counted initial attempts as reconnects while mixing packetAck writes into the G2
ACK population. The follow-up retires and disconnects the exact R1 lifecycle on
arm/transport loss, makes reset/disconnect health transitions explicit, counts
only replacement attempts as reconnects, labels the coherent G2 ACK population,
and preserves timeout/protocol failure classes without exposing exception text.

The debug APK installed/launched over USB on the authorised Samsung A32
`RFCR707RQGV`. PID-filtered runtime evidence (PID 27349) shows a live two-arm G2
session with render, heartbeat, settings, shutdown and warmup ACKs; the R1 then
connected independently, subscribed at MTU 247, completed the read-only session
open/device-info/health GET flow, delivered health notifications, and accepted a
generation-bound packetAck. The Controls page rendered normally on the phone.
No pairing, ownership, NVM, firmware/DFU, reset, wipe, permission, or Even-app
Bluetooth state was changed.

## Deliberately blocked

- Public MCP/skill publication and untrusted external `glasses.render_view`
- WhatsApp production pairing/startup and stock Node 16 KiB compatibility
- Stable signing and public-store release until signing custody and permission
  minimisation are approved
- G2 firmware flashing/recovery experiments until separately authorized
  sacrificial recovery evidence exists
- First-time R1 provisioning, pair/unpair ownership, and NVM mutation
- R1 firmware/DFU/OTA, recovery, reset, wipe, power, and destructive commands
- Sleep decoding until a CRC-valid type-1 stage-bearing frame and absolute
  time-base handoff are correlated to the matching ground truth
- Broad custom-firmware compatibility or recovery claims beyond one owner-unit
  boot report

## Private material

Health exports, Bluetooth captures, firmware binaries, detailed decode evidence,
credentials, MAC addresses, serials, private IPs, and consent records remain
outside the repository. Never copy them into commits, PR descriptions, CI logs,
or release artefacts.

## Build and validation

```bash
npm ci
npm test
npm run typecheck
npm run build
```

Use JDK 21 and Android SDK 35. For hardware validation, separate build, install,
launch, transport, display, wearer-input, and R1 evidence. Never infer an
unobserved hardware result from passing host tests.

## Next recommended work

1. Upgrade the private repository to a plan with branch protection/rulesets, or
   explicitly decide to make it public. Then require exact `release-gate` and
   `codeql` checks, one approving review, linear/squash history, conversation
   resolution, and blocked force-push/deletion; read the effective rules back
   through the API. Until then, treat direct `main` pushes as administratively
   prohibited even though GitHub cannot enforce that policy.
2. Validate the private bridge end to end with an authenticated `wss://` server,
   exact-turn envelopes, credentials, and a disposable generic client.
3. Complete the deferred non-destructive G2/R1/Doze/calendar/mic matrix when the
   live devices are available without contention; do not infer it from this APK.
4. Obtain the missing type-1 R1 sleep evidence only under a separately reviewed,
   reversible, private capture plan.
5. Keep firmware/recovery work blocked unless every independent provenance,
   authority, recovery, privacy, power, and per-run consent gate passes.