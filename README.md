# Hermes G2 — Hermes Agent for Even Realities G2 glasses

Hermes G2 is an unofficial Android interface for the Even Realities G2 smart
glasses. It provides a multitasking glasses UI, voice interaction, notification
actions and replies, media controls, navigation, terminal mirroring, timers,
calendar and weather tools, and direct Even R1 ring-health support.

This project is not created, endorsed, or supported by Even Realities. It is
development software with no warranty. Custom firmware can void the hardware
warranty and can permanently damage a device.

## Project status

The repository's previously split development histories were consolidated onto
`main` on 21 August 2026. `main` is now the canonical branch for application
code, tests, documentation, ring-protocol research, and the glasses-firmware
research archive. Historical task branches may remain briefly for auditability,
but should not be used as development bases.

The current application code has passed the full host test suite, TypeScript
typechecking, and an Android build with JDK 21 and Android SDK 35 on its reviewed
integration lineage. The startup connection-race fix was also verified on a
real two-arm G2 session. These checks are evidence for that source revision,
not a guarantee for every phone, firmware version, or hardware unit.

Development preview 2 adds static Fold7/foldable compatibility: the phone UI is
resizable, responds to live application-window bounds across fold, rotation and
multi-window changes, bounds wide-screen forms, keeps 48dp touch targets, and
uses Android's edge-to-edge-aware NativeScript 9 runtime. The APK is arm64-only
and 16 KiB page-size verified. The exact preview APK was installed, launched,
and observed as a live process on an SM-F966B running Android 16. Because the
initial install observation was locked/Dozing; later both G2 arms reached session
ready and the direct R1 BLE session connected. Unlocked Hermes-phone visual
behavior and physical fold transitions, rotation, tabletop, and multi-window
remain unverified, and the owner observed no R1 indicator on the glasses HUD.

## Before you start

Hermes currently works alongside the official Even Realities app rather than
replacing it completely. Complete first-time setup in Even before handing the
devices over to Hermes:

1. Use the official Even app to pair and provision the G2 glasses and R1 ring,
   and to apply required official firmware updates.
2. In Even, open **Home**, select the glasses, open **Connection**, and press
   **Disconnect**. Even and Hermes cannot hold the glasses connection at the
   same time.
3. Keep the Even app installed, but close it or disable its Bluetooth
   permission during Hermes use. The R1 permits only one active central connection, so Even
   must release Bluetooth before Hermes can receive live ring data.
4. Start Hermes and complete onboarding for Bluetooth, notification access,
   battery optimisation, and either custom-firmware or phone-preview mode.

Do not uninstall Even yet. Hermes does not perform first-time R1 provisioning or
standalone R1 firmware maintenance.

## Features

- Voice input triggered by “Hey Even”, with on-device transcription by default
  and optional Deepgram, OpenAI Whisper, ElevenLabs, or Soniox transcription.
- Hermes Agent bridge integration with streamed replies and bounded MCP tools.
- Direct Anthropic/OpenAI and downloaded on-phone model fallback.
- Multitasking launcher, switcher sidebar, lock screen, and phone-side preview.
- Android notification mirroring, dismissal, actions, and direct voice replies.
- Configurable notification text size and event-specific glasses beeps.
- Media playback, library browsing, and per-source filtering.
- Turn-by-turn navigation with a user-provided Mapbox token.
- Terminal mirroring through
  [g2mirror](https://github.com/jimrandomh/g2mirror), including voice input.
- Weather, calendar, timers, Nightscout, games, screenshots, and recording.
- R1 battery, firmware version, live/current-hour heart rate, hourly
  heart-rate/SpO2/HRV history, and confirmed 10-minute activity/calorie buckets.

## Hermes Agent bridge and MCP status

The Hermes Agent bridge is the preferred backend. Configure it under
**Settings > Assistant** with a reachable host, port, and shared token. The app
accepts encrypted `wss://` bridge endpoints; public deployment is still blocked
until the external server, certificate identity, licensed adapter, credentials,
and generic-client behaviour are independently demonstrated.

The private-evaluation `glasses.render_view` surface is bounded, revision-owned,
rate-limited, TTL-limited, inert, and does not wake or steal focus. Normal shell
transport and wearer input have been hardware-verified, but this does not
constitute authorisation to publish a public MCP skill or expose remote rendering
to untrusted clients. See [docs/mcp-glasses-display.md](docs/mcp-glasses-display.md).

Direct-provider mode remains available as a fallback and uses its own provider
credentials; those credentials are not used by the bridge.

WhatsApp pairing is disabled in release builds while live-pair custody and the
embedded Node 16 KiB page-size gate remain open. Terminal/g2mirror requires TLS
for non-loopback hosts. See [release security](docs/release-security.md).

## R1 ring-health protocol

Hermes exchanges bounded R1 health-session traffic directly over the bonded BLE
link. Session setup includes the captured `healthEnable` and one-shot
`systemTime` writes before read requests; these are positive-allowlisted and are
not pairing, ownership, provisioning, NVM, power, or firmware operations. The ring is not
blocked by a per-app application-layer authentication wall; the practical
failure mode is contention when multiple central apps try to control the single
command session.

The checked-in implementation validates the transport and inner envelopes,
requires current-day activity anchors, and fails closed on malformed or stale
data. Daily vital headers carry a signed timezone, local-midnight day base,
current-value timestamp, current reading, and fixed-stride hourly records.
Activity uses confirmed 10-minute step and active/total-calorie buckets.

Sleep remains deliberately unavailable. Three CRC-valid type-2 sleep frames
confirm relative start/end intervals in seconds, but the absolute time-base and
type-1 summary/stage layout are not yet proven. `decodeSleep` therefore remains
a throwing stub. Start with [docs/ring-health](docs/ring-health) and the canonical
wire reference in `notes/ring-wire-format-2026-08-20.md`.

## Firmware warning

Hermes includes a deterministic patch set for the reviewed G2 2.2.8.4 custom
firmware candidate. The owner has reported one successful flash and boot on one
unit, but recovery has not been independently validated and compatibility with
other units or firmware revisions is not established. The native writer accepts
only the pinned stock image or its exact reviewed derivative; this is not a
recovery guarantee.

The full 640×480 glasses UI requires custom firmware, but installation is
release-disabled. Do not flash or run recovery experiments without separate
authorization and independently reviewed sacrificial recovery evidence. The supporting source-only research is under
[firmware-research](firmware-research); proprietary firmware binaries are not
included.

Hermes does **not** build or perform standalone R1 firmware updates. Ring DFU,
pairing ownership, NVM provisioning, reset, wipe, and destructive command
families remain blocked. See `notes/ring-firmware-consent-gate.md` and
`notes/ring-firmware-update-design.md`.

## Building and testing

Requirements:

- Node.js 20 or newer with npm
- JDK 21
- Android SDK 35 with licences accepted
- NativeScript Android prerequisites
- Android NDK 27.2.12479018 and CMake 3.22.1

```bash
npm ci
npm test
npm run typecheck
npm run build
```

To launch on a connected authorised Android device, use the NativeScript Android
run command. Tests and compilation do not require a phone. See
[DEVELOPMENT.md](DEVELOPMENT.md) for repository layout, safety rules, and focused
validation commands.

## Privacy and private research data

See [PRIVACY](PRIVACY). Bridge tokens, provider keys, device identifiers, health
exports, Bluetooth captures, firmware binaries, and pulled Android preferences
are sensitive. Never commit `secrets.local.md`, `ground-truth-private/`, raw
health captures, MAC addresses, tokens, or generated settings exports.

## Support, upstream, and licence

Hermes G2 is a personal development project shared as-is. Support is best effort
and there is no guarantee of response, compatibility, fitness, or recovery.

Hermes G2 is based on [Faceclaw](https://github.com/jimrandomh/faceclaw) by James
Babcock and contributors. The firmware work builds on
[g2flash](https://github.com/jimrandomh/g2flash) and broader community research.
See [ACKNOWLEDGEMENTS.md](ACKNOWLEDGEMENTS.md) for credits.

Hermes G2 is Free Software under the **GNU General Public License, version 3**.
See [LICENSE](LICENSE).