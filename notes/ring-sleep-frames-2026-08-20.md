# Ring sleep frames (cmd=6) — type-1 summary confirmed (updated 2026-08-25)

The R1 pushes sleep on `module=2 cmd=0x6 subCmd=1`. A fresh BLE session can
re-pull stored records. This note contains sanitized layout facts only; the
capture, exact values, health rows, and firmware disassembly remain in the
private evidence tree. No private timestamp, health value, or stage vector is
reproduced here.

## Confirmed type-1 summary

A complete overnight type-1 notification passes both transport checks and the
canonical `module=2 status=2 cmd=6 subCmd=1` envelope. Independent firmware
producer, serializer, and diagnostic-format paths establish this sanitized data
layout:

```text
[0]       record type u8 (=1)
[1]       sleep efficiency percent u8
[2]       ring sleep score u8
[3]       reserved (=0)
[4..7]    stage-share percent bytes; [4] is the remainder, exact sum=100
[8..9]    absolute nightly body/skin temperature u16 LE, 0.1 C; zero=absent
[10..11]  timezone offset minutes i16 LE
[12..15]  absolute start Unix second u32 LE
[16..19]  absolute end Unix second u32 LE
[20..21]  total asleep seconds u16 LE
[22..23]  awake seconds u16 LE
[24..25]  REM seconds u16 LE
[26..27]  light/core seconds u16 LE
[28..29]  deep seconds u16 LE
[30]      stage-run count u8
[31]      reserved (=0)
[32..]    count runs: [stage u8][duration u16 LE]
[end-4..] opaque four-byte trailer
```

Run duration units are 30 seconds. Stage ids are 0=awake, 1=REM, 2=light/core,
and 3=deep. For the captured complete frame, every run sum reproduces its
corresponding aggregate, asleep equals REM+light+deep, and the absolute interval
equals asleep+awake. The ring score at `[2]` is retained as authoritative; a
locally derived sleep score is only a fallback for older non-protocol inputs.

The firmware converts the three shares at `[5..7]` and writes `[4]` as their
integer remainder from 100. Hermes therefore checks their exact sum, while
using the aggregate durations and stage-run sums as the stronger source of
sleep-stage truth.

The field at `[8..9]` is not a signed temperature delta despite an older private
schema label. The producer's input path validates raw sensor magnitudes in the
30,000–50,000 milli-C range, collects them as unsigned samples, and requires at
least 12 readings before its trimmed aggregation. It scales the resulting
absolute sensor value to tenths of a degree, writes an unsigned halfword, and
logs it as `body_temp`; exported skin-temperature magnitude independently
corroborates the absolute interpretation. Hermes stores the absolute value and
computes any baseline variation locally.

Production decoding requires the exact length implied by the run count and
rejects impossible timestamps, unknown/empty/adjacent runs, inconsistent totals,
invalid score/efficiency/temperature ranges, and malformed reserved fields. The
latest `endTs` wins when stored replies arrive out of order. It persists across
app closure, but only a night ending within 36 hours can feed current readiness;
older retained data remains history.

## Captured type-2 records

Three distinct notifications were reproduced from the existing capture. Every
one is a complete single-fragment frame with valid outer CRC-32 and inner
CRC-16/MODBUS, canonical magic/version, module 2, status 2, cmd 6, and subCmd 1.

Each declared inner length is 48 bytes: exactly the 12-byte inner header plus a
36-byte data region. The earlier note's claimed length mismatch was wrong.

The sanitized type-2 data shape is:

```
[0]       record type u8 (=2)
[1..11]   zero in all three captures
[12..15]  relative interval start u32 LE
[16..19]  relative interval end u32 LE
[20..35]  zero in all three captures
```

Firmware independently copies these u32 fields as the sleep record's ordered
start/end pair. Type 2 bypasses summary and stage serialization, matching the
zero summary fields and empty stage arrays in the correlated database rows.
Each stored record is emitted separately; duplicate delivery on re-poll is not
pagination within a session.

## Ground-truth correlation and confidence

The read-only A32 database contains four `source=ring1Notify` sleep sessions.
For each of the three captured pairs, `end - start` equals exactly one distinct
database session span. The three matches are one-to-one, and every matched row
has no stage runs or non-zero summary fields.

This closes all three evidence legs for the following claims:

- **HIGH:** data offsets 12 and 16 are ordered relative interval endpoints.
- **HIGH:** their unit is seconds.
- **HIGH:** data offset 0 is a record type, and captured type 2 is interval-only.
- **HIGH:** the three frames represent three separate stored sessions.

It does **not** make either u32 an epoch timestamp. The inferred absolute
reference differs among the three records, is neither local nor UTC midnight,
and is not carried in these payloads. The firmware has a separate zero-time /
time-sync recovery path, but the available wire and static evidence do not show
the exact base handed to the phone. Keep this concept separate from both the
confirmed activity local-midnight epoch base and the opaque non-activity daily
header word at offset 7.

## Remaining type-2 boundary

The complete type-1 layout does not supply the missing base for historical
type-2 interval-only records. `decodeSleep` therefore accepts type 1 only and
continues to reject type 2 rather than reconstructing guessed dates or emitting
partial sleep statistics. A future type-2 decoder still requires independent
proof of that absolute-base handoff.

The confirmed daily HR/HRV/SpO2 record layout remains unchanged; see
`notes/ring-daily-layout-2026-08-20.md`.
