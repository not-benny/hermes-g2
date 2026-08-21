# Even R1 Ring — Health Sync Protocol (captured live 2026-08-19)

**Status: BREAKTHROUGH.** The multi-session "the ring ignores Hermes" mystery is solved, and
it was never what we thought. Full protocol captured from the Even app's own plaintext logs.

Raw evidence: `notes/ring-capture-2026-08-19/even-sync-full.log` (6.5k lines, a real
com.even.sg ring sync). Decoder: `notes/ring-capture-2026-08-19/parse_btsnoop.py`.

---

## 1. TL;DR — the real root cause

- **The ring is NOT auth-walled and was never broken.** It syncs HR, SpO2, HRV, steps,
  calories, sleep on demand.
- **The blocker was BLE contention.** When *both* Hermes and the Even app hold the ring, every
  Ring1 command times out for both (observed directly: `Ring1 Process time out ... serialId=31`
  from the Even app itself while Hermes' canary was firing). With one central driving it in
  isolation, the ring answers immediately.
- This retroactively explains EVERYTHING: prior sessions' "cold GET gets no reply" and "blind
  pairAuth replay didn't open it" were the Even background service contending for the ring, not
  a missing handshake.
- **pairAuth is a plain request→ack, not a challenge-response** (see §4). No secret, no crypto,
  no per-app identity. Confirms the earlier "no auth wall" finding at the wire level.

## 2. How this was captured (reproducible, no root / no btsnoop)

The Even app (`com.even.sg`, a Flutter app) logs its **entire** Ring1 protocol AND the parsed
health values to logcat in plaintext, under tag `flutter`:

```
adb -s <dev> logcat -c
adb -s <dev> logcat flutter:V FaceclawComm:V JS:V *:S > evencap.log   # Even + Hermes only
# then: ring on finger, open Even app, force a health sync
```

Key log prefixes:
- `[EvConnect::BleRing1CmdService] Ring1 Process is sending: ... subCmd=X serialId=N` — TX (app→ring)
- `[EvConnect::BleRing1CmdService] Ring1 Receive notify - ... subCmd=X serialId=N statusAck=... data length=L` — RX ack
- `[EvConnect::BleRing1CmdService] Ring1 Receive multi packet - K` — a data packet, K counts down to 0
- `[Health][HealthSync] _handleRing1HealthDailyData-common: cmd=X allItems=[{avg,max,min}...] timestamps=[...]` — PARSED values
- `[Health][HealthSync] _handleModuleUpload-HealthModuleType.X: receive chunk, values=[...]/mmaValues=[...]` — per-module chunks

**btsnoop is NOT needed** — the app hands us the semantics for free. btsnoop/root is only useful
as a byte-level reference for the data-frame layout (§7). Samsung's snoop is also a dead end here:
`sSnoopLogSettingAtEnable=EMPTY` persists across BT restarts (Samsung ignores the AOSP
`settings put secure bluetooth_hci_log 1`), and a full `adb bugreport` contained no btsnoop.

## 3. GATT / link facts

- Ring MAC `DC:BE:DA:94:20:B8`, name `EVEN R1_9420B8`, LE, bonded, `EncryptionStatus keySize=16`.
- **MTU is negotiated to 247** (`mtu: 247`). Hermes should request MTU 247 too — big health
  frames fragment badly at the default 23. (Possible secondary contributor to prior flakiness.)
- Service `bae80001-4f05-4503-8e65-3af1f7329d1f`:
  - `bae80010` props=4  → **write (no response)** — likely the command WRITE char Hermes uses (`R1_WRITE_CHAR_UUID`)
  - `bae80011` props=16 → **notify** (phoneNotify / status)
  - `bae80012` props=4  → write (2nd)
  - `bae80013` props=16 → **notify** (dataNotify — health responses land here)
- Contention signature in Hermes' log: `direct ring ready ...` repeating every few seconds and
  `dataNotify` flapping true/false = Hermes' subscription being knocked out while Even holds the
  session. Under contention Hermes captured ZERO response frames.

## 4. pairAuth = session open (request → ack)

TX (app→ring), the FIRST command of every session, `serialId=0`:
```
model=system cmd=system subCmd=pairAuth(0x08) status=req  payload=0x01   (18-byte frame)
golden bytes: 00971953f964016401000000080d003f0101   (CRC-32 verified)
```
RX (ring→app), immediately:
```
Ring1 Receive notify - subCmd=pairAuth, serialId=0, statusAck=BleRing1StatusAck.ok, data length=1
```
→ **payload `01`, ring replies `statusAck.ok`, session is open.** No challenge, no second round.
Re-sent mid-sync (serialId 13) after a reconnect — i.e. re-auth on every fresh connection.

## 5. The full sync sequence (one real run, serialId order)

```
 0  system/pairAuth            session open  → ack ok
 1  system/healthSettingsStatus(0x0e)
 2  system/advStart(0x0a)      *Hermes-blocklisted; see §8 — NOT needed for health*
 3  system/systemTime(0x05)    time sync
 4  health/heartRate/daily     → HR data (avg/max/min per hour)
 5  system/systemTime
 6  system/deviceStatus(0x01)
 7  system/deviceInfo(0x02)
 8  system/userInfo(0x04)      (payload seen in golden: 020000...)
 9  system/packetAck(0x7e)     ack a received data batch (data length=27)
10  health/hrv/daily           → HRV (latestData=42 ms)
11  system/deviceStatus
12  health/hrv/daily
13  system/pairAuth            re-auth after reconnect
14  system/healthSettingsStatus
15  system/advStart            *blocklisted*
16  system/systemTime
17  system/deviceStatus
18  system/userInfo
19  system/deviceInfo
20  system/nvRecover(0x11)     *Hermes-blocklisted; data length=138; NOT needed for health*
21  health/spo2/daily          → SpO2 (multi-packet: chunks of 3,17,14,13 hourly items)
22  system/deviceStatus
23  system/packetAck           ...continues: packetAck loop pulls the rest
... activity/daily → steps + calories; sleep/daily → sleep
```
Module/cmd/subCmd enums (from com.even.sg BleRing1Model, already in FaceclawBleCommunicator):
- module: system=1 health=2 sport=3
- health cmd: heartRate=1 spo2=2 temperature=3 hrv=4 activity=5 sleep=6
- health subCmd: daily=1 point=2 measure=3
- system subCmd: deviceStatus=1 deviceInfo=2 wearStatus=3 userInfo=4 systemTime=5 pairAuth=8
  healthSettingsStatus=0x0e systemSettingsStatus=0x0f **packetAck=0x7e** heartbeatPack=0x7f
  advStart=0x0a otaStart=9 setAlgoKey=0x0c nvRecover=0x11 powerControl=0x12 pairDelete=0x13

Health GETs take **no payload** (bare `status=req` frame) — e.g. heartRate/daily =
`sendRingCommand(module=health(2), cmd=heartRate(1), subCmd=daily(1), status=req, payload=null)`.

## 6. Multi-packet + packetAck loop

Large history (SpO2/steps span days) arrives as **multi-packet** notifications on bae80013:
```
Ring1 Receive multi packet - 1     (more coming)
Ring1 Receive multi packet - 0     (last of this batch)
_handleRing1HealthDailyData: cmd=spo2 ... source=ring1MultiData
```
The phone then sends `system/packetAck(0x7e)` (observed `data length=27`) to ack the batch and
pull the next. Some acks time out and are retried; data still completes. The ack carries a cursor
payload whose exact bytes we don't have yet (§7).

## 7. Data format — values KNOWN, raw bytes TBD

Parsed values captured (so the encoding is verifiable once we have raw bytes):
- **heartRate**: `allItems=[{avg:101,max:102,min:100}] timestamps=[1787166000000]`; `latestData=102`
- **spo2**: `allItems=[{avg:98,max:98,min:98},{97..},{96..},...] timestamps=[...]`; hourly, `latestData=95`
- **hrv**: `latestData=42`
- **steps** (activity): `values=[0,0,0,47,16,36,0,...]` per-hour counts (arrays of 21/52/60/94 = hours over days)
- **calories** (activity): `mmaValues` avg/max/min per hour
- **sleep**: seen (`sleepUpload_sleep_empty` when none)

Shape: **hourly buckets**, each either `{avg,max,min}` (HR/SpO2/HRV/temp/calories) or a scalar
count (steps). Timestamps are epoch **milliseconds**, top of each hour. The raw ring frame
carries a base timestamp + per-hour deltas (exact byte layout is the one remaining unknown).

`[ProtoHealthExt (PB)] HealthDataPackage_CommandData.singleData` is a SEPARATE protobuf path that
logged `status=BleCmdStatus.noDevice` here — it is NOT the ring health path (likely glasses).
Ring health is 100% the Ring1 binary/CRC-32 protocol. Do not chase the protobuf for the ring.

## 8. What Hermes must do (implementation plan)

1. **Request MTU 247** on ring connect (before the probe).
2. **Exclusive access**: the Even app must not be holding the ring (force-stop com.even.sg during
   a Hermes sync). This is also a real product constraint — document for the HUD/UX.
3. Replace the read-only canary in `probeRingHealth()` with a real session:
   a. `pairAuth` payload `01`, wait for the bae80013 ack (`status=ack`).
   b. Send the health GETs (bare `status=req`): heartRate/daily, spo2/daily, hrv/daily,
      temperature/daily, activity/daily, sleep/daily. (Skip advStart/nvRecover — blocklisted and
      not required for health.)
4. **RX handler**: on each bae80013 notify, decode the frame (already have `describeRingFrame`),
   detect multi-packet, and emit `system/packetAck(0x7e)` to continue the batch.
5. **Parse** frames → hourly items → `state.battery`/`state.health.*` → surface on the HUD (the
   dormant ring battery icon + new HR/SpO2 tiles).

Keep advStart(0x0a)/nvRecover(0x11)/setAlgoKey(0x0c)/otaStart(9)/powerControl(0x12)/pairDelete(0x13)
**blocklisted** — none are needed to read health.

## 9. Remaining unknowns → how to close them
- Exact `packetAck` payload bytes and the health-data frame byte layout (§6, §7).
- **Close via**: implement §8 steps a–b + capture Hermes' own raw bae80013 bytes (`raw=` in the RX
  log) during a SOLO sync (Even force-stopped), then reverse the layout against the known values
  in §7. Fallback reference: a rooted-phone btsnoop of one Even sync (user has one ready).

## 10. Contention — product note
The ring serves ONE command session at a time. Hermes and the Even app cannot both actively drive
it. For Hermes to own ring health, either the user stops using the Even app, or Hermes must yield
gracefully when the Even app is foreground. Track as a UX decision before shipping ring health.
