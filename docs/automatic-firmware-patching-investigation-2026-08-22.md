# Automatic firmware patching investigation

**Date:** 22 August 2026  
**Scope:** Even Realities G2 glasses only  
**Baseline:** canonical `main` at `60d92905652a9b2a5664ab5e4db5b8b30cdaddcd`

## Decision

Automatic **rebuild, delta generation, replay, and static validation** of an
already human-ported, exact-version G2 firmware candidate is feasible and is the
recommended next automation boundary. Automatically relocating or porting the
patch to a newly discovered vendor release is not demonstrated: 2.2.8.4 depends
on a version-specific, manually reviewed address map and source substitutions.
Automatic promotion into the trusted app allowlist, unattended installation,
automatic rollback, and R1 ring firmware updates are not currently feasible
safely.

The practical direction is a hermetic host/CI pipeline that notices a candidate
stock release and acquires it into quarantine. A human must determine whether a
new version is worth porting, produce and review its version-specific relocation
map and source changes, and approve provenance and semantics. Only then may the
pipeline rebuild that exact port, replay the generated delta independently, and
emit an unsigned review bundle. A separate review must update the app's exact
allowlist and authorize every staged hardware trial and user transfer. Remote
input may revoke an already approved digest, but must never approve or enable a
new digest.

This distinction is important:

- **Patch automation** means rebuilding and checking bytes for an exact candidate
  whose version-specific port already received human review, without touching a
  device. This is feasible now; automatic porting to a new base is not.
- **Deployment automation** means transferring those bytes to one or both lenses.
  The transport exists, but safe unattended operation and recovery do not.
- **Automatic rollback** would require a proven independent recovery mechanism.
  Reflashing stock over the same live BLE OTA service is only a repair attempt,
  not rollback from a dead or unreachable lens.

## Evidence surveyed

### Current Hermes pipeline

Hermes already contains most of a deterministic, exact-version patch pipeline:

1. `scripts/update_deltas.sh` runs the configured external verification package,
   rebuilds from the exact stock image, byte-compares the result with the reviewed
   candidate, and emits offset/expected-old/new operations plus base and output
   SHA-256 values. Its default input is the sibling
   `even-g2-cfw-8.4-verification` working package, not a hermetic repository input.
2. `app/g2/firmware-builder.ts` downloads one fixed CDN object, verifies its exact
   base digest, applies only the committed guarded operations, verifies the full
   output digest, and stages the result in app-private storage.
3. `FaceclawFirmwareFlasher.java` rereads the staged bytes and independently
   permits only the exact stock or custom full-image digest. It also checks
   component CRC32C, the required Apollo main component, load address, declared
   length, and a conservative MRAM ceiling before OTA.
4. The writer sends components sequentially to the left and then right lens, with
   block and component retries, progress callbacks, reconnect windows, and a
   heartbeat.
5. Both TypeScript and native release policy gates are currently false. This is
   the correct release posture while recovery remains unvalidated.

The source-only research archive under `firmware-research/` pins upstream
`jimrandomh/g2flash` commit
[`877c8d9490db0d3717ca012dd0f54556af3701bd`](https://github.com/jimrandomh/g2flash/tree/877c8d9490db0d3717ca012dd0f54556af3701bd),
retains the GPL source and relocation evidence, and provides offline verification
scripts. `firmware-research/README.md` records one owner-unit boot report but no
interruption recovery, broader compatibility, or cross-toolchain reproducibility.
The historical `firmware-research/REPORT.md` documents exact static checks and
residual hardware blockers.

The public openCFW work documents the EVENOTA multi-component format and a
single-slot Apollo application update model without proven autonomous rollback:
[`evenRealities-openCFW`](https://github.com/kalanihelekunihi/evenRealities-openCFW/tree/1f7421a54eb2f53be900dd7a1efd6c1b9b9e0438/g2).
The pinned `g2-kit-unofficial` transport research provides application/BLE framing
and generated OTA message concepts, but it is not a complete image builder,
flasher, or recovery system:
[`g2-kit-unofficial@33da3a7`](https://github.com/Commute773/g2-kit-unofficial/tree/33da3a7ec2b905ca7148acad69f105a0986b3fb7).

### Controls that are already valuable

- exact base and output SHA-256 identities;
- old-byte preconditions for every replacement and EOF confinement for appends;
- byte equality between the source rebuild and reviewed candidate;
- package manifests, pinned verification dependency, branch-target checks,
  checksum repair, diff confinement, and MRAM bounds;
- a native full-image allowlist immediately before transfer;
- independent native container checks;
- explicit preparation and transfer UI stages; and
- a stock-image path for a reachable, OTA-capable device.

These establish the identity and static consistency of the one reviewed 2.2.8.4
candidate. They do not establish that a newly discovered version is authentic,
compatible, semantically safe, bootable, or recoverable.

## Options

| Option | Expected benefits | Limitations and dependencies | Major risks | Decision |
|---|---|---|---|---|
| Keep the current manually regenerated, exact-version patch set | Small attack surface; straightforward review; exact bytes are pinned in TypeScript and Java | Manual coordination is required when the base changes; duplicated URL/digests/versions can drift; relies on a specific reviewed source package | Human copy errors; stale native allowlist; no scalability to future bases | Retain as the trusted promotion model until a manifest-driven pipeline replaces duplication |
| Hermetic host/CI candidate builder | Automates release discovery and hashing, then rebuild, independent replay, static analysis, and review-bundle generation for an exact human-ported version without device writes | Needs lawful stock acquisition, a manually reviewed version-specific relocation/port, content-addressed inputs, pinned compiler/dependencies, reproducibility on independent builders, and secure artifact retention | Mistaking automatic discovery for a safe automatic port; a compromised source, toolchain, CDN, or CI runner could produce a plausible malicious candidate; proprietary binaries must not leak | **Recommended first implementation** as quarantined, non-publishing automation after human porting |
| Manifest-driven app integration | One reviewed manifest could bind source URL, lengths, versions, compatibility, patch revision, base/output hashes, native allowlist, and policy epoch; generated TS/Java/tests would reduce drift | Requires a schema, signature/threshold-approval process, deterministic code generation, packaged-APK readback, and revocation handling | Treating a structurally valid or merely signed manifest as semantic approval; remote enablement of a new digest | Build only after the host pipeline; promotion and signing remain manual and reviewed |
| Assisted, journalled deployment | Reuses the existing Android OTA writer while preserving immediate human consent; can collect consistent per-lens evidence and guide repair | Requires writer hardening, foreground-service ownership, durable transaction state, exact pair/hardware preflight, post-reboot attestation, sacrificial recovery tests, and staged rollout | Process death, stale ACKs, mixed left/right firmware, power loss, unrecoverable single-slot failure | Gated future work; no deployment trial without separate authorization and recovery evidence |
| Unattended or agent-triggered deployment | Convenience and rapid fleet updates | Requires all assisted-deployment controls plus mature rollout governance and an independently proven recovery path | Bricking unattended devices, bypassing informed consent, broad compromise from a bad promotion | **Reject** for the current product |
| Automatic stock rollback | Could repair a custom image while both lenses still boot and accept OTA | Same OTA path and compatibility assumptions as installation; no A/B slot, ROM recovery, or public hard-brick route has been demonstrated | False assurance: a dead lens cannot accept the purported rollback | Do not claim or implement as automatic rollback; describe only as manual live-target stock repair |
| Standalone R1 firmware automation | Would reduce dependence on the official Even app for updates | R1 exposes Nordic Secure DFU and is expected, but not yet observed, to enforce vendor ECDSA-P256 signatures; Hermes has captured neither a DFU transaction/init packet nor an approved image and lacks independent recovery and provisioning authority | Image-authenticity failure, pairing loss, unrecoverable brick, no demonstrated custom-firmware value | **Do not build**; preserve the existing blocklist and official-app maintenance path |

## Recommended architecture

### Phase 1: quarantined acquisition and build

A monitor may discover a release but cannot make it trusted or port the patch.
Every input starts in quarantine. New bases require human version-specific
relocation, source adaptation, and semantic review before entering the automated
rebuild/replay stage. That stage should consume a machine-readable candidate
manifest that records, without secrets or device identifiers:

- exact byte length and SHA-256 of the stock image;
- source URL, acquisition time, vendor version, and evidence of vendor signature
  when available;
- product, board, bootloader, OTA-protocol, and component compatibility claims;
- pinned patch-source commit, toolchain/container identities, flags, and dependency
  hashes; and
- expected patched digest, patch-operation digest, and policy epoch.

Use TUF-equivalent expiry, anti-freeze, rollback protection, and key rotation for
Hermes metadata. TLS and the opaque CDN filename are transport evidence, not
release provenance. If no independently verifiable vendor signature exists,
promotion needs threshold human approval plus archived source evidence and a
transparency record.

Build in a clean, network-isolated environment after acquisition. Generate into a
temporary directory, replay the delta with an independent implementation, and
require byte equality from at least two independent builders before producing a
candidate report. Verify:

- patch offsets, lengths, ordering, non-overlap, component confinement, old-byte
  preconditions, and append-at-EOF rules;
- full-image and per-component digests/checksums;
- container bounds, unique expected component names, topology, load addresses,
  memory ceilings, and exact payload coverage;
- injected branch targets and source-to-binary mapping;
- semantic/disassembly diff against the reviewed patch intent; and
- source/package manifests, licences, SBOM, and signed build provenance.

The output is an **unsigned, quarantined review bundle**. CI must not modify the
trusted app manifest, push generated hashes, publish proprietary images, enable
firmware installation, or contact hardware.

### Phase 2: reviewed promotion

Promotion is a separate pull request requiring two-person review for provenance,
firmware semantics, trusted hashes, compatibility, and policy changes. Generate
TypeScript, native Java allowlists, URLs, version data, and executable test
fixtures from one signed manifest rather than copying constants manually.

The final Android package must be checked, not only source: verify its identity,
signing mode, embedded bundle and DEX/native allowlist, and exact artifact hash.
A signed revocation or kill switch may disable an approved digest. No server,
release monitor, bridge, assistant, or manifest download may enable an unapproved
digest or expand the rollout cohort.

### Phase 3: assisted deployment, only after recovery evidence

Before any future transfer, the native layer must enforce all of the following:

- exact full-image digest bound to install/restore mode and policy epoch;
- exact pair, arm, model, hardware/board, bootloader, protocol, and source-version
  compatibility, rejecting unknown or asymmetric data;
- monotonic anti-downgrade policy; any break-glass recovery downgrade is short-lived,
  device-bound, digest-bound, manually approved, and separately logged;
- both-arm battery/charging/thermal, phone power/storage, and BLE-link preflight;
- immediate, expiring consent bound to transaction, pair, mode, source/target,
  artifact digest, procedure revision, and risk disclosure; and
- a durable, fsynced transaction journal written before the first OTA command.

The writer must fail closed on every false BLE write and unexpected status, bind
ACKs to lens, connection generation, transfer nonce, opcode, sequence, component,
and block, and clear stale callbacks across reconnects. Staging should use a
bounded download, temporary file, fsync, atomic rename, and a final native digest
read immediately before transfer.

After each lens reboots, reconnect and attest its expected version/capability before
continuing or reporting success. Run the transfer in a bounded Android foreground
service. After process restart, show a dedicated recovery decision; never silently
resume or create a new transaction. Resume only if the device can prove committed
state for the unchanged transaction. Otherwise require operator-directed repair.

### Rollout and failure handling

Promotion stages should be explicit and signed:

1. reproducibility/static validation;
2. parser, fuzz, property, malformed-container, process-death, and ACK-interleaving
   tests;
3. sacrificial hardware with physical recovery capability;
4. internal opt-in canary;
5. a small fixed cohort; and
6. broader opt-in deployment, if ever justified.

Every expansion remains manual. Automatically pause or revoke on boot failure,
asymmetric arms, unexpected version/capability, any repair/restore attempt,
repeated reconnect, CRC or ACK anomalies, or elevated failure rate. Cancellation
must explain whether stopping mid-component is less safe than completing the
current protocol unit.

Recovery testing must interrupt every block/component boundary and the gap between
left and right lenses. It must demonstrate repeated stock repair and separately
identify what happens when a lens no longer exposes BLE OTA. Until an independent
A/B, ROM, bootloader, debug-port, or vendor-service route is exercised, the honest
recovery statement remains: **automatic rollback is unavailable and permanent
device loss is possible**.

## Privacy and operational constraints

Detailed diagnostics stay local by default. Firmware consent is not telemetry
consent. Any opt-in upload needs a fixed schema, encryption, access control,
retention/deletion limits, regional handling, and coarse pseudonymous rollout IDs.
Never collect or publish MAC addresses, account tokens, health/notification data,
firmware bytes, private captures, raw BLE payloads, or local file paths. Aggregate
rollout analysis may automatically stop an approved rollout but must never approve
one, and local safety/recovery cannot depend on cloud availability.

Separate authorizations are required for artifact promotion, installer enablement,
cohort expansion, each transfer, stock repair, and break-glass downgrade. Static
review is never operational authorization.

## Concrete follow-up work

1. Define the signed candidate/promotion manifest and generate all duplicated app
   constants and tests from it. Keep version-specific relocation and patch-source
   approval explicitly manual.
2. Make `firmware-research` verification hermetic and reproducible on two builders;
   add executable patch replay, malformed-container, bounds, and semantic-diff tests.
3. Add a quarantine-only CI workflow that emits a review report without committing,
   publishing firmware, changing allowlists, enabling installation, or touching BLE.
4. Harden the dormant native writer: fail-closed write/status handling, exact ACK
   identity, checked container arithmetic/coverage, atomic staging, and native
   compatibility/policy enforcement.
5. Design and test a durable two-lens transaction journal and post-reboot attestation
   entirely in simulation before requesting hardware authorization.
6. Prepare a separately reviewed sacrificial-device interruption and recovery plan.
   Do not execute it without Benny's explicit per-run authorization.

## Final feasibility verdict

Proceed with **quarantined acquisition followed by offline automatic rebuild,
delta generation, replay, and validation of an exact human-ported candidate**.
Do not treat release discovery as an automatic port, and do not proceed with
automatic trust promotion, unattended flashing, or claimed automatic rollback.
Keep installation release-disabled until native hardening, exact compatibility
and consent, staged rollout controls, and independently witnessed sacrificial
recovery evidence all pass. Keep R1 firmware automation out of scope and blocked.
