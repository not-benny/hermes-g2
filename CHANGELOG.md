# Changelog

This changelog records user-visible work in the Hermes G2 1.0.0 development-preview line. Experimental, hardware-limited, and deliberately unavailable capabilities are called out explicitly.

## [1.0.0-preview.3] - 2026-08-25

### Highlights

- Replaced the prompt-driven Hermes integration with an MCP-only private
  architecture: Host Session MCP for voice/status, private Device MCP for phone
  capabilities, and a portable static workflow MCP for the model.
- Added the phone-owned Work Tasks board, durable Clock alarms and timers,
  Conversate, a two-line optical HUD, grouped notification-source icons, emoji
  fallback rendering, and consolidated Window Management.
- Reworked sleeping assistant turns so thinking and tool progress never occupy
  or block the glasses. Only the final strict-acknowledged result is presented.

### Hermes and workflows

- Reduced the owner SOUL to identity and response style only. Removed native G2
  skills, tool registration, generic phone discovery/call proxies, and legacy
  custom chat, Cockpit, and Companion command channels.
- Added twelve exact high-level workflows for Work Tasks, Clock timers, Clock
  alarms, reminders, weather, National Rail departures, app/window management,
  media, navigation, notifications, ring-health summary, and calendar agenda.
- Added digest-bound, expiring exact-turn capabilities, schema-pinned private
  phone routes, deterministic operation IDs, replay protection, standard MCP
  cancellation, and typed receipt validation.
- Replaced model-driven reminder firing with a deterministic durable outbox that
  calls only the fixed proactive notification route.
- Added a status-only Hermes Cockpit using the `H` identity and Host MCP status
  resource. It exposes no transcript, tool activity, or command authority.

### Glasses reliability and UI

- Added encrypted direct-result persistence, reconnect/wear-state recovery,
  retained retry authority, strict frame acknowledgement, and transactional
  wake rollback for assistant results and reminders.
- Added a double-height pixel time/date HUD with two rows, a separator between
  phone notification sources and persistent telemetry, explicit Hermes Gateway
  state, and optical-safe sidebar/window geometry.
- Grouped HUD notification icons per source app, added drawable fallback, and
  added shared bounded emoji-to-text fallback for unsupported glyphs.
- Added paged notification digest/action menus and double-tap dismiss while
  preserving Back, Reply, Android actions, and Dismiss.
- Added a full Clock app with timers, alarms, world clocks, voice creation,
  durable Android scheduling, worn/off-head alert campaigns, visual feedback,
  and ring dismissal.

### Verification and limits

- Phone suite: 873 tests passed; TypeScript typecheck passed.
- Native gateway suite: 282 passed with one optional live test skipped.
- Portable workflow MCP: 23 tests plus current MCP SDK and plugin-doctor checks.
- Hermes capability/plugin suite: 335 tests.
- The debug APK built with JDK 21 and Android SDK 35, installed, launched, and
  reported Hermes Cockpit online. The glasses BLE session was offline during
  the final check, so a fresh physical lens acceptance run remains required.
- The private owner cutover passed review. Combined public distribution remains
  blocked because the native bridge is redistribution-prohibited. The separate
  public-web MCP is an undeployed review candidate and still requires host-level
  resource containment and prompt-injection isolation.

## [1.0.0-preview.1] - 2026-08-21

### Highlights

- Hermes G2 is an unofficial Android companion and multitasking UI for Even Realities G2 glasses, with notification actions, media, navigation, voice tools, phone controls, and direct R1 ring health.
- The repository's previously unrelated release and integration histories are consolidated onto `main`; maintained ring-health documentation and source-only firmware research are retained alongside the reviewed application tree.
- A five-step onboarding flow explains the Even hand-off, permissions, and firmware choice. Phone-only preview uses anonymous demo data and can erase that preview state when leaving.
- The R1 dashboard includes readiness, local history, charts, JSON export, battery, read-only firmware version, hourly HR/SpO2/HRV, current/current-hour HR, and confirmed 10-minute activity/calorie buckets.
- Hermes Agent bridge is the preferred assistant backend, with direct-provider and on-phone fallbacks. Public MCP/skill publication remains blocked.

### Added

- Android notification mirroring with dismissal, ordinary actions, direct voice replies, and configurable notification text sizing.
- Media-library browsing, per-source filtering, resume-last behaviour, and now-playing controls.
- Configurable glasses beeps for notifications, assistant replies/errors/tools, timers, and connection events.
- Persistent health history, fail-closed hourly identity, ring-native activity and calorie buckets, anonymous preview data, and additive export fields.
- A private-evaluation `glasses.render_view` surface with inert blocks, owner/revision checks, operation idempotency, TTL and rate limits, strict compositor receipts, and bounded gesture-event polling.
- Exact GATT callback identity/generation tracking, independent display/R1 workers, and generation-bound packet acknowledgement handling.
- Public-safe R1 protocol, provisioning-analysis, threat-model, consent-gate, and recovery-gate documentation.

### Changed and fixed

- Fixed the startup race where the native communicator's asynchronously posted initial disconnected snapshot could detach a fresh live connection. Communicator ownership is now released only after owned teardown reaches terminal disconnected state.
- Prevented stale BLE callbacks, timeout completions, worker actions, and cleanup from mutating or retiring replacement sessions.
- Bound external MCP calls to a live connection and exact originating turn, with explicit proactive-call gating and cancellation through delayed side effects.
- Disabled Android cleartext bridge transport; configured bridge endpoints must use `wss://`. This is transport policy, not proof of a trustworthy public deployment.
- Current HR refreshes through a lightweight 15-second HR-only request; full multi-metric polling remains slower and separate.
- Daily vital decoding validates signed timezone, local-midnight day base, independent current timestamp, record count, and envelope/CRC boundaries. Invalid metadata preserves permitted readings without inventing timestamps.
- Activity ingestion rejects malformed, stale, future-day, wrong-status, wrong-subcommand, and bad-CRC frames; deterministic clocks prevent date-sensitive test failures.
- Sleep research now confirms three type-2 relative start/end intervals in seconds. Full sleep decoding still fails closed because the absolute base and type-1 summary/stage layout are not proven.
- Direct-ring contention and reconnect UI now explains the Even hand-off and exposes bounded retry behaviour.

### Verification evidence

- Exact source `24274cfa5a076618afdb2306b880623aa4a94abe` passed a clean `npm ci`, all 247 host tests, TypeScript typechecking, and a JDK 21 / Android SDK 35 debug build. The released APK passed ZIP-integrity and prohibited-private-path checks before publication.
- The final reviewed application integration lineage previously reported 248/248 host tests, a passing TypeScript typecheck, and a passing Android build using JDK 21 and Android SDK 35.
- The startup connection fix was installed over the authorised Samsung A32 package with data retained; both G2 arms reached session ready, frame delivery was acknowledged, the phone displayed Connected, and real glasses input reached the shell.
- These results apply to the tested source revision and hardware session. They are not a compatibility, recovery, or production-support guarantee.

### Security and safety gates

- Glasses flashing accepts only the pinned 2.2.8.4 stock image or its exact reviewed derivative. One owner unit has reportedly booted the candidate, but recovery and broad compatibility remain unvalidated; flashing can void the warranty or brick hardware.
- Hermes does not implement standalone R1 firmware updates. R1 DFU/OTA, pairing ownership, NVM provisioning, reset, wipe, power-control, host rebinding, pair deletion, and destructive raw commands remain blocked.
- Public MCP/skill publication remains NO-GO pending authenticated server identity, licensed adapter compatibility, credentials, generic-client evidence, mutation/privacy review, and tool-specific real-G2 validation.
- Private health exports, Bluetooth captures, proprietary firmware, credentials, MAC addresses, serials, private IPs, pulled settings, and consent records must remain outside Git and release artefacts.

### Known limitations

- The official Even app remains required for first-time provisioning and official maintenance. It must release Bluetooth before Hermes can hold the glasses and R1 sessions.
- Sleep decoding remains a throwing stub. Skin temperature is sparse/daily, and R1 heart rate is current/hourly rather than a per-beat stream.
- WhatsApp self-service pairing remains blocked by the upstream Baileys `link_code_companion_reg` 400 regression.
- The complete wakeword → authenticated private bridge → agent → tool → reply path still needs end-to-end validation in the intended private deployment.
- Public `glasses.render_view`, a published Hermes G2 skill, R1 provisioning independence, and destructive firmware/recovery operations are unavailable.
- Debug APKs are not reproducible release identities; use the exact source revision and documented toolchain when comparing evidence.
