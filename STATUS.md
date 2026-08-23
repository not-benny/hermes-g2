# Hermes G2 status

Current as of 23 August 2026.

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
flash or recovery action.

This phase is about proving that loop in daily use. It is not a public Android
release, a generic MCP platform, a firmware product, or a mandate to finish every
experimental feature in the repository.

## Canonical repository state

| Area | State |
| --- | --- |
| Development base | `main`, exclusively |
| Application baseline | The integrated code from PR #68; 579 host tests, TypeScript, Android build, release-surface verification, and the 74-test cross-feature matrix passed before merge |
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

## Implemented but not yet accepted

- The real licensed-provider path for the phone Hermes companion and glasses
  cockpit. Local TLS-WSS and adversarial fake-gateway tests pass; live provider
  evidence is still missing.
- The complete provider-backed voice loop, background tool work, and
  media/navigation/tool workflows on the exact Preview 3 artifact.
- Captions and translation, universal search, notification digests, contextual
  dashboards, motion calibration, and longer-running background assistant work.
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
- Public MCP/skill publication, untrusted remote rendering, arbitrary remote
  control, or production Home Assistant mutation.
- Live WhatsApp pairing, Play Store/public distribution, or support claims for
  phones and firmware outside the evidenced owner setup.
- Installing an APK signed by a different identity over the owner installation
  without an explicitly approved data-migration plan.

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

Do not add another feature. Configure one licensed private Hermes gateway and
execute the authorization gate and acceptance checklist in
[`ROADMAP.md`](ROADMAP.md) against the Fold7/G2 setup and, if explicitly
authorised, the optional R1. Record all results on issue #59; fix only blockers
found by that run.
