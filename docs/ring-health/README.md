# Even R1 ring: health sync protocol (BLE)

Reverse engineering notes for reading health data (heart rate, SpO2, HRV,
temperature, steps, calories, sleep) from the Even Realities R1 ring over BLE.
Captured and verified against firmware as shipped in August 2026 with the
official Even app version 2.2.8.

Everything here is the direct BLE path. It does not touch Even's cloud API and
needs no account, no signing keys, and no firmware modification.

## The headline finding: it is contention, not authentication

A long running belief in the community was that the ring "ignores" third party
central apps, as if there were a per app auth wall. That is not what happens.

The ring is a single command session peripheral. When two central apps hold it
at the same time (for example the official Even app plus a second app), every
Ring1 command times out for both of them. We caught the official Even app itself
logging `Ring1 Process time out` while a second app was also issuing commands.
Give the ring one central at a time and it answers immediately.

There is no crypto handshake gating health. `pairAuth` is a plain request and ack
(see below), not a challenge and response. The ring is LE bonded and encrypted to
the phone at the link layer, and there is no per app identity above that.

Practical consequence: to read ring health from your own app, make sure the
official Even app is not actively holding the ring during your session.

## How the protocol was captured (no root, no sniffer)

The official Even app is built with Flutter and logs its entire Ring1 protocol,
plus the parsed health values, to logcat in plain text. That is enough to read
the whole flow:

```
adb logcat -c
adb logcat flutter:V *:S > even-sync.log
# then: put the ring on, open the Even app, trigger a health sync
```

Useful log prefixes from the Even app:

- `[EvConnect::BleRing1CmdService] Ring1 Process is sending: subCmd=X serialId=N`
  transmit, phone to ring
- `[EvConnect::BleRing1CmdService] Ring1 Receive notify - subCmd=X serialId=N statusAck=... data length=L`
  receive, ring to phone
- `[EvConnect::BleRing1CmdService] Ring1 Receive multi packet - K`
  a data packet, K counts down to 0 within a batch
- `[Health][HealthSync] _handleRing1HealthDailyData-common: cmd=X allItems=[{avg,max,min}...] timestamps=[...]`
  parsed values

Note on Samsung devices: the AOSP HCI snoop toggle
(`settings put secure bluetooth_hci_log 1`) does not take effect. The state
`sSnoopLogSettingAtEnable=EMPTY` persists across Bluetooth restarts and a full
`adb bugreport` contains no btsnoop. The logcat method above sidesteps that
entirely, because the official app hands you the semantics for free.

## GATT layout

- Service `bae80001-4f05-4503-8e65-3af1f7329d1f`
  - `bae80010` properties 4, write without response
  - `bae80011` properties 16, notify (status and phone notify channel)
  - `bae80012` properties 4, write without response (command write channel)
  - `bae80013` properties 16, notify (health and command responses)
- MTU is negotiated to 247. Request the same, since health frames fragment badly
  at the default 23.
- The official app writes commands on `bae80012` and receives on `bae80013`.

## Frame format

Every Ring1 frame is a 5 byte transport header followed by a 12 byte inner
header and an optional data payload.

```
[0]      0x00                      packet type
[1..4]   CRC-32 over the inner     poly 0x1EDC6F41 (Castagnoli), MSB first,
                                    init 0, no xorout, stored little endian
--- inner frame (12 byte header + data) ---
[5]      0x64                      version (100)
[6]      module                    system=1, health=2, sport=3
[7]      0x64                      moduleVersion (100)
[8..9]   serialId u16 little endian
[10]     status                    0=req, 1=set, 2=push, 3=ack
[11]     cmd                       see enums below
[12]     subCmd
[13..14] length u16 little endian  = 12 + len(data)
[15..16] crc16 u16 little endian   the ring does not appear to validate this
[17..]   data
```

The transport CRC-32 at bytes 1 to 4 is the important one. A frame with a wrong
CRC-32 is silently dropped by the ring transport before the command dispatcher
runs. This is a common trap: fill it with the wrong value and the ring looks
"silent" even though writes report success at the GATT layer.

The `ring-frame-decoder.py` tool in this folder builds and verifies these frames
and reproduces captured examples byte for byte.

### Enums

Module: `system=1`, `health=2`, `sport=3`.

Health cmd: `heartRate=1`, `spo2=2`, `temperature=3`, `hrv=4`, `activity=5`,
`sleep=6`.

Health subCmd: `daily=1`, `point=2`, `measure=3`.

System subCmd (module 1, cmd 0): `deviceStatus=0x01`, `deviceInfo=0x02`,
`wearStatus=0x03`, `userInfo=0x04`, `systemTime=0x05`, `pairAuth=0x08`,
`otaStart=0x09`, `advStart=0x0a`, `getAlgoKeyStatus=0x0b`, `setAlgoKey=0x0c`,
`healthSettingsStatus=0x0e`, `systemSettingsStatus=0x0f`, `nvRecover=0x11`,
`powerControl=0x12`, `pairDelete=0x13`, `packetAck=0x7e`, `heartbeatPack=0x7f`.

## Session open: pairAuth

The first command of every session, serialId 0:

```
module=system(1) cmd=system(0) subCmd=pairAuth(0x08) status=req(0) payload=0x01
example bytes: 00971953f964016401000000080d003f0101   (18 byte frame, CRC-32 verified)
```

The ring replies on `bae80013`:

```
Ring1 Receive notify - subCmd=pairAuth, serialId=0, statusAck=ok, data length=1
```

That is the whole handshake. Payload `0x01`, ack `ok`, session open. It is re-sent
on every fresh connection.

## Reading health

After pairAuth, the daily health values are pulled with bare `status=req` frames,
one per metric, with no payload:

```
heartRate daily:    module=health(2) cmd=heartRate(1)    subCmd=daily(1) status=req
spo2 daily:         module=health(2) cmd=spo2(2)         subCmd=daily(1) status=req
hrv daily:          module=health(2) cmd=hrv(4)          subCmd=daily(1) status=req
temperature daily:  module=health(2) cmd=temperature(3)  subCmd=daily(1) status=req
activity daily:     module=health(2) cmd=activity(5)     subCmd=daily(1) status=req
sleep daily:        module=health(2) cmd=sleep(6)        subCmd=daily(1) status=req
```

The ring streams the answers on `bae80013`. History that spans more than one
notification arrives as a multi packet batch (`Ring1 Receive multi packet - K`,
K counting down to 0). The phone acknowledges each batch with a
`system packetAck(0x7e)` frame to pull the next one. Some acks time out and are
retried, and the data still completes.

## Data shape

Values are hourly buckets. Heart rate, SpO2, HRV, temperature, and calories are
reported as an `{avg, max, min}` triple per hour. Steps are a scalar count per
hour. Timestamps are epoch milliseconds at the top of each hour.

Example parsed output from a real sync (values are illustrative):

```
heartRate  allItems=[{avg:101, max:102, min:100}]   timestamps=[<hourly ms>]
spo2       allItems=[{avg:98, max:98, min:98}, {avg:97, ...}, {avg:96, ...}]
hrv        latestData=42
steps      values=[0, 0, 47, 16, 36, 0, ...]         per hour counts
```

A separate `HealthDataPackage` protobuf path (`ProtoHealthExt` in the app logs)
exists, but it is not the ring health path. Ring health is entirely the Ring1
binary protocol above.

## Commands to avoid

The official app sends `advStart(0x0a)` and `nvRecover(0x11)` during a normal
sync, but neither is needed to read health. `advStart` carries a host MAC and is
the one command that can rebind the ring to a different host, so treat it and the
other mutating system subCmds (`otaStart`, `setAlgoKey`, `powerControl`,
`pairDelete`) as do not send.

## Open items

- The exact byte layout of the daily data payload (the hourly encoding) and the
  exact `packetAck` cursor bytes are the remaining unknowns. The parsed values
  above are known, so the encoding can be recovered by capturing the raw
  `bae80013` response bytes during a solo sync and matching them against the
  values.

## Files

- `ring-frame-decoder.py` builds and verifies Ring1 frames, including the CRC-32.
- `capture-method.md` is the step by step capture recipe.
- `sample-capture.log` is a short, scrubbed excerpt of a real sync that shows the
  session open, the command sequence, and the multi packet health flow.
