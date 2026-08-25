import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../app/assistant/host-session-mcp-client.ts", import.meta.url), "utf8");
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
}).outputText;
const {
  HostSessionMcpClient,
  HostSessionMcpCancelledError,
} = await import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const context = {
  foregroundApp: "launcher",
  foregroundTitle: "Launcher",
  screenOn: true,
  localTime: "Tue Aug 25, 11:00 AM",
  headsetBattery: 72,
};

function setup() {
  const sent = [];
  let active = true;
  const client = new HostSessionMcpClient({
    connectionGeneration: "socket-7",
    isConnectionGenerationActive: () => active,
    send: (msg) => sent.push(structuredClone(msg)),
    initializeTimeoutMs: 5_000,
    requestTimeoutMs: 5_000,
  });
  return { client, sent, retire: () => { active = false; } };
}

function acknowledgeInitialize(client, sent) {
  const initialize = sent.find((msg) => msg.method === "initialize");
  assert.ok(initialize);
  client.handleMessage({
    jsonrpc: "2.0",
    id: initialize.id,
    result: {
      protocolVersion: "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "hermes-host-session", version: "1.0.0" },
    },
  });
  assert.ok(sent.some((msg) => msg.jsonrpc === "2.0" && msg.method === "notifications/initialized"));
}

function terminal(turnId, text = "Done", stopReason = "complete") {
  return {
    content: [{ type: "text", text: JSON.stringify({ turnId, text, stopReason }) }],
    isError: false,
  };
}

test("host MCP initializes before an exact hermes.voice.turn tools/call", async () => {
  const { client, sent } = setup();
  assert.deepEqual(sent[0], {
    jsonrpc: "2.0",
    id: "host-mcp:socket-7:initialize:1",
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "hermes-g2-host-session", version: "1.0.0" },
    },
  });

  const call = client.callVoiceTurn({ turnId: "t1", text: "What is next?", context });
  assert.equal(sent.some((msg) => msg.method === "tools/call"), false, "call waits for initialize result");
  acknowledgeInitialize(client, sent);
  await tick();

  const wireCall = sent.find((msg) => msg.method === "tools/call");
  assert.deepEqual(wireCall, {
    jsonrpc: "2.0",
    id: call.requestId,
    method: "tools/call",
    params: {
      name: "hermes.voice.turn",
      arguments: { turnId: "t1", text: "What is next?", context },
    },
  });

  client.handleMessage({ jsonrpc: "2.0", method: "notifications/progress", params: {
    progressToken: "private", progress: 1, message: "Using a tool",
  } });
  client.handleMessage({ jsonrpc: "2.0", id: call.requestId, result: terminal("t1", "Your next meeting is at noon.", "complete") });
  assert.deepEqual(await call.result, {
    turnId: "t1",
    text: "Your next meeting is at noon.",
    stopReason: "complete",
  });
  client.close();
});

test("voice cancellation is standard MCP notifications/cancelled and late finals are inert", async () => {
  const { client, sent } = setup();
  acknowledgeInitialize(client, sent);
  const call = client.callVoiceTurn({ turnId: "t-cancel", text: "Long task", context });
  await tick();
  call.cancel("Dismissed on the ring");
  assert.deepEqual(sent.at(-1), {
    jsonrpc: "2.0",
    method: "notifications/cancelled",
    params: { requestId: call.requestId, reason: "Dismissed on the ring" },
  });
  await assert.rejects(call.result, (error) => {
    assert.ok(error instanceof HostSessionMcpCancelledError);
    assert.equal(error.message, "Dismissed on the ring");
    return true;
  });

  client.handleMessage({ jsonrpc: "2.0", id: call.requestId, result: terminal("t-cancel", "Late") });
  const next = client.callVoiceTurn({ turnId: "t-next", text: "Next", context });
  await tick();
  client.handleMessage({ jsonrpc: "2.0", id: next.requestId, result: terminal("t-next", "Fresh") });
  assert.equal((await next.result).text, "Fresh");
  client.close();
});

test("exact CallToolResult, tool errors, and JSON-RPC errors map to terminal outcomes", async () => {
  const { client, sent } = setup();
  acknowledgeInitialize(client, sent);

  const toolError = client.callVoiceTurn({ turnId: "t-error", text: "Fail", context });
  await tick();
  client.handleMessage({ jsonrpc: "2.0", id: toolError.requestId, result: {
    content: [{ type: "text", text: "Calendar permission denied" }], isError: true,
  } });
  await assert.rejects(toolError.result, /Calendar permission denied/);

  const rpcError = client.callVoiceTurn({ turnId: "t-rpc", text: "Fail again", context });
  await tick();
  client.handleMessage({ jsonrpc: "2.0", id: rpcError.requestId,
    error: { code: -32603, message: "Hermes session failed" } });
  await assert.rejects(rpcError.result, /Hermes session failed/);

  const wrongTurn = client.callVoiceTurn({ turnId: "t-current", text: "Mismatch", context });
  await tick();
  client.handleMessage({ jsonrpc: "2.0", id: wrongTurn.requestId,
    result: terminal("t-stale", "Must not surface") });
  await assert.rejects(wrongTurn.result, /invalid terminal result/);

  const extraField = client.callVoiceTurn({ turnId: "t-exact", text: "Exact", context });
  await tick();
  client.handleMessage({ jsonrpc: "2.0", id: extraField.requestId, result: {
    content: [{ type: "text", text: JSON.stringify({
      turnId: "t-exact", text: "No", stopReason: null, progress: "leak",
    }) }],
  } });
  await assert.rejects(extraField.result, /invalid terminal result/);
  client.close();
});

test("connection generations and message bounds retire work without stale success", async () => {
  const first = setup();
  acknowledgeInitialize(first.client, first.sent);
  const stale = first.client.callVoiceTurn({ turnId: "t-stale", text: "Wait", context });
  await tick();
  first.retire();
  first.client.handleMessage({ jsonrpc: "2.0", id: stale.requestId, result: terminal("t-stale", "Stale") });
  await assert.rejects(stale.result, /no longer active/);

  const second = setup();
  acknowledgeInitialize(second.client, second.sent);
  const oversized = second.client.callVoiceTurn({ turnId: "t-large", text: "x".repeat(70 * 1024), context });
  await assert.rejects(oversized.result, /bounded message limit/);
  assert.equal(second.sent.some((msg) => msg.method === "tools/call"), false);
  second.client.close();
});

test("bridge requires host-mcp-v1 and has no legacy custom turn channel", () => {
  const bridge = readFileSync(new URL("../app/assistant/bridge-client.ts", import.meta.url), "utf8");
  assert.match(bridge, /capabilities: \["mcp", "host-mcp-v1"\]/);
  assert.match(bridge, /frame\.capabilities\.includes\("host-mcp-v1"\)/);
  assert.match(bridge, /case "host-mcp":\s*\n\s*if \(!this\.requireAuthenticated\(generation\)\) return/);
  assert.match(bridge, /new HostSessionMcpClient\(\{/);
  assert.match(bridge, /case "chat":\s*\n\s*return; \/\/ Legacy custom turns are never an authority path\./);
  assert.match(bridge, /callVoiceTurn\(\{ turnId, text, context: ctx \}\)/);
  assert.match(bridge, /chan: "host-mcp", msg/);
  assert.match(bridge, /Bridge does not support the required Host MCP/);
  assert.doesNotMatch(bridge, /chan: "chat"/);
});

test("host MCP reads and validates the status-only Cockpit resource", () => {
  const sent = [];
  const statuses = [];
  const client = new HostSessionMcpClient({
    connectionGeneration: 9,
    isConnectionGenerationActive: () => true,
    send: (message) => sent.push(message),
    onStatus: (status) => statuses.push(status),
  });
  const initialize = sent.find((message) => message.method === "initialize");
  client.handleMessage({
    jsonrpc: "2.0",
    id: initialize.id,
    result: {
      protocolVersion: "2025-06-18",
      capabilities: { tools: {}, resources: {} },
      serverInfo: { name: "hermes-g2-host-session", version: "1.0.0" },
    },
  });
  const read = sent.find((message) => message.method === "resources/read");
  assert.deepEqual(read?.params, { uri: "hermes://session/status" });
  client.handleMessage({
    jsonrpc: "2.0",
    id: read.id,
    result: { contents: [{
      uri: "hermes://session/status",
      mimeType: "application/json",
      text: JSON.stringify({
        schemaVersion: 1,
        connectionGeneration: "host_connection_0123456789abcdef0123456789abcdef",
        profile: "even-g2",
        transport: { state: "online", authenticated: true },
        sessionMcp: { state: "ready", voiceTurnState: "idle", legacyChatFallback: false },
        cockpit: { state: "online", transport: "mcp-resource", projection: "status-only", sharedSessions: 0, commandsAvailable: false },
        companion: { state: "unavailable", reason: "backend-authority-absent", commandsAvailable: false },
      }),
    }] },
  });
  assert.deepEqual(statuses, [{
    connectionGeneration: "host_connection_0123456789abcdef0123456789abcdef",
    voiceTurnState: "idle",
  }]);

  client.requestStatus();
  const secondRead = sent.at(-1);
  client.handleMessage({
    jsonrpc: "2.0",
    id: secondRead.id,
    result: { contents: [{ uri: "hermes://session/status", mimeType: "application/json", text: "{}" }] },
  });
  assert.equal(statuses.length, 1, "malformed status must not replace the synchronized projection");
  client.close();
});
