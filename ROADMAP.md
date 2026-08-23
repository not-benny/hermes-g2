# Hermes G2 roadmap

Current as of 23 August 2026. `main` is the canonical branch.

**Status key:** DONE · IN PROGRESS · PARTIAL · TODO · RESEARCH · BLOCKED

## Now

### Background assistant tasks

- **IMPLEMENTED / HOST VERIFIED; G2 EVIDENCE PENDING (23 August 2026).** The
  assistant yields its overlay during tool work without cancelling the turn,
  returns short outcomes through serial ACK-backed alerts, and restores the
  conversation for interactive, long, empty, or failed outcomes. Exact turn,
  render, display-session, capture, and displaced-overlay ownership prevent
  stale delivery or duplicate UI. The code-only refresh is based on exact
  `origin/main@b762846c5c0652c0e67f8828209b40d148447272`; its stable patch ID
  matches the verified port. Fresh focused tests pass 70/70, the full host suite
  passes 508/508, and TypeScript typechecking passes. No APK installation or
  combined Fold7/G2 runtime evidence is claimed.

### Accessibility-first live captions and translation

- **IMPLEMENTED / HARDWARE EVIDENCE PENDING (23 August 2026).** Transcribe now
  provides volatile foreground/screen-owned captions, exact generation-bound
  capture, visual-only failure states, bounded rolling text and optional
  translation/speaker evidence. Duplicate/stale provider events fail closed and
  no transcript is logged or persisted. Static review and the full build matrix
  pass; connected-G2 readability/stop/privacy and approved live-mic evidence
  remain pending. See `docs/live-captions.md`.

### Privacy-scoped universal search

- **IMPLEMENTED / HARDWARE EVIDENCE PENDING (23 August 2026).** A native
  memory-only Search app provides bounded opt-in apps/calendar/notifications/
  bookmark/shared-Hermes providers with isolated deadlines and exact one-shot
  open handles. Hostile provider objects and reentrant generations fail closed;
  query/results are not persisted or logged. Static review and the full build
  matrix pass. Connected-G2 navigation/open/back/filter evidence remains pending.
  See `docs/universal-search.md`.

### Native Hermes agent cockpit

- **IMPLEMENTED / END-TO-END HARDWARE AND BRIDGE DEPLOYMENT BLOCKED (23 August
  2026).** A provider-neutral `cockpit-v1` channel now rides the authenticated
  private WSS bridge and exposes only explicitly shared opaque session
  projections. The native Hermes glasses app provides active work, compact
  transcript/tool rows, a pending inbox, reviewed listed answers, deny-default
  exact one-shot permissions, twice-reviewed voice steering, exact-generation
  interrupt, and explicit terminal states. Sequence gaps, reconnect, expiry,
  duplicate taps, replacement generations, answered-elsewhere prompts, terminal
  runs, and unsupported approval scopes fail closed. The metadata-only Hermes
  adapter maps current TUI gateway events/actions without exporting provider IDs,
  prompts, reasoning, tool arguments/results, credentials, or unshared work; a
  deterministic JSON-lines fake and adversarial fixtures cover ordering and
  privacy. At its `main` merge, all 376 host tests, TypeScript typecheck, and the
  JDK 21 / SDK 35 Android build passed. That merge's exact debug APK SHA-256 is
  `be226031aa95fbf3b731d32a92d54c4b7935f3fa60892e379cb9144d567ea7d0`.
  No A32/G2 was attached and the private bridge was not upgraded in this run, so
  real question/deny/allow-once/steer/interrupt/completion evidence remains open.
  See `docs/hermes-agent-cockpit.md`.

### Accessibility-first live captions and translation

- **IMPLEMENTED / FOLD7 AND G2 EVIDENCE PENDING — volatile foreground captions
  (23 August 2026).**
  The Transcribe app is now an accessibility-first Captions window with
  visual-only microphone/network/provider/translation states, grapheme-safe
  bounded wrapping, bottom anchoring, history scrollback, pause/resume, clear,
  and source-preserving split/full translation layouts. Capture, permission
  continuations, Java/cloud callbacks, PCM delivery, provider swaps and teardown
  are generation-bound; background, screen-off, pause and close stop capture.
  Soniox supplies optional one-way translation and evidence-backed speaker
  labels with bounded PCM buffering/reconnect/drop metrics. Phone settings bound
  languages, layout, font, spacing, lines, speaker labels and local-only
  unsupported vocabulary while disclosing local/cloud processing. Captions are
  memory-only and transcript-only remains credential-independent. On the
  requested `main@51f147d` integration, the focused caption/voice race suite
  passes 19/19, the full host suite passes 478/478, TypeScript and the JDK 21 /
  SDK 35 build pass, and the APK verifier passes. Fold7 install/launch, scripted
  and live microphone, real-G2 readability,
  stop/clear/background, disconnect, and caption-specific privacy-safe logcat
  evidence remain required before DONE. See `docs/live-captions.md`.

### Notification priority and digests

- **IN PROGRESS — local privacy-first triage (22 August 2026).** A deterministic
  pure reducer now covers sender/channel/category/app/default precedence, per-app
  defaults/reset, urgent/immediate/digest/mute tiers, quiet hours, cooldown,
  cross-key deduplication, global/per-app rate caps, bounded fair digest draining,
  update replacement, Android removal, dismiss/clear tombstones, restart, and
  wall/timezone changes. Android emits post and removal events with current bounded
  metadata; glasses show “Why” for immediate items and offer a reviewable digest.
  Persisted state contains aggregate counts only and the old external icon-debug
  files/package logs are removed. Host tests, typecheck and Android build pass;
  reversible A32 synthetic post → queued update → removal transitions were observed
  through aggregate-only metadata. Final independent review, CI and remote PR
  read-back remain the delivery gates. See `docs/notification-triage.md`.

### Renderer performance

- **IMPLEMENTED / HARDWARE FLOOR MEASURED — renderer hot paths (22 August
  2026).** Added a fixed 60-second, privacy-safe A32 benchmark and separated
  paint, snapshot/bridge, composite, pack, compression/plan, Bluetooth send,
  application ACK, phone framestats, GC, and PSS evidence. Ordinary redraws
  coalesce, idle Java submission skips one measured timer hop, queued images
  outrank redundant heartbeats, native typed-array copying replaces the slower
  generic copy, and repetitive success logs leave the release hot path. Receipt
  correctness is stronger: strict operations require a successful terminal
  outcome, first-finish wins across Java/TS, and multi-message frames complete
  only after every application ACK. Host tests pass 266/266, typecheck/build
  pass, and an installed USB A32 candidate received both ACKs for a real
  two-message G2 image before reporting `sent`. A later clean 60-second Fold7
  run recorded 43 valid phone frames, 2.326% jank and p99/max 19.547 ms, closing
  the phone-jank percentile target. Its only changed G2 frame still took 819 ms,
  dominated by worker scheduling before compression, so end-to-end G2 latency
  remains open. No firmware/texture-cache device command was added.

### Repository and release

- **DONE / PRIVATE DEPLOYMENT — sleep voice, HUD signal/R1, and WSS bridge (22 August 2026).**
  A sleeping R1 long-press now wakes directly into assistant push-to-talk;
  quick-close mode names its controls; the HUD adds phone signal and keeps a
  configured R1 visible while battery is unknown. Battery requests precede rich
  history and both standard-GATT/protocol values feed Health and HUD. The private
  Hermes bridge now has a certificate-validated WSS deployment with its private
  key outside the repository. Host tests, build, APK checks, independent review,
  and a real WSS handshake pass. The exact APK installed/launched on the Fold7
  and authenticated to Hermes with 33 phone tools. Both G2 arms then reached
  session ready and direct R1 BLE reached MTU-247/notify readiness on the exact
  candidate. The wearer confirmed signal bars, sleep long-press voice capture,
  clear close-mode guidance, and a matching R1 battery percentage in HUD and
  Health. The wearer verified Health is explicitly labelled as hideable rather
  than closeable in quick-close mode and tap hides it; the launcher is labelled
  pinned.

- **PARTIAL — Fold7 cover/rotation validated; posture matrix open (23 August 2026).**
  Preview 2 removes the portrait lock, handles live cover/unfolded/rotation/
  tabletop/multi-window bounds, bounds wide content, preserves platform font
  scaling and 48dp controls, and retains the existing G2 compositor contract.
  Host fixture, build, APK, ABI, signing, and 16 KiB evidence are required for
  publication. The exact debug APK installed and ran as a live process on an
  SM-F966B with Android 16. The exact contextual-dashboard candidate later
  passed unlocked cover visuals, forced landscape/rotation, two-arm session
  readiness and direct R1 operation. That run found and fixed a wide-layout
  gesture-label wrapping defect under focused RED/GREEN coverage. Physical
  unfold transitions, tabletop and true multi-window proof remain blocked.

- **DONE — full audit remediation and release path (21 August 2026).** The
  merged PR #28 implementation removes private-data logging, encrypts credential
  and token-bearing settings with verified Keystore migration/clear, makes calendar
  failures explicit, narrows foreground-service claims, disables unclosed
  WhatsApp production pairing, requires TLS for remote terminal transport,
  allowlists the R1 health-session boundary, hash-verifies native inputs, pins
  NDK/CMake/NativeScript, and adds permanent CI/CodeQL/Dependabot/SBOM/APK
  verification. Local host/build/APK and authorised A32 upgrade/launch evidence,
  independent review, GitHub CI, and merge passed. See
  `docs/audit-remediation-2026-08-21.md` and
  `docs/release-security.md`.

- **DONE — enforced release governance (verified 23 August 2026).** The
  Benny-authorized public repository has API-verified `main` protection:
  strict `release-gate` and `codeql`, one stale-dismissed approving review,
  conversation resolution, enforced admins, linear history, and blocked
  force-push/deletion. `PROTECTED_RELEASE_ENABLED=true`. Protected Release
  Validation run `32604871016` succeeded at canonical
  `main@712cb644d9dd017158a6359ea494ec2ab6beb9b1`, including the isolated
  source-free `protected-release` signing job. PR builds still receive no
  signing credentials or publishable APK.

- **DONE — history consolidation.** The original release history, reviewed
  integration history, remaining PR heads, and superseded startup-race attempt
  are joined on `main`. The final tree keeps the newer reviewed application
  implementation and restores the maintained public ring-health documentation,
  firmware-research archive, and development guide from the original line.
- **DONE — fresh-checkout release validation (21 August 2026).** Exact `main`
  commit `24274cfa5a076618afdb2306b880623aa4a94abe` passed `npm ci`, all
  247 host tests, TypeScript typechecking, and the JDK 21 / Android SDK 35 debug
  build in a clean GitHub-hosted environment. The resulting 335,831,435-byte APK
  passed ZIP-integrity and private-path checks and has SHA-256
  `03143d502175e0f0cfce5b0022ee3263aa85bc8d48bc4cdc710133de621908f2`.
  See `docs/clean-checkout-validation-2026-08-21.md`.
- **DONE — development-preview release (21 August 2026).** Published prerelease
  `v1.0.0-preview.1` from the exact validated source commit, with the
  checksum-pinned debug APK plus explicit setup, firmware, privacy and
  known-limitation warnings. See
  `docs/development-preview-release-2026-08-21.md`.

### Connection and lifecycle reliability

- **PARTIAL — shared IMU/compass calibration service (22 August 2026).** One
  generation-bound owner now arbitrates multi-app sensor demand/rate, stops on
  screen-off/final release, rejects stale/outlier/interference-like samples,
  derives bounded level/posture state, and persists only versioned
  opaque-device-bound calibration quality/neutral metadata. Compass and accelerometer UI expire
  stale values and label uncertain results. All 303 tests, typecheck and Android
  build pass. USB A32/G2 evidence proves warmed-session IMU/compass enable ACKs,
  eight accepted motion samples, prompt dual disable ACKs, and no continuing
  repaint stream after stop. The resting/off-head G2 emitted no heading or
  calibration-complete event. A follow-up worn run then proved live `188° S`,
  level and 54 accepted samples but still no firmware calibration events. Compass
  now exposes a bounded local start/cancel workflow that sends no BLE command,
  requires filtered heading coverage plus level-neutral IMU evidence, persists
  only `poor` summary quality, and fails closed across timeout/session/restart;
  firmware start/complete remains a separate at-most-`fair` path. Host lifecycle
  and 576×288 viewport coverage pass, but exact-candidate hardware validation and
  a meaningful battery delta remain unproven. Repeat the local flow while
  worn/moving in a serialized hardware window before marking DONE.

- **DONE — startup connection race.** A delayed constructor-time disconnected
  snapshot can no longer release a newly connecting communicator. Retained
  ownership remains authoritative until exact teardown completion.
- **DONE — exact GATT ownership.** Connects and operations use exact
  `BluetoothGatt` identity plus monotonic generations; stale callbacks and
  timed-out operations cannot retire replacements.
- **DONE — worker isolation and bounded teardown.** Display and R1 workers have
  separate lifecycle ownership, generation-bound packet acknowledgements, and
  deferred exact-once cleanup.
- **DONE — truthful independent connection health (22 August 2026).** Optional
  R1 connect and health work stays off the display worker, and blocking BLE work
  runs outside its short state monitor under generation ownership. Deterministic
  blocked-work reads stay below 100 ms. Controls distinguishes G2 from R1 and
  shows a safe failure class, retry countdown/action, and bounded redacted
  reconnect/ACK/stale-work/lock-latency counters. USB A32 evidence proves live G2
  ACK traffic and independent R1 health/packetAck traffic.
- **TODO — broader device matrix.** Repeat non-destructive startup, reconnect,
  charging, screen-off, and wearer-input checks on additional supported phones
  and G2 firmware revisions without weakening the existing safety gates.
- **PARTIAL — audit device matrix (updated 22 August 2026).** Same-certificate
  upgrade, launch, Keystore migration, settings redaction, and log sentinels
  passed on the authorised Samsung A32. A later non-destructive run proves a live
  two-arm G2 render/ACK session and independent R1 session-open, device-info,
  health notify and packetAck traffic. Doze, charging, phone-mic, calendar, and
  additional phone/firmware variants remain open. No pairing, provisioning,
  reset, wipe, firmware, permission-dialog, or Even-app Bluetooth action occurred.

## R1 health

- **DONE — vital decoding and persistence.** Battery, read-only firmware version,
  current/current-hour heart rate, hourly HR/SpO2/HRV, nullable anchored
  timestamps, history, export, and fail-closed persistence are implemented.
- **DONE — activity and calories.** Confirmed 10-minute step, active-calorie,
  total-calorie, and derived resting-calorie buckets are validated by envelope,
  CRC, shape, and current-local-day gates.
- **DONE — session clock and polling.** A one-shot best-effort `systemTime`
  command runs during session setup; HR-only refresh remains separate from the
  slower full-health poll.
- **RESEARCH — health parity and sleep.** The field-level current-main inventory
  is recorded in `notes/health-data-parity-2026-08-23.md`. Cmd 6 remains unmapped
  and `decodeSleep` remains fail-closed until a CRC-valid stage-bearing frame is
  correlated to authoritative ground truth for the exact same worn session and
  its absolute time-base handoff is proven with frozen positive/negative vectors.
- **BLOCKED — first-time provisioning and ownership.** Pair/unpair, host binding,
  NVM mutation, recovery, and fresh-device onboarding remain unproven and are not
  authorised for implementation or hardware use.

## Assistant, MCP, and glasses rendering

- **DONE — private bounded render surface.** `glasses.render_view` has operation
  IDs, exact owner/revision checks, TTL and rate limits, inert content, strict
  compositor receipts, gesture-event polling, cancellation, and no wake/focus.
- **DONE — turn and connection binding.** External calls require a live
  connection and exact claimed originating turn, or an explicitly gated
  proactive call. Disconnect and cancellation retire owned work.
- **PARTIAL / DEPLOYED BOUNDARY PASS — dedicated read-only contextual dashboards (23 August 2026).**
  The superseding V2 outcome is restricted to the dedicated `even-g2` profile.
  It opens an ACK-backed loading view before direct read-only gathering, streams
  bounded summary-first sections with typed source/freshness/uncertainty, and
  uses exact dashboard/presentation/refresh/revision identities. Ring actions
  are fixed phone-local refresh/pin/unpin/section/follow-up only; no provider
  mutation or remote action handle is accepted. Up to five encrypted pins retain
  bounded intent and refresh policy but no responses or rendered values. The
  permanent Liverpool Lime Street projector renders all destinations ordered by
  expected departure. The final 360-test/typecheck/Android-build matrix passes;
  the exact APK is installed on Fold7 with live G2/R1 sessions. The deployment-
  local bridge at `0b3743c` adds exact turn/proactive authorization, final-lock
  generation checks, bounded profile claims, malformed-ID rejection, peer-safe
  logs and a default-deny tool allowlist; 29 bridge tests and independent review
  pass. Live WSS/MCP capabilities succeed and proactive `begin` is denied.
  Exact-turn loading/useful latency, rail data, wearer controls and optical proof
  remain gates. See `docs/dynamic-glasses-apps.md`.
- **BLOCKED — public MCP/skill publication.** No public skill or untrusted remote
  rendering until authenticated `wss://` server identity, compatible licensed
  generic client, credential/retry/privacy gates, and real-G2 contextual-
  dashboard evidence all pass. Smart-home mutations are a later project.
- **PARTIAL — private end-to-end bridge validation.** Certificate failure,
  authenticated capabilities, reconnect, profile isolation, stale/proactive
  rejection and exact phone/G2 transport pass. Exercise one exact G2 utterance
  through loading → read-only gather → useful publish → wearer actions/reply.
- **PARTIAL / PRIVATE EVALUATION ONLY — dynamic Home Assistant harness.** PR #65
  merged authenticated private WSS, a durable mutation ledger, bounded provider
  transport and a reversible-evaluation harness. It is read-only by default and
  remains separate from the contextual-dashboard product; production mutation
  authorization and private deployment evidence remain gated.

## Firmware

### G2 glasses

- **RESEARCH / LIMITED OWNER EVIDENCE.** The reviewed 2.2.8.4 custom candidate has
  reportedly booted and run on one owner unit. That does not establish broad
  compatibility, reproducibility, or recovery.
- **BLOCKED — recovery assurance.** Do not claim the flash path safe until a
  documented, independently witnessed recovery procedure succeeds on appropriate
  sacrificial hardware.

### R1 ring

- **BLOCKED / DO NOT BUILD.** Standalone R1 DFU/OTA remains absent. Secure DFU
  requires a genuine compatible vendor-signed image, while provenance, authority,
  recovery, privacy, power, and per-run consent gates remain unsatisfied.
- **BLOCKED.** Reset, wipe, pair-delete, host rebinding, algorithm-key mutation,
  power-control, and raw-command bypasses stay blocklisted.

## Later

- Non-Even first-time glasses onboarding, only after safe ownership and recovery
  boundaries are documented and independently validated.
- Additional local-first assistant and accessibility features that do not expand
  the trusted-data or device-mutation boundary.
- A public release and community-list submission only when release documentation
  accurately distinguishes implemented, hardware-verified, research-only, and
  blocked capabilities.
