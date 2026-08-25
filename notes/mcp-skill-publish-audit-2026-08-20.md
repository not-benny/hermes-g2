# Hermes G2 MCP / skill publish-readiness audit (2026-08-20)

> **Historical publication audit.** App-side WSS enforcement, exact turn and
> connection ownership, cancellation, duplicate rejection, and bounded
> `glasses.render_view` were subsequently implemented. Public publication is
> still NO-GO for server identity, adapter licensing, encrypted credential
> custody, generic interoperability, tool privacy/mutation policy, idempotency,
> and real-G2 evidence. See `docs/audit-remediation-2026-08-21.md`.
> The Roam integration described in this dated evidence was later retired and
> is no longer part of the app or assistant-tool registry.
> The private owner deployment subsequently moved to Host Session MCP, private
> Device MCP, and a portable static workflow MCP. Its current authority map and
> remaining publication blockers are in `docs/hermes-mcp-architecture.md`.

## Verdict

**Audit complete; public MCP/skill publication is NO-GO.**

The phone now serves 26 assistant tools through a minimal MCP surface over
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

The process-wide registry exposes 26 tools:

- System (10): `glasses.get_state`, `glasses.show_alert`,
  `glasses.render_view`, `glasses.read_view_events`, `calendar.list_events`,
  `media.now_playing`, `media.play_pause`, `media.next`,
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

1. **Closed for private evaluation:** the app and private Hermes adapter require
   hostname-verified WSS outside loopback, and a token-authenticated hello/ack
   passed. Public identity/deployment, generic-client, licensing and Android
   negative-certificate evidence remain open.
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

V1 is implemented for private evaluation as one shell-owned overlay using the
strict shell-delivery receipt. This deliberately avoids exposing compositor
surface identities or changing the user's foreground window:

```json
{
  "operation_id": "living-room-42",
  "spec": {
    "version": 1,
    "view_id": "opaque-id-on-update",
    "expected_revision": 3,
    "title": "Living room",
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
- Click produces only a bounded inert event for the exact owner/revision; the
  owner drains it via `glasses.read_view_events`. It never invokes another tool.
  Disconnect closes the owned view and event queue. This static evidence does
  not authorize an interactive public agent surface.

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

## Complete publication audit matrix

This matrix is the release decision record, not a claim that static source
inspection substitutes for operational proof. `Release-ready` means that the
repository contains the required publication artifact and evidence; a passing
unit test alone is insufficient. The 26 process-wide phone tools are listed
individually below. Line references identify the registration or protocol
entry point; the worker references identify the underlying app implementation
where a wrapper forwards a call.

| Item / name | Source entry point | Purpose; availability / permissions | Sensitive data; side effects / destructive risk | Docs status; tests | Publication identity / mechanism | Hardware, credentials, external dependency | Disposition; exact reason / required change |
|---|---|---|---|---|---|---|---|
| MCP transport / bridge server | `app/assistant/mcp-server.ts:1-181`; `bridge-client.ts:167-177` | JSON-RPC `initialize`, `ping`, `tools/list`, `tools/call`; external bridge `mcp` channel; outbound WSS with bearer token in `hello` | All listed tool data and mutations cross the bridge; private WSS proof does not authorize public export | Protocol/lifecycle/error coverage plus private server TLS and hello/ack proof; no generic-client or Android negative-certificate test | No MCP registry, licensed server package, npm publish config, or release automation; only app APK + GitHub Release + CHANGELOG | Private bridge server/credential/network exist; generic MCP client, licensing and public deployment evidence remain absent | **blocked for publication** - preserve private WSS and add generic-client interoperability, licensing, Android certificate-negative and operational credential tests |
| `glasses.get_state` | `system-tools.ts:25-34` | Read display, foreground app/title, headset battery, local time; always available and proactive | Window title/app ID and battery are contextual device data; no mutation | Registration covered indirectly by registry/MCP tests; no per-tool permission/privacy or real-device result test | No independent package; app debug APK workflow only | Live G2/display and battery state required for result verification; no generic-client evidence | **remediable** - document least-privilege export and add per-tool privacy/result tests plus A32/G2 evidence |
| `glasses.show_alert` | `system-tools.ts:36-55` | Display short popup; always available and proactive | User-visible display wake/mutation; can interrupt and is not live-transport gated | No dedicated alert permission, rate, wake, or result-verification test | App APK + GitHub Release + CHANGELOG only | Real glasses display required; proactive policy depends on bridge/session | **blocked** - add explicit live/proactive authorization, bounds and interruption tests, and real-glasses verification |
| `calendar.list_events` | `system-tools.ts:57-81` | Upcoming events with bounded window/count; always available; Android calendar permission is implicit in native reader | Titles, times, locations are sensitive personal data; read-only | No per-tool permission/privacy/result test; generic registry schema coverage only | No public MCP/skill artifact | Android calendar permission and populated calendar; no A32 evidence | **remediable** - document permission/redaction/retention, add denied/empty/result tests and real-device proof |
| `media.now_playing` | `system-tools.ts:83-91` | Current playback metadata; always available and proactive | Track, artist and app metadata are sensitive; read-only | Native media tests exist (`tests/media-access.test.mjs`); no MCP per-tool privacy/result test | No independent package; APK workflow | Android notification/media access and active session; no external-client evidence | **remediable** - add publication-facing permission/privacy and live result evidence |
| `media.play_pause` | `system-tools.ts:93-105` | Toggle current media session; always available | External playback side effect; retries may duplicate toggle | No idempotency/side-effect result test; registry/MCP tests do not prove media action | APK workflow only | Android media session and device playback; no A32 proof | **blocked** - replace toggle with operation-safe semantics or explicit duplicate protection, then per-tool and hardware tests |
| `media.next` | `system-tools.ts:107-119` | Skip current track; always available | External playback mutation; retries can skip repeatedly | No per-tool idempotency/result test | APK workflow only | Android media session; no hardware proof | **blocked** - add operation/retry safety and permission/result/hardware tests |
| `notifications.list` | `system-tools.ts:121-137` | List active mirrored Android notifications; always available | Notification titles/bodies/app names are sensitive personal data; read-only export | `tests/input-and-notification-filters.test.mjs`, `notifications-actions.test.mjs`; no MCP privacy/result proof | APK workflow only | Notification listener permission and live notifications; no A32 publication evidence | **remediable** - document minimization/redaction and add denied/large/body privacy tests plus device proof |
| `notifications.dismiss` | `system-tools.ts:139-156` | Dismiss notification by returned key; always available | Destructive notification mutation; repeated calls and stale keys need defined behavior | `tests/notifications-actions.test.mjs`; no bridge retry/idempotency or hardware result test | APK workflow only | Android notification listener and active notification; no A32 proof | **blocked** - prove stale/retry/idempotent behavior and explicit destructive confirmation/permission semantics |
| `nav.start_navigation` | `navigate-tools.ts:22-55`; worker `navigate-app.worker.ts:225-264` | Launch app, obtain location, geocode and route; always available; location permission prompt | Precise location and destination are sensitive; wakes display, starts tracking, network requests | No per-tool location/privacy/network/result test; no real route/glasses test | APK workflow only | Fine location, Mapbox token, GPS, network and real glasses; no credential/device evidence | **blocked** - add permission/privacy/error/result tests, token handling proof, and A32/G2 route verification |
| `nav.stop_navigation` | `navigate-tools.ts:57-69`; worker `navigate-app.worker.ts:302-314` | Stop active route; always available | Stops tracking and guidance; mutation is retry-safe only if defined | No per-tool lifecycle/idempotency/hardware test | APK workflow only | Navigation worker and GPS state; no real-device proof | **remediable** - document stop semantics and add repeated/stale-call plus device tests |
| `nav.route_status` | `navigate-tools.ts:71-85` | Read next maneuver, distance and ETA; always available and proactive | Location/destination and route metadata sensitive; read-only | No per-tool privacy/result or live route test | APK workflow only | Active GPS route and glasses app; no hardware proof | **remediable** - add privacy/permission and real route result evidence |
| `roam.add_todo` | `roam-tools.ts:20-37`; worker `roam-app.worker.ts:74-94` | Append daily-note TODO and launch Roam; always available | User content exported to third party and remote write; duplicate retries create duplicate TODOs | No Roam tool integration/idempotency test; only registry/MCP behavior | APK workflow only; no skill/package | Roam graph name + API token, network, configured account; no credential or device proof | **blocked** - add masked credential/config tests, write idempotency/duplicate handling, privacy and real-account/device evidence |
| `roam.read_todos` | `roam-tools.ts:40-49`; worker `roam-app.worker.ts:74-82` | Read entire current daily page (not only TODOs); always available | Entire Roam page is sensitive content and third-party export | No per-tool scope/privacy test; existing audit records over-broad read | APK workflow only | Roam graph/API token/network; no proof | **blocked** - narrow response to TODOs or obtain explicit scope approval, then privacy and credential/device tests |
| `timer.set` | `timer-tools.ts:26-44`; worker `timer-app.worker.ts:71-86,199-216` | Create countdown; always available and proactive; wrapper timeout 20s | Audible/vibrating/display alarm mutation; schema lacks bounded integer constraints and retry can duplicate | No per-tool bounds, duplicate, alarm or device test | APK workflow only | Timer worker and real glasses alarm; no hardware proof | **blocked** - bound duration schema, add operation identity/duplicate behavior and real alarm verification |
| `timer.list` | `timer-tools.ts:46-56`; worker `timer-app.worker.ts:87-93` | Read timers; always available and proactive | Timer state is contextual; no mutation | No per-tool result/privacy test | APK workflow only | Timer worker and device clock; no hardware proof | **remediable** - add deterministic expiry/result tests and real-device evidence |
| `timer.cancel` | `timer-tools.ts:58-75`; worker `timer-app.worker.ts:95-107,222-244` | Cancel one or clear all; always available and proactive | Destructive alarm cancellation; `all=true` clears every timer; retries need idempotency | No per-tool destructive confirmation/idempotency/hardware test | APK workflow only | Timer worker and real alarm state; no hardware proof | **blocked** - require explicit bounded semantics/confirmation, prove repeat behavior and hardware result |
| `apps.launch` | `window-tools.ts:39-62` | Launch/focus installed app and wake display; always available | Wakes/focuses display and may expose app/window context; app enum is local | No per-tool installed-app/privacy/result test; no disconnected-success test | APK workflow only | Launcher app definitions and glasses; no real-device proof | **blocked** - remove debug/developer entries from public schema, gate disconnected success, add device tests |
| `apps.list_windows` | `window-tools.ts:64-85` | List window IDs, titles, apps and foreground state; always available and proactive | Window titles/app IDs are sensitive context; read-only | No per-tool privacy/result test | APK workflow only | Live shell windows; no device proof | **remediable** - document metadata minimization and add real shell/device evidence |
| `apps.focus_window` | `window-tools.ts:87-113` | Focus open window and wake display; always available | Display/focus side effect; repeated call generally safe but unverified | No per-tool focus/wake/result test; recent in-process focus tests are local shell coverage | APK workflow only | Live glasses shell; no real-glasses proof | **remediable** - add explicit focus authorization and A32/G2 result test |
| `apps.close_window` | `window-tools.ts:115-141` | Close non-pinned window; always available | Destructive app/window close and possible unsaved-state loss | No per-tool confirmation/idempotency/real-result test | APK workflow only | Live shell/window ownership; no device proof | **blocked** - define confirmation and stale/retry semantics, add lifecycle and hardware tests |
| `apps.list_folders` | `window-tools.ts:143-162` | Read launcher folders and app membership; always available and proactive | App organization metadata; read-only | No per-tool privacy/result test | APK workflow only | Local launcher state; no hardware proof | **remediable** - document scope and add state/result evidence |
| `apps.move_to_folder` | `window-tools.ts:164-195` | Assign app to folder; always available | Persistent launcher organization mutation; retry should be idempotent but is unverified | No per-tool persistence/retry/device test | APK workflow only | Local settings/launcher state; no hardware proof | **remediable** - add persistence and idempotency tests plus device result evidence |
| `apps.remove_from_folder` | `window-tools.ts:197-221` | Ungroup app; always available | Persistent organization mutation; retry behavior unverified | No per-tool persistence/retry/device test | APK workflow only | Local launcher state; no hardware proof | **remediable** - add persistence/idempotency and device evidence |
| `apps.disband_folder` | `window-tools.ts:223-251` | Delete folder and move all apps to top level; always available | Destructive bulk organization mutation; no confirmation or operation ID | No per-tool destructive/idempotency/device test | APK workflow only | Local launcher state; no hardware proof | **blocked** - add explicit confirmation, bounded bulk semantics, retry safety and hardware evidence |
| In-process app-tool surface | `in-process-tool-adapter.ts:1-18`; `tool-registry.ts:124-174`; `worker-window.ts:248-252` | Window-owned `app.<appId>.*` tools, gated `open`/`foreground`; local/private registry only | Data and side effects depend on app; terminal can send commands; ownership/focus is security-relevant | `tests/in-process-surface.test.mjs`, `tests/tool-registry.test.mjs`; no independent publication contract or generic-client test | No separate manifest/package/public mechanism; not a release unit | App workers, shell lifecycle, and connected hosts for terminal; no public server proof | **out of scope** for public release - retain local/private; define a separately versioned API, permissions, and publication artifact before reconsidering |
| Flagship `glasses.render_view` private implementation | `app/assistant/render-view.ts`; `system-tools.ts`; `app/ui/shell/render-view-layer.ts` | Bounded shell-owned singleton overlay; conversation-only, not proactive | Agent text is inert and byte bounded; operation ID, owner, revision, TTL, rate, cancellation and event queue fail closed | Behavioral contract/lifecycle/event tests in `tests/render-view.test.mjs`; no fuzz corpus, golden image or real-glasses proof | Phone tool only; no public endpoint/package/skill | Real G2 display/gestures, licensed compatible bridge and generic-client evidence required | **blocked for publication** - private static implementation exists, but operational/server/licensing/hardware gates remain open |
| `glasses.read_view_events` | `app/assistant/render-view.ts`; `system-tools.ts` | Drains at most 16 inert click events for the exact owned view/revision; conversation-only | Action IDs are bounded; no label/content export and no direct tool invocation | Owner/revision/drain behavior covered in `tests/render-view.test.mjs`; no external client or hardware gesture proof | Phone tool only; no public endpoint/package/skill | Requires the same bridge/client and real-G2 gesture evidence as `render_view` | **blocked for publication** - safe private polling contract exists, but operational/server/licensing/hardware gates remain open |
| Future `hermes-g2-glasses` skill | Audit `:157-171`; no `SKILL.md` | Future usage/documentation skill for bridge, schema, lifecycle and monochrome UX | Could misrepresent unsafe capabilities or disclose operational prerequisites | No artifact, manifest, or skill tests | No skill manifest or registry publication path exists | Requires proven MCP endpoint, render behavior, and safe examples | **blocked** - create only after MCP/render gates and establish versioned skill publication mechanism |
| Phone package / debug APK | `package.json:1-13`; `ROADMAP.md:131-133` | Android companion; package version `1.0.0`, `private:false`; debug preview build | Bundles all local tools and bridge client; package metadata is not an MCP/skill manifest | Full app tests/typecheck/build are repository checks; no reproducible APK identity or release automation | Established workflow is package/package-lock version identity, `npm run build`, GitHub Release + CHANGELOG; no npm publish config | Android SDK/JDK, A32/G2, Even provisioning and bridge credentials; build is debug/non-reproducible | **out of scope** for public MCP/skill release - may be a future app preview after separate release gates; do not change metadata here |
| Sibling `faceclaw-agent-bridge` / adapter | `notes/voice-assistant-design.md:314-448`; README bridge docs | Separate bridge/server compatibility reference; not shipped by this repository | Shared token, remote agent access and tool forwarding risks; private use is not public evidence | Design/TODO notes only; no repository integration, server proof, generic-client or hardware evidence | No sibling package or release artifact in this repository | Separate bridge checkout/configuration and credentials; no WSS/operational proof | **out of scope / blocked** - audit separately and prove secure transport, adapter compatibility and hardware path before any public claim |

### Recommended release scope

**Decision: no public MCP or skill release now.** The proposed release set is
empty: no matrix row is release-ready. The 26 phone tools are code-level
registrations with conservative `remediable` or `blocked` dispositions, not a
safe public product. In particular, `glasses.render_view`,
`hermes-g2-glasses`, the bridge/server, and the sibling adapter remain blocked;
the in-process surface is local/private and the APK is an app release unit,
not an MCP or skill publication.

The minimum future scope is a separately versioned, authenticated MCP endpoint
with server proof, unique live-turn authorization, cancellation or operation
IDs/idempotency for every remaining mutation, per-tool permission/privacy and
destructive-action evidence, generic-client interoperability, and real A32/G2
verification. The bounded private `render_view` implementation does not close
those gates; only after they pass may a truthful skill be considered. Static tests must not be promoted to
hardware, credential, WSS, or operational proof.

## Source traceability and evidence ledger

At this audit's frozen 20 August commit, inspected release and manifest sources
were `package.json` (the only app manifest; version `1.0.0`, `private:false`, no
`publishConfig`), `package-lock.json`, and the then-current root roadmap,
handover, and README. Those mutable files and line numbers are historical
evidence, not current project status. No `CHANGELOG.md` was present in that
checkout. The
established release description is debug
preview APK via `npm run build`, followed by GitHub Release and CHANGELOG; no
MCP registry, skill manifest, npm publish configuration, or release automation
was found or added.

Inspected protocol/auth/registry sources: `app/assistant/mcp-server.ts:1-198`,
`bridge-client.ts:1-426`, `bridge-connection-guard.ts`,
`tool-registry.ts:1-356`, `in-process-tool-adapter.ts:1-18`, and
`app/ui/shell/worker-window.ts:240-270`. Inspected registrations:
`system-tools.ts` (10), `navigate-tools.ts:15-85` (3),
`roam-tools.ts:13-49` (2), `timer-tools.ts:19-76` (3), and
`window-tools.ts:30-251` (8): **26 total**, reconciled with the current list.
Worker-only/local app tools were separately identified in
`app/apps/navigate/navigate-app.worker.ts`, `roam/roam-app.worker.ts`,
`timer/timer-app.worker.ts`, and `terminal/terminal-app.worker.ts`; they are
not additional phone-served rows because only the first three are wrapped by
the process-wide tools, while terminal remains in-process/private.

Inspected tests: `tests/mcp-server.test.mjs` (MCP lifecycle, malformed calls,
duplicate IDs and late replies), `tests/tool-registry.test.mjs` (schema,
availability, ownership and timeout behavior), `tests/bridge-connection-guard.test.mjs`
(connection generation), `tests/in-process-surface.test.mjs` (registration,
foreground gating, notifications and teardown), plus related
`tests/notifications-actions.test.mjs`, `tests/input-and-notification-filters.test.mjs`,
`tests/media-access.test.mjs`, and assistant/bridge tests discovered in the
repository. These are static/unit evidence only. Missing or unresolved
evidence includes a generic MCP client, Hermes/OpenClaw adapter, WSS and
authenticated server proof, bridge credentials in a safe test environment,
per-tool permission/privacy/destructive/idempotency tests, real A32/G2 and
real-glasses result verification, and all `render_view` fuzz/race/gesture/
golden-image coverage.

No secrets, bridge tokens, MAC addresses, health data, generated artifacts, or
new publication manifests were added by this audit. Hardware verification was
not required for this documentation change; the matrix intentionally records
the hardware and credential gaps rather than treating them as closed.

## Audit validation run

- `node --test tests/mcp-server.test.mjs tests/tool-registry.test.mjs tests/bridge-connection-guard.test.mjs tests/in-process-surface.test.mjs tests/notifications-actions.test.mjs tests/input-and-notification-filters.test.mjs tests/media-access.test.mjs` - **19 passed, 0 failed**.
- `npm run typecheck` - **passed**.
- `npm test` - **143 passed, 2 failed** in the pre-existing ring activity tests (`tests/ring-health-store.test.mjs:158` and `:190`); this documentation-only change does not touch ring code or tests, so the failures remain an explicit repository limitation rather than being relabeled as MCP evidence.
- `git diff --check` - **passed**.
