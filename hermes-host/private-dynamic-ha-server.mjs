#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:https";
import { isIP } from "node:net";
import { pathToFileURL } from "node:url";
import { WebSocket, WebSocketServer } from "hermes-private-ws";
import { acquireDurableLedgerLease, DurableMutationLedger } from "./durable-mutation-ledger.mjs";
import { DurableCompanionJournal } from "./durable-companion-journal.mjs";
import { createHomeAssistantTransport, HomeAssistantAdapter } from "./home-assistant-adapter.mjs";
import { PrivateBridgeConnection } from "./private-bridge-connection.mjs";
import { HermesCompanionEndpoint } from "../tools/hermes-companion-endpoint.mjs";

const HELP = `Private dynamic-app / WSS / Home Assistant evaluation server

Requires a private literal bind address, TLS certificate and key, bridge token,
HTTPS Home Assistant origin/token, provider-side atomic mutation endpoint,
0600 durable-ledger path, and the explicit reversible-mutation gate.

The phone must be configured for this WSS endpoint and private CA. Start the
server, then say exactly: "open private living room controls". Every wearer
mutation is receipt-restored before the dynamic view closes. No credentials,
provider IDs, private addresses, or raw provider errors are printed.

An optional loopback Hermes companion gateway reuses this authenticated WSS
and an owner-only operation journal. It does not create another HTTP surface.
`;

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

export function isReviewedPrivateAddress(host) {
  const version = isIP(host);
  if (version === 4) {
    const [a, b] = host.split(".").map(Number);
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (version === 6) {
    const value = host.toLowerCase();
    return value === "::1" || value.startsWith("fc") || value.startsWith("fd") || /^fe[89ab]/.test(value);
  }
  return false;
}

function parseConfig() {
  const host = required("PRIVATE_BRIDGE_BIND_HOST");
  if (!isReviewedPrivateAddress(host)) throw new Error("bind host must be a reviewed private literal address");
  const port = Number(required("PRIVATE_BRIDGE_PORT"));
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("bridge port is invalid");
  if (process.env.HA_ALLOW_MUTATION !== "I_UNDERSTAND" || process.env.PRIVATE_EVALUATION_RESTORE !== "REQUIRED") {
    throw new Error("explicit reversible mutation gates are required");
  }
  const token = required("PRIVATE_BRIDGE_TOKEN");
  if (token.length < 16) throw new Error("bridge token is too short");
  const companionValues = [process.env.HERMES_COMPANION_GATEWAY_URL,
    process.env.HERMES_COMPANION_GATEWAY_TOKEN, process.env.HERMES_COMPANION_JOURNAL_PATH];
  if (companionValues.some(Boolean) && !companionValues.every(Boolean)) {
    throw new Error("companion gateway configuration is incomplete");
  }
  return {
    host, port, token,
    certPath: required("PRIVATE_BRIDGE_TLS_CERT"),
    keyPath: required("PRIVATE_BRIDGE_TLS_KEY"),
    haUrl: required("HA_URL"),
    haToken: required("HA_TOKEN"),
    atomicMutationPath: required("HA_ATOMIC_MUTATION_PATH"),
    ledgerPath: required("HA_MUTATION_LEDGER_PATH"),
    triggerPhrase: process.env.PRIVATE_EVALUATION_PHRASE || "open private living room controls",
    companion: companionValues.every(Boolean) ? {
      gatewayUrl: companionValues[0], gatewayToken: companionValues[1], journalPath: companionValues[2],
    } : null,
  };
}

async function main() {
  if (process.argv.includes("--help")) {
    process.stdout.write(HELP);
    return;
  }
  const config = parseConfig();
  const [cert, key] = await Promise.all([readFile(config.certPath), readFile(config.keyPath)]);
  const transport = createHomeAssistantTransport({
    baseUrl: config.haUrl,
    getToken: () => config.haToken,
    atomicMutationPath: config.atomicMutationPath,
  });
  const releaseLedgerLease = await acquireDurableLedgerLease(config.ledgerPath);
  const ledger = new DurableMutationLedger({ path: releaseLedgerLease.canonicalPath });
  let releaseCompanionLease = null;
  let companionEndpoint = null;
  if (config.companion) {
    releaseCompanionLease = await acquireDurableLedgerLease(config.companion.journalPath);
    const journal = new DurableCompanionJournal({ path: releaseCompanionLease.canonicalPath });
    companionEndpoint = new HermesCompanionEndpoint({
      gatewayUrl: config.companion.gatewayUrl,
      token: config.companion.gatewayToken,
      createSocket: (address) => new WebSocket(address),
      journal: journal.records(),
      reserveOperation: (record) => journal.reserve(record),
      completeOperation: (operationId, outcome) => journal.complete(operationId, outcome),
    });
    companionEndpoint.start();
  }
  const adapter = new HomeAssistantAdapter({ transport, ledger });
  const recoverLedger = async () => {
    if (!(await ledger.list()).length) return;
    const authorized = () => process.env.HA_ALLOW_MUTATION === "I_UNDERSTAND" && process.env.PRIVATE_EVALUATION_RESTORE === "REQUIRED";
    await adapter.discover({ kind: "area", label: "Living Room" });
    const receipts = await adapter.recoverUnrestoredMutations({ isAuthorized: authorized });
    for (const receipt of receipts) {
      const recoveryId = `recovery-${createHash("sha256").update(receipt.operationId).digest("hex").slice(0, 24)}`;
      await adapter.restore(receipt, { operationId: recoveryId, isAuthorized: authorized });
    }
  };
  await recoverLedger();
  const server = createServer({ cert, key }, (_request, response) => {
    response.writeHead(404, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
    response.end("Not found\n");
  });
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024, perMessageDeflate: false });
  let generation = 0;
  let active = null;
  let promotionQueue = Promise.resolve();

  server.on("upgrade", (request, socket, head) => {
    if (request.url !== "/") {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    sockets.handleUpgrade(request, socket, head, (webSocket) => sockets.emit("connection", webSocket));
  });

  sockets.on("connection", (webSocket) => {
    let owned;
    let authTimer = setTimeout(() => webSocket.close(1008, "authentication timeout"), 15_000);
    let controlQueue = Promise.resolve();
    const connection = new PrivateBridgeConnection({
      expectedToken: config.token,
      connectionGeneration: `connection_socket_${++generation}_${Date.now()}`,
      adapter,
      companionEndpoint,
      triggerPhrase: config.triggerPhrase,
      send: (frame) => { if (webSocket.readyState === webSocket.OPEN) webSocket.send(JSON.stringify(frame)); },
      closeSocket: (code, reason) => webSocket.close(code, reason),
      onAuthenticated: async () => {
        clearTimeout(authTimer);
        authTimer = null;
        const promote = promotionQueue.then(async () => {
          const previous = active;
          if (previous && previous !== owned) {
            await previous.connection.close("connection replaced");
            previous.socket.close(1012, "connection replaced");
          }
          await recoverLedger();
          active = owned;
        });
        promotionQueue = promote.catch(() => undefined);
        await promote;
      },
    });
    owned = { socket: webSocket, connection };
    webSocket.on("message", (data, isBinary) => {
      if (isBinary || data.length > 64 * 1024) { webSocket.close(1009, "bounded JSON only"); return; }
      let frame;
      try { frame = JSON.parse(data.toString("utf8")); }
      catch { webSocket.close(1007, "invalid JSON"); return; }
      if (frame?.chan === "mcp") {
        void connection.receive(frame).catch(() => webSocket.close(1011, "private evaluation failed safely"));
        return;
      }
      const handled = controlQueue.then(() => connection.receive(frame));
      controlQueue = handled.catch(() => undefined);
      void handled.catch(() => webSocket.close(1011, "private evaluation failed safely"));
    });
    webSocket.on("close", () => {
      if (authTimer) clearTimeout(authTimer);
      if (active === owned) active = null;
      void connection.close("socket closed");
    });
    webSocket.on("error", () => {});
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, resolve);
  });
  process.stdout.write("Private evaluation WSS server ready.\n");

  const stop = async () => {
    if (active) {
      await active.connection.close("server stopping");
      active.socket.close(1001, "server stopping");
    }
    for (const socket of sockets.clients) socket.close(1001, "server stopping");
    await new Promise((resolve) => sockets.close(resolve));
    await new Promise((resolve) => server.close(resolve));
    companionEndpoint?.stop();
    if (releaseCompanionLease) await releaseCompanionLease();
    await releaseLedgerLease();
  };
  process.once("SIGINT", () => { void stop().finally(() => { process.exitCode = 130; }); });
  process.once("SIGTERM", () => { void stop().finally(() => { process.exitCode = 143; }); });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    process.stderr.write("Private evaluation server failed safely; check local configuration.\n");
    process.exitCode = 1;
  });
}
