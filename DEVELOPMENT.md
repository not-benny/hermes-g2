# Development guide

Hermes G2 is an Android application built with TypeScript/NativeScript and Java.
The TypeScript application lives under `app/`; Android and BLE integration lives
under `App_Resources/Android/src/main/java/com/faceclaw/app/`.

## Canonical branch

Develop from `main`. The repository previously contained two unrelated Git
histories and numerous task branches; they were deliberately consolidated on
21 August 2026. Do not base new work on archived `work/`, `wt/`, `integration/`,
or dated cleanup branches.

Use a focused feature branch, keep commits reviewable, and merge through a pull
request. Never force-push or rewrite a reviewed shared branch unless the owner
explicitly asks for that exact operation.

## Toolchain

- Node.js 20 or newer
- npm
- JDK 21
- Android SDK 35
- NativeScript Android prerequisites
- Required NDK and CMake packages for the native audio/model components

JDK 21 is intentional. Newer JDKs have failed this Gradle stack's `jlink` stage.

## Install, test, and build

```bash
npm ci
npm test
npm run typecheck
npm run build
```

Useful focused suites include:

```bash
node --test tests/ring-parser.test.mjs
node --test tests/ring-health-store.test.mjs
node --test tests/render-view.test.mjs tests/mcp-server.test.mjs
node --test tests/connection-state-lifecycle.test.mjs tests/communicator-teardown.test.mjs
```

The tests transpile pure TypeScript modules with the declared TypeScript
devDependency and import them through `data:` URLs. Keep new protocol and
lifecycle logic Android-free where practical so it can be exercised under Node.

To launch on an authorised device:

```bash
npx ns run android --device <adb-device-id> --justlaunch
```

Use package-filtered `adb logcat` for runtime evidence. A successful build is not
the same as a successful install or hardware test; report each separately.

## Debug-only ADB control harness

Debug APKs expose a deliberately narrow ordered-broadcast receiver for authorised
ADB-shell automation. The receiver exists only in Android's `debug` source set,
requires the signature-level `android.permission.DUMP` permission held by the ADB
shell, and checks `BuildConfig.DEBUG` again at runtime. Release APKs must contain
neither `FaceclawDebugControlReceiver` nor `com.faceclaw.app.DEBUG_CONTROL_V1`.

The host command reads exactly one version-1 JSON envelope from stdin and writes
exactly one JSON receipt to stdout:

```bash
printf '%s\n' '{"v":1,"id":"query-1","command":"state","args":{}}' \
  | node scripts/hermes-g2-debug-control.mjs
```

The initial `state` receipt supplies the process, session, window, and capture
generations required by every mutating command. Commands with stale generations,
duplicate IDs, malformed fields, an offline G2 session, or invalid fixture state
fail closed. The command selects the sole authorised online ADB target. If more
than one target is listed, set an exact wireless or USB serial explicitly:

```bash
HERMES_G2_ADB_SERIAL='192.0.2.10:37123' \
  node scripts/hermes-g2-debug-control.mjs < request.json
# Equivalent when ANDROID_SERIAL is unset:
node scripts/hermes-g2-debug-control.mjs --serial '192.0.2.10:37123' < request.json
```

The allowlist is limited to display wake/blank, fixed launcher app IDs, synthetic
ring gestures, and two procedural voice fixtures. There is no arbitrary intent,
shell, path, URL, keycode, PCM, file, transcript, token, or credential input.
Receipts contain only bounded state and `empty`/`nonempty` transcript classes.
Fixtures are generated in memory and traverse the production endpoint detector
and Moonshine recognizer; neither samples nor recognized content are logged.

Focused verification:

```bash
node --test tests/debug-control.test.mjs tests/debug-control-android.test.mjs tests/debug-control-cli.test.mjs
npm run verify:release-unsigned
```

`verify:release-unsigned` prepares Android, cleans variant metadata, and invokes
Gradle's `assembleRelease` with the narrowly scoped
`hermesUnsignedReleaseVerification=true` property. Its
`app-release-unsigned.apk` is verification evidence only: it is explicitly
unsigned, non-installable as a trusted update, and must never be published.
The property rejects every task request except exactly `assembleRelease`; release
tasks without it still require all four real NativeScript keystore properties and
fail closed when credentials are absent. Do not create a verification keystore.
Inspect the generated release merged manifest and unsigned APK for
`FaceclawDebugControlReceiver`, `com.faceclaw.app.DEBUG_CONTROL_V1`, and
`android.permission.DUMP`; all three must be absent.

TDD evidence for this feature: the protocol/source-set tests were first recorded
RED with missing `app/debug/control-protocol.ts`; the CLI suite was recorded RED
with `MODULE_NOT_FOUND` for `scripts/hermes-g2-debug-control.mjs`; and the
concurrency regression was recorded RED when a queued old-generation input
executed instead of returning `stale`. The implementation then produced GREEN
focused suites, followed by the full host suite, typecheck, and both Android
variants. No hardware action is part of this build-time harness validation.

## Repository map

- `app/assistant/` — bridge, MCP server, tool registry, and direct backends
- `app/g2/` — dashboard controller and G2 session lifecycle
- `app/health/` — R1 frame parsing, health state, and persistence contracts
- `app/native/` — NativeScript-to-Android bridges
- `app/ui/` — glasses shell, layers, settings, notifications, and rendering
- `App_Resources/Android/` — Android manifest, Java BLE implementation, and assets
- `tests/` — host-side regression tests
- `docs/` — maintained public-facing protocol and integration documentation
- `notes/` — detailed research, threat models, validation matrices, and gates
- `firmware-research/` — source-only G2 firmware port research; no proprietary binaries

## Safety boundaries

Do not weaken the repository's fail-closed gates to make a test pass.

- R1 pairing ownership, NVM provisioning, reset, wipe, DFU/OTA, power-control,
  and destructive raw commands remain blocked.
- Public MCP/skill publication remains blocked until transport, identity,
  licensing, credential, generic-client, and real-device gates are met.
- Custom G2 firmware may brick hardware. The owner-unit boot report is not a
  recovery guarantee or broad compatibility proof.
- Keep health data, Bluetooth captures, firmware binaries, credentials, device
  identifiers, and completed consent records outside Git.

## Secrets and generated data

The following must never be committed:

- `secrets.local.md` or similar local secret files
- `ground-truth-private/`
- raw health exports or Bluetooth captures
- firmware binaries
- pulled Android settings/preferences
- API tokens, bridge tokens, MAC addresses, serials, or private IP addresses
- generated build outputs under `platforms/`, `dist/`, or `node_modules/`

Run `git diff --check` and inspect the exact staged paths before every commit.