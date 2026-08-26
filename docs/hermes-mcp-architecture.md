# Hermes MCP architecture

Current as of 25 August 2026.

This document is the maintained interaction and authority map between the
Hermes G2 phone app, the glasses runtime, and Hermes Agent. It describes the
private owner deployment that is running today and the stricter boundary
required before any public distribution claim.

## Current outcome

The fixed G2 interaction boundary is MCP-only and operational. The checked-in
distributable profile remains least privilege, while a separately administered
private owner profile may opt into general Hermes host capabilities:

- `SOUL.md` contains only identity and response style. It contains no tool
  names, workflow recipes, routing rules, retry policy, or device commands.
- The native G2 plugin registers only the authenticated transport platform.
  It registers no model-facing tools or skills.
- Voice turns use Host Session MCP. Phone capabilities use the private Device
  MCP. A separate portable workflow MCP exposes the reviewed intent-level
  model surface.
- The legacy custom `chat`, `cockpit`, and `companion` WSS channels are inert.
- The distributable profile excludes raw phone discovery, arbitrary phone tool
  calls, delegation, and general host toolsets. A private owner capability
  overlay may grant the exact host toolsets described below without widening
  the phone allowlist.
- A completed reminder is delivered by a deterministic outbox directly to the
  fixed phone notification route. No agent prompt runs when the reminder fires.

The private cutover passed independent security review. The app, native bridge,
workflow package, and source-pinned installer are now public under their stated
licenses. Protected APK publication and the broader activation gates listed
below remain closed.

## Transport and MCP roles

```text
phone / glasses
    |
    | authenticated certificate-validated WSS
    v
native G2 transport plugin
    |-- ctl       authentication, capability negotiation, keepalive, version
    |-- host-mcp  phone is MCP client, Hermes is MCP server
    `-- mcp       Hermes is MCP client, phone is private Device MCP server

Hermes model
    |
    v
portable hermes-g2-workflows MCP
    |
    | signed, expiring, exact-turn workflow capability
    v
private fixed workflow relay
    |
    v
private Device MCP tool with pinned name, schema, identity, and receipt
```

The WSS connection is a transport and authentication boundary, not a workflow
description channel. Model-facing intent and schema live in the portable MCP.
Connection ownership, turn authority, replay protection, cancellation, and
phone receipt verification remain enforced in code.

### `ctl`

`ctl` carries only hello/ack negotiation, authentication, keepalive, transport
generation, and protocol version state. A client that does not negotiate
`host-mcp-v1` fails closed.

### Host Session MCP

The phone is the MCP client. Hermes exposes:

- `hermes.voice.turn`, a long-running final-result-only voice turn;
- standard request-ID cancellation;
- `hermes://session/status`, a bounded transport and turn-health resource;
- `hermes://cockpit/state`, a subscribed bounded current/recent G2 session
  projection;
- `hermes.cockpit.command`, an exact reviewed answer, permission, steer, or
  interrupt action with an authoritative receipt.

No partial answer, chain of thought, tool activity, prompt, provider payload,
credential, raw transcript, or unrelated Hermes session crosses these
resources. Cockpit snapshots and commands never become an assistant lens
result. The assistant result shown on the glasses is the single terminal voice
MCP tool result.

### Private Device MCP

The phone is the MCP server. It owns device state, Android permissions, wearer
state, the glasses compositor, durable phone stores, and mutation receipts.
Its raw tool list is never mounted into the model registry. A phone update or
`tools/listChanged` event cannot widen the public model surface.

### Portable workflow MCP

`hermes-g2-workflows` is the only model-facing G2 workflow package. It has a
static tool inventory, exact input and output schemas, bounded results, and no
generic proxy. Mutations derive stable content-free operation IDs from trusted
turn metadata and retry only with the same identity and payload after an
explicitly ambiguous outcome.

The package receives only its reviewed profile-scoped relay endpoint through
`HERMES_G2_WORKFLOW_RELAY`. It does not receive broad profile state through
`HERMES_HOME`, infer a global socket, or scan for another profile's relay.

## Model-facing workflow inventory

| MCP tool | Intent and fixed private route |
| --- | --- |
| `g2_work_task_add` | Add one task to the phone-owned encrypted Work Tasks board |
| `g2_kanban_task_create` | Create one blocked, unassigned card on one exact existing Hermes Kanban board |
| `g2_clock_set_timer` | Set a durable Clock countdown |
| `g2_clock_set_alarm` | Set a durable local or repeating Clock alarm |
| `g2_reminder_create` | Create one deterministic one-shot reminder outbox record |
| `g2_reminders_manage` | List, cancel, or snooze one-shot reminder records |
| `g2_weather_present` | Read typed Open-Meteo UKMO data and atomically present a fixed attributed deck |
| `g2_train_departures_present` | Read typed National Rail departures and atomically present a fixed deck |
| `g2_apps_manage` | Launch apps and inspect or manage windows and launcher folders |
| `g2_media_control` | Read media state, play or pause, or advance one track |
| `g2_navigation` | Start, stop, or read bounded navigation state |
| `g2_notifications` | List bounded phone notifications or dismiss one exact returned key |
| `g2_health_summary` | Read a coarse, consent-gated local ring-health summary |
| `g2_calendar_agenda` | Read a bounded upcoming phone calendar agenda |

Weather and trains are intent-complete readers. They use isolated headless
Playwright with the reviewed Brave binary and fixed provider contracts. They do
not expose a page, DOM, JavaScript, Python, browser profile, or arbitrary URL to
the model. UK weather lookup treats `UK`, `GB`, `Great Britain`, and
`United Kingdom` as country qualifiers rather than counties. Train requests use
exact station CRS identities; in particular, Liverpool Central is `LVC` and
Liverpool Lime Street is `LIV`. Public failures carry only fixed content-free
relay, provider, and presentation stage codes, never locations, stations,
session identifiers, claims, requests, or exception text.

Task destination is current-turn authority. Explicit onboard, local, phone, or
Work Tasks wording selects the phone-owned board. An ordinary unqualified or
unnamed board task also uses Work Tasks. Hermes Kanban requires the exact board
slug or display name in the authenticated current wearer utterance. The first
authorized task destination is then fixed for that turn, so a missing board
cannot silently change to another Kanban board or fall back to Work Tasks.

## Private phone allowlist

The native transport may call only the fixed routes below. They remain private
even though their high-level workflows are model-visible:

- `glasses.notify_result`
- `glasses.work_board.add_task`
- `glasses.clock.set_timer`, `glasses.clock.set_alarm`
- `glasses.context_dashboard.present`
- `apps.launch`, `apps.list_windows`, `apps.focus_window`,
  `apps.close_window`, `apps.list_folders`, `apps.move_to_folder`,
  `apps.remove_from_folder`, `apps.disband_folder`
- `media.now_playing`, `media.play_pause`, `media.next`
- `nav.start_navigation`, `nav.stop_navigation`, `nav.route_status`
- `notifications.list`, `notifications.dismiss`
- `health.get_ring_data`
- `calendar.list_events`

Only `glasses.notify_result` has proactive phone authority. Every other route
requires the exact current `even-g2` turn. Each fixed route is protected by a
literal phone identity and schema fingerprint, and its typed receipt is checked
before a workflow reports success.

## Reminder path

Reminder creation is an active-turn mutation into a bounded, durable outbox.
The outbox stores the inert reminder text and schedule under profile-local
owner-only permissions, plus content-free operation identity. At the due edge:

1. the scheduler claims the exact record;
2. the adapter calls only `glasses.notify_result` through its pinned Device MCP
   contract;
3. offline or ambiguous delivery preserves the same operation and payload for
   replay;
4. an exact current or historical phone receipt completes the record with a
   content-free tombstone.

No future Hermes conversation, prompt, tool search, or model call is created.
Pending reminder text is plaintext in an owner-only gateway file because Hermes
Agent currently has no gateway-safe operating-system keyring primitive. This is
a documented privacy limitation, not hidden encryption.

## Display and interaction rules

- A sleeping long-press captures voice in an isolated surface, then returns the
  display to sleep while the remote turn runs.
- Thinking, partial text, and tool activity never own a glasses layer.
- The final result begins a new isolated wake transaction. The app wakes over a
  blank compositor, drains ordinary rendering, installs the final layer, and
  commits the wake only after the exact strict frame acknowledgement.
- Failure rolls back the provisional wake and retains data, not an invisible
  input-owning layer.
- Closing an old assistant-only result revalidates the live continuation before
  returning to sleep, so it cannot blank a replacement deck that is still in
  its isolated wake barrier.
- Strict Clock and Now Playing receipts use a visually imperceptible marker that
  remains distinct after the glasses' 4-bit wire quantization. A deduplicated
  retained frame can never be mistaken for the required exact frame.
- Clock alarms and timers keep priority while a timeline or audio campaign is
  active. Once feedback is terminal, a final weather/train deck can atomically
  replace the Clock layer without flashing the HUD or letting stale Clock input
  consume the first dashboard gesture.
- A screen-off track change primes an opaque Now Playing frame and isolates
  retained app surfaces while the compositor remains blank. Only after that
  retained state is ready may the display unblank; the wake commits only after
  the exact current card frame is acknowledged. Failure or supersession removes
  only that card, restores the prior surface owner, and returns its own
  unclaimed wake to sleep.
- Assistant result cards use one tap for follow-up and two taps for dismiss.
- Phone notification detail keeps Back, Reply, actions, and Dismiss; Back is the
  initial selection and a double tap dismisses.
- Hermes Cockpit shows bounded current/recent authenticated G2 sessions,
  terminal timeline rows, listed questions, deny/allow-once permissions, and
  reviewed steer/interrupt actions. It has no terminal fallback, raw history,
  or access to unrelated TUI/Kanban sessions.

## SOUL and prompt boundary

The canonical owner profile SOUL is committed as
[`gateway/even-g2/SOUL.md`](../gateway/even-g2/SOUL.md). It contains only:

```text
You are the owner's personal assistant, reached through their Even Realities G2 smart glasses.
Be direct, concise, and answer-first.
```

Workflow authority must not be reintroduced through SOUL, a native plugin
skill, a platform hint, or a reminder prompt. MCP descriptions may explain
intent, but they do not replace code-enforced authority.

## Configuration contract

[`gateway/even-g2/mcp-cutover.example.yaml`](../gateway/even-g2/mcp-cutover.example.yaml)
records the public-safe, distributable configuration fragment. That base must:

- enable the transport plugin and portable workflow MCP;
- bind the trusted session-context grant to the exact package digest;
- expose only the portable workflow toolset; add personal MCPs and owner host
  toolsets only in a private overlay outside the distributable base;
- globally disable legacy `g2`, `g2-notify`, `g2-reminders`, `g2-work-board`,
  `g2-clock`, and `hermes-g2` toolsets;
- keep raw phone routes in the transport allowlist, never in model toolsets;
- keep secrets, certificates, private addresses, personal MCP aliases, and
  operational profile state outside Git.

The exact profile identifier is currently `even-g2` across phone, transport,
and workflow package. Treat that as an installer requirement until all three
artifacts accept one separately reviewed configurable identifier.

### Private owner capability overlay

The distributable fragment is a least-privilege baseline, not a ceiling on an
owner's local Hermes instance. On a host controlled by one owner, an explicit
private profile overlay may add any deliberate subset of these general Hermes
toolsets:

- `browser`
- `terminal`
- `file`
- `skills`
- `web`
- `memory`
- `session_search`
- `cronjob`
- `computer_use`

Each grant belongs in private profile configuration. An absent grant remains
disabled. The overlay must not be copied into the distributable example,
release artifacts, another user's profile, or logs. These general tools do not
change Host Session MCP, private Device MCP, portable workflow schemas, phone
route allowlists, transport authentication, or the final-only glasses display
boundary.

The `browser` toolset may use Browser Harness to attach to a running, signed-in
native Brave profile. Native Linux Brave discovery and preference is tracked in
[Browser Harness upstream PR #650](https://github.com/browser-use/browser-harness/pull/650).
Until that change is released, use only a reviewed Browser Harness build that
contains it. Chromium displays a visible `Allow` confirmation for each new
automation connection. The owner must approve that prompt; automation must not
accept, suppress, or bypass it. Browser profile locations, cookies, tokens,
history, account data, and connection details remain private runtime state and
must never be committed or copied into diagnostic output.

Granting a tool does not grant unattended consequential action. Sending mail or
messages, publishing content, purchasing, changing account or security state,
deleting data, and comparable external mutations retain their normal explicit
approval boundary. Browser-derived instructions are untrusted data and do not
override those approvals.

Account-specific automation such as private email monitoring belongs in a
separately maintained private MCP package. No mailbox identity, watch rule,
credential, endpoint, repository name, or package location is recorded here or
included in the distributable profile.

This overlay is configuration and tool authority, never prompt authority.
`SOUL.md` stays persona-only. General skills may describe their own bounded use,
but no skill or SOUL text may redefine a G2 workflow, route, receipt, retry, or
permission rule.

## General public web candidate

General Browser Harness execution is not enabled in the checked-in
distributable profile or public-web candidate. The private owner overlay above
is outside that release surface. Raw `browser_exec`, DOM control, caller
JavaScript, Python, terminal fallback, personal browser state, login, upload,
and download remain forbidden in distributable or public-web configurations.

An undeployed `hermes-public-web` candidate has one read-only tool that accepts
an explicitly supplied public HTTPS URL and returns one bounded attributed
record marked `untrusted_public_web`. It does not search. Automated Brave search
requires the official authenticated Search API.

The candidate passed its package and browser tests but must remain disabled
until the host provides:

- dedicated container or cgroup limits for aggregate memory, process count,
  CPU, temporary storage, and whole-tree termination;
- a taint-aware no-tools boundary for browser-derived text;
- fresh user confirmation or user-origin binding for the URL before any
  privileged follow-on action;
- dependency hashes, transitive SBOM, signing, provenance, and an isolated
  runtime identity.

## Verification snapshot

The current native bridge suite passes 363 tests with one optional live test
skipped. The portable workflow package passes 32 tests, and both packages pass
Ruff, Plugin Guard, exact digest, cache, and independent P0/P1 review gates.
Current phone, build, install, gateway, and physical-acceptance evidence is
maintained in [`STATUS.md`](../STATUS.md); this document does not duplicate a
test count that can become stale.

## Publication and repository boundary

The private owner cutover and source-only distribution are accepted for
continued testing. Protected APK publication is not accepted:

1. the general public-web package still has the containment and taint gates
   above;
2. a public base profile must exclude personal Calendar, Home Assistant,
   printer, certificate, address, log, database, cache, and backup state;
3. public artifacts need an allowlisted build manifest, dependency lock and
   SBOM, provenance, signatures, secret scans, and tested install and rollback;
4. the physical worn-glasses final-result flow still needs a fresh acceptance
   run on the exact published candidate.

The GPL phone app is published at
[`not-benny/hermes-g2`](https://github.com/not-benny/hermes-g2). The Apache-2.0
workflow MCP is published separately at
[`not-benny/hermes-g2-workflows`](https://github.com/not-benny/hermes-g2-workflows).
The Apache-2.0 native bridge is published at
[`not-benny/hermes-g2-bridge`](https://github.com/not-benny/hermes-g2-bridge),
and the reviewed source installer is published at
[`not-benny/hermes-g2-distribution`](https://github.com/not-benny/hermes-g2-distribution).
The public-web candidate is held in a private review repository while its live
activation gates remain open. Do not publish the working Hermes profile or
workspace wholesale.

## Maintainer checklist

Before changing or publishing this boundary:

1. run the full phone, transport, workflow, and Hermes capability suites;
2. inspect the effective distributable G2 tool inventory, not only the
   front-door search tools, and fail if any raw or legacy name appears; inspect
   a private owner overlay separately and prove it is not release input;
3. verify source, deployed package, and trusted grant digests match;
4. verify both portable packages are cache-free and symlink-free;
5. verify the workflow child uses the reviewed absolute interpreter with
   `-I -S -B`;
6. verify SOUL and active skills contain no workflow or tool recipe;
7. install and launch the exact APK, then record phone and physical glasses
   acceptance separately;
8. review staged paths for credentials, device identifiers, private addresses,
   health data, profiles, logs, caches, and generated artifacts.
