# Ring daily-data record layout (reverse-engineered 2026-08-20)

Captured live from the R1 on bae80013 (exclusive access, Even app stopped) and
cross-checked against the Even app's decoded `health.sqlite` (values are
`{avg,max,min}` per hour, no per-record "latest"). The previous stride-9/stride-13
decoder was WRONG: it read record 0 roughly right by luck, then produced garbage
(hour 104/113, min 0) for later records.

## Real inner-frame `data` layout (module=health, subCmd=1 daily)

```
[0]        count            (u8)  number of hour records
[1..6]     reserved         (6 bytes, zero)
[7..10]    base             (u32 LE, opaque header word; meaning remains unproved)
[11..]     current          live/instant reading: u8 for HR/SpO2, u16 LE for HRV
[then N records]
  HR / SpO2 record (4 bytes):  [hourIdx u8][avg u8][max u8][min u8]
  HRV record      (7 bytes):   [hourIdx u8][avg u16 LE][max u16 LE][min u16 LE]
  (trailing zero padding after the records)
```

The `current` value (frame header, not a record) is the ring's live reading —
this is the byte the old decoder misread as a record's `.latest` (the 112-vs-range
bug). The Even app discards it; we can surface it as the live current HR.

Do not conflate this non-activity offset-7 word with the activity command's
confirmed local-midnight epoch base or cmd=6's unresolved interval reference.
Firmware and wire evidence have not established a timestamp meaning for it.

## Golden vectors (real captures, hex = inner-frame `data`)

- **heartRate** count=3, current=106:
  `03 000000000000 da620000 6a 044958 3b·wait` -> bytes:
  `030000000000 00 da62 0000 6a 04 49 58 3b 05 69 7a 57 06 68 71 58 00000000`
  -> current 106; hour4 avg73/max88/min59; hour5 105/122/87; hour6 104/113/88.
- **spo2** count=2, current=98:
  `020000000000008a6200006204616161065f5f5f00000000`
  -> hour4 97/97/97; hour6 95/95/95.
- **hrv** count=3, current=39 (u16):
  `03000000000000b3620000270004350035003500056200620062000641004100410000000000`
  -> hour4 53/53/53; hour5 98/98/98; hour6 65/65/65 (ms).

Every record is internally consistent (min<=avg<=max).

## Why the app only sees a few hours (the "sparse data" problem)

The ring pushes only its recent cached hours via notify (`source:"ring1Notify"`).
The Even app's deep multi-day history (333 HR rows over ~2 weeks) is largely
`source:"cloud_export"` — backfilled from Even's cloud, which we do not have. So
mirroring Even fully means **accumulating hourly records locally over time**
(poll, decode, persist per day+hour), plus the live `current` value. There is no
single "give me everything" ring query to reproduce the cloud history.

## Downstream implications

- ring-parser `decodeDailyData`: rewrite to this layout; records carry
  hourIdx/avg/max/min only (no per-record ts or latest).
- Frame `current` -> store.currentHr (live HR), feeds insights `liveHr`.
- Persist HOURLY records into history (Ben: daily granularity is useless), so
  charts + export show hour-by-hour across days as they accumulate.
