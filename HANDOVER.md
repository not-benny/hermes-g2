# Hermes G2 handover — 22 August 2026

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
smoke test passed. Host verification has 295 tests, TypeScript, Android build,
and APK verification passing. The exact 195,673,222-byte debug APK has SHA-256
`5b5838a238f68daa0af131ccad5a12d79f8079f9f0336225423fdcbae68e476c`.
Independent adversarial review of the final app code candidate and bridge commit
`fdd84de85c82706104428db3e7d0eacb91480b2a` returned static PASS and private,
non-destructive deployment GO. Exact APK/Fold7/G2/R1 runtime verification is
blocked by the currently unreachable Fold7 Teleport route. The preceding R1
session accepted battery GET writes but emitted no notify frames during the
observation window, so an actual battery percentage remains operationally
unproved until the exact candidate reconnects with exclusive R1 access.

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
was performed.

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