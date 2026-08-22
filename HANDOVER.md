# Hermes G2 handover — 22 August 2026

## Repository state

`main` is the canonical development branch. The original release lineage and the
later Hermes/R1 integration lineage were created as unrelated Git histories;
they have now been joined by an explicit multi-parent consolidation commit.

Audit remediation PR [#28](https://github.com/not-benny/hermes-g2/pull/28)
merged by squash as `24f9525eea8ae120ba98ec756b21b92617eb3551` after the
`release-gate`, `codeql-javascript`, `codeql-java`, and `codeql` checks passed.
The owner subsequently reported upgrading to GitHub Pro, but GitHub still
returned HTTP 403 from the private-repository branch-protection PUT at 03:50 UTC
on 22 August. Do not make the repository public merely to bypass this pending
entitlement-propagation gate.

Release-governance PR [#40](https://github.com/not-benny/hermes-g2/pull/40)
merged by squash as `486a8b9f76e228ab70e19e25c4820985f47ce72f`.
It removes every signing secret and APK upload from pull-request CI. PR and
`main` builds use an isolated ephemeral debug identity; only a separate post-build
`protected-release` job receives credentials,
and that job downloads a content-addressed input without checking out or running
repository source. The signing job remains disabled by the absent
`PROTECTED_RELEASE_ENABLED` variable until `main` protection is verified.
Vulnerability alerts and automated security fixes are enabled.
Incompatible Dependabot majors #29, #31, and #33-#35 were closed with rationale;
#30, #32, and #36-#39 were rebased onto the safe CI path and remain separate
dependency decisions. Enabled scanning now reports no critical/high alert on
`main`; three GitHub medium alerts / 28 npm moderate development-tool findings
remain documented.

The resulting tree uses the reviewed cleanup/integration line for application
code and tests, while retaining the original line's maintained public ring-health
documentation, G2 firmware-research archive, and development guide. Divergent PR
and startup-race branch heads are retained as merge ancestry without replacing
the newer implementations in the final tree.

Do not resume work from the old `hermes-g2`, `integration/`, `work/`, `wt/`,
`fix/`, or dated cleanup branches. Create new feature branches from `main`.

## Current verified implementation

### Shared G2 motion service candidate (22 August 2026)

Branch `feat/imu-compass-service` replaces app-owned IMU/compass controls with
one process-wide lease service. It aggregates low/interactive IMU demand and
compass demand, binds callbacks to the exact communicator/session generation,
coalesces queued native controls, snapshots Java listeners before main-thread
delivery, rejects stale/non-finite/wrong-source samples, and disables both
streams synchronously with screen-off or final release. The first warmed frame
reasserts retained demand because native connectivity becomes visible before
the EvenHub session accepts IMU control. Compass and accelerometer UI values
expire after three seconds; unchanged freshness polls no longer repaint.

Pure calibration/filter state handles circular wraparound, discontinuity-based
possible-interference detection, bounded gravity orientation, level/posture
derivation, and versioned opaque-device-bound persistence. A secret
install-local salt pseudonymises the arm identity before ordinary persistence.
Persistence contains only a neutral vector, zero boresight offset,
schema/algorithm versions, timestamp and
quality; it stores no raw motion history. Uncalibrated posture remains
`unknown`, and the compass labels non-good values approximate rather than exact.
The supplied upstream hash `6e4ece5` is album-art work, not compass work; the
relevant ancestor `12bb76b` was reviewed for ideas but its unversioned scalar
offset, stale-reading and false-completion behavior was not copied.

Independent review of the first frozen candidate found and the final source fixes
IMU shutdown/retry, exact native-generation delivery, connect-failure retirement,
calibration-start provenance, sustained-turn reacquisition, timestamp/offset
validation, verified-save ordering, raw-address persistence, and misleading
wearer-alignment labels. A final review pass also closed overlapping-connect
publication/retirement and rejected legacy persisted `good` quality. Firmware
completion can now establish at most `fair` sensor/neutral quality; without
wearer alignment the UI remains approximate.

A follow-up blocker was reproduced on the authorised worn/moving A32/G2 run:
the exact installed APK SHA-256
`9ecd9e6128ebaae49fb133135a69c5a4fa7deaf3121fcd3e661e7a3e9bc77e21`
rendered `188° S`, live level, and 54 accepted samples, but remained
`uncalibrated` because the firmware emitted headings without calibration
start/complete events. The branch now adds an explicit phone-side Compass click
action that collects for at most 30 seconds, requires 24 filtered headings over
six 45-degree sectors plus eight level-neutral IMU samples, and can be cancelled.
It sends no new BLE command. Verified local completion persists only the existing
compact summary at `poor`; only a matched firmware start/complete can reach
`fair`, and neither path claims boresight alignment or exact heading. Firmware
start safely supersedes local collection, while timeout, stale callbacks,
session replacement, screen-off, and restart cannot persist partial data. See
`docs/g2-local-motion-calibration.md`.

Acceptance for this follow-up is source/build complete only when focused and full
host tests, TypeScript, the 576×288 Compass viewport test, and the JDK 21 Android
build pass at the pushed SHA. Hardware validation remains pending: no device is
touched by this follow-up task, so the new start/progress/cancel/success UI and
persisted `poor` restart state must still be exercised with the exact candidate
on the authorised worn G2 before the operational gate is closed.

Final independent adversarial review passed the source at
`4624c5f7a874cc748e65918dde630e4445aed304`. Static review is **PASS**; operational
authorization remains **NO-GO** only for the missing worn/moving heading and
calibration evidence described below.

Final local verification passes 303/303 host tests, TypeScript typechecking,
`git diff --check`, and the JDK 21 / Android SDK 35 debug build. On USB Samsung
A32 with both G2 arms live on firmware 2.2.8.4, a cold process restart first
logged the expected pre-ready IMU skip, then the warmed-session reassertion
queued IMU pace 500 plus compass enable and both controls ACKed. The phone/G2
UI accepted eight motion samples in the bounded capture and truthfully rendered
`Cal: uncalibrated ... samples: 8`; the stock compass emitted no heading or
calibration-complete event while the glasses were off-head/resting, so no
heading, posture-calibration, or exact-level hardware claim is made. The final
review-fixed APK cold-started with both controls deferred before readiness,
reasserted/ACKed both after warmup, then screen-off queued IMU and compass disable
at 06:10:10 local and both ACKed within 185 ms. Native shutdown now also forces
an IMU disable ahead of queue flush and fails the transport closed on disable
timeout. The final UI transition settled without the previous 400 ms repaint
stream.
Across the USB-powered bounded run the phone stayed at 100% with charge counter
2,946,000 µAh, so short-run battery delta was below device reporting resolution;
this is traffic/lifecycle evidence, not a battery-life estimate. Screenshot
evidence is local at `/tmp/hermes-compass-final-live.png` and contains no private
content. No pairing, permission, coordinate/device-setting, firmware,
provisioning, reset, wipe, credential, or destructive action was performed.

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

The dynamic-glasses-app candidate is based directly on canonical `main`
`f02d8f88bb44e147dad213e36a2ab16ad304aebe`. It adds a versioned generic
`glasses.dynamic_apps.*` lifecycle with exact socket/turn ownership, stable view
and component IDs, CAS full/patch updates, TTL/close/cancellation tombstones,
acknowledged input cursors, bounded rich components, deterministic scrolling and
focus, and success only for a current `sent` frame completion. Hermes-hosted
provider code keeps credentials and provider IDs off the phone. The Home
Assistant reference adapter discovers the actual Living Room membership at
runtime, permits only available lights/switches, uses fresh opaque handles and
explicit revision-checked target states, verifies the result, and restores only
when no later human/automation revision intervened. See
`docs/dynamic-glasses-apps.md` and
`notes/dynamic-glasses-app-threat-model-2026-08-22.md`.

The final local source candidate passes all 281 host tests, TypeScript
typechecking, `git diff --check`, and the JDK 21 / Android SDK 35 build. Its
195,407,092-byte debug APK has SHA-256
`d6083a30344db8f03b16b38228da81622cd2effdb4f88256ed16a9ea4b0d87a7`.
That exact APK upgrade-installed and launched on the authorised Samsung A32 over
USB. Both G2 arms reached session-ready on firmware 2.2.8.4, wear state was
not re-proven in this final install, and ordinary shell frames 11, 12, and 13
completed with transport outcome `sent`. The PID-filtered final log
contained no fatal/TypeScript/dynamic
app errors and no token/password/API-key/HA sentinel pattern. No private log was
retained in the repository.

Independent adversarial review iterated over frozen candidates until final
source SHA `08020fc890bc6cb771cd8a75c9a2de23de4b9584` received static PASS. The
review re-probed close/update races, pending create cleanup, exact ACK identity,
event ordering, physical disconnect, concurrent provider operations, stale area
scope, outcome-unknown replay, restoration causality, and cross-owner replay.
Operational authorization remains NO-GO for the missing external/runtime evidence
listed below; static approval is not permission to publish or operate HA control.

PR [#41](https://github.com/not-benny/hermes-g2/pull/41) passed the permanent
`release-gate`, `codeql-javascript`, `codeql-java`, and aggregate `codeql`
checks, then squash-merged to canonical `main` as
`544a5d60176f64ea6cdda8271894a95a32a00c7b`.

This is not Home Assistant or dynamic-view lens evidence: the environment had
no HA URL/token, and the configured bridge peer is not the authenticated Hermes
WSS/generic MCP peer required to invoke the new tools. Therefore no living-room
render, scroll, toggle, restoration, per-lens applied ACK, or optical visibility
claim is made. The private read-only/default and explicitly gated reversible
harness is runnable at `hermes-host/private-evaluation.mjs`; the exact missing
peer contract and remaining gates are documented in the developer guide.

Local candidate verification passed the complete 259-test host suite after the
two stale branding expectations were updated for the now-lockfile-pinned CLI,
TypeScript, JDK 21 / SDK 35 / NDK 27.2.12479018 / CMake 3.22.1 Android build,
ZIP integrity, private-content/path scan, ZIP 16 KiB alignment, and APK-wide ELF
LOAD alignment. The disabled WhatsApp/Node runtime is excluded. The arm64-only
debug APK is 194,871,195 bytes, versionCode 1000001 / versionName
1.0.0-preview.1, and its
final SHA-256 is
`03a82652986aff42ba70619eb87e28430fdce7fd55d1fbe6a384a54c5d9b8347`.

The integrated release-governance follow-up passes 283 host tests, TypeScript,
the root high-severity and WhatsApp runtime audits, workflow `actionlint`, diff
hygiene, and a clean isolated JDK 21 / SDK 35 Android build. Patched lockfile
overrides, including a loopback-tested ws 8 compatibility exception, reduce the
root audit from 2 critical / 7 high / 28 moderate to 28 development-only moderate
findings.
The CI high-severity gate passes, and the incompatible residual Jimp,
uuid, and yauzl tool paths remain documented rather than force-downgraded. The
untrusted-validation APK is 195,396,948 bytes with
SHA-256 `57118899cd7232229886a0181ca256b324655e9e5d35522a4f13f899bd5f7ddf`;
the verifier proves it does not carry the protected certificate. This APK is test
evidence only and is not a release/install artifact.

PR #40's final `release-gate`, `codeql-javascript`, `codeql-java`, and aggregate
`codeql` checks passed at head `abc39655a28d51994806e95a1db4bfc4631301be`.
On merged `main`, Protected Release Validation run `32549342872` and CodeQL run
`32549342876` passed at `486a8b9f76e228ab70e19e25c4820985f47ce72f`.
The source-free `protected-release` job was correctly skipped because protection
is not yet enforceable; no protected APK was produced or published.

On the authorised Samsung A32, the existing and candidate APK certificates
matched. Upgrade install, launch and resumed activity passed; package metadata
reported the new version. The Settings UI showed WhatsApp disabled, replace-only
secret fields, and explicit clear actions without displaying values. The bridge
token migrated to the encrypted preferences file and was absent from ordinary
`faceclaw_settings`. A 222-line PID-filtered log review found zero configured
secret/pairing/content sentinels. Both G2 arms reached live GATT activity, but the
session remained in reconnect attempts, so no new render/wearer, Doze, charging,
phone-mic, calendar, or R1-value evidence is claimed. No gated dialog or
destructive/pairing/firmware operation was performed.

## Deliberately blocked

- Public MCP/skill publication and untrusted external `glasses.render_view`
- Public dynamic-app publication and production HA control until authenticated
  WSS identity, durable cross-process idempotency, generic-client compatibility,
  private credential custody, licensing, and real dynamic-view G2 evidence pass
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

1. After GitHub Pro entitlement propagates, require exact `release-gate` and
   `codeql` PR checks, one approving review, linear/squash history, conversation
   resolution, and blocked force-push/deletion; read the effective rules back
   through the API. Until then, treat direct `main` pushes as administratively
   prohibited even though GitHub cannot enforce that policy.
2. Supply an authenticated private Hermes WSS/generic MCP peer and private HA
   credentials, then run the documented living-room harness end to end: render,
   scroll, exact safe reversible state change, verified update, restore, and
   sentinel-clean log review. Do not publish or broaden authority.
3. Validate the remaining private bridge lifecycle with certificate failure,
   cancellation, reconnect, stale-turn rejection, durable mutation replay, and
   a disposable generic client.
4. Complete the deferred non-destructive G2/R1/Doze/calendar/mic matrix when the
   live devices are available without contention; do not infer it from this APK.
5. Obtain the missing type-1 R1 sleep evidence only under a separately reviewed,
   reversible, private capture plan.
6. Keep firmware/recovery work blocked unless every independent provenance,
   authority, recovery, privacy, power, and per-run consent gate passes.