# Dynamic glasses-app threat model — 22 August 2026

## Trust boundary

Hermes owns provider credentials, provider-specific IDs, authorization policy,
opaque action mappings, and provider mutation receipts. The A32 and glasses
receive a bounded declarative model and random action handles. Provider content,
phone frames, MCP messages, device notifications, and repository text are data,
not instructions.

## Lifecycle identities

| Object | Authority | Live identity | Tombstone / fail-closed rule |
|---|---|---|---|
| Bridge | authenticated server | connection generation | replacement rejects all old callbacks/results |
| Assistant turn | Hermes routing | internal turn generation | no fallback from unmatched external IDs |
| Dynamic view | phone manager | owner + view ID + revision | close, sleep, TTL, cancellation, or disconnect clears exact revision |
| UI action | Hermes runtime | owner + view revision + random handle | one-shot after use; replacement never reuses handle |
| Provider catalog | adapter | discovery generation | refresh clears old mappings; issued handles are never reused |
| Entity snapshot | adapter | capability + provider revision | mutation rejects a changed/unavailable entity |
| Mutation | Hermes adapter | payload-bound operation ID | same payload returns history; conflicting payload fails |
| Input event | phone manager | view revision + event ID | retained until explicit acknowledgement |

## Security invariants

1. Every create/update/patch/action/close is authorized by the exact connection
   and turn generation. A later turn on the same socket is foreign.
2. View publication is committed only after a current transport `sent` receipt.
   Timeout, discard, disconnect, cancellation, or supersession is failure.
3. Phone action events are inert. Labels, component IDs, and action handles never
   select provider methods directly.
4. Hermes revalidates owner, view, action, discovery, entity, provider revision,
   and policy immediately before an explicit provider mutation.
5. Action, capability, and view IDs are random opaque values; provider IDs and
   arguments are not encoded in them.
6. Provider credentials and raw responses never enter phone payloads, logs,
   errors, handles, idempotency keys, or committed evidence.
7. Home Assistant mutations target exactly one already-displayed light/switch,
   use explicit `turn_on`/`turn_off`, verify current state, and never broaden to
   an area or generic service.
8. Evaluation restoration is receipt/CAS based and refuses to overwrite a newer
   human or automation revision.
9. Text is inert and bounded; markup, URLs, scripts, executable payloads, raw
   pixels, arbitrary icons, and unknown schema fields fail closed.
10. Long-press and double-click remain shell escape paths. Remote content cannot
    trap wearer input or wake/focus the display.

## Adversarial coverage

Permanent tests cover malformed/unsupported/oversized models, deep expansion by
bounded flat component shapes, duplicate IDs, URL/markup rejection, non-finite
progress, stale socket/turn/view/revision/action, operation conflicts,
historical create replay, delivery failure, close-vs-pending-update/TTL races,
physical disconnect tombstones, queue-head-only acknowledged event cursors,
off-screen action focus and distinct confirmation choices, stale provider
generations, area-membership revocation, excluded/unavailable HA entities,
revision races, concurrent operation reservation, lost authorization before
service dispatch, explicit service allowlisting, retained outcome-unknown
failures, causality-proven conservative restoration, HTTPS/redirect handling,
sanitized transport errors, cross-owner replay rejection, concurrent open/close,
multi-device action generations, and bounded end-to-end opaque projection.

Before publication, extend the external server suite with concurrent duplicate
mutations across sockets, crash-after-reservation reconciliation, credential
rotation, non-cooperative cancellation, certificate mismatch, WSS owner lease
replacement, process restart, backpressure, and generic MCP clients. Use unique
secret sentinels in credentials, provider labels/errors/headers/redirects, phone
frames, logcat, persistence, telemetry, screenshots, and support exports; every
surface must contain zero sentinel occurrences.

## Verdict

Static local boundary: implemented and testable, pending final independent
review of the frozen candidate.

Operational authorization: NO-GO until a private authenticated WSS peer, Home
Assistant credentials, and real A32 + G2 evidence are available. A phone build
or one transport ACK is not lens visibility or dual-lens applied proof.

Publication/licensing: BLOCKED pending generic-client, server identity,
credential, retry/idempotency, licensing, and hardware evidence.
