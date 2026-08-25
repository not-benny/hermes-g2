import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
const transpile = (source) => ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 } }).outputText;
const dataUrl = (js) => "data:text/javascript;base64," + Buffer.from(js).toString("base64");
const registryUrl = dataUrl(transpile(readFileSync(new URL("../app/assistant/tool-registry.ts", import.meta.url), "utf8")));
const mcpSource = transpile(readFileSync(new URL("../app/assistant/mcp-server.ts", import.meta.url), "utf8"))
  .replace('"./tool-registry"', JSON.stringify(registryUrl));
const { ToolRegistry } = await import(registryUrl);
const { AssistantMcpServer } = await import(dataUrl(mcpSource));

function setup() {
  const sent = []; const registry = new ToolRegistry(); let calls = 0;
  registry.registerSystemTool({ name: "test.echo", description: "echo", inputSchema: {
    type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false,
  } }, (args) => { calls++; return { ok: true, content: args.text }; });
  const server = new AssistantMcpServer({ send: (msg) => sent.push(msg), isTurnActive: () => true,
    getTurnGeneration: () => "turn-1", connectionGeneration: "connection-1",
    isConnectionGenerationActive: () => true, allowProactive: () => false, registry });
  return { server, sent, calls: () => calls };
}

function initialize(server) {
  server.handleMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  server.handleMessage({ jsonrpc: "2.0", method: "notifications/initialized" });
}

test("MCP requires initialization and negotiates its supported version", () => {
  const { server, sent } = setup();
  server.handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
  assert.equal(sent.at(-1).error.code, -32002);
  server.sendToolsChanged();
  assert.equal(sent.length, 1, "no notifications before initialization");
  server.handleMessage({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "bogus" } });
  assert.equal(sent.at(-1).result.protocolVersion, "2025-06-18");
  server.handleMessage({ jsonrpc: "2.0", method: "notifications/initialized" });
  server.sendToolsChanged();
  assert.equal(sent.at(-1).method, "notifications/tools/list_changed");
});

test("MCP rejects malformed calls and never executes tools/call notifications", async () => {
  const { server, sent, calls } = setup(); initialize(server);
  server.handleMessage({ jsonrpc: "2.0", method: "tools/call", params: { name: "test.echo", arguments: { text: "silent" } } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls(), 0);
  server.handleMessage({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { arguments: {} } });
  assert.equal(sent.at(-1).error.code, -32602);
  server.handleMessage({ jsonrpc: "2.0", id: 4, method: "unknown", params: {} });
  assert.equal(sent.at(-1).error.code, -32601);
});

test("duplicate tool request IDs execute once and closed sessions suppress late replies", async () => {
  const sent = []; const registry = new ToolRegistry(); let calls = 0; let finish;
  registry.registerSystemTool({ name: "test.slow", description: "slow", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
    () => { calls++; return new Promise((resolve) => { finish = resolve; }); });
  const server = new AssistantMcpServer({ send: (msg) => sent.push(msg), isTurnActive: () => true,
    getTurnGeneration: () => "turn-1", connectionGeneration: "connection-1", isConnectionGenerationActive: () => true,
    allowProactive: () => false, registry });
  initialize(server);
  const call = { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "test.slow", arguments: {} } };
  server.handleMessage(call, { turnGeneration: "turn-1" }); server.handleMessage(call, { turnGeneration: "turn-1" });
  assert.equal(calls, 1); assert.equal(sent.at(-1).error.code, -32600);
  const beforeClose = sent.length;
  server.close(); finish({ ok: true, content: "late" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(sent.length, beforeClose);
});

test("MCP rejects a delayed side effect whose claimed turn is no longer active", async () => {
  const sent = []; const registry = new ToolRegistry(); let calls = 0; let generation = "turn-1";
  registry.registerSystemTool({ name: "test.write", description: "write", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
    () => { calls++; return { ok: true, content: "written" }; });
  const server = new AssistantMcpServer({ send: (msg) => sent.push(msg), isTurnActive: () => true,
    getTurnGeneration: () => generation, connectionGeneration: "connection-1", isConnectionGenerationActive: () => true,
    allowProactive: () => false, registry });
  initialize(server); generation = "turn-2";
  server.handleMessage({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "test.write", arguments: {} } },
    { turnGeneration: "turn-1" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls, 0);
  assert.equal(sent.at(-1).result.isError, true);
});

test("MCP tool calls work when the Android runtime lacks AbortController", async () => {
  const original = globalThis.AbortController;
  try {
    globalThis.AbortController = undefined;
    const { server, sent, calls } = setup(); initialize(server);
    server.handleMessage({ jsonrpc: "2.0", id: 20, method: "tools/call", params: { name: "test.echo", arguments: { text: "android" } } },
      { turnGeneration: "turn-1" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(calls(), 1);
    assert.equal(sent.at(-1).result.content[0].text, "android");
  } finally {
    globalThis.AbortController = original;
  }
});

test("MCP rejects missing authorization and close aborts connection-owned calls", async () => {
  const sent = []; const registry = new ToolRegistry(); let calls = 0; let aborted = false;
  registry.registerSystemTool({ name: "test.slow", description: "slow", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
    (_args, signal) => { calls++; return new Promise((resolve) => signal.addEventListener("abort", () => {
      aborted = true; resolve({ ok: false, error: "aborted" });
    }, { once: true })); });
  const server = new AssistantMcpServer({ send: (msg) => sent.push(msg), isTurnActive: () => true,
    getTurnGeneration: () => "turn-1", connectionGeneration: "connection-1", isConnectionGenerationActive: () => true,
    allowProactive: () => false, registry });
  initialize(server);
  const call = { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "test.slow", arguments: {} } };
  server.handleMessage(call);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls, 0);
  server.handleMessage({ ...call, id: 3 }, { turnGeneration: "turn-1" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls, 1);
  server.close();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(aborted, true);
});

test("standard MCP cancellation aborts only the exact active phone call and suppresses its late result", async () => {
  const sent = []; const registry = new ToolRegistry(); let aborted = 0; let finish;
  registry.registerSystemTool({
    name: "test.cancel", description: "cancel",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  }, (_args, signal) => new Promise((resolve) => {
    finish = resolve;
    signal.addEventListener("abort", () => { aborted++; resolve({ ok: false, error: "aborted" }); }, { once: true });
  }));
  const server = new AssistantMcpServer({
    send: (msg) => sent.push(msg), isTurnActive: () => true,
    getTurnGeneration: () => "turn-cancel", connectionGeneration: "connection-cancel",
    isConnectionGenerationActive: () => true, allowProactive: () => false, registry,
  });
  initialize(server);
  server.handleMessage({ jsonrpc: "2.0", id: "call-1", method: "tools/call",
    params: { name: "test.cancel", arguments: {} } }, { turnGeneration: "turn-cancel" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  server.handleMessage({ jsonrpc: "2.0", method: "notifications/cancelled",
    params: { requestId: "call-1", reason: "user dismissed" } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(aborted, 1);
  assert.equal(sent.some((message) => message.id === "call-1"), false);

  server.handleMessage({ jsonrpc: "2.0", method: "notifications/cancelled",
    params: { requestId: "stale-call" } });
  finish?.({ ok: true, content: "late" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(aborted, 1, "stale cancellation is inert");
});

test("direct result notifications are visible and callable only for the exact even-g2 profile", async () => {
  const run = async (profileId) => {
    const sent = []; const registry = new ToolRegistry(); let calls = 0;
    registry.registerSystemTool({
      name: "glasses.notify_result", description: "notify", proactive: true,
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    }, () => { calls++; return { ok: true, content: "acknowledged" }; });
    const server = new AssistantMcpServer({
      send: (msg) => sent.push(msg), isTurnActive: () => false,
      getTurnGeneration: () => null, profileId, connectionGeneration: "connection-profile",
      isConnectionGenerationActive: () => true, allowProactive: () => true, registry,
    });
    initialize(server);
    server.handleMessage({ jsonrpc: "2.0", id: 30, method: "tools/list", params: {} });
    const listed = sent.at(-1).result.tools.some((tool) => tool.name === "glasses.notify_result");
    server.handleMessage({ jsonrpc: "2.0", id: 31, method: "tools/call",
      params: { name: "glasses.notify_result", arguments: {} } }, { proactive: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    return { listed, calls, response: sent.find((message) => message.id === 31) };
  };

  const exact = await run("even-g2");
  assert.equal(exact.listed, true);
  assert.equal(exact.calls, 1);
  assert.equal(exact.response.result.isError, false);

  for (const profile of [undefined, "Even-G2", "custom"]) {
    const denied = await run(profile);
    assert.equal(denied.listed, false, String(profile));
    assert.equal(denied.calls, 0, String(profile));
    assert.equal(denied.response.result.isError, true, String(profile));
    assert.match(denied.response.result.content[0].text, /authenticated even-g2 profile/);
  }
});

test("Work Tasks is visible only to even-g2 and callable only from its exact active turn", async () => {
  const run = async ({ profileId, active = true, authorization }) => {
    const sent = []; const registry = new ToolRegistry(); let calls = 0; let contextSeen;
    registry.registerSystemTool({
      name: "glasses.work_board.add_task", description: "add work task",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    }, (_args, _signal, _isAllowed, context) => {
      calls++; contextSeen = context;
      return { ok: true, content: "saved" };
    });
    const server = new AssistantMcpServer({
      send: (msg) => sent.push(msg), isTurnActive: () => active,
      getTurnGeneration: () => active ? "turn-work-1" : null,
      profileId, connectionGeneration: "connection-work",
      isConnectionGenerationActive: () => true, allowProactive: () => true, registry,
    });
    initialize(server);
    server.handleMessage({ jsonrpc: "2.0", id: 140, method: "tools/list", params: {} });
    const listed = sent.at(-1).result.tools.some((tool) => tool.name === "glasses.work_board.add_task");
    server.handleMessage({ jsonrpc: "2.0", id: 141, method: "tools/call",
      params: { name: "glasses.work_board.add_task", arguments: {} } }, authorization);
    await new Promise((resolve) => setTimeout(resolve, 0));
    return { listed, calls, contextSeen, response: sent.find((message) => message.id === 141) };
  };

  const accepted = await run({ profileId: "even-g2", authorization: { turnGeneration: "turn-work-1" } });
  assert.equal(accepted.listed, true);
  assert.equal(accepted.calls, 1);
  assert.deepEqual(accepted.contextSeen, {
    caller: "mcp", proactive: false, profileId: "even-g2",
    connectionGeneration: "connection-work", turnGeneration: "turn-work-1",
  });
  assert.equal(accepted.response.result.isError, false);

  const proactive = await run({ profileId: "even-g2", active: false, authorization: { proactive: true } });
  assert.equal(proactive.listed, true);
  assert.equal(proactive.calls, 0);
  assert.equal(proactive.response.result.isError, true);
  assert.match(proactive.response.result.content[0].text, /cannot be called outside a conversation/);

  for (const profileId of [undefined, "Even-G2", "custom"]) {
    const denied = await run({ profileId, authorization: { turnGeneration: "turn-work-1" } });
    assert.equal(denied.listed, false, String(profileId));
    assert.equal(denied.calls, 0, String(profileId));
    assert.equal(denied.response.result.isError, true, String(profileId));
    assert.match(denied.response.result.content[0].text, /authenticated even-g2 profile/);
  }
});

test("Clock tools are visible only to even-g2 and callable only from its exact active turn", async () => {
  const run = async ({ profileId, active = true, authorization }) => {
    const sent = []; const registry = new ToolRegistry(); const calls = [];
    let contextSeen;
    for (const name of ["glasses.clock.set_timer", "glasses.clock.set_alarm"]) {
      registry.registerSystemTool({
        name, description: "Clock fixed route",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      }, (_args, _signal, _isAllowed, context) => {
        calls.push(name); contextSeen = context;
        return { ok: true, content: "acknowledged" };
      });
    }
    const server = new AssistantMcpServer({
      send: (msg) => sent.push(msg), isTurnActive: () => active,
      getTurnGeneration: () => active ? "turn-clock-1" : null,
      profileId, connectionGeneration: "connection-clock",
      isConnectionGenerationActive: () => true, allowProactive: () => true, registry,
    });
    initialize(server);
    server.handleMessage({ jsonrpc: "2.0", id: 150, method: "tools/list", params: {} });
    const listed = sent.at(-1).result.tools
      .filter((tool) => tool.name.startsWith("glasses.clock."))
      .map((tool) => tool.name);
    server.handleMessage({ jsonrpc: "2.0", id: 151, method: "tools/call",
      params: { name: "glasses.clock.set_timer", arguments: {} } }, authorization);
    await new Promise((resolve) => setTimeout(resolve, 0));
    return { listed, calls, contextSeen, response: sent.find((message) => message.id === 151) };
  };

  const accepted = await run({ profileId: "even-g2", authorization: { turnGeneration: "turn-clock-1" } });
  assert.deepEqual(accepted.listed, ["glasses.clock.set_timer", "glasses.clock.set_alarm"]);
  assert.deepEqual(accepted.calls, ["glasses.clock.set_timer"]);
  assert.deepEqual(accepted.contextSeen, {
    caller: "mcp", proactive: false, profileId: "even-g2",
    connectionGeneration: "connection-clock", turnGeneration: "turn-clock-1",
  });
  assert.equal(accepted.response.result.isError, false);

  const proactive = await run({ profileId: "even-g2", active: false, authorization: { proactive: true } });
  assert.equal(proactive.listed.length, 2);
  assert.equal(proactive.calls.length, 0);
  assert.equal(proactive.response.result.isError, true);
  assert.match(proactive.response.result.content[0].text, /cannot be called outside a conversation/);

  for (const profileId of [undefined, "Even-G2", "custom"]) {
    const denied = await run({ profileId, authorization: { turnGeneration: "turn-clock-1" } });
    assert.deepEqual(denied.listed, [], String(profileId));
    assert.equal(denied.calls.length, 0, String(profileId));
    assert.equal(denied.response.result.isError, true, String(profileId));
    assert.match(denied.response.result.content[0].text, /authenticated even-g2 profile/);
  }
});

test("proactive opt-in is revalidated through completion and revocation reports no success", async () => {
  const sent = []; const registry = new ToolRegistry();
  let allowProactive = true;
  let release;
  let sideEffects = 0;
  let contextSeen;
  registry.registerSystemTool({
    name: "glasses.notify_result", description: "notify", proactive: true,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  }, async (_args, _signal, isAllowed, context) => {
    contextSeen = context;
    await new Promise((resolve) => { release = resolve; });
    if (!isAllowed()) return { ok: false, error: "revoked before side effect" };
    sideEffects++;
    return { ok: true, content: "acknowledged" };
  });
  const server = new AssistantMcpServer({
    send: (msg) => sent.push(msg), isTurnActive: () => false,
    getTurnGeneration: () => null, profileId: "even-g2", connectionGeneration: "connection-live-opt-in",
    isConnectionGenerationActive: () => true, allowProactive: () => allowProactive, registry,
  });
  initialize(server);
  server.handleMessage({ jsonrpc: "2.0", id: 40, method: "tools/call",
    params: { name: "glasses.notify_result", arguments: {} } }, { proactive: true });
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(contextSeen, {
    caller: "mcp", proactive: true, profileId: "even-g2",
    connectionGeneration: "connection-live-opt-in", turnGeneration: null,
  });
  allowProactive = false;
  release();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(sideEffects, 0);
  const response = sent.find((message) => message.id === 40);
  assert.equal(response.result.isError, true);
  assert.match(response.result.content[0].text, /disabled|revoked/);
});

test("a direct notification durably queued before opt-out keeps its truthful queued receipt", async () => {
  const sent = [];
  const registry = new ToolRegistry();
  let allowProactive = true;
  let durablePending = 0;
  registry.registerSystemTool({
    name: "glasses.notify_result", description: "notify", proactive: true,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  }, (_args, _signal, isAllowed) => {
    assert.equal(isAllowed(), true, "authorization is checked adjacent to the durable write");
    durablePending++;
    // Models the Settings callback racing immediately after the synchronous
    // encrypted save, before the MCP continuation sends its reply.
    allowProactive = false;
    return { ok: true, content: JSON.stringify({ status: "queued", operation_id: "race-1" }) };
  });
  const server = new AssistantMcpServer({
    send: (message) => sent.push(message), isTurnActive: () => false,
    getTurnGeneration: () => null, profileId: "even-g2", connectionGeneration: "connection-commit-race",
    isConnectionGenerationActive: () => true, allowProactive: () => allowProactive, registry,
  });
  initialize(server);
  server.handleMessage({ jsonrpc: "2.0", id: 45, method: "tools/call",
    params: { name: "glasses.notify_result", arguments: {} } }, { proactive: true });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(durablePending, 1);
  const response = sent.find((message) => message.id === 45);
  assert.equal(response.result.isError, false,
    "a completed durable commit must not be rewritten as definite not-committed");
  assert.deepEqual(JSON.parse(response.result.content[0].text), {
    status: "queued", operation_id: "race-1",
  });
});

test("proactive opt-in preflight and six-per-minute rate gate remain enforced", async () => {
  const makeServer = (allowed) => {
    const sent = []; const registry = new ToolRegistry(); let calls = 0;
    registry.registerSystemTool({
      name: "test.proactive", description: "proactive", proactive: true,
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    }, () => { calls++; return { ok: true, content: "done" }; });
    const server = new AssistantMcpServer({
      send: (msg) => sent.push(msg), isTurnActive: () => false,
      getTurnGeneration: () => null, profileId: "even-g2", connectionGeneration: "connection-rate",
      isConnectionGenerationActive: () => true, allowProactive: () => allowed, registry,
    });
    initialize(server);
    return { server, sent, calls: () => calls };
  };

  const off = makeServer(false);
  off.server.handleMessage({ jsonrpc: "2.0", id: 50, method: "tools/call",
    params: { name: "test.proactive", arguments: {} } }, { proactive: true });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(off.calls(), 0);
  assert.match(off.sent.find((message) => message.id === 50).result.content[0].text, /disabled in Settings/);

  const limited = makeServer(true);
  for (let index = 0; index < 7; index++) {
    const id = 60 + index;
    limited.server.handleMessage({ jsonrpc: "2.0", id, method: "tools/call",
      params: { name: "test.proactive", arguments: {} } }, { proactive: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.equal(limited.calls(), 6);
  const seventh = limited.sent.find((message) => message.id === 66);
  assert.equal(seventh.result.isError, true);
  assert.match(seventh.result.content[0].text, /rate limit/);
});
