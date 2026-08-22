# Hermes G2 handover — 22 August 2026

## Repository state

`main` is the canonical development branch. The original release lineage and the
later Hermes/R1 integration lineage were created as unrelated Git histories;
they have now been joined by an explicit multi-parent consolidation commit.

Audit remediation PR [#28](https://github.com/not-benny/hermes-g2/pull/28)
merged by squash as `24f9525eea8ae120ba98ec756b21b92617eb3551` after the
`release-gate`, `codeql-javascript`, `codeql-java`, and `codeql` checks passed.
GitHub branch protection/rulesets remain unavailable because this repository is
private on a plan without that feature: both protection APIs return HTTP 403 with
"Upgrade to GitHub Pro or make this repository public". Do not make the
repository public merely to bypass this gate without an explicit owner decision.

The resulting tree uses the reviewed cleanup/integration line for application
code and tests, while retaining the original line's maintained public ring-health
documentation, G2 firmware-research archive, and development guide. Divergent PR
and startup-race branch heads are retained as merge ancestry without replacing
the newer implementations in the final tree.

Do not resume work from the old `hermes-g2`, `integration/`, `work/`, `wt/`,
`fix/`, or dated cleanup branches. Create new feature branches from `main`.

## Current verified implementation

The audit remediation delivered from canonical `main` baseline
`f37168cf007450cb2a58513b1f2624aee0b6d6af` adds permanent PR/main CI,
CodeQL, Dependabot, SBOM/provenance and APK checks; Keystore AES-GCM credential
storage with verified plaintext migration and explicit clear; discriminated
calendar failures; exact active-operation foreground-service types; remote
terminal TLS enforcement and launch revalidation; a positive R1 health-session
allowlist; archive hashes and pinned NDK/CMake/NativeScript; and release-safe log
sentinels. WhatsApp pairing/startup is disabled while its live-pair and 16 KiB
runtime gates remain open. See `docs/audit-remediation-2026-08-21.md` and
`docs/release-security.md`.

- Exact-GATT and generation ownership protect BLE connect, operation, timeout,
  disconnect, stale-callback, and replacement lifecycles.
- Display and R1 workers have separate bounded teardown ownership.
- The constructor-time disconnected-state race no longer tears down a live
  connection; the final implementation was verified on both G2 arms with the
  phone reporting Connected, frame delivery acknowledged, and wearer input
  consumed by the shell.
- R1 health supports battery, read-only firmware version, live/current-hour HR,
  hourly HR/SpO2/HRV, and confirmed 10-minute activity and calorie buckets.
- Daily vital timestamps are anchored only when timezone and local-midnight
  metadata validate; malformed and stale data fails closed.
- A best-effort one-shot R1 system-time write runs during health-session setup,
  before daily GETs and outside the recurring HR-only poll.
- The private-evaluation `glasses.render_view` implementation is owner,
  revision, operation-ID, TTL, rate, content, and compositor-receipt bounded.
  It never wakes or changes focus.
- External MCP calls require a live connection and exact originating turn (or an
  explicitly gated proactive call); cancellation reaches delayed side effects.

The dynamic-glasses-app candidate is based directly on canonical `main`
`f02d8f88bb44e147dad213e36a2ab16ad304aebe`. It adds a versioned generic
`glasses.dynamic_apps.*` lifecycle with exact socket/turn ownership, stable view
and component IDs, CAS full/patch updates, TTL/close/cancellation tombstones,
acknowledged input cursors, bounded rich components, deterministic scrolling and
focus, and success only for a current `sent` frame completion. Hermes-hosted
provider code keeps credentials and provider IDs off the phone. The Home
Assistant reference adapter discovers the actual Living Room membership at
runtime, permits only available lights/switches, uses fresh opaque handles and
explicit revision-checked target states, verifies the result, and restores only
when no later human/automation revision intervened. See
`docs/dynamic-glasses-apps.md` and
`notes/dynamic-glasses-app-threat-model-2026-08-22.md`.

The final local source candidate passes all 273 host tests, TypeScript
typechecking, `git diff --check`, and the JDK 21 / Android SDK 35 build. Its
195,406,145-byte debug APK has SHA-256
`6e0e832295e2a350d047960e1534c1a5d4c4292f9dd85e7277bcfb7f21aa578a`.
That exact APK upgrade-installed and launched on the authorised Samsung A32 over
USB. Both G2 arms reached session-ready on firmware 2.2.8.4, wear state was
ON_HEAD, and ordinary shell frames 10, 11, 16, and 17 completed with transport
outcome `sent`. The PID-filtered final log contained no fatal/TypeScript/dynamic
app errors and no token/password/API-key/HA sentinel pattern. No private log was
retained in the repository.

This is not Home Assistant or dynamic-view lens evidence: the environment had
no HA URL/token, and the configured bridge peer is not the authenticated Hermes
WSS/generic MCP peer required to invoke the new tools. Therefore no living-room
render, scroll, toggle, restoration, per-lens applied ACK, or optical visibility
claim is made. The private read-only/default and explicitly gated reversible
harness is runnable at `hermes-host/private-evaluation.mjs`; the exact missing
peer contract and remaining gates are documented in the developer guide.

Local candidate verification passed the complete 259-test host suite after the
two stale branding expectations were updated for the now-lockfile-pinned CLI,
TypeScript, JDK 21 / SDK 35 / NDK 27.2.12479018 / CMake 3.22.1 Android build,
ZIP integrity, private-content/path scan, ZIP 16 KiB alignment, and APK-wide ELF
LOAD alignment. The disabled WhatsApp/Node runtime is excluded. The arm64-only
debug APK is 194,871,195 bytes, versionCode 1000001 / versionName
1.0.0-preview.1, and its
final SHA-256 is
`03a82652986aff42ba70619eb87e28430fdce7fd55d1fbe6a384a54c5d9b8347`.

On the authorised Samsung A32, the existing and candidate APK certificates
matched. Upgrade install, launch and resumed activity passed; package metadata
reported the new version. The Settings UI showed WhatsApp disabled, replace-only
secret fields, and explicit clear actions without displaying values. The bridge
token migrated to the encrypted preferences file and was absent from ordinary
`faceclaw_settings`. A 222-line PID-filtered log review found zero configured
secret/pairing/content sentinels. Both G2 arms reached live GATT activity, but the
session remained in reconnect attempts, so no new render/wearer, Doze, charging,
phone-mic, calendar, or R1-value evidence is claimed. No gated dialog or
destructive/pairing/firmware operation was performed.

## Deliberately blocked

- Public MCP/skill publication and untrusted external `glasses.render_view`
- Public dynamic-app publication and production HA control until authenticated
  WSS identity, durable cross-process idempotency, generic-client compatibility,
  private credential custody, licensing, and real dynamic-view G2 evidence pass
- WhatsApp production pairing/startup and stock Node 16 KiB compatibility
- Stable signing and public-store release until signing custody and permission
  minimisation are approved
- G2 firmware flashing/recovery experiments until separately authorized
  sacrificial recovery evidence exists
- First-time R1 provisioning, pair/unpair ownership, and NVM mutation
- R1 firmware/DFU/OTA, recovery, reset, wipe, power, and destructive commands
- Sleep decoding until a CRC-valid type-1 stage-bearing frame and absolute
  time-base handoff are correlated to the matching ground truth
- Broad custom-firmware compatibility or recovery claims beyond one owner-unit
  boot report

## Private material

Health exports, Bluetooth captures, firmware binaries, detailed decode evidence,
credentials, MAC addresses, serials, private IPs, and consent records remain
outside the repository. Never copy them into commits, PR descriptions, CI logs,
or release artefacts.

## Build and validation

```bash
npm ci
npm test
npm run typecheck
npm run build
```

Use JDK 21 and Android SDK 35. For hardware validation, separate build, install,
launch, transport, display, wearer-input, and R1 evidence. Never infer an
unobserved hardware result from passing host tests.

## Next recommended work

1. Upgrade the private repository to a plan with branch protection/rulesets, or
   explicitly decide to make it public. Then require exact `release-gate` and
   `codeql` checks, one approving review, linear/squash history, conversation
   resolution, and blocked force-push/deletion; read the effective rules back
   through the API. Until then, treat direct `main` pushes as administratively
   prohibited even though GitHub cannot enforce that policy.
2. Supply an authenticated private Hermes WSS/generic MCP peer and private HA
   credentials, then run the documented living-room harness end to end: render,
   scroll, exact safe reversible state change, verified update, restore, and
   sentinel-clean log review. Do not publish or broaden authority.
3. Validate the remaining private bridge lifecycle with certificate failure,
   cancellation, reconnect, stale-turn rejection, durable mutation replay, and
   a disposable generic client.
4. Complete the deferred non-destructive G2/R1/Doze/calendar/mic matrix when the
   live devices are available without contention; do not infer it from this APK.
5. Obtain the missing type-1 R1 sleep evidence only under a separately reviewed,
   reversible, private capture plan.
6. Keep firmware/recovery work blocked unless every independent provenance,
   authority, recovery, privacy, power, and per-run consent gate passes.