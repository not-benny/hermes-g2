import assert from "node:assert/strict";
import test from "node:test";

const { HermesCockpitEndpoint } = await import(new URL("../tools/hermes-cockpit-endpoint.mjs", import.meta.url));

class FakeSocket {
  static OPEN = 1;
  constructor(url) { this.url = url; this.readyState = 0; this.sent = []; }
  addEventListener(type, listener) { this[`on_${type}`] = listener; }
  open() { this.readyState = 1; this.on_open?.({}); }
  message(value) { this.on_message?.({ data: JSON.stringify(value) }); }
  close() { this.readyState = 3; this.on_close?.({}); }
  send(value) { this.sent.push(JSON.parse(value)); }
}

test("endpoint connects only to loopback Hermes WS and emits an explicit-share snapshot", () => {
  const frames = [];
  let socket;
  const endpoint = new HermesCockpitEndpoint({
    gatewayUrl: "ws://127.0.0.1:9119/api/ws",
    token: "privacy-sentinel-token",
    shares: [{ publicSessionId: "session_public_1234", hermesSessionId: "private-session", generation: 8, title: "Disposable" }],
    createSocket: (url) => (socket = new FakeSocket(url)),
    emit: (frame) => frames.push(frame),
    createConnectionGeneration: () => "connection_endpoint_1",
  });
  endpoint.start();
  assert.match(socket.url, /^ws:\/\/127\.0\.0\.1:9119\/api\/ws\?token=/);
  socket.open();
  assert.equal(frames[0].type, "snapshot");
  assert.equal(frames[0].connection_generation, "connection_endpoint_1");
  assert.equal(frames[0].sessions[0].session_id, "session_public_1234");
  assert.equal(JSON.stringify(frames).includes("private-session"), false);
  assert.equal(JSON.stringify(frames).includes("privacy-sentinel-token"), false);
  assert.throws(() => new HermesCockpitEndpoint({ gatewayUrl: "ws://192.0.2.1:9119/api/ws", token: "x", shares: [], createSocket: () => {}, emit: () => {} }));
});

test("endpoint projects generation-bound events and dispatches exact commands with receipts", () => {
  const frames = [];
  let socket;
  const endpoint = new HermesCockpitEndpoint({
    gatewayUrl: "ws://localhost:9119/api/ws", token: "token", now: () => 1000,
    shares: [{ publicSessionId: "session_public_1234", hermesSessionId: "private-session", generation: 8, title: "Disposable" }],
    createSocket: (url) => (socket = new FakeSocket(url)), emit: (frame) => frames.push(frame),
    createConnectionGeneration: () => "connection_endpoint_1",
  });
  endpoint.start(); socket.open();
  socket.message({ jsonrpc: "2.0", method: "event", params: {
    type: "tool.start", session_id: "private-session", data: { name: "read_file", args: { secret: "privacy-sentinel" } },
  } });
  assert.equal(frames.at(-1).type, "timeline_append");
  assert.equal(JSON.stringify(frames.at(-1)).includes("privacy-sentinel"), false);

  const command = { v: 1, chan: "cockpit", type: "steer", command_id: "command_endpoint_1",
    connection_generation: "connection_endpoint_1", session_id: "session_public_1234", generation: 8, text: "Run focused tests" };
  assert.equal(endpoint.handleCommand(command), true);
  assert.deepEqual(socket.sent.at(-1), { jsonrpc: "2.0", id: "command_endpoint_1", method: "session.steer",
    params: { session_id: "private-session", text: "Run focused tests" } });
  socket.message({ jsonrpc: "2.0", id: "command_endpoint_1", result: { accepted: true } });
  assert.equal(frames.at(-1).type, "command_receipt");
  assert.equal(frames.at(-1).outcome, "accepted");
});

test("socket loss revokes commands and a successor gets a fresh connection generation", () => {
  const frames = [];
  const sockets = [];
  const generations = ["connection_endpoint_1", "connection_endpoint_2"];
  const endpoint = new HermesCockpitEndpoint({
    gatewayUrl: "ws://localhost:9119/api/ws", token: "token",
    shares: [{ publicSessionId: "session_public_1234", hermesSessionId: "private-session", generation: 8, title: "Disposable" }],
    createSocket: (url) => { const socket = new FakeSocket(url); sockets.push(socket); return socket; },
    emit: (frame) => frames.push(frame), createConnectionGeneration: () => generations.shift(),
  });
  endpoint.start(); sockets[0].open(); sockets[0].close();
  assert.equal(endpoint.handleCommand({ v: 1, chan: "cockpit", type: "interrupt", command_id: "command_old_conn_1",
    connection_generation: "connection_endpoint_1", session_id: "session_public_1234", generation: 8 }), false);
  endpoint.start(); sockets[1].open();
  assert.equal(frames.at(-1).connection_generation, "connection_endpoint_2");
});
