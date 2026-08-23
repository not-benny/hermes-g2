# Hermes agent cockpit

The Hermes app now has a structured, native glasses cockpit for explicitly shared
Hermes sessions and Kanban workers. It is separate from the terminal app: no
terminal scraping, raw command input, hidden session discovery, or provider UI is
used.

## Trust boundary

The existing private Hermes bridge remains the only network endpoint. It is WSS
only, authenticates before privileged channels, and validates the configured
server certificate against Android's system roots plus the deployment-local
Hermes bridge CA. Cockpit support adds the negotiated `cockpit-v1` capability and
multiplexes protocol-version-1 `chan: "cockpit"` frames after `hello-ack`.

The bridge host is authoritative. The phone keeps only a bounded in-memory
projection and cannot prove that a request is still pending. Every action is
bound to an explicit public session ID, exact execution generation, opaque
request ID/nonce, and one-shot command ID. The host must revalidate those values,
expiry, pending state, and current policy immediately before sending a Hermes RPC
or side effect.

The complete lifecycle and privacy threat model is in
`notes/hermes-cockpit-protocol-threat-model-2026-08-23.md`.

## Native glasses UI

The launcher includes **Hermes** next to Terminal. The native app has these local,
fixed screens:

- active work, ordered with pending input first;
- a compact bounded timeline with assistant/tool/status rows;
- a pending-input inbox;
- listed question choices followed by an answer-review screen;
- an exact typed permission scope followed by a separate decision screen;
- reviewed voice steering bound to the opened run generation;
- exact-run interrupt and explicit completed/failed/interrupted state.

Permission decisions default to **Deny**. The only positive decision is
**Approve once**. If the host cannot express a request through the typed scope,
the glasses show an unsupported scope and offer denial only. There is no approve
all, persistent allow, permission-mode change, arbitrary command entry, provider
markup, URL action, or current-session fallback.

The existing shell voice UI reviews transcription before delivering it to the
cockpit. The cockpit performs a second exact-run review before sending steering.
Disconnect, sequence gaps, replacement generations, terminal runs, retired
requests, duplicate taps, and expired requests make controls inert.

Closing the Hermes window clears its volatile UI subscription. Disabling or
clearing the existing Hermes bridge configuration disconnects the transport.
Host-side `unshare` clears the selected session projection and pending handles.
No cockpit transcript, request, or decision is written to app settings.

## Host adapter

`tools/hermes-cockpit-adapter.mjs` is the metadata-only host adapter core intended
to be embedded in the existing authenticated bridge process. It consumes the
current Hermes TUI gateway JSON-RPC/event surface and emits only the bounded
cockpit projection. Its supported Hermes mappings are:

| Cockpit input/event | Hermes TUI gateway |
|---|---|
| assistant text | `message.delta` / `message.complete` |
| tool summary | `tool.start` / `tool.progress` / `tool.complete` (name/status only) |
| listed question | `clarify.request` → `clarify.respond` |
| typed one-shot permission | `approval.request` → `approval.respond` with `all: false` |
| reviewed steering | `session.steer` |
| interrupt | `session.interrupt` |

The adapter accepts sessions only through `share(...)`; it never calls global
session history/discovery or reads Hermes/kanban SQLite files. Public IDs are
opaque and separate from Hermes IDs. Raw event objects are not retained. Tool
arguments/results, reasoning, prompts, provider IDs, credentials, private task
bodies, and unsupported approval commands are not projected or logged.

A positive approval requires a bridge-authored typed `cockpit_scope` containing
an allowlisted action, exact bounded target, and material effect. Generic Hermes
approval payloads are deliberately deny-only because their provider-shaped
command/argument data is not a safe authority schema.

The bridge integration sequence is:

1. connect to Hermes' authenticated `/api/ws` gateway on loopback;
2. maintain an operator-selected allowlist of session/task IDs;
3. feed allowlisted gateway events into `HermesCockpitAdapter.ingest`;
4. send returned frames over the already authenticated private WSS `cockpit`
   channel;
5. pass phone commands to `handleCommand` immediately before dispatch;
6. send a returned JSON-RPC request to Hermes only if non-null;
7. turn the Hermes RPC result into a `command_receipt` and authoritative state or
   interaction-close event;
8. call `disconnect()` on either transport loss and require a fresh snapshot
   before accepting another action.

The adapter has no standalone public listener, token store, or TLS downgrade. The
private bridge deployment owns its WSS endpoint, credentials, certificate, replay
journal, and audit metadata. Audit records must contain stable event/action type,
public opaque identity, generation, timestamp, and outcome only—not text, scope,
answer, command arguments, or private payloads.

## Local fake adapter and fixtures

For deterministic development without a Hermes process or hardware:

```bash
node tools/hermes-cockpit-fake-adapter.mjs
```

It accepts one JSON object per stdin line and writes one bounded JSON object per
stdout line. Operations are `share`, `unshare`, `snapshot`, `event`, `observe`,
`command`, and `disconnect`. It does not open a network listener or log input.

`tests/fixtures/hermes-cockpit-events.json` inventories ordering, duplicated and
answered-elsewhere prompts, stale generations, expiry, reconnect, interrupt races,
process death, malformed/oversized content, and privacy sentinels. The permanent
adapter/protocol/controller/UI tests exercise the executable paths.

## Verification status

Host tests, TypeScript typecheck, and the JDK 21 / Android SDK 35 debug build pass
for the current candidate. The APK contains the native cockpit app and launches
through the ordinary app registry.

A32 install/launch and real-G2 cockpit interaction were not run because `adb
devices -l` reported no attached device. The private bridge deployment has not
been upgraded with this adapter core in this repository run, so no real Hermes
question, approval, steering, interrupt, reconnect, or completion claim is made.
The feature remains operationally gated until the exact reviewed candidate and
matching bridge adapter are deployed in a serialized hardware window.

No pairing/ownership, provisioning/NVM, firmware/DFU/OTA, reset/wipe, Bluetooth
setting, OS permission, or destructive device action is part of this feature.
