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

test("an unanswered initial snapshot reaches deterministic unavailable state and recovers only through a fresh RPC", () => {
  let socket;
  const frames = [], timers = [];
  const endpoint = new HermesCompanionEndpoint({ gatewayUrl: "ws://localhost:9119", token: "private-loopback-token",
    createSocket: (url) => (socket = new FakeSocket(url)), reserveOperation: () => true, createOpaque: opaque,
    createRequestId: () => "snapshot_initial_timeout_1234", now: () => 1_000,
    snapshotTimeoutMs: 100,
    setSnapshotTimer: (callback, delay) => { const timer = { callback, delay, cleared: false }; timers.push(timer); return timer; },
    clearSnapshotTimer: (timer) => { timer.cleared = true; },
  });
  endpoint.start(); socket.open(); endpoint.attach("connection_phone_1234", (frame) => frames.push(frame));
  assert.equal(frames.length, 0, "an open gateway has until the bounded deadline to answer");
  assert.equal(timers[0].delay, 100);
  timers[0].callback();
  assert.equal(frames.at(-1).status, "unavailable");
  assert.equal(frames.at(-1).connection_generation, "connection_phone_1234");

  const afterTimeout = frames.length;
  socket.message({ jsonrpc: "2.0", id: "snapshot_initial_timeout_1234", result: providerSnapshot });
  assert.equal(frames.length, afterTimeout, "the timed-out initial reply cannot restore stale authority");

  const refresh = { v: 1, chan: "companion", connection_generation: "connection_phone_1234", type: "refresh",
    operation_id: "operation_recover_timeout_1234" };
  assert.equal(endpoint.handleCommand(refresh, "connection_phone_1234"), true);
  socket.message({ jsonrpc: "2.0", id: refresh.operation_id, result: providerSnapshot });
  assert.equal(frames.at(-2).status, "ready", "an explicit fresh request can recover after the deadline");
  assert.equal(frames.at(-1).outcome, "accepted");
  endpoint.stop();
});

test("snapshot deadlines and late replies are owned by the exact phone generation", () => {
  let socket;
  let requestSerial = 0;
  const firstFrames = [], secondFrames = [], timers = [];
  const endpoint = new HermesCompanionEndpoint({ gatewayUrl: "ws://localhost:9119", token: "private-loopback-token",
    createSocket: (url) => (socket = new FakeSocket(url)), reserveOperation: () => true, createOpaque: opaque,
    createRequestId: () => `snapshot_generation_${++requestSerial}_1234`, now: () => 1_000,
    snapshotTimeoutMs: 100,
    setSnapshotTimer: (callback) => { const timer = { callback, cleared: false }; timers.push(timer); return timer; },
    clearSnapshotTimer: (timer) => { timer.cleared = true; },
  });
  endpoint.start(); socket.open();
  endpoint.attach("connection_phone_first_1234", (frame) => firstFrames.push(frame));
  endpoint.attach("connection_phone_second_1234", (frame) => secondFrames.push(frame));
  assert.equal(timers[0].cleared, true);
  timers[0].callback();
  socket.message({ jsonrpc: "2.0", id: "snapshot_generation_1_1234", result: providerSnapshot });
  assert.equal(firstFrames.length, 0);
  assert.equal(secondFrames.length, 0, "retired generation work cannot publish into its replacement");
  socket.message({ jsonrpc: "2.0", id: "snapshot_generation_2_1234", result: providerSnapshot });
  assert.equal(secondFrames.at(-1).status, "ready");
  assert.equal(secondFrames.at(-1).connection_generation, "connection_phone_second_1234");
  endpoint.stop();
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
    params: { session_id: "provider-private-session", expected_generation: 2 } });
  socket.message({ jsonrpc: "2.0", id: "operation_cancel_1234",
    result: { accepted: true, matched_generation: 2 } });
  assert.equal(frames.at(-1).type, "operation_receipt");
  assert.equal(frames.at(-1).outcome, "accepted");
  assert.equal(endpoint.handleCommand({ ...command, operation_id: "operation_stale_12345" }, "connection_phone_OLD"), false);
  endpoint.detach("connection_phone_1234");
  assert.equal(endpoint.handleCommand({ ...command, operation_id: "operation_after_12345" }, "connection_phone_1234"), false);
});

test("authoritative capability and session state reject crafted commands with durable terminal receipts", () => {
  let socket;
  const frames = [], reserved = [], completed = [];
  const endpoint = new HermesCompanionEndpoint({ gatewayUrl: "ws://localhost:9119", token: "private-loopback-token",
    createSocket: (url) => (socket = new FakeSocket(url)), createOpaque: opaque,
    createRequestId: () => "snapshot_capability_1234", now: () => 1_000,
    reserveOperation: (record) => { reserved.push(record); return true; },
    completeOperation: (operationId, outcome) => { completed.push({ operationId, outcome }); return true; },
  });
  endpoint.start(); socket.open(); endpoint.attach("connection_phone_1234", (frame) => frames.push(frame));
  socket.message({ jsonrpc: "2.0", id: "snapshot_capability_1234", result: { ...providerSnapshot,
    capabilities: { ...providerSnapshot.capabilities, voice: false }, voice: undefined } });
  const projected = frames.at(-1);
  assert.equal(projected.capabilities.voice, false);

  const voice = { v: 1, chan: "companion", connection_generation: "connection_phone_1234",
    type: "new_voice_session", operation_id: "operation_voice_blocked_1234" };
  const sentBeforeVoice = socket.sent.length;
  assert.equal(endpoint.handleCommand(voice, "connection_phone_1234"), true);
  assert.equal(socket.sent.length, sentBeforeVoice, "voice:false must block crafted commands before gateway dispatch");
  assert.deepEqual(frames.at(-1), { v: 1, chan: "companion", type: "operation_receipt",
    connection_generation: "connection_phone_1234", sequence: projected.sequence + 1,
    operation_id: voice.operation_id, operation: voice.type, outcome: "rejected", code: "voice_unavailable" });
  assert.deepEqual(completed.at(-1), { operationId: voice.operation_id, outcome: "rejected" });
  assert.equal(endpoint.handleCommand(voice, "connection_phone_1234"), true);
  assert.equal(frames.at(-1).outcome, "rejected");
  assert.equal(frames.at(-1).code, "duplicate");
  assert.equal(socket.sent.length, sentBeforeVoice);

  const stale = { v: 1, chan: "companion", connection_generation: "connection_phone_1234",
    type: "cancel_session", operation_id: "operation_stale_blocked_1234",
    session_id: projected.sessions[0].session_id, generation: 1 };
  assert.equal(endpoint.handleCommand(stale, "connection_phone_1234"), true);
  assert.equal(frames.at(-1).outcome, "rejected");
  assert.equal(frames.at(-1).code, "stale_session");
  assert.equal(socket.sent.length, sentBeforeVoice);
  assert.equal(reserved.length, 2, "each terminal pre-dispatch rejection is durably tombstoned once");
  endpoint.stop();
});

test("gateway mutations need positive acknowledgements and refresh needs an authoritative snapshot", () => {
  let socket;
  let requestSerial = 0;
  const frames = [];
  const endpoint = new HermesCompanionEndpoint({ gatewayUrl: "ws://localhost:9119", token: "private-loopback-token",
    createSocket: (url) => (socket = new FakeSocket(url)), reserveOperation: () => true, createOpaque: opaque,
    createRequestId: () => `snapshot_strict_${++requestSerial}_1234`, now: () => 1_000 });
  endpoint.start(); socket.open(); endpoint.attach("connection_phone_1234", (frame) => frames.push(frame));
  socket.message({ jsonrpc: "2.0", id: "snapshot_strict_1_1234", result: providerSnapshot });

  const createVoice = (operationId) => ({ v: 1, chan: "companion", connection_generation: "connection_phone_1234",
    type: "new_voice_session", operation_id: operationId });
  for (const [operationId, result] of [
    ["operation_voice_null_1234", null],
    ["operation_voice_empty_1234", {}],
  ]) {
    const command = createVoice(operationId);
    assert.equal(endpoint.handleCommand(command, "connection_phone_1234"), true);
    socket.message({ jsonrpc: "2.0", id: operationId, result });
    assert.equal(frames.at(-1).outcome, "rejected");
    assert.equal(frames.at(-1).code, "operation_unconfirmed");
  }
  const ambiguousVoice = createVoice("operation_voice_ambiguous_1234");
  assert.equal(endpoint.handleCommand(ambiguousVoice, "connection_phone_1234"), true);
  socket.message({ jsonrpc: "2.0", id: ambiguousVoice.operation_id, result: { accepted: true }, error: null });
  assert.equal(frames.at(-1).outcome, "rejected", "a response carrying an error member is never a positive acknowledgement");
  assert.equal(frames.at(-1).code, "rpc_error");

  const acceptedVoice = createVoice("operation_voice_positive_1234");
  assert.equal(endpoint.handleCommand(acceptedVoice, "connection_phone_1234"), true);
  socket.message({ jsonrpc: "2.0", id: acceptedVoice.operation_id, result: { accepted: true } });
  assert.equal(frames.at(-1).outcome, "accepted", "a literal accepted:true is the positive creation acknowledgement");

  const refresh = (operationId) => ({ v: 1, chan: "companion", connection_generation: "connection_phone_1234",
    type: "refresh", operation_id: operationId });
  for (const [operationId, result] of [
    ["operation_refresh_null_1234", null],
    ["operation_refresh_empty_1234", {}],
  ]) {
    const command = refresh(operationId);
    assert.equal(endpoint.handleCommand(command, "connection_phone_1234"), true);
    socket.message({ jsonrpc: "2.0", id: operationId, result });
    assert.equal(frames.at(-2).status, "unavailable", "invalid refresh retires cached authority");
    assert.equal(frames.at(-1).outcome, "rejected");
    assert.equal(frames.at(-1).code, "invalid_snapshot");
  }
  const validRefresh = refresh("operation_refresh_valid_1234");
  assert.equal(endpoint.handleCommand(validRefresh, "connection_phone_1234"), true);
  socket.message({ jsonrpc: "2.0", id: validRefresh.operation_id, result: providerSnapshot });
  assert.equal(frames.at(-2).status, "ready");
  assert.equal(frames.at(-1).outcome, "accepted");
  endpoint.stop();
});

test("offline rejection is durably replayed and can never dispatch after recovery", () => {
  let socket;
  const frames = [];
  const endpoint = new HermesCompanionEndpoint({ gatewayUrl: "wss://[::1]:9119", token: "private-loopback-token",
    createSocket: (url) => (socket = new FakeSocket(url)), reserveOperation: () => true,
    createRequestId: () => "snapshot_request_1234", now: () => 1_000 });
  endpoint.start(); endpoint.attach("connection_phone_1234", (frame) => frames.push(frame));
  assert.equal(frames.at(-1).status, "unavailable");
  const refresh = { v: 1, chan: "companion", connection_generation: "connection_phone_1234",
    type: "refresh", operation_id: "operation_refresh_1234" };
  assert.equal(endpoint.handleCommand(refresh, "connection_phone_1234"), true);
  assert.equal(frames.at(-1).type, "operation_receipt");
  assert.equal(frames.at(-1).code, "backend_offline");
  socket.open();
  const sentAfterOpen = socket.sent.length;
  assert.equal(endpoint.handleCommand(refresh, "connection_phone_1234"), true);
  assert.equal(frames.at(-1).code, "duplicate");
  assert.equal(frames.at(-1).outcome, "rejected");
  assert.equal(socket.sent.length, sentAfterOpen, "offline tombstone replay must not reach the gateway");
  endpoint.stop();
});

test("unconfirmed generation CAS and timed-out RPCs fail closed and suppress late replies", () => {
  let socket;
  let timeoutCallback = null;
  let requestSerial = 0;
  const frames = [];
  const endpoint = new HermesCompanionEndpoint({ gatewayUrl: "ws://localhost:9119", token: "private-loopback-token",
    createSocket: (url) => (socket = new FakeSocket(url)), reserveOperation: () => true,
    createOpaque: opaque, createRequestId: () => `snapshot_timeout_${++requestSerial}_1234`, now: () => 1_000,
    commandTimeoutMs: 100, setCommandTimer: (callback) => { timeoutCallback = callback; return { id: 1 }; },
    clearCommandTimer: () => {},
  });
  endpoint.start(); socket.open(); endpoint.attach("connection_phone_1234", (frame) => frames.push(frame));
  socket.message({ jsonrpc: "2.0", id: "snapshot_timeout_1_1234", result: providerSnapshot });
  const session = frames.at(-1).sessions[0];
  const first = { v: 1, chan: "companion", connection_generation: "connection_phone_1234", type: "cancel_session",
    operation_id: "operation_uncas_1234", session_id: session.session_id, generation: 2 };
  assert.equal(endpoint.handleCommand(first, "connection_phone_1234"), true);
  socket.message({ jsonrpc: "2.0", id: first.operation_id, result: { accepted: true } });
  assert.equal(frames.at(-1).outcome, "rejected");
  assert.equal(frames.at(-1).code, "generation_unconfirmed");

  const second = { ...first, operation_id: "operation_timeout_1234" };
  assert.equal(endpoint.handleCommand(second, "connection_phone_1234"), true);
  timeoutCallback();
  assert.equal(frames.at(-1).outcome, "outcome_unknown");
  assert.equal(frames.at(-1).code, "gateway_timeout");
  const frameCount = frames.length;
  socket.message({ jsonrpc: "2.0", id: second.operation_id,
    result: { accepted: true, matched_generation: 2 } });
  assert.equal(frames.length, frameCount, "late gateway completion must be ignored after timeout");
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
