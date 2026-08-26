import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const transpile = (value) => ts.transpileModule(value, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
}).outputText;
const protocolUrl = "data:text/javascript;base64," + Buffer.from(transpile(
  readFileSync(new URL("../app/agent-cockpit/protocol.ts", import.meta.url), "utf8"),
)).toString("base64");
const source = readFileSync(new URL("../app/assistant/host-session-mcp-client.ts", import.meta.url), "utf8")
  .replace('"../agent-cockpit/protocol"', JSON.stringify(protocolUrl));
const js = transpile(source);
const {
  HostSessionMcpClient,
  HostSessionMcpCancelledError,
} = await import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));
const controllerSource = readFileSync(new URL("../app/agent-cockpit/controller.ts", import.meta.url), "utf8")
  .replace('"./protocol"', JSON.stringify(protocolUrl));
const { AgentCockpitController } = await import(
  "data:text/javascript;base64," + Buffer.from(transpile(controllerSource)).toString("base64")
);

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const context = {
  foregroundApp: "launcher",
  foregroundTitle: "Launcher",
  screenOn: true,
  localTime: "Tue Aug 25, 11:00 AM",
  headsetBattery: 72,
};

function setup({ conversateCuesSupported = false, cockpitFreeTextSupported = false } = {}) {
  const sent = [];
  let active = true;
  const client = new HostSessionMcpClient({
    connectionGeneration: "socket-7",
    isConnectionGenerationActive: () => active,
    send: (msg) => sent.push(structuredClone(msg)),
    initializeTimeoutMs: 5_000,
    requestTimeoutMs: 5_000,
    conversateCueTimeoutMs: 5_000,
    conversateCuesSupported,
    cockpitFreeTextSupported,
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
      capabilities: { tools: {}, resources: {} },
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

test("Host MCP readiness is explicit and initialization failure is surfaced to the bridge owner", async () => {
  const sent = [];
  const lifecycle = [];
  const client = new HostSessionMcpClient({
    connectionGeneration: "socket-ready",
    isConnectionGenerationActive: () => true,
    send: (message) => sent.push(structuredClone(message)),
    initializeTimeoutMs: 5_000,
    onReady: () => lifecycle.push("ready"),
    onInitializationError: (error) => lifecycle.push(`failed:${error.message}`),
  });
  assert.deepEqual(lifecycle, []);
  acknowledgeInitialize(client, sent);
  assert.deepEqual(lifecycle, ["ready"]);
  client.close();

  const failedSent = [];
  const failedLifecycle = [];
  const failed = new HostSessionMcpClient({
    connectionGeneration: "socket-failed",
    isConnectionGenerationActive: () => true,
    send: (message) => failedSent.push(structuredClone(message)),
    initializeTimeoutMs: 5_000,
    onReady: () => failedLifecycle.push("ready"),
    onInitializationError: (error) => failedLifecycle.push(`failed:${error.message}`),
  });
  const initialize = failedSent.find((message) => message.method === "initialize");
  failed.handleMessage({ jsonrpc: "2.0", id: initialize.id,
    error: { code: -32602, message: "unsupported Host MCP version" } });
  await tick();
  assert.deepEqual(failedLifecycle, ["failed:unsupported Host MCP version"]);
  failed.close();

  const missingResourcesSent = [];
  const missingResourcesLifecycle = [];
  const missingResources = new HostSessionMcpClient({
    connectionGeneration: "socket-missing-resources",
    isConnectionGenerationActive: () => true,
    send: (message) => missingResourcesSent.push(structuredClone(message)),
    onReady: () => missingResourcesLifecycle.push("ready"),
    onInitializationError: (error) => missingResourcesLifecycle.push(`failed:${error.message}`),
  });
  const missingResourcesInitialize = missingResourcesSent.find((message) => message.method === "initialize");
  missingResources.handleMessage({ jsonrpc: "2.0", id: missingResourcesInitialize.id, result: {
    protocolVersion: "2025-06-18",
    capabilities: { tools: {} },
    serverInfo: { name: "incomplete-host", version: "1.0.0" },
  } });
  await tick();
  assert.deepEqual(missingResourcesLifecycle, ["failed:Hermes host MCP negotiated an invalid initialize result"]);
  missingResources.close();
});

test("initialize transport rejection never re-enters the bridge owner during construction", async () => {
  for (const mode of ["false", "throw"]) {
    const lifecycle = [];
    const client = new HostSessionMcpClient({
      connectionGeneration: `socket-sync-${mode}`,
      isConnectionGenerationActive: () => true,
      send: () => {
        if (mode === "throw") throw new Error("synthetic synchronous send failure");
        return false;
      },
      onInitializationError: (error) => lifecycle.push(error.message),
    });

    assert.deepEqual(lifecycle, [], "constructor must return before notifying its bridge owner");
    await tick();
    assert.equal(lifecycle.length, 1);
    assert.match(lifecycle[0], mode === "throw"
      ? /synthetic synchronous send failure/
      : /not accepted for transport/);
    client.close();
  }
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

test("optional Conversate cue calls are exact, bounded, and latest-wins", async () => {
  const { client, sent } = setup({ conversateCuesSupported: true });
  acknowledgeInitialize(client, sent);
  const first = client.callConversateCues({
    sessionId: "cv-1",
    revision: 1,
    transcript: "We should plan the release",
  });
  await tick();
  const firstWire = sent.find((message) => message.id === first.requestId);
  assert.deepEqual(firstWire.params, {
    name: "hermes.conversate.cues",
    arguments: { sessionId: "cv-1", revision: 1, transcript: "We should plan the release" },
  });

  const second = client.callConversateCues({
    sessionId: "cv-1",
    revision: 2,
    transcript: "We should plan the Friday release",
  });
  await assert.rejects(first.result, HostSessionMcpCancelledError);
  assert.ok(sent.some((message) => message.method === "notifications/cancelled" &&
    message.params?.requestId === first.requestId));
  await tick();
  client.handleMessage({ jsonrpc: "2.0", id: second.requestId, result: {
    content: [{ type: "text", text: JSON.stringify({
      sessionId: "cv-1",
      revision: 2,
      cues: [{ kind: "question", text: "What must be ready before Friday?" }],
    }) }],
    isError: false,
  } });
  assert.deepEqual(await second.result, {
    sessionId: "cv-1",
    revision: 2,
    cues: [{ kind: "question", text: "What must be ready before Friday?" }],
  });

  const malformed = client.callConversateCues({ sessionId: "cv-1", revision: 3, transcript: "Next" });
  await tick();
  client.handleMessage({ jsonrpc: "2.0", id: malformed.requestId, result: {
    content: [{ type: "text", text: JSON.stringify({
      sessionId: "cv-1", revision: 3,
      cues: [{ kind: "question", text: "Okay?", extra: "leak" }],
    }) }],
  } });
  await assert.rejects(malformed.result, /invalid cue/);
  client.close();
});

test("Conversate cue deadline cancels the exact Host MCP request", async () => {
  const sent = [];
  const client = new HostSessionMcpClient({
    connectionGeneration: "socket-cue-timeout",
    isConnectionGenerationActive: () => true,
    send: (message) => sent.push(structuredClone(message)),
    initializeTimeoutMs: 5_000,
    conversateCueTimeoutMs: 10,
    conversateCuesSupported: true,
  });
  acknowledgeInitialize(client, sent);
  const call = client.callConversateCues({
    sessionId: "cv-timeout",
    revision: 1,
    transcript: "A finalized transcript",
  });
  await assert.rejects(call.result, /timed out/);
  assert.ok(sent.some((message) => message.method === "notifications/cancelled" &&
    message.params?.requestId === call.requestId));
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

test("bridge requires host-mcp-v1 and negotiates bounded Cockpit free text without a legacy channel", () => {
  const bridge = readFileSync(new URL("../app/assistant/bridge-client.ts", import.meta.url), "utf8");
  assert.match(bridge, /capabilities: \["mcp", "host-mcp-v1", CONVERSATE_CUES_CAPABILITY, CONTEXTUAL_SUBJECT_CAPABILITY,\s*COCKPIT_FREE_TEXT_CAPABILITY\]/);
  assert.match(bridge, /COCKPIT_FREE_TEXT_CAPABILITY = "cockpit-free-text-v1"/);
  assert.match(bridge, /const cockpitFreeTextSupported = this\.hostMcpSupported &&\s*frame\.capabilities\.includes\(COCKPIT_FREE_TEXT_CAPABILITY\)/);
  assert.match(bridge, /cockpitFreeTextSupported,/);
  assert.match(bridge, /frame\.capabilities\.includes\("host-mcp-v1"\)/);
  assert.match(bridge, /case "host-mcp":\s*\n\s*if \(!this\.requireAuthenticated\(generation\)\) return/);
  assert.match(bridge, /new HostSessionMcpClient\(\{/);
  assert.match(bridge, /case "chat":\s*\n\s*return; \/\/ Legacy custom turns are never an authority path\./);
  assert.match(bridge, /callVoiceTurn\(\{ turnId, text, context: ctx \}\)/);
  assert.match(bridge, /callConversateCues\(request\)/);
  assert.match(bridge, /chan: "host-mcp", msg/);
  assert.match(bridge, /Bridge does not support the required Host MCP/);
  assert.match(bridge, /Starting secure Host MCP/);
  assert.match(bridge, /onInitializationError/);
  assert.match(bridge, /setState\("connected"[\s\S]*frame\.serverName/);
  assert.doesNotMatch(bridge, /chan: "chat"/);
});

test("unnegotiated free-text projection is dropped without hiding listed answers", () => {
  const run = (cockpitFreeTextSupported) => {
    const sent = [];
    const frames = [];
    const client = new HostSessionMcpClient({
      connectionGeneration: cockpitFreeTextSupported ? 29 : 28,
      isConnectionGenerationActive: () => true,
      send: (message) => sent.push(structuredClone(message)),
      cockpitFreeTextSupported,
      cockpitRefreshIntervalMs: 60_000,
      onCockpitFrame: (frame) => frames.push(frame),
    });
    acknowledgeInitialize(client, sent);
    const read = sent.find((message) => message.method === "resources/read" &&
      message.params?.uri === "hermes://cockpit/state");
    const listed = {
      request_id: "request_listed_1234", nonce: "nonce_listed_12345", kind: "question",
      title: "Choose target", expires_at_ms: 5_000,
      choices: [{ id: "choice_listed_1234", label: "Staging" }],
    };
    const freeText = {
      request_id: "request_text_12345", nonce: "nonce_text_123456", kind: "text_question",
      title: "Name release", expires_at_ms: 5_000, max_length: 64,
    };
    client.handleMessage({ jsonrpc: "2.0", id: read.id, result: { contents: [{
      uri: "hermes://cockpit/state", mimeType: "application/json", text: JSON.stringify({
        v: 1, chan: "cockpit", type: "snapshot",
        connection_generation: "host_connection_0123456789abcdef0123456789abcdef",
        sequence: 1, sessions: [{
          session_id: "session_mixed_12345", generation: 1, revision: 1,
          title: "Mixed questions", state: "waiting_human", updated_at_ms: 1_000,
          timeline: [], pending: [listed, freeText],
        }],
      }),
    }] } });
    client.close();
    return frames[0].sessions[0].pending;
  };

  assert.deepEqual(run(false).map((request) => request.kind), ["question"]);
  assert.deepEqual(run(true).map((request) => request.kind), ["question", "text_question"]);
});

test("host MCP reads health without replacing the Cockpit snapshot resource", () => {
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
        cockpit: { state: "online", transport: "mcp-resource", projection: "session-snapshot", sharedSessions: 0, commandsAvailable: false },
        companion: { state: "unavailable", reason: "backend-authority-absent", commandsAvailable: false },
      }),
    }] },
  });
  assert.deepEqual(statuses, [{
    connectionGeneration: "host_connection_0123456789abcdef0123456789abcdef",
    voiceTurnState: "idle",
    commandsAvailable: false,
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

test("a coalesced post-failure status read suppresses the pre-failure response", () => {
  const sent = [];
  const statuses = [];
  const client = new HostSessionMcpClient({
    connectionGeneration: 10,
    isConnectionGenerationActive: () => true,
    send: (message) => sent.push(structuredClone(message)),
    onStatus: (status) => statuses.push(status),
    cockpitRefreshIntervalMs: 60_000,
  });
  acknowledgeInitialize(client, sent);
  const first = sent.find((message) => message.method === "resources/read" &&
    message.params?.uri === "hermes://session/status");
  assert.equal(client.requestStatus(), true, "frame rejection coalesces a post-failure status read");
  const statusResult = (commandsAvailable) => ({ contents: [{
    uri: "hermes://session/status", mimeType: "application/json", text: JSON.stringify({
      schemaVersion: 1,
      connectionGeneration: "host_connection_0123456789abcdef0123456789abcdef",
      profile: "even-g2",
      transport: { state: "online", authenticated: true },
      sessionMcp: { state: "ready", voiceTurnState: "idle", legacyChatFallback: false },
      cockpit: { state: "online", transport: "mcp-resource", projection: "session-snapshot",
        sharedSessions: 0, commandsAvailable },
      companion: { state: "unavailable", reason: "backend-authority-absent", commandsAvailable: false },
    }),
  }] });
  client.handleMessage({ jsonrpc: "2.0", id: first.id, result: statusResult(true) });
  assert.deepEqual(statuses, [], "the status issued before failure cannot restore mutation authority");
  const second = sent.filter((message) => message.method === "resources/read" &&
    message.params?.uri === "hermes://session/status").at(-1);
  assert.notEqual(second.id, first.id);
  client.handleMessage({ jsonrpc: "2.0", id: second.id, result: statusResult(false) });
  assert.equal(statuses.length, 1);
  assert.equal(statuses[0].commandsAvailable, false);
  client.close();
});

test("an invalid recovery snapshot cannot reopen commands with its pre-failure status response", () => {
  const sent = [];
  const connectionGeneration = "host_connection_0123456789abcdef0123456789abcdef";
  const authoritativeStatus = {
    connectionGeneration,
    voiceTurnState: "idle",
    commandsAvailable: true,
  };
  const authoritativeSnapshot = {
    v: 1, chan: "cockpit", type: "snapshot",
    connection_generation: connectionGeneration, sequence: 1, sessions: [],
  };
  let client = null;
  const controller = new AgentCockpitController(() => false, {
    requestResync: () => {
      if (!client) return false;
      const statusAccepted = client.requestStatus();
      const snapshotAccepted = client.requestCockpitState();
      return statusAccepted || snapshotAccepted;
    },
  });
  assert.equal(controller.handleMcpStatus(authoritativeStatus), true);
  assert.equal(controller.handleFrame(authoritativeSnapshot), true);
  assert.equal(controller.snapshot().commandsAvailable, true);

  client = new HostSessionMcpClient({
    connectionGeneration: 26,
    isConnectionGenerationActive: () => true,
    send: (message) => sent.push(structuredClone(message)),
    onStatus: (status) => controller.handleMcpStatus(status),
    onCockpitFrame: (frame, readEpoch) => controller.handleFrame(frame, readEpoch),
    onCockpitUnavailable: () => controller.unavailable(),
    cockpitRefreshIntervalMs: 60_000,
  });
  acknowledgeInitialize(client, sent);
  const firstStatus = sent.find((message) => message.method === "resources/read" &&
    message.params?.uri === "hermes://session/status");
  const firstSnapshot = sent.find((message) => message.method === "resources/read" &&
    message.params?.uri === "hermes://cockpit/state");
  assert.ok(firstStatus && firstSnapshot);

  client.handleMessage({ jsonrpc: "2.0", id: firstSnapshot.id, result: { contents: [{
    uri: "hermes://cockpit/state", mimeType: "application/json",
    text: JSON.stringify({ ...authoritativeSnapshot, secret: "invalid" }),
  }] } });
  assert.equal(controller.snapshot().synchronized, false);
  assert.equal(controller.snapshot().commandsAvailable, false);
  const postFailureSnapshot = sent.filter((message) => message.method === "resources/read" &&
    message.params?.uri === "hermes://cockpit/state").at(-1);
  assert.notEqual(postFailureSnapshot.id, firstSnapshot.id,
    "the rejected recovery response must begin a new authoritative snapshot read");

  const statusResult = { contents: [{
    uri: "hermes://session/status", mimeType: "application/json", text: JSON.stringify({
      schemaVersion: 1,
      connectionGeneration,
      profile: "even-g2",
      transport: { state: "online", authenticated: true },
      sessionMcp: { state: "ready", voiceTurnState: "idle", legacyChatFallback: false },
      cockpit: { state: "online", transport: "mcp-resource", projection: "session-snapshot",
        sharedSessions: 0, commandsAvailable: true },
      companion: { state: "unavailable", reason: "backend-authority-absent", commandsAvailable: false },
    }),
  }] };
  client.handleMessage({ jsonrpc: "2.0", id: firstStatus.id, result: statusResult });
  assert.equal(controller.snapshot().commandsAvailable, false,
    "the status read begun before the invalid frame is suppressed");
  const postFailureStatus = sent.filter((message) => message.method === "resources/read" &&
    message.params?.uri === "hermes://session/status").at(-1);
  assert.notEqual(postFailureStatus.id, firstStatus.id);

  client.handleMessage({ jsonrpc: "2.0", id: postFailureSnapshot.id, result: { contents: [{
    uri: "hermes://cockpit/state", mimeType: "application/json",
    text: JSON.stringify(authoritativeSnapshot),
  }] } });
  assert.equal(controller.snapshot().synchronized, true);
  assert.equal(controller.snapshot().commandsAvailable, false,
    "a post-failure snapshot alone cannot restore mutation authority");
  client.handleMessage({ jsonrpc: "2.0", id: postFailureStatus.id, result: statusResult });
  assert.equal(controller.snapshot().commandsAvailable, true,
    "only the status read begun after failure can reopen commands");
  client.close();
});

test("Cockpit subscribes, applies a non-empty resource, and returns exact command receipts", () => {
  const sent = [];
  const frames = [];
  const client = new HostSessionMcpClient({
    connectionGeneration: 11,
    isConnectionGenerationActive: () => true,
    send: (message) => sent.push(structuredClone(message)),
    onCockpitFrame: (frame) => frames.push(frame),
  });
  const initialize = sent.find((message) => message.method === "initialize");
  client.handleMessage({
    jsonrpc: "2.0",
    id: initialize.id,
    result: {
      protocolVersion: "2025-06-18",
      capabilities: { tools: {}, resources: { subscribe: true } },
      serverInfo: { name: "hermes-g2-host", version: "1.0.0" },
    },
  });
  assert.ok(sent.some((message) => message.method === "resources/subscribe" &&
    message.params?.uri === "hermes://cockpit/state"));
  const read = sent.find((message) => message.method === "resources/read" &&
    message.params?.uri === "hermes://cockpit/state");
  const session = {
    session_id: "session_1234567890", generation: 4, revision: 1,
    title: "Prepare release", state: "running", updated_at_ms: 1000,
    timeline: [{ id: "timeline_user_12345", kind: "user", text: "Prepare release", status: "done" }],
    pending: [],
  };
  const snapshot = {
    v: 1, chan: "cockpit", type: "snapshot",
    connection_generation: "host_connection_0123456789abcdef0123456789abcdef",
    sequence: 1, sessions: [session],
  };
  client.handleMessage({
    jsonrpc: "2.0", id: read.id, result: { contents: [{
      uri: "hermes://cockpit/state", mimeType: "application/json", text: JSON.stringify(snapshot),
    }] },
  });
  assert.deepEqual(frames, [snapshot]);

  const command = {
    v: 1, chan: "cockpit",
    connection_generation: snapshot.connection_generation,
    type: "steer", command_id: "command_steer_12345",
    session_id: session.session_id, generation: 4, text: "Run focused tests",
  };
  assert.equal(client.sendCockpitCommand(command), true);
  const call = sent.find((message) => message.method === "tools/call" &&
    message.params?.name === "hermes.cockpit.command");
  assert.deepEqual(call.params.arguments, command);
  const receipt = {
    v: 1, chan: "cockpit", type: "command_receipt", sequence: 2,
    command_id: command.command_id, session_id: session.session_id,
    generation: 4, outcome: "accepted",
  };
  client.handleMessage({
    jsonrpc: "2.0", id: call.id, result: {
      content: [{ type: "text", text: JSON.stringify(receipt) }],
      structuredContent: receipt, isError: false,
    },
  });
  assert.deepEqual(frames, [snapshot, receipt]);

  client.handleMessage({
    jsonrpc: "2.0", method: "notifications/resources/updated",
    params: { uri: "hermes://cockpit/state" },
  });
  const refreshed = sent.filter((message) => message.method === "resources/read" &&
    message.params?.uri === "hermes://cockpit/state").at(-1);
  assert.notEqual(refreshed.id, read.id);
  client.close();
});

test("a Cockpit resource hint refreshes commandsAvailable status and snapshot together", () => {
  const sent = [];
  const client = new HostSessionMcpClient({
    connectionGeneration: 27,
    isConnectionGenerationActive: () => true,
    send: (message) => sent.push(structuredClone(message)),
    cockpitRefreshIntervalMs: 60_000,
  });
  acknowledgeInitialize(client, sent);
  const connectionGeneration = "host_connection_0123456789abcdef0123456789abcdef";
  const initialStatus = sent.find((message) => message.method === "resources/read" &&
    message.params?.uri === "hermes://session/status");
  client.handleMessage({ jsonrpc: "2.0", id: initialStatus.id, result: { contents: [{
    uri: "hermes://session/status", mimeType: "application/json", text: JSON.stringify({
      schemaVersion: 1, connectionGeneration, profile: "even-g2",
      transport: { state: "online", authenticated: true },
      sessionMcp: { state: "ready", voiceTurnState: "idle", legacyChatFallback: false },
      cockpit: { state: "online", transport: "mcp-resource", projection: "session-snapshot",
        sharedSessions: 0, commandsAvailable: false },
      companion: { state: "unavailable", reason: "backend-authority-absent", commandsAvailable: false },
    }),
  }] } });
  const initialCockpit = sent.find((message) => message.method === "resources/read" &&
    message.params?.uri === "hermes://cockpit/state");
  client.handleMessage({ jsonrpc: "2.0", id: initialCockpit.id, result: { contents: [{
    uri: "hermes://cockpit/state", mimeType: "application/json", text: JSON.stringify({
      v: 1, chan: "cockpit", type: "snapshot", connection_generation: connectionGeneration,
      sequence: 0, sessions: [],
    }),
  }] } });
  const beforeStatus = sent.filter((message) => message.method === "resources/read" &&
    message.params?.uri === "hermes://session/status").length;
  const beforeCockpit = sent.filter((message) => message.method === "resources/read" &&
    message.params?.uri === "hermes://cockpit/state").length;
  client.handleMessage({ jsonrpc: "2.0", method: "notifications/resources/updated",
    params: { uri: "hermes://cockpit/state" } });
  assert.equal(sent.filter((message) => message.method === "resources/read" &&
    message.params?.uri === "hermes://session/status").length, beforeStatus + 1);
  assert.equal(sent.filter((message) => message.method === "resources/read" &&
    message.params?.uri === "hermes://cockpit/state").length, beforeCockpit + 1);
  client.close();
});

test("Cockpit skips unsupported subscriptions and a rejected subscription retains polling recovery", async () => {
  const pollingOnlySent = [];
  const pollingOnly = new HostSessionMcpClient({
    connectionGeneration: 18,
    isConnectionGenerationActive: () => true,
    send: (message) => pollingOnlySent.push(structuredClone(message)),
    cockpitRefreshIntervalMs: 60_000,
  });
  acknowledgeInitialize(pollingOnly, pollingOnlySent);
  assert.equal(pollingOnlySent.some((message) => message.method === "resources/subscribe"), false);
  assert.ok(pollingOnlySent.some((message) => message.method === "resources/read" &&
    message.params?.uri === "hermes://cockpit/state"));
  pollingOnly.close();

  const sent = [];
  const client = new HostSessionMcpClient({
    connectionGeneration: 19,
    isConnectionGenerationActive: () => true,
    send: (message) => sent.push(structuredClone(message)),
    cockpitRefreshIntervalMs: 1_000,
    cockpitReadTimeoutMs: 5_000,
  });
  const initialize = sent.find((message) => message.method === "initialize");
  client.handleMessage({ jsonrpc: "2.0", id: initialize.id, result: {
    protocolVersion: "2025-06-18",
    capabilities: { tools: {}, resources: { subscribe: true } },
    serverInfo: { name: "hermes-host-session", version: "1.0.0" },
  } });
  const subscription = sent.find((message) => message.method === "resources/subscribe");
  assert.ok(subscription);
  client.handleMessage({ jsonrpc: "2.0", id: subscription.id,
    error: { code: -32601, message: "subscriptions disabled" } });
  const initialReads = sent.filter((message) => message.method === "resources/read");
  for (const read of initialReads) {
    client.handleMessage({ jsonrpc: "2.0", id: read.id, error: { code: -32000, message: "initial read retired" } });
  }
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  assert.ok(sent.filter((message) => message.method === "resources/read").length >= initialReads.length + 2,
    "status and snapshot polling must continue without notifications");
  assert.equal(sent.filter((message) => message.method === "resources/subscribe").length, 1,
    "a rejected optional subscription is not spammed");
  client.close();
});

test("a Cockpit mutation timeout reports an exact unknown outcome and performs read-only recovery", async () => {
  const sent = [];
  const frames = [];
  const outcomes = [];
  const client = new HostSessionMcpClient({
    connectionGeneration: 21,
    isConnectionGenerationActive: () => true,
    send: (message) => sent.push(structuredClone(message)),
    cockpitCommandTimeoutMs: 10,
    cockpitReadTimeoutMs: 1_000,
    cockpitRefreshIntervalMs: 60_000,
    onCockpitFrame: (frame, readEpoch) => frames.push({ frame, readEpoch }),
    onCockpitCommandOutcome: (outcome, minimumSnapshotReadEpoch) =>
      outcomes.push({ outcome, minimumSnapshotReadEpoch }),
  });
  acknowledgeInitialize(client, sent);
  const initialReads = sent.filter((message) => message.method === "resources/read");
  const command = {
    v: 1, chan: "cockpit", connection_generation: "host_connection_0123456789abcdef0123456789abcdef",
    type: "interrupt", command_id: "command_timeout_1234",
    session_id: "session_timeout_1234", generation: 3,
  };
  assert.equal(client.sendCockpitCommand(command), true);
  const call = sent.find((message) => message.method === "tools/call" &&
    message.params?.name === "hermes.cockpit.command");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(outcomes, [{
    outcome: {
      commandId: command.command_id,
      sessionId: command.session_id,
      generation: 3,
      outcome: "outcome_unknown",
      code: "receipt_timeout",
    },
    minimumSnapshotReadEpoch: 2,
  }], "an already-in-flight snapshot cannot satisfy the post-outcome read barrier");
  assert.equal(sent.filter((message) => message.method === "tools/call" &&
    message.params?.name === "hermes.cockpit.command").length, 1, "ambiguous mutations are never retried");
  const staleSnapshot = {
    v: 1, chan: "cockpit", type: "snapshot",
    connection_generation: command.connection_generation, sequence: 10, sessions: [],
  };
  const staleCockpitRead = initialReads.find((message) => message.params?.uri === "hermes://cockpit/state");
  client.handleMessage({ jsonrpc: "2.0", id: staleCockpitRead.id, result: { contents: [{
    uri: "hermes://cockpit/state", mimeType: "application/json", text: JSON.stringify(staleSnapshot),
  }] } });
  const initialStatusRead = initialReads.find((message) => message.params?.uri === "hermes://session/status");
  client.handleMessage({ jsonrpc: "2.0", id: initialStatusRead.id,
    error: { code: -32000, message: "stale status" } });
  assert.ok(sent.filter((message) => message.method === "resources/read").length >= initialReads.length + 2,
    "queued recovery is limited to fresh authoritative status and snapshot reads");
  const recoveryCockpitRead = sent.filter((message) => message.method === "resources/read" &&
    message.params?.uri === "hermes://cockpit/state").at(-1);
  client.handleMessage({ jsonrpc: "2.0", id: recoveryCockpitRead.id, result: { contents: [{
    uri: "hermes://cockpit/state", mimeType: "application/json", text: JSON.stringify(staleSnapshot),
  }] } });
  assert.deepEqual(frames.map(({ readEpoch }) => readEpoch), [1, 2],
    "the stale in-flight response and actually issued recovery read retain distinct epochs");

  const lateReceipt = {
    v: 1, chan: "cockpit", type: "command_receipt", sequence: 5,
    command_id: command.command_id, session_id: command.session_id, generation: 3, outcome: "accepted",
  };
  client.handleMessage({ jsonrpc: "2.0", id: call.id, result: {
    content: [{ type: "text", text: JSON.stringify(lateReceipt) }], isError: false,
  } });
  assert.equal(frames.length, 2, "a late command response cannot replace the explicit terminal unknown outcome");
  client.close();
});

test("a rejected immediate unknown-outcome reread reserves the next successful epoch", () => {
  const sent = [];
  const outcomes = [];
  const frames = [];
  let rejectNextCockpitRead = false;
  const client = new HostSessionMcpClient({
    connectionGeneration: 25,
    isConnectionGenerationActive: () => true,
    send: (message) => {
      sent.push(structuredClone(message));
      if (rejectNextCockpitRead && message.method === "resources/read" &&
          message.params?.uri === "hermes://cockpit/state") {
        rejectNextCockpitRead = false;
        return false;
      }
      return true;
    },
    cockpitRefreshIntervalMs: 60_000,
    onCockpitFrame: (frame, readEpoch) => frames.push({ frame, readEpoch }),
    onCockpitCommandOutcome: (outcome, minimumSnapshotReadEpoch) =>
      outcomes.push({ outcome, minimumSnapshotReadEpoch }),
  });
  acknowledgeInitialize(client, sent);
  const initialRead = sent.find((message) => message.method === "resources/read" &&
    message.params?.uri === "hermes://cockpit/state");
  const snapshot = {
    v: 1, chan: "cockpit", type: "snapshot",
    connection_generation: "host_connection_0123456789abcdef0123456789abcdef",
    sequence: 1, sessions: [],
  };
  client.handleMessage({ jsonrpc: "2.0", id: initialRead.id, result: { contents: [{
    uri: "hermes://cockpit/state", mimeType: "application/json", text: JSON.stringify(snapshot),
  }] } });

  const command = {
    v: 1, chan: "cockpit", connection_generation: snapshot.connection_generation,
    type: "interrupt", command_id: "command_epoch_retry_1",
    session_id: "session_epoch_retry_1", generation: 2,
  };
  assert.equal(client.sendCockpitCommand(command), true);
  const call = sent.find((message) => message.method === "tools/call" &&
    message.params?.name === "hermes.cockpit.command");
  rejectNextCockpitRead = true;
  client.handleMessage({ jsonrpc: "2.0", id: call.id,
    error: { code: -32000, message: "ambiguous dispatch" } });
  assert.equal(outcomes[0].minimumSnapshotReadEpoch, 2);
  assert.equal(client.requestCockpitState(), true);
  const recovery = sent.filter((message) => message.method === "resources/read" &&
    message.params?.uri === "hermes://cockpit/state").at(-1);
  client.handleMessage({ jsonrpc: "2.0", id: recovery.id, result: { contents: [{
    uri: "hermes://cockpit/state", mimeType: "application/json", text: JSON.stringify(snapshot),
  }] } });
  assert.deepEqual(frames.map(({ readEpoch }) => readEpoch), [1, 2]);
  client.close();
});

test("definite send rejection is unsent, while socket close settles accepted in-flight commands as unknown", () => {
  const sent = [];
  const unsentOutcomes = [];
  const unsent = new HostSessionMcpClient({
    connectionGeneration: 22,
    isConnectionGenerationActive: () => true,
    send: (message) => {
      sent.push(structuredClone(message));
      return message.params?.name === "hermes.cockpit.command" ? false : true;
    },
    cockpitCommandTimeoutMs: 50,
    cockpitRefreshIntervalMs: 60_000,
    onCockpitCommandOutcome: (outcome) => unsentOutcomes.push(outcome),
  });
  acknowledgeInitialize(unsent, sent);
  const command = {
    v: 1, chan: "cockpit", connection_generation: "host_connection_0123456789abcdef0123456789abcdef",
    type: "steer", command_id: "command_unsent_12345",
    session_id: "session_unsent_12345", generation: 2, text: "Do not queue",
  };
  assert.equal(unsent.sendCockpitCommand(command), false);
  assert.deepEqual(unsentOutcomes, [], "a proven-unsent mutation is rolled back by the controller, not marked ambiguous");
  unsent.close();

  const acceptedFrames = [];
  const closedOutcomes = [];
  const accepted = new HostSessionMcpClient({
    connectionGeneration: 23,
    isConnectionGenerationActive: () => true,
    send: (message) => (acceptedFrames.push(structuredClone(message)), true),
    cockpitCommandTimeoutMs: 5_000,
    cockpitRefreshIntervalMs: 60_000,
    onCockpitCommandOutcome: (outcome) => closedOutcomes.push(outcome),
  });
  acknowledgeInitialize(accepted, acceptedFrames);
  assert.equal(accepted.sendCockpitCommand(command), true);
  accepted.close("socket retired");
  assert.deepEqual(closedOutcomes, [{
    commandId: command.command_id,
    sessionId: command.session_id,
    generation: 2,
    outcome: "outcome_unknown",
    code: "connection_closed",
  }]);
});

test("malformed or mismatched Cockpit command responses become terminal unknown outcomes", () => {
  const sent = [];
  const outcomes = [];
  const client = new HostSessionMcpClient({
    connectionGeneration: 24,
    isConnectionGenerationActive: () => true,
    send: (message) => sent.push(structuredClone(message)),
    cockpitCommandTimeoutMs: 5_000,
    cockpitRefreshIntervalMs: 60_000,
    onCockpitCommandOutcome: (outcome) => outcomes.push(outcome),
  });
  acknowledgeInitialize(client, sent);
  const command = {
    v: 1, chan: "cockpit", connection_generation: "host_connection_0123456789abcdef0123456789abcdef",
    type: "steer", command_id: "command_mismatch_1234",
    session_id: "session_expected_123", generation: 6, text: "Exact target",
  };
  client.sendCockpitCommand(command);
  const call = sent.find((message) => message.params?.name === "hermes.cockpit.command");
  client.handleMessage({ jsonrpc: "2.0", id: call.id, result: {
    content: [{ type: "text", text: JSON.stringify({
      v: 1, chan: "cockpit", type: "command_receipt", sequence: 2,
      command_id: command.command_id, session_id: "session_wrong_12345", generation: 6, outcome: "accepted",
    }) }], isError: false,
  } });
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].outcome, "outcome_unknown");
  assert.equal(outcomes[0].code, "command_receipt_mismatch");
  client.close();
});

test("Cockpit read timeout fails closed and an explicit retry resynchronizes the glasses", async () => {
  const sent = [];
  const frames = [];
  const unavailable = [];
  const client = new HostSessionMcpClient({
    connectionGeneration: 12,
    isConnectionGenerationActive: () => true,
    send: (message) => sent.push(structuredClone(message)),
    cockpitReadTimeoutMs: 40,
    cockpitRefreshIntervalMs: 60_000,
    onCockpitFrame: (frame) => frames.push(frame),
    onCockpitUnavailable: (reason) => unavailable.push(reason),
  });
  acknowledgeInitialize(client, sent);
  const first = sent.find((message) => message.method === "resources/read" &&
    message.params?.uri === "hermes://cockpit/state");
  assert.ok(first);
  assert.equal(client.requestCockpitState(), true, "opening Cockpit requests a refresh even while one read is in flight");
  // Wait past the first deadline but keep ample headroom before the retry's
  // own deadline. Using exactly two timeout intervals races both callbacks
  // when the full suite temporarily starves this process.
  await new Promise((resolve) => setTimeout(resolve, 55));
  const reads = sent.filter((message) => message.method === "resources/read" &&
    message.params?.uri === "hermes://cockpit/state");
  assert.equal(unavailable.at(-1), "Cockpit snapshot timed out");
  assert.ok(reads.length >= 2, "the pending explicit retry starts after the wedged read is retired");

  const snapshot = {
    v: 1, chan: "cockpit", type: "snapshot",
    connection_generation: "host_connection_0123456789abcdef0123456789abcdef",
    sequence: 2, sessions: [],
  };
  client.handleMessage({
    jsonrpc: "2.0", id: reads.at(-1).id, result: { contents: [{
      uri: "hermes://cockpit/state", mimeType: "application/json", text: JSON.stringify(snapshot),
    }] },
  });
  assert.deepEqual(frames, [snapshot]);
  client.close();
});
