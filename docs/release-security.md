# Release security and compatibility

This document is the maintained release contract for Hermes G2. Historical preview-release notes are evidence for one artifact only; they are not a permanent release gate.

## Identity, versioning, and signing

- The Android application ID remains `com.faceclaw.app` for upgrade compatibility with the current owner installation. Renaming it would create a second app and strand app-private state, so it requires a separately planned migration.
- Version metadata is `versionCode 1000001` and `versionName 1.0.0-preview.1`. Future builds must increase `versionCode`; stable releases use the same monotonically increasing sequence.
- Pull-request and main build-validation APKs use an isolated ephemeral debug identity and are never published as release APKs. After a green `main` build, a separate job downloads only the content-addressed APK/evidence, applies the protected upgrade-compatible identity with pinned `apksigner`, verifies the exact certificate, and publishes the protected artifact. The signing job never checks out or executes repository source, npm, Gradle, or project scripts while credentials are present. It is additionally disabled unless repository variable `PROTECTED_RELEASE_ENABLED` is exactly `true`; set that variable only after effective `main` protection has been read back from GitHub. Do not install a differently signed build over the owner phone until certificate and data-migration compatibility are decided.
- The APK is large because it includes offline speech/model and arm64 native runtime assets. CI records its exact size and SHA-256. Splitting models into optional, hash-verified downloads is the preferred future footprint reduction.

## Credentials and storage

Bridge, provider, Even, Mapbox, Roam, Nightscout, and terminal token-bearing settings are encrypted with an Android Keystore AES-GCM key. Legacy plaintext values migrate only after an encrypted commit and decrypting read-back succeeds; otherwise the plaintext remains so the only valid copy is not lost. Clear actions remove both encrypted and legacy copies.

Android backup is disabled. Keystore keys are device/app-install scoped: uninstall or app-data clear destroys the key and settings. Reinstalling does not recover credentials. Upgrade-in-place preserves them when Android preserves app data and signing identity. The developer pull/push preference scripts are not a credential backup mechanism and must not be used for release migration.

## Transport and optional integrations

- Hermes bridge traffic requires authenticated `wss://`; public bridge/MCP publication remains NO-GO pending the maintained server, certificate-identity, licensing, generic-client, privacy, idempotency, and real-G2 gates.
- Terminal/g2mirror requires TLS for every non-loopback host. Plain `g2mirror://` is accepted only for localhost/loopback development. Token-bearing connection records are encrypted and raw URLs are never used as display labels.
- WhatsApp startup and pairing UI are disabled. The bundled Node runtime is not proven compatible with 16 KiB page-size Android devices, live pairing has not passed the disposable-number gate, and Baileys production custody/licensing remain unresolved.

## Build and CI gates

Permanent `CI / release-gate` runs on pull requests without repository signing secrets: locked install, host tests, TypeScript, diff hygiene, full root dependency audit at high severity, runtime-only WhatsApp audit, CycloneDX inventory, JDK 21/SDK 35 Android build, ZIP integrity, private-path scan, checksum/provenance, ZIP 16 KiB alignment, and APK-wide ELF LOAD alignment. It uploads only SBOM/provenance/alignment evidence, never the PR APK. `Protected Release Validation` repeats that matrix on `main` with no secrets, then hands the unsigned/debug-signed APK to isolated `protected-release` signing. `CodeQL / codeql` performs source scanning. Dependabot monitors npm and pinned GitHub Actions. Major runtime/toolchain and reviewed prerelease pins are not auto-merge candidates.

NativeScript CLI's legacy development-only graph is lockfile-overridden to patched same-major releases of Axios, lodash, minimatch, simple-git, and tar. No maintained ws 7 release fixes the current advisory, so ws 8 is a deliberate major compatibility override covered by a real loopback start/stop test of webpack-bundle-analyzer's WebSocket server path. This closes the enabled Dependabot/npm-audit critical and high findings without changing the pinned NativeScript CLI. Twenty-eight moderate findings remain in legacy Jimp/file-type, uuid, and yauzl tool paths because npm offers only a destructive downgrade or incompatible major overrides; they are not packaged app dependencies and remain visible for coordinated NativeScript migration rather than being hidden or force-fixed.

All downloaded native/model/source archives have checked-in SHA-256 identities. Downloads use a `.part` file, are hashed before atomic publication, and invalid cache entries are rejected. Native toolchains are pinned to NDK `27.2.12479018` and CMake `3.22.1`; NativeScript CLI `9.0.7` is in `package-lock.json` and invoked without network installation.

The unvalidated embedded Node runtime and WhatsApp asset are excluded from the
APK while WhatsApp remains release-disabled. Every packaged native library and
ZIP entry must pass the 16 KiB release verifier. This is static artifact evidence,
not 16 KiB hardware evidence.

## Permission posture

The current personal-development package requests broad capabilities for glasses BLE, notification mirroring, calendar, optional voice, navigation, exact alarms, installed-app notification selection, developer file access, and long-lived connections. `QUERY_ALL_PACKAGES`, `MANAGE_EXTERNAL_STORAGE`, and battery-optimisation exemption are not suitable for an ordinary Play Store release without policy justification. A public release requires a least-privilege flavor that replaces broad storage with SAF, narrows package visibility, and requests microphone/location/notification/exact-alarm access only at feature activation.

## Gated operations

No release or review authorizes pairing ownership, R1 provisioning/NVM, reset/wipe/power commands, R1 DFU, G2 firmware flashing/recovery experiments, signing-key rotation, public MCP publication, or live WhatsApp pairing. Those remain separate explicit gates.
