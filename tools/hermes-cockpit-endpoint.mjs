import { randomBytes } from "node:crypto";
import { HermesCockpitAdapter } from "./hermes-cockpit-adapter.mjs";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

function connectionId() {
  return `connection_${randomBytes(16).toString("base64url")}`;
}

/**
 * Production Hermes-side endpoint core. It connects only to the loopback Hermes
 * TUI gateway and exposes bounded cockpit frames to the existing authenticated
 * bridge through the injected emit/handleCommand seam. It opens no public port.
 */
export class HermesCockpitEndpoint {
  constructor(options) {
    const url = new URL(options.gatewayUrl);
    if (!["ws:", "wss:"].includes(url.protocol) || !LOOPBACK.has(url.hostname)) {
      throw new Error("Hermes cockpit gateway must be loopback WebSocket");
    }
    if (typeof options.token !== "string" || !options.token) throw new Error("Hermes gateway token is required");
    this.gatewayUrl = url;
    this.token = options.token;
    this.shares = Array.isArray(options.shares) ? options.shares.map((share) => ({ ...share })) : [];
    this.createSocket = options.createSocket ?? ((address) => new WebSocket(address));
    this.emit = options.emit;
    this.createConnectionGeneration = options.createConnectionGeneration ?? connectionId;
    this.adapter = new HermesCockpitAdapter({ now: options.now, monotonicNow: options.monotonicNow, journal: options.journal });
    this.generationByHermes = new Map(this.shares.map((share) => [share.hermesSessionId, share.generation]));
    this.pendingCommands = new Map();
    this.socket = null;
  }

  start() {
    if (this.socket) return;
    const address = new URL(this.gatewayUrl);
    address.searchParams.set("token", this.token);
    const socket = this.createSocket(address.toString());
    this.socket = socket;
    socket.addEventListener("open", () => this.#opened(socket));
    socket.addEventListener("message", (event) => this.#message(socket, event.data));
    socket.addEventListener("close", () => this.#closed(socket));
    socket.addEventListener("error", () => this.#closed(socket));
  }

  stop() {
    const socket = this.socket;
    this.#closed(socket);
    try { socket?.close(); } catch { /* already closed */ }
  }

  handleCommand(command) {
    const socket = this.socket;
    if (!socket || socket.readyState !== 1) return false;
    const result = this.adapter.handleCommand(command, (rpc) => {
      // The adapter performs its final identity/generation/policy check
      // immediately before this synchronous send boundary.
      this.pendingCommands.set(command.command_id, command);
      socket.send(JSON.stringify(rpc));
      return true;
    });
    return result === true;
  }

  exportJournal() {
    return this.adapter.exportJournal();
  }

  #opened(socket) {
    if (this.socket !== socket) return;
    this.adapter.connect(this.createConnectionGeneration());
    for (const share of this.shares) this.adapter.share(share);
    const snapshot = this.adapter.snapshot();
    if (snapshot) this.emit(snapshot);
  }

  #closed(socket) {
    if (!socket || this.socket !== socket) return;
    this.socket = null;
    this.adapter.disconnect();
    this.pendingCommands.clear();
  }

  #message(socket, raw) {
    if (this.socket !== socket || typeof raw !== "string" || raw.length > 64 * 1024) return;
    let frame;
    try { frame = JSON.parse(raw); } catch { return; }
    if (!frame || typeof frame !== "object") return;
    if (frame.method === "event" && frame.params && typeof frame.params === "object") {
      const generation = this.generationByHermes.get(frame.params.session_id);
      if (generation === undefined) return;
      const projected = this.adapter.ingest(frame.params, generation);
      if (projected) this.emit(projected);
      return;
    }
    if (typeof frame.id !== "string") return;
    const command = this.pendingCommands.get(frame.id);
    if (!command) return;
    this.pendingCommands.delete(frame.id);
    const outcome = frame.error ? "rejected" : "accepted";
    const code = frame.error && typeof frame.error.code !== "undefined" ? `rpc_${String(frame.error.code)}` : undefined;
    const receipt = this.adapter.commandReceipt(command, outcome, code);
    if (receipt) this.emit(receipt);
  }
}
