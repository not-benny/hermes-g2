# R1 protocol evidence capture method

This guide is for protocol research on devices and accounts you own or are
explicitly authorised to test. It is not required for normal Hermes G2 use.

The default repository position is **no fresh capture**: use existing sanitised
fixtures and public-safe notes unless a specific unknown cannot be resolved any
other way. A capture can expose personal health data, account identifiers, BLE
addresses, device serials, tokens, and proprietary implementation details.

## Safety boundary

Permitted for an explicitly reviewed non-destructive evidence task:

- read-only package-filtered logs
- temporary copies of an official-app database or export
- observation of already occurring BLE traffic
- offline decoding and comparison

Not authorised by this guide:

- pairing or ownership changes
- host rebinding, algorithm-key or NVM writes
- firmware/DFU/OTA
- reset, wipe, pair-delete, recovery, or power-control commands
- certificate validation weakening, global proxy changes, or credential capture
- publishing raw health values, identifiers, tokens, databases, or captures

Any device-affecting or credential-bearing procedure needs its own reviewed,
fail-closed plan and, where applicable, the repository's separate consent gate.

## Preparation

1. Create a private evidence directory **outside** the repository, with restricted
   permissions and a task-specific retention/deletion rule.
2. Record the exact purpose, expected evidence, device alias, app/build versions,
   UTC window, operator, and stop conditions in the private task record.
3. Confirm both G2 arms and the R1 are already provisioned by the official Even
   app. Do not change bonds or ownership for a capture.
4. Stop Hermes and any other BLE central before opening Even. Only one app should
   control the R1 command session at a time.
5. Clear only the temporary log buffer you intend to capture. Do not clear app
   data, reset devices, or alter permissions beyond the separately approved
   reversible hand-off.

## Package-filtered log capture

The official app has historically emitted useful Ring1 protocol events to its
own logs. Android and app versions can change this behaviour, so absence of a
line is not proof that a command did not occur.

A minimal local example is:

```bash
adb logcat -c
adb logcat --pid="$(adb shell pidof -s com.even.sg)" -v threadtime > "$PRIVATE_DIR/even-ring-session.log"
```

Start the log only after the private directory is set. Trigger the smallest
read-only sync needed, stop capture immediately after the target response, and
inspect the file locally before any sharing.

If the process ID changes, restart the package-filtered capture. Do not fall back
to an unrestricted device-wide log unless a separate privacy review explicitly
authorises it.

## Correlation workflow

1. Record only the sanitised command/status/length/CRC facts needed for the
   research question.
2. Verify outer CRC-32C and incoming inner CRC-16/MODBUS before interpreting a
   payload.
3. Correlate against the smallest matching official-app row or export record.
4. Replace real values with synthetic builders in tests. Do not paste raw frames
   or health rows into the repository.
5. Write a public-safe note stating what was proven, what remains inferred, and
   which exact evidence is still missing.

For sleep, the required missing evidence is a complete CRC-valid type-1 command-6
notification correlated to the matching non-empty-stage `ring1Notify` row, plus
proof of the absolute time-base handoff. Type-2 interval frames alone are not
sufficient to implement sleep decoding.

## Restore and close

1. Stop the official app and restore the pre-task Bluetooth ownership boundary.
   In the current owner workflow, Even is left stopped/disabled with its Bluetooth
   permissions revoked before Hermes resumes.
2. Confirm Hermes can reconnect without pairing, provisioning, permission, or
   credential changes.
3. Record whether every temporary setting was restored exactly.
4. Delete unneeded temporary logs and database copies according to the private
   retention rule.
5. Keep raw evidence outside Git. Commit only sanitised documentation and
   synthetic tests.

A failed prerequisite, unexpected prompt, permission drift, ownership change,
unbounded log, missing restoration step, or uncertain private-data boundary is a
STOP result—not a reason to improvise.