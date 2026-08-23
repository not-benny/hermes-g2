import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WebSocket, WebSocketServer } from "hermes-private-ws";

const entry = new URL("../hermes-host/private-dynamic-ha-server.mjs", import.meta.url).pathname;
const timeout = (ms, message) => new Promise((_, reject) => {
  const timer = setTimeout(() => reject(new Error(message)), ms);
  timer.unref();
});

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function makeCertificate(directory, name) {
  const key = join(directory, `${name}.key`);
  const cert = join(directory, `${name}.crt`);
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", key, "-out", cert],
  { stdio: "ignore" });
  return { key, cert };
}

async function waitReady(child) {
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { output += chunk; });
  await Promise.race([
    new Promise((resolve, reject) => {
      const check = () => output.includes("WSS server ready") && resolve();
      child.stdout.on("data", check);
      child.once("exit", (code) => reject(new Error(`server exited ${code}`)));
      check();
    }),
    timeout(5_000, "server readiness timed out"),
  ]);
}

async function connect(url, ca) {
  const socket = new WebSocket(url, { ca, rejectUnauthorized: true });
  await Promise.race([new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); }), timeout(5_000, "WSS connect timed out")]);
  return socket;
}

async function connectAsWrongHost(port, ca) {
  const socket = new WebSocket(`wss://wrong-host.invalid:${port}`, {
    ca,
    rejectUnauthorized: true,
    lookup: (_hostname, _options, callback) => callback(null, "127.0.0.1", 4),
  });
  await Promise.race([new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); }), timeout(5_000, "wrong-host WSS connect timed out")]);
  return socket;
}

function frameQueue(socket) {
  const frames = [];
  const waiters = [];
  socket.on("message", (data) => {
    let frame;
    try { frame = JSON.parse(data.toString("utf8")); } catch { return; }
    frames.push(frame);
    for (const wake of waiters.splice(0)) wake();
  });
  return async (predicate) => {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const index = frames.findIndex(predicate);
      if (index >= 0) return frames.splice(index, 1)[0];
      await Promise.race([new Promise((resolve) => waiters.push(resolve)), timeout(Math.max(1, deadline - Date.now()), "frame timed out")]);
    }
    throw new Error("frame timed out");
  };
}

test("private WSS accepts the configured CA/IP identity and rejects a foreign CA before hello", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hermes-g2-wss-"));
  const trusted = makeCertificate(directory, "trusted");
  const foreign = makeCertificate(directory, "foreign");
  const port = await freePort();
  const child = spawn(process.execPath, [entry], {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      PRIVATE_BRIDGE_BIND_HOST: "127.0.0.1", PRIVATE_BRIDGE_PORT: String(port),
      PRIVATE_BRIDGE_TLS_CERT: trusted.cert, PRIVATE_BRIDGE_TLS_KEY: trusted.key,
      PRIVATE_BRIDGE_TOKEN: "correct-private-token", HA_URL: "https://ha.invalid",
      HA_TOKEN: "private-ha-token", HA_ATOMIC_MUTATION_PATH: "/api/hermes_g2/safe_set_power",
      HA_MUTATION_LEDGER_PATH: join(directory, "ledger.json"), HA_ALLOW_MUTATION: "I_UNDERSTAND",
      PRIVATE_EVALUATION_RESTORE: "REQUIRED",
    },
  });
  t.after(async () => {
    if (child.exitCode === null) child.kill("SIGTERM");
    await Promise.race([new Promise((resolve) => child.once("exit", resolve)), timeout(2_000, "server stop timed out")]).catch(() => child.kill("SIGKILL"));
    await rm(directory, { recursive: true, force: true });
  });
  await waitReady(child);
  const ca = await readFile(trusted.cert);
  const socket = await connect(`wss://127.0.0.1:${port}`, ca);
  const ack = new Promise((resolve, reject) => {
    socket.once("message", (data) => resolve(JSON.parse(data.toString("utf8"))));
    socket.once("error", reject);
  });
  socket.send(JSON.stringify({ v: 1, chan: "ctl", type: "hello", version: 1, token: "correct-private-token",
    deviceName: "Hermes G2", capabilities: ["chat", "mcp"] }));
  assert.equal((await Promise.race([ack, timeout(5_000, "hello ack timed out")])).type, "hello-ack");

  const intruder = await connect(`wss://127.0.0.1:${port}`, ca);
  const intruderClosed = new Promise((resolve) => intruder.once("close", resolve));
  intruder.send(JSON.stringify({ v: 1, chan: "ctl", type: "hello", version: 1, token: "wrong-private-token",
    deviceName: "Other", capabilities: ["chat", "mcp"] }));
  await Promise.race([intruderClosed, timeout(5_000, "unauthenticated socket was not closed")]);
  const pong = new Promise((resolve) => socket.once("message", (data) => resolve(JSON.parse(data.toString("utf8")))));
  socket.send(JSON.stringify({ v: 1, chan: "ctl", type: "ping", ts: 123 }));
  assert.equal((await Promise.race([pong, timeout(5_000, "authenticated socket was evicted")])).type, "pong");
  socket.close();
  await new Promise((resolve) => socket.once("close", resolve));

  const foreignCa = await readFile(foreign.cert);
  await assert.rejects(() => connect(`wss://127.0.0.1:${port}`, foreignCa), /certificate|self-signed|verify/i);
  await assert.rejects(() => connectAsWrongHost(port, ca), /hostname|not cert|IP address/i);
});

test("authenticated private WSS carries bounded companion list, resume, new voice, and usage RPCs", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hermes-g2-companion-wss-"));
  const trusted = makeCertificate(directory, "trusted");
  const bridgePort = await freePort();
  let gatewayPort = await freePort();
  if (gatewayPort === bridgePort) gatewayPort = await freePort();
  const methods = [];
  let gatewayTokenSeen = false;
  const gateway = new WebSocketServer({ host: "127.0.0.1", port: gatewayPort });
  await Promise.race([new Promise((resolve, reject) => {
    gateway.once("listening", resolve); gateway.once("error", reject);
  }), timeout(5_000, "gateway readiness timed out")]);
  const providerSnapshot = {
    status: "ready", metadata_redacted: true, model: "hermes-private", profile: "voice",
    last_connected_at_ms: Date.now(), capabilities: { voice: true, usage: true, cost: true, tool_activity: true },
    sessions: [{ id: "provider-private-session", generation: 4, title: "Safe recent session", title_redacted: true,
      state: "completed", updated_at_ms: Date.now(), resumable: true, prompt: "privacy-sentinel-prompt" }],
    voice: { utterance_count: 2, audio_ms: 2_000, stt_provider: "local", capture_state: "idle", recent_failures: [] },
    usage: { currency: "GBP", day: { input_tokens: 10, output_tokens: 20, cost_micros: 100 },
      seven_days: { input_tokens: 100, output_tokens: 200, cost_micros: 1_000 } },
    tool_activity: [{ id: "private-tool", label: "Read file", redacted: true, status: "done",
      updated_at_ms: Date.now(), payload: "privacy-sentinel-payload" }], recent_errors: [],
  };
  gateway.on("connection", (socket, request) => {
    gatewayTokenSeen = new URL(request.url, "ws://127.0.0.1").searchParams.get("token") === "private-gateway-token";
    socket.on("message", (data) => {
      const rpc = JSON.parse(data.toString("utf8"));
      methods.push(rpc.method);
      if (rpc.method === "companion.snapshot") socket.send(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: providerSnapshot }));
      else socket.send(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: { accepted: true,
        ...(Number.isSafeInteger(rpc.params?.expected_generation)
          ? { matched_generation: rpc.params.expected_generation } : {}) } }));
    });
  });

  const child = spawn(process.execPath, [entry], {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      PRIVATE_BRIDGE_BIND_HOST: "127.0.0.1", PRIVATE_BRIDGE_PORT: String(bridgePort),
      PRIVATE_BRIDGE_TLS_CERT: trusted.cert, PRIVATE_BRIDGE_TLS_KEY: trusted.key,
      PRIVATE_BRIDGE_TOKEN: "correct-private-token", HA_URL: "https://ha.invalid",
      HA_TOKEN: "private-ha-token", HA_ATOMIC_MUTATION_PATH: "/api/hermes_g2/safe_set_power",
      HA_MUTATION_LEDGER_PATH: join(directory, "ha-ledger.json"), HA_ALLOW_MUTATION: "I_UNDERSTAND",
      PRIVATE_EVALUATION_RESTORE: "REQUIRED",
      HERMES_COMPANION_GATEWAY_URL: `ws://127.0.0.1:${gatewayPort}`,
      HERMES_COMPANION_GATEWAY_TOKEN: "private-gateway-token",
      HERMES_COMPANION_JOURNAL_PATH: join(directory, "companion-operations.json"),
    },
  });
  t.after(async () => {
    if (child.exitCode === null) child.kill("SIGTERM");
    await Promise.race([new Promise((resolve) => child.once("exit", resolve)), timeout(2_000, "server stop timed out")]).catch(() => child.kill("SIGKILL"));
    await new Promise((resolve) => gateway.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  await waitReady(child);
  const socket = await connect(`wss://127.0.0.1:${bridgePort}`, await readFile(trusted.cert));
  const nextFrame = frameQueue(socket);
  socket.send(JSON.stringify({ v: 1, chan: "ctl", type: "hello", version: 1, token: "correct-private-token",
    deviceName: "Hermes G2", capabilities: ["chat", "mcp", "hermes-companion-v1"] }));
  const ack = await nextFrame((frame) => frame.type === "hello-ack");
  assert.deepEqual(ack.capabilities, ["hermes-companion-v1"]);
  const snapshot = await nextFrame((frame) => frame.chan === "companion" && frame.type === "snapshot" && frame.status === "ready");
  assert.equal(snapshot.sessions.length, 1);
  assert.equal(snapshot.usage.day.total_tokens, 30);
  assert.equal(gatewayTokenSeen, true);
  assert.equal(JSON.stringify(snapshot).includes("provider-private-session"), false);
  assert.equal(JSON.stringify(snapshot).includes("privacy-sentinel"), false);

  socket.send(JSON.stringify({ v: 1, chan: "companion", type: "resume_session",
    connection_generation: snapshot.connection_generation, operation_id: "operation_resume_1234",
    session_id: snapshot.sessions[0].session_id, generation: 4 }));
  const resume = await nextFrame((frame) => frame.type === "operation_receipt" && frame.operation_id === "operation_resume_1234");
  assert.equal(resume.outcome, "accepted");
  socket.send(JSON.stringify({ v: 1, chan: "companion", type: "new_voice_session",
    connection_generation: snapshot.connection_generation, operation_id: "operation_voice_12345" }));
  const voice = await nextFrame((frame) => frame.type === "operation_receipt" && frame.operation_id === "operation_voice_12345");
  assert.equal(voice.outcome, "accepted");
  assert.equal(methods.includes("session.resume"), true);
  assert.equal(methods.includes("session.create"), true);
  socket.close();
  await new Promise((resolve) => socket.once("close", resolve));
});
