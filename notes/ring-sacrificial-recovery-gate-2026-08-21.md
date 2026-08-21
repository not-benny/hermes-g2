# R1 sacrificial recovery gate (2026-08-21)

> **Static protocol: REVIEW PENDING** — this document defines a safety gate only;
> it does not establish a recovery path.
>
> **Operational authorization: NO-GO** — no firmware build, DFU, device write, pairing change,
> recovery injection, or interruption experiment is authorized by this document.
>
> **Recovery gate: BLOCKED/UNKNOWN** — no independent recovery path has been demonstrated.
> If the evidence review confirms that no such path exists, the verdict is terminal
> **FAIL — NO RECOVERY PATH** and no interruption experiment may start.

## Purpose and non-goals

This protocol defines the evidence a future, separately approved lab exercise would need before
risking an R1 ring with a controlled transport/process failure. It does not authorize or perform
private-firmware inspection, firmware construction, APK installation, ADB/BLE access, pairing or
unpairing, bootloader entry, `otaStart` or buttonless-DFU packets, power interruption, battery
exhaustion, factory reset, or any device modification. Possessing a private DFU candidate, a
successful ordinary update, Nordic generic behavior, app installation, or static documentation
review is not recovery evidence and does not authorize destructive testing.

The six mutator blocklists remain in force: `otaStart`, `advStart`, `setAlgoKey`, `nvRecover`,
`powerControl`, and `pairDelete`. This protocol does not weaken them or authorize a raw-frame
bypass. Any non-sacrificial ring transfer remains separately prohibited.

## Authority and independence

A future run requires a separate reviewed approval that names the units, scenarios, artifacts,
operator, and observer. Static documentation approval is distinct from hardware authorization,
licensing, and any later consent for non-sacrificial maintenance.

Recovery must be independent of the Hermes updater under test. Acceptable evidence is either:

- a demonstrated official Even recovery workflow; or
- a vendor/debug/service mechanism with known board access, the correct signed restore image,
  and an operator/toolchain independent from Hermes.

A second unproven Hermes or Nordic client is not independent. The independent route must first be
rehearsed successfully without failure injection. If no route meets these conditions, record
**FAIL — NO RECOVERY PATH**, stop, and do not enter bootloader or interrupt a transfer.

## Required lab allocation and equipment

- Two inventory-tagged, owner-designated **sacrificial R1 units**: one DUT and one separately
  designated spare/control. Each immutable unit ID must be in the authorization manifest.
- An isolated test phone/host, on AC/UPS, with chargers/UPS and recorded RF conditions.
- An independently proven recovery adapter/toolchain, if the selected recovery route requires one.
- A named operator and safety observer, with continuous physical and temperature observation.
- Clock-synchronised, bounded evidence capture for the phone/host, BLE trace, recovery tool, and
  relevant app logs. Raw evidence is retained privately; tracked documents contain redacted
  credentials and MACs plus stable hashes.

Provisioned or non-sacrificial devices must be absent or radio-isolated. Device selection fails
closed against the authorization manifest; a personal or otherwise non-sacrificial ring is never a
substitute.

## Preflight: every item is mandatory

Record PASS/FAIL/UNKNOWN before any failure injection. Missing or unknown is **STOP**, not a
waiver:

1. Written destructive-test authorization exists for each unit, with owner, scope, and expiry.
2. Both immutable inventory/unit IDs match the manifest; DUT and spare/control roles are explicit.
3. A canonical signed restore/update image or package is identified by stable hash, with signature,
   compatibility, and provenance verdicts captured. Existence is not a verdict.
4. The official app → bootloader → DFU state machine, including safe observable checkpoints and
   rediscovery identity/address mapping, is captured from the real R1 flow. Never guess packet
   offsets, erase timing, banking, or a checkpoint that the evidence does not expose.
5. Standalone bond ownership and the recovery route's identity/rediscovery behavior are proven.
6. Battery telemetry and the minimum threshold are known; baseline `deviceInfo`, health, and
   connection checks pass for each unit.
7. Phone/host, ring, charger, RF, firmware/container, app, OS, tool, and commit/config versions
   are recorded; log sources are UTC clock-synchronised.
8. The independent recovery route has completed a rehearsal before failure injection.
9. A named safety observer is present and has authority to stop the run.
10. The isolated host sees only the authorized sacrificial target; no non-sacrificial discovery
    or transfer is possible.

## Conservative controls and stop rules

- Ring battery is **≥80% and stable** before each run. Phone/host is **≥80% and on AC/UPS**.
- Record chargers, power state, RF environment, temperature, and physical observations.
- Keep one DUT active and in range; do not run both simultaneously. Exercise the second unit in
  separate runs as the designated spare/control.
- Do not intentionally drain, cut, or interrupt ring power. Controlled failures terminate the
  transport/process only: client termination, BLE loss, or host restart, at an observable approved
  checkpoint.
- Stop immediately and quarantine if identity/address mapping differs, an unexpected erase/state
  appears, telemetry is lost, temperature rises abnormally, swelling or other physical concern is
  seen, a non-sacrificial device is discovered, an artifact/hash or signature verdict changes, or
  the run deviates from the captured flow.
- Allow at most **two failed independent recovery attempts** per affected unit. Then quarantine
  and tag the unit and escalate. No improvisation, guessed packets, factory reset, power cycling
  as a recovery method, or substitution of a personal ring.

## Ordered scenario matrix (future approval only)

Run the baseline and independent-route rehearsal first. For each authorized scenario, capture the
checkpoint from the observed state machine, inject only the named transport/process failure, then
attempt independent recovery and complete post-restore checks:

| Order | Scenario / controlled failure | Required safe outcome |
| --- | --- | --- |
| 1 | Signature/package rejection **before destructive transition** | Old app remains functional; otherwise independent route restores it. |
| 2 | Bootloader-entry / pre-transfer transport loss (client termination or BLE loss) | Rediscovery is understood and the independent route restores the unit. |
| 3 | Mid-transfer transport/process loss | Independent route restores the unit with no unexplained anomaly. |
| 4 | Post-transfer / pre-activation loss, **only if the observed protocol safely exposes this checkpoint** | Independent route restores the unit and baseline checks pass. |

Do not invent a fourth checkpoint, packet offset, erase boundary, or activation boundary. If the
protocol does not expose scenario 4 safely, mark it NOT RUN with rationale; do not force it.

“Repeatable” means every authorized scenario succeeds with no unexplained anomaly in at least
**three consecutive cycles per scenario**, exercises **both sacrificial units**, and includes at least
one recovery per unit after an interruption known to occur after bootloader entry. A single success,
normal update, or recovery of only one unit is insufficient.

## Independent recovery procedure requirements

The evidence bundle must show the route was rehearsed and is independent, uses the correct
signature-valid/hash-identified restore artifact, reaches the correct board/unit, and restores the
unit without Hermes updater assistance. Record each attempt and result. A route that cannot be
proven before the experiment is UNKNOWN; if no qualifying route exists, the gate is terminal
**FAIL — NO RECOVERY PATH**.

## Evidence schema per run

Use UTC timestamps and stable, private raw-evidence hashes. Record:

- authorization and manifest, DUT/control inventory IDs, operator, safety observer;
- hardware, tool, app, OS, Hermes commit/config, and recovery-tool versions;
- firmware/container hashes, signature verdict, compatibility/provenance verdict;
- ring/phone battery, RSSI, charger/power state, RF and temperature observations;
- ordered UTC event timeline, BLE trace, tool logs, and bounded ADB/app logs where separately
  authorized (redact credentials and MACs in tracked material);
- injected-failure checkpoint and method, bootloader address/identity mapping;
- each independent recovery attempt, result, anomaly, and quarantine decision;
- post-restore firmware/version, `deviceInfo`/health/connection results, and baseline functional
  checks.

## Verdict and next approval checkpoint

A reviewer may mark the recovery gate **PASS** only when the complete evidence bundle proves the
independent route, all mandatory preflight items, the two-unit/three-cycle repeatability rule,
and clean post-restore baselines. Any missing or unknown prerequisite is **UNKNOWN/STOP**. No
independent recovery path is terminal **FAIL — NO RECOVERY PATH**. A PASS still does not authorize
firmware build/DFU or any non-sacrificial transfer: a separate reviewed approval must explicitly
name the next safe action and preserve all six mutator blocklists.

Current checkpoint: retain T1 as **NO-GO**. Reconsider only after a complete, reviewed, two-unit
evidence bundle exists and the independent recovery route has been demonstrated; until then do not
build, ship, or execute ring firmware writes.