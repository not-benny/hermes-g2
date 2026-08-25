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

This phase is about proving that loop in daily use. It is not a public Android
release, a generic MCP platform, a firmware product, or a mandate to finish every
experimental feature in the repository.

## Canonical repository state

| Area | State |
| --- | --- |
| Development base | `main`, exclusively |
| Application baseline | Current owner candidate: 873 host tests, TypeScript, JDK 21 / Android SDK 35 debug build, install, launch, and MCP cutover verification passed |
| Android identity | `versionCode 1000003`, `versionName 1.0.0-preview.3`; this identifies the next internal candidate, not a published release |
| Pull requests | One focused PR at a time, based on current `main` |
| Active work | [Issue #59](https://github.com/not-benny/hermes-g2/issues/59) only: prove the real owner Hermes loop |
| Publication | Disabled; repository variable `PROTECTED_RELEASE_ENABLED` remains `false` |
| Installed identity | The owner installation still uses the legacy Android development certificate; same-certificate APKs are internal upgrade evidence only |

## Supported owner envelope

- Fold7 on Android 16, arm64, using upgrade-in-place with the existing owner
  certificate.
- An already-provisioned two-arm G2 session. The existing reviewed owner custom
  firmware is required for the full 640×480 glasses runtime; stock firmware is
  limited to phone preview. No flash or recovery is in scope.
- Authenticated private `wss://` transport and fail-closed connection ownership.
- When the optional R1 is connected: direct battery, firmware-version,
  heart-rate, SpO2, HRV, activity, and calorie polling. The official Even app
  must release its R1 connection first.
- Phone settings, notification mirroring, glasses shell lifecycle, bounded
  rendering, and bounded wearer input within the single owner setup.

## Implemented and privately accepted

- The authenticated private gateway now uses the MCP-only interaction contract
  in [`docs/hermes-mcp-architecture.md`](docs/hermes-mcp-architecture.md). Host
  Session MCP owns final-only voice turns and status; the private phone Device
  MCP owns fixed device capabilities; the portable workflow MCP is the only
  model-facing G2 workflow surface. SOUL is persona-only, native skills and
  registrations are absent, and custom chat/Cockpit/Companion channels are
  inert. Runtime inventory and independent review found no raw G2 proxy,
  terminal, code-execution, delegation, or browser-exec route.
- The final private deployment was healthy after restart with an authenticated
  phone WSS and the Hermes workflow child running under the reviewed isolated
  interpreter. The rebuilt Fold package launched and Hermes Cockpit reported
  Host MCP online. This is private owner evidence, not a public deployment or a
  physical lens acceptance claim.

## Implemented but not yet accepted

- The final physical worn-glasses result path on the exact installed candidate.
  The phone and gateway connection is proven, but the glasses BLE session was
  offline during the final MCP cutover check, so the sleeping long-press to one
  strict-acknowledged lens result still needs a fresh run.
- The complete provider-backed voice loop, background tool work, and
  media/navigation/tool workflows on the exact Preview 3 artifact. Intermediate
  thinking, drafts, and tool activity are now suppressed at the glasses
  boundary; fresh completed voice/cockpit/Codex results use a retained wake +
  strict frame-ACK path and compact viewport-aware cards. The private `even-g2`
  deployment also has an exact-profile, final-only `glasses.notify_result`
  route backed by a bounded encrypted Fold-local FIFO. Unknown/off-head wear
  queues without wake or beep; a fresh current-session worn state presents the
  phone-receipt timestamp, and strict ACK replaces private text with a
  content-free retry tombstone. One-shot Hermes reminders use a deterministic
  durable gateway outbox and direct fixed phone route, with no model session or
  prompt at fire time. Hardware proof remains pending. Acknowledged result cards
  remain until wearer Dismiss/Back or the global screen timeout; legacy transient
  alerts start their private timer only after frame acknowledgement.
- Conversate (the replacement for Transcribe) provides explicit foreground-only
  sessions, bundled on-device transcription by default, independently selected
  cloud transcription, volatile live text, and transparent local action/question/topic
  cues. It never records raw audio or persists transcript text. The compact ring
  UI, generation-bound pause/end flow, provider-final flush, and host tests are
  implemented; live microphone and optical hardware acceptance remain pending.
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
- Fold7 unfolded, tabletop, split-screen, and TalkBack operation as a complete
  physical matrix.
- Public-facing release mechanics. The unsigned production surface and signing
  gates are tested, but no approved production signing identity exists.

These are not parallel feature tracks. A failure matters now only when it blocks
the active owner loop or exposes a security, privacy, data-loss, or hardware risk.

## Unsupported and deliberately blocked

- First-time G2 or R1 pairing, provisioning, ownership transfer, or recovery.
- R1 sleep decoding, DFU/OTA, reset, wipe, host rebinding, NVM mutation, or
  power-control commands.
- G2 firmware flashing or recovery from a release build.
- Public distribution of the current native bridge, untrusted remote rendering,
  HTML/CSS/script or raw-layout generated interfaces, arbitrary remote
  actions/control, raw Browser Harness execution, or production Home Assistant
  mutation. The Apache portable workflow MCP is a separate publication unit;
  it does not cure the native bridge's redistribution block.
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

The protected workflow must remain unable to publish while
`PROTECTED_RELEASE_ENABLED=false`. The current owner certificate has an
`Android Debug` subject and is not a production identity. A non-debuggable APK
signed with it may be used only for controlled same-owner upgrade validation and
must be labelled internal-only.

Production signing and app-data migration are deferred in
[issue #69](https://github.com/not-benny/hermes-g2/issues/69). They become active
work only if the owner explicitly chooses public or production distribution
after the owner-preview milestone. The permanent technical contract is in
[`docs/release-security.md`](docs/release-security.md).

## Immediate next action

Do not add another feature. Reconnect the authorised G2, then execute the
sleep-origin final-result, reminder, Clock, Work Tasks, weather, trains, and
ring-stop acceptance rows in [`ROADMAP.md`](ROADMAP.md) against the exact
installed candidate. Record the results on issue #59 and fix only blockers
found by that run. Public work remains limited to the licensing, containment,
artifact, and signing gates documented in `docs/hermes-mcp-architecture.md` and
`docs/release-security.md`.
