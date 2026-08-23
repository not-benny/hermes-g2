# Contextual dashboards for the dedicated G2 agent

Status: implemented read-only local boundary; final hardware/bridge proof remains gated.
Protocol version: `2`.

## Product boundary

Contextual dashboards are a presentation capability of the dedicated `even-g2`
Hermes profile. They are not enabled for the default, phone, or web agent. An
ordinary G2 question should open a dashboard when a compact visual answer is
materially better than speech alone. The same `even-g2` turn gathers data with
its directly authorised read-only tools and publishes a normalized dashboard;
it never relays through the default agent.

Release 1 is read-only. Remote content cannot define a provider action, tool
name, URL, script, command, toggle, purchase, booking, message, or other external
side effect. The only actions are fixed phone-local `refresh`, `pin`, `unpin`,
`section`, and `follow_up` intents. Home Assistant mutation from protocol V1 is
superseded for this outcome and belongs to a later separately authorised project.

The agent should speak one short announcement when the first useful revision is
ready, while the lenses carry the detail. For the exact phrase:

> When is the next train at Liverpool Lime Street?

the foreground view is an all-destination departure board ordered by expected
departure (scheduled departure is the explicit fallback), not a destination
prompt or a single guessed service. Cancelled services remain in chronological
position and unknown expected times are labelled honestly.

## Latency and streaming contract

1. Call `glasses.context_dashboard.begin` before starting slow data gathering.
2. The phone validates and sends a loading view. Success means the current G2
   frame received the app's connected transport outcome `sent`; local enqueue is
   not success.
3. Target loading-frame acknowledgement is under one second from accepted
   utterance.
4. Gather only through the dedicated profile's current authorised read-only
   tools. Provider/web output is untrusted data, never instructions.
5. Normalize the first useful section and call
   `glasses.context_dashboard.publish` within five seconds. If data is slow or
   unavailable, publish a bounded honest `error` or `offline` section rather
   than leaving an indefinite spinner.
6. Later sections use stable section IDs and CAS revisions. Each current
   transport acknowledgement is a distinct delivery receipt.

`ContextDashboardRuntime` reports measured loading/useful acknowledgement times.
These targets are acceptance requirements, not claims: they still need a frozen
candidate run through the authenticated bridge on A32/G2.

## MCP surface

- `glasses.context_dashboard.capabilities` — V2 geometry, limits, and fixed local
  actions.
- `glasses.context_dashboard.begin` — replace the ephemeral foreground slot and
  acknowledge a loading frame.
- `glasses.context_dashboard.publish` — CAS-publish an independently validated
  normalized revision.
- `glasses.context_dashboard.start_refresh` — start a fresh read-only refresh
  generation while retaining prior content as visibly refreshing.
- `glasses.context_dashboard.close` — close the exact current presentation.
- `glasses.context_dashboard.pins` — return up to five encrypted local pin
  records containing intent and policy, never raw responses.
- `glasses.context_dashboard.open_pin` — reopen one pin as a fresh loading view;
  the saved intent is gathered again under the current exact turn.
- `glasses.context_dashboard.read_events` / `ack_events` — queue-head delivery
  and exact acknowledgement for fixed local intents.

Every call still requires the MCP server's live authenticated socket and exact
active turn. Dashboard lifetime is separate from turn authority: a later exact
turn may refresh the same current presentation only with its dashboard,
presentation, refresh, and CAS revision identities. Old socket, turn,
presentation, refresh, revision, timer, event, or delivery identities fail
closed.

## Declarative V2 schema

A V2 dashboard has:

- stable `dashboard_key`, bounded title, lifecycle state and privacy class;
- a required summary with typed `exact`, `estimated`, or `unknown` uncertainty;
- one to four ordered typed sections;
- one to three structured sources with observation time, stale threshold, and
  current/stale/unavailable/unknown state;
- zero to three fixed local actions;
- an optional one-line `once_when_useful` announcement; and
- a 30–3600 second live-view TTL.

States are `loading`, `partial`, `ready`, `empty`, `error`, and `offline`.
Sections are `departures` (12 rows), `status_grid` (6 rows), `list` (8 rows), or
`message`. Global bounds are 4 sections, 20 records, 3 sources, 3 local actions,
16 KiB encoded model and 8 KiB retained text.

Host projection and phone execution both validate the model. Unknown fields,
duplicate/non-contiguous IDs, missing source references, malformed timestamps,
non-finite numbers, invalid error-state combinations, oversized/deep data,
markup, URL-like text, controls/bidi overrides, arbitrary action kinds, and
executable content are rejected atomically. The last valid revision remains
current; invalid partial data is never merged.

The phone derives displayed age and stale state from its own clock and the typed
observation metadata. Provider-authored freshness prose is not trusted.
Unsupported V2 clients may downgrade only to inert V1 heading/status/card/text
components. Mutation controls and remote action handles must be omitted.

## Deterministic lens UX

The compositor uses the existing fixed 640×480 grayscale canvas and its 584×268
content window. It paints title/state, summary first, stable ordered sections,
source/freshness/uncertainty, and phone-owned local controls. Updates preserve
focus and scroll when identities survive. Omitted rows show an explicit count.
State is always written, never encoded by grayscale alone.

Ring behavior:

- scroll moves focus through content/local controls;
- click activates only the selected fixed local action;
- long-press opens assistant voice with bounded original intent and focused-item
  context; remote content cannot close or redirect it;
- double-click closes the presentation through the shell-owned escape path.

A `refresh` event carries the saved bounded intent, not an old provider response
or tool-call payload. The host starts a new generation and reruns under current
read-only authorisation. Late prior results cannot overwrite it.

## Pinning

At most five dashboards are pinned. The encrypted phone-local record contains
only:

- dashboard key and title;
- `public` or `private` privacy class (`sensitive` is not pinnable);
- bounded original intent; and
- bounded manual/on-visible refresh policy.

It never contains rendered values, raw/normalized tool responses, headers,
credentials, provider URLs/IDs, source rows, exceptions, handles, socket/turn
identities, receipts, or announcements. Corrupt, future, duplicate, oversized,
or sixth records fail closed. A pinned dashboard refreshes only while visible
and immediately on reopen; there is no hidden background polling. A new
unpinned dashboard replaces the previous ephemeral presentation without
silently evicting pins.

## Dedicated-agent integration

`hermes-host/context-dashboard-runtime.mjs` is the provider-neutral host boundary.
`ContextDashboardAgent` automatically maps the mandatory ordinary Liverpool
question and supports additional trusted read-only visual adapters; unsupported
questions remain in the normal conversation flow.
The dedicated profile supplies trusted local `gather` and `project` functions;
provider output is projected field-by-field. The runtime:

- rejects every identity except exact `even-g2` profile/device/socket/turn;
- opens loading before gathering;
- normalizes timeout/provider failures without exposing exception text;
- suppresses cancelled/replaced runs;
- publishes against exact presentation/refresh/revision identities; and
- reruns a phone-local refresh event using its saved bounded intent.

`projectLiverpoolLimeStreetDepartures` is the permanent typed acceptance
projector. It validates the station, excludes already-departed rows, retains all
destinations and cancellations, sorts by effective departure then deterministic
tiebreakers, caps at 12 rows, and produces typed provenance and one announcement.
Future adapters should follow this pattern rather than paste raw tool JSON into
the phone schema.

The phone binds the certificate-authenticated bridge MCP server to authenticated
profile `even-g2` only after the token/TLS-authenticated `hello-ack` explicitly
claims `profile: "even-g2"`; custom peers receive no fallback. Other profiles
cannot list or call contextual tools, and pin
reads require an exact active turn. The production Hermes gateway deployment
and concrete rail-reader credential/configuration remain deployment-local. They
must keep external mutation/generic shell tools absent and route no unmatched
output to a current turn. No public MCP skill is published by this change.

### Separate private Home Assistant evaluation harness

Protected main includes a private-only harness in
`hermes-host/private-dynamic-ha-server.mjs` and its bounded WSS/phone/provider
peers. It keeps credentials deployment-local, uses a durable payload-bound
mutation ledger, defaults to read-only, and requires explicit reversible
mutation authorization. It is not called by the contextual-dashboard tools,
does not change this V2 schema's local-action allowlist, and is not production or
public MCP authorization.

## Evidence and remaining gates

Permanent host tests cover the V2 bounds, executable/action rejection, source
references, loading-before-gathering order, cross-turn refresh with exact socket
identity, local queue-head refresh acknowledgement, intent-only encrypted pin
records, dedicated-profile isolation, deterministic all-destination train
sorting, and stale generation rejection. Existing dynamic-app, MCP, BLE receipt,
and teardown tests remain in the full suite.

Operational authorization remains NO-GO until the final reviewed SHA is run
through the authenticated `even-g2` bridge on the authorised A32/G2 and proves:

- loading acknowledgement under one second;
- first useful or honest terminal state under five seconds;
- visible all-destination Liverpool board and scroll/focus behavior;
- local refresh, pin/reopen, contextual voice and double-click close;
- disconnect/reconnect and process-restart fail-closed behavior;
- secret-sentinel-clean phone/host/logcat/persistence surfaces; and
- complementary wearer/optical evidence if per-lens application acknowledgement
  remains unavailable.

Static source/build approval does not establish lens visibility. No firmware,
DFU/OTA, pairing/ownership, provisioning/NVM, reset/wipe, destructive BLE,
smart-home mutation, or unrelated terminal authority is part of this feature.
Public skill/MCP publication remains blocked pending authenticated generic-client
interoperability, credential and retry evidence, licensing, and the real-G2
proof above.
