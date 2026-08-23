import { randomBytes } from "node:crypto";
import { HermesCompanionAdapter } from "./hermes-companion-adapter.mjs";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
const SESSION_OPERATIONS = new Set(["open_session", "resume_session", "cancel_session"]);
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
    this.commandTimeoutMs = options.commandTimeoutMs ?? 15_000;
    if (!Number.isSafeInteger(this.commandTimeoutMs) || this.commandTimeoutMs < 100 || this.commandTimeoutMs > 120_000) {
      throw new Error("Hermes gateway command timeout is invalid");
    }
    this.setCommandTimer = options.setCommandTimer ?? ((callback, delay) => {
      const timer = setTimeout(callback, delay);
      timer.unref?.();
      return timer;
    });
    this.clearCommandTimer = options.clearCommandTimer ?? ((timer) => clearTimeout(timer));
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
    for (const { command } of [...this.pendingCommands.values()]) {
      this.#takePending(command.operation_id);
      this.#settle(command, "outcome_unknown", "phone_detached");
    }
    this.phoneGeneration = null;
    this.emit = null;
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
      if (!this.adapter.reserveRejection(command)) return false;
      this.#settle(command, "rejected", "backend_offline");
      return true;
    }
    let sendFailed = false;
    const handled = this.adapter.handleCommand(command, (rpc) => {
      const pending = { command, timer: null };
      this.pendingCommands.set(command.operation_id, pending);
      try {
        socket.send(JSON.stringify(rpc));
        const timer = this.setCommandTimer(
          () => this.#commandTimedOut(command.operation_id, command), this.commandTimeoutMs);
        if (this.pendingCommands.get(command.operation_id) === pending) pending.timer = timer;
        else this.clearCommandTimer(timer);
        return true;
      } catch {
        this.pendingCommands.delete(command.operation_id);
        if (pending.timer) this.clearCommandTimer(pending.timer);
        sendFailed = true;
        return false;
      }
    }) === true;
    if (sendFailed) {
      this.#settle(command, "outcome_unknown", "gateway_send_failed");
      return true;
    }
    return handled;
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
    for (const { command } of [...this.pendingCommands.values()]) {
      this.#takePending(command.operation_id);
      this.#settle(command, "outcome_unknown", "gateway_disconnected");
    }
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
    // Only the latest projection request can restore current authority. A late
    // reply to an older request is ignored, and its ID is not retained forever.
    this.snapshotRequests.clear();
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
    const command = this.#takePending(frame.id);
    if (!command) return;
    const casConfirmed = !SESSION_OPERATIONS.has(command.type) ||
      (frame.result && typeof frame.result === "object" && frame.result.accepted === true &&
        frame.result.matched_generation === command.generation);
    const applicationRejected = frame.result && typeof frame.result === "object" &&
      [frame.result.accepted, frame.result.ok].some((value) => value === false);
    const outcome = frame.error || applicationRejected || !casConfirmed ? "rejected" : "accepted";
    const code = frame.error && typeof frame.error.code !== "undefined" ? `rpc_${String(frame.error.code)}`
      : !casConfirmed ? "generation_unconfirmed" : undefined;
    if (command.type === "refresh" && outcome === "accepted" && frame.result && typeof frame.result === "object") {
      this.#emit(this.adapter.snapshot(frame.result));
    }
    this.#settle(command, outcome, code);
  }

  #takePending(operationId) {
    const pending = this.pendingCommands.get(operationId);
    if (!pending) return null;
    this.pendingCommands.delete(operationId);
    if (pending.timer) this.clearCommandTimer(pending.timer);
    return pending.command;
  }

  #commandTimedOut(operationId, command) {
    const owned = this.pendingCommands.get(operationId);
    if (!owned || owned.command !== command) return;
    this.#takePending(operationId);
    this.#settle(command, "outcome_unknown", "gateway_timeout");
  }

  #settle(command, outcome, code) {
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
