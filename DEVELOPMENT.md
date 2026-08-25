# Development guide

Hermes G2 is an Android application built with TypeScript/NativeScript and Java.
The TypeScript application lives under `app/`; Android and BLE integration lives
under `App_Resources/Android/src/main/java/com/faceclaw/app/`.

## Canonical branch

Develop from `main`. The repository previously contained two unrelated Git
histories and numerous task branches; they were deliberately consolidated on
21 August 2026. Do not base new work on archived `work/`, `wt/`, `integration/`,
or dated cleanup branches.

`STATUS.md` is the only current-state authority and `ROADMAP.md` contains the
single active milestone. Feature documents describe component contracts; dated
notes and pull-request descriptions are evidence, not competing priorities.

Until the Owner Hermes Loop milestone closes, work only on a failed acceptance
item or a P0/P1 security, privacy, data-loss, or hardware-safety finding. Use one
short-lived branch and one pull request at a time. Never force-push or rewrite a
reviewed shared branch unless the owner explicitly asks for that exact operation.

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

### Foldable and resizable phone UI

Do not restore a portrait activity lock or calculate phone layouts from the
physical display. Android 16 can ignore orientation restrictions on large
screens, and fold/multi-window transitions can resize a live activity. Keep
phone breakpoints in `app/phone-ui/window-layout.ts`, driven from the current
page's `getActualSize()`. Run `node --test tests/foldable-phone-ui.test.mjs`
for the cover/unfolded/landscape/tabletop/split-screen contract. The matrix and
source links are in `notes/fold7-compatibility-matrix-2026-08-22.md`.

## Debug-only ADB control harness

Authorised debug APKs expose a narrow, generation-bound ADB automation harness.
Query current state before any mutation:

```bash
printf '%s\n' '{"v":1,"id":"query-1","command":"state","args":{}}' \
  | node scripts/hermes-g2-debug-control.mjs
```

The harness is debug-only, DUMP-protected, allowlisted, replay-safe, and contains
no synthetic wearer input or arbitrary shell/file/network surface. Release APKs
must contain none of its receiver, action, permission, or JavaScript
implementation. The full protocol, target selection, privacy boundary, and
verification commands are in [`docs/debug-control.md`](docs/debug-control.md).

## Repository map

- `STATUS.md` - sole current product and operational state
- `ROADMAP.md` - single active milestone and deferred boundaries
- `app/assistant/` - bridge, MCP server, tool registry, and direct backends
- `app/g2/` - dashboard controller and G2 session lifecycle
- `app/health/` - R1 frame parsing, health state, and persistence contracts
- `app/native/` - NativeScript-to-Android bridges
- `app/ui/` - glasses shell, layers, settings, notifications, and rendering
- `App_Resources/Android/` - Android manifest, Java BLE implementation, and assets
- `tests/` - host-side regression tests
- `docs/` - maintained component contracts and integration documentation
- `gateway/even-g2/` - public-safe SOUL and MCP cutover configuration templates
- `notes/` - research, threat models, and dated evidence; never current status
- `firmware-research/` - source-only G2 firmware port research; no proprietary binaries

## Safety boundaries

Do not weaken the repository's fail-closed gates to make a test pass.

- R1 pairing ownership, NVM provisioning, reset, wipe, DFU/OTA, power-control,
  and destructive raw commands remain blocked.
- The portable workflow MCP and native transport have separate publication
  boundaries. The native bridge and workflow package are separately published
  under Apache-2.0, and the reviewed source installer pins both exact commits.
  Do not copy either package or a private profile wholesale into this repository;
  update the distribution locks and consent digest instead. Protected APK
  publication and physical-device acceptance remain separately gated. See
  `docs/hermes-mcp-architecture.md`.
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
