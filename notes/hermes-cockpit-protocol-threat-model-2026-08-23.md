# Structured Hermes cockpit protocol boundary — 23 August 2026

## Scope and trust boundary

This is a provider-neutral application protocol for a native G2 cockpit carried
inside the existing authenticated WSS bridge. It does not replace TLS, bridge
authentication, MCP, or provider APIs. The bridge/Hermes host is authoritative
for session state and authorization; the phone is an authenticated, untrusted
presentation/input peer. Model output, task text, provider events, repository
content, labels, and error strings are inert data, never protocol instructions.

The first version is deliberately narrow: one account/device lease, bounded
session summaries and Kanban cards, streamed public assistant text, and explicit
human questions, permissions, steering, and interrupt. It excludes raw provider
frames, chain-of-thought/reasoning, prompts, credentials, environment values,
tool arguments/results by default, arbitrary markup/URLs/images, and generic
remote UI or tool execution.

## Canonical envelope and model

Every frame is one bounded JSON object. Unknown fields, duplicate JSON keys,
non-integer numbers, invalid UTF-8/control or bidi text, and unknown enum values
fail closed. IDs are opaque random ASCII values (not provider IDs or encoded
arguments); text is plain and length-bounded before retention.

```text
Envelope {
  v: 1,
  chan: "cockpit",
  type: enum,
  connectionGeneration: opaque,   // assigned after authenticated hello-ack
  sessionId?: opaque,
  generation?: uint53,             // server-assigned execution incarnation
  eventSeq?: uint53,               // server event order within session
  commandId?: opaque,              // client-generated idempotency identity
  body: type-specific object
}
```

`connectionGeneration` is a capability for one authenticated socket and is
never accepted on a successor socket. `sessionId` names durable public cockpit
state. `generation` is monotonically increased by the server whenever execution
starts/restarts/supersedes; it is never inferred from a provider turn ID.
Provider IDs remain in a private adapter mapping and unmatched provider output
is dropped, never routed to the current generation.

Canonical server events are:

- `session.snapshot`: session revision, generation/state, board revision,
  ordered bounded cards, public transcript tail, and live interaction requests.
- `session.state`: `queued | running | waiting_human | interrupting | completed |
  failed | interrupted | expired`, with revision and sanitized public summary.
- `board.patch`: CAS-style board revision plus operations over stable card IDs;
  cards contain only `title`, bounded public summary, `todo | doing | blocked |
  done`, and optional coarse progress. No provider payload is executable.
- `assistant.delta`: append/replace text with a stream ID and monotonic chunk
  index; `assistant.final` closes that stream. Missing chunks require resync.
- `interaction.open` / `interaction.closed`: the one-shot request lifecycle.
- `command.receipt`: authoritative acceptance/rejection/deduplication outcome.
- `sync.begin`, `sync.ready`, `session.tombstone`, and bounded sanitized `error`.

A live `interaction.open` has `{requestId, requestNonce, kind, generation,
openedSeq, expiresAt, prompt, choices?, risk?}`. `kind` is `question` or
`permission`. Questions allow exactly one bounded typed answer or one listed
choice. Permissions allow exactly one explicit `allow_once` or `deny`; there is
no default allow, “always allow”, wildcard scope, or permission inheritance.
`risk` is server-authored inert disclosure of the exact action, target, data
leaving the device, and consequence; display labels never define authority.

Client commands are:

```text
answer { commandId, sessionId, generation, requestId, requestNonce,
         answer | choiceId }
permission_decide { commandId, sessionId, generation, requestId, requestNonce,
                    decision: "allow_once" | "deny" }
steer { commandId, sessionId, generation, text }
interrupt { commandId, sessionId, generation }
ack { sessionId, throughEventSeq }
resume { sessionId, lastAppliedEventSeq, lastKnownRevision }
```

Schemas set explicit encoded-byte, collection, nesting, text, frame, session,
and rate limits. Limits apply after decoding as well as on the wire. Compression
must have an independent decompressed-size and expansion-ratio cap.

## Exact lifecycle invariants

1. **Three identities are mandatory.** Privileged handling requires the exact
   authenticated connection generation, cockpit session ID, and execution
   generation. No missing field, “active session”, latest-turn, provider-ID, or
   single-session fallback is permitted.
2. **Authority is server-side.** Only the server allocates generations, event
   sequence numbers, interaction identities/nonces, revisions, expiry, and final
   command outcomes. Client UI state is never proof that a request remains live.
3. **One-shot means one accepted transition.** `(sessionId, generation,
   commandId)` is durably reserved before work. Replays with byte-identical
   semantic payload return the original receipt; reuse with different payload
   is a conflict. “Exactly once” applies to acceptance, not unverifiable external
   effects; unknown outcomes remain `outcome_unknown` and are never retried as a
   fresh command automatically.
4. **Question/permission binding.** An answer/decision is accepted only if the
   exact request ID and nonce are live, pending, unexpired, and owned by the
   exact generation. Acceptance atomically closes it before resuming work. Any
   close, expiry, interrupt, supersession, disconnect policy, or generation
   change makes later input stale. Duplicate identical input returns the original
   receipt; conflicting or second input is rejected.
5. **Permission is not a portable capability.** `allow_once` authorizes only the
   server-canonicalized action disclosed by that exact request, in that exact
   generation, once. The action is revalidated immediately before dispatch.
   Changed arguments, target, policy, provider revision, session/generation, or
   expiry require a new request. Timeout, ambiguity, disconnect, and malformed
   input deny; UI choice order or highlighted/default controls grant nothing.
6. **Steer is generation-bound injection, not a new user turn by fallback.** A
   steer command is accepted at most once only while the exact generation is in
   an explicitly steerable state. Reservation and insertion into that
   generation's ordered input queue are atomic. It cannot answer a question,
   grant permission, revive terminal work, or be silently applied to a successor.
   If the adapter cannot prove insertion, the receipt is failure/unknown, not
   success.
7. **Interrupt is monotonic and wins races.** An accepted interrupt atomically
   changes the exact generation to `interrupting`, closes its interactions, and
   prevents all new dispatches before cancellation is requested. Revalidation
   immediately before every delayed send/side effect rejects the interrupted
   generation. Completion racing afterward may be recorded as late diagnostic
   data but cannot revert the terminal `interrupted` state, publish UI into a
   successor, or satisfy a new request. Repeated identical interrupt returns the
   first receipt; interrupting another generation requires a new command ID.
8. **Terminal is permanent.** A generation has exactly one terminal state.
   Restart/resume-after-terminal allocates a strictly newer generation; old IDs,
   streams, interactions, callbacks, timers, and provider mappings remain
   tombstoned and cannot be reactivated.
9. **Events are totally ordered per session.** `eventSeq` is contiguous and
   strictly increasing in the committed log. The phone applies an event only
   when it matches the expected next sequence and its generation/revision
   preconditions. Duplicate events are ignored after equality validation; gaps,
   conflicts, or regressions force resync. Presentation order never determines
   authorization order.
10. **Receipts precede optimistic UI.** The phone may show “sending” locally but
    cannot show answered/allowed/steered/interrupted until the corresponding
    canonical event/receipt is applied. A socket write or WSS ACK is not command
    acceptance, provider dispatch, completion, or lens visibility.
11. **Bounded expiry is authoritative.** The server uses its own monotonic timer
    and stores a wall-clock `expiresAt` only for display/restart recovery. On
    restart it chooses the earlier safe deadline and never extends a request.
    Expiry atomically tombstones before any late command is considered. Client
    clock changes cannot extend authority.
12. **Disconnect is revocation, not pause, for transport authority.** It
    invalidates the connection generation immediately. Server execution may
    continue by policy, but no old socket callback/input remains valid. Pending
    permissions default-deny on their bounded deadline; no queued offline
    permission/answer/steer/interrupt is sent without a fresh synchronized view.

## Reconnect and ordering contract

1. Complete WSS and existing `hello`/`hello-ack`; allocate a fresh connection
   generation. Reject all cockpit traffic before authentication and capability/
   version negotiation.
2. Enter `syncing`; disable all mutating controls. Send `resume` only for explicit
   session IDs with the last contiguously applied sequence. Never claim locally
   rendered-but-uncommitted state.
3. Server emits `sync.begin` with a high-water mark. If retained history covers
   the cursor, replay exactly `cursor+1..highWater`; otherwise emit one complete
   `session.snapshot` whose sequence/revision establishes the new base. Snapshot
   replacement is atomic, never merged with stale local interactions.
4. Buffer events above the high-water mark, apply replay/snapshot, then apply the
   buffered contiguous suffix. Server emits `sync.ready` with the resulting
   sequence and current generation. Only then enable controls.
5. Before submitting any command, the phone rechecks that its displayed request
   and generation came from the synchronized canonical state. The server still
   rechecks all invariants. Commands sent before `sync.ready`, for absent
   sessions, or across a sequence gap fail closed.
6. `ack(throughEventSeq)` advances retention only contiguously. It never grants
   authority. Keep bounded command/request tombstones longer than the maximum
   reconnect/retry window; if dedupe history is unavailable, reject ambiguous
   replay rather than execute it.

This ordering handles the adversarial case where a question expires, permission
is consumed elsewhere, interrupt wins, or a generation completes while the
phone is offline: the canonical close/terminal event is applied before controls
can become active.

## Privacy and minimization invariants

- Export an explicit public projection only: coarse status/Kanban summaries,
  bounded user-visible assistant text, and narrowly scoped interaction prompts.
  Never serialize hidden reasoning, system/developer prompts, raw tool/provider
  payloads, credentials, headers, environment, filesystem paths, health data,
  notification/calendar bodies, or precise location unless a separately
  specified feature and consent gate permits that exact field.
- Each field has a classification and retention owner. Sensitive optional fields
  are omitted, not filled with placeholders. Errors are stable codes plus
  bounded sanitized text; handles and operation IDs contain no secrets.
- WSS encryption does not authorize logging or persistence. Tokens, nonces,
  answers, permission details, transcript text, and card content are redacted
  from routine logs/telemetry/support exports. Persist only the minimum encrypted
  resume state; deletion/disable removes local projections and resume tokens.
- Phone preview, notifications, screenshots, recents thumbnails, accessibility,
  backups, crash reports, and glasses shoulder-surfing are separate disclosure
  surfaces. Default to no notification-body copy, secure recents/screenshots
  where supported, short HUD text/TTL, and explicit reveal for sensitive text.
- Backpressure drops/coalesces non-authoritative deltas only; it never drops
  interactions, closures, receipts, terminal events, revisions, or tombstones.
  A snapshot must preserve the same privacy projection and cannot broaden data.

## Adversarial threat register

| Attack/fault | Required fail-closed result |
|---|---|
| Replay old allow/answer after reconnect | Old connection/generation/request/nonce or tombstone rejects it; no action. |
| Delayed steer lands in a new run | Exact generation mismatch rejects; no current-turn fallback. |
| Interrupt races provider/tool completion | Interrupting gate blocks dispatch/publication; late completion cannot overwrite terminal state. |
| Duplicate command after lost receipt | Same payload returns original receipt; conflicting payload fails; pruned dedupe history fails ambiguous. |
| Malicious label/choice swaps buttons | Choice ID and server-canonical request define meaning; no default allow; labels inert. |
| Session/provider ID collision or reuse | Independent opaque internal identities and durable generation tombstones prevent rebinding. |
| Out-of-order replay/snapshot/live events | Contiguous sequence/high-water barrier; gap or conflict disables controls and resyncs. |
| Expiry/client clock rollback/restart | Server monotonic deadline and earlier-safe restart reconstruction; never extend. |
| Compromised model emits protocol-shaped text | Text remains in bounded text fields; cannot create frames, choices, or authority. |
| Oversize/decompression/patch bomb | Pre/post-decode limits, bounded flat schemas, rate limits, close abusive socket. |
| Slow consumer/flood | Bounded queues and snapshot resync; never silently discard security state. |
| Token/socket theft | Existing WSS/server identity plus auth still required; connection lease replacement revokes old generation; command invariants limit replay. |
| Privacy leakage via logs/snapshot/errors | Allowlisted public projection and sentinel scanning across logs, persistence, telemetry, screenshots, and support exports. |
| Crash after command reservation | Recover receipt/tombstone and reconcile; do not issue fresh side effect when outcome is unknown. |

## Verification and release gates

Permanent negative tests must exercise every row above, including
non-cooperative cancellation; disconnect at each lifecycle transition; stale,
missing, reused, and conflicting IDs; interrupt/completion and expiry/answer
interleavings; snapshot/replay gaps; process restart with reserved commands;
queue exhaustion; malformed/unknown fields; and secret sentinels across all
export surfaces. Fuzz decoding and state transitions, not only schemas.

Static protocol design: **PASS as a fail-closed target contract; not implemented.**

Operational authorization: **NO-GO** until the contract has an independently
reviewed implementation, durable dedupe/recovery evidence, authenticated WSS
negative tests, real reconnect/race exercises, privacy sentinel scans, and
A32 + real-G2 evidence. No permission, provider mutation, pairing, firmware, or
other unsafe bypass is authorized by this document.
