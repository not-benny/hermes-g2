# Even R1 ring health over BLE

This directory documents the direct, bonded BLE path Hermes G2 uses to read
health data from the Even Realities R1 ring. It does not require an Even cloud
account or a ring firmware modification.

The current implementation and canonical byte-level notes live in:

- `app/health/ring-parser.ts`
- `app/health/ring-health-store.ts`
- `notes/ring-wire-format-2026-08-20.md`
- `notes/ring-daily-layout-2026-08-20.md`
- `notes/ring-sleep-frames-2026-08-20.md`

This directory is the maintained public entry point and includes a sanitised
capture guide plus a standalone frame-inspection utility.

## Main finding: contention, not a per-app auth wall

The R1 exposes a single command session over a bonded and encrypted BLE link.
When the official Even app and another central both try to control that session,
commands time out or become unreliable. With one central active, the direct
Ring1 binary channel responds normally.

`pairAuth` opens the command session but is not an application-specific
challenge/response. First-time bonding, ownership, host binding, algorithm-key
provisioning, and durable NVM state are separate concerns and remain outside the
supported Hermes path.

Practical rule: provision with Even, then make Even release Bluetooth before
Hermes connects. Keep Even installed for official maintenance.

## GATT channels

The rich binary health path uses service
`bae80001-4f05-4503-8e65-3af1f7329d1f`:

- `bae80012` — command writes
- `bae80013` — health and command-response notifications
- `bae80010` / `bae80011` — separate status/phone-notify channel

Hermes requests MTU 247 after service discovery and before subscribing/probing.
A safe fallback remains available when negotiation fails.

## Transport and inner frame

Each notification fragment begins with:

```text
[0]      fragment index u8
[1..4]   batch id / CRC-32C u32 LE
[5..]    fragment payload
```

Fragments for one batch are concatenated in descending fragment-index order.
The batch ID must equal the Even/R1 CRC-32C over the reassembled inner frame:
polynomial `0x1EDC6F41`, MSB-first, initial value 0, no xorout.

The inner frame is:

```text
[0]       0x64
[1]       module: system=1, health=2, sport=3
[2]       0x64
[3..4]    sequence u16 LE
[5]       status: request=0, set=1, push=2, ack=3
[6]       command
[7]       sub-command
[8..9]    total inner length u16 LE
[10..11]  inner CRC u16 LE
[12..]    data
```

Complete incoming rich frames are validated with CRC-16/MODBUS over the inner
frame while treating bytes 10 and 11 as zero. The outer CRC-32C remains the
transport checksum that must match every reassembled batch. Do not treat the
legacy outbound CRC field or an accepted write as proof that an incoming frame
is valid.

## Session and command table

A normal read-only health session sends `pairAuth(0x08)` and safe setup/status
commands, then one bare daily GET for each metric.

Health commands (`module=2`, `subCmd=1`):

| Command | Metric | Hermes status |
|---:|---|---|
| 1 | heart rate | confirmed and implemented |
| 2 | SpO2 | confirmed and implemented |
| 3 | temperature | shared hourly layout; sparse |
| 4 | HRV | confirmed and implemented |
| 5 | activity/calories | confirmed and implemented |
| 6 | sleep | type-1 summary/stages implemented; type 2 rejected |

System reads include `deviceStatus(0x01)` for battery and `deviceInfo(0x02)` for
the read-only firmware version. `systemTime(0x05)` is sent once, best-effort,
during a new health session before daily GETs.

Pairing, host, firmware, power, reset, wipe, pair-delete, and NVM-mutating command
families remain blocklisted.

## Daily vital layout

Heart rate, SpO2, temperature, and HRV use this header:

```text
[0]        record count u8
[1..2]     timezone offset minutes i16 LE
[3..6]     local-midnight Unix epoch second u32 LE
[7..10]    current-value timestamp u32 LE
[11..]     current reading: u8 for HR/SpO2, u16 LE for HRV
[then]     fixed-stride hourly records
```

HR/SpO2/temperature records are
`[hour u8][avg u8][max u8][min u8]`. HRV records are
`[hour u8][avg u16][max u16][min u16]`.

Hermes derives an hourly timestamp only when the signed offset is within ±14
hours, the day base is non-zero, and local-midnight alignment validates. Invalid
metadata leaves permitted values available but unanchored; it never invents an
absolute timestamp. The finest stored heart-rate resolution exposed by this path
is current/current-hour plus hourly min/max/average, not a per-beat stream.

## Activity layout

Activity uses:

```text
[count u8][timezone i16 LE][local-midnight epoch u32 LE]
```

followed by 7-byte 10-minute buckets:

```text
[slot u8][steps u16 LE][active kcal u16 LE][total kcal u16 LE]
```

Hermes validates slot range, calorie ordering, canonical envelope, inner CRC,
expected push/daily status, and current local day. Resting calories are derived
as total minus active. Stale and future-day activity is rejected.

## Sleep status

A complete CRC-valid type-1 notification and independent firmware paths now
establish the summary/stage schema. Hermes decodes absolute Unix start/end,
timezone, ring score and efficiency, asleep/awake/REM/light/deep totals,
optional absolute nightly body temperature (unsigned 0.1°C), and stage runs
encoded as `(stage id, 30-second units)`. Stage ids are 0=awake, 1=REM,
2=light/core, and 3=deep.

The decoder fails closed unless the exact run-count length, canonical envelope,
reserved bytes, ranges, absolute interval, aggregate equality, and per-stage run
sums all agree. Firmware quantizes three stage-share bytes and constructs the
fourth as their remainder, so those display percentages must total 100. The
newest `endTs` wins,
persists across closure, and can drive current phone/glasses readiness for 36
hours. See the sanitized field table in
[`notes/ring-sleep-frames-2026-08-20.md`](../../notes/ring-sleep-frames-2026-08-20.md).

Type 2 remains a separate, rejected record form. Three complete CRC-valid
type-2 notifications establish this sanitised shape:

```text
[0]       record type (=2)
[1..11]   zero in the observed records
[12..15]  relative interval start u32 LE
[16..19]  relative interval end u32 LE
[20..35]  zero in the observed records
```

The ordered endpoints are seconds and their spans match distinct interval-only
`ring1Notify` rows. They are not proven epoch timestamps and their absolute base
is not carried in those frames. `decodeSleep` therefore accepts complete type 1
only and rejects type 2 rather than emitting partial or guessed nights.

## Capture and privacy

See [capture-method.md](capture-method.md). Raw logs, health values, official-app
databases, Bluetooth captures, firmware binaries, account data, device addresses,
and detailed decode evidence belong outside Git. Only sanitised protocol facts,
synthetic tests, and redacted evidence summaries may be committed.

## Standalone utility

`ring-frame-decoder.py` inspects a single-fragment public/sanitised frame, verifies
the outer CRC, reports possible inner CRC matches, and can construct read-only
frames for offline testing. It is a research utility, not a pairing, provisioning,
firmware, recovery, or destructive-command tool.
