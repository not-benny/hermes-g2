# R1 health-data parity with Even (22 August 2026)

## Scope and evidence

This is a field-level inventory of what Hermes G2 requests, decodes, persists,
and surfaces compared with the seven health files exported by the Even app. It
uses the sanitized schemas in `notes/ring-groundtruth-2026-08-20.md`, the current
application path, and a read-only review of the private overnight cmd=6 capture.
No pairing, provisioning, permission, reset, firmware, NVM, power, or other
device-state operation was performed for this review. Raw health values and
captures remain outside the repository.

## Parity matrix

| Even health data | Requested/captured by Hermes | Decoded and retained | Persisted/exported | Surfaced | Parity result |
| --- | --- | --- | --- | --- | --- |
| Heart rate: hourly min/max/average plus current-hour value | Daily cmd 1 in the full poll; separate HR-only refresh | Hourly samples and current HR | Hourly min/max/average and daily summary | Phone and glasses current/range/chart | **Parity for the documented Even fields.** Even's export has no per-beat stream. |
| Blood oxygen: hourly min/max/average | Daily cmd 2 | Hourly samples; the header current value is decoded but the store uses the hourly series | Hourly min/max/average plus the latest hour's average in the daily summary | Latest hourly average on phone and glasses | **Parity for the exported hourly fields.** A separate first-party live SpO2 field is not established by the export. |
| HRV: hourly min/max/average | Daily cmd 4 | Hourly samples; the header current value is decoded but the store uses the hourly series | Hourly min/max/average plus the latest hour's average in the daily summary | Latest hourly average and readiness input | **Parity for the exported hourly fields.** A separate first-party live HRV field is not established by the export. |
| Steps: 10-minute buckets | Daily activity cmd 5 | Timestamped 10-minute buckets and day total | Canonical activity buckets and daily total | Day total on phone and glasses; buckets in explicit JSON export | **Data parity.** Hermes does not duplicate the first-party bucket presentation in its UI. |
| Calories: 10-minute total/resting/active buckets | Same activity cmd 5 | Native total and active; resting is exactly total minus active | Canonical activity buckets and totals | Active calories on phone/glasses; all components in JSON export | **Data parity; partial presentation parity.** The UI intentionally shows active calories, while the explicit export retains all components. |
| Skin temperature: sparse daily value | Cmd 3 is currently reserved rather than actively polled | An unsolicited hourly-shaped cmd 3 could decode, but no validated daily skin-temperature mapping populates state | No validated temperature series; nullable nightly field only | Phone placeholder; no glasses value | **Gap / blocked mapping.** The documented daily skin value and sleep `body_temp_delta` must not be conflated with the unvalidated cmd-3 hourly path. |
| Sleep: start/end, total/wake/REM/light/deep seconds, 30-second stages, timezone, body-temperature delta | Daily cmd 6 is requested and CRC-valid responses are captured | Cmd 6 is intentionally unmapped; `decodeSleep` throws; the store ignores it | Nullable daily summary columns exist, but real sleep is not persisted or exported | Sleep card remains locked; no real sleep value is shown | **Major gap / evidence-blocked.** See the reproduction and stop rule below. |

Ring battery and firmware version are adjacent device telemetry, not fields in
the seven Even health exports. Hermes readiness is locally derived and is also
not a documented first-party export field.

## End-to-end implementation inventory

- Requests are emitted by the R1 worker in
  `App_Resources/Android/src/main/java/com/faceclaw/app/FaceclawBleCommunicator.java`:
  HR, SpO2, HRV, activity, and sleep are in the full poll; HR also has a separate
  current-hour refresh. Temperature is deliberately reserved.
- Pure envelope and metric decoding is in `app/health/ring-parser.ts`.
  `RING_HEALTH_CMD` includes cmds 1-5 only and `decodeSleep` fails closed.
- `app/health/ring-health-store.ts` buffers and CRC-checks notifications, retains
  decoded vital/activity state, and ignores unmapped cmd 6.
- `app/health/health-store.ts`, `app/health/health-history.ts`, and
  `app/health/health-hourly.ts` own canonical device-local persistence.
- `app/native/health-export.ts` explicitly exports that canonical document as
  JSON; it does not synthesize missing sleep or temperature values.
- `app/phone-ui/even-health-view-model.ts` passes `sleep: null`, so neither the
  phone nor glasses health surfaces can mistake an unvalidated cmd-6 payload for
  a real session.

## Sleep issue reproduction and evidence

The issue is reproduced, not ruled out:

1. The current parser regression test confirms that `decodeSleep` throws
   `ring sleep captured but layout/base not validated`.
2. The private overnight artifact contains four cmd-6 requests and five
   responses, including one intact 104-byte type-1 notification. The btsnoop and
   ATT export hashes match their frozen provenance manifest.
3. The read-only vendor database has three same-window `ring1Notify` interval
   rows with empty stages and zero summaries. Its only stage-bearing
   `ring1Notify` row is older and has no matching captured type-1 wire leg.
4. The captured type-1 frame therefore cannot be correlated byte-for-byte with
   authoritative start/end, totals, stage runs, score/efficiency, temperature,
   or timezone for the same session.
5. No captured or documented handoff establishes the absolute time base for the
   cmd-6 relative endpoints.

The copied SQLite main-file hash no longer matches the frozen manifest and its
manifest-listed WAL/SHM sidecars are absent. Read-only queries are useful for
parity accounting, but this snapshot cannot be promoted to immutable decode
ground truth without explaining and reconciling that provenance change.

## Verification

- The frozen type-1 artifact independently reproduced its manifest hash and
  passed outer CRC, declared-inner-length, inner CRC, non-zero stage-count, and
  stage-bounds checks.
- Focused parser/store verification passed 34/34 tests, including the throwing
  sleep gate. The complete host suite passed 283/283 after a locked install;
  TypeScript typechecking and the JDK 21 / Android SDK 35 build also passed.
- Independent adversarial review passed after checking the inventory against the
  production request, decoder, persistence, export, and UI paths.
- No hardware operation was needed or performed. This is offline evidence and
  accounting, not a claim that Hermes displayed sleep data on the A32 or R1.

## Decision and remaining limitation

There is no evidence-backed production mapping change to make in this task.
Decoding the intact type-1 frame now would require guessing both semantic fields
and absolute time. `decodeSleep` therefore remains throwing, cmd 6 remains
unmapped, and the UI remains locked.

The decoder gate is exact: correlate the existing CRC-valid, structurally valid
type-1 frame to a stage-bearing `source=ring1Notify` row for the same session,
preserve coherent immutable database provenance, and prove the absolute-base
handoff. A future decoder must then reproduce start/end, all stage totals and
30-second runs, timezone, and temperature from frozen vectors before any value
is stored or displayed.