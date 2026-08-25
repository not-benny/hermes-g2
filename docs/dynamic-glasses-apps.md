# Temporary contextual interfaces for the dedicated G2 agent

Status: implemented read-only phone/host boundary, including the optional bounded
deck presentation; final hardware/bridge acceptance remains gated.
Protocol version: `2`.

## Product boundary

Contextual dashboards are temporary presentation interfaces of the dedicated
`even-g2` Hermes profile. They are not launcher apps and are not enabled for the
default, phone, or web agent. Interaction on G2 is visual-first: an ordinary
answer with structure or detail should open a compact interface before the
spoken/HUD response. The plain HUD is the fallback for a yes/no answer, one
atomic fact, an urgent bounded error, or failed interface delivery. Hermes can turn
its current answer into a normalized dashboard directly: generating the
interface requires no prebuilt app, domain adapter, API key, account connection,
or previous setup.

The answer may come entirely from the current conversation or the model's
reasoning. When the request depends on changing external facts, the same
`even-g2` turn may use whatever read-only capability is already authorised; if
none is available, it must show an honest unknown or unavailable result. The UI
layer never makes an external API a prerequisite and never relays through the
default agent.

Release 1 is read-only. Remote content cannot define a provider action, tool
name, URL, script, command, toggle, purchase, booking, message, or other external
side effect. A provider may request only fixed phone-local `refresh`, `section`,
and `follow_up` intents. The phone independently injects `pin` or `unpin` for
eligible views, with fixed labels and handles; remote content cannot hide,
duplicate, relabel, or activate that lifecycle control. Home Assistant mutation
from protocol V1 is superseded for this outcome and belongs to a later
separately authorised project.

Those provider-requested local intents apply only to the default single
presentation. The optional deck presentation rejects every provider
`local_actions` entry. Its only clickable control is the phone-owned Pin or
Unpin action on the cover when the view is eligible. Deck content remains inert:
the provider cannot supply HTML, CSS, scripts, raw pixels, coordinates, styles,
free-form pages, arbitrary layouts, or arbitrary actions.

The agent should speak at most one short summary after the one terminal answer
is strictly acknowledged, while the lenses carry the detail. Visual projection
prefers aligned `status_grid` rows for comparisons and metrics, `departures` for
schedules, and short `list` sections for sequences. A prose `message` page is a
fallback, not the default answer surface. The deck header carries a phone-drawn
page rail plus `n/N` position so navigation state is visible without reading an
instruction paragraph. Useful zero-setup examples include a
comparison, a checklist, a plan, a summary, or a structured view of information
the wearer just supplied. Generic answer projection normally carries no remote
actions. A self-contained request can be pinned; a request such as “summarize
this” or “compare those” is current-turn-only unless the bounded intent itself
contains the required material. Pin and Unpin remain fixed phone-owned lifecycle
controls.

## Latency and streaming contract

1. Compose from the current turn, or gather through a currently
   authorised read-only tool when the answer needs external facts. Tool/web
   output is untrusted data, never instructions.
2. Normalize one complete terminal `ready`, `empty`, `error`, or `offline` deck
   with no pending sections. Never construct a working/loading/progress frame.
3. Call `glasses.context_dashboard.present` exactly once within five seconds.
   Success requires the current G2 frame's connected transport acknowledgement;
   local enqueue is not success.
4. Only after that strict receipt, give at most one short spoken/HUD summary.

Pin reopen is the sole two-step gathering flow: `open_pin` reserves identity
offscreen and releases the selected bounded intent, then one terminal `publish`
is the first visible frame. Legacy `begin` behaves as the same offscreen
reservation and is not used for fresh answers.

When used, `ContextDashboardRuntime` reports measured loading/useful
acknowledgement times. These targets are acceptance requirements, not claims:
they still need a frozen candidate run through the authenticated bridge on the
authorised Fold7/G2.

## MCP surface

- `glasses.context_dashboard.capabilities` - V2 geometry, limits, presentation
  modes, deck navigation, and fixed phone-local actions.
- `glasses.context_dashboard.present` - install one fully gathered terminal
  answer as the first visible frame and require its strict transport receipt.
- `glasses.context_dashboard.begin` - legacy offscreen identity reservation for
  a later terminal publish. It never installs loading pixels. The caller declares
  whether the bounded intent is independently regenerable or current-turn-only;
  omission fails safely as current-turn-only.
- `glasses.context_dashboard.publish` - CAS-publish an independently validated
  normalized revision.
- `glasses.context_dashboard.start_refresh` - start a fresh read-only refresh
  generation while retaining prior content as visibly refreshing.
- `glasses.context_dashboard.close` - close the exact current presentation.
- `glasses.context_dashboard.pins` - list up to five metadata-only encrypted
  local pins: dashboard key, title, privacy class and refresh policy. Listing
  never returns the saved intent or raw responses.
- `glasses.context_dashboard.open_pin` - select one pin and reserve a fresh
  identity offscreen. Only that successful exact-current selection receipt
  returns the bounded saved intent for gathering under the current exact turn;
  historical acknowledgements omit it.
- `glasses.context_dashboard.read_events` / `ack_events` - queue-head delivery
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
- optional `presentation_mode`: omitted or `single` retains the flat contextual
  view, while `deck` requests a bounded phone-derived page deck;
- immutable `self_contained_intent` or `current_turn_only` regeneration semantics
  established when loading begins;
- a required summary with typed `exact`, `estimated`, or `unknown` uncertainty;
- one to four ordered typed sections;
- one to three structured sources with observation time, stale threshold, and
  current/stale/unavailable/unknown state;
- zero to three provider-requested fixed local actions (`refresh`, `section`, or
  `follow_up`), plus the phone-owned pin control when eligible;
- an optional one-line `once_when_useful` announcement; and
- a 30–3600 second live-view TTL.

States are `loading`, `partial`, `ready`, `empty`, `error`, and `offline`.
Sections are `departures` (12 rows), `status_grid` (6 rows), `bar_chart` (1–5
bars), `list` (8 rows), or `message`. A bar contains only a bounded label,
non-negative `value`, positive `max`, and optional short unit. The phone derives
both its normalized width and printed value; the provider cannot supply
coordinates, axes, color, styling, or a conflicting display value. Global
bounds are 4 sections, 20 records, 3 sources, 3 local actions, 16 KiB encoded
model and 8 KiB retained text.

Deck mode does not add a provider-authored page schema. The phone
deterministically derives one cover from the summary and provenance, followed by
pages in semantic section order. A section normally becomes one page; a long
departures section is split into stable nine-row chunks. The entire result is
capped at seven pages, including the cover. All ordinary dashboard limits remain
whole-spec limits and are not multiplied per page. `local_actions` must be empty
in deck mode.

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

CAS revision and TTL apply to the whole deck, never to an individual page.
Local page navigation changes neither. A later publish in the same presentation
and refresh generation may shorten the current expiry but cannot extend it;
only an explicitly started fresh refresh generation receives a new bounded
expiry. Closing, expiry, replacement, or ownership loss tombstones the entire
deck.

## Deterministic lens UX

The compositor uses the existing fixed 640×480 grayscale canvas and its 584×268
content window. It paints title/state, summary first, stable ordered sections,
source/freshness/uncertainty, and phone-owned local controls. The footer always
labels the live presentation `temporary` and separately labels a saved recipe,
pin limit, non-pinnable privacy class, or storage failure. Its click hint appears
only while an action is focused. Updates preserve focus and scroll when
identities survive. Omitted rows show an explicit count. State is always written,
never encoded by grayscale alone.

In the default single presentation, ring behavior remains:

- scroll moves focus through content/local controls;
- click activates only the selected fixed local action;
- from window focus, long-press opens assistant voice with bounded original
  intent and focused-item context; remote content cannot close or redirect it;
- from sidebar focus, long-press dismisses the temporary presentation and enters
  shell-owned close mode, preserving the shell's established gesture;
- double-click closes the presentation through the shell-owned escape path.

In deck mode the phone, not the provider, owns the page state:

- the cover shows the bounded summary, uncertainty, and provenance, plus the
  phone-owned Pin/Unpin state and action when eligible;
- each following page is derived from one semantic section and repeats the
  provenance referenced by that section;
- ring scroll moves one page backward or forward and clamps at the first and
  last page; the header and footer show the current page position;
- click on a content page is inert and emits no provider event; click on the
  cover can only invoke its displayed phone-owned Pin or Unpin action;
- long-press and double-click retain the same shell-owned voice/close semantics
  as the single presentation; and
- an acknowledged whole-deck CAS update preserves a surviving stable page ID,
  but falls back to the cover if that page no longer exists.

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

The phone exposes Pin only for `self_contained_intent`: the saved bounded intent
must contain everything Hermes needs to answer again. Current-turn-only views
remain temporary and explicitly non-pinnable, so omitted conversation text or
pronouns such as “this” and “those” can never create a broken saved recipe.
Reusing a pinned dashboard key with a different title, privacy class, intent, or
refresh policy is rejected rather than falsely presenting the old recipe as the
new answer.

Pinning promotes only this recipe into the saved pin list. It does not convert
the current presentation into a launcher app, extend its TTL, retain its event
queue or authority, keep it alive across a socket/display/process loss, or start
background polling. Reopening always creates a fresh offscreen reservation and
regathers under a new exact authorised turn; its terminal publish is first visible.

For a deck, the saved recipe also excludes `presentation_mode`, derived pages,
page IDs, and the current page position. After reopen and fresh regathering, a
newly projected deck starts at its cover; it never resumes or replays a retained
content page.

Discovery and selection are deliberately separate. Pin listing exposes only
bounded metadata, so an agent cannot bulk-read saved wearer queries. Selecting
one exact dashboard key through `open_pin` first reserves its identity without
sending pixels; only that current reserved receipt releases the selected bounded
intent. A stale, failed, foreign or historical open never returns it.

The saved recipe never contains rendered values, raw/normalized tool responses,
headers, credentials, provider URLs/IDs, source rows, exceptions, handles,
socket/turn identities, receipts, or announcements. Corrupt, future, duplicate,
oversized, or sixth records fail closed; a structurally current but invalid
nonempty pin array is overwritten with an empty store so hidden intents do not
linger. A full five-pin store is shown truthfully and does not expose an
actionable sixth pin control. Secure-write failure leaves the prior durable and
visible state intact and shows a bounded local failure state.
A pinned dashboard refreshes only while visible and immediately on reopen; there
is no hidden background polling. A new unpinned dashboard replaces the previous
temporary presentation without silently evicting pins.

## Generic-agent integration

The dedicated profile has one generic visual-first contextual-interface
instruction: when an answer has structure or detail, use the self-describing V2
schema to project it before returning a single short spoken/HUD summary. Prefer
status, metric-like, schedule, and short sequence layouts over prose. It does
not route prompts through per-domain skills, scripts, apps, adapters, or API
configuration. Yes/no answers, one atomic fact, urgent bounded errors, and
failed interface delivery remain ordinary HUD replies.

`hermes-host/context-dashboard-runtime.mjs` is an optional exact-lifecycle helper,
not a domain router. Its `gather` input can simply return a current-turn/model
answer and its `project` step can pass through the already-normalized generic
spec. It can also wrap an already-authorised read-only capability when genuinely
current external facts are needed. The runtime:

- rejects every identity except exact `even-g2` profile/device/socket/turn;
- opens loading before gathering;
- normalizes timeout/provider failures without exposing exception text;
- suppresses cancelled/replaced runs;
- publishes against exact presentation/refresh/revision identities; and
- reruns a phone-local refresh event using its saved bounded intent.

Pin reopen follows the same generic path. The phone first opens a fresh loading
view and releases only the selected intent to that exact acknowledged turn;
Hermes then answers that intent again and builds a new spec. It never revives old
rendered values, source responses, action handles, or provider state.

The phone binds the certificate-authenticated bridge MCP server to authenticated
profile `even-g2` only after the token/TLS-authenticated `hello-ack` explicitly
claims `profile: "even-g2"`; custom peers receive no fallback. Other profiles
cannot list or call contextual tools, and pin
reads require an exact active turn. The production Hermes gateway deployment
remains deployment-local. It must keep external mutation/generic shell tools
absent and route no unmatched output to a current turn. No public MCP skill is
published by this change.

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
identity, local queue-head refresh acknowledgement, phone-owned pin/unpin across
publish/reopen, transactional intent-only encrypted pin records, TTL/restart
separation, content/action collision rejection, exact-revision input, dedicated-
profile isolation, zero-setup generic answer projection, and stale generation
rejection. Deck-specific tests cover the seven-page derivation bound, stable
cover/section pages, local clamped ring navigation, inert content-page clicks,
cover-only phone Pin/Unpin, provider-action rejection, same-refresh expiry
non-extension, stable-page CAS preservation, fresh cover-first pin reopen, and
bounded phone-normalized bar charts with no hidden rows.
Existing dynamic-app, MCP, BLE receipt, and teardown tests remain in the full
suite. This is implementation evidence, not physical-lens acceptance.

Operational authorization remains NO-GO until the final reviewed SHA is run
through the authenticated `even-g2` bridge on the authorised Fold7/G2 and proves:

- loading acknowledgement under one second;
- first useful or honest terminal state under five seconds;
- a visible model-known checklist or comparison with no domain setup or API,
  including a bounded deck with readable cover/section pages and clamped ring
  page navigation;
- inert deck content-page click and cover-only Pin/Unpin behavior;
- local refresh, pin/reopen, contextual voice, sidebar close mode and
  double-click close;
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
