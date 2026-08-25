import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../app/agent-cockpit/protocol.ts", import.meta.url), "utf8");
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
}).outputText;
const { AgentCockpitStore, validateCockpitFrame } = await import(
  "data:text/javascript;base64," + Buffer.from(js).toString("base64")
);

const session = {
  session_id: "session_1234567890",
  generation: 7,
  revision: 1,
  title: "Fix CI",
  state: "running",
  updated_at_ms: 1_000,
  timeline: [{ id: "row_1234567890", kind: "tool", text: "search_files · 12 hits", status: "done" }],
  pending: [],
};

function snapshot(sequence = 1, overrides = {}) {
  return {
    v: 1,
    chan: "cockpit",
    type: "snapshot",
    connection_generation: "connection_123456",
    sequence,
    sessions: [{ ...session, ...overrides }],
  };
}

test("cockpit protocol accepts bounded provider-neutral snapshots and rejects private or executable payloads", () => {
  assert.equal(validateCockpitFrame(snapshot()), null);
  for (const bad of [
    { ...snapshot(), v: 2 },
    { ...snapshot(), prompt: "private prompt" },
    snapshot(1, { timeline: [{ id: "row_1234567890", kind: "tool", text: "search", status: "done", arguments: { path: "/secret" } }] }),
    snapshot(1, { title: "<script>approve()</script>" }),
    snapshot(1, { title: "x".repeat(161) }),
    snapshot(1, { pending: [{ request_id: "req_1234567890", nonce: "nonce_1234567890", kind: "permission", title: "Run", expires_at_ms: 5_000, action: "shell", target: "*", effect: "arbitrary", choices: ["allow_always"] }] }),
  ]) assert.ok(validateCockpitFrame(bad), JSON.stringify(bad));
});

test("store discards tool rows while preserving snapshot and incremental sequencing", () => {
  const store = new AgentCockpitStore();
  assert.equal(store.apply(snapshot(10, {
    revision: 4,
    timeline: [
      { id: "row_tool_snapshot_1", kind: "tool", text: "search_files · running", status: "running" },
      { id: "row_assistant_1234", kind: "assistant", text: "First final result", status: "done" },
    ],
  })), true);
  let current = store.snapshot();
  assert.equal(current.sequence, 10);
  assert.equal(current.sessions[0].revision, 4);
  assert.deepEqual(current.sessions[0].timeline.map((row) => row.kind), ["assistant"]);

  assert.equal(store.apply({
    v: 1, chan: "cockpit", type: "timeline_append", sequence: 11,
    session_id: session.session_id, generation: 7, revision: 5,
    row: { id: "row_tool_increment_1", kind: "tool", text: "read_file · done", status: "done" },
  }), true);
  current = store.snapshot();
  assert.equal(current.synchronized, true);
  assert.equal(current.sequence, 11);
  assert.equal(current.sessions[0].revision, 5);
  assert.deepEqual(current.sessions[0].timeline.map((row) => row.text), ["First final result"]);

  assert.equal(store.apply({
    v: 1, chan: "cockpit", type: "timeline_append", sequence: 12,
    session_id: session.session_id, generation: 7, revision: 6,
    row: { id: "row_assistant_5678", kind: "assistant", text: "Second final result", status: "done" },
  }), true);
  current = store.snapshot();
  assert.equal(current.sequence, 12);
  assert.equal(current.sessions[0].revision, 6);
  assert.deepEqual(current.sessions[0].timeline.map((row) => row.text), ["First final result", "Second final result"]);
});

test("snapshot and contiguous events build active work without hidden session discovery", () => {
  const store = new AgentCockpitStore();
  assert.equal(store.apply(snapshot()), true);
  assert.equal(store.snapshot().sessions.length, 1);
  assert.equal(store.apply({
    v: 1, chan: "cockpit", type: "session_state", sequence: 2,
    session_id: session.session_id, generation: 7, revision: 2,
    state: "waiting_human", updated_at_ms: 2_000,
  }), true);
  assert.equal(store.snapshot().sessions[0].state, "waiting_human");
  assert.equal(store.apply({
    v: 1, chan: "cockpit", type: "session_state", sequence: 4,
    session_id: session.session_id, generation: 7, revision: 3,
    state: "running", updated_at_ms: 3_000,
  }), false, "sequence gaps fail closed");
  assert.equal(store.snapshot().synchronized, false);
});

test("duplicate prompts dedupe and requests answered elsewhere retire exact pending input", () => {
  const store = new AgentCockpitStore();
  store.apply(snapshot());
  const opened = {
    v: 1, chan: "cockpit", type: "interaction_open", sequence: 2,
    session_id: session.session_id, generation: 7, revision: 2,
    request: {
      request_id: "req_1234567890", nonce: "nonce_1234567890", kind: "question",
      title: "Choose test target", expires_at_ms: 9_000,
      choices: [{ id: "choice_unit_1234", label: "Unit tests" }, { id: "choice_full_1234", label: "Full suite" }],
    },
  };
  assert.equal(store.apply(opened), true);
  assert.equal(store.apply({ ...opened, sequence: 3, revision: 3 }), true);
  assert.equal(store.snapshot().sessions[0].pending.length, 1);
  assert.equal(store.apply({
    v: 1, chan: "cockpit", type: "interaction_closed", sequence: 4,
    session_id: session.session_id, generation: 7, revision: 4,
    request_id: "req_1234567890", reason: "answered_elsewhere",
  }), true);
  assert.equal(store.snapshot().sessions[0].pending.length, 0);
});

test("actions are exact-generation one-shot and stale, replayed, expired, or offline taps fail closed", () => {
  let now = 2_000;
  const store = new AgentCockpitStore({ now: () => now, createCommandId: () => "command_1234567890" });
  store.apply(snapshot());
  store.apply({
    v: 1, chan: "cockpit", type: "interaction_open", sequence: 2,
    session_id: session.session_id, generation: 7, revision: 2,
    request: {
      request_id: "req_1234567890", nonce: "nonce_1234567890", kind: "permission",
      title: "Read one file", expires_at_ms: 3_000,
      action: "read_file", target: "README.md", effect: "Read one bounded repository file",
      choices: ["deny", "allow_once"],
    },
  });
  const command = store.preparePermissionDecision(session.session_id, 7, "req_1234567890", "allow_once");
  assert.equal(command?.type, "permission_decide");
  assert.equal(store.preparePermissionDecision(session.session_id, 7, "req_1234567890", "allow_once"), null, "late double tap dedupes");
  store.markDisconnected();
  assert.equal(store.prepareInterrupt(session.session_id, 7), null);
  store.apply(snapshot(1));
  assert.equal(store.prepareInterrupt(session.session_id, 6), null);
  now = 4_000;
  assert.equal(store.preparePermissionDecision(session.session_id, 7, "req_1234567890", "deny"), null);
});

test("interrupt and steering bind to current live generation and receipts control visible completion", () => {
  const ids = ["command_steer_1234", "command_stop_12345"];
  const store = new AgentCockpitStore({ createCommandId: () => ids.shift() });
  store.apply(snapshot());
  assert.deepEqual(store.prepareSteer(session.session_id, 7, "Run only the focused test"), {
    v: 1, chan: "cockpit", type: "steer", command_id: "command_steer_1234",
    connection_generation: "connection_123456",
    session_id: session.session_id, generation: 7, text: "Run only the focused test",
  });
  assert.equal(store.snapshot().sessions[0].state, "running", "socket intent is not an acknowledgement");
  assert.equal(store.apply({
    v: 1, chan: "cockpit", type: "command_receipt", sequence: 2,
    command_id: "command_steer_1234", session_id: session.session_id, generation: 7,
    outcome: "accepted",
  }), true);
  assert.equal(store.prepareInterrupt(session.session_id, 7)?.command_id, "command_stop_12345");
  assert.equal(store.apply({
    v: 1, chan: "cockpit", type: "session_state", sequence: 3,
    session_id: session.session_id, generation: 7, revision: 2,
    state: "interrupted", updated_at_ms: 3_000, summary: "Stopped by wearer",
  }), true);
  assert.equal(store.prepareSteer(session.session_id, 7, "too late"), null);
});
