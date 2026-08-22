# Hermes G2 handover — 22 August 2026

## Renderer-jank candidate

The `perf/glasses-renderer-jank` candidate starts from canonical `main` at
`f02d8f88bb44e147dad213e36a2ab16ad304aebe`. It adds a non-destructive,
privacy-allowlisted 60-second USB A32 benchmark (`scripts/run-render-benchmark.sh`)
that records phone framestats, PSS, GC lines, and the existing per-frame paint,
fingerprint, bitmap snapshot/bridge, composite, 4-bpp pack, compression/plan,
Bluetooth-send, and application-ACK landmarks. It auto-discovers USB and does
not publish device identifiers, pair/reconnect, clear data, toggle Bluetooth,
or send a new device command.

The measured fixes are deliberately small: ordinary shell render bursts now
coalesce to one follow-up while strict alert deliveries keep separate receipts;
idle frame submission avoids an approximately 18 ms timer hop; typed-array
snapshot copying uses the native `slice` path; an already queued image blocks a
redundant heartbeat; and repetitive successful frame, GATT-write, image-plan,
enqueue, and ACK logs are removed from release hot paths. The scheduling/copy
changes are provenance-compatible ports of isolated Faceclaw commit
`f6035ea9ecdabd13cc85af1e26ef518ae64d3d6b`; no texture-cache firmware modes or
device commands were ported.

Delivery semantics are stronger, not weaker: strict operations accept only
ACK-backed `sent` outcomes and reject queued-image deduplication, missing, or
failed receipts; only the first communicator terminal frame result reaches TypeScript; and
multi-message images report `sent` only after every distinct application ACK,
including out-of-order ACKs. Ordinary redraw work cannot inherit or extend a
strict owner's receipt, and the inline Java-call fast path remains busy across
synchronous reentrancy. Focused RED/GREEN contracts pass 7/7 and the full
host suite passes 265/265. TypeScript and the JDK 21 / SDK 35 Android build pass.
The final debug APK SHA-256 is
`98c87fa58d96f8386a526759807adb5c92337e64668a979d8ce3f6edbec41425`.

The frozen preview.1 idle observation reproduced the reported phone-jank floor:
33/45 frames janky (73.333%), p90 20.498 ms, p99/max 24.643 ms, PSS
245217→244282 KiB. A later candidate idle interval produced no phone frames and
therefore no valid jank percentile; PSS fell 276480→180944 KiB rather than
growing. The candidate APK was installed and launched on the USB Samsung A32.
A real two-message G2 image reached application ACKs and only then completed its
receipt (`frame#10`, 4353 ms including initial connect/warm-up), proving the
all-ACK path on hardware. Its measured stages were paint 7 ms, fingerprint
0 ms, 8-bpp copy 0 ms, bridge snapshot 1 ms, Java submit 10 ms, composite 5 ms,
4-bpp pack 1 ms, compression/plan 249 ms, first Bluetooth write at 4191 ms,
last write at 4221 ms, and final application ACK at 4353 ms. Later connected
frames completed in 374 ms and 371 ms; this is an honest hardware/radio floor,
not a claim that the requested 50 ms end-to-end threshold was met.
The fixed-duration post-change run was contaminated by
another concurrent A32 installer replacing the package, so it is not used to
claim the below-10% / p99-under-50-ms target. The remaining measured floor is
startup/radio/compression work, not phone paint, snapshot, composite, or pack.
No firmware, DFU, OTA, pairing, provisioning, reset, wipe,
power, or NVM operation was performed.

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
2. Validate the private bridge end to end with an authenticated `wss://` server,
   exact-turn envelopes, credentials, and a disposable generic client.
3. Complete the deferred non-destructive G2/R1/Doze/calendar/mic matrix when the
   live devices are available without contention; do not infer it from this APK.
4. Obtain the missing type-1 R1 sleep evidence only under a separately reviewed,
   reversible, private capture plan.
5. Keep firmware/recovery work blocked unless every independent provenance,
   authority, recovery, privacy, power, and per-run consent gate passes.