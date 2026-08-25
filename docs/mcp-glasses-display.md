# MCP glasses display (private evaluation)

Status: private Device MCP only. This phone server is an internal authority
boundary behind the fixed workflows in `hermes-mcp-architecture.md`; it is not
mounted directly into the model registry and is not a public MCP product.

## Safe defaults

- Proactive bridge calls are disabled by default. Enable **Allow proactive Hermes
  actions** only for a deliberate, trusted evaluation and disable it afterward.
- The internal `glasses.show_alert` route accepts at most 160 characters of
  inert plain text. It is not present in the portable workflow MCP. It
  rejects control characters, markup delimiters, and URLs. It never wakes an
  unavailable/off display, and reports success only after the shell transport
  completion boundary. Cancellation, stale-turn invalidation, and replacement
  invalidate the alert owner and prevent a later queued frame from being
  reported as that call's success. Transport completion is not evidence that
  pixels reached real G2 lenses.
- `glasses.notify_result` is the separate wake-capable path for one fresh,
  completed agent result. It is available only to the authenticated `even-g2`
  profile, requires an exact bounded `operation_id` plus at most 160 characters
  of inert final text, and is proactive only when both the phone opt-in and the
  gateway's exact tool allowlists permit it. Acceptance synchronously commits a
  bounded Keystore-encrypted FIFO record and returns `queued`; off-head or
  unknown wear never wakes, beeps, or submits a candidate frame. Only a fresh
  confirmed-worn state from the current communicator/session may start the wake
  barrier. The card labels the Fold's first receipt time and reserves its queue
  position, then a strict shell-frame acknowledgement atomically replaces the
  encrypted pending text with a content-free replay tombstone before wake
  ownership commits. The card remains readable until Dismiss/Back or the global
  screen timeout and has no private auto-dismiss timer. Identical pending retries
  remain `queued`; delivered retries return a historical acknowledgement without
  another wake; conflicting reuse fails closed. Thinking, drafts, progress, tool
  activity, and ordinary active-turn replies must never use this route.

  The private `even-g2` deployment routes one-shot remind-me requests through a
  deterministic durable gateway outbox with one stable, content-free operation
  identity. At the due edge the scheduler calls only the pinned
  `glasses.notify_result` Device MCP contract. It does not start an agent, use a
  prompt, or fall back to ordinary G2 delivery, Home Assistant, generic phone
  calls, Work Tasks, Kanban, or todo. Offline, ambiguous, and restart recovery
  reuse the same operation and payload; an exact current or historical phone
  receipt completes the outbox record. A queued receipt proves phone retention,
  not that the wearer has read it.
- The bridge token is configuration, not a publication credential. Never put it
  in source, screenshots, bug reports, or logs. Use a replacement-only update
  and treat Android backup/ADB access as local secret exposure.
- Model output, tool results, notifications, calendar, media, and window data
  are untrusted or private. Do not paste them into release artifacts.

## Configuration and permissions

The phone-side assistant is configured in Settings under Assistant. The external
mode requires a bridge host, port, and shared token. The private deployment now
uses a certificate-validated `wss://` endpoint with hostname verification and a
deployment-specific CA; a real authenticated hello/ack passed. That private
proof does not authorize public operation or publication: native adapter
licensing, privacy, credential, artifact, and real-G2 evidence remain open.
Only grant Android runtime permissions for features you use. Keep Even installed
for provisioning and official maintenance; Hermes does not replace Even's
ownership or firmware responsibilities.

## Tool boundary

The phone exposes versioned MCP lifecycle methods and a private registry of
currently available tools. The native transport is the only client. It pins the
exact phone identity and schema for each reviewed route, while the portable
workflow MCP exposes only static intent-level tools. Raw phone discovery,
arbitrary call forwarding, and dynamic model registration are forbidden.

Every external `tools/call` requires an envelope claim for the exact originating
turn or the single explicitly allowed proactive notification route. The phone
revalidates both the turn and owning connection before delayed effects.
Disconnect closes owned calls and views. Missing, stale, wrong-profile, or
replayed claims fail closed.

`glasses.render_view` is implemented for private evaluation as one shell-owned,
replace-only overlay. It is conversation-only and never wakes or changes focus.
Create requires `operation_id` plus `spec`; update additionally requires the
returned opaque `view_id` and exact `expected_revision`. The allowed V1 blocks
are `text`, `key_value`, `progress`, and `divider`. Limits are 16 KiB UTF-8 per
encoded spec, 32 blocks, 8 actions, 8 KiB aggregate UTF-8 text, 1 KiB per text
block, 80 Unicode code points for title, 40 for action labels, 64 ASCII
characters for IDs, TTL 30-3600 seconds, and at most two accepted renders per
rolling second. Unknown fields, controls, bidi overrides, markup, URL-like text,
raw pixels, coordinates, images, scripts, colours, fonts, wake, and focus are
rejected before shell mutation.

Successful delivery means the exact current shell frame reached the compositor
completion boundary; it does not prove lens visibility. Scroll changes only the
local selected action. Click adds one bounded, revision-bound inert event, which
the exact owner can drain with `glasses.read_view_events`; it never invokes a
tool itself. Double-click closes the view. Long-press closes untrusted content
and preserves the shell escape path. TTL, disconnect, and local close tombstone
the exact revision, and stale callbacks cannot remove a replacement.

No native G2 workflow `SKILL.md` is active. Workflow intent and schema live in
the portable MCP, while transport/session authority remains enforced in code.
Reintroducing native prompt recipes would create a second policy surface and is
forbidden by the cutover contract.

## Troubleshooting and disable/rollback

If a call reports that the display is unavailable, reconnect the provisioned G2
through the normal app flow; do not pair, reset, flash, or change ownership to
recover it. If the bridge behaves unexpectedly, turn off **Allow proactive Hermes
actions**, switch the assistant backend away from external mode, or clear the
bridge host/token settings. Uninstalling is not required to disable the bridge.

The current owner candidate passed 873 phone tests, TypeScript, Android build,
Fold install/launch, Host MCP status, and the separate gateway/workflow/Hermes
capability suites. The final check had no active glasses BLE session, so no
fresh physical lens or gesture claim was produced. Phone-only, simulated, and
gateway-only results do not prove public release readiness.
