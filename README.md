# Hermes G2 - Hermes Agent for Even Realities G2 glasses

Hermes G2 is an unofficial, owner-only Android companion for an
already-provisioned Even Realities G2. It provides a bounded phone surface and,
on the owner's device already running the reviewed custom firmware, a
voice-first Hermes Agent runtime on the glasses. Stock-firmware use is limited
to phone-preview mode. Optional direct R1 health data is also available.

This project is not created, endorsed, or supported by Even Realities. It is
development software with no warranty. Custom firmware can void the hardware
warranty and can permanently damage a device.

## What it is

The current target is deliberately narrow: one authorised Fold7, one
already-provisioned G2 already running the reviewed owner custom firmware, an
optional paired R1, and one authenticated private Hermes gateway. Preview 3
authorises no firmware flash or recovery action. The project is proving a
dependable owner loop on that setup; public all-in-one distribution and broad
support remain pending rather than current claims. A reviewed source-pinned
setup is available for experienced operators, but it is not a production app
release or a broad hardware-support promise.

`main` is the only canonical development branch. The exact current support and
release posture is in [`STATUS.md`](STATUS.md). The only active milestone is
[`v1.0.0-preview.3 - Owner Hermes Loop`](ROADMAP.md);
[issue #59](https://github.com/not-benny/hermes-g2/issues/59) is its sole tracker.

## Product surfaces

The implementation contains the phone companion, glasses shell, internal
assistant-result projection path, notifications, the glasses-native Work Tasks
board with encrypted phone-local storage, a durable Clock app for alarms,
timers, and world clocks, Conversate for explicit-session live transcription,
local cues, and optional low-latency Hermes auxiliary cues, an optional
read-only R1 health path, and several experimental applications. Conversate replaces the former
Transcribe launcher app, defaults to bundled on-device transcription, and keeps
its provider choice independent from assistant dictation. Evidence and acceptance levels are
intentionally not repeated here: [`STATUS.md`](STATUS.md) is the sole current
authority, while component contracts live under [`docs/`](docs) and dated
research under [`notes/`](notes).

Hermes does not perform first-time pairing, provisioning, ownership transfer,
firmware/recovery, reset, wipe, or destructive R1 operations. The public
source installer does not change those boundaries, and production signing is
not yet accepted. See
`STATUS.md` for the complete current boundary.

## Before you start

Hermes works alongside the official Even app rather than replacing it.
Complete first-time setup in Even before handing the devices over to Hermes:

1. Use the official Even app to pair and provision the G2 and R1 and to apply
   required official firmware updates.
2. In Even, open **Home**, select the glasses, open **Connection**, and press
   **Disconnect**. Even and Hermes cannot hold the glasses connection at the
   same time.
3. Keep the Even app installed, but close it or disable its Bluetooth permission
   during Hermes use. The R1 accepts one active central connection, so Even must
   release Bluetooth before Hermes can receive ring data.
4. Start Hermes and complete onboarding for Bluetooth, notification access,
   battery optimisation, and custom-firmware or phone-preview mode.

On the tested Android 16 owner setup, sensitive-notification redaction is
exempted through an owner-approved `CompanionDeviceManager` association. That
association is owner/device configuration, not an automatic Hermes action or a
general public-install guarantee.

Do not uninstall Even yet. Hermes does not perform first-time provisioning or
standalone R1 firmware maintenance.

## Hermes gateway

Configure the Hermes Agent bridge under **Settings > Assistant** with a
reachable certificate-validated `wss://` endpoint and shared token. The phone
requires Host Session MCP for voice turns and status, while Hermes uses the
phone's private Device MCP for fixed device capabilities. The launcher-visible
Hermes Cockpit uses bounded Host MCP resources for current/recent authenticated
G2 sessions and one exact command tool for listed answers, deny/allow-once
permissions, steering, and interruption. It exposes no prompt, reasoning,
partial text, tool activity, unrelated session history, or terminal fallback.
Thinking and tool progress remain private; only the final voice Host MCP result
may drive a glasses card.

The model-facing G2 surface is a separate portable workflow MCP with thirteen
reviewed intent-level tools. The checked-in distributable profile excludes raw
phone discovery, arbitrary phone calls, legacy custom chat, Cockpit, and
Companion channels, and general host toolsets. An explicitly administered
private owner profile may separately grant `browser`, `terminal`,
`file`, `skills`, `web`, `memory`, `session_search`, `cronjob`, and
`computer_use`. That local overlay does not widen the phone MCP allowlist or
become part of a distributable profile. The complete channel, workflow,
reminder, configuration, test, and release contract is in
[`docs/hermes-mcp-architecture.md`](docs/hermes-mcp-architecture.md).
The owner profile SOUL contains persona and response style only; every Hermes
workflow, command, receipt, and authority boundary is packaged in the Host,
Device, or portable workflow MCP contracts and enforced by code or configuration.
The Apache-2.0 package is maintained separately as
[`not-benny/hermes-g2-workflows`](https://github.com/not-benny/hermes-g2-workflows).
The phone-to-Hermes bridge is also separately public under Apache-2.0 at
[`not-benny/hermes-g2-bridge`](https://github.com/not-benny/hermes-g2-bridge).
The reviewed source installer, exact source locks, conservative profile, and
optional private-owner tool consent are published at
[`not-benny/hermes-g2-distribution`](https://github.com/not-benny/hermes-g2-distribution).

These boundaries do not make the assistant data plane content-free: fulfilling
an authorised request necessarily transmits the current utterance, requested
context, and authorised MCP call arguments and results between the app and the
private gateway.

Outside an active voice turn, the dedicated direct-result route first commits
the bounded final text and Fold receipt time to an encrypted phone-local FIFO.
It presents only after the current G2 session confirms the glasses are worn;
off-head or unknown wear produces no wake or beep. One-shot Hermes reminders use
a deterministic gateway outbox and that fixed delivery route. No future agent
prompt runs when a reminder fires.

Direct-provider mode remains available as a fallback and uses its own provider
credentials. Those credentials are not used by the bridge. The private MCP-only
cutover is operational. The separately published Apache-2.0 bridge, workflow,
and source-distribution packages are operational. A production-signed Android
release and general support still require separate acceptance. See
[`docs/release-security.md`](docs/release-security.md) and
[`docs/hermes-agent-cockpit.md`](docs/hermes-agent-cockpit.md).

## R1 health boundary

Hermes exchanges a bounded, positive-allowlisted health session over the bonded
BLE link. It does not expose pairing, ownership, provisioning, NVM, power,
firmware, reset, wipe, or destructive command families. Frames are envelope,
CRC, shape, generation, and time-window validated before persistence.

Complete type-1 sleep summaries are decoded fail-closed: absolute start/end,
ring score and efficiency, asleep/awake/REM/light/deep totals, 30-second stage
runs, timezone, and optional absolute nightly skin temperature. The latest
verified night persists across app closure and feeds the phone and glasses only
while current; older nights remain history. Interval-only type-2 records still
lack an absolute base and remain rejected. Start with
[`docs/ring-health`](docs/ring-health) and
[`notes/ring-sleep-frames-2026-08-20.md`](notes/ring-sleep-frames-2026-08-20.md).

## Firmware warning

The repository contains source-only research and a deterministic patch set for
one reviewed G2 firmware candidate. One owner unit reportedly booted it, but
recovery and broad compatibility are not established. Installation remains
release-disabled. Do not flash or run recovery experiments without separate
authorization and independently reviewed sacrificial recovery evidence.

Proprietary firmware binaries are not included. See
[`firmware-research/`](firmware-research),
[`notes/ring-firmware-consent-gate.md`](notes/ring-firmware-consent-gate.md),
and [`notes/ring-firmware-update-design.md`](notes/ring-firmware-update-design.md).

## Building and testing

Requirements: Node.js 20 or newer, JDK 21, Android SDK 35, NativeScript Android
prerequisites, NDK 27.2.12479018, and CMake 3.22.1.

```bash
npm ci
npm test
npm run typecheck
npm run build
```

Every push to `main` runs the guarded Android release build and publishes a
30-day Actions artifact named `hermes-g2-owner-preview-<commit-sha>`. It contains
an owner-signed, non-debuggable Preview 3 APK plus checksums, provenance, SBOMs,
and native-alignment evidence. Download it from the completed
`Protected Release Validation` run; it is an unsupported owner-preview binary,
not a Play Store or general compatibility release.

### Build, sign, and update from GitHub

The owner update helper fetches a fresh, detached GitHub snapshot, runs the
repository's guarded unsigned-release build, zipaligns and signs the APK
locally, checks its package/version/signature, and uses `adb install -r`. It
never uninstalls the current app or clears its data:

```bash
./scripts/build-sign-install-from-github.sh \
  --ref 67989dada122ab6ce04594b11e57e742441dd2dd \
  --serial YOUR_ADB_SERIAL
```

Pass a full commit SHA with `--ref` for a repeatable build. `--adb-port`
supports a non-default ADB server. Use
`--build-only` (or `--no-install`) to produce and verify the signed APK while no
phone is connected. The helper requires the repository-pinned Android SDK
build-tools 35.0.1 and NDK 27.2.12479018. It honors a JDK 21 `JAVA_HOME`, or
discovers a standard local JDK 21 installation when `JAVA_HOME` is unset.

If it exists, the calling owner's standard Android debug keystore is the
default. For another keystore, pass `--keystore` and `--key-alias`, and export
`HERMES_KEYSTORE_PASSWORD` plus `HERMES_KEY_PASSWORD` if its key password is
different. Passwords are passed to `apksigner` through its environment password
provider and are not printed. The script stops before installation if the
installed signer differs or the fetched version is older. The explicit
`--allow-signer-mismatch` and `--allow-downgrade` overrides only permit an ADB
attempt; they never authorize uninstalling or clearing data, and Android may
still reject an incompatible signature or downgrade.

The owner upgrade path is proven for exact GitHub source commit
`67989dada122ab6ce04594b11e57e742441dd2dd`. It passed 971/971 full tests,
155/155 focused lifecycle and cross-component tests, 22/22 focused performance
and privacy tests, TypeScript typecheck, diff checks, CI, and unsigned-production
verification. The unsigned verifier SHA-256 is
`8412ab0440a2513bf2020fd020b8bb62a2525758f0a11fcb7b1c80b2cc066cc3`.

The source was fetched from GitHub, built, signed with the existing owner
signer, and installed upgrade-in-place. Android preserved the package, UID,
`firstInstallTime`, and app data; a warm launch succeeded with no crash markers.
The signed APK SHA-256 is
`1a90cd8998e2d2bd166d8580cbfcc456d498fd9fe7a3c5d1f19423bf3789651b`.
This is owner-install evidence, not physical worn-lens acceptance, production
signing, or a public all-in-one release claim.

The current implementation merged to public `main` at
`74e7224f55930a3964c79e118f1c5b6b1b0cc8b1`. The permanent tag
`distribution-v0.1.1-android-source` keeps the exact installed build input
reachable. Earlier tags `distribution-v0.1.0-android-source` and
`owner-preview3-installed-source-20260825` retain the preceding Preview 3 build
inputs as historical provenance rather than current install claims.
The current reviewed all-source setup is published as distribution prerelease
[`v0.1.1`](https://github.com/not-benny/hermes-g2-distribution/releases/tag/v0.1.1)
from distribution `main` commit
`7c7f9d685c53b3ef374d9ee2716ee434c860dc74`. It passed independent review of an
exact tagged checkout, a fresh install, and an update install. The earlier
`v0.1.0` distribution release remains historical provenance only.

See [`DEVELOPMENT.md`](DEVELOPMENT.md) for repository layout, safety rules,
focused tests, and authorised-device commands.

## Privacy, support, and licence

See [`PRIVACY`](PRIVACY). Never commit bridge/provider tokens, device
identifiers, health exports, Bluetooth captures, firmware binaries, pulled
Android preferences, or private research data.

Hermes G2 is a personal development project shared as-is. Support is best effort.
It is based on [Faceclaw](https://github.com/jimrandomh/faceclaw) by James Babcock
and contributors, with firmware research building on
[g2flash](https://github.com/jimrandomh/g2flash). See
[`ACKNOWLEDGEMENTS.md`](ACKNOWLEDGEMENTS.md).

Hermes G2 is Free Software under the **GNU General Public License, version 3**.
See [`LICENSE`](LICENSE).
