# Hermes G2 research

This section is the public map of the research behind Hermes G2. It is written for
people who want to understand, reproduce, review, or extend the project without
needing access to the owner's phone, glasses, ring, private gateway, or local
captures.

The project is an owner-only internal preview for an authorised Android phone,
provisioned Even Realities G2 glasses, an optional Even R1 ring, and a private
Hermes Agent gateway. It is not a production release, a general hardware-support
claim, or a firmware distribution.

## How to read this section

- [`STATUS.md`](../../STATUS.md) is the authority for current project state.
- [`ROADMAP.md`](../../ROADMAP.md) is the authority for the active milestone.
- [`DEVELOPMENT.md`](../../DEVELOPMENT.md) defines contribution, testing, and
  safety rules.
- The dated notes below are research records and evidence, not competing
  roadmaps. A dated conclusion can be superseded by a later implementation or
  acceptance record.
- Maintained component contracts live under [`docs/`](..), while this page is
  the cross-topic index and synthesis.

Research findings are deliberately separated from operational secrets. Public
research must never contain bridge tokens, API keys, certificates or private
keys, private network addresses, device identifiers or serials, health exports,
Bluetooth captures, pulled Android settings, completed consent records,
proprietary firmware, or raw private transcripts.

## Research conclusions at a glance

### 1. The product boundary is intentionally narrow

Hermes G2 is a visual-first, voice-oriented owner companion. The supported
research envelope is one known Android Fold7 setup, already-provisioned G2
hardware, an optional paired R1, and one authenticated private Hermes gateway.
The project does not perform first-time pairing, ownership transfer, provisioning,
firmware flashing, DFU/OTA, recovery, reset, wipe, unpairing, or destructive R1
operations.

Stock-firmware use is limited to phone-preview mode. The full glasses runtime
requires the reviewed owner firmware, but the repository does not publish
proprietary firmware binaries or treat one successful boot as recovery or
compatibility evidence.

### 2. The bridge is an authenticated transport, not a generic remote shell

The phone opens one certificate-validated WSS connection to the private gateway.
The connection has three reviewed roles:

- `ctl` — authentication, profile/capability negotiation, keepalive, and protocol
  state;
- Host Session MCP — final-only assistant turns and bounded Hermes Cockpit state;
- private Device MCP — phone-owned device operations, never mounted directly into
  the model registry.

The separate `hermes-g2-workflows` MCP package exposes intent-level workflows
rather than a generic phone-tool proxy. Connection generations, profile identity,
request identity, replay handling, cancellation, exact schemas, and phone
receipts are part of the authority boundary.

Thinking, partial responses, provider payloads, tool activity, raw prompts,
credentials, and terminal fallbacks must not become wearer-visible output. Only a
bounded authoritative final result may drive a glasses presentation.

### 3. R1 health research is based on captured protocol evidence, not guesses

The R1 work established a bounded BLE health path with a session-opening
`pairAuth` exchange, a packetised transport, response acknowledgements, daily
health records, activity records, and a separate sleep boundary. The implementation
keeps parsing framework-free and fail-closed:

- envelope, length, status, CRC, field shape, generation, and freshness are
  validated before persistence;
- incomplete or relative-only records are rejected rather than presented as
  complete data;
- daily heart rate, SpO2, HRV, activity, calorie, battery, sleep, and temperature
  support each have separate evidence levels;
- ring identity, connection ownership, reconnect, and stale callback behaviour are
  treated as part of the data contract;
- the official Even app must release the R1 connection before Hermes can use it.

Raw captures remain private. The public documents retain the method, decoded
layout, safe golden-vector descriptions, limitations, and verification procedure,
not personal health data or identifying radio captures.

### 4. The glasses UI is constrained by the real display and input lifecycle

The research treats the lenses as a small, low-bit-depth, glance-oriented display.
The design system favours short cards, bounded lists, progressive disclosure,
explicit confirmation, stable focus, optical-safe margins, and deterministic
motion. A screen-off result must prepare its isolated surface before wake and
commit only after the exact frame acknowledgement.

A failed or superseded presentation must release its input and wake ownership
without blanking a newer surface. Running work stays phone-only; it does not
silently acquire a glasses layer. Health is hideable, never closeable.

### 5. Security and publication are separate from implementation

A feature can be implemented and pass host tests while still being blocked from
physical acceptance or public release. The research therefore records separate
verdicts for:

1. source and static analysis;
2. focused and full host tests;
3. build, signing, and package verification;
4. installation and process launch;
5. transport and protocol evidence;
6. phone rendering evidence;
7. worn-glasses and ring hardware acceptance;
8. public publication and licensing readiness.

This prevents a clean compile, a fake-phone protocol test, or a simulated lens
frame from being misreported as real hardware acceptance.

## Research methods

### Protocol discovery

Protocol work starts with the smallest reproducible capture or fixture. A finding
must identify what was observed, how it was captured, what was decoded, what
remains unknown, and which implementation boundary consumes it. Parsers are kept
pure where possible so malformed lengths, CRC failures, truncated records,
unknown fields, and out-of-order fragments can be tested without Android.

### Hardware evidence

Hardware evidence names the exact device class, transport, app candidate, and
operation scope in the private run record. Non-destructive reads and metadata
checks are distinct from writes to BLE characteristics. Pairing, provisioning,
firmware, recovery, power, reset, wipe, and data deletion remain separately gated.
A phone screenshot proves rendering, a protocol log proves transport, and neither
alone proves the other.

### Threat modelling

Threat models enumerate trust boundaries, capability identity, stale and replayed
requests, connection replacement, late callbacks, hidden or off-head display
states, prompt/tool injection, privacy leakage, and publication mistakes. Proposed
surfaces must fail closed on malformed, oversized, foreign, expired, unbound, or
ambiguous input.

### Reproducible reports

A useful research record gives another contributor:

- the question and scope;
- the provenance of the observation;
- the smallest safe reproduction method;
- the implementation consequence;
- the confidence and evidence level;
- the known limitations;
- the next test that would change the conclusion.

Private evidence can be referred to by a content-free record name or evidence
class, but it must not be copied into a public issue, pull request, release, or
support bundle.

## Research map

### Architecture and transport

- [`Voice Assistant Architecture`](../../notes/voice-assistant-design.md) — local
  versus external assistant modes, entry points, tool ontology, and the original
  voice-loop design.
- [`G2 protobuf transport primitives`](../../notes/g2-proto-transport.md) —
  bounded protobuf command primitives and their runtime safety boundary.
- [`Local-only EvenHub compatibility`](../evenhub-local-compat.md) — what can be
  retained locally, what is proven, and which compatibility paths are explicitly
  out of scope.
- [`Hermes MCP architecture`](../hermes-mcp-architecture.md) — current Host MCP,
  Device MCP, workflow MCP, profile, capability, receipt, and display boundaries.
- [`Hermes Cockpit over Host MCP`](../hermes-agent-cockpit.md) — bounded current
  and recent session projection, exact commands, stale-generation handling, and
  phone-only running state.
- [`MCP glasses display`](../mcp-glasses-display.md) — private display evaluation,
  configuration, safe defaults, troubleshooting, and rollback.
- [`MCP glasses-display threat model`](../../notes/mcp-glasses-display-threat-model-2026-08-21.md)
  — display assets, trust boundaries, attacker model, safe failure, and
  publication gates.
- [`Hermes Cockpit protocol threat model`](../../notes/hermes-cockpit-protocol-threat-model-2026-08-23.md)
  — bounded snapshots, commands, ordering, reconnect, replay, and privacy
  invariants.
- [`MCP/skill publication audit`](../../notes/mcp-skill-publish-audit-2026-08-20.md)
  — publication-readiness findings, hardening progress, and remaining gates.

### R1 ring health and BLE protocol

- [`R1 health over BLE`](../ring-health/README.md) — public protocol overview,
  GATT channels, transport envelope, command table, daily layout, activity,
  sleep, capture method, and privacy boundary.
- [`R1 protocol evidence capture method`](../ring-health/capture-method.md) —
  safe, package-filtered capture and correlation procedure with restoration steps.
- [`Even R1 health sync protocol`](../../notes/ring-health-protocol-2026-08-19.md)
  — initial live protocol finding, session sequence, packet acknowledgements,
  and remaining unknowns.
- [`R1 wire format`](../../notes/ring-wire-format-2026-08-20.md) — GATT channels,
  binary envelope, inner frame, command table, daily records, and decoder status.
- [`R1 daily-data layout`](../../notes/ring-daily-layout-2026-08-20.md) — decoded
  daily health fields, sparse-data explanation, and downstream implications.
- [`R1 ground truth`](../../notes/ring-groundtruth-2026-08-20.md) — correlation of
  btsnoop traffic and Even health exports, including the evidence limitations.
- [`R1 sleep frames`](../../notes/ring-sleep-frames-2026-08-20.md) — confirmed
  type-1 absolute sleep summary, type-2 limitations, and confidence boundary.
- [`R1 health-data parity`](../../notes/health-data-parity-2026-08-23.md) —
  request-to-surface matrix, ownership, persistence, and the remaining end-to-end
  acceptance boundary.
- [`Rich Health tab`](../../notes/health-tab-2026-08-20.md) — deferred richer
  health surface, lifecycle, persistence, retention, and the requirement for
  worn-ring ground truth.
- [`Calorie-burn estimator`](../../notes/calorie-estimation.md) — HR-based active
  calorie estimate, profile assumptions, and limitations.
- [`R1 provisioning static analysis`](../../notes/r1-provisioning-static-analysis-2026-08-21.md)
  — review of provisioning call sites and the bounded conclusion that static
  analysis is not permission to run them.
- [`R1 firmware-update design`](../../notes/ring-firmware-update-design.md) —
  feasibility assessment, risks, safe near-term alternative, and gated future
  architecture.
- [`R1 firmware consent gate`](../../notes/ring-firmware-consent-gate.md) —
  separate approval, evidence, retention, and stop rules for any future firmware
  work.
- [`R1 sacrificial recovery gate`](../../notes/ring-sacrificial-recovery-gate-2026-08-21.md)
  — future-only recovery lab requirements and independent evidence gates.

### Glasses UX, phone UX, and lifecycle

- [`Modern glasses UI solutions`](../../notes/glasses-ui-modern-design-2026-08-22.md)
  — display/input constraints, human factors, card patterns, lists, confirmation,
  motion, and recommended glance interactions.
- [`Glasses design system`](../glasses-design-system.md) — shared tones, spacing,
  typography, cards, focus, progress, motion, and optical constraints.
- [`Phone UI design language`](../phone-ui-design-language.md) — quiet technical
  companion direction, Fold7 constraints, reusable controls, and privacy rules.
- [`Fold7 compatibility matrix`](../../notes/fold7-compatibility-matrix-2026-08-22.md)
  — cover, unfolded, tabletop, split-screen, resize, accessibility, and evidence
  levels for the target phone.
- [`G2 local motion calibration`](../g2-local-motion-calibration.md) — wearer
  calibration flow, truth boundaries, and acceptance coverage.
- [`Local reader and teleprompter`](../local-reader.md) — local import, on-glasses
  controls, state, and privacy.
- [`Conversate/live captions`](../live-captions.md) — local-first transcription,
  foreground-only lifecycle, optional auxiliary cues, and no raw-audio retention.
- [`Notification triage`](../notification-triage.md) — precedence, quiet hours,
  digest policy, notification ownership, and glasses interaction.
- [`Universal search`](../universal-search.md) — source contracts, safe action
  revalidation, privacy, and rollback.
- [`Contextual dashboard threat model`](../../notes/dynamic-glasses-app-threat-model-2026-08-22.md)
  — trust boundary, lifecycle identities, bounded schemas, pinning, and
  adversarial coverage.
- [`Temporary contextual interfaces`](../dynamic-glasses-apps.md) — declarative
  dashboards, bounded data, deterministic pages, pinning, and private evaluation
  limits.

### Integrations and feasibility studies

- [`MentraOS compatibility assessment`](../../notes/mentraos-compat-assessment.md)
  — compatibility with the MentraOS app models, hard parts, effort, and
  recommendation.
- [`WhatsApp pairing options`](../../notes/whatsapp-pairing-options-2026-08.md)
  — pairing models, architecture options, preconditions, and decision gates.
- [`WhatsApp link-code regression`](../../notes/whatsapp-link-code-regression-2026-08.md)
  — stale-auth diagnosis, affected boundary, confidence, and the three-stage
  proof gate.
- [`Media-key resume`](../../notes/media-resume-via-media-key.md) — research into
  the safe resume action and media dispatch boundary.

### Firmware, safety, and publication

- [`Automatic firmware patching investigation`](../automatic-firmware-patching-investigation-2026-08-22.md)
  — quarantined acquisition, reviewed promotion, assisted deployment, rollout,
  and failure handling.
- [`Release security`](../release-security.md) — identity, signing, credentials,
  transport, build/CI, permissions, and gated operations.
- [`Audit remediation`](../audit-remediation-2026-08-21.md) — corrected findings,
  remediated boundaries, and honest remaining limits.
- [`Clean-checkout validation`](../clean-checkout-validation-2026-08-21.md) —
  source, toolchain, artifact, and validation-boundary record.
- [`Development-preview release`](../development-preview-release-2026-08-21.md)
  — preview identity, publication state, and installation boundary.
- [`Repository consolidation`](../repository-consolidation-2026-08-21.md) — why
  the development histories were consolidated and how branch provenance was
  classified.
- [`Direct assistant hardware test matrix`](../../notes/direct-assistant-app-tools-hardware-test-matrix.md)
  — two-stage authorization, evidence levels, hardware matrix, and blocked-result
  procedure.
- [`Debug-only ADB control harness`](../debug-control.md) — bounded debug
  automation, target selection, replay protection, and release exclusion rules.

### Source-only firmware research

The firmware directory contains source-only research and review records; it does
not contain proprietary firmware images. These documents are intentionally
separate from the Android runtime and never constitute permission to flash or
recover hardware:

- [`CFW research overview`](../../firmware-research/README.md) — scope, status,
  contents, licensing, and safe-use boundary.
- [`CFW verification report`](../../firmware-research/REPORT.md) — fixed-candidate
  changes, hook scope, reproducible build, static verification, provenance, and
  residual hardware blockers.
- [`CFW peer review`](../../firmware-research/peer-review/PEER-REVIEW.md) —
  independent findings, unresolved safety issues, and go/no-go gates.
- [`Fixed-build peer review`](../../firmware-research/peer-review/FIXED-BUILD-REVIEW.md)
  — final review evidence and mandatory hardware gates.
- [`CFW anchor relocation`](../../firmware-research/relocation/RELOC-6.10-to-8.4.md)
  — verified relocation evidence between reviewed candidate versions.

### Publication preparation

These records are held as drafts or preparation material. They are useful for
understanding how a public listing was evaluated, but they are not evidence that
an external listing or pull request was accepted:

- [`Awesome-list base`](../../notes/awesome-list-prep/pangoleen-awesome-even-realities-g2/BASE.md)
- [`Hermes G2 awesome-list draft`](../../notes/awesome-list-prep/pangoleen-awesome-even-realities-g2/hermes-g2-pr.md)
- [`R1 health awesome-list draft`](../../notes/awesome-list-prep/pangoleen-awesome-even-realities-g2/ring-health-pr.md)

## Evidence status and open questions

The implementation has broad host-side coverage, but the research keeps these
boundaries explicit:

- full worn-glasses acceptance of the exact Android candidate remains distinct
  from build and phone-preview evidence;
- the complete R1 sleep/readiness path still requires an installed, end-to-end
  owner-ring run;
- the provider-backed voice loop and background tool workflows need exact
  candidate hardware acceptance;
- the full Fold7 cover/unfolded/accessibility matrix remains a physical test;
- firmware acquisition, recovery, flashing, and broad compatibility remain
  gated, not assumed;
- public release claims must continue to distinguish source publication,
  owner-preview artifacts, signing, installation, and real-device acceptance.

For the current truth of any item, follow `STATUS.md` and `ROADMAP.md` rather
than relying on a dated note.

## Contributing research

When adding research:

1. Start with a narrowly scoped question and a safe reproduction path.
2. Record the observation date, environment class, evidence level, and known
   limitations.
3. Separate observed facts, interpretations, implementation decisions, and
   open questions.
4. Add focused tests or fixtures when a protocol or lifecycle finding becomes
   code.
5. Link the note from this index and update the relevant maintained contract if
   the finding changes current behaviour.
6. Run the repository's normal checks and `git diff --check`.
7. Remove or redact private captures before staging anything.

A research note is not permission to perform a gated operation. Static analysis,
reverse engineering, a simulated device, or a successful test fixture never
implicitly authorises pairing, provisioning, firmware, recovery, reset, wipe,
or destructive hardware actions.
