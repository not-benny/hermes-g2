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

const session = {
  session_id: "session_1234567890", generation: 4, revision: 1, title: "Disposable task",
  state: "running", updated_at_ms: 1000, timeline: [], pending: [],
};
const snapshot = { v: 1, chan: "cockpit", type: "snapshot", connection_generation: "connection_123456", sequence: 1, sessions: [session] };

test("controller publishes only validated synchronized projections", () => {
  const sent = [];
  const changes = [];
  const controller = new AgentCockpitController((command) => sent.push(command), {
    createCommandId: () => "command_1234567890",
  });
  controller.onChange((state) => changes.push(state));
  assert.equal(controller.handleFrame(snapshot), true);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].sessions[0].title, "Disposable task");
  assert.equal(controller.handleFrame({ ...snapshot, secret: "sentinel-private" }), false);
  assert.equal(changes.length, 1);
  assert.deepEqual(sent, []);
});

test("assistant terminal rows remain a passive Cockpit projection", () => {
  const controller = new AgentCockpitController(() => {}, {
    createCommandId: () => "command_1234567890",
  });
  assert.equal(controller.onAssistantResult, undefined,
    "Cockpit must not expose a second wearer-facing completion channel");
  assert.equal(controller.handleFrame(snapshot), true);

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
  controller.handleFrame(snapshot);
  assert.equal(controller.steer(session.session_id, 4, "Use focused tests"), "command_0_1234567890");
  assert.equal(sent.length, 1);
  controller.disconnect();
  assert.equal(controller.interrupt(session.session_id, 4), null);
  controller.handleFrame({ ...snapshot, sequence: 9 });
  assert.equal(sent.length, 1, "offline intent is never queued for reconnect");
});

test("question answers and permission decisions send only store-issued exact handles", () => {
  const sent = [];
  let serial = 0;
  const controller = new AgentCockpitController((command) => sent.push(command), {
    createCommandId: () => `command_${++serial}_1234567890`, now: () => 1500,
  });
  controller.handleFrame({
    ...snapshot,
    sessions: [{ ...session, state: "waiting_human", pending: [
      { request_id: "request_question_1234", nonce: "nonce_question_12345", kind: "question", title: "Target?",
        expires_at_ms: 3000, choices: [{ id: "choice_unit_12345", label: "Unit" }] },
      { request_id: "request_permission_1", nonce: "nonce_permission_123", kind: "permission", title: "Read?",
        expires_at_ms: 3000, action: "read_file", target: "README.md", effect: "Read one file", choices: ["deny", "allow_once"] },
    ] }],
  });
  assert.equal(controller.answer(session.session_id, 4, "request_question_1234", "choice_unit_12345"), "command_1_1234567890");
  assert.equal(controller.decidePermission(session.session_id, 4, "request_permission_1", "allow_once"), "command_2_1234567890");
  assert.deepEqual(sent.map((item) => item.type), ["answer", "permission_decide"]);
  assert.equal(controller.decidePermission(session.session_id, 4, "request_permission_1", "allow_once"), null);
  assert.ok(sent.every((item) => item.generation === 4 && item.session_id === session.session_id));
});

test("Cockpit status is Host MCP-only and the legacy channel is inert", () => {
  const bridge = readFileSync(new URL("../app/assistant/bridge-client.ts", import.meta.url), "utf8");
  assert.match(bridge, /readonly cockpit = new AgentCockpitController/);
  assert.match(bridge, /capabilities: \["mcp", "host-mcp-v1", CONVERSATE_CUES_CAPABILITY\]/);
  assert.match(bridge, /case "cockpit":\s*\n\s*return; \/\/ Cockpit state is read only through Host MCP resources\./);
  assert.doesNotMatch(bridge, /legacyCockpitSupported/);
  assert.doesNotMatch(bridge, /chan: "cockpit"/);
  assert.match(bridge, /this\.cockpit\.disconnect\(\)/);
});

test("Host MCP health cannot erase or invent the separately fetched Cockpit projection", () => {
  const sent = [];
  const controller = new AgentCockpitController((command) => sent.push(command));
  assert.equal(controller.handleMcpStatus({
    connectionGeneration: "host_connection_0123456789abcdef0123456789abcdef",
    voiceTurnState: "idle",
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
  assert.equal(controller.interrupt("missing-session", 1), null);
  assert.deepEqual(sent, []);
});
