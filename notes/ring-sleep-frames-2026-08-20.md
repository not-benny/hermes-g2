# Ring sleep frames (cmd=6) — captured, not yet decoded (2026-08-20)

The R1 pushes sleep on `module=2 cmd=0x6 subCmd=1`. A fresh BLE session re-pulls
them. Captured real frames below, but they are **not yet decodable** because we
lack matching ground truth (see "Blocker").

## Raw frames captured (bae80013 notify, single-fragment each)

Envelope `[fragIndex][batchId u32][inner]`; inner `[64][module][64][serial u16]
[status][cmd][subCmd][len u16][crc16][data]`. Three DISTINCT payloads seen (each
also arrived a second time on re-poll):

```
serial 84/87  data(36B)= 02 000000000000000000000000 9c180000 962d0000 0000000000000000000000000000
serial 85/88  data(36B)= 02 000000000000000000000000 9c180000 44340000 0000000000000000000000000000
serial 86/89  data(36B)= 02 000000000000000000000000 a4010000 5e1a0000 0000000000000000000000000000
```

Decoded as u32 LE: `[2, 0, 0, X, Y, 0, 0, 0, 0]`:
- 84/87 -> X=6300, Y=11670
- 85/88 -> X=6300, Y=13380
- 86/89 -> X=420,  Y=6750

So the layout looks like `[count/type u8 = 2][~11 reserved bytes][u32 X][u32 Y]
[trailing zero]`. Two values per frame; meaning unconfirmed. (Note: the frame's
declared len is 0x30=48 but only 36 data bytes are present.)

## Ground truth (Even app health.sqlite, metric_type='sleep', in raw_payload)

Full decoded session shape:
`{score 0-100, efficiency %, start_ts, end_ts (epoch s), total_time, wake_time,
rem_time, light_time, deep_time (all seconds), body_temp (deci-degC, 0 when
absent), stages:[{type, half_minutes}]}` with stage map **0=awake,1=REM,2=light,
3=deep**, half_minutes = 30-second units. Example (ring1Notify nap):
`deep 660, light 1830, rem 540, wake 870, total 3030, score 43, eff 77`.

## Blocker: no matching ground truth for the captured frames

The frame values (6300 / 11670 / 13380 / 420 / 6750) do NOT match any field in
any DB sleep session. The DB's newest sleep synced at 08-19 23:04, i.e. BEFORE
last night's main sleep finished — so **the night these frames describe is not in
the DB**, and there is nothing to validate a decode against. The DB's real
sessions are mostly `source:"cloud_export"` (Even's cloud backfill), which the
ring does not stream to us.

## How to unblock (do this when Ben has fresh sleep data)

1. Open the Even app and let it sync so the DB gains last night's session
   (`source:"ring1Notify"`) with real score/durations.
2. Immediately capture the ring's cmd=6 frames for the SAME night (fresh session
   re-pull; watch bae80013).
3. Correlate frame bytes <-> the DB session's fields to pin the layout, then
   implement `decodeSleep` and validate. Only then unlock the Sleep card + nightly
   body-temperature. Do NOT guess the layout and ship it (would show wrong data).

The daily HR/HRV/SpO2 layout is already cracked — see
notes/ring-daily-layout-2026-08-20.md.
