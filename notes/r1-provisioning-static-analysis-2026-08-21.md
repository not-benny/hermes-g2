# R1 provisioning call-site review (static-only, 2026-08-21)

## Scope and evidence boundary

This is a repository-safe summary of static inspection of the installed official
Even Android app (`com.even.sg`, version 2.2.9, four installed APK/splits) on
the authorized development phone. APK/splits and the private Blutter output were
kept outside this repository. No package path, serial, MAC, identifier,
credential, raw APK/AOT bytes, or proprietary byte dump is recorded here. No app
modification, provisioning command, ring write, or runtime provisioning attempt
was performed.

Evidence used:

- Installed package metadata and `pm path`: base plus arm64, English, and xhdpi
  configuration splits; the arm64 split contains `libapp.so`, `libflutter.so`,
  and `libflutter_ezw_algorithm.so`.
- Private Blutter AOT/object-pool output for `libapp.so`, inspected only to
  recover sanitized function names, addresses, control-flow facts, and model
  field/length behavior. The report cites function names/addresses, not dumps.
- Existing repository-safe capture reconciliation in
  `notes/ring-health-protocol-2026-08-19.md`,
  `notes/ring-firmware-update-design.md`, and `tests/ring-frame.test.mjs` was
  used for the already-known outer frame schema and lifecycle context. The
  captured `advStart` vector in the test is a previously captured frame and is
  not treated as a newly extracted official-app secret or algo-key vector.

## Shared AOT transport path

The recovered `BleRing1CmdPublicExt.sendCmd` at AOT `0x1461d0c` accepts module,
command, sub-command, optional `data`, a status method, a status-zero value, and
a timeout (default 1000 ms). Its dispatch path at `0x1461ed8` constructs the
Ring1 model with `cmd`, `module`, `subCmd`, `data`, serial ID, and request status,
serializes it through `BleRing1Model.toBytes` (`0x1463890`), computes the outer
CRC32, and sends a `BleRing1Transfer`. Thus the command wrappers below are
actual call sites, not conclusions from retained strings alone.

The model serializer writes a fixed 12-byte inner header before the variable
data: command byte, mapped sub-command byte, module byte, a 16-bit field, then
status and remaining header fields (see `BleRing1Model.toBytes`,
`0x1463890`). The method is represented in that shared status field: recovered
`BleRing1StatusMethod` maps GET to ordinal/status `0x00` and SET to
ordinal/status `0x01`. The exact meanings of every other header offset are
outside this command-specific report; the relevant facts are that the selected
method/status is serialized in the header and `data` is appended after the
12-byte inner header.

## `system/advStart` (sub-command 0x0a)

**Recovered/proven:**

- `BleRing1CmdProto.advStart` at AOT `0x1747a14` constructs
  `BleRing1SystemHostMac`, checks `isComplete`, serializes it with `toBytes`,
  and calls `BleRing1CmdPublicExt.sendCmd` at `0x1747b30`. The call passes the
  system command/module and sub-command object that maps to 0x0a, with the
  shared default method **GET/0x00**; this is control-flow evidence of outbound
  issuance.
- `isComplete` at `0x1747cc8` calls `StringExt.macToBytes()` for both fields and
  requires each resulting list length to be six. If incomplete, the wrapper
  logs and returns without sending. The prerequisite is therefore two complete
  six-byte MAC-derived values, not an arbitrary caller-supplied vector.
- `BleRing1SystemHostMac.toBytes` at `0x1747b50` obtains `_rightMacBytes`
  (`0x1747c84`) first, then `_leftMacBytes` (`0x1747c4c`), copies the right
  list into a growable integer list, appends the left list, and allocates the
  final byte list at that length. The current AOT payload is consequently
  **12 data bytes, right then left**, followed by the normal 12-byte inner
  header and outer framing. `StringExt.macToBytes` normalizes separators,
  validates 12 hexadecimal characters, parses successive two-character bytes,
  then returns the reversed list. Therefore each MAC contributes six bytes in
  reversed textual-byte order; the two-MAC concatenation remains right first,
  then left.
- The wrapper awaits `sendCmd` and discards its value, returning void. The
  wrapper's explicit failure handling is the incomplete-MAC skip; no retry,
  rollback, persistence, or ACK interpretation is exposed here.
- Existing repository capture reconciliation identifies module 1, command 0,
  sub-command 0x0a, request status, and places `advStart` early after session
  setup. The repository test vector has inner length 18, so after its 12-byte
  inner header it contains **six data bytes**. That legacy six-byte capture is
  distinct from the current AOT host-MAC serializer's 12-byte right+left form;
  the reason for the discrepancy (firmware/app version, derived value, or
  different call path) is unresolved. A separate established-session capture
  with 12 data bytes must not be silently conflated with the legacy vector.

**Not proven:** padding, serial policy, response/ACK payload structure,
retries/backoff, and error mapping. The AOT does not prove
that the six-byte legacy vector is an accepted current provisioning payload.

**Confidence:** outbound call site, gating, current right-then-left length, and
reversed per-MAC byte order: high. Legacy-vector reconciliation: low/medium.

## `system/getAlgoKeyStatus` (sub-command 0x0b)

**Recovered/proven:**

- `BleRing1CmdGoMoreExt.getAlgoKeyStatus` at AOT `0x1b0d1e4` calls
  `sendCmd` at `0x1b0d238` with system command/module and the sub-command object
  mapping to 0x0b. It supplies no `data` argument, so the request data field is
  empty/bare at this model layer. It uses the shared default method
  **GET/0x00** and timeout (the shared `sendCmd` default is 1000 ms).
- After awaiting the response, it checks the response success/status field
  (`field_b`); on failure it returns null. It then requires a non-null response
  data object and reads its integer field (`field_13`); values <= 1 return null.
  Only when that value is > 1 does it call `BleRing1GetAlgoKey.fromBytes` at
  `0x1b0d2b4`.
- `fromBytes` bounds-checks that at least one byte exists, reads byte zero as an
  integer, decodes the remaining bytes with `Uint8listExt.decodeToString`, and
  constructs `BleRing1GetAlgoKey`. `decodeToString` first applies UTF-8 codec
  decoding, then strips control characters and trims whitespace; its fallback
  path handles decode failure without establishing a different semantic
  encoding. Therefore the parsed response model is one status/metadata byte
  plus a variable-length sanitized decoded string. The AOT does not establish
  the semantic enum or whether the string is key material.
- No explicit retry, persistence, or ordering behavior is present in this
  wrapper. It returns a nullable model, not a raw ACK object.

**Confidence:** query direction/status, empty request data, response guard, and
parser shape/UTF-8 sanitization: high. Meaning of the integer/string, exact
response envelope/payload length, retries, and provisioning lifecycle remain
unresolved.

## `system/setAlgoKey` (sub-command 0x0c)

**Recovered/proven:**

- `BleRing1CmdGoMoreExt.setAlgoKey` at AOT `0x1b0d02c` takes a numeric first
  argument and a string-like second argument, stores them in
  `BleRing1SetAlgoKey`, serializes through the shared algo-key `toBytes` at
  `0x1b0cf2c`, and calls `sendCmd` at `0x1b0d0c4` with the system command/module
  and sub-command object mapping to 0x0c. It explicitly passes the serialized
  value as `data` and selects **SET/0x01**, distinct from the GET method.
- `BleRing1SetAlgoKey.toBytes` delegates to `BleRing1GetAlgoKey.toBytes`.
  That serializer creates a list beginning with the integer field as one byte,
  then appends `StringExt.toUint8List()` of the string field. `toUint8List`
  directly applies Dart `Utf8Encoder.convert`. Hence the data shape is **one
  integer byte followed by variable-length UTF-8 string bytes**; the exact
  accepted integer range and total key length are not established by this static
  path.
- The wrapper awaits the shared result and returns its boolean-like response
  field. The AOT shows no local retry, rollback, persistence, or confirmation
  parsing beyond that shared response/status machinery.
- Existing Hermes safety notes classify 0x0c as a provisioning mutator and keep
  it blocklisted. This safety classification remains mandatory and is
  independent of the recovered payload shape.

**Not proven:** cryptographic meaning, key derivation, valid ranges, response
payload/ACK enum, persistence semantics, retries,
rollback, error mapping, and whether 0x0b precedes or follows 0x0c in any
first-time provisioning flow.

**Confidence:** command direction/status, mutating call site, serializer order,
and UTF-8 encoding: high. Semantic key meaning and lifecycle/ACK behavior: low.

## Bounded lifecycle and safety conclusion

Static evidence supports only this bounded reconstruction:

1. A Ring1 session/transport is needed for the shared `sendCmd` path.
2. The glasses host identity must provide two complete six-byte values before
   `advStart`; the wrapper may skip it otherwise.
3. `getAlgoKeyStatus` is an empty-data **GET/0x00** query that parses a guarded
   response. In the recovered `HomeController` call site, the awaited result is
   inspected: only the guarded model state equal to one enters an authenticated
   API lookup using the decoded response string; only a successful, non-empty
   returned value reaches the awaited `setAlgoKey` call. Null, failure, and
   non-matching-state branches skip the mutation. This proves a bounded caller
   sequence and external-service prerequisite for that path, not a complete
   first-time provisioning lifecycle. `setAlgoKey` is a separate
   data-bearing **SET/0x01** mutator. Persistence, retry policy, ACK semantics,
   and relationship to `advStart` outside this controller path remain unknown.

Keep 0x0a and 0x0c blocklisted and do not send 0x0b speculatively: even a query
can have undocumented prerequisites or expose sensitive state. Closing the
remaining gaps requires an authorized, isolated Even-app trace correlated with
these call sites, while redacting credentials and personal identifiers. This
report remains intelligence-only; no provisioning or ring mutation was done.