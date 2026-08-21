# MCP-driven glasses display threat model (2026-08-21)

## Decision and scope

**Static review: FAIL for publication.**  **Operational authorization: NO-GO.**
This document is a security and publishability model for the current phone-side
assistant bridge and the proposed, not-yet-implemented `glasses.render_view`
surface. It describes the path from agent intent to pixels and the evidence still
needed before any public MCP endpoint, adapter, or skill can be advertised.

The current private bridge may be evaluated only as a trusted-tailnet experiment.
A private trusted-tailnet evaluation is not public proof: it does not authenticate
the WebSocket server, protect the bearer token on `ws://`, establish generic MCP
interoperability, or prove safe behavior on real hardware. The sibling
`hermes-faceclaw-agent-bridge` is also **NO-GO for licensing/redistribution**: the
checkout identifies the upstream project as `jimrandomh`, contains no license
that this repository can rely on, and is not a distributable Hermes artifact.

This is documentation only. It does not implement `glasses.render_view`, change
runtime or release metadata, publish a skill/package, or perform pairing, DFU,
firmware, or other destructive BLE operations.

## Assumptions and non-goals

Assumptions:

- The phone is the MCP server and the external agent/bridge is the MCP client.
- The current bridge is a single phone connection with a shared bearer token.
- Even provisioning and the authenticated/provisioned EvenHub BLE session are
  prerequisites for useful lens output, not proof of MCP peer identity.
- Model output, tool text, notifications, calendar/media/Roam content, window
  titles, logs, and captured packets are untrusted data, never instructions.

Non-goals for v1:

- No direct compositor API, raw pixels, HTML, Markdown, scripts, URLs, images,
  arbitrary fonts/colours, coordinates, z-order, overlays, or wake/focus action.
- No persistence of remote views, multi-view layout, agent-controlled gestures,
  double-click/long-press/extended-hold semantics, or autonomous display wake.
- No claim that a unit test, fake phone, OpenClaw session, A32-only run, or
  trusted network proves a real G2 or public-release gate.

## Architecture and data flow

Current path (the alert/reply path exists today):

```text
user utterance or wakeword / proactive agent
        -> OpenClaw model + persistent session (third-party agent boundary)
        -> sibling bridge meta-tools / MCP JSON-RPC over WebSocket
        -> phone bridge client + MCP lifecycle / ToolRegistry preflight
        -> tool handler and shell (alerts, streamed assistant reply, windows)
        -> retained shell surfaces -> SurfaceCompositor full composite
        -> packed frame -> authenticated/provisioned EvenHub BLE session
        -> G2 lenses
```

Secondary outputs and leak paths are phone preview, screenshots/recordings,
SharedPreferences/configuration, Android backup/ADB access, logs/errors, and
MCP tool schemas/results. Calendar, notification, media, window, location,
navigation, and Roam data can leave the phone through the bridge even when the
final display is blank or disconnected.

Proposed path (not implemented):

```text
conversation-bound agent intent
        -> validated static render_view schema
        -> singleton shell-owned in-process window
        -> retained compositor -> EvenHub BLE -> lenses
```

The proposed path must reject malformed or stale requests before side effects;
render success must not be reported unless transport and result evidence exist.

## Assets

| Asset | Confidentiality / integrity / availability concern |
|---|---|
| Bridge token and host/port configuration | Secret theft enables tool calls; host/port tampering redirects traffic. |
| Utterances, transcripts, context and OpenClaw session | Sensitive speech, location/app state and durable personal history. |
| Tool schemas, arguments and results | Schema confusion can turn untrusted text into side effects or exports. |
| Notification, calendar, media, window and Roam data | Personal content can be exported, logged, retained, or shown to bystanders. |
| Display content and retained view state | Spoofing, stale content, distraction, privacy disclosure, and memory exhaustion. |
| Device addresses, connection generations and session state | Rebinding or replay can address the wrong socket/device or resurrect a view. |
| Android SharedPreferences, backup and ADB configuration | Local users/tools may read masked-but-plaintext secrets and private data. |
| BLE/compositor frames and transport result | Corruption or false success can produce wrong lens output or unsafe assumptions. |
| Hardware-validation evidence | False provenance could turn simulation into an unjustified release claim. |

## Trust boundaries

| Boundary | Crossing data / principal | Required control |
|---|---|---|
| User intent | Spoken/user action vs agent request | Preserve turn identity; no silent promotion of proactive intent. |
| Model, agent and plugins | Third-party generated text/tool selection vs Hermes | Treat all output as data; validate schemas and permissions locally. |
| Bridge host/network | OpenClaw host, WebSocket peer and network | WSS or an authenticated tunnel plus server proof; least binding; replay defense. |
| Android app/config/ADB/backup | Local OS, backup service and developer tooling | Minimize permissions, disable backup where appropriate, secret-safe storage/logs. |
| MCP/registry/window workers | JSON-RPC caller vs handlers and window ownership | Preflight, explicit authorization, operation IDs/cancellation, ownership epochs. |
| Compositor/native BLE | Shell surfaces vs native packer/EvenHub session | Bounds, failure propagation, no false success, preserve BLE safety gates. |
| Physical lenses/bystanders | Pixels and audio visible to wearer/others | Minimize content, TTL, clear close behavior, no distracting autonomous wake. |

Pairing/provisioning crosses a device-onboarding boundary only. It does not
authenticate an MCP peer or prove that the WebSocket server is the intended one.

## Attacker model

Consider a malicious network peer on or beyond the tailnet, a compromised
agent/plugin/model emitting prompt or tool injection, a replayed or delayed
turn/request, oversized or adversarial content, a curious local user with
ADB/backup access, and a bystander shoulder-surfing the lenses. Also consider
ordinary faults: unavailable hardware, disconnect/reconnect, blank/off display,
compositor failure, local close/TTL races, and duplicate or late completions.
The model includes accidental unsafe model selection, not just intentionally
malicious users.

## Current limits and material gaps

| Component | Current observed limit/control | Gap that remains |
|---|---|---|
| Bridge transport | Phone dials plaintext `ws://`; bearer token is in `hello`; `hello-ack` is accepted without server proof. | Use authenticated secure transport/server proof; never treat a tailnet as peer authentication. |
| Bridge lifecycle | Connection generations, 15 s auth timeout, 20 s keepalive check, 45 s liveness timeout, 3 min turn timeout, and reconnect backoff of 1–60 s plus up to 50% jitter. | Bind MCP calls to a unique live turn generation and prove replay/late rejection; keepalive and reconnect are availability controls, not peer authentication. |
| MCP lifecycle | Initialization/version handling, duplicate-ID tombstones, 128 completed-ID retention, and connection epoch suppression. | Bind authorization to the originating turn and make cancellation/late side effects safe. |
| Proactive MCP | Boolean “some turn active” test and a sliding quota of 6 calls/minute after preflight. | Explicit turn-bound intent; proactive opt-in must default off. |
| Registry | Schema preflight; 10 s default caller timeout; live 25 s overrides include `navigate-tools.ts:42` and `roam-tools.ts:31`; all are caller-side deadlines and do not cancel the handler. | Cancellation or operation IDs/idempotency; result must identify real completion and late handlers must not create side effects. |
| Display today | Unbounded `glasses.show_alert`; shell popup is 6 s and proactive. | Bounds, interruption policy, live transport/turn gate, and device result evidence. |
| Streamed reply today | `AssistantLayer` retains the full stream; only the visible tail is clipped by HUD geometry. | Visual clipping is not input bounding; cap bytes/chars before retention and transport. |
| Proposed view | Audit design specifies singleton, 16 KiB encoded spec, 32 blocks, 8 actions, 8 KiB total text, 1 KiB/text block, title 80, label 40, ID 64 ASCII, TTL 30–3600 s, 2 updates/s. | No implementation or race/fuzz/golden/hardware evidence exists. Adopt, do not redesign, these limits. |
| Android | Manifest allows cleartext, backup, broad storage/package/location/audio/calendar/Bluetooth and related permissions. | Least-privilege review, scoped storage/backup decision, and user-visible permission/privacy behavior. |
| Sibling bridge | Shared token/plaintext WebSocket that may bind non-loopback; 10 s hello timeout, 120 s turn timeout, and 20 s MCP caller timeout; persistent OpenClaw session; caller-only deadlines do not cancel handlers. | Secure/replay-safe implementation, license authority, and generic-client/adapter evidence. |

In particular, a clipped tail in the HUD is only a presentation limit. Current
alert and streamed-reply inputs are not bounded before they are retained,
serialized, or passed to the compositor.

## Threat register

Severity is the residual risk before the named remediation is evidenced.
Owners are suggested implementation/evidence owners, not a claim that work is
already assigned or complete.

| ID / attack | Current control | Residual gap | Severity | Exact remediation / evidence owner |
|---|---|---|---|---|
| T1 spoofed bridge/server | Shared token and client generation guard | Plaintext transport; unauthenticated `hello-ack` server identity | Critical | Bridge owner: WSS with certificate validation or enforced authenticated tunnel plus server proof; negative/positive credential tests. |
| T2 token theft/replay | Token is masked in settings UI; pre-auth frames rejected | Token is sent over `ws://`, stored as a string, and may enter ADB/backup/log paths | Critical | Android/bridge owner: secret-safe storage and redaction, backup policy, secure transport; inspect logs/backup and run stolen-token/replay tests. |
| T3 prompt/tool injection | Central JSON schema preflight | Model/tool text can be treated as instructions; meta-tool accepts dynamic names/args | High | Agent adapter owner: explicit untrusted-data contract; registry rejects unsupported schemas and per-tool authorization tests. |
| T4 schema abuse | Types, required fields, bounds, additional properties are checked | Existing tools still have broad/insufficient bounds and no render schema | High | Registry/system-tools owner: per-tool schemas and hostile/oversize tests; child hardening task owns code. |
| T5 duplicate/late side effect | Duplicate request-ID tombstones and connection epoch | Handler continues after timeout; retries can toggle, skip, dismiss, write, or close twice | Critical | Registry/tool owners: cancellation or operation IDs/idempotency and late-completion tests. |
| T6 stale turn/connection race | Socket generations and active-turn IDs | “Some turn active” is not the caller’s unique live turn | High | Bridge/MCP owner: turn generation in authorization context; stale/replay/reconnect tests. |
| T7 flooding/proactive abuse | 6/min proactive quota; 15 s auth and 45 s liveness timers | Quota is global/boolean and display alerts can interrupt/wake | High | MCP policy owner: default-off proactive opt-in, per-turn intent and bounded display update tests. |
| T8 memory/render exhaustion | HUD geometry clips visible tail | Retained reply, alert, and compositor inputs are not bounded | High | Shell/render owner: enforce byte/character and encoded-spec limits before retention; fuzz and allocation tests. |
| T9 privacy export/retention | Tool availability gates and local shell state | Transcripts, context, notifications/calendar/media/Roam/window data cross bridge and session persists | High | Privacy owner: minimization/redaction/retention policy, no-secret logs, denied-permission and export tests. |
| T10 log/error disclosure | Errors are surfaced as text; some logs identify peers/tools | Error strings and bridge logs can include sensitive values or model output | High | Bridge/app owner: structured redaction and bounded generic errors; log-scan tests with sentinel secrets. |
| T11 broad Android permissions | Runtime permissions exist for feature set | Manifest grants broad storage, backup, cleartext, package visibility, location and device access | High | Android owner: least-privilege manifest review, backup decision, permission denial tests; no permission widening for render v1. |
| T12 unavailable hardware | Registry availability preflight; BLE session has existing gates | A disconnected/blank/off display can still produce local-only success or stale content | High | Shell/BLE owner: reject before side effect, disconnect removes ownership, result only after transport evidence; A32/G2 tests. |
| T13 disconnect/reconnect | Connection epochs close old MCP sessions | Late worker completions, gestures, or updates may target a new owner | Critical | Render/MCP owner: owner epoch, cancellation, tombstones and reconnect race tests. |
| T14 blank/off display | Shell knows screen state; current alert is proactive | No v1 wake/focus gate; content can be reported while not visible | High | Render owner: no wake/focus in v1; distinguish sent, transported, and visible result; off-display tests. |
| T15 compositor failure | Native compositor packs retained surfaces | Failure propagation and partial-update semantics are not an MCP contract | High | Native/shell owner: fail closed, retain old valid surface or clear safely, never report success; injected-failure tests. |
| T16 local close/TTL race | Proposed tombstone and TTL rules in audit | No implementation; update can resurrect closed/expired view | High | Render owner: tombstone closed views, monotonic revision/operation ID; close/update/TTL race tests. |
| T17 unsafe actions/distraction | Shell owns some gestures | Agent content/actions can disclose data or distract wearer; no `render_view` exists | High | UX/shell owner: static text/key-value/progress/divider only, bounded actions, escape semantics, shoulder-surf review and real-G2 test. |
| T18 licensing/redistribution | Audit identifies sibling checkout and upstream | No license authority for sibling bridge; publication could redistribute improperly | Critical | Release owner: obtain written license or do not ship/reference as artifact; provenance record. |
| T19 evidence laundering | Existing unit/fake-phone tests are useful static/simulated evidence | No generic MCP, WSS, credentials, A32+G2, or operational proof | Critical | QA/release owner: ledger labels and reproducible evidence bundle; operational GO remains blocked. |
| T20 malicious action labels/content | Text is displayed as text | URLs/scripts/Markdown/images/raw pixels could become unsafe if admitted later | High | Render owner: reject all non-v1 fields and escape/plain-text render; hostile-content schema tests. |

## Safe-failure contract

Every proposed display operation must:

1. Validate protocol version, schema, size, revision, TTL, owner, turn, and
   authorization before any shell/compositor/BLE side effect.
2. Treat all model and tool text as inert data; reject HTML/Markdown/scripts,
   URLs, images, raw pixels, fonts, coordinates, colours, and z-order in v1.
3. Never wake or focus the display for v1. An off/blank display is not a display
   success; return a distinguishable unavailable/not-visible result.
4. Use one replace-only singleton. Create an opaque `view_id`; updates require
   the expected monotonic revision; local close and expiry create tombstones.
5. Use cancellation and/or an operation ID with idempotent semantics. A timeout
   must not allow an unknown late handler to mutate the view.
6. Remove ownership on disconnect and prevent an old connection from updating a
   newly connected owner. Never resurrect a closed view.
7. Report success only after transport/result evidence from the shell/compositor
   and (where claimed) the BLE path. A local enqueue is not lens visibility.

## Publishability gate checklist

| Gate | Status now | PASS evidence required |
|---|---|---|
| Least privilege | FAIL | Manifest/config review removes unnecessary access or documents a separately approved feature; denial paths pass. |
| Explicit turn-bound intent | FAIL | Unique live turn generation is carried and revalidated immediately before side effects. |
| Proactive opt-in default-off | FAIL (`assistant.allowProactive` defaults true) | Default false, explicit setting/consent, bounded per-session policy tests. |
| Untrusted-content handling | FAIL | Plain-text allowlist and rejection tests for injection/URLs/scripts/markup/images. |
| Secret-safe storage/logs/errors | FAIL | Secure storage or documented containment, no token/PII in logs/errors/backup/ADB evidence. |
| Data minimization/retention | FAIL | Field-level export policy, bounded transcript/session retention, deletion/disable behavior. |
| Bounded HUD schema/output/update rate/TTL | FAIL | Static v1 schema with exact audit limits, fuzz tests, 2 updates/s and TTL tests. |
| Secure authenticated transport/server proof | FAIL | WSS certificate validation or enforced authenticated tunnel plus proof the peer knows the secret. |
| Replay/idempotency | FAIL | Duplicate IDs, stale revisions, cancellation, timeout, reconnect and late side-effect tests. |
| Generic MCP + Hermes adapter interoperability | FAIL | Independent generic client and adapter tests against a versioned endpoint. |
| Licensing | FAIL | License/provenance clearance for every shipped dependency, especially sibling bridge. |
| Rollback/disable | PARTIAL | Disable bridge/proactive path without uninstalling; prove disconnect/close and recovery behavior. |
| Evidence provenance | FAIL | Reproducible ledger with STATIC/SIMULATED/A32-ONLY/A32+REAL-G2 labels and artifacts. |

All gates must pass before publication. The current headline and operational
verdict therefore remain unchanged.

## Ordered exact-change backlog

### P0 — global bridge, turn, and idempotency gates

Target `app/assistant/bridge-client.ts`, `app/assistant/mcp-server.ts`,
`app/assistant/tool-registry.ts`, `app/assistant/bridge-connection-guard.ts`,
the sibling bridge's transport/adapter only if its licensing is resolved, and
focused tests in `tests/mcp-server.test.mjs`,
`tests/tool-registry.test.mjs`, `tests/bridge-connection-guard.test.mjs`.
Add authenticated transport/server proof, unique live-turn authorization,
pre-side-effect revalidation, cancellation or operation IDs/idempotency, and
secret-safe failure behavior. Keep public scope empty while evidence is absent.

### P1 — bounded static `render_view` implementation and tests

After P0, target the shell/registry integration (`app/ui/shell/`,
`app/assistant/`), a dedicated schema/handler module, and
`tests/in-process-surface.test.mjs` plus new render contract/fuzz/race tests.
Implement only the existing audit design at
`notes/mcp-skill-publish-audit-2026-08-20.md:101-142`: singleton,
replace-only, revisions, owner epoch, tombstones, exact size/text/action/TTL
limits, no wake/focus, and safe result/error semantics. Do not add code in this
documentation task; child `t_0c616231` owns that implementation phase.

### P2 — adapter/docs/skill

Only after P0/P1 evidence: establish a versioned generic MCP endpoint and
Hermes/OpenClaw adapter contract, obtain sibling licensing clearance, write
installation/configuration/privacy/rollback docs, and consider a
`hermes-g2-glasses` skill. Cross-link the publication audit rather than
reproducing its 24-tool matrix; every example must state the evidence and
hardware limits honestly.

## Evidence ledger

| Claim / test | Label | Current evidence and limitation |
|---|---|---|
| Source architecture, trust boundaries, limits and gaps | STATIC | This document plus live TypeScript/Java/manifest source and publication audit. Static inspection is not operational proof. |
| MCP lifecycle/schema/connection unit tests | STATIC | Audit run: focused suite 19 passed, 0 failed. Does not prove WSS, credentials, generic client, or hardware. |
| Full repository tests | STATIC | This task run: 145 passed, 2 pre-existing/date-sensitive failures at `tests/ring-health-store.test.mjs:158` and `:190`; not MCP evidence. The earlier audit baseline was 143/145 before concurrent test additions. |
| Typecheck and Android debug build | STATIC | Audit reported typecheck and JDK 21/Android SDK build passed; debug APK is not a reproducible release identity. |
| Fake-phone/OpenClaw bridge evaluation | SIMULATED | Useful protocol exercise only; fake phone and trusted network do not prove server identity, public security, or lens visibility. |
| A32 install/launch/logcat and package behavior | A32-ONLY | Required before operational review; no claim is made here that this task performed it. |
| Real G2 static view create/update | A32+REAL-G2 | Required: create, replace update, monotonic revision and transport/result evidence. Not available in current proposed surface. |
| Real G2 stale revision/oversize/rate/TTL | A32+REAL-G2 | Required negative tests: reject stale, oversize and bursts; verify expiry without resurrection. Missing. |
| Local close/disconnect/no-wake/escape | A32+REAL-G2 | Required: tombstone close, reconnect ownership removal, no proactive wake, safe gesture escape. Missing. |
| Generic MCP and Hermes adapter | SIMULATED then operational | Must run against the versioned secured endpoint with sanitized credentials and reproducible logs. Missing. |

Operational GO requires the A32 install/launch/logcat evidence plus real-G2
create/update/stale-revision/oversize/rate/TTL/local-close/disconnect/no-wake/
escape tests. Until then, retain `FAIL for publication` and `NO-GO`.

## Source index and related record

- Bridge: `app/assistant/bridge-client.ts:164-409`.
- MCP lifecycle and tombstones: `app/assistant/mcp-server.ts:47-197`.
- Schema preflight and timeout: `app/assistant/tool-registry.ts:211-348`.
- Current alert/tools: `app/assistant/system-tools.ts:25-156`.
- Stream retention and visual tail clipping: `app/ui/shell/assistant.ts:44-116`.
- Settings and proactive default: `app/ui/dashboard-settings.ts:575-616,697-704`.
- Android permissions/cleartext/backup: `App_Resources/Android/src/main/AndroidManifest.xml:11-55`.
- Retained surfaces/BLE path: `SurfaceCompositor.java:10-209` and
  `FaceclawBleCommunicator.java:700-801,1383-1434`.
- Publication matrix and exact v1 limits:
  `notes/mcp-skill-publish-audit-2026-08-20.md:101-142,173-232`.
- Sibling bridge evidence: `/home/benny/Documents/hermes-g2/hermes-faceclaw-agent-bridge/README.md:13-37,72-95,107-147,194-224`,
  `lib/bridge-service.js:24-57,93-280,282-358`,
  `lib/mcp-client.js:23-43,92-124`, `lib/tools.js:28-81`.

The publication audit remains the canonical 24-tool matrix. This document is
its end-to-end display threat model and evidence gate, not a replacement for it.
