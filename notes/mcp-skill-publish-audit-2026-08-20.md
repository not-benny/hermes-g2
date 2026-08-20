# Hermes G2 MCP / skill publish-readiness audit (2026-08-20)

## Verdict

**Audit complete; public MCP/skill publication is NO-GO.**

The phone already serves 24 assistant tools through a minimal MCP surface over
the external assistant WebSocket bridge, and the shell/compositor can host a
generic remote view. The current bridge is not yet an authenticated, replay-safe,
schema-enforced general MCP endpoint, however. Do not advertise it as one or
publish a glasses-control skill until the blockers below are closed.

This verdict does not disable the existing private bridge deployment. It records
that the deployment assumes a trusted transport/network and is not suitable as a
public security boundary.

### Hardening progress after the audit

The first hardening pass now rejects privileged pre-auth traffic, generation-
binds native WebSocket callbacks, enforces tool input schemas centrally, makes
same-app multi-window ownership removal-safe, fails closed on availability
exceptions, implements MCP initialization/error handling, ignores side-effecting
`tools/call` notifications, and charges proactive quota only after preflight.
Behavioral coverage raises the suite to 141 tests.

Publication remains NO-GO because `ws://` does not authenticate the server or
protect the bearer token, MCP calls are not yet bound to a unique live turn
generation, and timed-out side-effecting handlers are not cancelled/idempotent.

The review follow-up also binds each MCP server/reply to one socket generation,
closes old sessions on reconnect, suppresses late replies, rejects duplicate
request IDs with bounded replay tombstones, restores older same-app tool owners,
fails closed on unsupported schema keywords, closes protocol-mismatch sockets,
and adds a 15-second authentication-handshake timeout.
Array bounds and schema-valued additional properties are enforced, and every
inbound bridge frame must carry the documented top-level protocol version.

## Current surface

The process-wide registry exposes 24 tools:

- System (8): `glasses.get_state`, `glasses.show_alert`,
  `calendar.list_events`, `media.now_playing`, `media.play_pause`, `media.next`,
  `notifications.list`, `notifications.dismiss`.
- Navigate (3): `nav.start_navigation`, `nav.stop_navigation`,
  `nav.route_status`.
- Roam (2): `roam.add_todo`, `roam.read_todos`.
- Timer (3): `timer.set`, `timer.list`, `timer.cancel`.
- Apps/windows (8): `apps.launch`, `apps.list_windows`,
  `apps.focus_window`, `apps.close_window`, `apps.list_folders`,
  `apps.move_to_folder`, `apps.remove_from_folder`, `apps.disband_folder`.

All tools currently return text. The MCP server implements `initialize`, `ping`,
`tools/list`, `tools/call`, and `notifications/tools/list_changed`.

## Publication blockers

### Bridge and turn authorization (HIGH)

1. The bridge always uses plaintext `ws://`; the bearer token is sent in the
   `hello` JSON frame. Any `hello-ack` is accepted without proof that the peer
   knows the token. Public use requires `wss://` with normal certificate
   validation or an explicitly enforced authenticated tunnel plus a server proof.
2. **Closed:** `chat` and `mcp` frames are rejected before `hello-ack` completes.
3. **Closed:** WebSocket callbacks are bound to a connection generation and
   stale callbacks from replaced sockets are ignored.
4. An MCP call is treated as conversational whenever *some* voice turn is active.
   Calls carry no internal turn generation, so delayed/replayed calls can bypass
   proactive restrictions. Calls must be bound to a unique live turn and
   revalidated immediately before side effects.

### MCP / registry correctness (HIGH)

5. **Closed:** advertised JSON Schemas are centrally enforced before handlers run.
6. **Closed:** window registrations carry ownership; closing an older same-app
   window cannot delete a newer registration.
7. **Closed for the current server:** MCP uses explicit initialization state,
   negotiates its supported version, emits protocol errors, and ignores
   side-effecting `tools/call` notifications.
8. Registry timeouts do not cancel handlers, so late side effects can occur after
   a timeout and be duplicated by retries. Side-effecting calls need cancellation
   and/or operation IDs plus idempotency.
9. **Closed:** availability predicate failures fail closed inside error handling.
10. **Closed:** proactive quota is charged only after tool/schema/eligibility preflight.

### Tool-specific holds

- `glasses.show_alert`: proactive and wakes the display; no live-transport gate.
- `roam.read_todos`: returns the entire daily page, not only TODOs.
- `timer.set`: proactive audible/vibrating alarm creation without bounded integer
  schema constraints.
- `timer.cancel`: proactive destructive cancellation, including clear-all.
- `apps.launch`: includes debug/developer entries and can report local-only success
  while disconnected.

Conditional tools need clearer permission/privacy/side-effect documentation:
calendar, notification listing/dismissal, navigation, Roam writes, timer listing,
window closing, and folder disbanding. Calendar titles/locations, notification
bodies, media metadata, window titles, and Roam content are sensitive exports.

## Safe `glasses.render_view` design

Do not expose direct compositor surfaces, z-order, coordinates, raw pixels,
overlays, URLs, images, scripts, HTML, Markdown, arbitrary fonts, or colours.

V1 should be a shell-owned, in-process singleton window managed by
`DashboardController` and `createInProcessWindow`:

```json
{
  "spec": {
    "version": 1,
    "view_id": "opaque-id-on-update",
    "expected_revision": 3,
    "title": "Living room",
    "height": "standard",
    "blocks": [
      {"type": "text", "text": "Two lights are on", "emphasis": "normal"},
      {"type": "key_value", "label": "Temperature", "value": "21.5 C"},
      {"type": "progress", "label": "Heating", "value": 0.65},
      {"type": "divider"}
    ],
    "actions": [{"id": "lights_off", "label": "Turn lights off"}],
    "ttl_seconds": 600
  }
}
```

Rules:

- Omitted `view_id` creates; an update is full replacement and requires
  `expected_revision`.
- Random opaque ID, monotonic revision, connection-epoch owner, tombstone on
  local close, no resurrection, and no persistence in v1.
- One live remote view; 16 KiB encoded spec; 32 blocks; 8 actions; 8 KiB total
  text; 1 KiB per text block; title 80 chars; action label 40 chars; action ID 64
  ASCII chars; TTL 30-3600 seconds; max two accepted updates/second.
- V1 is conversation-only and must not wake or focus the display proactively.
- Scroll changes local selection; click may emit a versioned event; double-click,
  long-press, and extended-hold remain owned by the shell.
- Until gesture event delivery is generation-bound and tested across reconnect,
  publish only a static/local-navigation view, not an interactive agent surface.

## Required verification before publication

- Behavioral tests for bridge authentication, pre-auth rejection, stale socket
  callbacks, turn generations, replay/duplicate IDs, MCP lifecycle/errors,
  schema validation, registry ownership, proactive limits, and timeout/late work.
- Per-tool permission, connectivity, privacy, destructive-action, idempotency,
  and real result-verification tests.
- `render_view` schema fuzzing, hostile/oversized input, create/update/stale
  revision, local-close/update races, TTL/render races, disconnect/reconnect,
  timeout/late completion, surface failure, gesture escape contracts, golden
  images, burst coalescing, and real phone/glasses tests.
- Real generic MCP client plus Hermes/OpenClaw adapter tests.

## Skill publication

No repository `SKILL.md` exists yet. Do not publish a skill that implies the
unsafe surface is ready. Once the blockers and `render_view` v1 are complete,
ship a `hermes-g2-glasses` skill containing bridge prerequisites, discovery,
schema/limits, monochrome writing guidance, lifecycle recipes, gesture/escape
semantics, revision handling, privacy/proactive constraints, and compact Home
Assistant/dashboard examples.

Useful source material for that future skill:

- `notes/voice-assistant-design.md`
- `README.md`
- `SurfaceCompositor.java` contract comments
- `app/ui/shell/geometry.ts`, `gestures.ts`, and `window-menu.ts`
