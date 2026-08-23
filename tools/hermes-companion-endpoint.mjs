import { randomBytes } from "node:crypto";
import { HermesCompanionAdapter } from "./hermes-companion-adapter.mjs";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
const requestId = () => `snapshot_${randomBytes(16).toString("base64url")}`;

/**
 * Connects outward to a loopback-only Hermes gateway and exposes no listener.
 * An authenticated private bridge explicitly attaches one phone generation and
 * receives only the adapter's bounded projections.
 */
export class HermesCompanionEndpoint {
  constructor(options) {
    const url = new URL(options.gatewayUrl);
    if (!["ws:", "wss:"].includes(url.protocol) || !LOOPBACK.has(url.hostname)) {
      throw new Error("Hermes companion gateway must be loopback WebSocket");
    }
    if (typeof options.token !== "string" || options.token.length < 16) throw new Error("Hermes gateway token is too short");
    if (typeof options.reserveOperation !== "function") throw new Error("durable operation reservation callback is required");
    this.gatewayUrl = url;
    this.token = options.token;
    this.createSocket = options.createSocket ?? ((address) => new WebSocket(address));
    this.createRequestId = options.createRequestId ?? requestId;
    this.adapter = new HermesCompanionAdapter({ now: options.now, createOpaque: options.createOpaque,
      journal: options.journal, reserveOperation: options.reserveOperation });
    this.completeOperation = options.completeOperation ?? (() => true);
    this.setReconnectTimer = options.setReconnectTimer ?? ((callback, delay) => {
      const timer = setTimeout(callback, delay);
      timer.unref?.();
      return timer;
    });
    this.clearReconnectTimer = options.clearReconnectTimer ?? ((timer) => clearTimeout(timer));
    this.socket = null;
    this.phoneGeneration = null;
    this.emit = null;
    this.pendingCommands = new Map();
    this.snapshotRequests = new Set();
    this.reconnectTimer = null;
    this.reconnectDelayMs = 1_000;
    this.stopped = true;
  }

  start() {
    this.stopped = false;
    if (this.reconnectTimer) {
      this.clearReconnectTimer(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.#connect();
  }

  #connect() {
    if (this.stopped || this.socket) return;
    const address = new URL(this.gatewayUrl);
    address.searchParams.set("token", this.token);
    let socket;
    try { socket = this.createSocket(address.toString()); }
    catch { this.#scheduleReconnect(); return; }
    this.socket = socket;
    socket.addEventListener("open", () => this.#opened(socket));
    socket.addEventListener("message", (event) => this.#message(socket, event.data));
    socket.addEventListener("close", () => this.#closed(socket));
    socket.addEventListener("error", () => this.#closed(socket));
  }

  stop() {
    this.stopped = true;
    if (this.reconnectTimer) {
      this.clearReconnectTimer(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const socket = this.socket;
    this.#closed(socket);
    try { socket?.close(); } catch { /* already closed */ }
  }

  attach(connectionGeneration, emit) {
    if (typeof emit !== "function") throw new Error("authenticated bridge emitter is required");
    this.detach();
    this.phoneGeneration = connectionGeneration;
    this.emit = emit;
    this.adapter.connect(connectionGeneration);
    if (this.socket?.readyState === 1) this.#requestSnapshot();
    else this.#emit(this.adapter.unavailableSnapshot());
  }

  detach(connectionGeneration = this.phoneGeneration) {
    if (!this.phoneGeneration || connectionGeneration !== this.phoneGeneration) return false;
    this.phoneGeneration = null;
    this.emit = null;
    this.pendingCommands.clear();
    this.snapshotRequests.clear();
    this.adapter.disconnect();
    return true;
  }

  handleCommand(command, connectionGeneration) {
    if (!this.phoneGeneration || connectionGeneration !== this.phoneGeneration ||
        command?.connection_generation !== connectionGeneration) return false;
    const replay = this.adapter.replayReceipt(command);
    if (replay) { this.#emit(replay); return true; }
    const socket = this.socket;
    if (!socket || socket.readyState !== 1) {
      const rejected = this.adapter.rejectUnavailable(command);
      if (rejected) this.#emit(rejected);
      return Boolean(rejected);
    }
    return this.adapter.handleCommand(command, (rpc) => {
      this.pendingCommands.set(command.operation_id, command);
      socket.send(JSON.stringify(rpc));
      return true;
    }) === true;
  }

  exportJournal() { return this.adapter.exportJournal(); }

  #emit(frame) {
    if (frame && this.emit && frame.connection_generation === this.phoneGeneration) this.emit(frame);
  }

  #opened(socket) {
    if (this.socket !== socket) return;
    this.reconnectDelayMs = 1_000;
    if (this.phoneGeneration) this.#requestSnapshot();
  }

  #closed(socket) {
    if (!socket || this.socket !== socket) return;
    this.socket = null;
    this.pendingCommands.clear();
    this.snapshotRequests.clear();
    if (this.phoneGeneration) this.#emit(this.adapter.unavailableSnapshot());
    this.#scheduleReconnect();
  }

  #scheduleReconnect() {
    if (this.stopped || this.socket || this.reconnectTimer) return;
    const delay = this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, 60_000);
    this.reconnectTimer = this.setReconnectTimer(() => {
      this.reconnectTimer = null;
      this.#connect();
    }, delay);
  }

  #requestSnapshot() {
    const socket = this.socket;
    if (!socket || socket.readyState !== 1 || !this.phoneGeneration) return;
    const id = this.createRequestId();
    this.snapshotRequests.add(id);
    socket.send(JSON.stringify({ jsonrpc: "2.0", id, method: "companion.snapshot", params: this.adapter.snapshotParams() }));
  }

  #message(socket, raw) {
    if (this.socket !== socket || typeof raw !== "string" || raw.length > 64 * 1024) return;
    let frame;
    try { frame = JSON.parse(raw); } catch { return; }
    if (!frame || typeof frame !== "object") return;
    if (frame.jsonrpc === "2.0" && frame.method === "companion.snapshot") {
      this.#emit(this.adapter.snapshot(frame.params));
      return;
    }
    if (frame.jsonrpc !== "2.0" || typeof frame.id !== "string" || (!("result" in frame) && !("error" in frame))) return;
    if (this.snapshotRequests.delete(frame.id)) {
      if (!frame.error && frame.result && typeof frame.result === "object") this.#emit(this.adapter.snapshot(frame.result));
      else this.#emit(this.adapter.unavailableSnapshot());
      return;
    }
    const command = this.pendingCommands.get(frame.id);
    if (!command) return;
    this.pendingCommands.delete(frame.id);
    const applicationRejected = frame.result && typeof frame.result === "object" &&
      [frame.result.accepted, frame.result.ok].some((value) => value === false);
    const outcome = frame.error || applicationRejected ? "rejected" : "accepted";
    const code = frame.error && typeof frame.error.code !== "undefined" ? `rpc_${String(frame.error.code)}` : undefined;
    if (command.type === "refresh" && outcome === "accepted" && frame.result && typeof frame.result === "object") {
      this.#emit(this.adapter.snapshot(frame.result));
    }
    let durableOutcome = outcome;
    try {
      if (this.completeOperation(command.operation_id, outcome) !== true) durableOutcome = "outcome_unknown";
    } catch {
      durableOutcome = "outcome_unknown";
    }
    this.#emit(this.adapter.operationReceipt(command, durableOutcome, code));
    if (command.type !== "refresh" && outcome === "accepted") this.#requestSnapshot();
  }
}
