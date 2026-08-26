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
  or block the glasses. Only the single Host MCP final result may enter an exact
  strict-acknowledged presentation; Cockpit remains a passive phone projection.
  A reply from sleep returns to sleep after dismissal or expiry, while a reply
  that began with an active HUD preserves that HUD.

### Hermes and workflows

- Reduced the owner SOUL to identity and response style only. Removed native G2
  skills, tool registration, generic phone discovery/call proxies, and legacy
  custom chat, Cockpit, and Companion command channels.
- Separated the distributable least-privilege profile from an explicit local
  owner capability overlay. A private owner profile may grant reviewed general
  host tools without widening the phone MCP allowlist or moving authority into
  SOUL; browser attachment still requires Chromium's visible per-connection
  approval and consequential actions retain approval.
- Added thirteen exact high-level workflows for Work Tasks, parked Hermes
  Kanban cards, Clock timers, Clock alarms, reminders, weather, National Rail
  departures, app/window management, media, navigation, notifications,
  ring-health summary, and calendar agenda. Kanban creation requires an exact
  existing board and leaves the card blocked and unassigned without starting a
  worker.
- Added digest-bound, expiring exact-turn capabilities, schema-pinned private
  phone routes, deterministic operation IDs, replay protection, standard MCP
  cancellation, and typed receipt validation.
- Replaced model-driven reminder firing with a deterministic durable outbox that
  calls only the fixed proactive notification route.
- Added a bounded Hermes Cockpit using the `H` identity,
  `hermes://cockpit/state`, and the exact `hermes.cockpit.command`. It exposes
  current/recent authenticated G2 sessions, listed answers, deny/allow-once
  permissions, steering, and interruption without exposing prompts, reasoning,
  tool activity, unrelated sessions, or terminal access.
- Added an optional low-latency Conversate cue lane over Host MCP. Stable live
  transcript text is coalesced and sent only when the owner enables the setting;
  requests are tool-free, latest-wins, tightly bounded, and silently fall back
  to immediate local cues without showing Working or taking over the glasses.
- Scoped portable workflow calls to the reviewed profile relay endpoint through
  `HERMES_G2_WORKFLOW_RELAY`; the package no longer infers a global socket or
  receives broad profile state.
- Accepted redundant UK country qualifiers in weather lookup, disambiguated
  Liverpool Central (`LVC`) from Liverpool Lime Street (`LIV`) in the train
  contract, and added only fixed content-free failure-stage diagnostics.

### Glasses reliability and UI

- Added encrypted direct-result persistence, reconnect/wear-state recovery,
  retained retry authority, strict frame acknowledgement, and transactional
  wake rollback for assistant results and reminders.
- Drained ordinary shell rendering before installing an interactive assistant
  final, required a positive exact frame receipt, and detached any
  unacknowledged card from input while retaining its exact retry data. Sleep
  teardown now clears exact overlay identity so an old strict completion cannot
  corrupt a later assistant turn. Transaction-scoped isolation also prevents
  stale cleanup from restoring or clearing surfaces owned by a newer voice
  turn.
- Added a double-height pixel time/date HUD with two rows, a separator between
  phone notification sources and persistent telemetry, explicit Hermes Gateway
  state, and optical-safe sidebar/window geometry.
- Grouped HUD notification icons per source app, added drawable fallback, and
  added shared bounded emoji-to-text fallback for unsupported glyphs.
- Increased the effective repeat rate of ring and touchpad scrolling by 25
  percent at sensitivity levels 1 through 4. The saved five-level setting and
  raw level 5 behavior are unchanged, and non-scroll gestures are unaffected.
- Unified the wearer UI around one 4-bit-safe tone, spacing, radius, focus,
  card, progress, and motion system across the HUD, launcher, menus, Assistant,
  notifications, media, Clock, and Conversate. Fresh notification cards now
  show the exact cached Android app icon with a deterministic initial fallback
  inside optical-safe bounds, while retaining the full 576-pixel wearer-visible
  message width and the configured notification text size.
- Added paged notification digest/action menus and double-tap dismiss while
  preserving Back, Reply, Android actions, and Dismiss.
- Present fresh phone notifications as opaque, blank-first cards. A tap opens
  the existing notification dialogue, while dismissal restores the exact prior
  display state, including returning a sleep-origin presentation to sleep.
- Preserve sleep-origin ownership when Clock covers a notification card or its
  acknowledged detail/digest modal. A modal awaiting strict acknowledgement
  excludes Clock, remote, and dynamic presentation, while remote and dynamic
  strict owners reject a covering Clock frame instead of reporting a false
  acknowledgement.
- Keep the Music playlist selector on the actual playing queue item, preserve
  manual browsing, and track stable queue identity through delayed callbacks or
  queue reordering instead of jumping to the first row.
- Added a full Clock app with timers, alarms, world clocks, voice creation,
  durable Android scheduling, worn/off-head alert campaigns, visual feedback,
  and ring dismissal.
- Prevented an old assistant-only result close from blanking a replacement deck
  that is still inside its isolated wake transaction.
- Let final decks atomically replace terminal Clock feedback while active and
  pending alerts remain non-preemptible, and made strict Clock/card markers
  remain distinct after the glasses' wire quantization.
- Made screen-off Now Playing presentation blank-first: the opaque card and
  isolated retained surfaces are prepared before unblank, then committed only
  after the exact current card frame is acknowledged. Failure and supersession
  roll back only the provisional music owner.
- Route Now Playing play, pause, skip, dismiss, and companion release input
  before global dashboard activity. A card that woke sleeping glasses now
  returns to sleep on expiry and retains that state while covered by Clock. When
  the covering Clock becomes terminal, it retires before dynamic presentation
  is considered, which re-exposes the music card without stacking another
  result above it. An exactly removed card cannot rearm its timers.
- Suspend the global screen timeout only while Conversate is actively capturing
  or completing its bounded final transcript flush, then restore a full timeout
  interval without letting an older capture release a newer capture's hold.

### Verification and limits

- Exact GitHub source commit
  `67989dada122ab6ce04594b11e57e742441dd2dd` passed 971/971 full tests,
  155/155 focused lifecycle and cross-component tests, 22/22 focused
  performance and privacy tests, TypeScript typecheck, diff checks, CI, and
  unsigned-production verification. Its unsigned verifier SHA-256 is
  `8412ab0440a2513bf2020fd020b8bb62a2525758f0a11fcb7b1c80b2cc066cc3`.
- Native gateway suite: 363 passed with one optional live test skipped.
- Portable workflow MCP: 32 tests plus current MCP SDK and plugin-doctor checks.
- Hermes capability/plugin suite: 335 tests.
- The exact GitHub source was built, signed with the existing owner signer, and
  installed upgrade-in-place. Android preserved the package, UID,
  `firstInstallTime`, and app data; a warm launch succeeded with no crash
  markers. The signed APK SHA-256 is
  `1a90cd8998e2d2bd166d8580cbfcc456d498fd9fe7a3c5d1f19423bf3789651b`.
  Physical worn-glasses behavior remains separate and unverified.
- The current implementation merged to public `main` at
  `74e7224f55930a3964c79e118f1c5b6b1b0cc8b1`. The permanent tag
  `distribution-v0.1.1-android-source` retains the exact installed build input.
  The prior Preview 3 source tags remain historical provenance rather than
  current install claims.
- The Hermes G2 bridge is now separately public under Apache-2.0 at
  [`not-benny/hermes-g2-bridge`](https://github.com/not-benny/hermes-g2-bridge).
  The workflow MCP remains a separate Apache-2.0 publication. The reviewed
  source installer and exact source locks are public at
  [`not-benny/hermes-g2-distribution`](https://github.com/not-benny/hermes-g2-distribution).
  The independently reviewed source setup is published as distribution
  prerelease [`v0.1.1`](https://github.com/not-benny/hermes-g2-distribution/releases/tag/v0.1.1)
  from distribution `main` commit
  `7c7f9d685c53b3ef374d9ee2716ee434c860dc74`. Review covered an exact tagged
  checkout, a fresh install, and an update install. The earlier `v0.1.0`
  release remains historical provenance only. Production APK signing and broad
  support remain separate gates.
- The live private profile runs bridge 2.1.1 at
  `8c4f979020a21ae01fd6bc5351996e342d068136` and workflows 0.4.1 at
  `8ecda2d984733328e4524c070386d3c1721f5c90`, with exact digest
  `sha256:beab3a2170289a0f64ebeb957fd7a5c63fcaa43960c3ab293968c829eb6f9d4c`.
  Live discovery found all 13 workflow tools and 42 MCP tools.

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
- Complete type-1 sleep summaries now decode fail-closed and persist across app
  closure: ring score/efficiency, absolute interval, stage totals/runs, timezone,
  and optional nightly temperature feed freshness-bounded phone/glasses
  readiness. Relative type-2 records remain rejected.
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
- Type-2 sleep remains unavailable because its absolute base is unknown. Type-1
  nightly temperature is sparse, and R1 heart rate is current/hourly rather
  than a per-beat stream.
- WhatsApp self-service pairing remains blocked by the upstream Baileys `link_code_companion_reg` 400 regression.
- The complete wakeword → authenticated private bridge → agent → tool → reply path still needs end-to-end validation in the intended private deployment.
- Public `glasses.render_view`, a published Hermes G2 skill, R1 provisioning independence, and destructive firmware/recovery operations are unavailable.
- Debug APKs are not reproducible release identities; use the exact source revision and documented toolchain when comparing evidence.
