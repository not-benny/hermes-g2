# G2 local motion calibration

The G2 firmware can emit ordinary compass headings without emitting
`COMPASS_CALIBRATION_STARTED` or `COMPASS_CALIBRATION_COMPLETE`. The Compass app
therefore offers an explicit **local calibration** action. This workflow runs in
the phone-side motion service and sends no new BLE command.

## User workflow

1. Open Compass and wait until heading and IMU data are live.
2. Click **start local calibration**.
3. Keep the glasses approximately level and slowly turn through a full circle.
4. The screen shows accepted heading, level-neutral, and heading-sector progress.
   Click again to cancel.

Collection is bounded to 30 seconds. Success requires at least 24 filtered
heading samples spanning six of eight 45-degree sectors plus eight level-neutral
IMU samples. A timeout, unavailable stream, explicit cancellation, session
replacement, screen-off, or process restart does not persist an in-progress
calibration. Firmware calibration-start takes precedence and resets collection
so local samples cannot satisfy a later firmware-complete event.

## Truth and privacy boundaries

- Local completion persists quality `poor`, not `fair` or `good`: the phone saw
  sufficient sensor/neutral evidence, but did not prove firmware calibration or
  wearer boresight alignment.
- A firmware start + complete pair with sufficient post-start samples may persist
  at most `fair`.
- Headings remain labelled **Approximate magnetic heading**.
- Persistence remains the versioned, opaque-device-bound summary: timestamp,
  neutral vector, zero heading offset, algorithm/schema versions, and quality.
  No raw heading or IMU sample history is stored.
- The action does not add, guess, or transmit a calibration opcode.

## Acceptance coverage

Host tests deterministically cover local success, insufficient-quality timeout,
cancel, firmware takeover, stale callbacks, session replacement, restart,
verified summary persistence, and the absence of a new source control call. A
viewport test renders the collecting state at the real 576×288 G2 dimensions and
verifies visible instructions, progress, and cancel action remain on-screen.
Real-device acceptance still requires building/installing the exact candidate
and repeating the worn full-circle flow; host tests do not constitute hardware
calibration evidence.
