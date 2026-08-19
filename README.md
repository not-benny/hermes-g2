# Hermes G2: Hermes Agent for Even Realities G2 glasses

Hermes G2 is an unofficial Android interface for the Even Realities G2 smart
glasses, built around Hermes Agent. It provides a multitasking glasses UI,
voice interaction, notifications, media controls, navigation, terminal mirroring,
and other utilities.

This project is not created, endorsed, or supported by Even Realities. It is
development software with no warranty. Using its custom glasses firmware may
void your hardware warranty and carries the normal risks of firmware flashing.

## Assistant backends

**Hermes Agent bridge is the preferred and default backend.** The phone dials
out to a Hermes Agent bridge over a websocket, streams assistant turns, and
serves the glasses' dynamic tools over MCP. This lets Hermes Agent answer voice
queries, operate glasses tools during a turn, and, when the user setting allows
it, perform rate-limited proactive actions such as showing an alert.

Configure the connection under **Settings > Assistant**:

- **Assistant backend:** `Hermes Agent (bridge)` (default)
- **Hermes Agent host:** hostname or IP address reachable by the phone
- **Hermes Agent port:** `8790` by default
- **Hermes Agent token:** the shared bridge token
- **Allow proactive Hermes actions:** optional master gate

The companion `hermes-g2-bridge` uses the existing websocket v1 protocol. A
server compatible with that protocol can also be used; the app retains the v1
`ctl`, `chat`, and `mcp` channels for interoperability with upstream bridge
implementations.

**Direct provider mode remains available as a fallback.** Select
`Direct provider (fallback)` to call Anthropic or OpenAI with your own API key,
or to use the downloaded on-phone model. Direct-provider settings do not affect
the Hermes Agent bridge.

## Features

- Voice input triggered by “Hey Even,” with on-device transcription by default
  and optional Deepgram, OpenAI Whisper, ElevenLabs, or Soniox transcription.
- Hermes Agent integration with streamed replies, MCP glasses tools, and
  optional proactive actions.
- Direct Anthropic/OpenAI and downloaded on-phone model fallback.
- Multitasking with an app launcher, switcher sidebar, and lock screen.
- Android notification mirroring, actions, dismissal, and quick reply.
- Media playback controls and media-library navigation.
- Terminal mirroring through
  [g2mirror](https://github.com/jimrandomh/g2mirror), including voice input.
- Turn-by-turn navigation with a user-provided Mapbox token.
- Weather, calendar, timers, Nightscout, games, and other glasses apps.
- Phone-side display preview, simulated ring input, screenshots, and recording.
- Connection management, power management, and official-app conflict detection.

## Ring health protocol (reverse engineering)

This repo includes reverse engineering notes for reading health data (heart rate,
SpO2, HRV, temperature, steps, calories, sleep) from the Even Realities R1 ring
over BLE, direct from the ring, with no cloud account and no firmware changes. The
headline finding is that the ring was never auth walled: the long standing "the
ring ignores third party apps" behavior is BLE contention between two central apps,
not authentication. See [docs/ring-health](docs/ring-health) for the full protocol
writeup, a self testing frame decoder, and the capture method.

## Firmware warning

Hermes G2 embeds a deterministic patch set for the reviewed 2.2.8.4 candidate
(`bf143aa220d634969fc7ea856716bfccd6cf197fe93f41bec2b87ebd8add7584`)
so the Android build and firmware research stay synchronized. Static checks pass,
but the candidate has not completed hardware testing or recovery validation.
**Firmware installation is enabled in this owner build.** The native writer accepts
only the pinned stock 2.2.8.4 image or its exact reviewed CFW derivative; this does
not establish that either image is recoverable after a failed write.

The full glasses UI requires custom firmware for 640×480 framebuffer access and
wear/wake integration. Firmware flashing can fail or brick a device: read every
warning, keep both lenses powered and nearby, and disconnect the official Even app
before choosing Flash Now.

## Building

Requirements:

- Android SDK 35 with licenses accepted
- JDK 21
- Node.js 20 or newer with npm
- NativeScript CLI and the Android build prerequisites
- Android NDK and CMake packages used by the native audio/model components

Install dependencies, run tests and typechecking, then build:

```bash
npm ci
npm test
npm run typecheck
npm run build
```

To install a build, connect an authorized Android device with `adb` and use the
NativeScript Android run command. No phone is needed for tests or compilation.

## Privacy

See [PRIVACY](PRIVACY). The bridge and direct-provider fallback have different
data paths, and the selected transcription provider has its own policy. Bridge
tokens and API keys are secrets. The configuration helper scripts read and
write Android shared preferences; never commit or share a pulled settings file.

## Support and status

Hermes G2 is a personal project shared as is. There is no warranty of any kind,
express or implied, and no guarantee of fitness for any purpose. See the GPLv3
license for the full disclaimer.

Support is best effort and limited. The author maintains this in spare time around
a day job, so issues and pull requests may take a while, and some may not be
answered at all. Bug reports and fixes are welcome, but please do not expect
commercial support or a fast response. Running the app, using the cloud and voice
integrations, and especially flashing custom firmware are entirely at your own risk.

The firmware research under [firmware-research](firmware-research) documents porting
g2flash to 2.2.8.4. The author has flashed the candidate and it runs on their
hardware, but flashing custom firmware still risks bricking the glasses, the
recovery path is not documented, and there is no warranty. Read its README before
flashing anything.

## Upstream and license

Hermes G2 is based on [Faceclaw](https://github.com/jimrandomh/faceclaw), created
by James Babcock and its contributors. The custom firmware work builds on
[g2flash](https://github.com/jimrandomh/g2flash) and the broader G2 firmware
community. The fork intentionally retains the upstream architecture, websocket v1
compatibility, internal Java package and class names, firmware compatibility
identifiers, and project history in this initial rebrand. See
[ACKNOWLEDGEMENTS.md](ACKNOWLEDGEMENTS.md) for additional third-party credits.

Hermes G2 remains Free Software distributed under the **GNU General Public
License, version 3 (GPLv3)**. See [LICENSE](LICENSE). Changes must continue to
comply with the GPL and retain applicable copyright and attribution notices.
