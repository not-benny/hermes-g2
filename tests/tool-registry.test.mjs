import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
const source = readFileSync(new URL("../app/assistant/tool-registry.ts", import.meta.url), "utf8");
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 } }).outputText;
const { ToolRegistry } = await import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));

test("registry enforces advertised schemas before handlers", async () => {
  const registry = new ToolRegistry(); let calls = 0;
  registry.registerSystemTool({ name: "test.write", description: "test", inputSchema: {
    type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false,
  } }, () => { calls++; return { ok: true, content: "done" }; });
  assert.equal((await registry.callTool("test.write", { text: 7 })).ok, false);
  assert.equal((await registry.callTool("test.write", { text: "ok", extra: true })).ok, false);
  assert.equal(calls, 0);
  assert.equal((await registry.callTool("test.write", { text: "ok" })).ok, true);
});

test("stale same-window generation cannot delete its replacement", async () => {
  const registry = new ToolRegistry();
  let changes = 0;
  registry.onToolsChanged(() => { changes++; });
  const provider = (windowId, value) => ({ windowId, appId: "same",
    specs: [{ name: "do", description: "do", inputSchema: { type: "object", properties: {}, additionalProperties: false }, availability: "open" }],
    invoke: () => ({ ok: true, content: value }), isForeground: () => true });
  const oldLease = registry.setAppTools(provider("reused", "old"));
  const newLease = registry.setAppTools(provider("reused", "new"));
  assert.equal((await registry.callTool("app.same.do", {})).content, "new");
  registry.removeAppTools("reused", oldLease);
  assert.equal((await registry.callTool("app.same.do", {})).content, "new");
  assert.equal(changes, 2);
  registry.removeAppTools("reused", newLease);
  assert.match((await registry.callTool("app.same.do", {})).error, /Unknown tool/);
  assert.equal(changes, 3);
  registry.removeAppTools("reused", newLease);
  assert.equal(changes, 3);

  const fallback = new ToolRegistry();
  const oldWindowLease = fallback.setAppTools(provider("old", "old"));
  const newWindowLease = fallback.setAppTools(provider("new", "new"));
  fallback.removeAppTools("new", newWindowLease);
  assert.equal((await fallback.callTool("app.same.do", {})).content, "old");
  fallback.removeAppTools("old", oldWindowLease);
});

test("unsupported JSON Schema keywords fail closed", async () => {
  const registry = new ToolRegistry(); let called = false;
  registry.registerSystemTool({ name: "test.schema", description: "test", inputSchema: { anyOf: [{ type: "string" }] } },
    () => { called = true; return { ok: true }; });
  const result = await registry.callTool("test.schema", 7);
  assert.equal(result.ok, false); assert.match(result.error, /unsupported schema keyword anyOf/); assert.equal(called, false);
});

test("array bounds and schema-valued additional properties are enforced", async () => {
  const registry = new ToolRegistry(); let calls = 0;
  registry.registerSystemTool({ name: "test.complex", description: "test", inputSchema: {
    type: "object",
    properties: { tags: { type: "array", minItems: 2, maxItems: 3, items: { type: "string" } } },
    required: ["tags"], additionalProperties: { type: "string" },
  } }, () => { calls++; return { ok: true }; });
  assert.equal((await registry.callTool("test.complex", { tags: [] })).ok, false);
  assert.equal((await registry.callTool("test.complex", { tags: ["a", "b"], extra: 7 })).ok, false);
  assert.equal((await registry.callTool("test.complex", { tags: ["a", "b"], extra: "ok" })).ok, true);
  assert.equal(calls, 1);
});

test("availability failures fail closed without throwing", async () => {
  const registry = new ToolRegistry();
  registry.register({ spec: { name: "test.flaky", description: "test", inputSchema: { type: "object", properties: {} }, availability: "always" },
    handler: () => ({ ok: true }), isAvailable: () => { throw new Error("boom"); } });
  const warn = console.warn; console.warn = () => {};
  try { assert.deepEqual(registry.listTools(), []); } finally { console.warn = warn; }
  const result = await registry.callTool("test.flaky", {});
  assert.equal(result.ok, false); assert.match(result.error, /availability check failed/);
});
