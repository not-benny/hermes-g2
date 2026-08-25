# Hermes Cockpit over Host MCP

Hermes Cockpit is the bounded control surface for authenticated G2 voice
sessions. It uses the Hermes `H` icon and the existing native glasses UI. It is
not a terminal, raw transcript viewer, database browser, or alternate transport
channel.

## Release contract

The phone and host negotiate `host-mcp-v1` over the authenticated WSS
transport. The phone reads two exact MCP resources:

- `hermes://session/status` for transport and voice-turn health;
- `hermes://cockpit/state` for the bounded current/recent G2 session
  projection.

The status resource contains only:

- the opaque current connection generation;
- authenticated transport state;
- Host MCP voice-turn state (`idle`, `running`, or `cancelling`);
- the number of shared G2 sessions and whether Cockpit commands are available;
- an explicit unavailable Companion state.

The Cockpit resource contains at most eight current/recent authenticated G2
voice sessions. Each entry has a bounded user row, terminal assistant rows,
session state, generation, and any current reviewed interaction. It does not
carry prompts, reasoning, partial assistant text, tool activity, provider
payloads, credentials, arbitrary history, or unrelated TUI/Kanban sessions.

The phone rejects malformed, oversized, wrong-profile, extra-field, replayed,
or stale-generation documents. It preserves the bridge-owned opaque connection
generation exactly when updating the local Cockpit store.

The custom `chat`, `cockpit`, and `companion` WSS channels are retired. The
phone advertises only `mcp` and `host-mcp-v1`; it ignores legacy custom frames,
sends no legacy commands, and fails the connection if Host MCP is absent.
Voice turns and exact cancellation use `hermes.voice.turn`. Reviewed Cockpit
actions use `hermes.cockpit.command`. The command tool accepts only a command
created from the current phone-owned projection:

- answer one listed-choice clarification;
- deny or allow once for one exact native approval request;
- steer the exact currently running G2 agent;
- interrupt the exact currently running G2 agent.

Authority is rechecked at dispatch against connection, session, generation,
request nonce, expiry, clarify ID or native approval request ID, and the exact
live agent. Receipts are bounded and authoritative. Reconnect snapshots,
resource updates, commands, partial text, and tool progress never wake the
glasses as an assistant result. Only the terminal voice CallToolResult is
eligible for final-result presentation.

## UI behavior

The launcher-visible Cockpit shows connection state, current/recent G2
sessions, bounded terminal timeline rows, pending listed questions or
permissions, and reviewed steer/interrupt actions. Normal assistant follow-up
remains available on the final result card. Day-job tasks remain in the
phone-owned Work Tasks app.

Running and `Working` state stays phone-only. It never acquires a glasses layer,
wakes the display, or blocks ordinary ring and shell interaction while Hermes
is thinking or using a tool.

Open-ended clarification is not yet a Cockpit action because v1 has no reviewed
free-text command. Unrelated Hermes TUI and Kanban sessions are not projected.
Adding either requires a typed Host MCP contract and matching authority checks;
it must not reintroduce a custom WSS command channel or read raw databases,
terminal output, provider UI, or event streams.

## Verification

Regression tests cover MCP initialization, both exact resources, subscriptions,
opaque generation compatibility, legacy-channel rejection, standard MCP
cancellation, stale completion suppression, disconnect cleanup, projection
bounds, command replay/expiry/generation checks, listed clarification,
exact-request approval, steering, interruption, and receipts. Hardware
acceptance must confirm a non-empty G2 session appears in Cockpit, actions stay
bound to that session, and no intermediate assistant work wakes the lenses.
