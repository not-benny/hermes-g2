# Changelog

## 2026-08-20 (later the same day)

Live ring health in the HUD, verified on hardware.

- The ring's health frames now flow end to end: the BLE layer forwards
  every data-notify frame to a new decode store that reassembles and
  CRC-checks multi-packet batches and keeps the latest value per metric.
  The health probe additionally requests the ring's device status, whose
  response carries the battery percent.
- The top bar shows a live heart-rate readout (heart glyph plus bpm) and
  the ring battery gauge, verified on a real rig: heart rate, SpO2, HRV,
  activity and ring battery all decoded from a live sync
  (screenshots/launcher-health-hud-green.png).
- The onboarding wordmark is recolored for the dark theme.
- The phone app is locked to portrait orientation.

## 2026-08-20

Reliability batch, dark phone UI, ring health parser, and a bridge status
indicator.

### Connection reliability

- Ring reconnect: exponential backoff with a circuit breaker after repeated
  failures, and the wedged GATT handle is now closed before each retry so a
  returning ring can actually reconnect. Ring connect attempts use short
  fail-fast timeouts so an absent ring no longer stalls the display pipeline.
- Congestion is no longer treated as a dropped link: a soft resync gate
  (clear the image pipeline, re-assert connection priority, probe a
  heartbeat) runs before any full teardown when both arms are still
  connected and notifications are recent. Deliberate teardowns (charging
  ended, shutdown ack timeout) bypass the gate so real reconnects still
  happen.
- BLE connection priority is periodically re-asserted to stop
  connection-interval drift from blowing ack timeouts under load.
- The navigation app stops rendering and transmitting map frames while the
  screen is off, so wake commands are no longer starved by a background
  frame flood.
- In-process window renders are coalesced; the music screen skips its
  per-second tick while not visible.
- Wear detection now runs whenever the glasses are connected instead of only
  when the lock screen feature is enabled.
- Brightness changes are debounced.
- The assistant bridge WebSocket gained a client ping, a liveness watchdog,
  and reconnect backoff with jitter, so half-open connections are detected
  and recovered.

### Phone companion UI

- Full dark theme for every phone page, with the Even green accent.
- Native text inputs are now legible (light text on dark fields) on the
  main, device configuration, and API key pages.

### Ring health

- New pure-Typescript decoder for the R1 ring daily health push:
  multi-packet reassembly with CRC32 verification, heart rate, SpO2,
  temperature, HRV, activity records, and ring battery. Covered by a
  dedicated test suite. On-device wiring into the HUD is in progress.

### HUD

- New top-bar indicator showing the assistant bridge connection state
  (connected, connecting, or disconnected), drawn next to the brightness
  and battery block when an external assistant backend is configured.

### Build

- Native llama library is linked with 16 KB page alignment, fixing the
  Android 15 compatibility warning on 16 KB page-size devices.
- Glasses screen previews and captures render in the display's green
  phosphor tone instead of grayscale.

## Earlier

The initial public snapshot: the Faceclaw-based app, the R1 ring health BLE
protocol write-up under docs/ring-health/, and the g2flash 2.2.6.10 to
2.2.8.4 firmware research under firmware-research/.
