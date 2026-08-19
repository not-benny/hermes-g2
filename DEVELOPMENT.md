# Development notes

Hermes G2 is an Android program based on Faceclaw that provides a user
interface on the Even Realities G2 smart glasses. It is written in a mix of
Typescript/NativeScript (for the user interface parts) and Java (for the
low-level bluetooth parts and for interfacing with the Android SDK).

Typescript parts are in `app/`. Java parts are in
`App_Resources/Android/src/main/java/com/faceclaw/app/`.

## Building and running

Typecheck (fast): `npm run typecheck` (runs `tsc --noEmit`).

Tests: `node --test tests/*.test.mjs`. Typescript modules are tested by
transpiling with the `typescript` devDependency and importing a `data:` URL;
see `tests/edge-scroll.test.mjs` for the pattern.

Deploy to a phone with adb enabled:

```bash
ns run android --device <id> --justlaunch
```

If no phone is connected, the build still completes but the install step
fails with "Cannot find connected devices." Use `adb logcat` to view runtime
results.

Note that the Android Gradle Plugin in use requires JDK 21; newer JDKs fail.

## Protocol references

For low-level communication work, see
https://github.com/Commute773/g2-kit-unofficial/ and its `ble/docs/` and
`ble/gen/` directories. That repository contains protobuf schemas, some
communication test scripts, and documentation of caveats that come up when
communicating with the headset.

The R1 ring health BLE protocol is documented in `docs/ring-health/`.
