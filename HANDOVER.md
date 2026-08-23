# Hermes G2 handover — 22 August 2026

## Accessibility-first live captions candidate — 23 August 2026

Branch `feat/live-captions-translation` from canonical `main@712cb644` evolves
Transcribe into a volatile, accessibility-first Captions window. It has literal
on-lens starting/live/paused/stopped/mic/network/provider/translation/drop
states; grapheme-safe bounded wrapping; bottom anchoring and history; click
pause/resume; long-press clear; and bounded phone settings for language,
source/split/translation layout, font, spacing, maximum lines, evidence-only
speaker labels and custom vocabulary. Unsupported vocabulary remains local and
is not sent. Source captions remain available without translation or a
translation credential, and no transcript is written to Downloads.

Capture is foreground- and screen-owned. Permission continuations, exact Java
listener callbacks, cloud clients, PCM, provider changes, stop and close carry
monotonic generations; stale work cannot publish. Soniox one-way translation
uses documented original/translation tokens and documented speaker IDs, bounds
pre-connect audio at 50 chunks, reconnects with bounded exponential backoff,
and reports aggregate drops without content. Credentials stay in the existing
Keystore-backed replace-only settings and never enter glasses payloads or logs.
See `docs/live-captions.md` and `PRIVACY`.

Verification on the current source: focused caption/provider/phone/security
tests pass 25/25; the full host suite passes 357/357; TypeScript passes; and the
JDK 21 / Android SDK 35 debug build and release-artifact verifier pass. The
exact 195,740,952-byte debug APK at
`platforms/android/app/build/outputs/apk/debug/app-debug.apk` has SHA-256
`491e8f53cd24754aeeae4427ed6d8209dc3b3e1250549c64694d70ae2eda9979`.
The authorised Samsung A32 later appeared over its existing wireless ADB pairing.
The exact APK upgrade-installed and launched with version 1000002 /
1.0.0-preview.2 and a live process. PID-filtered launch logs contained no fatal,
JavaScript, credential or transcript-content marker. The G2 transport repeatedly
failed before session readiness, so no caption frame, optical readability,
fixture, disconnect or stop/clear result is claimed. Android app-ops reported
microphone `ignore`; no permission dialog was accepted and no live-mic test ran.
No pairing, firmware, provisioning, reset, wipe, power, NVM or destructive
command was attempted. A serialized ready-G2 window and separately approved
visible microphone permission remain the next gates; do not infer hardware
success from install, process or build evidence.

The first independent frozen-candidate review blocked provider/PTT sharing,
unmatched release, non-transactional startup, unbounded non-Soniox queues,
Soniox send/reconnect identity, cumulative-stream truncation, stale provider
disclosure, translation lag/source fallback, repeated-partial speaker labels,
and status/footer overflow. The follow-up makes capture single-owner and
transactional, bounds every cloud queue, defers live provider/language setting
changes until the next lifecycle-owned capture, emits incremental final token
deltas, measures matching-revision lag, falls back to current source, derives
partial labels without mutating committed state, truncates fixed chrome, and
adds executable mock-Soniox fixtures.

Later re-review also found and the current source closes failed Soniox
end-of-audio retry, stale generation rollback in the lens layer, missing
assistant-follow-up preemption, stale live translation after a newer source
revision, and Soniox final-token loss in ordinary assistant/voice input. The
last fix introduces one provider-neutral transcript accumulator shared by voice
input and an executable final-delta/stream-finish regression. Independent
adversarial re-review of exact source commit
`95f96abb181423a7eec21cd4837f5428312ffe80` returned **PASS** after additionally
binding the caption layer to the exact successful continuous-capture lease so
late or concurrent assistant generations cannot be adopted. Operational
hardware authorization remains NO-GO until the
G2 reaches session readiness and the documented approved checks run.

PR [#63](https://github.com/not-benny/hermes-g2/pull/63) is open from
`feat/live-captions-translation` to `main`. At reviewed code head
`95f96abb181423a7eec21cd4837f5428312ffe80`,
`release-gate`, `codeql-javascript`, `codeql-java`, and aggregate `codeql` all
passed. The PR is intentionally unmerged because the required serialized A32/G2
fixture, visible live-mic, stop/clear/background, disconnect, optical
readability, and caption/session-specific privacy-safe logcat evidence remains
unavailable. Merge only
after that exact-candidate hardware gate passes; do not treat green CI as device
evidence.

## Gesture, HUD, R1 battery, and Hermes bridge follow-up

Work on stacked branch `feat/gesture-signal-ring` adds sleeping R1 long-press
push-to-talk for the assistant, an explicit quick-close instruction bar, bounded
phone cellular-signal bars, and a persistent configured-R1 HUD identity that
shows `--` until a battery value is known. R1 `deviceStatus` battery is requested
before rich history traffic, and either standard-GATT or protocol battery values
feed the same Health/HUD store. The existing generation, command allowlist,
pairing/provisioning, firmware, and destructive-operation gates are unchanged.

The Hermes `even-g2` gateway bridge now serves certificate-validated WSS on its
dedicated private-tunnel endpoint. The app migrates the exact legacy default
port 8790 to the WSS deployment on 8791 while preserving custom ports. The app
bundles only the private CA public certificate; the CA/server private keys remain
deployment-local and outside the repository. The custom bridge protocol,
bearer-token authentication, exact-turn guards, and proactive-action gates are
unchanged. A real WSS hello/hello-ack
smoke test passed. Host verification has 302 tests, TypeScript, Android build,
and APK verification passing. The exact 195,708,625-byte debug APK has SHA-256
`05752f99271eec1e29c58779a11e3167bd2111c62e80883b7ad589d3eb2951d4`.
Independent adversarial review of the final app code candidate and bridge commit
`fdd84de85c82706104428db3e7d0eacb91480b2a` returned static PASS and private,
non-destructive deployment GO. The exact APK upgrade-installed and launched on
the authorised Fold7 with the expected version and a live process; no fatal,
JavaScript, or TLS/certificate failure marker appeared. The exact legacy bridge
port migrated to 8791, and the live Hermes gateway authenticated `hermes-g2` and
listed 33 phone MCP tools. After both G2 arms were physically recycled, the exact
candidate reached `session ready`; direct R1 BLE reached ready at MTU 247 with
both notify channels active and emitted live data notifications. The duplicate
bridge reconnect loop was traced to the A32 running the same identity; the A32
was restored enabled with its assistant backend set to direct, leaving the Fold7
as the single stable bridge owner. The ring lacks the standard battery service,
and repeated protocol `deviceStatus` GET writes still produced no decoded
battery value initially; it arrived after the ready session and the wearer
confirmed the same percentage in both HUD and Health. The wearer also confirmed
sleep long-press opens voice capture, phone signal bars are visible, and the
quick-close guidance is clear. The wearer then verified the selected Health tab
says `HIDE HEALTH / tap hide` and hides on tap rather than implying the pinned
tab can be closed; the launcher is explicitly labelled pinned.

## Fold7 development-preview candidate

Work on `feat/fold7-compat` from canonical baseline
`c4e512509d30a587f511896b87415b8d29f7b4f8` adds a pure live-window size-class
contract and Fold7-like cover/unfolded/landscape/tabletop/split fixtures, removes
the portrait lock, marks the activity resizable with IME resize, replaces
physical-screen calculations with page bounds, bounds phone content at 840dp,
and enforces 48dp controls. It does not touch G2/R1 pairing, permissions,
firmware, BLE ownership, or glasses compositor geometry. Focused tests were RED
on the baseline and are GREEN after implementation. The candidate is version
1000002 / 1.0.0-preview.2. Final lifecycle hardening coalesces live-resize
callbacks, cancels queued callbacks on unload, ignores unchanged bounds, and
releases each main-page dashboard subscription. The focused 8-test contract and
full 291-test suite pass. The final 195,664,501-byte debug APK built from
`444e4032b3d630962047f6d3a2ef4e472164bff0` has SHA-256
`1d61d96548ed721c5c84ec36b738e92435bada0179d9c4eba03a9145b678f067`.
The immediate predecessor (`d26f01795863b6f4ab1fe0f6e7e3966a818e7b19c7f9c0a96bd57676e2a022f8`)
reproduced a launch crash when NativeScript reported a transient 0×0 page during
fragment construction. A focused regression was observed RED, the strict
classifier gained a non-throwing deferred-layout wrapper, and the focused/full
suites returned GREEN. The exact final APK then upgrade-installed and launched
on an authorised Galaxy Z Fold7 SM-F966B (`q7q`), Android 16 / SDK 36. Package
metadata reported the expected version, the process remained live, and the
PID-filtered post-launch log contained no `FATAL EXCEPTION`, zero-size-bounds,
or `onCreateView` failure marker. The phone was locked/Dozing, so there is no
unlocked Hermes-phone visual, physical fold-posture transition, rotation,
tabletop, or multi-window evidence; none may be inferred from install/process
proof. After Bluetooth was enabled, the app connected both G2
arms and logged `session ready`; the direct R1 BLE session also connected. Benny
observed that the ring was not shown on the glasses HUD, so no R1-HUD success is
claimed. No pairing, provisioning, permission, firmware, wake, or unlock action
was performed. After merging canonical `main` at
`18f99767bd6336e0fc5106d5cf4342ff2bae4ba5`, the combined tree passes 298 host
tests, TypeScript, diff hygiene and the JDK 21 / SDK 35 Android build. Its exact
195,701,531-byte debug APK has SHA-256
`d04fc94fa07281a414241d904bcc99309e3bd77b49f71d46b47d5719fe77116e`.

## Renderer-jank candidate

The `perf/glasses-renderer-jank` candidate starts from canonical `main` at
`f02d8f88bb44e147dad213e36a2ab16ad304aebe`. It adds a non-destructive,
privacy-allowlisted 60-second USB A32 benchmark (`scripts/run-render-benchmark.sh`)
that records phone framestats, PSS, GC lines, and the existing per-frame paint,
fingerprint, bitmap snapshot/bridge, composite, 4-bpp pack, compression/plan,
Bluetooth-send, and application-ACK landmarks. It auto-discovers USB and does
not publish device identifiers, pair/reconnect, clear data, toggle Bluetooth,
or send a new device command.

The measured fixes are deliberately small: ordinary shell render bursts now
coalesce to one follow-up while strict alert deliveries keep separate receipts;
idle frame submission avoids an approximately 18 ms timer hop; typed-array
snapshot copying uses the native `slice` path; an already queued image blocks a
redundant heartbeat; and repetitive successful frame, GATT-write, image-plan,
enqueue, and ACK logs are removed from release hot paths. The scheduling/copy
changes are provenance-compatible ports of isolated Faceclaw commit
`f6035ea9ecdabd13cc85af1e26ef518ae64d3d6b`; no texture-cache firmware modes or
device commands were ported.

Delivery semantics are stronger, not weaker: strict operations accept only
ACK-backed `sent` outcomes and reject queued-image deduplication, missing, or
failed receipts; only the first communicator terminal frame result reaches TypeScript; and
multi-message images report `sent` only after every distinct application ACK,
including out-of-order ACKs. Ordinary redraw work cannot inherit or extend a
strict owner's receipt, and the inline Java-call fast path remains busy across
synchronous reentrancy. Focused RED/GREEN contracts pass 7/7 and the full
host suite passes 266/266. TypeScript and the JDK 21 / SDK 35 Android build pass.
Independent adversarial review of frozen `c8fa3b1` passed all static receipt,
queue, timeout, and coalescing gates; operational performance authorization
remains NO-GO because the fixed-duration candidate run was contaminated and the
371–374 ms hardware floor exceeds the 50 ms target.
The final debug APK SHA-256 is
`98c87fa58d96f8386a526759807adb5c92337e64668a979d8ce3f6edbec41425`.

The frozen preview.1 idle observation reproduced the reported phone-jank floor:
33/45 frames janky (73.333%), p90 20.498 ms, p99/max 24.643 ms, PSS
245217→244282 KiB. A later candidate idle interval produced no phone frames and
therefore no valid jank percentile; PSS fell 276480→180944 KiB rather than
growing. The candidate APK was installed and launched on the USB Samsung A32.
A real two-message G2 image reached application ACKs and only then completed its
receipt (`frame#10`, 4353 ms including initial connect/warm-up), proving the
all-ACK path on hardware. Its measured stages were paint 7 ms, fingerprint
0 ms, 8-bpp copy 0 ms, bridge snapshot 1 ms, Java submit 10 ms, composite 5 ms,
4-bpp pack 1 ms, compression/plan 249 ms, first Bluetooth write at 4191 ms,
last write at 4221 ms, and final application ACK at 4353 ms. Later connected
frames completed in 374 ms and 371 ms; this is an honest hardware/radio floor,
not a claim that the requested 50 ms end-to-end threshold was met.
The fixed-duration post-change run was contaminated by
another concurrent A32 installer replacing the package, so it is not used to
claim the below-10% / p99-under-50-ms target. The remaining measured floor is
startup/radio/compression work, not phone paint, snapshot, composite, or pack.
No firmware, DFU, OTA, pairing, provisioning, reset, wipe,
power, or NVM operation was performed.

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

### Notification triage candidate (22 August 2026)

Branch `feat/notification-priority-digests` now includes canonical
`main@5b6947c78c7d89fd881ddcc7a76cb97803079fe5` after PRs #46 and #49
merged. It adds a local-only pure
notification reducer with sender/channel/category/app/default precedence;
urgent/immediate/digest/mute routing; quiet hours; deduplication, cooldown and
global/per-app caps; fair bounded digest selection; same-key replacement; Android
removal; dismiss/clear tombstones; and restart/wall/timezone protections. Existing
all-installed-app names and allow/block toggles remain; each app also has a priority
cycle and reset. Immediate and digest glasses views explain why an item was routed.

Observed notification content, Android keys, senders and app/channel identity remain
volatile; explicitly user-authored rule selectors are normalized bounded local
configuration. Only bounded aggregate runtime queue metadata is persisted; restart never wakes
for the existing active set. Android removal prunes Hermes state. The production
external icon-debug dump and package/icon detail logging were removed. Detailed
behavior and rollback are in `docs/notification-triage.md`.

Current evidence: focused notification policy/integration tests pass 8/8; the final
post-integration host suite passes 344/344; TypeScript typecheck and the JDK 21 /
SDK 35 Android build pass. The earlier MessagingStyle compatibility fix uses the
public recovered-builder API. Seven adversarial review passes drove API-24,
privacy bounds, queued deduplication, revision/tombstone identity, delivery receipt,
scheduler lifetime, modal cleanup, input-index and concurrent-presentation fixes;
the final staged-diff verdict has no security or logic blockers. The candidate APK
installed and launched on a Samsung A32 over USB; notification access remained granted and only reversible
synthetic `com.android.shell` notifications were used. The final APK produced the
expected aggregate-only transitions: a new synthetic post was accepted with no
queued item, a same-key synthetic update moved one revision into the digest queue,
and Android snooze/removal returned the queue to zero while decreasing the active
count. The user’s Selected-app filter was temporarily changed to All from a
force-stopped private-settings backup, then restored byte-for-byte to Selected;
synthetic items were snoozed and temporary files removed. This verifies the A32
listener → NativeScript → policy → bounded-metadata post/update/removal path. Real-G2
digest rendering was unavailable and remains unverified. No personal notification
content was read or logged; no pairing, firmware, provisioning, reset, wipe, or
destructive command ran.

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
R1 connect call. After merging canonical `main` through
`76adcd5e443a9ee9295a3683f1f8a149be669d7a`, the complete host suite passes
290/290, TypeScript typechecking passes, and the JDK 21 / SDK 35 Android debug
build passes. Two stale source-contract expectations that required the old
blocking monitor design were replaced with generation-token and
non-blocking-monitor assertions.

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

The first frozen adversarial review found and blocked two issues: a G2 arm loss
retired the R1 generation without retiring its ready flags/GATT, and diagnostics
counted initial attempts as reconnects while mixing packetAck writes into the G2
ACK population. The follow-up retires and disconnects the exact R1 lifecycle on
arm/transport loss, makes reset/disconnect health transitions explicit, counts
only replacement attempts as reconnects, labels the coherent G2 ACK population,
and preserves timeout/protocol failure classes without exposing exception text.
The second review found three remaining diagnostic reset inconsistencies; organic
R1 disconnect now publishes a bounded transport backoff, no-address arm/transport
loss remains `not-configured`, and idle/not-configured resets clear stale failure
and countdown fields.
The third review found one final callback-order race; R1 connect publication now
captures and revalidates the pre-connect R1 generation, while a delayed connected
callback preserves already-published notification readiness. A disconnect racing
setup therefore cancels publication instead of resurrecting a retired session.
Final independent adversarial review passed frozen reliability source commit
`16881e50b39d37d21b8952cb35201b9807ada327`. Operational GO is limited to
non-destructive app delivery; every pairing, firmware, reset, wipe, provisioning,
NVM, power-control, and ownership gate remains NO-GO. Canonical `main` at
`f02d8f88bb44e147dad213e36a2ab16ad304aebe` was then merged without rebasing;
the only manual conflict was this handover, and the post-merge
288-test/typecheck/build matrix passed.

The debug APK installed/launched over USB on the authorised Samsung A32
`RFCR707RQGV`. PID-filtered runtime evidence (PID 27349) shows a live two-arm G2
session with render, heartbeat, settings, shutdown and warmup ACKs; the R1 then
connected independently, subscribed at MTU 247, completed the read-only session
open/device-info/health GET flow, delivered health notifications, and accepted a
generation-bound packetAck. The Controls page rendered normally on the phone.
No pairing, ownership, NVM, firmware/DFU, reset, wipe, permission, or Even-app
Bluetooth state was changed.

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