# Hermes G2 handover — 23 August 2026

## Ultra completion candidate

This candidate starts from exact protected `origin/main`
`38c9ce1623aea4bfa0ac6d5eb556b23186e66d21`, where PR #60 is already merged,
and consolidates every remaining open repository item without reviving stale
branches:

- issue #66's timestamped, exact-R1 battery persistence and ACK-resistant health
  polling, including same-address reconnect fencing at the final Java listener;
- issue #67's current-main request/decode/persist/export/phone/glasses health
  parity matrix, with sleep cmd 6 still deliberately unmapped and fail-closed;
- issue #59's bounded Hermes phone companion over the authenticated private WSS
  owner, with negotiated capability, exact-generation CAS, durable operation
  receipts, deadlines, replay safety, redacted projections and a responsive
  fifth tab;
- the maintained work from stale PRs #51, #53, #54 and #56: firmware automation
  research, the modern phone and glasses design contracts, and a DUMP-protected
  debug-only ADB harness; and
- final adversarial fixes for phone tab units, interactive assistant replies,
  companion initial synchronization, release-only publication, unsigned-input
  attestation and complete production exclusion of the JavaScript debug-control
  modules.

The open PR heads are historical inputs only. The combined branch is the
authoritative delivery vehicle. Its complete host suite passes 578/578, the
cross-feature completion matrix passes 74/74, TypeScript typechecking and diff
hygiene pass, and all 18 phone XML files parse. Debug, unsigned-release, signed-
release and same-certificate Fold7 evidence is recorded against the frozen
artifact candidate before merge. A real configured/licensed Hermes gateway
remains an external deployment evidence gate; the repository provides a
certificate-validated loopback WSS/RPC integration without inventing provider
or deployment claims.

## Ultra completion verification

The frozen artifact source is
`8fbdab9a7a19bf2b5543d26787b9660b9ca304d7`. With the locked dependency graph,
JDK 21, Android SDK/build tools 35.0.1 and NDK 27.2:

- the full host suite passes 578/578, the cross-feature matrix passes 74/74,
  typechecking and `git diff --check` pass, and all 18 phone XML files parse;
- the protected-cert debug APK is 195,906,735 bytes with SHA-256
  `358402611921874324945928c2671321a67e14f2ac89d7d4c2a55fa7c3dace30`;
- that exact debug artifact upgrade-installed over USB on the Fold7, launched
  without a fatal marker and reached an online G2 session. Exact-generation
  debug receipts proved replay rejection, Search/Transcribe/Cockpit opening,
  procedural endpoint fixtures, owned fixture stop, and display blank/wake.
  No wearer-input injection or live microphone capture was used;
- the same artifact completed four ordered
  battery→HR→SpO2→HRV→activity→sleep R1 polls while 26 packet acknowledgements
  were interleaved, closing the packet-ACK starvation regression on hardware;
- the Fold7 cover display reported 420 dpi (2.625 density). Its native tab strip
  measured 147 pixels, exactly 56 DIP; the inner item row retained a 126-pixel
  (48-DIP) touch surface after the 8-DIP gesture inset. The Hermes phone page
  rendered its bounded Refresh, New voice, sessions, voice and usage surfaces;
- the positively attested unsigned production APK is 185,723,703 bytes with
  SHA-256 `74cd0ff5f03124d3eed895a88bf9364c9a6050b9758129168197f64886d5bc50`;
  it is non-debuggable, has no signature material and contains no debug-control
  manifest, DEX or JavaScript surface; and
- the locally protected-signed release APK is 185,774,026 bytes with SHA-256
  `b2d8b2cebf4e596a85fcc930c9023a92a4be441609f4c25ef9ba5273809b3fc9`.
  It verifies under the expected certificate with v2/v3 signatures and
  debuggable signing forbidden. The USB-installed base APK reproduced that exact
  digest, Android denied `run-as` as non-debuggable, the debug receiver/action
  were absent, the process launched, and the G2 session reached ready.

Repeated debug/release swaps left the optional direct R1 link in bounded retry
backoff on the final signed-process observation; no false final-session R1 claim
is made. The identical frozen code in the exact debug artifact already supplied
the ordered four-poll proof above. Real licensed Hermes-provider deployment,
wearer-optical caption/search/cockpit review, TalkBack and the remaining physical
Fold posture matrix stay explicit operational evidence gates rather than code or
artifact blockers.

## Background assistant tasks on protected main

PR #60 is merged into the protected baseline. The assistant overlay yields when
a live turn begins tool work without cancelling that turn. Short declarative
outcomes drain serially through retained ACK-backed alerts; questions, choices,
long answers, empty answers, errors, and common postcode/code/approval prompts
restore the full assistant view. Pending results retry after a real G2 display
reconnect, strict alerts wait for ordinary rendering to become idle, active
turns reject competing capture, and synchronous bridge failures cannot retain a
dead turn handle. Context-dashboard displacement explicitly retires prior
background-overlay ownership so it cannot later duplicate or restore stale UI.

## Accessibility-first live captions candidate

PR #63 evolves Transcribe into volatile foreground/screen-owned captions with
visual mic/network/provider/error states, bounded grapheme-safe bottom-anchored
text, pause/clear/history, optional translation, truthful lag/drop metadata and
evidence-only speaker labels. It uses the exact generation-reserved voice
lifecycle now on main; caption and cloud callbacks are exact-lease/socket bound,
disconnect revokes capture before awaited teardown, and duplicate final provider
events cannot alter the submitted transcript. Credentials remain in the existing
replace-only secure settings and transcripts are neither logged nor persisted.
Frozen review, focused/full tests, typecheck and Android build pass. Real-G2
caption readability/stop/privacy and any explicitly approved live-mic evidence
remain operational gates. See `docs/live-captions.md`.

## Privacy-scoped universal search candidate

PR #64 adds a native, memory-only Search app over bounded local providers for
apps, upcoming calendar events, active notifications, one non-symbolic bookmark
level, and explicitly shared synchronized Hermes cockpit sessions. Provider
failures/timeouts are isolated; outputs are inert and bounded; action handles
are exact-generation, one-shot and revalidated immediately before opening.
Hostile provider arrays/getters/species and reentrant replacement searches are
contained to their source. Query/results/filters are not persisted or logged,
and unavailable Roam/terminal/media/health authorities are shown honestly rather
than broadened. Frozen review, focused/full tests, typecheck and Android build
pass; connected-G2 navigation evidence remains NO-GO rather than inferred. See
`docs/universal-search.md`.

## Live captions on protected main

PR #63 ships the live-captions/translation delta on top of Search. It retains the
native Hermes cockpit and contextual-dashboard lifecycle, including in-process
text input, foreground/screen notifications, assistant displacement/restoration
and exact-generation voice capture.

Transcribe is now a volatile, accessibility-first Captions window with literal
starting/live/paused/stopped/error/drop states, grapheme-safe bounded wrapping,
bottom anchoring and history, pause/resume and clear controls, and bounded phone
settings for source language, translation layout, font, spacing, line count,
evidence-backed speaker labels, and local-only unsupported vocabulary. Capture
is owned by the exact successful foreground/screen lease; assistant push-to-talk
preempts it, and late permission, Java, provider, PCM, stop, or close callbacks
cannot publish into a replacement generation. Source captions remain available
when translation or its credential is unavailable. Captions are memory-only and
credentials remain in the existing Keystore-backed replace-only settings.

The combined completion candidate preserves this lifecycle and revalidates it
with the battery, companion, phone-theme and release changes. See
`docs/live-captions.md` and `PRIVACY`.

## Canonical repository and release governance

`main` is the only canonical development branch. Current protected baseline is
`38c9ce1623aea4bfa0ac6d5eb556b23186e66d21` (`feat(g2): run tool tasks in
the background (#60)`). Do not resume from historical
`hermes-g2`, `integration/`, `work/`, `wt/`, `fix/`, or dated cleanup branches.

Public visibility is Benny-authorized and required by the current GitHub plan.
On 23 August, GitHub API read-back verified `not-benny/hermes-g2` is public and
`main` requires strict `release-gate` and aggregate `codeql`, conversation
resolution, enforced admins and linear history; force-push and deletion are
disabled. The current rule does not require an approving review. The repository variable
`PROTECTED_RELEASE_ENABLED` is `true`.

The most recent protected release validation documented here is run
[32604871016](https://github.com/not-benny/hermes-g2/actions/runs/32604871016)
which completed successfully at historical main SHA
`712cb644d9dd017158a6359ea494ec2ab6beb9b1`.
Its secret-free `main-build-validation` and source-free `protected-release`
signing jobs both passed. That run is historical evidence, not evidence for the
current completion candidate. The candidate workflow now builds an explicitly
unsigned production bundle, proves there is no v1 signature or pre-central-
directory signing material, rejects debug manifest/DEX/JavaScript surfaces,
and signs only that exact release artifact with debuggable signing forbidden.
PR jobs still receive no protected signing credential and publish no APK.

## Current outcomes: Hermes cockpit and read-only contextual dashboards

Protected main contains PR #62's provider-neutral native Hermes agent cockpit.
Its `cockpit-v1` channel rides the authenticated private WSS bridge and accepts
only explicitly shared, opaque session projections. The glasses app provides
bounded active-work, transcript/tool, pending-inbox and listed-answer views;
one-shot decisions, steering, interrupt and terminal actions remain exact-
generation and deny-default. Provider IDs, prompts, reasoning, tool arguments/
results, credentials and unshared work are excluded. The contract and remaining
private deployment evidence gates are in `docs/hermes-agent-cockpit.md`.

The completion candidate adds a separate phone companion projection on the same
authenticated WSS owner. It negotiates support before requesting state, bounds
initial synchronization and every gateway RPC, and exposes only status,
model/profile, last connection, bounded sessions, voice state, usage/cost and
redacted activity/error classes. Resume, cancel and voice creation are explicit
operation-ID actions with exact phone/provider generations, positive gateway
acknowledgements and durable owner-only receipts. Offline, unsupported, stale,
duplicate, timed-out, lost-receipt and late-reply paths terminate deterministically
and preserve a safe refresh route. A real licensed/configured provider deployment
was not available in the repository, so live provider evidence remains separate
from the passing local TLS-WSS/RPC integration.

PR #61's contextual-dashboard implementation supersedes the earlier HA-centric
dynamic mutation objective. Home Assistant and other external mutations are not
part of this release and remain a later separately authorized project.

Protected main now also contains PR #65's private dynamic-HA evaluation harness.
That harness is deployment-local, credential-custody and durable-idempotency
gated, read-only by default, and does not authorize production/public mutations.
The contextual dashboard surface below remains strictly read-only and does not
expose the private harness or broaden its authority.

PR #61 adds a provider-neutral V2 contextual-dashboard boundary for the
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

## Historical contextual-dashboard candidate verification

This section records the exact PR #61 candidate evidence; it is not the current
protected-main baseline. Its base was
`origin/main@712cb644d9dd017158a6359ea494ec2ab6beb9b1`.
The final source head is `844fc62aafe52c19f031bbd3e7c52358e9ef5014`.
Using the locked dependency graph, JDK 21 and Android SDK 35:

- focused Fold7 layout tests pass 9/9;
- full host suite passes 364/364;
- TypeScript `tsc --noEmit` passes;
- `git diff --check` passes;
- added-line credential/private-key/bearer scan has zero matches; and
- the Android debug build passes.

The exact final debug APK is 195,507,105 bytes with SHA-256
`5cfe9c6fb77258b1cc91ae5588da80323f65a243b436693c1d01044e8b18fe52`.
It upgrade-installed on the authorised Fold7; pulling the installed base APK
reproduced the same digest. The process launched, both G2 arms reached
`session ready`, and the independent direct R1 session reached MTU-247 with
both notify channels active. No fatal marker appeared.

The connected Fold7 cover layout rendered normally. A forced landscape run
found that the wide synthetic-gesture grid omitted the existing compact
`gesture-grid` style, wrapping labels mid-word. A focused regression was
observed RED (1 vs 2 styled grids), the wide grid now uses the same bounded
style, focused/full tests returned GREEN, and the rebuilt exact APK shows all
six gesture labels on one readable line in landscape.

The first exact-turn train attempt then exposed two deployment/runtime gaps:
the Android JavaScript runtime lacked native `AbortController`, and the active
assistant overlay still owned the lens surface when the loading dashboard tried
to deliver. The final candidate provides an exception-isolated cancellation
fallback in both MCP and registry boundaries, explicitly detaches and retains
the displaced assistant while the dashboard owns the surface, cancels it on
sleep/replacement, and restores it after failure only under exact live layer,
display, operation and retained-assistant identity. Dedicated timeout/listener,
supersession, sleep/teardown and rollback regressions pass; final independent
lifecycle/security review reports no blocker.

A 60-second connected warm renderer run recorded 43 valid phone frames, one
janky frame (2.326%), p90 15.547 ms and p99/max 19.547 ms, with 13 PSS samples
and no GC lines. One distinct G2 frame reached final application ACK; its total
latency was 819 ms, dominated by 771 ms waiting before 17 ms compression/plan,
then 27 ms to final ACK. This closes the phone-jank percentile target but does
not close the G2 radio/scheduling latency target.

Non-destructive runtime checks also proved Fold7 cover rotation, inactive/idle
Doze state, charging presentation, microphone capture reaching Deepgram's
bounded no-speech state, and one synthetic digest moving aggregate queue count
1 -> 0 without reading or persisting notification content. The original
notification filter/app-tier settings were restored and the synthetic item was
snoozed specifically.

The deployment-local bridge at commit
`0b3743cf00dcfdf7e180ed5d46ccb581694cf560` now returns a bounded configured
`hello_profile`, default-denies every phone tool outside an exact global
allowlist, distinguishes exact turn authority from explicit proactive calls,
revalidates event/turn generation under the final websocket send lock, rejects
malformed JSON-RPC IDs, and omits peer identifiers from logs. Its 29-test suite,
compile check, static scan and final independent security review pass for the
read-only contextual-dashboard scope. The live certificate-validated WSS/MCP
path returned the V2 640x480/4-bit capability and correctly rejected
`context_dashboard.begin` outside a conversation.

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
read-back remain required. The deployment-local bridge and exact Fold7/G2/R1
candidate are now live, but useful-dashboard operational authorization remains
NO-GO until an exact G2 turn exercises the deployment-local reader and the
remaining wearer actions below.
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

1. **Contextual dashboard:** the authenticated profile/tool boundary and live
   capabilities call pass, including proactive denial of `begin`. Still prove
   loading ACK under one second and useful/terminal state under five seconds in
   an exact G2 conversation using the deployment-local rail reader, then exercise
   the Liverpool all-destination board, scroll/focus, local refresh, pin/reopen,
   contextual voice, double-click close, reconnect/process restart, and
   sentinel-clean host/phone/logcat/storage. Obtain wearer/optical evidence when
   per-lens applied acknowledgement is unavailable.
2. **Public MCP/skill:** remains blocked until authenticated generic-client
   interoperability, credential/retry behavior, licensing and the real-G2 proof
   above pass. No public skill is part of this candidate.
3. **Renderer performance:** the clean fixed-duration Fold7 run proves the
   below-10% phone-jank and p99-under-50-ms target. The only sent G2 frame still
   took 819 ms, so the radio/scheduling latency target remains open.
4. **Fold7 preview:** exact install/process, cover visuals, forced rotation,
   landscape readability, two-arm readiness and direct R1 operation pass.
   Physical unfold transitions, tabletop and true multi-window remain unproven.
5. **Motion calibration:** source/build and bounded off-head/resting transport
   evidence pass, but exact-candidate worn/moving local calibration completion,
   heading quality and meaningful battery delta remain open.
6. **Notification triage:** the exact Fold7 candidate queued one synthetic digest
   and later drained aggregate queue count 1 -> 0 while the G2 session was live.
   Wearer/optical confirmation of the digest remains unverified.
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
