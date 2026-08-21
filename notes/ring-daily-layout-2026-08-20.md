# Ring daily-data record layout (reverse-engineered 2026-08-20)

Confirmed from independent firmware and sanitized capture cross-checks (values are
`{avg,max,min}` per hour, no per-record "latest"). The previous stride-9/stride-13
decoder was WRONG: it read record 0 roughly right by luck, then produced garbage
(hour 104/113, min 0) for later records.

## Real inner-frame `data` layout (module=health, subCmd=1 daily)

```
[0]        count                  (u8)     number of hour records
[1..2]     timezoneOffsetMinutes  (i16 LE) signed UTC offset in minutes
[3..6]     dayBaseSec             (u32 LE) local-midnight epoch second
[7..10]    currentTimestampSec    (u32 LE) timestamp for the current value
[11..]     current                         live value: u8 for HR/SpO2, u16 LE for HRV
[then N records]
  HR / SpO2 record (4 bytes):  [hourIdx u8][avg u8][max u8][min u8]
  HRV record      (7 bytes):   [hourIdx u8][avg u16 LE][max u16 LE][min u16 LE]
  (trailing zero padding after the records)
```

For a valid day anchor, each hourly record is timestamped exactly as
`dayBaseSec + hourIdx * 3600`. The offset must be within ±14 hours, the day base
must be nonzero, and local-midnight alignment must hold. Invalid metadata leaves
the metric values available with a null timestamp. `currentTimestampSec` is
independently accepted only within the validated day and never substitutes for
the hourly base.

The `current` value (frame header, not a record) is the ring's live reading —
this is the byte the old decoder misread as a record's `.latest` (the 112-vs-range
bug). The Even app discards it; we can surface it as the live current HR.


## Why the app only sees a few hours (the "sparse data" problem)

The ring pushes only its recent cached hours via notify (`source:"ring1Notify"`).
The Even app's deep multi-day history (333 HR rows over ~2 weeks) is largely
`source:"cloud_export"` — backfilled from Even's cloud, which we do not have. So
mirroring Even fully means **accumulating hourly records locally over time**
(poll, decode, persist per day+hour), plus the live `current` value. There is no
single "give me everything" ring query to reproduce the cloud history.

## Downstream implications

- ring-parser `decodeDailyData`: implemented with hourIdx/avg/max/min plus a
  nullable derived absolute timestamp.
- Frame `current` -> store.currentHr (live HR), feeds insights `liveHr`.
- Persist HOURLY records into history (Ben: daily granularity is useless), so
  charts + export show hour-by-hour across days as they accumulate.
