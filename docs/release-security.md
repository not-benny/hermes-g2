# Release security and compatibility

This document is the maintained release contract for Hermes G2. Historical preview-release notes are evidence for one artifact only; they are not a permanent release gate.

## Identity, versioning, and signing

- The Android application ID remains `com.faceclaw.app` for upgrade compatibility with the current owner installation. Renaming it would create a second app and strand app-private state, so it requires a separately planned migration.
- Local version metadata remains `versionCode 1000003` and
  `versionName 1.0.0-preview.3`. Main-branch CI sets the validated
  `HERMES_CI_VERSION_CODE` override to `1000000 + github.run_number`, so each
  published preview build has a monotonic Android version code while retaining
  the Preview 3 name. These values are not a production publication claim.
- Pull-request debug builds use an isolated ephemeral identity and are not
  production release APKs. Pull-request CI separately builds an explicitly
  unsigned, production-bundled variant only to verify the publishable surface.
- Unsigned means positive absence of v1 signature entries and of every byte gap
  before the ZIP central directory. A generic `apksigner verify` failure is not
  sufficient because corrupt signed inputs fail verification too.
- Every successful push to `main` produces a source-free owner-preview signing
  job. It consumes only the exact unsigned artifact from `main`, rechecks the
  release surface and ZIP/native alignment, signs with dedicated owner-preview
  secrets, and requires exactly one signer, no SourceStamp, and the pinned owner
  certificate `f64ccdb8…7766d4`.
- The owner-preview APK, checksums, provenance, SBOMs, and alignment report are
  published as a public Actions artifact for 30 days. It is explicitly
  unsupported/non-production and is intended only for the evidenced owner
  Fold7 setup; it is not a Play Store or general compatibility release.
- The protected path consumes only the content-addressed unsigned artifact after
  a green `main` build. Its source-free job rechecks the manifest, DEX, JavaScript
  surface, and debuggability; signs with
  `--debuggable-apk-permitted false`; requires exactly one signer and no
  SourceStamp; and matches the configured certificate fingerprint while rejecting
  an `Android Debug` subject.
- Neither signing job checks out or executes repository source, npm, Gradle, or
  project scripts beside credentials. The protected job is disabled unless
  `PROTECTED_RELEASE_ENABLED` is exactly `true` and the separate
  `ANDROID_RELEASE_CERT_SHA256` value matches the non-development keystore.
- The owner-preview install uses the legacy Android development identity. A
  non-debuggable same-certificate artifact is owner-preview evidence only. Do
  not install a differently signed build over the owner phone until an explicit
  signing and app-data migration plan is approved.
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
  workflow MCP described in `hermes-mcp-architecture.md`. The GPL app,
  Apache-2.0 bridge, Apache-2.0 workflow package, and source-pinned distribution
  are public. Protected production APK publication remains disabled while
  artifact, privacy, and physical-device acceptance gates are open; the
  owner-preview Actions artifact is the separately labelled non-production path.
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

Permanent `CI / release-gate` runs on pull requests without repository signing secrets: locked install, host tests, TypeScript, diff hygiene, full root dependency audit at high severity, runtime-only WhatsApp audit, CycloneDX inventory, JDK 21/SDK 35 debug compilation, unsigned release assembly, ZIP integrity, private-path scan, checksum/provenance, release debug-surface exclusion, ZIP 16 KiB alignment, and APK-wide ELF LOAD alignment. It uploads only SBOM/provenance/alignment evidence, never either PR APK. `Protected Release Validation` repeats the host matrix on `main`, assigns a monotonic CI version code, builds and verifies only the unsigned release variant, hands that exact content-addressed artifact to source-free owner-preview signing, and keeps the separate protected production signer disabled. `CodeQL / codeql` performs source scanning. Dependabot monitors npm and pinned GitHub Actions. Major runtime/toolchain and reviewed prerelease pins are not auto-merge candidates.

NativeScript CLI's legacy development-only graph is lockfile-overridden to
reviewed patched releases of Axios, lodash, minimatch, simple-git, tar, `uuid`,
and `yauzl`. No maintained ws 7 release fixes the current advisory, so ws 8 is a
deliberate compatibility override covered by a real loopback start/stop test of
webpack-bundle-analyzer's WebSocket server path. Behavioral probes cover the
`uuid` buffer bounds and malformed `yauzl` timestamp paths. The production
dependency audit reports zero vulnerabilities and the repository high-severity
gate passes. Remaining moderate development-only `file-type` graph findings
stay visible for coordinated NativeScript migration rather than being hidden or
force-fixed.

CodeQL uploads both language analyses to GitHub Security as well as retaining
the review artifact. The Even glasses authentication protocol requires the
existing AES-CBC password-encryption primitive in `FaceclawEvenCrypto.java`;
that compatibility path is not used for app credential storage. Its
`java/weak-cryptographic-algorithm` result must remain visible and explicitly
triaged as a protocol compatibility exception rather than hidden by disabling
SARIF upload.

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
signing-key rotation, activation of the
general public-web candidate, or live WhatsApp pairing. Those remain separate
explicit gates.
