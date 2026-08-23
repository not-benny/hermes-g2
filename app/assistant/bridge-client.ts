import { AssistantMcpServer } from "./mcp-server";
import { toolRegistry } from "./tool-registry";
import { BridgeConnectionGuard } from "./bridge-connection-guard";
import { AgentCockpitController } from "../agent-cockpit/controller";
import type { CockpitClientCommand } from "../agent-cockpit/protocol";
import type { AssistantContext, AssistantTurnCallbacks, AssistantTurnHandle } from "./types";

declare const com: any;

/**
 * Dial-out websocket client for the Hermes Agent bridge (or another compatible
 * server on the user's machine; see
 * notes/voice-assistant-design.md "External mode"). One JSON object per text
 * frame, four multiplexed channels:
 *
 *   ctl:  hello/hello-ack auth handshake, ping/pong, error
 *   chat: utterance in, streamed reply out (per-turn)
 *   mcp:  raw MCP JSON-RPC; the phone is the MCP *server* (ToolRegistry)
 *   cockpit: bounded structured Hermes/Kanban events and exact actions
 *
 * Unlike G2MirrorClient (per-terminal-window, no reconnect), this connection
 * is a long-lived shell service: it stays up while configured so the remote
 * agent can make proactive tool calls, and it re-dials with backoff.
 */

const PROTOCOL_VERSION = 1;
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 60_000;
const PING_INTERVAL_MS = 20_000;
/** No inbound traffic for this long => the link is dead (half-open TCP). */
const LIVENESS_TIMEOUT_MS = 45_000;
const AUTH_TIMEOUT_MS = 15_000;
const MAX_BRIDGE_FRAME_BYTES = 64 * 1024;
/** Backstop on a turn the bridge never finishes (server-side cap is 2 min). */
const TURN_TIMEOUT_MS = 3 * 60 * 1000;

export type AssistantBridgePhase = "idle" | "connecting" | "connected" | "failed";

export type AssistantBridgeState = {
  phase: AssistantBridgePhase;
  status: string;
};

export type AssistantBridgeOptions = {
  host: string;
  port: number;
  token: string;
  deviceName: string;
  /** Reads assistant.allowProactive; consulted per proactive tool call. */
  allowProactive: () => boolean;
};

type ActiveTurn = {
  turnId: string;
  callbacks: AssistantTurnCallbacks;
  textSoFar: string;
  timer: ReturnType<typeof setTimeout>;
};

export class AssistantBridgeClient {
  readonly cockpit = new AgentCockpitController((command) => this.sendCockpit(command));
  private options: AssistantBridgeOptions | null = null;
  private ws: any = null;
  private listenerProxy: any = null;
  private phase: AssistantBridgePhase = "idle";
  private status = "Not configured.";
  private stopped = true;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelayMs = RECONNECT_MIN_MS;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private authTimer: ReturnType<typeof setTimeout> | null = null;
  private lastTrafficMs = 0;
  private activeTurn: ActiveTurn | null = null;
  private turnSeq = 0;
  private mcpServer: AssistantMcpServer | null = null;
  private unsubscribeToolsChanged: (() => void) | null = null;
  private readonly connectionGuard = new BridgeConnectionGuard();
  private readonly stateListeners = new Set<(state: AssistantBridgeState) => void>();

  state(): AssistantBridgeState {
    return { phase: this.phase, status: this.status };
  }

  onStateChange(listener: (state: AssistantBridgeState) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  isConnected(): boolean {
    return this.phase === "connected";
  }

  /**
   * Set (or replace) the bridge configuration and connect. Safe to call again
   * with new settings; the old connection is torn down first.
   */
  configure(options: AssistantBridgeOptions): void {
    this.stop();
    this.options = options;
    this.stopped = false;

    this.unsubscribeToolsChanged = toolRegistry.onToolsChanged(() => {
      if (this.phase === "connected") this.mcpServer?.sendToolsChanged();
    });
    this.connect();
  }

  /** Disconnect and stay down until the next configure(). */
  stop(): void {
    this.stopped = true;
    this.connectionGuard.invalidateCurrent();
    this.clearReconnectTimer();
    this.clearKeepalive();
    this.clearAuthTimer();
    this.failActiveTurn("Bridge connection closed");
    this.cockpit.disconnect();
    if (this.unsubscribeToolsChanged) {
      this.unsubscribeToolsChanged();
      this.unsubscribeToolsChanged = null;
    }
    this.mcpServer?.close();
    this.mcpServer = null;
    if (this.ws) {
      try {
        this.ws.close(1000, "bye");
      } catch {
        // ignore
      }
      this.ws = null;
    }
    this.listenerProxy = null;
    this.setState("idle", "Not connected.");
  }

  /**
   * Send an utterance as a new turn. Streaming replies arrive via callbacks.
   * A turn already in flight is superseded (the session serializes turns, so
   * this is just a safety net).
   */
  sendUtterance(
    text: string,
    ctx: AssistantContext,
    callbacks: AssistantTurnCallbacks,
  ): AssistantTurnHandle {
    if (this.phase !== "connected") {
      callbacks.onError(`Hermes Agent bridge is not connected (${this.status})`);
      return { cancel: () => {} };
    }
    this.failActiveTurn("Superseded by a new request");
    const turnId = `t${++this.turnSeq}`;
    this.activeTurn = {
      turnId,
      callbacks,
      textSoFar: "",
      timer: setTimeout(() => {
        if (this.activeTurn?.turnId !== turnId) return;
        this.failActiveTurn("The agent took too long to reply");
      }, TURN_TIMEOUT_MS),
    };
    this.send({ chan: "chat", type: "utterance", turnId, text, ctx });
    return {
      cancel: () => {
        if (this.activeTurn?.turnId !== turnId) return;
        this.send({ chan: "chat", type: "cancel", turnId });
        this.clearActiveTurn();
      },
    };
  }

  private connect(): void {
    if (this.stopped || this.ws || !this.options) return;
    const generation = this.connectionGuard.beginConnection();
    const { host, port } = this.options;
    const url = `wss://${host}:${port}`;
    this.setState("connecting", `Connecting to ${host}:${port}...`);
    let socket: any = null;
    this.listenerProxy = new com.faceclaw.app.FaceclawWebSocketListener({
      onOpen: () => {
        if (!this.isCurrentSocket(generation, socket)) return;
        this.setState("connecting", "Authenticating...");
        this.startAuthTimer(generation, socket);
        this.send({ chan: "ctl", type: "hello", version: PROTOCOL_VERSION, token: this.options!.token,
          deviceName: this.options!.deviceName, capabilities: ["chat", "mcp", "cockpit-v1"] });
      },
      onTextMessage: (message: string) => {
        if (!this.isCurrentSocket(generation, socket)) return;
        this.handleMessage(String(message), generation);
      },
      onClosed: (code: number, reason: string) => {
        if (!this.isCurrentSocket(generation, socket)) return;
        this.handleConnectionLost(`Connection closed (${Number(code)}${reason ? `: ${String(reason)}` : ""})`, generation);
      },
      onFailure: (message: string) => {
        if (!this.isCurrentSocket(generation, socket)) return;
        this.handleConnectionLost(`Connection failed: ${String(message)}`, generation);
      },
    });
    try {
      socket = new com.faceclaw.app.FaceclawWebSocket(url, this.listenerProxy, null, null);
      this.ws = socket;
      this.mcpServer?.close();
      this.mcpServer = new AssistantMcpServer({
        send: (msg) => this.sendMcpForSocket(generation, socket, msg),
        isTurnActive: () => this.activeTurn !== null,
        getTurnGeneration: () => this.activeTurn?.turnId ?? null,
        // The configured WSS endpoint has no repository-owned deployment or
        // runtime server-proof evidence; sensitive health remains fail-closed.
        isHealthCallerTrusted: () => false,
        connectionGeneration: generation,
        isConnectionGenerationActive: () => this.connectionGuard.isCurrent(generation),
        allowProactive: this.options!.allowProactive,
      });
    } catch (error) {
      this.ws = null;
      this.handleConnectionLost(`Connection failed: ${String((error as Error)?.message ?? error)}`, generation);
    }
  }

  private handleMessage(raw: string, generation: number): void {
    this.lastTrafficMs = Date.now();
    if (raw.length > MAX_BRIDGE_FRAME_BYTES) {
      const socket = this.ws;
      this.handleConnectionLost("Bridge frame exceeded the bounded message limit", generation);
      try { socket?.close(1009, "message too large"); } catch { /* already torn down */ }
      return;
    }
    let frame: any = null;
    try {
      frame = JSON.parse(raw);
    } catch {
      return;
    }
    if (!frame || typeof frame !== "object") return;
    if (frame.v !== PROTOCOL_VERSION) {
      const socket = this.ws;
      this.handleConnectionLost("Bridge protocol version mismatch", generation);
      try { socket?.close(1002, "protocol version mismatch"); } catch { /* already torn down */ }
      return;
    }
    switch (frame.chan) {
      case "ctl":
        this.handleCtl(frame, generation);
        return;
      case "chat":
        if (!this.requireAuthenticated(generation)) return;
        this.handleChat(frame);
        return;
      case "mcp":
        if (!this.requireAuthenticated(generation)) return;
        this.mcpServer?.handleMessage(
          frame.msg,
          frame.proactive === true
            ? { proactive: true }
            : typeof frame.turnId === "string"
              ? { turnGeneration: frame.turnId }
              : undefined,
        );
        return;
      case "cockpit":
        if (!this.requireAuthenticated(generation)) return;
        this.cockpit.handleFrame(frame);
        return;
      default:
        return;
    }
  }

  private handleCtl(frame: any, generation: number): void {
    if (frame.type === "hello-ack") {
      if (frame.version !== undefined && Number(frame.version) !== PROTOCOL_VERSION) {
        const socket = this.ws;
        this.handleConnectionLost("Bridge protocol version mismatch", generation);
        try { socket?.close(1002, "protocol version mismatch"); } catch { /* already torn down */ }
        return;
      }
      if (!this.connectionGuard.authenticate(generation)) return;
      this.clearAuthTimer();
      this.reconnectDelayMs = RECONNECT_MIN_MS;
      this.lastTrafficMs = Date.now();
      this.startKeepalive();
      this.setState("connected", `Connected to ${String(frame.serverName ?? "bridge")}`);
      return;
    }
    if (frame.type === "ping") {
      this.send({ chan: "ctl", type: "pong", ts: frame.ts });
      return;
    }
    if (frame.type === "error") {
      // The server closes after a ctl error; the close handler schedules the
      // re-dial. Record the reason so the status is more useful than a bare
      // close code (especially for a bad token).
      this.status = `Bridge error: ${String(frame.message ?? "unknown")}`;
      return;
    }
  }

  private handleChat(frame: any): void {
    const turn = this.activeTurn;
    if (!turn || frame.turnId !== turn.turnId) return;
    switch (frame.type) {
      case "text-delta": {
        const text = typeof frame.text === "string" ? frame.text : "";
        turn.textSoFar = frame.replace === true ? text : turn.textSoFar + text;
        turn.callbacks.onTextDelta(text, turn.textSoFar);
        return;
      }
      case "tool-activity":
        turn.callbacks.onToolActivity(String(frame.label ?? "tool"));
        return;
      case "turn-done": {
        this.clearActiveTurn();
        turn.callbacks.onTurnDone({
          stopReason: typeof frame.stopReason === "string" ? frame.stopReason : null,
        });
        return;
      }
      case "turn-error":
        this.clearActiveTurn();
        turn.callbacks.onError(String(frame.message ?? "Agent error"));
        return;
      default:
        return;
    }
  }

  private handleConnectionLost(status: string, generation: number): void {
    if (!this.connectionGuard.invalidate(generation)) return;
    this.mcpServer?.close();
    this.mcpServer = null;
    this.ws = null;
    this.listenerProxy = null;
    this.clearKeepalive();
    this.clearAuthTimer();
    // Keep a ctl-error status (e.g. "invalid token") in preference to the
    // generic close message that follows it.
    const detail = this.status.startsWith("Bridge error:") ? this.status : status;
    this.failActiveTurn("Bridge connection lost");
    this.cockpit.disconnect();
    this.setState("failed", detail);
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const delay = this.reconnectDelayMs + Math.floor(Math.random() * (this.reconnectDelayMs / 2));
    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, RECONNECT_MAX_MS);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private startAuthTimer(generation: number, socket: any): void {
    this.clearAuthTimer();
    this.authTimer = setTimeout(() => {
      this.authTimer = null;
      if (!this.isCurrentSocket(generation, socket) || this.connectionGuard.canHandlePrivileged(generation)) return;
      this.handleConnectionLost("Bridge authentication timed out", generation);
      try { socket.close(1008, "authentication timeout"); } catch { /* already torn down */ }
    }, AUTH_TIMEOUT_MS);
  }

  private clearAuthTimer(): void {
    if (!this.authTimer) return;
    clearTimeout(this.authTimer);
    this.authTimer = null;
  }

  private startKeepalive(): void {
    this.clearKeepalive();
    this.pingTimer = setInterval(() => this.checkLiveness(), PING_INTERVAL_MS);
  }

  private clearKeepalive(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private checkLiveness(): void {
    if (this.phase !== "connected" || !this.ws) return;
    if (Date.now() - this.lastTrafficMs > LIVENESS_TIMEOUT_MS) {
      const ws = this.ws;
      this.ws = null;
      try {
        ws.close(1000, "liveness timeout");
      } catch {
        // ignore
      }
      this.handleConnectionLost("Connection timed out (no traffic from bridge)", this.connectionGuard.currentGeneration());
      return;
    }
    this.send({ chan: "ctl", type: "ping", ts: Date.now() });
  }

  private clearActiveTurn(): void {
    if (!this.activeTurn) return;
    clearTimeout(this.activeTurn.timer);
    this.activeTurn = null;
  }

  private failActiveTurn(message: string): void {
    const turn = this.activeTurn;
    if (!turn) return;
    this.clearActiveTurn();
    turn.callbacks.onError(message);
  }

  private send(frame: object): void {
    if (!this.ws) return;
    try { this.ws.sendText(JSON.stringify({ v: PROTOCOL_VERSION, ...frame })); }
    catch { /* close/failure callback handles recovery */ }
  }

  private sendMcpForSocket(generation: number, socket: any, msg: object): void {
    if (!this.isCurrentSocket(generation, socket)) return;
    try { socket.sendText(JSON.stringify({ v: PROTOCOL_VERSION, chan: "mcp", msg })); }
    catch { /* socket callback handles failure */ }
  }

  private sendCockpit(command: CockpitClientCommand): void {
    if (this.phase !== "connected") return;
    this.send({ ...command, chan: "cockpit" });
  }

  private isCurrentSocket(generation: number, socket: any): boolean {
    return !this.stopped && socket !== null && this.ws === socket && this.connectionGuard.isCurrent(generation);
  }

  private requireAuthenticated(generation: number): boolean {
    if (this.connectionGuard.canHandlePrivileged(generation)) return true;
    const socket = this.ws;
    this.handleConnectionLost("Rejected privileged frame before authentication", generation);
    try { socket?.close(1008, "authentication required"); } catch { /* already torn down */ }
    return false;
  }

  private setState(phase: AssistantBridgePhase, status: string): void {
    this.phase = phase;
    this.status = status;
    const state = this.state();
    for (const listener of this.stateListeners) {
      try {
        listener(state);
      } catch {
        // listeners must not break the client
      }
    }
  }
}

/** Process-wide bridge client (main isolate), configured by the dashboard controller. */
export const assistantBridge = new AssistantBridgeClient();
