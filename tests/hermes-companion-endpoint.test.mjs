import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { HermesCompanionEndpoint } from "../tools/hermes-companion-endpoint.mjs";

class FakeSocket {
  constructor(url) { this.url = url; this.readyState = 0; this.sent = []; }
  addEventListener(type, listener) { this[`on_${type}`] = listener; }
  open() { this.readyState = 1; this.on_open?.({}); }
  message(value) { this.on_message?.({ data: JSON.stringify(value) }); }
  close() { this.readyState = 3; this.on_close?.({}); }
  send(value) { this.sent.push(JSON.parse(value)); }
}
const opaque = (prefix, source) => `${prefix}_${createHash("sha256").update(String(source)).digest("hex").slice(0, 24)}`;
const providerSnapshot = { status: "ready", metadata_redacted: true, model: "hermes-3", profile: "voice",
  last_connected_at_ms: 900, capabilities: { voice: true, usage: false, cost: false, tool_activity: true },
  sessions: [{ id: "provider-private-session", generation: 2, title: "Safe", title_redacted: true,
    state: "active", updated_at_ms: 950, resumable: false }],
  voice: { utterance_count: 1, audio_ms: 1000, stt_provider: "local", capture_state: "idle", recent_failures: [] },
  tool_activity: [{ id: "provider-tool", label: "Tool", redacted: true, status: "done", updated_at_ms: 990,
    payload: "privacy-sentinel-payload" }], recent_errors: [] };

test("endpoint is loopback-only, attaches an authenticated generation, and exposes no listener", () => {
  let socket;
  const frames = [];
  const endpoint = new HermesCompanionEndpoint({ gatewayUrl: "ws://127.0.0.1:9119/private", token: "privacy-sentinel-token",
    createSocket: (url) => (socket = new FakeSocket(url)), reserveOperation: () => true,
    createRequestId: () => "snapshot_request_1234", createOpaque: opaque, now: () => 1_000 });
  endpoint.start();
  assert.match(socket.url, /^ws:\/\/127\.0\.0\.1:9119\/private\?token=/);
  endpoint.attach("connection_phone_1234", (frame) => frames.push(frame));
  assert.equal(frames[0].status, "unavailable");
  socket.open();
  assert.deepEqual(socket.sent.at(-1), { jsonrpc: "2.0", id: "snapshot_request_1234", method: "companion.snapshot",
    params: { limits: { sessions: 20, tool_activity: 12, errors: 5 }, redacted: true } });
  socket.message({ jsonrpc: "2.0", id: "snapshot_request_1234", result: providerSnapshot });
  assert.equal(frames.at(-1).status, "ready");
  assert.equal(frames.at(-1).connection_generation, "connection_phone_1234");
  assert.equal(JSON.stringify(frames).includes("provider-private-session"), false);
  assert.equal(JSON.stringify(frames).includes("privacy-sentinel"), false);
  assert.equal("listen" in endpoint, false);
  assert.throws(() => new HermesCompanionEndpoint({ gatewayUrl: "ws://192.0.2.1:9119", token: "x", reserveOperation: () => true }));
});

test("endpoint dispatches exact operations, emits ordered receipts, and rejects stale generations", () => {
  let socket;
  let requestSerial = 0;
  const frames = [];
  const endpoint = new HermesCompanionEndpoint({ gatewayUrl: "ws://localhost:9119", token: "private-loopback-token",
    createSocket: (url) => (socket = new FakeSocket(url)), reserveOperation: () => true, createOpaque: opaque,
    createRequestId: () => `snapshot_request_${++requestSerial}_1234`, now: () => 1_000 });
  endpoint.start(); socket.open(); endpoint.attach("connection_phone_1234", (frame) => frames.push(frame));
  socket.message({ jsonrpc: "2.0", id: "snapshot_request_1_1234", result: providerSnapshot });
  const session = frames.at(-1).sessions[0];
  const command = { v: 1, chan: "companion", connection_generation: "connection_phone_1234", type: "cancel_session",
    operation_id: "operation_cancel_1234", session_id: session.session_id, generation: 2 };
  assert.equal(endpoint.handleCommand(command, "connection_phone_1234"), true);
  assert.deepEqual(socket.sent.at(-1), { jsonrpc: "2.0", id: "operation_cancel_1234", method: "session.cancel",
    params: { session_id: "provider-private-session" } });
  socket.message({ jsonrpc: "2.0", id: "operation_cancel_1234", result: { accepted: true } });
  assert.equal(frames.at(-1).type, "operation_receipt");
  assert.equal(frames.at(-1).outcome, "accepted");
  assert.equal(endpoint.handleCommand({ ...command, operation_id: "operation_stale_12345" }, "connection_phone_OLD"), false);
  endpoint.detach("connection_phone_1234");
  assert.equal(endpoint.handleCommand({ ...command, operation_id: "operation_after_12345" }, "connection_phone_1234"), false);
});

test("gateway loss produces an unavailable snapshot and deterministic rejected operation", () => {
  let socket;
  const frames = [];
  const endpoint = new HermesCompanionEndpoint({ gatewayUrl: "wss://[::1]:9119", token: "private-loopback-token",
    createSocket: (url) => (socket = new FakeSocket(url)), reserveOperation: () => true,
    createRequestId: () => "snapshot_request_1234", now: () => 1_000 });
  endpoint.start(); socket.open(); endpoint.attach("connection_phone_1234", (frame) => frames.push(frame));
  socket.close();
  assert.equal(frames.at(-1).status, "unavailable");
  const refresh = { v: 1, chan: "companion", connection_generation: "connection_phone_1234",
    type: "refresh", operation_id: "operation_refresh_1234" };
  assert.equal(endpoint.handleCommand(refresh, "connection_phone_1234"), true);
  assert.equal(frames.at(-1).type, "operation_receipt");
  assert.equal(frames.at(-1).code, "backend_offline");
  endpoint.stop();
});

test("gateway reconnect keeps the authenticated phone generation and refreshes authority", () => {
  const sockets = [], scheduled = [], frames = [];
  let requestSerial = 0;
  const endpoint = new HermesCompanionEndpoint({ gatewayUrl: "ws://localhost:9119", token: "private-loopback-token",
    createSocket: (url) => { const socket = new FakeSocket(url); sockets.push(socket); return socket; },
    reserveOperation: () => true, createOpaque: opaque, now: () => 1_000,
    createRequestId: () => `snapshot_reconnect_${++requestSerial}_1234`,
    setReconnectTimer: (callback, delay) => { const timer = { callback, delay }; scheduled.push(timer); return timer; },
    clearReconnectTimer: () => {},
  });
  endpoint.start(); sockets[0].open();
  endpoint.attach("connection_phone_1234", (frame) => frames.push(frame));
  sockets[0].message({ jsonrpc: "2.0", id: "snapshot_reconnect_1_1234", result: providerSnapshot });
  sockets[0].close();
  assert.equal(frames.at(-1).status, "unavailable");
  assert.equal(scheduled[0].delay, 1_000);
  scheduled[0].callback();
  sockets[1].open();
  sockets[1].message({ jsonrpc: "2.0", id: "snapshot_reconnect_2_1234", result: providerSnapshot });
  assert.equal(frames.at(-1).status, "ready");
  assert.equal(frames.at(-1).connection_generation, "connection_phone_1234");
  endpoint.stop();
});
