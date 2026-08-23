# Dynamic glasses applications (private evaluation)

Status: implemented local boundary; public MCP/skill publication remains blocked.
Protocol version: `1`.

## Architecture

Hermes is the trusted orchestration host. `hermes-host/dynamic-glasses-runtime.mjs`
projects typed provider data into the generic phone tools under
`glasses.dynamic_apps.*`. Provider credentials, provider URLs, entity IDs, raw
responses, headers, and arbitrary executable code never appear in the phone view
model or action events.

The phone owns strict validation and the G2 compositor. It reports success only
when the exact shell frame finishes with transport outcome `sent` in the current
connected session. A timeout, disconnect, supersession, cancellation, or any
`discarded:*` frame outcome fails the tool call. This proves the current BLE
transport acknowledgement available to the app; it does not by itself prove
that both lenses visibly applied the pixels.

Wearer input produces inert opaque action handles. The phone exposes only the
oldest unacknowledged event, so a later intent cannot execute and cumulatively
discard an earlier one. Hermes resolves a handle to a
provider capability and immediately revalidates the exact tenant, device,
connection generation, turn generation, view ID/revision, action generation,
provider discovery generation, authorization, entity availability, and current
provider revision before an explicit side effect. Input events remain available
until acknowledged.

## MCP tools

- `glasses.dynamic_apps.capabilities`: exact display, limits, inputs, and
  supported component types.
- `glasses.dynamic_apps.create`: create one exact-turn view.
- `glasses.dynamic_apps.update`: full CAS replacement.
- `glasses.dynamic_apps.patch`: component-ID CAS upsert/remove.
- `glasses.dynamic_apps.close`: close and tombstone the exact revision.
- `glasses.dynamic_apps.read_events`: cursor-based inert input observation.
- `glasses.dynamic_apps.ack_events`: exact event acknowledgement.

All mutating view calls use a payload-bound `operation_id`. Reusing an operation
ID with different arguments fails. Replaying a completed create after close is
reported as `historical_acknowledgement`, never as a currently live view.

## Declarative schema

A view has bounded `title`, `state`, `privacy`, `components`, and `ttl_seconds`.
States are `loading`, `ready`, `empty`, `error`, and `offline`. Privacy classes
are `public`, `private`, and `sensitive`.

Supported inert components are:

- heading and text;
- status/value rows with a bounded tone;
- cards and bounded lists;
- progress;
- fixed-name status icons;
- toggles and buttons with opaque action handles;
- explicit confirmation rows;
- dividers.

The phone rejects unknown fields/types, duplicate component IDs, malformed
handles, unsafe control/bidi characters, markup, URL-like text, non-finite
numbers, more than 64 components, more than 32 list entries, specs above 24 KiB,
and retained component text above 12 KiB. There are no URLs, images, coordinates,
fonts, colors, scripts, HTML, Markdown execution, shell commands, or generic tool
names in the protocol.

The renderer is deterministic for the fixed 640×480 grayscale G2 canvas. It
reserves title/state/footer space, clips atomically by component, truncates
bounded columns, displays an explicit omitted-item count, and uses scroll/click
for focus and activation. Double-click and long-press remain shell-owned escape
paths. Dynamic apps close on display sleep, owner disconnect, exact local close,
TTL, or explicit close; they do not wake the glasses or restore after process
replacement.

## Home Assistant reference adapter

`hermes-host/home-assistant-adapter.mjs` is the first provider adapter. It:

1. requires a server-side HTTPS origin and token getter;
2. blocks redirects and normalizes every error;
3. discovers the actual `Living Room` membership at runtime through a fixed
   Home Assistant template plus current states;
4. intersects membership with current state and permits only available
   `light.*` and `switch.*` entities;
5. exposes fresh opaque handles rather than entity IDs;
6. delegates mutation to one configured provider-side atomic endpoint that
   checks the exact area membership, entity/domain, provider revision, and
   explicit `on`/`off` target in the same Home Assistant operation; the endpoint
   must never use provider `toggle` or an area-wide target;
7. fails closed with `atomic mutation unavailable` when that endpoint is absent,
   rather than attempting a check-then-service TOCTOU sequence;
8. atomically reserves in-flight idempotency keys before asynchronous work and
   retains outcome-unknown failures so retries cannot redispatch;
9. rechecks current Living Room membership, capability generation, entity
   availability, provider revision, and authorization immediately before the
   service call; and
10. restores only an adapter-issued receipt whose service response context and
   verified post-read context match, then refuses to overwrite any later
   human/automation revision. A provider response without causal context is
   explicitly non-restorable.

## Adding another provider

Keep the adapter on the Hermes host. Implement these seams:

1. runtime discovery returning bounded labels, typed state, opaque capability
   handles, and provider-derived revisions;
2. `read(handle)` with current availability and revision validation;
3. explicit target-state mutation with an operation ID, abort signal, and a
   last-moment authorization callback;
4. post-mutation verification and an honest `outcome unknown` error where the
   provider cannot prove the result; and
5. receipt-based conservative restoration for any evaluation mutation.

Project only allowlisted provider fields into the generic schema. Never copy raw
objects or exception text. Refreshing discovery must issue a new generation and
make every old handle stale. Removing and re-adding the same external ID must not
resurrect old authority.

## Private harness

Read-only discovery is the default:

```bash
HA_URL=https://home-assistant.example \
HA_TOKEN='server-side-secret' \
node hermes-host/private-evaluation.mjs
```

A reversible mutation requires all gates:

```bash
HA_URL=https://home-assistant.example \
HA_TOKEN='server-side-secret' \
HA_ATOMIC_MUTATION_PATH=/api/hermes_g2/safe_set_power \
HA_ALLOW_MUTATION=I_UNDERSTAND \
node hermes-host/private-evaluation.mjs \
  --apply --label 'Floor lamp' --to on --restore
```

The token must be supplied through the server environment, not command-line
arguments. The harness prints only bounded labels and state. It requires one
exact unique label, verifies the explicit target, and restores in `finally`; a
revision conflict leaves the newer state untouched. SIGINT/SIGTERM does not exit
while a mutation is in flight; it waits for a verifiable receipt and then enters
the same restoration path. Kill/crash recovery still requires the durable
production ledger described below and is not authorised by this private harness.

The atomic endpoint is an external Home Assistant peer contract, not arbitrary
code delivered to the phone. Its exact request is an object containing only
`version: 1`, bounded `operation_id`, `area: "Living Room"`, one `entity_id`,
`domain: "light"|"switch"`, `expected_revision`, and `target: "on"|"off"`.
It must durably bind `operation_id` to that payload before mutation. Success is
`{applied:true, area:"Living Room", before:<HA state>, after:<HA state>}`;
fail-closed precondition responses are `{applied:false, code:"stale_scope"|
"stale_revision"|"unavailable"}`. Unknown fields and other codes are errors.

The revision is SHA-256, base64url without padding, over UTF-8 JSON for
`{attributes, context, last_updated, state}` where `context` is the HA context
ID and every object key (including nested attribute keys) is recursively sorted
lexicographically before serialization; arrays preserve order. The endpoint
must validate membership and this revision, execute one explicit service
transition, and capture before/after states atomically. Without this peer,
read-only discovery works and every mutation fails closed.

### Private end-to-end WSS runner

`hermes-host/private-dynamic-ha-server.mjs` now joins the phone's existing WSS
bridge protocol to a generic exact-turn MCP client, `DynamicGlassesRuntime`, and
the Home Assistant adapter. It accepts only one authenticated phone connection,
binds only a literal private/tunnel/loopback address, requires TLS certificate
and key files, rejects binary/oversized frames, replaces old connection
generations, and recognizes one exact spoken trigger. It polls only
`glasses.dynamic_apps.read_events`; one opaque action is routed through the
runtime per evaluation session and every retained mutation receipt is restored
before exact view close. Reopen the view for another reversible action.

Run from a private deployment environment; keep every path and value private:

```bash
PRIVATE_BRIDGE_BIND_HOST=<private-literal-address> \
PRIVATE_BRIDGE_PORT=<wss-port> \
PRIVATE_BRIDGE_TLS_CERT=<server-certificate-path> \
PRIVATE_BRIDGE_TLS_KEY=<server-key-path> \
PRIVATE_BRIDGE_TOKEN=<shared-token> \
HA_URL=https://home-assistant.example \
HA_TOKEN=<server-side-token> \
HA_ATOMIC_MUTATION_PATH=/api/hermes_g2/safe_set_power \
HA_MUTATION_LEDGER_PATH=<absolute-private-0600-ledger-path> \
HA_ALLOW_MUTATION=I_UNDERSTAND \
PRIVATE_EVALUATION_RESTORE=REQUIRED \
node hermes-host/private-dynamic-ha-server.mjs
```

Then say exactly `open private living room controls`. A different utterance is
rejected without opening a view. The durable local ledger binds operation ID,
provider payload, mutation/restore purpose, and restoration parent before
dispatch. On restart the server replays pending provider operations through the
same atomic endpoint, reconstructs trusted receipts for completed but unrestored
mutations, and restores them before accepting WSS connections. The atomic Home
Assistant endpoint remains the authority that must make a repeated operation ID
non-dispatching across host crashes.

## Remaining gates

The repository now contains a private-evaluation WSS server and generic MCP
client. It is not a public or production gateway. Real HA-to-phone-to-G2 use
still requires deployment-local credentials, a certificate whose SAN matches
the configured bridge host, the provider-side atomic endpoint, and explicit
hardware authorization/evidence.

Public publication and production authorization remain NO-GO until all of these
are independently proven on one frozen final SHA:

- Android evidence for correct-certificate success and wrong-CA/wrong-host
  failure (host-side WSS tests cover these paths but are not Android evidence);
- independent deployment review of durable cross-process mutation and restore
  reconciliation against the real provider-side endpoint;
- generic MCP-client version negotiation and interoperability;
- credential rotation and production secret-store integration;
- licensing and redistribution review;
- sanitized logs with secret sentinels;
- real A32 + G2 scroll/action/state-update evidence; and
- exact per-lens applied acknowledgement or complementary optical evidence for
  both lenses.

No firmware, DFU/OTA, pairing/ownership, provisioning/NVM, reset/wipe,
destructive BLE, or unrelated terminal capability is part of this feature.
