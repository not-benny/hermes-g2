import assert from "node:assert/strict";
import test from "node:test";
import { PrivateBridgeConnection } from "../hermes-host/private-bridge-connection.mjs";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup() {
  const sent = [];
  const closed = [];
  const runs = [];
  const connection = new PrivateBridgeConnection({
    expectedToken: "correct-private-token",
    connectionGeneration: "socket-1",
    send: (frame) => sent.push(structuredClone(frame)),
    closeSocket: (code, reason) => closed.push({ code, reason }),
    triggerPhrase: "open living room",
    createTurn: ({ phone, identity }) => ({
      async run(_identity, { signal }) {
        runs.push({ phone, identity, signal });
        await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
        return { actions: 0, reason: "cancelled" };
      },
    }),
  });
  return { connection, sent, closed, runs };
}

test("private bridge authenticates hello and starts only an exact-turn MCP session", async () => {
  const { connection, sent, runs, closed } = setup();
  await connection.receive({ v: 1, chan: "ctl", type: "hello", version: 1, token: "correct-private-token", deviceName: "Hermes G2", capabilities: ["chat", "mcp"] });
  assert.equal(sent[0].type, "hello-ack");

  void connection.receive({ v: 1, chan: "chat", type: "utterance", turnId: "turn-1", text: "open living room" });
  await tick();
  const initialize = sent.find((frame) => frame.chan === "mcp" && frame.msg?.method === "initialize");
  assert.equal(initialize.turnId, "turn-1");
  await connection.receive({ v: 1, chan: "mcp", msg: { jsonrpc: "2.0", id: "stale-socket:1", result: { protocolVersion: "2025-06-18" } } });
  await connection.receive({ v: 1, chan: "mcp", turnId: "wrong-turn", msg: { jsonrpc: "2.0", id: initialize.msg.id, result: { protocolVersion: "2025-06-18" } } });
  assert.equal(runs.length, 0);
  await connection.receive({ v: 1, chan: "mcp", msg: { jsonrpc: "2.0", id: initialize.msg.id, result: { protocolVersion: "2025-06-18" } } });
  await tick();
  assert.equal(runs.length, 1);
  assert.equal(runs[0].identity.connectionGeneration, "socket-1");
  assert.equal(runs[0].identity.turnGeneration, "turn-1");

  await connection.receive({ v: 1, chan: "chat", type: "cancel", turnId: "turn-1" });
  await connection.whenIdle();
  assert.equal(runs[0].signal.aborted, true);
  assert.equal(closed.at(-1).code, 1012);
});

test("bad token and privileged pre-auth traffic fail closed", async () => {
  const { connection, sent, closed } = setup();
  await connection.receive({ v: 1, chan: "mcp", turnId: "x", msg: {} });
  assert.equal(closed[0].code, 1008);
  assert.equal(sent.at(-1).type, "error");

  const other = setup();
  await other.connection.receive({ v: 1, chan: "ctl", type: "hello", version: 1, token: "wrong-private-token", deviceName: "Hermes G2", capabilities: ["chat", "mcp"] });
  assert.equal(other.closed[0].code, 1008);
  assert.equal(JSON.stringify(other.sent).includes("correct-private-token"), false);
});

test("companion endpoint attaches only after authenticated capability negotiation and detaches on socket close", async () => {
  const sent = [], closed = [], calls = [];
  const companionEndpoint = {
    attach(generation, emit) { calls.push({ type: "attach", generation }); this.emit = emit; },
    detach(generation) { calls.push({ type: "detach", generation }); return true; },
    handleCommand(frame, generation) { calls.push({ type: "command", frame, generation }); return true; },
  };
  const connection = new PrivateBridgeConnection({
    expectedToken: "correct-private-token", connectionGeneration: "connection_socket_1234",
    send: (frame) => sent.push(structuredClone(frame)), closeSocket: (code, reason) => closed.push({ code, reason }),
    createTurn: () => ({ async run() { return { actions: 0, reason: "complete" }; } }), companionEndpoint,
  });
  const preAuth = { v: 1, chan: "companion", type: "refresh", operation_id: "operation_refresh_1234",
    connection_generation: "connection_socket_1234" };
  assert.equal(await connection.receive(preAuth), false);
  assert.equal(calls.length, 0);
  assert.equal(closed.at(-1).code, 1008);

  const active = new PrivateBridgeConnection({
    expectedToken: "correct-private-token", connectionGeneration: "connection_socket_5678",
    send: (frame) => sent.push(structuredClone(frame)), closeSocket: () => {},
    createTurn: () => ({ async run() { return { actions: 0, reason: "complete" }; } }), companionEndpoint,
  });
  await active.receive({ v: 1, chan: "ctl", type: "hello", version: 1, token: "correct-private-token",
    deviceName: "Hermes G2", capabilities: ["chat", "mcp", "hermes-companion-v1"] });
  assert.equal(sent.at(-1).type, "hello-ack");
  assert.deepEqual(sent.at(-1).capabilities, ["hermes-companion-v1"]);
  assert.deepEqual(calls.at(-1), { type: "attach", generation: "connection_socket_5678" });
  const command = { ...preAuth, connection_generation: "connection_socket_5678" };
  assert.equal(await active.receive(command), true);
  assert.equal(calls.at(-1).type, "command");
  companionEndpoint.emit({ v: 1, chan: "companion", type: "snapshot", connection_generation: "connection_socket_5678" });
  assert.equal(sent.at(-1).chan, "companion");
  await active.close();
  assert.deepEqual(calls.at(-1), { type: "detach", generation: "connection_socket_5678" });
});

test("connection retirement cancels the owned turn and stale replies stay rejected", async () => {
  const { connection, sent, runs } = setup();
  await connection.receive({ v: 1, chan: "ctl", type: "hello", version: 1, token: "correct-private-token", deviceName: "Hermes G2", capabilities: ["chat", "mcp"] });
  void connection.receive({ v: 1, chan: "chat", type: "utterance", turnId: "turn-1", text: "open living room" });
  await tick();
  const initialize = sent.find((frame) => frame.msg?.method === "initialize");
  await connection.receive({ v: 1, chan: "mcp", msg: { jsonrpc: "2.0", id: initialize.msg.id, result: { protocolVersion: "2025-06-18" } } });
  await tick();
  await connection.close("socket replaced");
  assert.equal(runs[0].signal.aborted, true);
  assert.equal(await connection.receive({ v: 1, chan: "mcp", msg: { jsonrpc: "2.0", id: "late", result: {} } }), false);
});

test("every newer utterance retires the old phone turn and reconnects before trigger validation", async () => {
  const { connection, sent, runs, closed } = setup();
  await connection.receive({ v: 1, chan: "ctl", type: "hello", version: 1, token: "correct-private-token", deviceName: "Hermes G2", capabilities: ["chat", "mcp"] });
  void connection.receive({ v: 1, chan: "chat", type: "utterance", turnId: "turn-1", text: "open living room" });
  await tick();
  const initialize = sent.find((frame) => frame.msg?.method === "initialize");
  await connection.receive({ v: 1, chan: "mcp", msg: { jsonrpc: "2.0", id: initialize.msg.id, result: { protocolVersion: "2025-06-18" } } });
  await tick();
  await connection.receive({ v: 1, chan: "chat", type: "utterance", turnId: "turn-2", text: "something else" });
  assert.equal(runs[0].signal.aborted, true);
  assert.equal(closed.at(-1).code, 1012);
  assert.equal(sent.some((frame) => frame.type === "turn-error" && frame.turnId === "turn-2"), false);
});

test("two completed turns share one initialized phone MCP server on the same socket", async () => {
  const sent = [];
  const runs = [];
  const connection = new PrivateBridgeConnection({
    expectedToken: "correct-private-token", connectionGeneration: "socket-shared",
    send: (frame) => sent.push(structuredClone(frame)), closeSocket: () => {}, triggerPhrase: "open living room",
    createTurn: ({ identity }) => ({ async run() { runs.push(identity.turnGeneration); return { actions: 1, reason: "complete" }; } }),
  });
  await connection.receive({ v: 1, chan: "ctl", type: "hello", version: 1, token: "correct-private-token",
    deviceName: "Hermes G2", capabilities: ["chat", "mcp"] });
  await connection.receive({ v: 1, chan: "chat", type: "utterance", turnId: "turn-1", text: "open living room" });
  await tick();
  const initialize = sent.find((frame) => frame.msg?.method === "initialize");
  await connection.receive({ v: 1, chan: "mcp", msg: { jsonrpc: "2.0", id: initialize.msg.id,
    result: { protocolVersion: "2025-06-18" } } });
  await tick();
  assert.deepEqual(runs, ["turn-1"]);

  await connection.receive({ v: 1, chan: "chat", type: "utterance", turnId: "turn-2", text: "open living room" });
  await tick();
  assert.deepEqual(runs, ["turn-1", "turn-2"]);
  assert.equal(sent.filter((frame) => frame.msg?.method === "initialize").length, 1);
  assert.equal(sent.filter((frame) => frame.type === "turn-done").length, 2);
});
