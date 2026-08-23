# R1 health-data parity with Even (23 August 2026)

## Scope

This is a field-level inventory of what the current Hermes G2 `main` request,
decode, persistence/export, and phone/glasses presentation paths actually do.
It records only mappings established by the checked-in implementation and its
sanitized protocol notes. It does not treat private captures, inferred vendor
semantics, or nullable schema capacity as proof that a value is implemented.

## Request-to-surface matrix

| Even health field | Request path | Decode and in-memory state | Persistence / export | Phone / glasses presentation | Result |
| --- | --- | --- | --- | --- | --- |
| Heart rate: hourly minimum, maximum, average, and current-hour value | Daily cmd 1 in the full health poll; a separate HR-only refresh runs more frequently | Cmd 1 is mapped to `heartRate`; hourly records and the current value are retained | Hourly min/max/average and the current daily summary are stored and explicitly exported | Current/range/chart on the phone; current/range on glasses | **Parity for the documented hourly/current fields.** No per-beat stream is claimed. |
| Blood oxygen: hourly minimum, maximum, and average | Daily cmd 2 | Cmd 2 is mapped to `spo2`; hourly records are retained | Hourly min/max/average and the latest-hour daily summary are stored and exported | Latest hourly average on phone and glasses | **Parity for the documented hourly fields.** A separate first-party live field is not claimed. |
| HRV: hourly minimum, maximum, and average | Daily cmd 4 | Cmd 4 is mapped to `hrv`; hourly records are retained | Hourly min/max/average and the latest-hour daily summary are stored and exported | Latest hourly average on phone/glasses and used as a local readiness input | **Parity for the documented hourly fields.** A separate first-party live field is not claimed. |
| Steps: 10-minute buckets | Daily cmd 5 | Cmd 5 is mapped to `activity`; validated, timestamped 10-minute buckets and the local-day total are retained | Canonical buckets and the daily total are stored and exported | Daily total on phone and glasses; buckets in explicit JSON export | **Data parity; intentionally summarized presentation.** |
| Calories: 10-minute total, active, and resting buckets | Daily cmd 5 | Native total and active values are retained; resting is derived as total minus active | Canonical buckets and daily totals are stored and exported | Active calories on phone/glasses; all components in explicit JSON export | **Data parity; partial presentation parity.** |
| Skin temperature: sparse daily/nightly value | Cmd 3 is reserved and is not polled by the full health poll | Cmd 3 has an hourly-shaped parser path, but no validated mapping populates production state | Real temperature samples are not stored or exported; the daily field remains nullable | Phone placeholder; no real glasses value | **Gap / mapping blocked.** The nullable nightly field and an unvalidated cmd-3 shape are not interchangeable evidence. |
| Sleep: start/end, duration/totals, stage runs, timezone, and temperature delta | Daily cmd 6 is requested | Cmd 6 is intentionally absent from `RING_HEALTH_CMD`; `decodeSleep` throws and the store ignores the unmapped response | Nullable schema fields exist, but no real sleep value is stored or exported | The phone passes `sleep: null`; no real sleep value is shown on phone or glasses | **Major gap / evidence blocked.** Production must remain fail-closed until the gate below is met. |

Ring battery and firmware version are adjacent device telemetry, not health-export
parity fields. Hermes readiness is locally derived and is not presented as a
first-party exported metric.

## Current end-to-end ownership

- `FaceclawBleCommunicator.java` owns the read-only full poll: device status,
  HR, SpO2, HRV, activity, and sleep, with temperature reserved. The current-hour
  HR refresh is scheduled separately.
- `app/health/ring-parser.ts` owns envelope validation and the established
  cmds 1-5 metric layouts. `decodeSleep` deliberately throws.
- `app/health/ring-health-store.ts` owns reassembly, CRC checks, current state,
  and rejection of unmapped cmd 6.
- `app/health/health-store.ts`, `app/health/health-history.ts`, and
  `app/health/health-hourly.ts` own fail-closed device-local persistence.
- `app/native/health-export.ts` exports the canonical document without inventing
  missing sleep or temperature values or exposing the app-private ring identity.
- `app/phone-ui/even-health-view-model.ts` is the phone presentation/persistence
  bridge and explicitly supplies `sleep: null`; the glasses surface consumes the
  same validated health state.

## Sleep decoder release gate

Cmd 6 remains unmapped and `decodeSleep` must continue to throw until all of the
following can be satisfied without inference:

1. Obtain a CRC-valid cmd-6 frame containing stage data and correlate it to
   authoritative ground truth for the exact same worn session.
2. Establish the absolute time-base handoff, timezone semantics, interval units,
   and stage-code meanings.
3. Freeze sanitized vectors that reproduce start/end, every reported total,
   ordered stage runs, timezone, and any temperature field exactly.
4. Add negative vectors for malformed lengths, CRC failures, impossible times,
   inconsistent totals, and unknown stages; no partial value may reach state,
   persistence, export, or UI.
5. Run the complete host, type, Android-build, and authorized upgrade/device
   checks before enabling cmd 6 in `RING_HEALTH_CMD`.

Until that evidence exists, emitting a guessed sleep record would be a data
integrity regression, not parity work.
