import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const transpile = (source) => ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
}).outputText;
const protocolUrl = "data:text/javascript;base64," + Buffer.from(transpile(
  readFileSync(new URL("../app/hermes-companion/protocol.ts", import.meta.url), "utf8"),
)).toString("base64");
const controllerSource = readFileSync(new URL("../app/hermes-companion/controller.ts", import.meta.url), "utf8")
  .replace('"./protocol"', JSON.stringify(protocolUrl));
const { HermesCompanionController } = await import(
  "data:text/javascript;base64," + Buffer.from(transpile(controllerSource)).toString("base64")
);

const snapshot = { v: 1, chan: "companion", type: "snapshot", connection_generation: "connection_phone_1234",
  sequence: 1, generated_at_ms: 1_000, status: "ready",
  capabilities: { voice: true, usage: false, cost: false, tool_activity: false },
  sessions: [{ session_id: "session_active_1234", generation: 2, title: "Task", state: "active",
    updated_at_ms: 950, resumable: false }],
  voice: { utterance_count: 1, audio_ms: 500, stt_provider: "local", capture_state: "idle", recent_failures: [] },
  recent_errors: [] };

test("controller sends only store-issued operations and publishes pending state", () => {
  const sent = [], changes = [];
  let serial = 0;
  const controller = new HermesCompanionController((command) => sent.push(command), {
    now: () => 1_100, createOperationId: () => `operation_controller_${++serial}_1234`,
  });
  controller.onChange((state) => changes.push(state));
  assert.equal(controller.handleFrame(snapshot), true);
  const id = controller.cancel("session_active_1234", 2);
  assert.equal(id, "operation_controller_1_1234");
  assert.equal(sent[0].type, "cancel_session");
  assert.deepEqual(changes.at(-1).pendingOperations, [id]);
  assert.equal(controller.cancel("session_active_1234", 2), null);
  controller.disconnect();
  assert.equal(controller.newVoiceSession(), null);
});

test("bridge gates companion frames on authenticated WSS and revokes authority on loss", () => {
  const bridge = readFileSync(new URL("../app/assistant/bridge-client.ts", import.meta.url), "utf8");
  assert.match(bridge, /wss:\/\//);
  assert.match(bridge, /readonly companion = new HermesCompanionController/);
  assert.match(bridge, /capabilities: \["chat", "mcp", "cockpit-v1", "hermes-companion-v1"\]/);
  assert.match(bridge, /case "companion":\s*\n\s*if \(!this\.requireAuthenticated\(generation\)\) return;\s*\n\s*this\.companion\.handleFrame\(frame\)/);
  assert.match(bridge, /this\.companion\.disconnect\(\)/);
  assert.match(bridge, /private sendCompanion/);
  assert.doesNotMatch(bridge, /http:\/\//);
});
