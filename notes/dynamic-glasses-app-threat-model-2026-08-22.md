# Contextual-dashboard threat model — 23 August 2026

## Trust boundary

Hermes is trusted orchestration, but tool/web/provider output is untrusted data.
Only the dedicated authenticated `even-g2` profile may invoke the contextual
surface. The phone independently validates a bounded read-only model and owns
layout, fixed local actions, encrypted pin intent storage and current G2
transport receipts. The glasses receive pixels and wearer-input handling; they
receive no credential, provider connection data, executable code, generic tool
name or external capability handle.

## Lifecycle identities

| Object | Authority | Live identity | Fail-closed rule |
|---|---|---|---|
| Profile | authenticated Hermes deployment | literal `even-g2` + device | no default-profile fallback or cross-profile cache |
| Bridge | authenticated server | connection generation | replacement tombstones old turns, runs, views and receipts |
| Turn | MCP server | internal turn generation | every begin/publish/refresh call must be the exact active turn |
| Dashboard | phone | random dashboard ID | new ephemeral dashboard replaces the old presentation |
| Presentation | phone | dashboard + presentation generation | close/reopen never revives prior callbacks or events |
| Refresh | host/phone CAS | refresh generation | newer refresh rejects every older result and timer |
| Revision | phone CAS | presentation + revision | only acknowledged current frame commits |
| Local event | phone | presentation + revision + event ID | queue-head-only, fixed enum, exact acknowledgement |
| Pin | phone secure store | profile + dashboard key | max five; intent/policy only; corrupt store fails closed |

A dashboard may outlive the turn that created it, but the old turn gains no
continuing authority. A later refresh uses a new exact current turn plus the
current dashboard/presentation/refresh/revision tuple. There is no fallback to
"whatever turn is active."

## Security invariants

1. Release 1 has no external actions. Only phone-local refresh, pin, unpin,
   section and follow-up intents exist.
2. Host adapters project allowlisted typed fields; raw objects are never copied
   into the model, persistence, logs, errors, handles or receipts.
3. Host and phone reject unknown fields, duplicate IDs, invalid source links,
   excessive bytes/counts, non-finite/timestamp errors, markup/URLs, controls,
   bidi overrides and arbitrary actions.
4. Source/freshness/uncertainty are structured fields. The phone derives age and
   stale state from its own clock; provider-written confidence prose is inert.
5. Loading and useful publication succeed only after the current connected G2
   transport returns `sent`. Enqueue, local render and stale/discarded outcomes
   are not success or lens-visibility evidence.
6. Every delayed gather, timeout, patch, receipt, close and event revalidates the
   exact profile/socket/presentation/refresh/revision authority immediately
   before publication.
7. Pin storage is encrypted and contains only bounded intent, key/title/privacy
   and refresh policy. `sensitive` views, rendered values, raw responses,
   provider IDs, handles and receipts are never persisted.
8. Local refresh reruns current authorised read-only gathering from saved intent;
   it never replays an old tool payload or response.
9. Disconnect/owner close clears transient events and presentation authority.
   Pins retain no current data and reopen through a fresh authorised gather.
10. Long-press is shell-owned contextual voice; double-click remains shell-owned
    close. Remote data cannot trap, redirect or redefine wearer input.
11. Errors crossing the boundary are fixed bounded codes/copy, never provider or
    exception text.
12. No firmware, pairing, ownership, provisioning, NVM, reset, wipe, destructive
    BLE, smart-home mutation or generic terminal authority is introduced.

## Adversarial coverage

Permanent tests exercise:

- executable/URL/unknown-field/action-kind rejection;
- source-reference, count, byte and record bounds;
- loading acknowledgement before blocked gathering;
- deterministic all-destination Liverpool departure ordering, fallback time,
  cancellations and departed-row exclusion;
- exact socket with safe later-turn refresh and stale generation rejection;
- fixed local refresh queue head, duplicate acknowledgement and bounded intent;
- pin projection proving rendered/source/announcement data is absent;
- dedicated-profile rejection before phone calls; and
- existing MCP cancellation, owner teardown, discarded transport receipt,
  reconnect and dynamic-view races in the full suite.

Final review must additionally probe blocked interleavings for begin replacement,
publish vs close, refresh A/B reordering, disconnect during frame delivery,
process restart, corrupt/sixth pins, event replay after reconnect, clock skew,
backpressure and timer resurrection. Secret sentinels must be injected into
provider labels, headers, errors, redirects, nested fields and persistence, with
zero occurrences in host output, phone payload, logcat, storage, telemetry,
screenshot metadata or support exports.

## Verdict boundary

Static review: pending independent review of the final frozen candidate.

Operational authorization: NO-GO until authenticated `even-g2` bridge and real
A32/G2 evidence prove latency, scroll/focus, local refresh/pin/contextual voice,
disconnect/restart handling and sentinel-clean operation. A source build or one
ordinary frame ACK is not optical or dual-lens proof.

Publication/licensing: BLOCKED pending authenticated generic-client
interoperability, deployment credential/retry evidence, licensing review and the
real-G2 evidence above.
