# Hermes G2 roadmap

Current as of 22 August 2026. `main` is the canonical branch.

**Status key:** DONE · IN PROGRESS · PARTIAL · TODO · RESEARCH · BLOCKED

## Now

### Repository and release

- **IN PROGRESS — full audit remediation and protected release path (21 August
  2026).** The candidate removes private-data logging, encrypts credential and
  token-bearing settings with verified Keystore migration/clear, makes calendar
  failures explicit, narrows foreground-service claims, disables unclosed
  WhatsApp production pairing, requires TLS for remote terminal transport,
  allowlists the R1 health-session boundary, hash-verifies native inputs, pins
  NDK/CMake/NativeScript, and adds permanent CI/CodeQL/Dependabot/SBOM/APK
  verification. Local host/build/APK and authorised A32 upgrade/launch evidence
  pass; GitHub review, CI, merge, and protection read-back are the remaining
  delivery steps. See `docs/audit-remediation-2026-08-21.md` and
  `docs/release-security.md`.

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