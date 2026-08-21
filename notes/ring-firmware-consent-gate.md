# R1 Ring Firmware Investigation Consent Gate

**Status: DOCUMENTATION PASS; OPERATIONAL AUTHORIZATION: NO-GO**

This reusable gate governs any future R1 ring firmware investigation, capture, recovery rehearsal, or firmware test. It authorizes documentation only today; it does not authorize firmware work. Consent is necessary but never sufficient: protocol intelligence, authentic-image provenance, pairing/authority, privacy, and independently demonstrated recovery remain separate prerequisites.

## 1. Scope and fail-closed policy

The permitted tiers are separately approved and never transfer between one another:

1. **Read-only offline investigation** — public-safe documentation and analysis of already-authorized, redacted evidence; no device connection or device-affecting action.
2. **Non-destructive observation/capture** — observation or capture that cannot intentionally alter firmware, pairing, bootloader state, or device configuration, after protocol and privacy prerequisites are approved.
3. **Sacrificial device modification/recovery** — one specifically named sacrificial ring and one recovery procedure, with independent recovery responsibility and disposal expectations.

A companion-app install or UI exposure does not imply transfer consent. Approval for one device, artifact, operator, procedure, or run never transfers to another. No approval is standing, blanket, implied, or irrevocable. A phase approval alone never authorizes a device-affecting run.

A blank, ambiguous, stale, expired, revoked, scope-expanded, device-mismatched, artifact-mismatched, or procedure-mismatched record is an automatic **NO-GO**. Consent cannot override a failed protocol, genuine-image, pairing/authority, recovery, privacy, power, or environment gate. The present project recommendation remains **DO NOT BUILD**.

Secure-update protections are inviolable: never forge a signature, extract keys, disable validation, patch a bootloader, use a downgrade or exploit path, or otherwise bypass Secure DFU. Only an authentic, provenance-verified, hash-pinned, vendor-signed, compatible image could ever reach a separately approved test. Rejection is a STOP result, never a reason to circumvent it.

## 2. Required roles and separate signatures

Each role signs its own record with a UTC timestamp. One person may hold owner and operator roles, but a destructive/sacrificial test still requires a distinct safety approver. A sacrificial test also requires the independent recovery lead/witness named by the recovery protocol, with a separate signature.

- **Legal device owner or authorized custodian:** confirms ownership/authority and may revoke future consent.
- **Responsible hands-on operator:** confirms understanding of the procedure, risks, stop triggers, and duty to stop safely without improvisation.
- **Hermes G2 safety approver (Benny):** confirms the scope is explicit and independent gates are not collapsed into consent.
- **Independent recovery lead/witness (sacrificial tier only):** confirms recovery readiness and witnesses recovery/disposal outcome.

Any signatory may stop a run. A stop or revocation halts before the next device-affecting action. Resumption requires a fresh phase approval and per-run record; revocation does not erase the minimal prior audit record.

## 3. Two separately recorded approvals

### A. Phase approval record

One phase approval covers one named tier, purpose, procedure revision, and UTC validity window. It states allowed and prohibited actions, device scope, artifact/provenance requirements, evidence plan, risks, recovery expectations, privacy controls, stop authority, and the required signatures. Its unique ID/version must be referenced by every run. It is not a run authorization and must never be reused as one.

### B. Per-run GO/NO-GO record

Before each run, create a new record with its own unique ID/version and a reference to the governing phase approval ID/version. Bind it to the exact redacted device alias (with serial/MAC only in the private record), operator, artifact and complete hash, procedure revision, prerequisites, environment, and UTC start/end window. Reconfirm the phase scope and record a final GO or NO-GO. A GO is valid only for that device and window and never authorizes a later run.

## 4. Mechanical decision rule

A final **GO** is valid only when all of the following are true:

- the phase record and the per-run record are separate, complete, linked, unexpired, unrevoked, and within scope;
- every required signature is present, separately made, and UTC-timestamped;
- every required acknowledgment is exactly **YES**; any **NO** or blank forces **NO-GO**;
- every applicable gate is **PASS**; **FAIL**, blank, or unexplained **NOT APPLICABLE** forces **NO-GO**;
- `NOT APPLICABLE` is allowed only when the named tier genuinely does not involve that gate and the reason is recorded. Recovery lead identity/signature and recovery readiness may be N/A only outside the sacrificial tier; they are mandatory for that tier;
- identity, authority, artifact provenance/hash/compatibility, procedure revision, privacy, power, environment, protocol, pairing, and independent recovery prerequisites are all separately evidenced; and
- no signatory has stopped the run, the owner has not revoked consent, and no secure-update bypass has been requested.

Therefore phase-only, missing recovery signature for a sacrificial run, any required acknowledgment marked **NO**, or any failed/blank/unjustified gate is **NO-GO**. Only a valid non-destructive run with every applicable prerequisite and acknowledgment passing may reach GO; consent never overrides an independent gate.

## 5. Copyable phase approval record

Store the completed private record under the repo-excluded approval directory. Public documentation retains only approval ID, redacted alias, status, evidence hashes, and dates.

```text
R1 FIRMWARE CONSENT GATE — PHASE APPROVAL
Approval ID/version: ____________________   Created UTC: ____________________
Valid from UTC: _________________________   Valid to UTC: ___________________
Named tier (one only): READ-ONLY OFFLINE / NON-DESTRUCTIVE CAPTURE / SACRIFICIAL RECOVERY
Exact purpose, allowed actions, and device scope: ______________________________
Explicit prohibitions (including writes and scope expansion): ____________________
Ownership/authority proof reference (private): _________________________________
Permitted device class or named redacted alias: _________________________________
Artifact/provenance requirements and procedure revision: _______________________
Evidence links, storage/access, retention/deletion rule: ________________________
Risks reviewed: warranty/support; permanent brick/no manual recovery; data loss;
battery/fire/property; personal/health/account/BLE-capture privacy; other: ______
Stop triggers, safe-stop/no-improvisation procedure, notification channel: ______
Revocation channel and signatory notification list: _____________________________
Secure-update no-bypass acknowledgment: YES / NO
Owner/custodian signature + UTC: _______________________________________________
Hands-on operator signature + UTC: ____________________________________________
Hermes G2 safety approver (Benny) signature + UTC: ____________________________
Recovery lead/witness: N/A (only non-sacrificial tier) OR name, signature + UTC:
_______________________________________________________________________________
PHASE DECISION: GO / NO-GO   Rationale and failed gates: _______________________
```

## 6. Copyable per-run GO/NO-GO record

Create a new private record for every run. It must reference a valid phase record; it cannot be substituted by, appended to, or reused as the phase record.

```text
R1 FIRMWARE CONSENT GATE — PER-RUN GO/NO-GO
Run record ID/version: ____________________   Created UTC: ____________________
Governing phase approval ID/version: ___________________________________________
Exact redacted device alias: ____________________  Serial/MAC (private only): __
Legal owner/authority match confirmed: YES / NO   Operator: ____________________
Named tier and permitted action match: _________________________________________
Artifact name/provenance: ______________________  Hash algorithm + full digest: _
Compatible target/authenticity evidence: _______________________________________
Procedure revision matches phase: YES / NO   UTC run window: ________ to ________
Environment/power/recovery readiness evidence: _________________________________
Protocol gate: PASS / FAIL / N/A with tier-specific reason: _____________________
Genuine-image gate: PASS / FAIL / N/A with tier-specific reason: ________________
Pairing/authority gate: PASS / FAIL / N/A with tier-specific reason: _____________
Recovery gate: PASS / FAIL / N/A with tier-specific reason: _____________________
Privacy/evidence controls confirmed: PASS / FAIL / N/A with reason: _____________
All required risk and stop acknowledgments: YES / NO (every one must be YES)
Secure-update no-bypass acknowledgment: YES / NO (must be YES)
Owner signature + UTC: ________________________________________________________
Hands-on operator signature + UTC: ____________________________________________
Hermes G2 safety approver (Benny) signature + UTC: _____________________________
Recovery lead/witness: N/A only outside sacrificial tier OR signature + UTC: _____
PRE-RUN DECISION: GO / NO-GO   Failed or N/A rationale: _________________________
Start UTC (fill only after GO): ______________  End UTC: _______________________
Closure: NOT STARTED / COMPLETED / STOPPED / RECOVERY / DISPOSED / OTHER: ______
Evidence hash index, notifications, and minimal redacted audit reference: ______
```

## 7. Mandatory pre-run STOP conditions

Stop safely without improvising, preserve minimum permitted evidence, notify signatories, and obtain fresh records before resuming for: identity or ownership mismatch; missing/incomplete/expired/revoked signature; unresolved prerequisite; artifact, provenance, hash, or procedure drift; inadequate recovery, power, environment, or fire/property controls; unexpected protocol, pairing, device, bootloader, or device-state result; privacy spill; any request to bypass secure-update validation; any signatory stop instruction; owner revocation; or scope/time-window change.

## 8. Private evidence, retention, and public record

Private signed forms, exact serials/MACs, ownership proof, captures, raw logs, and proprietary artifacts belong under a repo-excluded directory such as `../ground-truth-private/firmware/approvals/<approval-id>/`. Do not inspect, copy, publish, or commit those files as part of this documentation gate. Public docs retain only approval ID, redacted alias, decision/status, evidence hashes, and dates.

Retain raw private evidence through closure plus 12 months, then securely delete unless the owner requests earlier deletion and no safety or legal hold applies. Retain the redacted decision/hash record for project auditability. Limit access to named people who need it for safety, recovery, or audit.

## 9. Current decision and review trigger

This is a static planning control, not operational authorization. The current decision is **NO-GO / BLOCKED / DO NOT BUILD**: consent documentation does not establish a genuine signed image, observed and validated DFU protocol, Hermes-owned pairing authority, or independent recovery on a sacrificial ring. A later review may reconsider only from a completed, scope-limited phase approval and a fresh per-run record after every independent gate is separately evidenced. Any failed gate preserves NO-GO.
