import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../app/agent-cockpit/protocol.ts", import.meta.url), "utf8");
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
}).outputText;
const { AgentCockpitStore, COCKPIT_PERMISSION_DETAIL_MAX_SCALARS, cockpitInteractionFingerprint, validateCockpitFrame } = await import(
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
    snapshot(1, { pending: [{ request_id: "request_question_1", nonce: "nonce_question_123", kind: "question",
      title: "W".repeat(65), expires_at_ms: 5_000,
      choices: [{ id: "choice_question_123", label: "Answer" }] }] }),
    snapshot(1, { pending: [{ request_id: "req_1234567890", nonce: "nonce_1234567890", kind: "permission", title: "Run", expires_at_ms: 5_000, action: "shell", target: "*", effect: "arbitrary", choices: ["allow_always"] }] }),
    { ...snapshot(), sessions: Array.from({ length: 9 }, (_, index) => ({
      ...session, session_id: `session_limit_${String(index).padStart(4, "0")}`,
    })) },
    { ...snapshot(), sessions: [session, { ...session }] },
  ]) assert.ok(validateCockpitFrame(bad), JSON.stringify(bad));
  assert.equal(validateCockpitFrame(snapshot(1, { pending: [{ request_id: "request_text_12345", nonce: "nonce_text_123456", kind: "text_question",
    title: "Open text?", expires_at_ms: 5_000, max_length: 64 }] })), null);
  assert.match(validateCockpitFrame(snapshot(1, { pending: [{ request_id: "request_text_12345", nonce: "nonce_text_123456", kind: "text_question",
    title: "Open text?", expires_at_ms: 5_000, max_length: 65 }] })), /invalid snapshot/,
  "the canonical projection schema rejects a free-text limit beyond the fully reviewable 64 scalars");
  for (const unsafe of ["\u061c", "\u200e", "\u200f", "\u2028", "\u2029"]) {
    assert.ok(validateCockpitFrame(snapshot(1, { title: `Unsafe${unsafe}title` })),
      `U+${unsafe.codePointAt(0).toString(16)} must be rejected`);
  }

  const permission = {
    request_id: "request_permission_1", nonce: "nonce_permission_123", kind: "permission",
    title: "Exact permission", expires_at_ms: 5_000, action: "read_file",
    target: "W".repeat(COCKPIT_PERMISSION_DETAIL_MAX_SCALARS),
    effect: "W".repeat(COCKPIT_PERMISSION_DETAIL_MAX_SCALARS), choices: ["deny", "allow_once"],
  };
  assert.equal(validateCockpitFrame(snapshot(1, { pending: [permission] })), null);
  assert.ok(validateCockpitFrame(snapshot(1, { pending: [{ ...permission, target: `${permission.target}W` }] })),
    "a decisive suffix beyond the proven lens capacity is rejected");
  assert.ok(validateCockpitFrame(snapshot(1, { pending: [{ ...permission, effect: "Café" }] })),
    "permission details outside the pixel-proven printable subset are rejected");
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

test("a reused request id cannot retarget a reviewed answer or permission", () => {
  const store = new AgentCockpitStore({ now: () => 2_000, createCommandId: () => "command_review_bound_1" });
  store.apply(snapshot());
  const original = {
    request_id: "request_reused_1234", nonce: "nonce_original_1234", kind: "question",
    title: "Choose target", expires_at_ms: 5_000,
    choices: [{ id: "choice_same_123456", label: "Staging" }],
  };
  store.apply({
    v: 1, chan: "cockpit", type: "interaction_open", sequence: 2,
    session_id: session.session_id, generation: 7, revision: 2, request: original,
  });
  const fingerprint = cockpitInteractionFingerprint(original);
  store.apply({
    v: 1, chan: "cockpit", type: "interaction_open", sequence: 3,
    session_id: session.session_id, generation: 7, revision: 3,
    request: { ...original, nonce: "nonce_replaced_123", title: "Choose production" },
  });
  assert.equal(store.prepareAnswer(session.session_id, 7, original.request_id, "choice_same_123456",
    original.nonce, fingerprint), null,
  "the action authority independently rejects a nonce or exact-projection replacement");
});

test("actions are exact-generation one-shot and stale, replayed, expired, or offline taps fail closed", () => {
  let now = 2_000;
  const store = new AgentCockpitStore({ now: () => now, createCommandId: () => "command_1234567890" });
  store.apply(snapshot());
  const reviewedPermission = {
    request_id: "req_1234567890", nonce: "nonce_1234567890", kind: "permission",
    title: "Read one file", expires_at_ms: 3_000,
    action: "read_file", target: "README.md", effect: "Read one bounded repository file",
    choices: ["deny", "allow_once"],
  };
  store.apply({
    v: 1, chan: "cockpit", type: "interaction_open", sequence: 2,
    session_id: session.session_id, generation: 7, revision: 2,
    request: reviewedPermission,
  });
  const review = [reviewedPermission.nonce, cockpitInteractionFingerprint(reviewedPermission)];
  const command = store.preparePermissionDecision(session.session_id, 7, "req_1234567890", "allow_once", ...review);
  assert.equal(command?.type, "permission_decide");
  assert.equal(store.preparePermissionDecision(session.session_id, 7, "req_1234567890", "allow_once", ...review), null, "late double tap dedupes");
  store.markDisconnected();
  assert.equal(store.prepareInterrupt(session.session_id, 7), null);
  store.apply(snapshot(1));
  assert.equal(store.prepareInterrupt(session.session_id, 6), null);
  now = 4_000;
  assert.equal(store.preparePermissionDecision(session.session_id, 7, "req_1234567890", "deny", ...review), null);
});

test("free-text Cockpit answers stay bound to the reviewed request", () => {
  const store = new AgentCockpitStore({ now: () => 2_000, createCommandId: () => "command_text_123456" });
  const request = {
    request_id: "request_text_12345", nonce: "nonce_text_123456", kind: "text_question",
    title: "What should Hermes do?", expires_at_ms: 5_000, max_length: 64,
  };
  assert.equal(store.apply(snapshot(1, { pending: [request], state: "waiting_human" })), true);
  const review = [request.nonce, cockpitInteractionFingerprint(request)];
  assert.equal(store.prepareAnswerText(session.session_id, 7, request.request_id,
    "W".repeat(65), ...review), null, "an answer suffix hidden by the lens cannot be submitted");
  assert.equal(store.prepareAnswerText(session.session_id, 7, request.request_id,
    "Unicode café", ...review), null, "reviewed answers stay inside the proven lens glyph contract");
  const command = store.prepareAnswerText(session.session_id, 7, request.request_id,
    "Run focused tests", ...review);
  assert.equal(command?.type, "answer_text");
  assert.equal(command?.text, "Run focused tests");
  assert.equal(store.prepareAnswerText(session.session_id, 7, request.request_id, "retry", ...review), null,
    "a text answer is one-shot until a later authoritative snapshot");
});

test("interrupt and steering bind to current live generation and receipts control visible completion", () => {
  const ids = ["command_steer_1234", "command_stop_12345"];
  const store = new AgentCockpitStore({ createCommandId: () => ids.shift() });
  store.apply(snapshot());
  assert.equal(store.prepareSteer(session.session_id, 7, "W".repeat(65)), null,
    "steering cannot carry a suffix beyond the fully rendered review bound");
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

test("an exact receipt remains terminal when a newer snapshot overtakes it", () => {
  const store = new AgentCockpitStore({ createCommandId: () => "command_overtaken_1234" });
  store.apply(snapshot());
  const command = store.prepareSteer(session.session_id, 7, "Keep the exact request correlated");
  assert.ok(command);
  assert.equal(store.apply(snapshot(3, { revision: 2 })), true);
  assert.equal(store.apply({
    v: 1, chan: "cockpit", type: "command_receipt", sequence: 2,
    command_id: command.command_id, session_id: session.session_id, generation: 7,
    outcome: "accepted",
  }), true);
  assert.equal(store.snapshot().synchronized, true);
  assert.equal(store.snapshot().sequence, 3);
  assert.deepEqual(store.snapshot().lastReceipt, {
    commandId: command.command_id, sessionId: session.session_id, generation: 7, outcome: "accepted",
  });
});

test("a correlated sequence jump settles the command, fails closed, and unlocks only after a snapshot", () => {
  const ids = ["command_gap_first_123", "command_gap_retry_123"];
  const store = new AgentCockpitStore({ createCommandId: () => ids.shift() });
  store.apply(snapshot());
  const command = store.prepareInterrupt(session.session_id, 7);
  assert.ok(command);
  assert.equal(store.apply({
    v: 1, chan: "cockpit", type: "command_receipt", sequence: 4,
    command_id: command.command_id, session_id: session.session_id, generation: 7,
    outcome: "rejected", code: "backend_busy",
  }), false, "a skipped projection sequence requires a full reread");
  assert.equal(store.snapshot().synchronized, false);
  assert.equal(store.snapshot().lastReceipt?.commandId, command.command_id);
  assert.equal(store.prepareInterrupt(session.session_id, 7), null);
  assert.equal(store.apply(snapshot(4)), true);
  assert.equal(store.prepareInterrupt(session.session_id, 7)?.command_id, "command_gap_retry_123");
});

test("unknown and disconnected command reservations survive until authoritative replacement", () => {
  const ids = ["command_unknown_12345", "command_after_sync_123"];
  const store = new AgentCockpitStore({ createCommandId: () => ids.shift() });
  store.apply(snapshot());
  const command = store.prepareInterrupt(session.session_id, 7);
  assert.ok(command);
  assert.equal(store.recordCommandOutcome({
    commandId: command.command_id,
    sessionId: session.session_id,
    generation: 7,
    outcome: "outcome_unknown",
    code: "connection_closed",
  }, { minimumSnapshotReadEpoch: 2 }), true);
  assert.equal(store.prepareInterrupt(session.session_id, 7), null,
    "an ambiguous transport outcome is never rolled back immediately");
  store.markDisconnected();
  assert.equal(store.apply(snapshot(8), 2), true);
  assert.equal(store.prepareInterrupt(session.session_id, 7)?.command_id, "command_after_sync_123");
});

test("a delayed pre-command snapshot cannot roll sequence back or unlock a receipt", () => {
  const ids = ["command_race_first_123", "command_race_retry_123"];
  const store = new AgentCockpitStore({ createCommandId: () => ids.shift() });
  assert.equal(store.apply(snapshot(10)), true);
  const command = store.prepareInterrupt(session.session_id, 7);
  assert.ok(command);
  assert.equal(store.apply({
    v: 1, chan: "cockpit", type: "command_receipt", sequence: 11,
    command_id: command.command_id, session_id: session.session_id, generation: 7,
    outcome: "accepted",
  }), true);

  assert.equal(store.apply(snapshot(10)), false, "the delayed pre-command snapshot is stale");
  assert.equal(store.snapshot().sequence, 11, "authority sequence never rolls back");
  assert.equal(store.prepareInterrupt(session.session_id, 7), null,
    "rejection cannot clear the one-shot reservation");

  assert.equal(store.apply(snapshot(11)), true);
  assert.equal(store.prepareInterrupt(session.session_id, 7)?.command_id, "command_race_retry_123",
    "only a snapshot at or beyond the receipt can unlock review");
});

test("an already-in-flight snapshot cannot reconcile an outcome_unknown", () => {
  const ids = ["command_epoch_first_12", "command_epoch_retry_12"];
  const store = new AgentCockpitStore({ createCommandId: () => ids.shift() });
  assert.equal(store.apply(snapshot(10), 1), true);
  const command = store.prepareInterrupt(session.session_id, 7);
  assert.ok(command);
  assert.equal(store.recordCommandOutcome({
    commandId: command.command_id,
    sessionId: session.session_id,
    generation: 7,
    outcome: "outcome_unknown",
    code: "receipt_timeout",
  }, { minimumSnapshotReadEpoch: 2 }), true);
  store.markDisconnected();

  assert.equal(store.apply(snapshot(10), 1), true, "the identical stale read may restore projection only");
  assert.equal(store.prepareInterrupt(session.session_id, 7), null,
    "a read issued before the outcome cannot unlock mutation");
  assert.equal(store.apply(snapshot(10), 2), true, "the post-outcome reread is authoritative proof");
  assert.equal(store.prepareInterrupt(session.session_id, 7)?.command_id, "command_epoch_retry_12");
});

test("an unknown receipt survives disconnect to settle UI but not a replacement Host MCP generation", () => {
  const store = new AgentCockpitStore({ createCommandId: () => "command_retired_receipt_1" });
  store.apply(snapshot());
  const command = store.prepareInterrupt(session.session_id, 7);
  assert.ok(command);
  assert.equal(store.recordCommandOutcome({
    commandId: command.command_id,
    sessionId: session.session_id,
    generation: 7,
    outcome: "outcome_unknown",
    code: "connection_closed",
  }), true);
  store.markDisconnected();
  assert.equal(store.snapshot().lastReceipt?.commandId, command.command_id,
    "the submitting view can still observe its terminal ambiguous outcome");

  assert.equal(store.apply({
    ...snapshot(1),
    connection_generation: "connection_replacement_123456",
  }), true);
  assert.equal(store.snapshot().lastReceipt, null,
    "a fresh authoritative generation cannot display the retired connection's receipt");
});

test("a command id awaiting snapshot reconciliation cannot be reused", () => {
  const store = new AgentCockpitStore({ createCommandId: () => "command_collision_1234" });
  store.apply(snapshot());
  const command = store.prepareInterrupt(session.session_id, 7);
  assert.ok(command);
  assert.equal(store.apply({
    v: 1, chan: "cockpit", type: "command_receipt", sequence: 2,
    command_id: command.command_id, session_id: session.session_id, generation: 7,
    outcome: "rejected", code: "backend_busy",
  }), true);
  assert.equal(store.prepareSteer(session.session_id, 7, "Must use a fresh identity"), null);
  assert.equal(store.snapshot().lastReceipt?.commandId, command.command_id);
});
