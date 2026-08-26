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
| Skin temperature: sparse nightly absolute value | Type-1 daily cmd 6; cmd 3 remains reserved | Cmd 6 decodes the firmware's unsigned absolute `body_temp` in 0.1°C units; zero remains unavailable | The latest canonical sleep record and daily summary store/export the value | Phone shows the absolute value while its local baseline builds, then variation; a recent value contributes to phone/glasses readiness | **Parity for type-1 nightly temperature.** No independent cmd-3 stream is claimed. |
| Sleep: start/end, duration/totals, stage runs, timezone, efficiency, and score | Daily cmd 6 | A strict type-1 path retains absolute timestamps, aggregate totals, 30-second runs, and the authoritative ring score; type 2 is rejected | The latest-by-end-time canonical night survives closure and is exported; daily summaries retain bounded trend fields | Phone shows score source, duration, efficiency, and awake/REM/light/deep totals; recent sleep feeds phone and glasses readiness | **Implemented for complete type-1 records; physical owner acceptance remains.** |

Ring battery and firmware version are adjacent device telemetry, not health-export
parity fields. Hermes readiness is locally derived and is not presented as a
first-party exported metric.

## Current end-to-end ownership

- `FaceclawBleCommunicator.java` owns the read-only full poll: device status,
  HR, SpO2, HRV, activity, and sleep, with temperature reserved. The current-hour
  HR refresh is scheduled separately.
- `app/health/ring-parser.ts` owns envelope validation, cmds 1-5 metric layouts,
  and strict type-1 sleep decoding. It deliberately rejects type 2.
- `app/health/ring-health-store.ts` owns reassembly, CRC checks, current state,
  latest-night ordering, and the canonical cmd-6 envelope gate.
- `app/health/health-store.ts`, `app/health/health-history.ts`, and
  `app/health/health-hourly.ts` own fail-closed device-local persistence.
- `app/native/health-export.ts` exports the canonical document without inventing
  missing values or exposing the app-private ring identity.
- `app/phone-ui/even-health-view-model.ts` is the phone presentation/persistence
  bridge; the glasses surface consumes the same validated, freshness-gated
  sleep/readiness state.

## Sleep decoder evidence and remaining boundary

The type-1 implementation was enabled only after these evidence requirements
were satisfied without committing private health vectors:

1. A complete CRC-valid cmd-6 frame contains summary and stage data.
2. Firmware producer/serializer/log paths establish absolute timestamps,
   timezone, score/efficiency, temperature units, aggregates, and run encoding.
3. Synthetic canonical tests reproduce every field and use no private timestamp
   or stage vector.
4. Negative tests reject malformed lengths/envelopes, relative times, invalid
   ranges, inconsistent totals/runs, unknown stages, stale readiness input, and
   out-of-order overwrite.
5. Focused host tests and TypeScript checks pass; physical owner-device
   acceptance remains a separate release check.

Type-2 records still lack an absolute base. They remain fail-closed and cannot
populate state, persistence, export, or UI.
