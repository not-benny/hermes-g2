# R1 ring BLE wire format (reverse-engineered 2026-08-20)

Wire-format reference for the Even R1 ring's health protocol, confirmed by
reverse-engineering the ring firmware and cross-checked byte-for-byte against
live captures and the existing decoder in `app/health/ring-parser.ts`. This note
carries wire-format facts only: byte offsets, sizes, CRC parameters, command
ids, and record layouts. It intentionally omits captured values.

Companion note: `notes/ring-daily-layout-2026-08-20.md` (daily-push record
layout with the same offsets).

## 1. GATT channels

Two independent channels carry ring data:

- **Protobuf control channel** (ATT `0x0842` write / `0x0844` notify): `0xAA`-framed
  protobuf with a 2-byte trailer. Used for a live short-cadence poll. Field 1 of
  the protobuf is the command id.
- **Binary health channel** (ATT `0x0015` write / `0x0017` notify): the richer
  channel that carries the CRC-checked health records described below. This is
  the one the daily-push decoders read.

Request MTU 247 before probing the binary channel; large health frames fragment
badly at the default MTU.

## 2. Binary-channel transport envelope

Each notify (and each host write) on the binary channel is:

```
[0]      fragIndex   u8      fragment index; counts down, 0x00 on the final/only fragment
[1..4]   crc32c      u32 LE  CRC-32C over bytes[5..], stored little-endian (= batchId)
[5..16]  frame       12 B    inner FRAME struct (section 3)
[17..]   payload             this fragment's slice of the inner buffer
```

**Transport CRC (CRC-32C / Castagnoli):** poly `0x1EDC6F41`, init 0, no xorout,
stored little-endian. Computed over every byte from offset 5 onward (the inner
FRAME plus payload).

**Reassembly:** fragments of one batch share the same `crc32c`/`batchId` in bytes
1..4. Order fragments by **descending** fragment index down to 0x00, concatenate
their payloads to form the inner buffer, then assert `CRC-32C(inner) == batchId`.
A single-command frame is one fragment (index 0x00, payload = the whole inner
frame).

## 3. Inner FRAME struct (12 bytes)

```
[0]       0x64                 frame marker
[1]       module               1=system, 2=health, 3=sport
[2]       (version marker)
[3..4]    seq         u16 LE   per-session sequence id
[5]       status               request vs. data/ok
[6]       cmd                  per-module command id (section 4)
[7]       subCmd               per-module sub-command (health daily=1)
[8..9]    innerLen    u16 LE   length of the inner frame (header + data)
[10..11]  crc16       u16 LE   inner-frame integrity CRC
[12..]    data                 payload region
```

**Inner CRC (CRC-16/MODBUS):** reflected polynomial (table constant `0xC0C1`),
init `0xFFFF`, computed over the inner frame with its own crc slot pre-zeroed.

## 4. Command table

- **module:** system=1, health=2, sport=3
- **health cmd:** heartRate=1, spo2=2, temperature=3, hrv=4, activity=5, sleep=6
- **health subCmd:** daily=1

Health GETs are **bare `status=req` frames with no data payload**; the metric is
selected by the `cmd` byte with `subCmd=1`. Responses return on the notify
characteristic and may span multiple fragments.

Battery is a system read: `deviceStatus` (module=system, cmd=0, subCmd=1); the
percent is `data[0]` of the response.

## 5. Daily health record layout

The inner-frame `data` region for a daily-push metric begins with a header,
followed by fixed-stride hourly records:

```
[0]        count     u8       number of hourly records
[1..6]     reserved  6 bytes
[7..10]    base      u32 LE   base/timestamp; exact meaning still open
[11..]     current            live current-hour reading: u8 (HR/SpO2), u16 LE (HRV)
[then N records]
```

Records start at offset 12 for HR/SpO2 and offset 13 for HRV (HRV's `current`
field is two bytes):

```
HR / SpO2 record (4 bytes):  [hourIdx u8][avg u8][max u8][min u8]
HRV record      (7 bytes):   [hourIdx u8][avg u16 LE][max u16 LE][min u16 LE]
```

- HR/SpO2 units: bpm and percent; values direct, no scaling.
- HRV units: milliseconds.
- `hourIdx` = hour-of-day (0..23). There is no per-record timestamp.

The header `current` field is the ring's live current-hour reading; it is what a
live read surfaces. The **finest resolution the ring stores is hourly** min/max/avg.
There is no per-beat or per-second stream.

## 6. Decoder status

| metric | cmd | status |
|---|---|---|
| heart rate | 1 | confirmed, implemented |
| SpO2 | 2 | confirmed, implemented |
| temperature | 3 | rides the hourly layout; sparse and often absent |
| HRV | 4 | confirmed, implemented |
| activity (steps + calories) | 5 | confirmed, implemented (10-minute buckets) |
| sleep | 6 | schema known, byte layout awaits an overnight capture |
| battery | system | confirmed, implemented |

- **Activity/steps/calories (cmd=5):** confirmed data header is
  `[count u8][UTC offset i16 LE][local-midnight epoch u32 LE]`; each 7-byte
  record is `[10-minute slot u8][steps u16 LE][active kcal u16 LE][total kcal u16 LE]`.
  Resting kcal is `total-active`, and absolute time is `dayBase+slot*600`.
  The captured slot 71 reproduces the Even CSV's 11:50 row exactly: 0 steps and
  15 kcal = 12 resting + 3 active. Buckets persist locally and merge by day/slot.
- **Sleep (cmd=6):** the output schema is known and verified (session start/end,
  total/wake/REM/light/deep seconds, a hypnogram of `{type, half_minutes}` at
  30-second epochs, and a nightly `body_temp_delta`). Stage map: `0=Wake, 1=REM,
  2=Light, 3=Deep`. The on-wire byte layout awaits a real overnight capture to
  correlate against a decoded session before it can be implemented.
- **Temperature (cmd=3):** has no separate detail record; it rides the same
  hourly layout as HR/SpO2. Its data is sparse and frequently absent, so it is
  treated as best-effort and not depended on.

## Open items

- Capture an overnight `cmd=6` sleep frame and decode its byte layout against a
  known session (start/end, stage durations, hypnogram, body-temp delta).
- Determine the meaning of the `base`/timestamp field at offset 7 so per-record
  absolute timestamps can be reconstructed rather than inferred from `hourIdx`.
- Request MTU 247 before probing. The captured `packetAck(0x7e)` cursor loop is
  implemented: only complete CRC-valid health pushes queue a bounded cursor, and
  the communicator worker performs the write outside the BLE callback.
