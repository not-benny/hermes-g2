import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WebSocket } from "hermes-private-ws";

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
