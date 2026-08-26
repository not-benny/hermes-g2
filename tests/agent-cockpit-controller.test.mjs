import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const transpile = (source) => ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
}).outputText;
const protocolUrl = "data:text/javascript;base64," + Buffer.from(transpile(
  readFileSync(new URL("../app/agent-cockpit/protocol.ts", import.meta.url), "utf8"),
)).toString("base64");
const controllerSource = readFileSync(new URL("../app/agent-cockpit/controller.ts", import.meta.url), "utf8")
  .replace('"./protocol"', JSON.stringify(protocolUrl));
const { AgentCockpitController } = await import(
  "data:text/javascript;base64," + Buffer.from(transpile(controllerSource)).toString("base64")
);
const { cockpitInteractionFingerprint } = await import(protocolUrl);

const session = {
  session_id: "session_1234567890", generation: 4, revision: 1, title: "Disposable task",
  state: "running", updated_at_ms: 1000, timeline: [], pending: [],
};
const snapshot = { v: 1, chan: "cockpit", type: "snapshot", connection_generation: "connection_123456", sequence: 1, sessions: [session] };
const status = {
  connectionGeneration: snapshot.connection_generation,
  voiceTurnState: "idle",
  commandsAvailable: true,
};

function synchronize(controller, frame = snapshot) {
  assert.equal(controller.handleMcpStatus({ ...status, connectionGeneration: frame.connection_generation }), true);
  assert.equal(controller.handleFrame(frame), true);
}

test("controller publishes only validated synchronized projections", () => {
  const sent = [];
  const changes = [];
  const controller = new AgentCockpitController((command) => sent.push(command), {
    createCommandId: () => "command_1234567890",
  });
  controller.onChange((state) => changes.push(state));
  synchronize(controller);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].sessions[0].title, "Disposable task");
  assert.equal(controller.handleFrame({ ...snapshot, secret: "sentinel-private" }), false);
  assert.equal(changes.length, 2);
  assert.equal(changes.at(-1).synchronized, false);
  assert.deepEqual(sent, []);
});

test("assistant terminal rows remain a passive Cockpit projection", () => {
  const controller = new AgentCockpitController(() => {}, {
    createCommandId: () => "command_1234567890",
  });
  assert.equal(controller.onAssistantResult, undefined,
    "Cockpit must not expose a second wearer-facing completion channel");
  synchronize(controller);

  assert.equal(controller.handleFrame({
    v: 1, chan: "cockpit", type: "timeline_append", sequence: 2,
    session_id: session.session_id, generation: 4, revision: 2,
    row: { id: "timeline_tool_1234", kind: "tool", text: "private_tool · done", status: "done" },
  }), true);

  assert.equal(controller.handleFrame({
    v: 1, chan: "cockpit", type: "timeline_append", sequence: 3,
    session_id: session.session_id, generation: 4, revision: 3,
    row: { id: "timeline_answer_1234", kind: "assistant", text: "Focused tests pass", status: "done" },
  }), true);
  assert.deepEqual(controller.snapshot().sessions[0].timeline, [
    { id: "timeline_answer_1234", kind: "assistant", text: "Focused tests pass", status: "done" },
  ], "the final remains visible only inside the synchronized Cockpit app");

  assert.equal(controller.handleFrame({
    v: 1, chan: "cockpit", type: "timeline_append", sequence: 4,
    session_id: session.session_id, generation: 4, revision: 4,
    row: { id: "timeline_answer_1234", kind: "assistant", text: "Focused tests pass", status: "done" },
  }), true);
  assert.equal(controller.snapshot().sessions[0].timeline.length, 1,
    "same row identity remains deduplicated inside the projection");
});

test("disconnect clears authority and reconnect snapshot never replays queued actions", () => {
  const sent = [];
  const controller = new AgentCockpitController((command) => sent.push(command), {
    createCommandId: () => `command_${sent.length}_1234567890`,
  });
  synchronize(controller);
  assert.equal(controller.steer(session.session_id, 4, "Use focused tests"), "command_0_1234567890");
  assert.equal(sent.length, 1);
  controller.disconnect();
  assert.equal(controller.interrupt(session.session_id, 4), null);
  controller.handleMcpStatus(status);
  controller.handleFrame({ ...snapshot, sequence: 9 });
  assert.equal(sent.length, 1, "offline intent is never queued for reconnect");
});

test("a transport-rejected command fails closed instead of waiting forever for a receipt", () => {
  const changes = [];
  const controller = new AgentCockpitController(() => false, {
    createCommandId: () => "command_rejected_1234",
  });
  controller.onChange((state) => changes.push(state));
  synchronize(controller);
  assert.equal(controller.steer(session.session_id, 4, "Use focused tests"), null);
  assert.equal(controller.snapshot().synchronized, false);
  assert.equal(changes.at(-1).synchronized, false);
});

test("question answers and permission decisions send only store-issued exact handles", () => {
  const sent = [];
  let serial = 0;
  const controller = new AgentCockpitController((command) => sent.push(command), {
    createCommandId: () => `command_${++serial}_1234567890`, now: () => 1500,
  });
  const question = { request_id: "request_question_1234", nonce: "nonce_question_12345", kind: "question", title: "Target?",
    expires_at_ms: 3000, choices: [{ id: "choice_unit_12345", label: "Unit" }] };
  const permission = { request_id: "request_permission_1", nonce: "nonce_permission_123", kind: "permission", title: "Read?",
    expires_at_ms: 3000, action: "read_file", target: "README.md", effect: "Read one file", choices: ["deny", "allow_once"] };
  synchronize(controller, {
    ...snapshot,
    sessions: [{ ...session, state: "waiting_human", pending: [question, permission] }],
  });
  assert.equal(controller.answer(session.session_id, 4, question.request_id, "choice_unit_12345",
    question.nonce, cockpitInteractionFingerprint(question)), "command_1_1234567890");
  assert.equal(controller.decidePermission(session.session_id, 4, permission.request_id, "allow_once",
    permission.nonce, cockpitInteractionFingerprint(permission)), "command_2_1234567890");
  assert.deepEqual(sent.map((item) => item.type), ["answer", "permission_decide"]);
  assert.equal(controller.decidePermission(session.session_id, 4, permission.request_id, "allow_once",
    permission.nonce, cockpitInteractionFingerprint(permission)), null);
  assert.ok(sent.every((item) => item.generation === 4 && item.session_id === session.session_id));
});

test("Cockpit status is Host MCP-only and the legacy channel is inert", () => {
  const bridge = readFileSync(new URL("../app/assistant/bridge-client.ts", import.meta.url), "utf8");
  assert.match(bridge, /readonly cockpit = new AgentCockpitController/);
  assert.match(bridge, /capabilities: \["mcp", "host-mcp-v1", CONVERSATE_CUES_CAPABILITY, CONTEXTUAL_SUBJECT_CAPABILITY,\s*COCKPIT_FREE_TEXT_CAPABILITY\]/);
  assert.match(bridge, /case "cockpit":\s*\n\s*return; \/\/ Cockpit state is read only through Host MCP resources\./);
  assert.doesNotMatch(bridge, /legacyCockpitSupported/);
  assert.doesNotMatch(bridge, /chan: "cockpit"/);
  assert.match(bridge, /this\.cockpit\.disconnect\(\)/);
  assert.match(bridge, /refreshCockpit\(\): boolean/);
  assert.match(bridge, /requestResync: \(\) => this\.refreshCockpit\(\)/);
  assert.match(bridge, /onCockpitFrame: \(frame, snapshotReadEpoch\)[\s\S]*this\.cockpit\.handleFrame\(frame, snapshotReadEpoch\)/);
  assert.match(bridge, /onCockpitCommandOutcome: \(outcome, minimumSnapshotReadEpoch\)[\s\S]*this\.cockpit\.handleCommandOutcome\(outcome, minimumSnapshotReadEpoch\)/);
  assert.match(bridge, /onCockpitUnavailable: \(\) => this\.cockpit\.unavailable\(\)/);
  assert.doesNotMatch(bridge, /if \(!this\.cockpit\.handleFrame\(frame\)\) this\.cockpit\.disconnect\(\)/);
  assert.match(bridge, /return socket\.sendText\([\s\S]*chan: "host-mcp"[\s\S]*\) !== false/);
});

test("Host MCP health cannot erase or invent the separately fetched Cockpit projection", () => {
  const sent = [];
  const controller = new AgentCockpitController((command) => sent.push(command), {
    createCommandId: () => "command_status_gate_1",
  });
  assert.equal(controller.handleMcpStatus({
    connectionGeneration: "host_connection_0123456789abcdef0123456789abcdef",
    voiceTurnState: "idle",
    commandsAvailable: false,
  }), true);
  let state = controller.snapshot();
  assert.equal(state.synchronized, false);
  assert.deepEqual(state.sessions, []);
  assert.equal(controller.handleFrame({
    ...snapshot,
    connection_generation: "host_connection_0123456789abcdef0123456789abcdef",
  }), true);
  state = controller.snapshot();
  assert.equal(state.synchronized, true);
  assert.equal(state.sessions.length, 1);
  assert.equal(controller.interrupt(session.session_id, session.generation), null,
    "read-only Cockpit stays synchronized while mutations are disabled");
  assert.deepEqual(sent, []);
  assert.equal(controller.handleMcpStatus({
    connectionGeneration: "host_connection_0123456789abcdef0123456789abcdef",
    voiceTurnState: "idle",
    commandsAvailable: true,
  }), true);
  assert.equal(controller.interrupt(session.session_id, session.generation), "command_status_gate_1");
  assert.equal(sent.length, 1);
});

test("generation binding re-arms an authoritative reread after every rejected snapshot", () => {
  const refreshes = [];
  const controller = new AgentCockpitController(() => {}, {
    requestResync: () => (refreshes.push("refresh"), true),
  });
  assert.equal(controller.handleFrame(snapshot), false, "a snapshot cannot establish its own generation authority");
  assert.deepEqual(refreshes, []);
  assert.equal(controller.handleMcpStatus(status), true);
  assert.deepEqual(refreshes, ["refresh"]);
  assert.equal(controller.handleFrame({ ...snapshot, connection_generation: "connection_stale_123" }), false);
  assert.deepEqual(refreshes, ["refresh", "refresh"],
    "a failure inside an already-latched recovery requires a post-failure status barrier");
  assert.equal(controller.handleFrame(snapshot), true);
  assert.equal(controller.handleFrame({ ...snapshot, secret: "invalid" }), false);
  assert.deepEqual(refreshes, ["refresh", "refresh", "refresh"]);
  assert.equal(controller.snapshot().commandsAvailable, false,
    "a rejected frame revokes the pre-failure mutation capability");
  assert.equal(controller.handleFrame(snapshot), true, "the snapshot response may win the recovery race");
  assert.equal(controller.snapshot().commandsAvailable, false,
    "a fresh snapshot alone cannot reopen actions before fresh status");
  assert.equal(controller.handleMcpStatus(status), true);
  assert.equal(controller.snapshot().commandsAvailable, true);
});

test("post-failure status arriving before its matching snapshot cannot mutate the stale projection", () => {
  const sent = [];
  const controller = new AgentCockpitController((command) => sent.push(command), {
    createCommandId: () => "command_after_repair_1",
    requestResync: () => true,
  });
  synchronize(controller);
  assert.equal(controller.handleFrame({ ...snapshot, secret: "invalid" }), false);
  assert.equal(controller.handleMcpStatus(status), true);
  assert.equal(controller.interrupt(session.session_id, session.generation), null,
    "fresh capability without a fresh snapshot is insufficient");
  assert.equal(controller.handleFrame(snapshot), true);
  assert.equal(controller.interrupt(session.session_id, session.generation), "command_after_repair_1");
  assert.equal(sent.length, 1);
});

test("a failed resync dispatch does not permanently latch recovery", () => {
  let attempts = 0;
  const controller = new AgentCockpitController(() => {}, {
    requestResync: () => (++attempts > 1),
  });
  controller.handleMcpStatus(status);
  assert.equal(attempts, 1);
  controller.handleFrame({ ...snapshot, secret: "invalid" });
  assert.equal(attempts, 2, "a definite unsent read may be requested again");
});

test("only a proven-unsent command rolls back its one-shot reservation", () => {
  let accepted = false;
  let serial = 0;
  const controller = new AgentCockpitController(() => accepted, {
    createCommandId: () => `command_retry_${++serial}_1234`, now: () => 1500,
  });
  const withQuestion = {
    ...snapshot,
    sessions: [{ ...session, state: "waiting_human", pending: [{
      request_id: "request_question_1234", nonce: "nonce_question_12345", kind: "question", title: "Target?",
      expires_at_ms: 3000, choices: [{ id: "choice_unit_12345", label: "Unit" }],
    }] }],
  };
  const reviewed = withQuestion.sessions[0].pending[0];
  synchronize(controller, withQuestion);
  assert.equal(controller.answer(session.session_id, 4, "request_question_1234", "choice_unit_12345",
    reviewed.nonce, cockpitInteractionFingerprint(reviewed)), null);
  accepted = true;
  synchronize(controller, { ...withQuestion, sequence: 2 });
  assert.equal(controller.answer(session.session_id, 4, "request_question_1234", "choice_unit_12345",
    reviewed.nonce, cockpitInteractionFingerprint(reviewed)),
    "command_retry_2_1234");
});
