# Ring sleep frames (cmd=6) — relative intervals confirmed (2026-08-20)

The R1 pushes sleep on `module=2 cmd=0x6 subCmd=1`. A fresh BLE session can
re-pull stored records. This note contains sanitized layout facts only; the
capture, exact values, health rows, and firmware disassembly remain in the
private evidence tree.

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

## Remaining decoder gate

The fourth ring1Notify database session has non-empty stages and summary fields,
but the existing capture has no matching type-1 cmd=6 notification. Therefore
score, efficiency, totals, body temperature, full field widths, stage runs, and
absolute timestamp reconstruction remain unvalidated. `decodeSleep` must keep
throwing, cmd=6 must remain unmapped, and the store must keep ignoring it.

The exact missing evidence is a complete CRC-valid type-1 cmd=6 notification
correlated to a non-empty-stage ring1Notify row, plus the absolute-base handoff.
Obtain it only in a reversible Even-only sync/capture window, then restore Even
stopped/disabled with both Bluetooth permissions revoked. A separately reviewed
implementation card is required after that evidence exists.

The confirmed daily HR/HRV/SpO2 record layout remains unchanged; see
`notes/ring-daily-layout-2026-08-20.md`.
