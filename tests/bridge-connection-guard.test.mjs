import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
const source = readFileSync(new URL("../app/assistant/bridge-connection-guard.ts", import.meta.url), "utf8");
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 } }).outputText;
const { BridgeConnectionGuard } = await import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));

test("privileged bridge traffic requires current-generation authentication", () => {
  const guard = new BridgeConnectionGuard();
  const generation = guard.beginConnection();
  assert.equal(guard.canHandlePrivileged(generation), false);
  assert.equal(guard.authenticate(generation), true);
  assert.equal(guard.canHandlePrivileged(generation), true);
});

test("replaced and closed generations stay rejected", () => {
  const guard = new BridgeConnectionGuard();
  const old = guard.beginConnection(); guard.authenticate(old);
  const current = guard.beginConnection();
  assert.equal(guard.authenticate(old), false);
  assert.equal(guard.canHandlePrivileged(old), false);
  guard.authenticate(current);
  assert.equal(guard.invalidate(current), true);
  assert.equal(guard.canHandlePrivileged(current), false);
});

test("bridge callbacks and privileged channels use the guard", () => {
  const client = readFileSync(new URL("../app/assistant/bridge-client.ts", import.meta.url), "utf8");
  assert.match(client, /const generation = this\.connectionGuard\.beginConnection\(\)/);
  assert.match(client, /isCurrentSocket\(generation, socket\)/);
  assert.match(client, /handleMessage\(String\(message\), generation\)/);
  assert.match(client, /case "chat":\s*\n\s*return; \/\/ Legacy custom turns are never an authority path\./);
  assert.match(client, /case "mcp":\s*\n\s*if \(!this\.requireAuthenticated\(generation\)\) return/);
  assert.match(client, /case "host-mcp":\s*\n\s*if \(!this\.requireAuthenticated\(generation\)\) return/);
  assert.match(client, /case "cockpit":\s*\n\s*return; \/\/ Cockpit state is read only through Host MCP resources\./);
  assert.match(client, /case "companion":\s*\n\s*return; \/\/ No legacy Companion command channel in the MCP-only bridge\./);
  assert.match(client, /send: \(msg\) => this\.sendMcpForSocket\(generation, socket, msg\)/);
  assert.match(client, /this\.mcpServer\?\.close\(\)/);
  assert.match(client, /AUTH_TIMEOUT_MS = 15_000/);
  assert.match(client, /frame\.v !== PROTOCOL_VERSION/);
  assert.match(client, /close\(1002, "protocol version mismatch"\)/);
});
