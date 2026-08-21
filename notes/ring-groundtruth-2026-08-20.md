# R1 ring ground truth: btsnoop + Even health export (2026-08-20)

**Status: verified.** A full btsnoop HCI capture of the Even app driving the R1
ring, plus the Even app's own built-in health-data export, together pin down what
the ring actually stores and at what resolution. This note is the decoder
ground-truth reference: it describes schemas, columns, resolutions and semantics
only, no raw readings. Use it to build and validate the ring decoders.

This supersedes two earlier assumptions: that HR has finer-than-hourly
granularity, and that the ring exposes no calories metric. Both were wrong (see
the CSV schemas below).

---

## 1. Method (the ground-truth harness)

Reproducible on the Android test device (Samsung A32, Android 13).

### btsnoop HCI logging (Samsung path)

Enable full HCI snoop, then restart the Bluetooth stack:

```
adb shell settings put global bluetooth_hci_log 1
adb shell setprop persist.bluetooth.btsnooplogmode full
# then toggle Bluetooth off/on (or restart the BT stack) to open a fresh log
```

The log lands at `/data/log/bt/btsnoop_hci.log`. Note this is the **Samsung**
path; it is NOT the AOSP `/data/misc/bluetooth/logs/` location, so tooling that
assumes the AOSP path finds nothing here. The btsnoop datalink type on this
device is **1002 (H4)**, which the parser must select.

### Capture the Even app's traffic (revert afterward)

The Even app is normally disabled and its Bluetooth revoked. For a capture it was
briefly re-enabled and allowed to connect to the ring so its ATT traffic is
recorded. Per the project's standing Operational rule this MUST be reverted after
the capture: re-disable the Even app and re-revoke its Bluetooth permission. The
capture window is the only time the Even app is allowed to hold the ring.

### Even app health-data export (the ground truth)

The Even app has a built-in health-data export that writes a zip named
`Even_health_data_YYYYMMDD.zip` to the root of external storage. It contains 7
CSVs. This is Even's own processed / decoded data, so it is the authoritative
ground truth for what each ring value means and at what resolution. Pull it, then
correlate its columns against the wire frames.

### btsnoop parser

A Python btsnoop parser is kept privately, outside this public repo, at
`ground-truth-private/parse_snoop.py`. It tracks LE connection handles to peer
MACs and dumps ATT writes / notifications per device so the ring's frames can be
isolated from other BLE traffic. Practical caveat: when moving the log off-device
as base64 over adb, strip CR/LF before decoding or the base64 is corrupt.

## 2. The two ring GATT channels observed

The capture shows the Even app talking to the ring over **two** distinct GATT
channels, not one.

### Protobuf-framed control channel

- ATT handle `0x0842` (write) / `0x0844` (notify).
- Frame shape: prefix byte `0xAA`, then a direction marker
  (`0x21` = request, `0x12` = response), then a protobuf body, then a 2-byte
  trailer.
- In the protobuf body, **field 1 = command id**. Observed ids:
  `1` = HR, `4` = HRV, `6` = sleep, `0x0e` = healthEnable.
- The Even app polls this channel roughly **every 15 seconds** while its HR
  screen is open. This is the cadence to mirror for a live read.

### Second, richer channel

- ATT handle `0x0015` (write) / `0x0017` (notify).
- Carries device metadata (serial strings, firmware version strings) and health
  payloads under a different framing that is still only partly resolved.

The exact frame-to-value mapping on **both** channels is not fully decoded yet.
Treat the byte offsets as unfinished; use the CSV schemas below as the target the
decode must reproduce.

## 3. Even export CSV schemas (ground truth)

Columns and semantics only. Example values are placeholders, never real readings.

### heart_rate.csv

```
timestamp,value,source,ty
```

- Hourly rows. `ty` is one of `{min, max, avg}`, so each hour is three rows
  (e.g. `avg=<bpm>`, `min=<bpm>`, `max=<bpm>`).
- `source` is `"R1"` for stored history and `"ring1Notify"` for a live
  current-hour read.
- **KEY FINDING: the finest HR granularity is HOURLY min/max/avg.** There is NO
  per-second (per-beat) HR anywhere in the export. A "live" read simply returns
  the current partial hour's min/max/avg. This is exactly what the Even app
  surfaces as e.g. "N bpm, 1 min ago": the current hour's average so far.

### blood_oxygen.csv and hrv.csv

```
timestamp,value,source,ty
```

- Same shape and semantics as `heart_rate.csv`: hourly min/max/avg rows.

### calories.csv

```
timestamp,value,resting,active,source
```

- **10-minute buckets.** `source` `"R1"`.
- Each stored bucket splits into `resting` + `active` kcal.
- **KEY FINDING: the ring provides calories directly.** This corrects the earlier
  "no calories metric" assumption. The ring-native calories are real, bucketed,
  and split resting/active.
- Live `ring1Notify` rows carry a single `value` with **empty** `resting` /
  `active`.

### steps.csv

```
timestamp,value,source
```

- 10-minute buckets, `source` `"R1"`.

### skin_temperature.csv

```
timestamp,value,source
```

- **Daily**, sparse. Frequently zero or absent. Do not assume a value every day.

### sleep.csv

```
timestamp,start_ts,end_ts,total_time,wake_time,rem_time,light_time,deep_time,stages,source,tz,body_temp_delta
```

- `start_ts` / `end_ts` are epoch seconds.
- `total_time`, `wake_time`, `rem_time`, `light_time`, `deep_time` are all in
  **seconds**.
- `stages` is a JSON array of `{type, half_minutes}` at **30-second epochs**
  (`half_minutes` counts 30-second units).
- `body_temp_delta` is the nightly body-temperature delta.
- **STAGE TYPE MAPPING (verified against the `*_time` totals):**
  `0 = Wake`, `1 = REM`, `2 = Light`, `3 = Deep`. Summing the `half_minutes` per
  type reproduces the corresponding `*_time` seconds, which is how the mapping was
  confirmed.

## 4. Implications for Hermes decoders

- **Live HR:** implement a periodic current-hour read that mirrors Even's ~15s
  poll on the `0x0842` / `0x0844` channel. Display the returned average and set
  the user expectation to a ~15s to 1min refresh, NOT per-beat. There is no
  per-second stream to wait for.
- **Calories:** decode the ring-native calories (10-minute buckets, resting +
  active split) instead of estimating. Keep the existing HR-based Keytel
  estimator as a fallback for when native buckets are unavailable
  (see `notes/calorie-estimation.md`).
- **Sleep:** decode the ring `cmd=6` frames against this now-known schema: a
  hypnogram of 30-second epochs using the `0/1/2/3` stage mapping, plus the
  total / wake / rem / light / deep seconds and `body_temp_delta`. A raw overnight
  `cmd=6` capture is still needed to finish the byte layout
  (see `notes/ring-sleep-frames-2026-08-20.md`).
- **Steps:** decode the 10-minute step buckets.

## 5. Open items

- Finish the frame-to-value decode on the `0x0842` / `0x0844` protobuf control
  channel.
- Finish the frame-to-value decode on the `0x0015` / `0x0017` richer channel
  (device metadata + health payloads).
- Capture a raw overnight `cmd=6` sleep frame set on a night that is also present
  in the export, to pin and validate the sleep byte layout.
- Validate each decoder (HR, HRV, SpO2, calories, steps, sleep) against the
  private ground-truth CSVs before surfacing its values in the UI.
