# Hermes G2 handover — 23 August 2026

## Canonical repository and release governance

`main` is the only canonical development branch. Current protected baseline is
`712cb644d9dd017158a6359ea494ec2ab6beb9b1` (`feat: add privacy-first
notification triage and digests (#47)`). Do not resume from historical
`hermes-g2`, `integration/`, `work/`, `wt/`, `fix/`, or dated cleanup branches.

Public visibility is Benny-authorized and required by the current GitHub plan.
On 23 August, GitHub API read-back verified `not-benny/hermes-g2` is public and
`main` requires strict `release-gate` and `codeql`, one approving review with
stale-review dismissal, conversation resolution, enforced admins and linear
history; force-push and deletion are disabled. The repository variable
`PROTECTED_RELEASE_ENABLED` is `true`.

Protected Release Validation run
[32604871016](https://github.com/not-benny/hermes-g2/actions/runs/32604871016)
completed successfully at exact main SHA `712cb644d9dd017158a6359ea494ec2ab6beb9b1`.
Its secret-free `main-build-validation` and source-free `protected-release`
signing jobs both passed. PR jobs still receive no protected signing credential
and cannot publish a release APK.

## Current outcome: dedicated read-only contextual dashboards

Branch `feat/contextual-g2-dashboards` supersedes the earlier HA-centric dynamic
mutation objective. Home Assistant and other external mutations are not part of
this release and remain a later separately authorized project.

The candidate adds a provider-neutral V2 contextual-dashboard boundary for the
dedicated authenticated `even-g2` Hermes profile:

- `ContextDashboardRuntime` sends an ACK-backed loading view before direct
  read-only gathering, normalizes failures, streams useful revisions, rejects
  every non-`even-g2` host identity and suppresses stale/replaced runs.
- The phone accepts contextual dashboards only from an exact MCP socket/turn;
  direct/default phone backends are rejected before display.
- Dashboard, presentation, refresh and CAS revision identities are independent.
  A later exact turn can refresh a current presentation without inheriting the
  old turn's authority.
- The V2 schema is read-only and bounded to 16 KiB, 8 KiB retained text, four
  typed sections, 20 records, three sources and three fixed local actions.
  Host projection and phone execution reject unknown fields, bad source links,
  executable/URL/markup/control text, arbitrary action kinds and malformed data.
- Summary, source age/state and uncertainty are structured. The phone computes
  displayed age and stale state from its own clock.
- Ring actions are phone-local refresh, pin/unpin, section and follow-up only.
  Queue-head events carry bounded original intent, not remote action handles or
  historical tool responses. Long-press opens assistant voice with bounded
  intent/focused-item context; double-click remains shell-owned close.
- Up to five `public`/`private` pins are encrypted through the existing Android
  Keystore setting boundary. Records contain only key/title/privacy, bounded
  intent and refresh policy. Rendered values, source rows, raw responses,
  credentials, provider IDs, exceptions, receipts and announcements are absent.
- The permanent Liverpool Lime Street projector keeps all destinations,
  excludes already-departed rows, preserves cancellations, applies explicit
  expected-time fallback and deterministic ordering, and emits a one-line first
  useful announcement.

The maintained contract, integration guide, downgrade behavior and exact
remaining gates are in `docs/dynamic-glasses-apps.md`; the current security model
is in `notes/dynamic-glasses-app-threat-model-2026-08-22.md`.

## Current candidate verification

Baseline for the candidate is exact `origin/main@712cb644d9dd017158a6359ea494ec2ab6beb9b1`.
After a clean `npm ci` using the locked dependency graph:

- focused contextual-dashboard tests pass 15/15;
- full host suite passes 359/359;
- TypeScript `tsc --noEmit` passes;
- `git diff --check` passes;
- added-line credential/private-key/bearer scan has zero matches; and
- the JDK 21 / Android SDK 35 debug build passes.

The resulting debug APK is 195,505,702 bytes with SHA-256
`61ff6f7e90ad6d3483c16b7efd7fac4803b2532ea7b346745a886346991db8f9`.
At verification time `adb devices -l` returned no attached device, so this exact
APK was not installed or launched and there is no exact-candidate A32/G2 lens,
latency, scroll, refresh, pin/reopen, contextual-voice, reconnect or optical
evidence. Do not infer any of those from host tests or build success.

The first frozen adversarial review correctly blocked profile/pin authorization,
pending-delivery resurrection, stale-turn publication, shared-surface ownership,
event acknowledgement, replay receipts, cancellation/deadlines, operation-ID
bounds, inherited-object validation, receipt bounds, scrolling, pin reopen,
uncertainty/focus and automatic train routing. Those findings are fixed with
permanent regressions. Repeated frozen re-review closed follow-up profile-claim,
pending close, crash replay, end-to-end deadline, station-timezone, focus/action,
operation-identity and cancellation races. Final frozen SHA
`d4925fe319b46a849232fc60cccf68accf996890` received static PASS, including a
successful adversarial cancellation-during-projection probe. PR/CI/remote
read-back remain required. Operational authorization remains NO-GO because the
deployment-local gateway/rail reader and exact-candidate A32/G2 evidence are
absent.
Public MCP/skill publication remains NO-GO.

## Safety and private data

Never commit credentials, device identifiers, private IPs, health exports,
Bluetooth captures, proprietary firmware binaries, pulled Android settings,
completed consent records, or anything from `ground-truth-private/`.

This contextual feature does not authorize firmware/DFU/OTA, pairing/ownership,
provisioning/NVM, reset/wipe, destructive BLE, smart-home mutation, arbitrary
remote rendering, generic shell execution, or unrelated terminal access.
Static review is not hardware or operational authorization.

## Remaining exact blockers and evidence gaps

1. **Contextual dashboard:** attach the authorized A32/G2 and deploy the final
   reviewed SHA through the authenticated `even-g2` bridge. Prove loading ACK
   under one second, first useful or honest terminal state under five seconds,
   the Liverpool all-destination board, scroll/focus, local refresh, pin/reopen,
   contextual voice, double-click close, reconnect/process restart, and
   sentinel-clean host/phone/logcat/storage. Obtain wearer/optical evidence when
   per-lens applied acknowledgement is unavailable.
2. **Public MCP/skill:** remains blocked until authenticated generic-client
   interoperability, credential/retry behavior, licensing and the real-G2 proof
   above pass. No public skill is part of this candidate.
3. **Renderer performance:** the prior candidate proved all-message application
   ACK semantics but measured a connected hardware floor around 371–374 ms; a
   fixed-duration post-change percentile run was contaminated by another A32
   installer. The below-10% jank / p99-under-50-ms target is not proven.
4. **Fold7 preview:** install/process and two-arm session readiness passed, but
   unlocked phone visuals, physical fold transitions, rotation, tabletop and
   multi-window remain unproven; R1 HUD visibility was not observed in that run.
5. **Motion calibration:** source/build and bounded off-head/resting transport
   evidence pass, but exact-candidate worn/moving local calibration completion,
   heading quality and meaningful battery delta remain open.
6. **Notification triage:** aggregate-only synthetic A32 listener transitions
   passed; real-G2 digest rendering remains unverified.
7. **R1 sleep:** decoding remains fail-closed until a CRC-valid type-1
   stage-bearing frame and matching absolute time-base/ground truth exist.
8. **Firmware and ownership:** G2 recovery assurance, R1 provisioning/ownership,
   R1 firmware/DFU/OTA, reset, wipe, pair-delete, host rebinding, NVM and power
   control remain blocked without separate authority and recovery evidence.

## Build and validation

Use the locked dependencies, JDK 21 and Android SDK 35:

```bash
npm ci
npm test
npm run typecheck
ANDROID_HOME="$HOME/Android/Sdk" \
JAVA_HOME=/usr/lib/jvm/java-21-openjdk \
npm run build
git diff --check
```

For hardware work, report build, install, launch, bridge, transport ACK, wearer
input and optical/lens evidence separately. Never infer an unobserved layer.
