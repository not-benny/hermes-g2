# Hermes Cockpit over Host MCP

Hermes Cockpit is a status surface for the authenticated Hermes connection. It
uses the Hermes `H` icon and reports whether Host Session MCP is online. It is
not a task board, terminal, transcript viewer, or alternate command channel.

## Release contract

The phone and host negotiate `host-mcp-v1` over the authenticated WSS
transport. The phone reads the exact MCP resource
`hermes://session/status`. The resource is bounded and contains only:

- the opaque current connection generation;
- authenticated transport state;
- Host MCP voice-turn state (`idle`, `running`, or `cancelling`);
- a status-only Cockpit projection with zero shared sessions and no commands;
- an explicit unavailable Companion state.

The phone rejects malformed, oversized, wrong-profile, extra-field, or stale
generation documents. It preserves the bridge-owned opaque generation exactly
when updating the local Cockpit store. No session history, transcript, prompt,
tool activity, provider data, credentials, or command authority crosses this
resource.

The custom `chat`, `cockpit`, and `companion` WSS channels are retired. The
phone advertises only `mcp` and `host-mcp-v1`; it ignores legacy custom frames,
sends no legacy commands, and fails the connection if Host MCP is absent.
Voice turns and exact cancellation use the Host MCP tool
`hermes.voice.turn`. Final tool results are the only assistant text eligible
for wearer presentation.

## UI behavior

The launcher-visible Cockpit can show connected/offline status and the current
voice-turn state. Because the Host MCP projection is deliberately status-only,
session lists and action controls remain empty/inert. Day-job tasks live in the
phone-owned Work Tasks app, and normal assistant follow-up remains on the
assistant result card.

Future Cockpit functionality must be added as a typed Host MCP resource or
tool with exact schemas, connection-generation binding, cancellation, and
bounded receipts. It must not reintroduce a custom WSS command channel or read
Hermes databases, terminal output, provider UI, or raw event streams.

## Verification

Regression tests cover MCP initialization, the exact status resource, opaque
generation compatibility with the Python bridge, legacy-channel rejection,
standard MCP cancellation, stale completion suppression, disconnect cleanup,
and the status-only UI projection. Hardware acceptance should confirm that an
authenticated Host MCP connection renders `HERMES GATEWAY ONLINE` and an empty
Cockpit status view without exposing any intermediate assistant work.
