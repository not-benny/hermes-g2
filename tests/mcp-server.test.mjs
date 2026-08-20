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
    allowProactive: () => false, registry });
  return { server, sent, calls: () => calls };
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
  const { server, sent, calls } = setup();
  server.handleMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  server.handleMessage({ jsonrpc: "2.0", method: "notifications/initialized" });
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
    allowProactive: () => false, registry });
  server.handleMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  server.handleMessage({ jsonrpc: "2.0", method: "notifications/initialized" });
  const call = { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "test.slow", arguments: {} } };
  server.handleMessage(call); server.handleMessage(call);
  assert.equal(calls, 1); assert.equal(sent.at(-1).error.code, -32600);
  const beforeClose = sent.length;
  server.close(); finish({ ok: true, content: "late" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(sent.length, beforeClose);
});
