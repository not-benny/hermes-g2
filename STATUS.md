# Hermes G2 status

Current as of 25 August 2026.

This is the only document that defines the project's current product and
operational state. `README.md` explains the product, `ROADMAP.md` defines the
single active milestone, `docs/` contains maintained component contracts, and
`notes/` contains research or dated evidence. Historical branches, pull-request
descriptions, and notes are not alternative roadmaps.

## Product decision

Hermes G2 is an **owner-only internal preview** for one authorised setup: an
Android Fold7, an already-provisioned Even Realities G2 already running the
reviewed owner custom firmware, an optional paired R1, and one authenticated
private Hermes gateway. Its job is to provide a dependable voice-first Hermes
loop on the glasses, with truthful status and control on the phone. Stock G2
firmware is limited to phone-preview mode; Preview 3 authorises no firmware
flash or recovery action. The interaction contract is voice-initiated but
visual-first: structured results lead on the lenses, with speech/plain text as
the short fallback rather than the primary surface.

This phase is about proving that loop in daily use. It is not a supported public
Android release, a generic MCP platform, a firmware product, or a mandate to
finish every experimental feature in the repository. Main-branch CI may publish
an owner-preview APK for convenience; that artifact remains unsupported and
non-production.

## Canonical repository state

| Area                 | State                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Development base     | `main`, exclusively                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Application baseline | The current implementation merged to public `main` at `74e7224f55930a3964c79e118f1c5b6b1b0cc8b1`. Exact installed GitHub source `67989dada122ab6ce04594b11e57e742441dd2dd` passed 971/971 full tests, 155/155 focused lifecycle and cross-component tests, 22/22 focused performance and privacy tests, TypeScript typecheck, diff checks, CI, and unsigned-production verification. The permanent tag `distribution-v0.1.1-android-source` retains that exact build input                                                          |
| Android identity     | `versionCode 1000003`, `versionName 1.0.0-preview.3`; this identifies the next internal candidate, not a published release                                                                                                                                                                                                                                                                                                                                                                                                          |
| Pull requests        | One focused PR at a time, based on current `main`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Active work          | [Issue #59](https://github.com/not-benny/hermes-g2/issues/59) only: prove the real owner Hermes loop                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Publication          | Source repositories and the source-pinned installer are public. Main pushes now publish a 30-day, owner-signed Preview 3 APK Actions artifact labelled unsupported/non-production. Distribution prerelease [`v0.1.1`](https://github.com/not-benny/hermes-g2-distribution/releases/tag/v0.1.1), from distribution `main` commit `7c7f9d685c53b3ef374d9ee2716ee434c860dc74`, passed independent tagged-checkout, fresh-install, and update-install review. The installed Android input is retained by `distribution-v0.1.1-android-source`. Protected production APK publication remains disabled; repository variable `PROTECTED_RELEASE_ENABLED` remains `false` |
| Installed identity   | The owner Fold7 has the exact `67989dada122ab6ce04594b11e57e742441dd2dd` source upgrade installed, signed with the existing owner signer. Android preserved the package, UID, `firstInstallTime`, and app data; a warm launch succeeded with no crash markers. This is internal upgrade evidence only                                                                                                                                                                                                                               |

## Supported owner envelope

- Fold7 on Android 16, arm64, using upgrade-in-place with the existing owner
  certificate.
- On the tested owner installation, Android 16 sensitive-notification redaction
  is exempted through an owner-approved `CompanionDeviceManager` association.
  That association is owner/device configuration, not an automated Hermes
  action or a general public-install guarantee.
- An already-provisioned two-arm G2 session. The existing reviewed owner custom
  firmware is required for the full 640×480 glasses runtime; stock firmware is
  limited to phone preview. No flash or recovery is in scope.
- Authenticated private `wss://` transport and fail-closed connection ownership.
- An explicitly administered private Hermes profile may add selected general
  host toolsets for the owner. This local authority is separate from the
  distributable least-privilege G2 profile and fixed phone MCP allowlist.
- When the optional R1 is connected: direct battery, firmware-version,
  heart-rate, SpO2, HRV, activity, calorie, and complete type-1 sleep polling.
  Sleep persists locally and drives freshness-bounded readiness on phone and
  glasses. The official Even app must release its R1 connection first.
- Phone settings, notification mirroring, glasses shell lifecycle, bounded
  rendering, and bounded wearer input within the single owner setup.

## Implemented and privately accepted

- The authenticated private gateway now uses the MCP-only interaction contract
  in [`docs/hermes-mcp-architecture.md`](docs/hermes-mcp-architecture.md). Host
  Session MCP owns final-only voice turns, `hermes://cockpit/state`, and the
  exact `hermes.cockpit.command`; the private phone Device
  MCP owns fixed device capabilities; the portable workflow MCP is the only
  model-facing G2 workflow surface. SOUL is persona-only, native skills and
  registrations are absent, and the legacy custom chat/Cockpit/Companion WSS
  channels are inert. The bounded MCP Cockpit supports listed answers,
  deny/allow-once permissions, steering, and interruption for exact current or
  recent authenticated G2 sessions. The distributable inventory and
  independent review found no raw G2 proxy, delegation, or general host toolset.
  A separately administered owner profile may explicitly grant `browser`,
  `terminal`, `file`, `skills`, `web`, `memory`, `session_search`, `cronjob`,
  and `computer_use` without changing the G2 MCP contracts. Consequential
  actions retain approval and this authority is never encoded in SOUL.
- The final private deployment was healthy after restart with an authenticated
  phone WSS and the Hermes workflow child running under the reviewed isolated
  interpreter. The rebuilt Fold package launched and Hermes Cockpit reported
  Host MCP online. This is private owner evidence, not a public deployment or a
  physical lens acceptance claim.
- The live private profile now runs bridge 2.1.1 at
  `8c4f979020a21ae01fd6bc5351996e342d068136` and workflows 0.4.1 at
  `8ecda2d984733328e4524c070386d3c1721f5c90`, with exact package digest
  `sha256:beab3a2170289a0f64ebeb957fd7a5c63fcaa43960c3ab293968c829eb6f9d4c`.
  Independent live discovery found all 13 workflow tools and 42 MCP tools
  across workflows, calendar, Home Assistant, and printers, plus 13 available
  private built-ins. The safe parked-card Kanban workflow is present; raw G2
  and generic Kanban tools are absent.
- Exact GitHub source commit
  `67989dada122ab6ce04594b11e57e742441dd2dd` passed 971/971 full tests,
  155/155 focused lifecycle and cross-component tests, 22/22 focused
  performance and privacy tests, TypeScript typecheck, diff checks, CI, and
  unsigned-production verification. Its unsigned verifier SHA-256 is
  `8412ab0440a2513bf2020fd020b8bb62a2525758f0a11fcb7b1c80b2cc066cc3`.
  The source was built from GitHub, signed with the existing owner signer, and
  installed as an upgrade. The signed APK SHA-256 is
  `1a90cd8998e2d2bd166d8580cbfcc456d498fd9fe7a3c5d1f19423bf3789651b`.
  Android preserved the package, UID, `firstInstallTime`, and app data; a warm
  launch succeeded with no crash markers. This proves the same-identity owner
  upgrade path, not production signing, public release, or worn-lens behavior.
- The current implementation merged to public `main` at
  `74e7224f55930a3964c79e118f1c5b6b1b0cc8b1`.
  The permanent tag `distribution-v0.1.1-android-source` retains the exact
  installed build input. Earlier tags
  `distribution-v0.1.0-android-source` and
  `owner-preview3-installed-source-20260825` retain the preceding Preview 3
  source inputs as historical provenance rather than current install claims.
- The public source-pinned setup is published at
  [`not-benny/hermes-g2-distribution`](https://github.com/not-benny/hermes-g2-distribution).
  Its reviewed
  [`v0.1.1` prerelease](https://github.com/not-benny/hermes-g2-distribution/releases/tag/v0.1.1),
  published from distribution `main` commit
  `7c7f9d685c53b3ef374d9ee2716ee434c860dc74`, pins the exact bridge, workflow,
  Hermes capability baseline, and Android source commits. Independent review
  covered an exact tagged checkout, a fresh install, and an update install.
  Hermes itself remains a prerequisite. The earlier `v0.1.0` release remains
  historical provenance only.

## Implemented but not yet accepted

- Strict type-1 R1 sleep decoding, latest-night persistence across app closure,
  and phone/glasses readiness/presentation pass synthetic host tests. Type-2
  interval-only records remain rejected. The exact owner ring still needs an
  installed end-to-end sync check.
- The final physical worn-glasses result path on the exact installed candidate.
  Build, signing, and upgrade-in-place are proven for
  `67989dada122ab6ce04594b11e57e742441dd2dd`, but the sleeping long-press to one
  strict-acknowledged lens result still needs a fresh worn-glasses run.
- The complete provider-backed voice loop, background tool work, and
  media/navigation/tool workflows on the exact Preview 3 artifact. Intermediate
  thinking, drafts, and tool activity are now suppressed at the glasses
  boundary; fresh completed voice and direct results use a retained wake +
  strict frame-ACK path and compact viewport-aware cards. Hermes Cockpit is a
  passive synchronized phone projection and cannot emit a second wearer-facing
  completion. The private `even-g2`
  deployment also has an exact-profile, final-only `glasses.notify_result`
  route backed by a bounded encrypted Fold-local FIFO. Unknown/off-head wear
  queues without wake or beep; a fresh current-session worn state presents the
  phone-receipt timestamp, and strict ACK replaces private text with a
  content-free retry tombstone. One-shot Hermes reminders use a deterministic
  durable gateway outbox and direct fixed phone route, with no model session or
  prompt at fire time. Hardware proof remains pending. Acknowledged result cards
  remain until wearer Dismiss/Back or the global screen timeout; legacy transient
  alerts start their private timer only after frame acknowledgement.
- The live gateway uses a profile-scoped `HERMES_G2_WORKFLOW_RELAY` endpoint and
  the separately published Apache workflow package. Weather accepts redundant
  UK country qualifiers; train requests distinguish exact CRS identities such
  as Liverpool Central (`LVC`) and Liverpool Lime Street (`LIV`). Fixed
  content-free relay, provider, and presentation stage codes improve diagnosis
  without recording the request, place, station, session, claim, or exception.
  The gateway, provider path, and matching phone source are deployed to the
  owner setup; provider-backed physical lens acceptance remains pending.
- The installed display transactions now enforce exact strict ownership. An
  assistant result is not installed until ordinary rendering is drained, and
  an unacknowledged result owns no invisible input layer while its exact data
  remains retryable. A voice turn that begins with the display asleep primes an
  isolated result before wake, returns to sleep after result dismissal or
  expiry, and never leaves the HUD behind. A turn that begins while the HUD is
  active preserves that HUD. Transaction-scoped teardown prevents an older
  isolated result from restoring or clearing surfaces owned by a newer turn,
  and Cockpit completion cannot duplicate the Host MCP result. These behaviors
  are installed but still require worn-lens acceptance.
- A screen-off Now Playing card is primed under isolated retained surfaces
  before unblank and commits only after its exact frame acknowledgement. Its
  play, pause, skip, dismissal, and companion release input no longer claim the
  dashboard wake. Expiry returns a sleep-origin card to sleep. Clock coverage
  retains the exact card and wake. When the covering Clock becomes terminal, it
  retires before dynamic presentation is considered, which re-exposes the music
  card without stacking another result above it. Removed-card timers cannot
  rearm off-stack.
- Fresh phone notification cards and their full detail/digest modals preserve
  exact presentation and prior-sleep ownership. A modal awaiting strict
  acknowledgement excludes Clock, remote, and dynamic presenters; Clock
  coverage of an acknowledged modal retains its wake; and strict remote or
  dynamic delivery cannot accept a covering Clock frame as its own
  acknowledgement. Cards use the exact cached Android app icon when available,
  with a deterministic app initial fallback inside optical-safe bounds. The
  message keeps its full wearer-visible width and configured notification text
  size. These source fixes are installed, but the complete worn-glasses
  acceptance matrix still needs a run on the exact artifact.
- The wearer UI now uses one 4-bit-safe design system for tone, spacing, radius,
  focus, cards, progress, and bounded motion across the HUD, launcher, menus,
  Assistant, notifications, media, Clock, and Conversate. The implementation
  and geometry tests are complete; comfort, legibility, and animation on the
  physical optics remain unverified.
- Ring and touchpad scrolling at sensitivity levels 1 through 4 accepts repeat
  input 1.25 times faster. The saved five-level setting, raw level 5 behavior,
  and all non-scroll gestures are unchanged. Physical ring responsiveness on
  the installed candidate remains unverified.
- Conversate (the replacement for Transcribe) provides explicit foreground-only
  sessions, bundled on-device transcription by default, independently selected
  cloud transcription, volatile live text, and transparent local action/question/topic
  cues. It never records raw audio or persists transcript text. While active
  capture owns the microphone, it also owns a generation-bound screen-timeout
  hold; pause, completion, failure, backgrounding, or removal releases that hold
  within a fixed bound. An owner-enabled Host MCP fast-cue lane can send recent
  transcript text to the configured auxiliary model for concise reply, question,
  and topic suggestions. That lane is tool-free, latest-wins, silent on failure,
  and never replaces immediate local cues or opens the global assistant UI. The
  compact ring UI, pause/end flow, live partial coalescing, provider-final flush,
  and host tests are implemented; live microphone and optical hardware acceptance
  remain pending.
- Universal search, notification digests, generic
  temporary contextual interfaces with intent-only pinning, motion calibration,
  and longer-running background assistant work. Contextual interfaces now
  include the implemented optional bounded deck presentation: a deterministic
  cover plus semantic-section pages, at most seven pages, local ring page
  navigation with a visual page rail, inert content-page clicks, and cover-only
  phone Pin/Unpin. Bounded numeric comparisons use phone-normalized bar charts,
  never provider coordinates or styles. The dedicated bridge policy is visual-first for structured
  answers and keeps speech/HUD text to a short summary or atomic-fact fallback. Its
  host tests pass, but the exact Fold7/G2 hardware acceptance gate has not run.
- The phone-owned Work Tasks app: a local encrypted four-lane board with
  ring-first navigation and durable task actions. Spoken creation uses one
  fixed, active-turn-only tool from the authenticated `even-g2` profile;
  identical retries are idempotent and the profile's built-in Hermes Kanban
  toolset is disabled. Host validation is implemented, but the exact Fold7/G2
  voice-to-board hardware flow is not yet accepted.
  A separate exact-turn workflow can create a card on an exact existing Hermes
  Kanban board. It creates the card blocked and unassigned, never starts a
  worker, and returns typed ambiguity, conflict, or unknown outcomes without
  falling back to Work Tasks.
- Fold7 unfolded, tabletop, split-screen, and TalkBack operation as a complete
  physical matrix.
- Public-facing release mechanics. Main pushes produce a SHA-labelled owner-
  signed Preview 3 APK artifact with checksums, provenance, SBOMs, and native
  alignment evidence. The artifact is unsupported/non-production; no approved
  production signing identity exists.

These are not parallel feature tracks. A failure matters now only when it blocks
the active owner loop or exposes a security, privacy, data-loss, or hardware risk.

## Unsupported and deliberately blocked

- First-time G2 or R1 pairing, provisioning, ownership transfer, or recovery.
- R1 DFU/OTA, reset, wipe, host rebinding, NVM mutation, or
  power-control commands.
- G2 firmware flashing or recovery from a release build.
- A supported public APK, production signing identity, Play Store release, or
  broad compatibility/support claim. The reviewed source installer and the
  public owner-preview artifact can build, sign, verify, and use Android's
  data-preserving replacement path, but neither turns the owner preview into a
  supported production release.
  Untrusted remote rendering, HTML/CSS/script or raw-layout
  generated interfaces, arbitrary remote actions/control, raw Browser Harness
  execution, and production Home Assistant mutation remain unsupported.
- Live WhatsApp pairing, Play Store/public distribution, or support claims for
  phones and firmware outside the evidenced owner setup.
- Installing an APK signed by a different identity over the owner installation
  without an explicitly approved data-migration plan.

## Retired integrations

The legacy Nightscout and Roam apps and their runtime, assistant-tool, search,
settings, and credential-management surfaces are removed. Upgrades purge their
saved URLs, graph names, encrypted tokens, pending encrypted writes, and legacy
plaintext token copies when the settings store initializes.

## Release posture

The owner-preview workflow may publish a public, 30-day Actions artifact on
`main`, but it must remain labelled unsupported/non-production and use only the
existing owner certificate (`f64ccdb8…7766d4`). The protected production
workflow must remain unable to publish while `PROTECTED_RELEASE_ENABLED=false`.
The owner certificate has an `Android Debug` subject and is not a production
identity; the preview artifact is for the evidenced owner setup only.

Production signing and app-data migration are deferred in
[issue #69](https://github.com/not-benny/hermes-g2/issues/69). They become active
work only if the owner explicitly chooses public or production distribution
after the owner-preview milestone. The permanent technical contract is in
[`docs/release-security.md`](docs/release-security.md).

## Immediate next action

Run the worn-glasses acceptance rows in [`ROADMAP.md`](ROADMAP.md) against the
installed `67989dada122ab6ce04594b11e57e742441dd2dd` artifact. Verify the
sleep-origin final result, Now Playing song-change wake and controls,
notification app icon and text legibility, notification card/detail return
state, shared UI geometry, reminder, Clock, Work Tasks, weather, trains, ring
responsiveness, and ring stop. Record the results on issue #59 and fix only
blockers found by that run. Public release work remains limited to the
remaining production-signing and support gates documented in
`docs/hermes-mcp-architecture.md` and `docs/release-security.md`.
