# Hermes G2 — Hermes Agent for Even Realities G2 glasses

Hermes G2 is an unofficial, owner-only Android companion and glasses runtime for
an already-provisioned Even Realities G2. It provides a private, voice-first
Hermes Agent interface on the glasses and a bounded control/status surface on the
phone, with optional direct R1 health data.

This project is not created, endorsed, or supported by Even Realities. It is
development software with no warranty. Custom firmware can void the hardware
warranty and can permanently damage a device.

## What it is

The current target is deliberately narrow: one authorised Fold7, one
already-provisioned G2, an optional paired R1, and one authenticated private
Hermes gateway. The project is proving a dependable owner loop on that setup;
it is not pursuing public distribution or a broad feature backlog.

`main` is the only canonical development branch. The exact current support and
release posture is in [`STATUS.md`](STATUS.md). The only active milestone is
[`v1.0.0-preview.3 — Owner Hermes Loop`](ROADMAP.md);
[issue #59](https://github.com/not-benny/hermes-g2/issues/59) is its sole tracker.

## Verified in the owner envelope

- Upgrade/install/launch on an arm64 Fold7 running Android 16.
- Two-arm G2 connection, bounded rendering and wearer input.
- Authenticated private `wss://` transport with exact connection and operation
  ownership.
- Phone-side status and settings, notification mirroring, core voice capture,
  media/navigation/tools, and the multitasking glasses shell.
- R1 battery, read-only firmware version, live/current-hour heart rate, hourly
  heart-rate/SpO2/HRV history, and confirmed 10-minute activity/calorie buckets.
- Host tests, TypeScript typechecking, Android builds, release-surface checks,
  16 KiB alignment checks, and debug-control exclusion on the reviewed main
  baseline.

These claims apply only to the evidenced owner setup and source revision. They
are not general device, firmware, recovery, or support guarantees.

## Implemented but experimental

- The phone Hermes companion and native glasses cockpit. Their local TLS-WSS and
  adversarial gateway tests pass, but the real licensed-provider deployment is
  the remaining Preview 3 acceptance gate.
- Background assistant tasks, captions and translation, universal search,
  notification digests, contextual dashboards, motion calibration, terminal
  mirroring, weather/calendar/timers, games, screenshots, and recording.
- Fold7 unfolded/tabletop/split-screen and TalkBack operation as a complete
  physical matrix.
- Direct Anthropic/OpenAI and downloaded on-phone model fallback.

Implemented does not mean accepted for daily use. Component contracts and honest
remaining limits live under [`docs/`](docs); dated investigation and protocol
evidence under [`notes/`](notes) does not redefine project status.

## Not supported

- First-time G2 or R1 pairing, provisioning, ownership transfer, or recovery.
- R1 sleep decoding, R1 DFU/OTA, reset, wipe, NVM mutation, host rebinding, or
  power control.
- Release-build G2 firmware flashing or recovery assurance.
- Public MCP/skill publication, untrusted remote rendering, arbitrary remote
  control, production Home Assistant mutation, or live WhatsApp pairing.
- Play Store/public release or a production signing identity. Protected
  publication is disabled and the owner install still uses a development
  certificate.

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

Do not uninstall Even yet. Hermes does not perform first-time provisioning or
standalone R1 firmware maintenance.

## Hermes gateway

Configure the Hermes Agent bridge under **Settings > Assistant** with a reachable
certificate-validated `wss://` endpoint and shared token. The bridge exposes
bounded, provider-neutral projections; it does not return credentials, prompts,
reasoning, raw tool arguments/results, or unshared work.

Direct-provider mode remains available as a fallback and uses its own provider
credentials. Those credentials are not used by the bridge. Public deployment
and generic-client publication remain blocked; see
[`docs/release-security.md`](docs/release-security.md) and
[`docs/hermes-agent-cockpit.md`](docs/hermes-agent-cockpit.md).

## R1 health boundary

Hermes exchanges a bounded, positive-allowlisted health session over the bonded
BLE link. It does not expose pairing, ownership, provisioning, NVM, power,
firmware, reset, wipe, or destructive command families. Frames are envelope,
CRC, shape, generation, and current-day validated before persistence.

Sleep remains unavailable. CRC-valid type-2 frames establish relative intervals,
but the absolute time base and type-1 summary/stage layout are not proven, so
`decodeSleep` deliberately throws. Start with [`docs/ring-health`](docs/ring-health)
and [`notes/ring-wire-format-2026-08-20.md`](notes/ring-wire-format-2026-08-20.md).

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
