# Debug-only ADB control harness

This is the maintained contract for Hermes G2's authorised-device automation
harness. It does not define product status or expand the supported owner surface.

## Boundary

Debug APKs expose a narrow ordered-broadcast receiver. The receiver exists only
in Android's `debug` source set, requires the signature-level
`android.permission.DUMP` permission held by the ADB shell, and checks
`BuildConfig.DEBUG` at runtime. Release APKs must contain neither
`FaceclawDebugControlReceiver`, `com.faceclaw.app.DEBUG_CONTROL_V1`,
`android.permission.DUMP`, nor the JavaScript control implementation.

The allowlist is limited to display wake/blank, fixed launcher app IDs, and two
procedural voice fixtures. It deliberately exposes no clicks, scrolls, long
presses, wakewords, arbitrary intents, shell, paths, URLs, keycodes, PCM, files,
transcripts, tokens, or credentials.

## Protocol

The host command reads exactly one version-1 JSON envelope from stdin and writes
exactly one JSON receipt to stdout:

```bash
printf '%s\n' '{"v":1,"id":"query-1","command":"state","args":{}}' \
  | node scripts/hermes-g2-debug-control.mjs
```

The initial state receipt supplies the process, session, window, and capture
generations required by every mutation. Stale generations, duplicate IDs,
malformed fields, offline G2 state, and invalid fixture state fail closed.
Mutation IDs remain tombstoned for the connected debug session; query churn
cannot evict them and a full ledger rejects further mutations.

Receipts contain bounded state and `empty`/`nonempty` transcript classes only.
Procedural fixtures are generated in memory, traverse the production endpoint
detector and Moonshine recognizer, and are neither logged nor persisted.

The command selects the sole authorised online ADB target. If more than one
target is visible, select one exact serial:

```bash
HERMES_G2_ADB_SERIAL='192.0.2.10:37123' \
  node scripts/hermes-g2-debug-control.mjs < request.json
# Equivalent when ANDROID_SERIAL is unset:
node scripts/hermes-g2-debug-control.mjs --serial '192.0.2.10:37123' < request.json
```

## Verification

```bash
node --test tests/debug-control.test.mjs \
  tests/debug-control-android.test.mjs \
  tests/debug-control-cli.test.mjs
npm run verify:release-unsigned
```

`verify:release-unsigned` builds the production bundle and Gradle release variant
under the narrowly scoped `hermesUnsignedReleaseVerification=true` property. The
result is unsigned verification evidence, not an install or publication
artifact. The property permits only the exact verification task; ordinary
release tasks require the four real NativeScript signing properties.

Production verification rejects the receiver/action/permission, the control
protocol's stable strings in app bundles, v1 signature entries, and every byte
gap before the ZIP central directory. Protected signing then repeats the
surface, debuggability, and exact-one-signer checks without checking out or
executing repository code beside credentials. See
[`release-security.md`](release-security.md) for the permanent release contract.
