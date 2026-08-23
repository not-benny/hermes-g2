# Hermes G2 — Hermes Agent for Even Realities G2 glasses

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
dependable owner loop on that setup; it is not pursuing public distribution or
a broad feature backlog.

`main` is the only canonical development branch. The exact current support and
release posture is in [`STATUS.md`](STATUS.md). The only active milestone is
[`v1.0.0-preview.3 — Owner Hermes Loop`](ROADMAP.md);
[issue #59](https://github.com/not-benny/hermes-g2/issues/59) is its sole tracker.

## Product surfaces

The implementation contains the phone companion, glasses shell and cockpit,
assistant/voice path, notifications, optional read-only R1 health path, and
several experimental applications. Their evidence and acceptance levels are
intentionally not repeated here: [`STATUS.md`](STATUS.md) is the sole current
authority, while component contracts live under [`docs/`](docs) and dated
research under [`notes/`](notes).

Hermes does not perform first-time pairing, provisioning, ownership transfer,
firmware/recovery, reset, wipe, or destructive R1 operations. Public
distribution and production signing are also blocked. See `STATUS.md` for the
complete current boundary.

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
certificate-validated `wss://` endpoint and shared token. The phone companion
and glasses cockpit receive bounded, provider-neutral session projections; those
projection channels do not expose credentials, provider prompts/reasoning, raw
tool arguments/results, or unshared work. This is not a claim about the
assistant data plane: fulfilling an authorised request necessarily transmits the
current utterance, requested context, and authorised MCP call arguments/results
between the app and the private gateway.

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
