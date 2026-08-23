# Hermes G2 roadmap

Current as of 23 August 2026. `main` is the canonical branch.

**Status key:** DONE · IN PROGRESS · PARTIAL · TODO · RESEARCH · BLOCKED

## Now

### Privacy-scoped universal search

- **IMPLEMENTED / FINAL VERIFICATION AND HARDWARE EVIDENCE IN PROGRESS (23 August
  2026).** The native Search app accepts only shell-reviewed text and defaults to
  Apps-only. Per-window opt-in filters search launcher apps, upcoming calendar
  events, active notifications, one bounded level below file bookmarks, and
  explicitly shared synchronized Hermes cockpit sessions. Results are inert,
  source-labelled and bounded; Unicode-aware ranking/deduplication is stable;
  provider deadlines and query generations isolate slow/erroring sources and
  prevent stale publication. Memory-only one-shot action handles revalidate the
  exact app, event ID/start time, notification key, bookmarked file path/modified
  time, or public Hermes session ID/execution generation before opening. Query,
  result and filter history is not persisted or logged. Roam, terminal, media and
  health remain visibly unavailable because safe bounded search/exact-action
  identities do not yet exist; no shell, URL, notification mutation, Roam write,
  cockpit command, media control or health-history read is exposed. Focused
  synthetic coverage passes 16/16; the full host suite passes 392/392,
  prepared-platform typecheck and the JDK 21 / SDK 35 Android build pass. The
  exact candidate installed and launched as a live process on the A32, but its
  G2 transport had no active connection, so glasses navigation/open/back/filter
  evidence is not claimed. Independent frozen-SHA review, connected-G2 evidence,
  CI and remote PR read-back remain gates. See `docs/universal-search.md`.

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
  privacy. All 376 host tests, TypeScript typecheck, and the JDK 21 / SDK 35
  Android build pass. The exact debug APK SHA-256 is
  `be226031aa95fbf3b731d32a92d54c4b7935f3fa60892e379cb9144d567ea7d0`.
  No A32/G2 was attached and the private bridge was not upgraded in this run, so
  real question/deny/allow-once/steer/interrupt/completion evidence remains open.
  See `docs/hermes-agent-cockpit.md`.

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
  two-message G2 image before reporting `sent`. A clean fixed-duration candidate
  percentile remains open because another concurrent device installer replaced
  the package during the run; do not claim the target from contaminated or
  zero-frame samples. No firmware/texture-cache device command was added.

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

- **IMPLEMENTED / FOLD7 VISUAL AND POSTURE VALIDATION BLOCKED — foldable phone UI (22 August 2026).**
  Preview 2 removes the portrait lock, handles live cover/unfolded/rotation/
  tabletop/multi-window bounds, bounds wide content, preserves platform font
  scaling and 48dp controls, and retains the existing G2 compositor contract.
  Host fixture, build, APK, ABI, signing, and 16 KiB evidence are required for
  publication. The exact debug APK installed and ran as a live process on an
  SM-F966B with Android 16. Both G2 arms later reached session ready and direct
  R1 BLE connected, but no R1 HUD indicator was visible. Unlocked Hermes-phone
  visual, physical fold-transition, rotation, tabletop, and multi-window proof
  remains blocked.

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

- **DONE — enforced release governance (22 August 2026).** The merged PR #40
  follow-up removes signing secrets and APK publication from PR jobs, gives
  untrusted builds an isolated debug identity, and separates secret-free `main`
  validation from a source-free protected signing job. Vulnerability alerts and
  automated security fixes are enabled. GitHub still returned the private-plan
  branch-protection HTTP 403 at 02:39 UTC after the owner reported upgrading to
  Pro; protection remains pending entitlement propagation and API read-back.

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
- **RESEARCH — sleep.** Three CRC-valid type-2 frames establish ordered relative
  interval endpoints in seconds. Full decoding remains blocked until a matching
  type-1 summary/stage frame and the absolute time-base handoff are proven.
  `decodeSleep` must remain fail-closed.
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
- **PARTIAL — generic dynamic glasses apps (22 August 2026).** A versioned,
  provider-neutral rich view/action protocol now supports bounded lifecycle,
  CAS update/patch/close, stable component IDs, acknowledged event cursors,
  deterministic G2 rendering, and exact socket/turn/action ownership. The
  Hermes-hosted reference runtime keeps Home Assistant credentials and entity
  IDs server-side, discovers the Living Room at runtime, and permits only
  revision-checked explicit light/switch target states with conservative
  restoration. All 281 host tests, typecheck, and Android build pass. The exact
  APK installed/launched on the A32 and established a live two-arm G2 session
  with ordinary shell-frame transport ACKs. Dynamic-view/HA scroll and reversible
  private WSS hello/ack is now verified; dynamic-view/HA scroll and reversible
  toggle evidence remains blocked by unavailable private HA credentials and
  missing exact-candidate hardware execution; no such result is inferred. See
  `docs/dynamic-glasses-apps.md`.
- **BLOCKED — public MCP/skill publication.** No public skill or untrusted remote
  rendering until authenticated `wss://` server identity, compatible licensed
  adapter, credentials, generic-client behaviour, mutation/privacy gates, and
  real-G2 tool-specific evidence all pass.
- **TODO — private end-to-end bridge validation.** Exercise wakeword → bridge →
  agent → bounded tool → reply on a disposable private deployment, including
  cancellation, reconnect, stale-turn rejection, and certificate failure.

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