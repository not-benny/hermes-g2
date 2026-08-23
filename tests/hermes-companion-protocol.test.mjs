import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const transpile = (source) => ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
}).outputText;
const source = readFileSync(new URL("../app/hermes-companion/protocol.ts", import.meta.url), "utf8");
const { HermesCompanionStore, validateHermesCompanionFrame } = await import(
  "data:text/javascript;base64," + Buffer.from(transpile(source)).toString("base64")
);

const snapshot = {
  v: 1, chan: "companion", type: "snapshot", connection_generation: "connection_phone_1234",
  sequence: 1, generated_at_ms: 1_000, status: "ready", model: "hermes-model", profile: "default",
  last_connected_at_ms: 900,
  capabilities: { voice: true, usage: true, cost: true, tool_activity: true },
  sessions: [
    { session_id: "session_active_1234", generation: 5, title: "Active task", state: "active", updated_at_ms: 980, resumable: false },
    { session_id: "session_done_12345", generation: 8, title: "Finished task", state: "completed", updated_at_ms: 800, resumable: true },
  ],
  voice: { utterance_count: 4, audio_ms: 12_000, stt_provider: "local-stt", capture_state: "idle",
    recent_failures: [{ id: "error_voice_12345", at_ms: 700, code: "stt_timeout", summary: "Speech capture timed out" }] },
  usage: {
    day: { input_tokens: 10, output_tokens: 20, total_tokens: 30, cost_micros: 400, currency: "GBP" },
    seven_days: { input_tokens: 100, output_tokens: 200, total_tokens: 300, cost_micros: 4_000, currency: "GBP" },
  },
  tool_activity: [{ activity_id: "activity_tool_1234", label: "read file", status: "done", updated_at_ms: 990 }],
  recent_errors: [],
};

test("strict companion snapshot accepts only capability-consistent redacted projections", () => {
  assert.equal(validateHermesCompanionFrame(snapshot), null);
  assert.match(validateHermesCompanionFrame({ ...snapshot, prompt: "private prompt" }), /invalid snapshot/);
  assert.match(validateHermesCompanionFrame({ ...snapshot, sessions: [{ ...snapshot.sessions[0], raw_payload: { token: "secret" } }] }), /invalid snapshot/);
  assert.match(validateHermesCompanionFrame({ ...snapshot, capabilities: { ...snapshot.capabilities, voice: false } }), /invalid snapshot/);
  assert.match(validateHermesCompanionFrame({ ...snapshot,
    usage: { ...snapshot.usage, day: { ...snapshot.usage.day, total_tokens: 999 } } }), /invalid snapshot/);
  assert.match(validateHermesCompanionFrame({ ...snapshot, model: "<script>" }), /invalid snapshot/);
});

test("operations are exact-generation, explicit, and single-flight", () => {
  let serial = 0;
  const store = new HermesCompanionStore({ now: () => 1_100,
    createOperationId: () => `operation_test_${++serial}_1234` });
  assert.equal(store.apply(snapshot), true);
  const cancel = store.prepareCancel("session_active_1234", 5);
  assert.equal(cancel.type, "cancel_session");
  assert.equal(cancel.connection_generation, "connection_phone_1234");
  assert.equal(store.prepareCancel("session_active_1234", 5), null, "a duplicate tap is inert while pending");
  assert.equal(store.prepareCancel("session_active_1234", 4), null, "stale session generations are inert");
  assert.equal(store.prepareResume("session_active_1234", 5), null);
  const resume = store.prepareResume("session_done_12345", 8);
  assert.equal(resume.type, "resume_session");
  assert.equal(store.prepareOpen("session_done_12345", 8).type, "open_session");
  assert.equal(store.prepareNewVoiceSession().type, "new_voice_session");

  assert.equal(store.apply({ v: 1, chan: "companion", type: "operation_receipt",
    connection_generation: "connection_phone_1234", sequence: 2, operation_id: cancel.operation_id,
    operation: "cancel_session", outcome: "accepted" }), true);
  assert.equal(store.prepareCancel("session_active_1234", 5).type, "cancel_session");
  const replay = { v: 1, chan: "companion", type: "operation_receipt",
    connection_generation: "connection_phone_1234", sequence: 3, operation_id: cancel.operation_id,
    operation: "cancel_session", outcome: "duplicate", code: "duplicate" };
  assert.equal(store.apply(replay), true, "a server-side replay advances deterministically without repeating intent");
  assert.equal(store.apply(replay), true, "an exact transport duplicate is idempotent");
  assert.equal(store.snapshot().synchronized, true);
});

test("offline, stale, sequence-gap, and reconnect behavior fail closed without replay", () => {
  let serial = 0;
  let now = 1_100;
  const store = new HermesCompanionStore({ now: () => now,
    createOperationId: () => `operation_state_${++serial}_1234` });
  store.apply(snapshot);
  assert.ok(store.prepareNewVoiceSession());
  store.markDisconnected();
  assert.equal(store.snapshot().data.sessions.length, 2, "last safe projection remains available for offline display");
  assert.equal(store.prepareNewVoiceSession(), null);
  assert.equal(store.prepareOpen("session_active_1234", 5), null);

  assert.equal(store.apply({ ...snapshot, connection_generation: "connection_phone_5678", sequence: 1 }), true);
  assert.deepEqual(store.snapshot().pendingOperations, [], "old-connection operations are never replayed");
  now = 1_000 + 2 * 60_000 + 1;
  assert.equal(store.prepareNewVoiceSession(), null, "expired snapshots cannot authorize mutations");
  assert.ok(store.prepareRefresh(), "refresh remains available to recover stale data");
  assert.equal(store.apply({ v: 1, chan: "companion", type: "operation_receipt",
    connection_generation: "connection_phone_5678", sequence: 99, operation_id: store.snapshot().pendingOperations[0],
    operation: "refresh", outcome: "accepted" }), false);
  assert.equal(store.snapshot().synchronized, false);
});

test("a bounded refresh can recover a desynchronized live generation without authorizing mutations", () => {
  let serial = 0;
  const store = new HermesCompanionStore({ now: () => 1_100,
    createOperationId: () => `operation_recover_${++serial}_1234` });
  store.apply(snapshot);
  assert.equal(store.apply({ v: 1, chan: "companion", type: "operation_receipt",
    connection_generation: "connection_phone_1234", sequence: 2, operation_id: "operation_unknown_1234",
    operation: "refresh", outcome: "accepted" }), false);
  assert.equal(store.prepareNewVoiceSession(), null);
  const refresh = store.prepareRefresh();
  assert.equal(refresh.type, "refresh");
  assert.equal(store.apply({ ...snapshot, sequence: 3, generated_at_ms: 1_100 }), true);
  assert.equal(store.apply({ v: 1, chan: "companion", type: "operation_receipt",
    connection_generation: "connection_phone_1234", sequence: 4, operation_id: refresh.operation_id,
    operation: "refresh", outcome: "accepted" }), true);
  assert.equal(store.snapshot().synchronized, true);
});
