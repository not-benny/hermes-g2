# Capturing the ring health protocol

The official Even app is a Flutter app that logs its full Ring1 protocol, and the
parsed health values, to logcat in plain text. No root, no BLE sniffer, and no
btsnoop are needed.

## Steps

1. Enable USB or wireless adb on the phone that runs the official Even app.
2. Grant the Even app its Bluetooth and location permissions if they are off:
   ```
   adb shell pm grant com.even.sg android.permission.BLUETOOTH_CONNECT
   adb shell pm grant com.even.sg android.permission.BLUETOOTH_SCAN
   adb shell pm grant com.even.sg android.permission.ACCESS_FINE_LOCATION
   adb shell pm grant com.even.sg android.permission.ACCESS_COARSE_LOCATION
   ```
3. Clear the log buffer and start a filtered capture. The Even app logs under the
   `flutter` tag:
   ```
   adb logcat -c
   adb logcat flutter:V *:S > even-sync.log
   ```
4. Put the ring on, open the Even app, and trigger a health sync.
5. Stop the capture. Grep for the protocol:
   ```
   grep -E "BleRing1CmdService|HealthSync|ProtoHealthExt" even-sync.log
   ```

## What to look for

- `Ring1 Process is sending: subCmd=X serialId=N` is a transmit, phone to ring.
- `Ring1 Receive notify - subCmd=X serialId=N statusAck=ok` is the ring's ack.
- `Ring1 Receive multi packet - K` is a data packet, K counting down to 0.
- `_handleRing1HealthDailyData-common: cmd=X allItems=[...] timestamps=[...]` is the
  parsed hourly data.
- `packetAck` is the phone acknowledging a data batch to pull the next one.

## Contention warning

The ring serves one command session at a time. If a second app is also driving
the ring while you capture, both time out. Capture with only the official Even app
active, and when you later test your own app, make sure the official Even app is
not holding the ring.

## Note on Samsung and btsnoop

On the Samsung device tested, the AOSP HCI snoop toggle does not take effect. The
state `sSnoopLogSettingAtEnable=EMPTY` persists across Bluetooth restarts, and a
full `adb bugreport` contains no btsnoop file. The logcat method here avoids that
problem, because the app itself logs the protocol. A rooted device can read
`/data/misc/bluetooth/logs/btsnoop_hci.log` directly if a byte level reference is
needed.
