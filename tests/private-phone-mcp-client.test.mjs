import assert from "node:assert/strict";
import test from "node:test";
import { PrivatePhoneMcpClient } from "../hermes-host/private-phone-mcp-client.mjs";

function setup() {
  const frames = [];
  const client = new PrivatePhoneMcpClient({
    turnId: "turn-1",
    connectionGeneration: "connection-1",
    send: (frame) => frames.push(structuredClone(frame)),
    requestTimeoutMs: 1_000,
  });
  return { client, frames };
}

test("private phone MCP client negotiates the exact protocol and turn-binds tool calls", async () => {
  const { client, frames } = setup();
  const initializing = client.initialize();
  assert.equal(frames[0].chan, "mcp");
  assert.equal(frames[0].turnId, "turn-1");
  assert.equal(frames[0].msg.method, "initialize");
  client.receive({ jsonrpc: "2.0", id: frames[0].msg.id, result: { protocolVersion: "2025-06-18", capabilities: {} } });
  await initializing;
  assert.equal(frames[1].msg.method, "notifications/initialized");

  const pending = client.callTool("glasses.dynamic_apps.capabilities", {});
  const request = frames.at(-1);
  assert.equal(request.turnId, "turn-1");
  assert.equal(request.msg.params.name, "glasses.dynamic_apps.capabilities");
  client.receive({ jsonrpc: "2.0", id: request.msg.id, result: { content: [{ type: "text", text: "{\"ok\":true}" }], isError: false } });
  assert.deepEqual(await pending, { ok: true });
});

test("close rejects pending calls and stale or unknown replies cannot reach a replacement", async () => {
  const { client, frames } = setup();
  const pending = client.callTool("glasses.dynamic_apps.capabilities", {});
  const oldId = frames[0].msg.id;
  client.close("connection replaced");
  await assert.rejects(() => pending, /replaced/i);
  assert.equal(client.receive({ jsonrpc: "2.0", id: oldId, result: {} }), false);

  const replacementFrames = [];
  const replacement = new PrivatePhoneMcpClient({ turnId: "turn-2", connectionGeneration: "connection-2", send: (frame) => replacementFrames.push(frame) });
  assert.equal(replacement.receive({ jsonrpc: "2.0", id: oldId, result: {} }), false);
});

test("tool errors and malformed payloads fail closed without leaking raw provider text", async () => {
  const { client, frames } = setup();
  const pending = client.callTool("glasses.dynamic_apps.create", {});
  const id = frames[0].msg.id;
  client.receive({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "bounded failure" }], isError: true } });
  await assert.rejects(() => pending, /phone tool failed/i);

  const malformed = client.callTool("glasses.dynamic_apps.create", {});
  client.receive({ jsonrpc: "2.0", id: frames.at(-1).msg.id, result: { content: [{ type: "image", data: "secret" }] } });
  await assert.rejects(() => malformed, /malformed/i);
});
