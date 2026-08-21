# MCP glasses display (private evaluation)

Status: private evaluation only. Public MCP/skill publication and operational
authorization remain NO-GO until the gates in
`notes/mcp-glasses-display-threat-model-2026-08-21.md` pass.

## Safe defaults

- Proactive bridge calls are disabled by default. Enable **Allow proactive Hermes
  actions** only for a deliberate, trusted evaluation and disable it afterward.
- `glasses.show_alert` accepts at most 160 characters of inert plain text. It
  rejects control characters, markup delimiters, and URLs. It never wakes an
  unavailable/off display, and reports success only after the shell transport
  completion boundary. Cancellation, stale-turn invalidation, and replacement
  invalidate the alert owner and prevent a later queued frame from being
  reported as that call's success. Transport completion is not evidence that
  pixels reached real G2 lenses.
- The bridge token is configuration, not a publication credential. Never put it
  in source, screenshots, bug reports, or logs. Use a replacement-only update
  and treat Android backup/ADB access as local secret exposure.
- Model output, tool results, notifications, calendar, media, and window data
  are untrusted or private. Do not paste them into release artifacts.

## Configuration and permissions

The phone-side assistant is configured in Settings under Assistant. The external
mode requires a bridge host, port, and shared token. The client now requires a
certificate-validated `wss://` endpoint, but the available sibling bridge/server
has not been shown to provide that endpoint or server identity proof; external
operation therefore remains disabled/NO-GO.
Only grant Android runtime permissions for features you use. Keep Even installed
for provisioning and official maintenance; Hermes does not replace Even's
ownership or firmware responsibilities.

## Tool boundary

The phone exposes versioned MCP lifecycle methods and a registry of currently
available tools. Every external `tools/call` now requires an envelope claim for
the exact originating turn (or an explicit proactive marker), and the phone
revalidates both that turn and the owning connection before delayed effects.
Disconnect closes owned calls and views. Older bridges that omit `turnId` now
fail closed; this is intentionally incompatible until a separately licensed
bridge implements and proves the envelope.

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

No `hermes-g2-glasses` `SKILL.md` is published. A skill would falsely imply a
usable public endpoint while server identity/deployment, adapter compatibility,
licensing, generic-client, and real-G2 evidence remain missing.

## Troubleshooting and disable/rollback

If a call reports that the display is unavailable, reconnect the provisioned G2
through the normal app flow; do not pair, reset, flash, or change ownership to
recover it. If the bridge behaves unexpectedly, turn off **Allow proactive Hermes
actions**, switch the assistant backend away from external mode, or clear the
bridge host/token settings. Uninstalling is not required to disable the bridge.

Testing so far is host/static plus Android build and A32 install/launch evidence.
The installed app started safely, but its logs reported no active glasses
connection, so no `render_view`, real-G2 lens, or gesture claim was produced.
A32-only or simulated results do not prove generic MCP interoperability, secure
server operation, or public release readiness.