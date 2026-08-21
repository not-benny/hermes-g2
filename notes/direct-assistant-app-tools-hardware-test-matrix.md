# Direct assistant and Terminal hardware test matrix

Status: authorization-gated runbook. No hardware, calendar, provider, g2mirror, or
ADB execution has been performed from this document. A test row is not evidence
until its authorization checkpoint is recorded and the row is run on the named
hardware.

## 1. Authorization gate (two-stage GO required)

Assignment, task unblock, device presence, or a connected service is never
operational authorization. Use two separately recorded approvals:

1. **G0 build-only authorization:** approve static checks and the Android build
   at one exact clean source commit. This approval authorizes no device
   discovery, query, install, launch, logcat, screenshot, microphone/wakeword
   action, calendar read, provider call, g2mirror query, or Terminal input.
2. **Re-confirmed operational GO:** after the static build, compute the exact APK
   SHA-256 and package/version, update the record below, and have the authorizer
   re-confirm/sign it. Only this re-confirmed GO can authorize G1 and later
   checkpoints. G1 cannot proceed on the initial build-only GO. Installed
   package/version is recorded only after the authorized installation.

Copy this record, fill it in, and obtain the applicable signature before acting.

```text
GO record ID / TRACE: HERMES_G2_QA_<TRACE>
Authorizer and approval time (UTC):
Operator:
Named phone: model / Android version / ADB serial:
Named G2: identity / firmware / pairing state:
Hermes source commit SHA (exact clean commit approved at G0):
G0 build-only approval / signature and time (no device actions authorized):
Built APK path:
Exact APK SHA-256 (computed after G0, before G1):
APK package/version (built artifact, before G1):
Operational GO re-confirmation/signature after hash/package review:
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
GO decision / signature (operational GO only; G1 is forbidden without it):
```

The operator must mark each checkpoint below `GO: <record ID>` immediately before
acting. If the record does not name the exact action and data scope, stop and
mark the affected rows BLOCKED; do not infer permission from a broader GO.

- **G0 — prerequisites and build:** after only passive collection of the reviewed
  commit, Node version, package version, and tool availability; before `npm ci`,
  tests, typecheck, Android build, or APK hashing. This is build-only scope with
  no device discovery or install.
- **G0R — artifact re-confirmation:** after the build/hash/package is recorded and
  before any device action; authorizer re-signs the exact artifact.
- **G1 — phone/app setup:** before ADB install, launch, logcat, or screenshots.
- **G2 — wakeword/mic:** before changing voice settings or speaking a wakeword.
- **G3 — calendar:** before calendar permission, fixture reads, or provider calls.
- **G4 — Terminal/g2mirror:** before connecting/querying g2mirror, foregrounding a
  disposable view, sending input, or reading a screen.
- **G5 — evidence:** before capturing screenshots, through-lens photos, or logs;
  evidence permission does not authorize additional actions.

## 2. Prerequisites and version record

Before G0, collect only passive facts: the reviewed clean commit, Node version,
package version from `package.json`, and whether the required tools are present.
After the authorizer records G0, run `npm ci`, the repository checks, Android
build, and APK hash below on that exact commit. The Android build requires SDK
35 and JDK 21; use the paths shown rather than JDK 26. Record the resulting hash
and package/version, obtain G0R, and only then proceed to G1; G1 is forbidden on
the initial build-only GO.

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
APK path and SHA-256 (computed after G0 and re-approved at G0R):
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
  calendar contains exactly these two events, created relative to the recorded
  test-start instant (and no other fields):
  `HERMES_G2_QA_<TRACE> earliest` at `T+01:00:00` and
  `HERMES_G2_QA_<TRACE> later` at `T+03:00:00`. Record their exact ISO
  timestamps in the run record.
- Exact action: type the copyable prompt `Show my upcoming calendar events
  within 24 hours`. When the provider requests the tool, permit exactly
  `calendar.list_events({"within_hours":24,"max_events":10})` once.
- Expected request/response: provider receives only the authorized prompt and
  tool result; the response contains exactly, in chronological order,
  `earliest` then `later`, with no unrelated event or field. Empty success is
  not an acceptable happy-path result.
- Expected phone/lens UI: `Thinking...`, canonical `→ calendar.list_events`, a
  concise answer, then Follow-up/Done; no sensitive fixture fields appear.
- Safe data: synthetic titles only, no attendees/location/notes.
- Evidence: redacted tool/provider trace, phone screenshot, through-lens photo,
  and foreground proof.
- Verdict: PASS only when all expected request, UI, ordering, and redaction
  evidence is present; otherwise FAIL with observed details.

#### DA-02 — empty calendar fixture

- Checkpoint: G3 before reading the empty disposable fixture; G5 before evidence.
- Setup: authorized fixture is empty for the next 24 hours.
- Exact action: type `List my upcoming calendar events in the next 24 hours`,
  then permit exactly `calendar.list_events({"within_hours":24,"max_events":10})`.
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
- Exact action: after permission is denied, type `List my upcoming calendar
  events in the next 24 hours`, then permit exactly
  `calendar.list_events({"within_hours":24,"max_events":10})`.
- Expected request/response: **known current limitation / expected FAIL**:
  `app/native/calendar.ts` returns `[]` for absent permission, missing context,
  and provider/parse exceptions, and `calendar.list_events` consequently
  returns the same `No upcoming events in that window.` success as DA-02. No
  event data should be returned. The desired future behavior is a distinct,
  user-visible error; it is not current behavior and requires an implementation
  issue before this row can PASS.
- Expected phone/lens UI: current implementation will show canonical tool
  activity followed by the indistinguishable no-events success, with no stale
  event content or crash. Mark FAIL with the limitation unless the issue is
  fixed and the distinct error is observed.
- Safe data: permission state and synthetic fixture only.
- Evidence: redacted error/tool trace and authorized screenshot.
- Verdict: PASS/FAIL per shared record.

#### DA-04 — calendar bounds and ordering

- Checkpoint: G3 and G5.
- Setup: create one disposable synthetic fixture relative to the recorded
  test-start instant T, with titles and starts exactly as follows (no other
  fields): `HERMES_G2_QA_<TRACE> E01` at T+00:30:00; for n=2..54,
  `HERMES_G2_QA_<TRACE> E<n>` at T+00:35:00 + (n-2)*20 seconds; and
  `HERMES_G2_QA_<TRACE> E55` at T+1500:00:00. Thus E01..E54 are ordered and
  inside 24 hours, while E55 is outside the effective 1440-hour (60-day)
  window; record the exact ISO timestamps and use the same fixture for all
  three calls.
- Exact action: issue these copyable prompts one at a time and permit only the
  shown tool call: (a) `Show the next calendar event within 0.5 hours, maximum
  0 events` -> `calendar.list_events({"within_hours":0.5,"max_events":0})`;
  (b) `List calendar events within 2000 hours, maximum 100 events` ->
  `calendar.list_events({"within_hours":2000,"max_events":100})`; (c) `List
  the first 2 calendar events within 24 hours` ->
  `calendar.list_events({"within_hours":24,"max_events":2})`.
- Expected request/response: the implementation clamps (a) to 1 hour/1
  event, returning exactly E01; clamps (b) to 1440 hours/50 events, returning
  E01 through E50 in timestamp order and excluding E51..E55; and leaves (c) at
  24 hours/2 events, returning exactly E01 then E02 and excluding E03..E55.
  `within_hours` is clamped to 1..1440 and `max_events` to 1..50; no result
  exceeds its effective bound and no malformed argument causes an unbounded
  read.
- Expected phone/lens UI: concise ordered rendering without clipping, stale text,
  duplication, or sensitive details.
- Safe data: synthetic titles/times only.
- Evidence: redacted argument/result trace and lens/phone capture showing the
  boundary case.
- Verdict: PASS/FAIL per shared record.

#### DA-05 — direct assistant turn/tool UI and cancellation

- Checkpoint: G3 for the authorized calendar call, G5 for UI evidence.
- Setup: authorized direct provider and disposable fixture; no unrelated tools.
- Exact action: type `Show my upcoming calendar events within 24 hours`, permit
  exactly `calendar.list_events({"within_hours":24,"max_events":10})`. In a
  separately authorized cancellation run, while the assistant shows
  `Thinking...`, perform one glasses double-click; this is the implemented
  cancel gesture (there is no tappable Cancel control). Do not claim a
  tool-iteration or timeout boundary from this row.
- Expected request/response: the authorized calendar call completes, or the
  second run cancels the in-flight request without a hanging continuation; tool
  activity uses the canonical name. This row does not verify the internal turn
  cap.
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
- Exact action: say `Hey Hermes`, wait for capture, say exactly `Show my
  HERMES_G2_QA_<TRACE> calendar events today`, then issue the implemented
  capture-ending click. In the resulting menu, leave the highlight on the
  `Send to Assistant` row (scroll to it if needed) and click once to select it.
  For the separately authorized cancellation path, double-click during capture
  to dismiss, or in the menu scroll to `Discard` and click once; do not use a
  nonexistent Send/Cancel tap target.
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
- Exact action: with skip-confirmation ON, say `Hey Hermes`, then exactly
  `Show my HERMES_G2_QA_<TRACE> calendar events today`; do not tap Send.
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
- Exact action: in each separately recorded state, say `Hey Hermes`, then
  exactly `Show my HERMES_G2_QA_<TRACE> calendar events today`; do not tap any
  confirmation control.
- Expected request/response: input is ignored; no capture, provider, calendar,
  or assistant turn starts.
- Expected phone/lens UI: unchanged/idle state and no assistant overlay.
- Safe data: synthetic wakeword attempt; do not record microphone content.
- Evidence: setting-state proof and bounded idle/log evidence only.
- Verdict: PASS/FAIL per shared record.

### 4.3 Terminal and g2mirror (background target)

For all positive Terminal rows, G4 must authorize exactly the three tools below,
and must explicitly authorize the isolation/preparation steps. Because
`list_sessions` enumerates every connected control and session, the setup is
fail-closed: before *any* provider/tool call, establish and record that only
the named disposable host/session is connected and visible. Disconnect or
otherwise remove every unrelated Terminal host/session using only actions named
in G4; do not query first to discover what is present. If isolation cannot be
established and recorded without an unapproved query/action, mark TM-01,
TM-02, and TM-03 `BLOCKED` and make no tool call. The Terminal must remain
backgrounded during the assistant call. Establish the authorized disposable
target by foregrounding its view once, then foregrounding a benign non-Terminal
window. Do not claim `list_sessions` selects a target or exposes a session ID.
The only permitted input is exactly
`printf '%s\n' 'HERMES_G2_QA_<TRACE>'`.

#### TM-01 — background `list_sessions`

- Checkpoint: G4 before g2mirror connection/query and G5 for evidence.
- Setup: G4 authorizes isolation/preparation; record that the named disposable
  host/session is the only connected/visible Terminal host/session; establish
  the target, then background Terminal behind a benign window. If that proof is
  unavailable, BLOCKED before the call.
- Exact action: direct assistant requests exactly
  `app.terminal.list_sessions({})`.
- Expected request/response: list succeeds within 15 seconds and returns only
  authorized session metadata; no caller-supplied session ID is used.
- Expected phone/lens UI: canonical `→ app.terminal.list_sessions`, concise result,
  no unexpected Terminal foregrounding.
- Safe data: disposable host/session metadata only.
- Evidence: redacted tool trace, background/foreground proof, screenshot/photo.
- Verdict: PASS/FAIL; a timeout at 15 seconds is FAIL unless GO explicitly covers
  a negative timeout case.

#### TM-02 — background `send_input`

- Checkpoint: G4 explicitly authorizes isolation/preparation and exactly the
  printf command; G5.
- Setup: same proven single-host/single-session isolation and background target
  procedure as TM-01; target is active-view, last-active-view, or sole-view
  resolution, not a supplied ID. If isolation or target proof is unavailable,
  BLOCKED before the call.
- Exact action: call exactly
  `app.terminal.send_input({"text":"printf '%s\\n' 'HERMES_G2_QA_<TRACE>'"})`.
- Expected request/response: command is delivered once and returns within 15
  seconds; no other tool/session/command is touched.
- Expected phone/lens UI: canonical `→ app.terminal.send_input`, concise result,
  Terminal remains backgrounded.
- Safe data: `HERMES_G2_QA_<TRACE>` only.
- Evidence: redacted tool trace, screen/output evidence limited to the fixture,
  and foreground proof. The request must use the exact shape above; no other
  command or session argument is permitted.
- Verdict: PASS/FAIL; timeout at 15 seconds is FAIL except authorized negative
  timeout coverage.

#### TM-03 — background `read_screen`

- Checkpoint: G4 explicitly authorizes isolation/preparation and G5.
- Setup: same proven single-host/single-session isolation and background target
  after TM-02. Before the call, create a fresh disposable view and prove that
  its complete visible screen contains only authorized benign/synthetic content
  (the `HERMES_G2_QA_<TRACE>` fixture and no unrelated prompt, scrollback, or
  session text). If that proof cannot be made, BLOCKED before the call because
  `read_screen` returns the complete visible terminal rows.
- Exact action: call exactly `app.terminal.read_screen({})`.
- Expected request/response: visible screen is returned within 15 seconds and
  contains only authorized fixture output; no session ID is exposed or supplied.
- Expected phone/lens UI: canonical `→ app.terminal.read_screen`, concise safe
  rendering, Terminal remains backgrounded.
- Safe data: synthetic fixture output only; unrelated scrollback must not exist
  on the visible screen. Do not rely on later redaction to make an unsafe call
  acceptable.
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
