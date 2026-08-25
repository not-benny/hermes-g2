# Release security and compatibility

This document is the maintained release contract for Hermes G2. Historical preview-release notes are evidence for one artifact only; they are not a permanent release gate.

## Identity, versioning, and signing

- The Android application ID remains `com.faceclaw.app` for upgrade compatibility with the current owner installation. Renaming it would create a second app and strand app-private state, so it requires a separately planned migration.
- Version metadata is `versionCode 1000003` and
  `versionName 1.0.0-preview.3`. It identifies the current internal candidate;
  it is not a publication claim. Future builds must increase `versionCode`.
- Pull-request debug builds use an isolated ephemeral identity and are not
  production release APKs. Pull-request CI separately builds an explicitly
  unsigned, production-bundled variant only to verify the publishable surface.
- Unsigned means positive absence of v1 signature entries and of every byte gap
  before the ZIP central directory. A generic `apksigner verify` failure is not
  sufficient because corrupt signed inputs fail verification too.
- The protected path consumes only the content-addressed unsigned artifact after
  a green `main` build. Its source-free job rechecks the manifest, DEX, JavaScript
  surface, and debuggability; signs with
  `--debuggable-apk-permitted false`; requires exactly one signer and no
  SourceStamp; and matches the configured certificate fingerprint while rejecting
  an `Android Debug` subject.
- The signing job never checks out or executes repository source, npm, Gradle, or
  project scripts beside credentials. It is disabled unless
  `PROTECTED_RELEASE_ENABLED` is exactly `true` and the separate
  `ANDROID_RELEASE_CERT_SHA256` value matches the non-development keystore.
- The owner install uses the legacy Android development identity. A
  non-debuggable same-certificate artifact is internal upgrade evidence only.
  Do not install a differently signed build over the owner phone until an
  explicit signing and app-data migration plan is approved.
- The APK is large because it includes offline speech/model and arm64 native runtime assets. CI records its exact size and SHA-256. Splitting models into optional, hash-verified downloads is the preferred future footprint reduction.

## Credentials and storage

Bridge, provider, Even, Mapbox, and dormant legacy terminal token-bearing settings are encrypted with an Android Keystore AES-GCM key. Legacy plaintext values migrate only after an encrypted commit and decrypting read-back succeeds; otherwise the plaintext remains so the only valid copy is not lost. Clear actions remove both encrypted and legacy copies. Settings-store initialization also purges plaintext, encrypted, and pending copies of credentials belonging to retired integrations; failed commits retry at the next process start.

The local Work Tasks board uses the same Keystore boundary for one strict,
bounded, versioned document. Mutations commit the task and a content-free
idempotency receipt in the same encrypted write before success is reported.
The authenticated `even-g2` profile exposes only the fixed active-turn add
route; it does not expose Hermes Kanban as an alternative store.

The direct Hermes notification inbox is a separate strict, bounded, versioned
Keystore document. Pending entries retain only the inert result text, a
phone-owned receipt timestamp, monotonic FIFO metadata, and hashed operation and
payload identities; plaintext operation IDs are never stored. Unknown or
off-head wear state, transport loss, lock, foreground voice, or proactive opt-out
pauses presentation without deleting the queue. A confirmed-worn strict frame
acknowledgement atomically replaces pending text with a bounded content-free
tombstone before the wake transaction commits. The acknowledged card remains in
RAM until wearer dismissal or the global screen timeout; a phone-process crash
during that interval cannot reconstruct the already-acknowledged card.

Android backup is disabled. Keystore keys are device/app-install scoped: uninstall or app-data clear destroys the key and settings. Reinstalling does not recover credentials. Upgrade-in-place preserves them when Android preserves app data and signing identity. The developer pull/push preference scripts are not a credential backup mechanism and must not be used for release migration.

## Transport and optional integrations

- Hermes bridge traffic requires authenticated `wss://`. The private owner
  deployment uses Host Session MCP, private Device MCP, and the portable static
  workflow MCP described in `hermes-mcp-architecture.md`. Combined public
  distribution remains NO-GO because the current native bridge is
  redistribution-prohibited and the remaining artifact, containment, privacy,
  and physical-device gates are open.
- The checked-in G2 configuration remains an MCP-only, least-privilege release
  baseline. A separately administered private owner profile may explicitly add
  general host capabilities, including Browser Harness access to a signed-in
  native Brave profile. This overlay is local configuration, never SOUL text or
  release input. Chromium's visible per-connection `Allow` confirmation remains
  mandatory, consequential actions retain approval, and browser state, secrets,
  profile locations, and connection details remain outside Git and logs.
- Terminal/G2Mirror is retired from launcher, search, debug control, persisted-window restore, and Settings navigation. Dormant source and any legacy encrypted records are retained only for rollback and explicit credential cleanup; no connection is started.
- WhatsApp startup and pairing UI are disabled. The bundled Node runtime is not proven compatible with 16 KiB page-size Android devices, live pairing has not passed the disposable-number gate, and Baileys production custody/licensing remain unresolved.

## Build and CI gates

Permanent `CI / release-gate` runs on pull requests without repository signing secrets: locked install, host tests, TypeScript, diff hygiene, full root dependency audit at high severity, runtime-only WhatsApp audit, CycloneDX inventory, JDK 21/SDK 35 debug compilation, unsigned release assembly, ZIP integrity, private-path scan, checksum/provenance, release debug-surface exclusion, ZIP 16 KiB alignment, and APK-wide ELF LOAD alignment. It uploads only SBOM/provenance/alignment evidence, never either PR APK. `Protected Release Validation` repeats the host matrix on `main`, builds and verifies only the unsigned release variant, then hands that exact content-addressed artifact to isolated `protected-release` signing. `CodeQL / codeql` performs source scanning. Dependabot monitors npm and pinned GitHub Actions. Major runtime/toolchain and reviewed prerelease pins are not auto-merge candidates.

NativeScript CLI's legacy development-only graph is lockfile-overridden to patched same-major releases of Axios, lodash, minimatch, simple-git, and tar. No maintained ws 7 release fixes the current advisory, so ws 8 is a deliberate major compatibility override covered by a real loopback start/stop test of webpack-bundle-analyzer's WebSocket server path. This closes the enabled Dependabot/npm-audit critical and high findings without changing the pinned NativeScript CLI. Twenty-eight moderate findings remain in legacy Jimp/file-type, uuid, and yauzl tool paths because npm offers only a destructive downgrade or incompatible major overrides; they are not packaged app dependencies and remain visible for coordinated NativeScript migration rather than being hidden or force-fixed.

All downloaded native/model/source archives have checked-in SHA-256 identities. Downloads use a `.part` file, are hashed before atomic publication, and invalid cache entries are rejected. Native toolchains are pinned to NDK `27.2.12479018` and CMake `3.22.1`; NativeScript CLI `9.0.7` is in `package-lock.json` and invoked without network installation.

The unvalidated embedded Node runtime and WhatsApp asset are excluded from the
APK while WhatsApp remains release-disabled. Every packaged native library and
ZIP entry must pass the 16 KiB release verifier. This is static artifact evidence,
not 16 KiB hardware evidence.

## Permission posture

The current personal-development package requests broad capabilities for glasses BLE, notification mirroring, calendar, optional voice, navigation, exact alarms, installed-app notification selection, developer file access, and long-lived connections. `QUERY_ALL_PACKAGES`, `MANAGE_EXTERNAL_STORAGE`, and battery-optimisation exemption are not suitable for an ordinary Play Store release without policy justification. A public release requires a least-privilege flavor that replaces broad storage with SAF, narrows package visibility, and requests microphone/location/notification/exact-alarm access only at feature activation.

## Gated operations

No release or review authorizes pairing ownership, R1 provisioning/NVM,
reset/wipe/power commands, R1 DFU, G2 firmware flashing/recovery experiments,
signing-key rotation, publication of the native bridge, activation of the
general public-web candidate, or live WhatsApp pairing. Those remain separate
explicit gates.
