# Direct assistant and Terminal hardware test matrix

Status: authorization-gated runbook. No hardware, calendar, provider, g2mirror, or
ADB execution has been performed from this document. A test row is not evidence
until its authorization checkpoint is recorded and the row is run on the named
hardware.

## 1. Authorization gate (GO required)

Assignment, task unblock, device presence, or a connected service is never
operational authorization. Before any discovery, query, wake, install, launch,
logcat, screenshot, microphone/wakeword action, calendar read, provider call,
g2mirror query, or Terminal input, obtain a separately recorded GO. Copy this
record, fill it in, and have the authorizer approve it before proceeding.

```text
GO record ID / TRACE: HERMES_G2_QA_<TRACE>
Authorizer and approval time (UTC):
Operator:
Named phone: model / Android version / ADB serial:
Named G2: identity / firmware / pairing state:
Hermes source commit SHA:
APK SHA-256 and package/version (record only after GO):
Allowed ADB actions (exact install, launch, stop, logcat, screenshot commands):
Allowed wakeword/microphone actions (voice master, voice action, confirmation changes):
Calendar fixture: disposable local QA calendar name; synthetic title set:
Calendar permission action and allowed data scope:
Provider: configured provider/model (no secret); explicitly authorized calendar-data transmission:
g2mirror host and disposable session:
Allowed g2mirror tools: list_sessions, send_input, read_screen only:
Exact authorized Terminal command: printf '%s\n' 'HERMES_G2_QA_<TRACE>'
Allowed evidence: phone screenshot / through-lens photo / redacted logs / traces:
Expiry (UTC):
Explicit exclusions: no reset, wipe, firmware, DFU, pairing or ownership change,
no destructive BLE, no Even-app re-pairing, no credential disclosure, and no
unrelated sessions, tools, commands, data, or terminal output.
GO decision / signature:
```

The operator must mark each checkpoint below `GO: <record ID>` immediately before
acting. If the record does not name the exact action and data scope, stop and
mark the affected rows BLOCKED; do not infer permission from a broader GO.

- **G0 — prerequisites and build:** before any device discovery or install.
- **G1 — phone/app setup:** before ADB install, launch, logcat, or screenshots.
- **G2 — wakeword/mic:** before changing voice settings or speaking a wakeword.
- **G3 — calendar:** before calendar permission, fixture reads, or provider calls.
- **G4 — Terminal/g2mirror:** before connecting/querying g2mirror, foregrounding a
  disposable view, sending input, or reading a screen.
- **G5 — evidence:** before capturing screenshots, through-lens photos, or logs;
  evidence permission does not authorize additional actions.

## 2. Prerequisites and version record

Complete the static prerequisites before G0. Use the reviewed clean commit, Node
20 or newer, and the package version from `package.json`. Run the repository
checks below on the reviewed commit. The Android build requires SDK 35 and JDK
21; use the paths shown rather than JDK 26.

```text
Reviewed commit / branch:
Node version (>=20):
Package version:
Timezone and clock source:
Companion commit/build:
Direct provider/model (no secret):
Calendar permission state:
g2mirror revision/connectivity:
Phone OS/model (after G1):
G2 firmware (after G1):
APK path and SHA-256 (after G1; compute, do not copy keys/tokens):
Installed package/version (after G1):
```

Static commands (no device or connected-service interaction):

```sh
npm ci
npm test
npm run typecheck
JAVA_HOME=/usr/lib/jvm/java-21-openjdk ANDROID_HOME=/home/benny/Android/Sdk npm run build
sha256sum platforms/android/app/build/outputs/apk/debug/app-debug.apk
```

Do not run the matrix, ADB, g2mirror, provider, calendar, or device commands as
part of static verification. A debug APK hash identifies that build instance;
it is not a release identity.

## 3. Shared run record and evidence rules

Create one run record per `TRACE`, and one timestamped entry for each row:

```text
TRACE:
Row / checkpoint / GO record:
UTC timestamp and local timestamp:
Setup and precondition:
Exact action/request (including arguments, with secrets removed):
Expected request/response:
Observed request/response:
Expected phone/lens UI:
Observed phone/lens UI:
Latency (start, end, elapsed):
Foreground/background proof:
Evidence filenames and redaction review:
Binary verdict: PASS / FAIL / BLOCKED
If FAIL: severity, reproduction, expected-vs-observed, issue reference:
If BLOCKED: missing prerequisite/evidence and exact unblock condition:
```

Capture only authorized, bounded evidence. Redact keys, tokens, account IDs,
personal calendar text, addresses, attendees, locations, notes, microphone
content, and unrelated terminal output. Calendar fixtures use synthetic titles
only, with no attendees, location, or notes. Through-lens evidence must show
only the authorized synthetic data. Preserve completed authorized rows without
extrapolating to blocked rows.

## 4. Matrix

Every row below must have the shared run-record fields: setup, exact action,
expected request/response, expected phone/lens UI, safe data, evidence, and a
binary PASS/FAIL verdict. `BLOCKED` is used instead of a binary verdict when an
authorization, hardware, service, or evidence prerequisite is unavailable.

### 4.1 Build, setup, and calendar

#### DA-01 — direct calendar happy path

- Checkpoint: G1, then G3, then G5 for evidence.
- Setup: authorized debug APK installed; voice master/action enabled; disposable
  calendar contains synthetic trace-derived titles at known ordered times.
- Exact action: ask the direct assistant for upcoming calendar events within the
  authorized window; permit `calendar.list_events` with bounded arguments.
- Expected request/response: provider receives only the authorized prompt and
  calendar tool result; request shape is `{within_hours?, max_events?}` and the
  tool returns ordered events or explicit empty success.
- Expected phone/lens UI: `Thinking...`, canonical `→ calendar.list_events`, a
  concise answer, then Follow-up/Done; no sensitive fixture fields appear.
- Safe data: synthetic titles only, no attendees/location/notes.
- Evidence: redacted tool/provider trace, phone screenshot, through-lens photo,
  and foreground proof.
- Verdict: PASS only when all expected request, UI, ordering, and redaction
  evidence is present; otherwise FAIL with observed details.

#### DA-02 — empty calendar fixture

- Checkpoint: G3 before reading the empty disposable fixture; G5 before evidence.
- Setup: authorized fixture has no upcoming events in the selected window.
- Exact action: request upcoming events with an authorized bounded window.
- Expected request/response: `calendar.list_events` returns `No upcoming events
  in that window.`; direct mode completes without inventing events.
- Expected phone/lens UI: canonical tool status, concise no-events response,
  Follow-up/Done, no stale events from DA-01.
- Safe data: empty fixture only.
- Evidence: redacted trace and screenshots proving the fixture/window.
- Verdict: PASS/FAIL per shared record.

#### DA-03 — calendar permission denied/error

- Checkpoint: G3 explicitly names permission revocation and G5 evidence.
- Setup: use only the disposable fixture; deny or remove calendar permission as
  authorized. Do not alter unrelated permissions.
- Exact action: request upcoming events.
- Expected request/response: a bounded, user-visible calendar error; no event
  data is returned or sent to the provider.
- Expected phone/lens UI: canonical tool activity followed by a concise error,
  no stale prior event content, and no crash.
- Safe data: permission state and synthetic fixture only.
- Evidence: redacted error/tool trace and authorized screenshot.
- Verdict: PASS/FAIL per shared record.

#### DA-04 — calendar bounds and ordering

- Checkpoint: G3 and G5.
- Setup: synthetic events straddle the window, include equal/nearby start times,
  and exceed the requested count.
- Exact action: issue authorized requests at low, high, and out-of-range values
  for `within_hours` and `max_events`.
- Expected request/response: `within_hours` is clamped to 1..1440 hours and
  `max_events` to 1..50; results are ordered by start time and never exceed the
  bound. No malformed argument causes an unbounded read.
- Expected phone/lens UI: concise ordered rendering without clipping, stale text,
  duplication, or sensitive details.
- Safe data: synthetic titles/times only.
- Evidence: redacted argument/result trace and lens/phone capture showing the
  boundary case.
- Verdict: PASS/FAIL per shared record.

#### DA-05 — direct assistant turn/tool UI and timeout boundary

- Checkpoint: G3 for the authorized calendar call, G5 for UI evidence.
- Setup: authorized direct provider and disposable fixture; no unrelated tools.
- Exact action: complete one calendar turn and, only if separately authorized,
  cancel a thinking turn with the documented UI gesture.
- Expected request/response: tools are re-listed each loop iteration; tool
  activity uses the canonical name; the direct loop stops at its turn cap and
  handles errors without hanging.
- Expected phone/lens UI: `Thinking...`, `→ <tool>`, streamed tail, error when
  applicable, then Follow-up/Done; no clipped or duplicated stale response.
- Safe data: synthetic prompt and calendar result.
- Evidence: bounded trace with timestamps and authorized UI captures.
- Verdict: PASS/FAIL per shared record.

### 4.2 Wakeword and voice policy

#### VW-01 — wakeword, voice master/action enabled, confirmation OFF

- Checkpoint: G2 before changing settings or speaking; G3 if the utterance is a
  calendar request; G5 for recording evidence.
- Setup: voice master and voice action enabled; skip-confirmation OFF; authorized
  disposable fixture/provider if calendar is requested.
- Exact action: speak the authorized wakeword and utterance; confirm/send through
  the normal flow.
- Expected request/response: wakeword opens capture; utterance is not sent until
  the normal confirmation action; only authorized tool/provider calls occur.
- Expected phone/lens UI: capture state, confirmation UI, then assistant status
  and final response; no audio or text leakage in evidence.
- Safe data: synthetic utterance and fixture titles only.
- Evidence: authorized phone/lens evidence and redacted timestamps.
- Verdict: PASS/FAIL per shared record.

#### VW-02 — wakeword, skip-confirmation ON auto-send

- Checkpoint: G2 explicitly names auto-send; G3/provider scope if applicable; G5.
- Setup: voice master/action enabled and skip-confirmation ON.
- Exact action: speak the authorized wakeword and synthetic request.
- Expected request/response: capture auto-sends after wakeword without a manual
  confirmation; request stays within the GO data scope.
- Expected phone/lens UI: wake/capture, `Thinking...`, tool status if used, and
  final response; no duplicate submission.
- Safe data: synthetic utterance only.
- Evidence: redacted request timing and authorized UI evidence.
- Verdict: PASS/FAIL per shared record.

#### VW-03 — voice master/action OFF ignored behavior

- Checkpoint: G2 explicitly names the setting changes and wakeword attempt; G5.
- Setup: voice master OFF, then separately voice action OFF as authorized; no
  calendar/provider scope is needed because no request should be sent.
- Exact action: speak the authorized wakeword/utterance in each state.
- Expected request/response: input is ignored; no capture, provider, calendar,
  or assistant turn starts.
- Expected phone/lens UI: unchanged/idle state and no assistant overlay.
- Safe data: synthetic wakeword attempt; do not record microphone content.
- Evidence: setting-state proof and bounded idle/log evidence only.
- Verdict: PASS/FAIL per shared record.

### 4.3 Terminal and g2mirror (background target)

For all positive Terminal rows, G4 must authorize exactly the three tools below.
The Terminal must remain backgrounded during the assistant call. Establish the
authorized disposable target by foregrounding its view once, then foregrounding
a benign non-Terminal window. Do not claim `list_sessions` selects a target or
exposes a session ID. The only permitted input is:
`printf '%s\n' 'HERMES_G2_QA_<TRACE>'` unless the GO records another harmless command.

#### TM-01 — background `list_sessions`

- Checkpoint: G4 before g2mirror connection/query and G5 for evidence.
- Setup: authorized disposable g2mirror host/session connected; terminal target
  established, then Terminal backgrounded behind a benign window.
- Exact action: direct assistant calls `app.terminal.list_sessions`.
- Expected request/response: list succeeds within 15 seconds and returns only
  authorized session metadata; no caller-supplied session ID is used.
- Expected phone/lens UI: canonical `→ app.terminal.list_sessions`, concise result,
  no unexpected Terminal foregrounding.
- Safe data: disposable host/session metadata only.
- Evidence: redacted tool trace, background/foreground proof, screenshot/photo.
- Verdict: PASS/FAIL; a timeout at 15 seconds is FAIL unless GO explicitly covers
  a negative timeout case.

#### TM-02 — background `send_input`

- Checkpoint: G4 explicitly authorizes the exact printf command; G5.
- Setup: same background target procedure as TM-01; target is active-view,
  last-active-view, or sole-view resolution, not a supplied ID.
- Exact action: call `app.terminal.send_input` with the exact authorized printf.
- Expected request/response: command is delivered once and returns within 15
  seconds; no other tool/session/command is touched.
- Expected phone/lens UI: canonical `→ app.terminal.send_input`, concise result,
  Terminal remains backgrounded.
- Safe data: `HERMES_G2_QA_<TRACE>` only.
- Evidence: redacted tool trace, screen/output evidence limited to the fixture,
  and foreground proof.
- Verdict: PASS/FAIL; timeout at 15 seconds is FAIL except authorized negative
  timeout coverage.

#### TM-03 — background `read_screen`

- Checkpoint: G4 and G5.
- Setup: same background disposable target after TM-02, with only fixture output
  visible where practical.
- Exact action: call `app.terminal.read_screen`.
- Expected request/response: visible screen is returned within 15 seconds and
  contains only authorized fixture output; no session ID is exposed or supplied.
- Expected phone/lens UI: canonical `→ app.terminal.read_screen`, concise safe
  rendering, Terminal remains backgrounded.
- Safe data: fixture output only; redact unrelated scrollback.
- Evidence: redacted response, background proof, phone/lens evidence.
- Verdict: PASS/FAIL; timeout at 15 seconds is FAIL except authorized negative
  timeout coverage.

#### TM-04 — no active view errors for send/read

- Checkpoint: G4 explicitly authorizes the no-active-view setup; G5.
- Setup: authorized g2mirror has no active, last-active, or sole view; do not
  create one through an unapproved launch tool.
- Exact action: call only `app.terminal.send_input` and
  `app.terminal.read_screen`, with the exact harmless input for send.
- Expected request/response: both fail closed with concise no-active-view errors;
  no input is sent and no screen is fabricated.
- Expected phone/lens UI: canonical tool status followed by error; no crash,
  hang, or unexpected Terminal window.
- Safe data: no-active-view state and harmless command text only.
- Evidence: redacted error traces and state proof.
- Verdict: PASS/FAIL per shared record; timeout is FAIL unless explicitly covered.

## 5. Verdict, failure, and blocked-result procedure

PASS requires the expected request/response, UI, safe-data boundary, evidence,
and timing/foreground condition in that row. FAIL requires observed-versus-
expected details, UTC/local timestamps, redacted artifacts, reproduction steps,
and issue-ready severity. A timeout at 15 seconds is FAIL for positive Terminal
rows unless the GO explicitly authorizes a negative timeout case.

If any authorization, named hardware, service, build, fixture, permission, or
evidence prerequisite is unavailable, stop before the first disallowed action.
Mark every unrun affected row `BLOCKED`, record the missing prerequisite and the
exact unblock condition, and do not mark it FAIL. Preserve independently
completed authorized rows; never extrapolate their result to another row.

A blocked result must include:

```text
BLOCKED — row:
Missing authorization/prerequisite:
Last permitted action and timestamp:
Exact unblock condition:
No disallowed action performed: yes/no (if no, stop and escalate):
```

Do not continue after an expired or scope-mismatched GO. No reset, wipe,
firmware/DFU, pairing/ownership change, destructive BLE operation, Even-app
re-pairing, credential disclosure, unrelated session/tool/command, or partial
execution is permitted.
