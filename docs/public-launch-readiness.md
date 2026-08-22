# Public launch readiness

Current baseline: `main` at `60d92905652a9b2a5664ab5e4db5b8b30cdaddcd`, 22 August 2026.

## Decision and launch boundary

**Current verdict: NO-GO for public visibility or a broadly supported app/glasses release.** The source, CI, fail-closed firmware policy, credential storage, and one owner-device lineage are substantially prepared, but publication is still blocked by repository privacy/history review, unenforced governance, incomplete public security and licence material, release identity/signing decisions, broad Android permissions, and limited hardware evidence.

Use two explicit milestones rather than treating “public launch” as one event:

1. **Milestone A — public source plus development preview.** Recommended first launch. Publish a curated source history and an explicitly experimental, sideload-only preview. Firmware installation, WhatsApp, public MCP/dynamic apps, R1 provisioning/DFU, destructive controls, and unsupported hardware claims remain disabled or excluded.
2. **Milestone B — supported app and glasses release.** Requires a protected, upgrade-compatible signed artifact, least-privilege packaging, a supported-device matrix, a maintainable assistant path, and real-G2 recovery/runtime evidence for every glasses capability advertised as supported.

A Milestone A launch must not imply Milestone B readiness. Preview mode is the safe path for stock or unrecognised G2 firmware. The official Even app remains required for first-time provisioning and official firmware maintenance.

## Evidence already available

- `CI / release-gate`, CodeQL, locked installs, tests, typechecking, JDK 21 / Android SDK 35 builds, SBOM generation, dependency auditing, APK integrity/private-path checks, and 16 KiB static alignment checks exist under `.github/workflows/` and `scripts/verify-release-artifacts.sh`.
- Credentials use Android Keystore-backed AES-GCM storage with migration and clear controls; Android backup is disabled. See `docs/audit-remediation-2026-08-21.md`, `docs/release-security.md`, and `PRIVACY`.
- G2 firmware writes fail closed in TypeScript and Java. The reviewed firmware candidate has limited owner-unit evidence, not public recovery or compatibility evidence.
- The current application lineage has non-destructive Samsung A32 / two-arm G2 2.2.8.4 evidence for session readiness and ordinary shell-frame delivery. This is one configuration, not a support matrix.
- Development prerelease `v1.0.0-preview.1` is tied to older source `24274cfa5a076618afdb2306b880623aa4a94abe`; it is not the release candidate for the current baseline.

## Tracking and approval

Each P0/P1 item must be copied into the release evidence ledger with: status, accountable owner, target milestone/date, frozen source and artifact identities, evidence location, reviewer, and final approver. Default accountable roles are repository maintainer for R-items, Android release owner for A-items, and hardware/firmware safety owner for G-items. The project owner gives the final launch GO only after independent privacy/security review and, where applicable, hardware or recovery review.

## Before Milestone A: public source and development preview

Complete every P0 item. P1 items may be deferred only when the launch scope and UI make the excluded capability unavailable and the limitation is prominent in the README and release notes.

### P0-R1 — Choose the public-history strategy and scrub it

**Deliverables**

- Choose either a curated/squashed public repository or a full-history rewrite of every ref and tag intended for publication. Keep the current repository private until that choice is approved.
- Inventory GitHub-hosted surfaces that a clone cannot inspect: forks and the fork network, pull-request refs/content/reviews/comments, commit comments, issues and attachments, Actions logs/artifacts/caches, release assets, discussions, wiki, Pages, Projects, packages, deployments/environments, Codespaces/prebuilds, security alerts, webhooks, and repository metadata. Record what can be deleted, what remains recoverable, and what cannot be proven clean.
- Prefer a new sanitised public repository when every server-side surface of the existing repository cannot be cleared with confidence. Do not assume switching visibility back to private recalls already copied data.
- Remove real device identifiers, personal machine paths, captures, credentials, private endpoint details, and personal data from the publishable tree and history. Current tracked notes and reachable history still contain device/path material despite the public-data policy.
- Decide whether existing commit author metadata is approved for publication.
- Recreate or invalidate tags/releases whose provenance changes after sanitisation.

**Dependencies:** owner approval of the history strategy; inventory of branches/tags/releases to retain; a standard full-history secret scanner.

**Validation / completion check**

- Scan all publishable refs with a standard secret scanner plus explicit device-identifier, private-path, IP, token, health-data, and capture patterns.
- Manually inspect `README.md`, `ROADMAP.md`, `HANDOVER.md`, `notes/`, release notes, and generated artifacts.
- Before visibility changes, audit every retained GitHub surface and downloadable artifact, clone the sanitised candidate into a clean local directory, and repeat the scan. Zero unexplained findings; owner signs off on the private preflight. Immediately after the controlled visibility/protection transition in the launch runbook, repeat the clone and surface checks anonymously; any discrepancy triggers the documented stop/revert response.

### P0-R2 — Add public governance, security intake, and support boundaries

**Deliverables**

- Add `SECURITY.md` with a private vulnerability-reporting route, supported versions, response expectations, and a prohibition on publishing private captures or firmware bypass material.
- Add `CONTRIBUTING.md`, a pull-request template, and issue forms that require tests, privacy review, hardware-evidence classification, and explicit safety scope.
- Add a support/known-limitations route. Add `CODE_OF_CONDUCT.md` before actively inviting community contributions.
- Triage or close stale/opaque pull requests and branches before launch; keep only intentional public work visible.

**Dependencies:** owner-selected contact/support route and contributor policy.

**Validation / completion check:** while private, render and review every reporting/contribution template in a staging or local fixture and dry-run the routing without private data. Immediately after the controlled visibility/protection transition, repeat the links and form checks anonymously; any failure blocks announcement, signing, and release publication.

### P0-R3 — Complete third-party licence and provenance inventory

**Deliverables**

- Add `THIRD_PARTY_NOTICES.md` (or an equivalent generated notice bundle) covering npm, NativeScript, native libraries, models, fonts, firmware-research sources, and every component shipped in the APK.
- Include required licence texts, exact versions/source URLs, modification notices, and corresponding-source obligations.
- Repair the `firmware-research/` publication bundle: its checked-in manifest currently references absent files and has checksum mismatches. Either make the documented verification package self-contained and reproducible or clearly remove it from launch claims.

**Dependencies:** legal/licence review of the actual release contents and a frozen artifact manifest.

**Validation / completion check**

- Rebuild the notice inventory from a clean clone and compare it to the APK/SBOM contents.
- Run `sha256sum -c firmware-research/MANIFEST-SHA256SUMS` successfully for the scope the manifest claims to cover.
- Run every verifier/test command advertised by `firmware-research/README.md` successfully from the public checkout.

### P0-R4 — Enforce repository governance before protected signing

**Deliverables**

- Prepare and review the exact ruleset while private. If public visibility is what enables the API, treat visibility plus protection as one controlled transition: change visibility, immediately apply and read back protection, and revert to private if protection cannot be enforced. No signing, release publication, contributor announcement, or public-launch claim may occur during the unprotected interval.
- Protect `main` with exact required `release-gate` and `codeql` checks, at least one approval, conversation resolution, blocked force-push/deletion, and a documented squash/linear-history policy.
- Enable CodeQL result publication. Review or narrowly document/suppress the known compatibility-only cryptography finding rather than allowing green workflow status to hide unexplained SARIF results.
- Keep `PROTECTED_RELEASE_ENABLED` absent/false until the effective rules are read back from GitHub.

**Dependencies:** repository visibility/plan capability; named maintainers/reviewers; reviewed CodeQL exception rationale.

**Validation / completion check**

- Read back the effective rules through the GitHub API.
- Demonstrate that an unreviewed direct update and a PR missing either required check cannot update `main`.
- Confirm the Security tab contains uploaded CodeQL results and zero unexplained high-severity findings.

### P0-A0 — Verify user-data flows, privacy disclosures, retention, and deletion

**Deliverables**

- Reconcile the frozen artifact with `PRIVACY`: audio/transcription, saved recordings, health history/export, notifications, calendar, location/navigation, files, credentials, bridge/direct AI providers, logs, and every network destination.
- Add a data-flow and retention/deletion/export matrix. State what stays on-device, what is sent, when third-party policies apply, how long data persists, what clear/uninstall removes, and what cannot be recovered after Keystore loss.
- Version the policy, provide a public privacy contact, link it from the README/release and in-app surfaces, and state that health/readiness output is not medical advice.
- Ensure first-run and feature-activation disclosures precede collection/transmission and remain truthful when optional permissions or providers are denied.

**Dependencies:** frozen feature set; provider inventory; owner-approved privacy/support contact; selected distribution channel.

**Validation / completion check:** inspect the packaged app and runtime network/log behaviour against the matrix; exercise consent, deny, revoke, export, clear, preview exit, app-data clear, and uninstall paths with synthetic data; verify every in-app/release policy link anonymously and obtain independent privacy review.

### P0-A1 — Freeze a safe preview feature set and default journey

**Deliverables**

- Define the preview SKU as sideload-only and ARM64 Android 7+ unless the verified artifact proves a broader contract.
- Keep G2 flashing, WhatsApp, R1 pairing/provisioning/NVM/DFU/reset/wipe/power, public MCP/dynamic apps, and unverified firmware controls inaccessible.
- Make the first-run path usable without a public Hermes bridge: preview mode and direct fallback must be clear; private bridge features must not be represented as generally available.
- State prominently that the official Even app performs first-time setup and maintenance and must release Bluetooth during Hermes use.

**Dependencies:** product owner approval of the exact preview claim set and navigation visibility.

**Validation / completion check:** on a fresh install with no bridge and no glasses, complete onboarding into preview mode, exercise exit/re-entry, deny optional permissions, and confirm no blocked feature can initiate a gated operation.

### P0-A2 — Decide package/signing/version identity and publish a current artifact

**Deliverables**

- Decide whether to retain `com.faceclaw.app` for owner-upgrade compatibility or migrate to a publisher-controlled Hermes package ID before broad distribution. Document state/credential migration or clean-install behaviour.
- Establish signing-key custody, backup, rotation, incident, and successor-maintainer rules.
- Increase `versionCode` and set a release-specific `versionName`; do not republish the older preview as evidence for current `main`.
- Extend the protected workflow to create the intended tag/GitHub Release, attach APK, checksum, SBOM/notices/provenance, and perform post-publication read-back without exposing signing credentials.

**Dependencies:** P0-R4; owner package-ID and signing-custody decisions; green frozen release candidate.

**Validation / completion check**

- `apksigner verify --verbose --print-certs <apk>` matches the approved certificate.
- Upgrade from the intended predecessor and clean install both behave as documented; credentials and app-private data follow the approved migration contract.
- Anonymous download read-back proves exact tag target, file set, size, SHA-256, signature, version metadata, SBOM/notices, and ZIP integrity.

### P0-A3 — Create a least-privilege public flavor

Required before any publicly downloadable APK, including a development sideload preview, to match the maintained release contract in `docs/release-security.md`.

**Deliverables**

- Replace broad storage access with Storage Access Framework flows.
- Narrow package visibility while preserving the product requirement to enumerate installed notification packages, with distribution-policy justification where an exception is necessary.
- Request microphone, location, notification, calendar, exact-alarm, and battery permissions only when the related feature is activated; define denial/revocation behaviour.
- Separate developer-only controls and permissions from the public artifact.

**Dependencies:** distribution-channel decision; feature inventory; store-policy review.

**Validation / completion check:** inspect the packaged manifest, exercise fresh-install grant/deny/revoke flows on supported Android versions, confirm core preview operation without optional grants, and complete the selected store’s policy declarations.

### P0-A4 — Qualify the exact signed preview candidate on real G2 hardware

**Deliverables**

- Select at least one explicitly preview-supported phone/G2 configuration and test the exact protected APK that will be published, not an earlier debug lineage.
- Prove non-destructive setup hand-off, two-arm connection, through-lens ordinary rendering, wearer input, disconnect/reconnect, preview fallback, and sentinel-clean logs. Record every untested capability as unsupported.
- Keep pairing, provisioning, firmware, reset, wipe, ownership, and other destructive actions outside this gate.

**Dependencies:** P0-A2 and P0-A3 candidate; already provisioned compatible G2; redacted synthetic evidence procedure.

**Validation / completion check:** evidence ledger binds phone/G2 alias, source SHA, APK SHA-256, signing certificate, version, expected/observed rows, redacted logs, through-lens synthetic output, reviewer, and explicit preview GO. Any missing core row stops APK publication.

## Before Milestone B: supported app and glasses release

### P0-G1 — Define and pass the supported hardware matrix

**Deliverables**

- Publish the exact phone architectures/Android versions, G2 revisions/firmware contracts, R1 scope, and unsupported combinations.
- Test cold start, reconnect, official-app contention/release, process restart, Bluetooth toggle, screen-off/Doze, charging, permission revoke/restore, and upgrade.
- Separate evidence into STATIC, SIMULATED, PHONE-ONLY, PHONE+REAL-G2, and DESTRUCTIVE/RECOVERY. Never infer lens visibility or wearer input from a build or phone launch.

**Dependencies:** representative non-destructive phones and provisioned G2 pairs; redacted evidence procedure; frozen release APK.

**Validation / completion check:** every supported matrix row has dated release-SHA/APK identity, expected and observed results, synthetic-content evidence, sentinel-clean logs, and a named reviewer. Unsupported rows fail closed or are documented.

### P0-G2 — Qualify the normal G2 runtime

**Deliverables**

- Prove both-arm session establishment, frame acknowledgements, through-lens rendering, wear/wake, gestures, voice/wakeword, battery/charging behaviour, disconnect/reconnect, and stale-session rejection on every supported G2 contract.
- Run bounded soak and rapid app/window transition tests; record latency and error budgets.
- Keep CFW-only rendering disabled until both arms report the exact required capability contract.

**Dependencies:** P0-G1; non-private synthetic scenarios; stable approved firmware already present on test devices.

**Validation / completion check:** execute the checked-in hardware matrix against the exact signed candidate and archive only redacted evidence. No pairing, firmware, reset, or ownership change is implied by this non-destructive gate.

### P0-G3 — Establish firmware provenance, installation, and recovery before advertising full stock-to-Hermes setup

**Deliverables**

- Repair the hermetic firmware build/verification package and pin every source, tool, binary hash, and output hash.
- Define a durable two-arm transaction/recovery model, power/battery preflight, interruption handling, mixed-arm recovery, post-boot version/capability verification, and stock restoration.
- Complete independently witnessed sacrificial-hardware recovery for app kill, BLE loss, power loss, block/component interruption, one-arm success/second-arm failure, repeated restore, and wrong/stale acknowledgements.
- Keep installation disabled in public artifacts until an independent high-risk review and a separately recorded owner GO approve the exact candidate and procedure.

**Dependencies:** explicit owner authorization; named sacrificial pair; independent recovery lead; genuine hash-pinned stock image; safe restore path; P0-R3.

**Validation / completion check:** the reviewed runbook passes simulation first, then every authorised recovery row on sacrificial hardware. The final signed APK is inspected to prove the intended gate state and accepted hashes. Any missing row remains NO-GO.

This gate is mandatory for Milestone B even when installation remains disabled: a broadly supported full glasses release must have a witnessed recovery boundary for the compatible custom-firmware state on which its full UI depends. Milestone A may leave it NO-GO only because it is explicitly a development preview and does not claim broad glasses support or a stock-to-full-Hermes setup.

### P0-A5 — Provide a maintainable supported assistant path

**Deliverables**

- Publish and version an authenticated, certificate-validating Hermes bridge with installation, health check, compatibility, upgrade, rollback, and support instructions, or make a fully supported local/direct backend the default.
- Validate wakeword → bridge/provider → agent → bounded tool → response, plus certificate failure, bad credentials, cancellation, reconnect, stale-turn rejection, replay/idempotency, and bridge upgrade.
- Keep public MCP/dynamic apps/HA control excluded until their separate security, licensing, generic-client, credential, privacy, mutation, and real-G2 gates pass.

**Dependencies:** maintained bridge distribution/licensing, TLS identity, test credentials, and P0-G2.

**Validation / completion check:** a new operator completes setup from public documentation on a fresh phone/host and passes the end-to-end negative and recovery matrix without private instructions.

## Launch runbook

1. Freeze one release-candidate SHA and record scope, version, package ID, signing certificate fingerprint, supported matrix, and exclusions.
2. Complete P0-R1 through P0-R3 and prepare the exact P0-R4 ruleset while private. Obtain explicit owner GO before changing visibility; public Git and GitHub-hosted data must be treated as permanently copied once exposed.
3. Make the source public, immediately apply/read back P0-R4 protection, and verify anonymous clone/docs/issues/security links. If protection cannot be enforced, revert visibility, stop, and remain NO-GO; do not enable protected signing or announce launch.
4. Complete P0-A0 through P0-A3 for Milestone A. Run `npm ci`, `npm test`, `npm run typecheck`, `npm run build`, dependency audits, CodeQL, SBOM/notices, artifact verifier, link checker, and privacy/history scan on the frozen SHA. The accepted audit threshold is zero critical/high findings and only explicitly reviewed development-only moderate exceptions recorded in `docs/release-security.md`.
5. Produce the protected artifact only after all required checks and approval pass. Verify signature, package/version, permissions, source identity, SBOM/notices, size, SHA-256, ZIP/ELF alignment, clean install, approved upgrade, and rollback instructions.
6. Complete P0-A4 on the exact protected artifact before upload. Do not perform pairing, provisioning, firmware, reset, wipe, or other destructive work without a separate exact-scope authorization.
7. Publish tag/release and read it back anonymously: base/source SHA, tag target, files, checksums, signatures, release text, URLs, and prerelease/stable state.
8. Execute any broader non-destructive supported matrix required by the advertised claim set.
9. Publish a GO/NO-GO record. Any missing P0 evidence is NO-GO or requires removing that capability/claim from the launch SKU.
10. Monitor crash/security/support channels and preserve a signed rollback artifact. Never “unpublish” as a substitute for incident response because clones and downloads may persist.

## Post-launch backlog

- Expand phone, Android, G2 revision, reconnect, Doze, charging, microphone, calendar, R1, and long-duration stability coverage.
- Replace bundled offline models with optional hash-verified downloads to reduce artifact size.
- Complete coordinated NativeScript migration for the remaining development-tool moderate advisories.
- Add standalone R1 provisioning only after ownership/NVM/recovery evidence; complete sleep decoding only after matching fail-closed ground truth.
- Reconsider WhatsApp, public MCP/dynamic apps, Home Assistant control, and firmware installation only through their separate security, privacy, licensing, hardware, and recovery gates.
- Add project topics, homepage/social preview, release cadence, deprecation policy, compatibility page, and community-list submissions after stable anonymous URLs and a supported artifact exist.

## Launch approval checklist

Milestone A is GO only when:

- [ ] P0-R1 public history/privacy review is signed off.
- [ ] P0-R2 public security and contribution intake works anonymously.
- [ ] P0-R3 licences/notices and firmware-research publication claims verify.
- [ ] P0-R4 effective branch protection and CodeQL reporting are read back.
- [ ] P0-A0 data-flow/privacy policy, retention/deletion, and disclosures match the artifact.
- [ ] P0-A1 preview scope is fail-closed and documented.
- [ ] P0-A2 current protected artifact, identity, version, signature, and anonymous release read-back pass.
- [ ] P0-A3 least-privilege public flavor passes grant/deny/revoke checks.
- [ ] P0-A4 exact signed preview candidate passes its explicitly supported phone/G2 row.
- [ ] All CI, build, audit, privacy, documentation-link, and clean-install checks pass on one frozen SHA.

Milestone B is GO only when all Milestone A checks, P0-G1 through P0-G3, and P0-A5 pass, and every advertised glasses capability has exact signed-artifact hardware evidence. Firmware installation may still remain excluded after recovery qualification unless its exact install procedure receives separate approval.
