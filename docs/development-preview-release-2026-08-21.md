# Development-preview release — 21 August 2026

Hermes G2 development preview 1 was published as a GitHub prerelease.

## Release identity

- Tag: `v1.0.0-preview.1`
- Release: <https://github.com/not-benny/hermes-g2/releases/tag/v1.0.0-preview.1>
- Source commit: `24274cfa5a076618afdb2306b880623aa4a94abe`
- Asset: `Hermes-G2-v1.0.0-preview.1-debug.apk`
- Size: `335,831,435` bytes
- SHA-256: `03143d502175e0f0cfce5b0022ee3263aa85bc8d48bc4cdc710133de621908f2`
- Clean-validation run: <https://github.com/not-benny/hermes-g2/actions/runs/32527230737>
- Publication run: <https://github.com/not-benny/hermes-g2/actions/runs/32530363547>
- Post-publication asset read-back run: <https://github.com/not-benny/hermes-g2/actions/runs/32530801521>

The release tag points to the exact source used for the clean build. Immediately
before publication, the APK was recovered from the retained validation artefact
and checked for its expected source record, single-APK shape, size, SHA-256 and
ZIP integrity. A separate post-publication workflow then downloaded both assets
from the finished GitHub release and verified the prerelease metadata, exact tag
target, APK size and SHA-256, checksum-file contents, `sha256sum -c`, and ZIP
integrity.

## Publication state

- GitHub release type: prerelease
- APK signing/build type: Android debug build
- Package: `com.faceclaw.app`
- App label/version: `Hermes G2` / `1.0.0`
- Minimum/target SDK: 24 / 35
- Public MCP/skill publication: not enabled
- Standalone R1 provisioning/DFU/destructive commands: not enabled
- G2 firmware recovery assurance: not established

The release notes include the official Even-app hand-off, installation guidance,
known limitations, firmware risk, privacy boundary, validated source and APK
checksum. No private capture, proprietary firmware binary, credential, device
identifier, pulled settings file or health export was added to the release.

## Installation boundary

The APK is debug-signed and is intended for development evaluation. Android may
refuse to install it over a build signed by a different key. The official Even
app remains required for first-time G2/R1 provisioning and official maintenance;
it must release Bluetooth before Hermes can reliably hold the devices.

The preview does not close the outstanding hardware matrix, private bridge
end-to-end, sleep-decoding, provisioning-ownership, public MCP publication or
firmware-recovery roadmap gates.