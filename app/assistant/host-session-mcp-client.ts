import type { AssistantContext } from "./types";

/**
 * MCP client for the authenticated Hermes host session. The websocket bridge
 * remains the transport owner; this class owns only MCP lifecycle, request
 * correlation, cancellation, and the exact terminal voice-result contract.
 */

const MCP_PROTOCOL_VERSION = "2025-06-18";
const HOST_VOICE_TOOL = "hermes.voice.turn";
const HOST_CONVERSATE_CUES_TOOL = "hermes.conversate.cues";
const HOST_COCKPIT_COMMAND_TOOL = "hermes.cockpit.command";
const HOST_STATUS_RESOURCE_URI = "hermes://session/status";
const COCKPIT_STATE_RESOURCE_URI = "hermes://cockpit/state";
const DEFAULT_INITIALIZE_TIMEOUT_MS = 15_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 3 * 60 * 1000;
const CONVERSATE_CUE_DEADLINE_MS = 2_500;
const MAX_OUTBOUND_MCP_BYTES = 60 * 1024;
const MAX_TURN_ID_CHARS = 128;
const MAX_RESULT_TEXT_CHARS = 16 * 1024;
const MAX_STOP_REASON_CHARS = 128;
const MAX_ERROR_TEXT_CHARS = 4 * 1024;
const MAX_CUE_TRANSCRIPT_SCALARS = 4_096;
const MAX_CUES = 3;
const MAX_CUE_TEXT_SCALARS = 160;

export type HostVoiceTurnRequest = {
  turnId: string;
  text: string;
  context: AssistantContext;
};

export type HostVoiceTurnResult = {
  turnId: string;
  text: string;
  stopReason: string | null;
};

export type HostVoiceTurnCall = {
  requestId: string;
  result: Promise<HostVoiceTurnResult>;
  cancel(reason?: string): void;
};

export type HostConversateCueKind = "question" | "topic" | "action";

export type HostConversateCue = {
  kind: HostConversateCueKind;
  text: string;
};

export type HostConversateCuesRequest = {
  sessionId: string;
  revision: number;
  transcript: string;
};

export type HostConversateCuesResult = {
  sessionId: string;
  revision: number;
  cues: readonly HostConversateCue[];
};

export type HostConversateCuesCall = {
  requestId: string;
  result: Promise<HostConversateCuesResult>;
  cancel(reason?: string): void;
};

export type HostSessionStatus = {
  connectionGeneration: string;
  voiceTurnState: "idle" | "running" | "cancelling";
};

export type HostSessionMcpClientOptions = {
  send: (msg: object) => void;
  connectionGeneration: string | number;
  isConnectionGenerationActive: () => boolean;
  initializeTimeoutMs?: number;
  requestTimeoutMs?: number;
  conversateCueTimeoutMs?: number;
  conversateCuesSupported?: boolean;
  onStatus?: (status: HostSessionStatus) => void;
  onCockpitFrame?: (frame: unknown) => void;
};

type VoiceRequest = {
  requestId: string;
  turnId: string;
  sent: boolean;
  settled: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  resolve: (result: HostVoiceTurnResult) => void;
  reject: (error: Error) => void;
};

type ConversateCueRequest = {
  requestId: string;
  expected: HostConversateCuesRequest;
  sent: boolean;
  settled: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  resolve: (result: HostConversateCuesResult) => void;
  reject: (error: Error) => void;
};

export class HostSessionMcpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HostSessionMcpError";
  }
}

export class HostSessionMcpCancelledError extends HostSessionMcpError {
  constructor(message = "Hermes voice turn cancelled") {
    super(message);
    this.name = "HostSessionMcpCancelledError";
  }
}

export class HostSessionMcpClient {
  private lifecycle: "initializing" | "initialized" | "failed" | "closed" = "initializing";
  private requestSequence = 0;
  private readonly initializeRequestId: string;
  private readonly initialized: Promise<void>;
  private resolveInitialized!: () => void;
  private rejectInitialized!: (error: Error) => void;
  private initializeTimer: ReturnType<typeof setTimeout> | null = null;
  private initializationFailure: Error | null = null;
  private activeVoiceRequest: VoiceRequest | null = null;
  private activeConversateCueRequest: ConversateCueRequest | null = null;
  private statusRequestId: string | null = null;
  private cockpitRequestId: string | null = null;
  private cockpitRefreshPending = false;
  private cockpitSubscriptionRequestId: string | null = null;
  private readonly cockpitCommandRequests = new Map<string, string>();

  constructor(private readonly options: HostSessionMcpClientOptions) {
    this.initializeRequestId = this.nextRequestId("initialize");
    this.initialized = new Promise<void>((resolve, reject) => {
      this.resolveInitialized = resolve;
      this.rejectInitialized = reject;
    });
    // Initialization can finish before the first voice call. Keep its
    // rejection observed while retaining the same promise for future callers.
    void this.initialized.catch(() => {});
    this.startInitialization();
  }

  callVoiceTurn(request: HostVoiceTurnRequest): HostVoiceTurnCall {
    const requestId = this.nextRequestId("voice");
    let voiceRequest!: VoiceRequest;
    const result = new Promise<HostVoiceTurnResult>((resolve, reject) => {
      voiceRequest = {
        requestId,
        turnId: request.turnId,
        sent: false,
        settled: false,
        timer: null,
        resolve,
        reject,
      };
    });

    if (this.lifecycle === "closed") {
      this.settleVoiceError(voiceRequest, new HostSessionMcpError("Hermes host MCP connection is closed"));
    } else if (this.lifecycle === "failed") {
      this.settleVoiceError(
        voiceRequest,
        this.initializationFailure ?? new HostSessionMcpError("Hermes host MCP initialization failed"),
      );
    } else if (this.activeVoiceRequest) {
      this.settleVoiceError(voiceRequest, new HostSessionMcpError("A Hermes voice turn is already active"));
    } else if (!isBoundedTurnId(request.turnId)) {
      this.settleVoiceError(voiceRequest, new HostSessionMcpError("Invalid Hermes voice turn id"));
    } else {
      this.activeVoiceRequest = voiceRequest;
      void this.initialized.then(() => {
        if (voiceRequest.settled) return;
        if (!this.options.isConnectionGenerationActive()) {
          this.settleVoiceError(voiceRequest, new HostSessionMcpError("Hermes host MCP connection is no longer active"));
          return;
        }
        const message = {
          jsonrpc: "2.0",
          id: requestId,
          method: "tools/call",
          params: {
            name: HOST_VOICE_TOOL,
            arguments: {
              turnId: request.turnId,
              text: request.text,
              context: request.context,
            },
          },
        };
        if (!this.isBoundedMessage(message)) {
          this.settleVoiceError(voiceRequest, new HostSessionMcpError("Hermes voice request exceeded the bounded message limit"));
          return;
        }
        voiceRequest.sent = true;
        voiceRequest.timer = setTimeout(() => {
          this.cancelVoiceRequest(voiceRequest, "Hermes voice turn timed out", true);
        }, this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
        try {
          this.options.send(message);
        } catch (error) {
          this.settleVoiceError(voiceRequest, asMcpError(error, "Unable to send Hermes voice turn"));
        }
      }).catch((error) => {
        this.settleVoiceError(voiceRequest, asMcpError(error, "Hermes host MCP initialization failed"));
      });
    }

    return {
      requestId,
      result,
      cancel: (reason = "Cancelled by the user") => this.cancelVoiceRequest(voiceRequest, reason, false),
    };
  }

  /**
   * Request bounded, tool-free Conversate suggestions. Only one is live: a
   * newer finalized transcript cancels the older request before it is sent.
   */
  callConversateCues(request: HostConversateCuesRequest): HostConversateCuesCall {
    const previous = this.activeConversateCueRequest;
    if (previous) this.cancelConversateCueRequest(previous, "Superseded by newer transcript", false);

    const requestId = this.nextRequestId("conversate-cues");
    let cueRequest!: ConversateCueRequest;
    const result = new Promise<HostConversateCuesResult>((resolve, reject) => {
      cueRequest = {
        requestId,
        expected: { ...request },
        sent: false,
        settled: false,
        timer: null,
        resolve,
        reject,
      };
    });

    if (!this.options.conversateCuesSupported) {
      this.settleConversateCueError(cueRequest, new HostSessionMcpError("Hermes Conversate cues are not supported"));
    } else if (this.lifecycle === "closed") {
      this.settleConversateCueError(cueRequest, new HostSessionMcpError("Hermes host MCP connection is closed"));
    } else if (this.lifecycle === "failed") {
      this.settleConversateCueError(
        cueRequest,
        this.initializationFailure ?? new HostSessionMcpError("Hermes host MCP initialization failed"),
      );
    } else if (!isBoundedConversateCueRequest(request)) {
      this.settleConversateCueError(cueRequest, new HostSessionMcpError("Invalid Hermes Conversate cue request"));
    } else {
      this.activeConversateCueRequest = cueRequest;
      cueRequest.timer = setTimeout(() => {
        this.cancelConversateCueRequest(cueRequest, "Hermes Conversate cue request timed out", true);
      }, this.options.conversateCueTimeoutMs ?? CONVERSATE_CUE_DEADLINE_MS);
      void this.initialized.then(() => {
        if (cueRequest.settled) return;
        if (!this.options.isConnectionGenerationActive()) {
          this.settleConversateCueError(
            cueRequest,
            new HostSessionMcpError("Hermes host MCP connection is no longer active"),
          );
          return;
        }
        const message = {
          jsonrpc: "2.0",
          id: requestId,
          method: "tools/call",
          params: { name: HOST_CONVERSATE_CUES_TOOL, arguments: request },
        };
        if (!this.isBoundedMessage(message)) {
          this.settleConversateCueError(
            cueRequest,
            new HostSessionMcpError("Hermes Conversate cue request exceeded the bounded message limit"),
          );
          return;
        }
        cueRequest.sent = true;
        try {
          this.options.send(message);
        } catch (error) {
          this.settleConversateCueError(
            cueRequest,
            asMcpError(error, "Unable to send Hermes Conversate cue request"),
          );
        }
      }).catch((error) => {
        this.settleConversateCueError(cueRequest, asMcpError(error, "Hermes host MCP initialization failed"));
      });
    }

    return {
      requestId,
      result,
      cancel: (reason = "Conversate cue request cancelled") =>
        this.cancelConversateCueRequest(cueRequest, reason, false),
    };
  }

  /** Send one store-issued exact Cockpit command through the authenticated Host MCP. */
  sendCockpitCommand(command: object): boolean {
    if (this.lifecycle !== "initialized" || !isRecord(command) || typeof command.command_id !== "string") return false;
    const requestId = this.nextRequestId("cockpit-command");
    const message = {
      jsonrpc: "2.0",
      id: requestId,
      method: "tools/call",
      params: { name: HOST_COCKPIT_COMMAND_TOOL, arguments: command },
    };
    if (!this.sendIfActive(message)) return false;
    this.cockpitCommandRequests.set(requestId, command.command_id);
    return true;
  }

  /** Handle one decoded JSON-RPC message from the negotiated host-mcp channel. */
  handleMessage(msg: unknown): void {
    if (this.lifecycle === "closed" || !isRecord(msg)) return;
    if (!this.options.isConnectionGenerationActive()) {
      this.close("Hermes host MCP connection is no longer active");
      return;
    }

    if (msg.id === this.initializeRequestId && this.lifecycle === "initializing") {
      this.handleInitializeResponse(msg);
      return;
    }

    const voiceRequest = this.activeVoiceRequest;
    if (voiceRequest && msg.id === voiceRequest.requestId) {
      this.handleVoiceResponse(msg, voiceRequest);
      return;
    }

    const cueRequest = this.activeConversateCueRequest;
    if (cueRequest && msg.id === cueRequest.requestId) {
      this.handleConversateCueResponse(msg, cueRequest);
      return;
    }

    if (this.statusRequestId !== null && msg.id === this.statusRequestId) {
      this.handleStatusResponse(msg);
      return;
    }


    if (this.cockpitRequestId !== null && msg.id === this.cockpitRequestId) {
      this.handleCockpitResponse(msg);
      return;
    }

    if (this.cockpitSubscriptionRequestId !== null && msg.id === this.cockpitSubscriptionRequestId) {
      this.cockpitSubscriptionRequestId = null;
      return;
    }

    if (typeof msg.id === "string" && this.cockpitCommandRequests.has(msg.id)) {
      this.handleCockpitCommandResponse(msg, this.cockpitCommandRequests.get(msg.id)!);
      this.cockpitCommandRequests.delete(msg.id);
      return;
    }

    // Progress, logging, tools/list_changed, and cancellation acknowledgements
    // are deliberately transport-private. The glasses receive only the final
    // CallToolResult through the bridge callbacks.
    if (msg.jsonrpc === "2.0" && msg.method === "notifications/resources/updated" && msg.id === undefined) {
      const params = msg.params;
      if (isRecord(params) && params.uri === COCKPIT_STATE_RESOURCE_URI) this.requestCockpitState();
      return;
    }
    if (msg.jsonrpc === "2.0" && typeof msg.method === "string" && msg.id === undefined) return;

    // No client capabilities are advertised, so server-to-client requests are
    // unsupported. Reply according to JSON-RPC without exposing them to UI.
    if (msg.jsonrpc === "2.0" && typeof msg.method === "string" && isRequestId(msg.id)) {
      this.sendIfActive({
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: -32601, message: `Method not supported: ${msg.method}` },
      });
    }
  }

  /** Retire this exact connection generation and reject all owned work. */
  close(reason = "Hermes host MCP connection closed"): void {
    if (this.lifecycle === "closed") return;
    this.lifecycle = "closed";
    this.clearInitializeTimer();
    const error = new HostSessionMcpError(reason);
    this.rejectInitialized(error);
    const voiceRequest = this.activeVoiceRequest;
    if (voiceRequest) this.settleVoiceError(voiceRequest, error);
    const cueRequest = this.activeConversateCueRequest;
    if (cueRequest) this.settleConversateCueError(cueRequest, error);
    this.cockpitCommandRequests.clear();
  }

  private startInitialization(): void {
    const message = {
      jsonrpc: "2.0",
      id: this.initializeRequestId,
      method: "initialize",
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "hermes-g2-host-session", version: "1.0.0" },
      },
    };
    if (!this.options.isConnectionGenerationActive()) {
      this.failInitialization(new HostSessionMcpError("Hermes host MCP connection is no longer active"));
      return;
    }
    this.initializeTimer = setTimeout(() => {
      this.failInitialization(new HostSessionMcpError("Hermes host MCP initialization timed out"));
    }, this.options.initializeTimeoutMs ?? DEFAULT_INITIALIZE_TIMEOUT_MS);
    try {
      this.options.send(message);
    } catch (error) {
      this.failInitialization(asMcpError(error, "Unable to initialize Hermes host MCP"));
    }
  }

  private handleInitializeResponse(msg: Record<string, unknown>): void {
    if (!isJsonRpcResponse(msg)) {
      this.failInitialization(new HostSessionMcpError("Invalid Hermes host MCP initialize response"));
      return;
    }
    const remoteError = jsonRpcError(msg);
    if (remoteError) {
      this.failInitialization(remoteError);
      return;
    }
    const result = msg.result;
    if (!isRecord(result) || result.protocolVersion !== MCP_PROTOCOL_VERSION ||
        !isRecord(result.capabilities) || !isRecord(result.serverInfo) ||
        typeof result.serverInfo.name !== "string" || typeof result.serverInfo.version !== "string") {
      this.failInitialization(new HostSessionMcpError("Hermes host MCP negotiated an invalid initialize result"));
      return;
    }
    this.clearInitializeTimer();
    if (!this.sendIfActive({ jsonrpc: "2.0", method: "notifications/initialized" })) {
      this.failInitialization(new HostSessionMcpError("Hermes host MCP connection is no longer active"));
      return;
    }
    this.lifecycle = "initialized";
    this.resolveInitialized();
    this.requestStatus();
    this.subscribeCockpitState();
    this.requestCockpitState();
  }

  private subscribeCockpitState(): void {
    if (this.lifecycle !== "initialized" || this.cockpitSubscriptionRequestId !== null) return;
    const requestId = this.nextRequestId("cockpit-subscribe");
    if (!this.sendIfActive({
      jsonrpc: "2.0", id: requestId, method: "resources/subscribe",
      params: { uri: COCKPIT_STATE_RESOURCE_URI },
    })) return;
    this.cockpitSubscriptionRequestId = requestId;
  }

  requestCockpitState(): void {
    if (this.lifecycle !== "initialized") return;
    if (this.cockpitRequestId !== null) {
      this.cockpitRefreshPending = true;
      return;
    }
    const requestId = this.nextRequestId("cockpit-state");
    if (!this.sendIfActive({
      jsonrpc: "2.0", id: requestId, method: "resources/read",
      params: { uri: COCKPIT_STATE_RESOURCE_URI },
    })) return;
    this.cockpitRequestId = requestId;
  }

  private handleCockpitResponse(msg: Record<string, unknown>): void {
    this.cockpitRequestId = null;
    if (isJsonRpcResponse(msg) && !jsonRpcError(msg)) {
      const frame = parseCockpitResource(msg.result);
      if (frame !== null) this.options.onCockpitFrame?.(frame);
    }
    if (this.cockpitRefreshPending) {
      this.cockpitRefreshPending = false;
      this.requestCockpitState();
    }
  }

  private handleCockpitCommandResponse(msg: Record<string, unknown>, commandId: string): void {
    if (!isJsonRpcResponse(msg) || jsonRpcError(msg)) return;
    const result = msg.result;
    if (!isRecord(result) || !Array.isArray(result.content) || result.content.length !== 1) return;
    const block = result.content[0];
    if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string" ||
        utf8ByteLength(block.text) > MAX_ERROR_TEXT_CHARS) return;
    let receipt: unknown;
    try { receipt = JSON.parse(block.text); } catch { return; }
    if (!isRecord(receipt) || receipt.command_id !== commandId || receipt.type !== "command_receipt") return;
    this.options.onCockpitFrame?.(receipt);
  }

  /** Refresh bounded Host MCP health; Cockpit state is a separate resource. */
  requestStatus(): void {
    if (this.lifecycle !== "initialized" || this.statusRequestId !== null) return;
    const requestId = this.nextRequestId("status");
    const message = {
      jsonrpc: "2.0",
      id: requestId,
      method: "resources/read",
      params: { uri: HOST_STATUS_RESOURCE_URI },
    };
    if (!this.sendIfActive(message)) return;
    this.statusRequestId = requestId;
  }

  private handleStatusResponse(msg: Record<string, unknown>): void {
    this.statusRequestId = null;
    if (!isJsonRpcResponse(msg) || jsonRpcError(msg)) return;
    const parsed = parseHostStatusResource(msg.result);
    if (parsed) this.options.onStatus?.(parsed);
  }

  private handleVoiceResponse(msg: Record<string, unknown>, voiceRequest: VoiceRequest): void {
    if (!isJsonRpcResponse(msg)) {
      this.settleVoiceError(voiceRequest, new HostSessionMcpError("Invalid Hermes voice response"));
      return;
    }
    const remoteError = jsonRpcError(msg);
    if (remoteError) {
      this.settleVoiceError(voiceRequest, remoteError);
      return;
    }
    const parsed = parseVoiceCallToolResult(msg.result, voiceRequest.turnId);
    if (parsed instanceof Error) {
      this.settleVoiceError(voiceRequest, parsed);
      return;
    }
    this.settleVoiceSuccess(voiceRequest, parsed);
  }

  private handleConversateCueResponse(
    msg: Record<string, unknown>,
    cueRequest: ConversateCueRequest,
  ): void {
    if (!isJsonRpcResponse(msg)) {
      this.settleConversateCueError(cueRequest, new HostSessionMcpError("Invalid Hermes Conversate cue response"));
      return;
    }
    const remoteError = jsonRpcError(msg);
    if (remoteError) {
      this.settleConversateCueError(cueRequest, remoteError);
      return;
    }
    const parsed = parseConversateCueCallToolResult(msg.result, cueRequest.expected);
    if (parsed instanceof Error) {
      this.settleConversateCueError(cueRequest, parsed);
      return;
    }
    this.settleConversateCueSuccess(cueRequest, parsed);
  }

  private cancelVoiceRequest(voiceRequest: VoiceRequest, reason: string, timedOut: boolean): void {
    if (voiceRequest.settled || this.activeVoiceRequest !== voiceRequest) return;
    if (voiceRequest.sent && this.options.isConnectionGenerationActive()) {
      this.sendIfActive({
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: voiceRequest.requestId, reason: boundedReason(reason) },
      });
    }
    const error = timedOut
      ? new HostSessionMcpError("Hermes voice turn timed out")
      : new HostSessionMcpCancelledError(boundedReason(reason));
    this.settleVoiceError(voiceRequest, error);
  }

  private settleVoiceSuccess(voiceRequest: VoiceRequest, result: HostVoiceTurnResult): void {
    if (voiceRequest.settled || this.activeVoiceRequest !== voiceRequest) return;
    voiceRequest.settled = true;
    if (voiceRequest.timer) clearTimeout(voiceRequest.timer);
    voiceRequest.timer = null;
    this.activeVoiceRequest = null;
    voiceRequest.resolve(result);
  }

  private settleVoiceError(voiceRequest: VoiceRequest, error: Error): void {
    if (voiceRequest.settled) return;
    voiceRequest.settled = true;
    if (voiceRequest.timer) clearTimeout(voiceRequest.timer);
    voiceRequest.timer = null;
    if (this.activeVoiceRequest === voiceRequest) this.activeVoiceRequest = null;
    voiceRequest.reject(error);
  }

  private cancelConversateCueRequest(
    cueRequest: ConversateCueRequest,
    reason: string,
    timedOut: boolean,
  ): void {
    if (cueRequest.settled || this.activeConversateCueRequest !== cueRequest) return;
    if (cueRequest.sent && this.options.isConnectionGenerationActive()) {
      this.sendIfActive({
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: cueRequest.requestId, reason: boundedReason(reason) },
      });
    }
    const error = timedOut
      ? new HostSessionMcpError("Hermes Conversate cue request timed out")
      : new HostSessionMcpCancelledError(boundedReason(reason));
    this.settleConversateCueError(cueRequest, error);
  }

  private settleConversateCueSuccess(
    cueRequest: ConversateCueRequest,
    result: HostConversateCuesResult,
  ): void {
    if (cueRequest.settled || this.activeConversateCueRequest !== cueRequest) return;
    cueRequest.settled = true;
    if (cueRequest.timer) clearTimeout(cueRequest.timer);
    cueRequest.timer = null;
    this.activeConversateCueRequest = null;
    cueRequest.resolve(result);
  }

  private settleConversateCueError(cueRequest: ConversateCueRequest, error: Error): void {
    if (cueRequest.settled) return;
    cueRequest.settled = true;
    if (cueRequest.timer) clearTimeout(cueRequest.timer);
    cueRequest.timer = null;
    if (this.activeConversateCueRequest === cueRequest) this.activeConversateCueRequest = null;
    cueRequest.reject(error);
  }

  private failInitialization(error: Error): void {
    if (this.lifecycle !== "initializing") return;
    this.lifecycle = "failed";
    this.initializationFailure = error;
    this.clearInitializeTimer();
    this.rejectInitialized(error);
  }

  private clearInitializeTimer(): void {
    if (!this.initializeTimer) return;
    clearTimeout(this.initializeTimer);
    this.initializeTimer = null;
  }

  private nextRequestId(kind: string): string {
    return `host-mcp:${String(this.options.connectionGeneration)}:${kind}:${++this.requestSequence}`;
  }

  private isBoundedMessage(msg: object): boolean {
    try {
      return utf8ByteLength(JSON.stringify(msg)) <= MAX_OUTBOUND_MCP_BYTES;
    } catch {
      return false;
    }
  }

  private sendIfActive(msg: object): boolean {
    if (this.lifecycle === "closed" || !this.options.isConnectionGenerationActive() || !this.isBoundedMessage(msg)) return false;
    try {
      this.options.send(msg);
      return true;
    } catch {
      return false;
    }
  }
}

function parseVoiceCallToolResult(value: unknown, expectedTurnId: string): HostVoiceTurnResult | Error {
  if (!isRecord(value) || !Array.isArray(value.content) || value.content.length !== 1 ||
      (value.isError !== undefined && typeof value.isError !== "boolean")) {
    return new HostSessionMcpError("Hermes voice tool returned an invalid CallToolResult");
  }
  const block = value.content[0];
  if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") {
    return new HostSessionMcpError("Hermes voice tool must return exactly one text content block");
  }
  if (value.isError === true) {
    const message = block.text.length <= MAX_ERROR_TEXT_CHARS && block.text.length > 0
      ? block.text
      : "Hermes voice turn failed";
    return new HostSessionMcpError(message);
  }
  let terminal: unknown;
  try {
    terminal = JSON.parse(block.text);
  } catch {
    return new HostSessionMcpError("Hermes voice tool returned invalid terminal JSON");
  }
  if (!isRecord(terminal) || !hasExactKeys(terminal, ["turnId", "text", "stopReason"]) ||
      terminal.turnId !== expectedTurnId || typeof terminal.text !== "string" ||
      terminal.text.length > MAX_RESULT_TEXT_CHARS ||
      (terminal.stopReason !== null && typeof terminal.stopReason !== "string") ||
      (typeof terminal.stopReason === "string" && terminal.stopReason.length > MAX_STOP_REASON_CHARS)) {
    return new HostSessionMcpError("Hermes voice tool returned an invalid terminal result");
  }
  return {
    turnId: terminal.turnId,
    text: terminal.text,
    stopReason: terminal.stopReason,
  };
}

function parseConversateCueCallToolResult(
  value: unknown,
  expected: HostConversateCuesRequest,
): HostConversateCuesResult | Error {
  if (!isRecord(value) || !Array.isArray(value.content) || value.content.length !== 1 ||
      (value.isError !== undefined && typeof value.isError !== "boolean")) {
    return new HostSessionMcpError("Hermes Conversate cue tool returned an invalid CallToolResult");
  }
  const block = value.content[0];
  if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") {
    return new HostSessionMcpError("Hermes Conversate cue tool must return exactly one text content block");
  }
  if (value.isError === true) {
    const message = block.text.length <= MAX_ERROR_TEXT_CHARS && block.text.length > 0
      ? block.text
      : "Hermes Conversate cues are temporarily unavailable";
    return new HostSessionMcpError(message);
  }
  let terminal: unknown;
  try {
    terminal = JSON.parse(block.text);
  } catch {
    return new HostSessionMcpError("Hermes Conversate cue tool returned invalid JSON");
  }
  if (!isRecord(terminal) || !hasExactKeys(terminal, ["sessionId", "revision", "cues"]) ||
      terminal.sessionId !== expected.sessionId || terminal.revision !== expected.revision ||
      !Array.isArray(terminal.cues) || terminal.cues.length > MAX_CUES) {
    return new HostSessionMcpError("Hermes Conversate cue tool returned an invalid terminal result");
  }
  const cues: HostConversateCue[] = [];
  for (const cue of terminal.cues) {
    if (!isRecord(cue) || !hasExactKeys(cue, ["kind", "text"]) ||
        typeof cue.kind !== "string" || !["question", "topic", "action"].includes(cue.kind) ||
        typeof cue.text !== "string" || !isBoundedOneLine(cue.text, MAX_CUE_TEXT_SCALARS)) {
      return new HostSessionMcpError("Hermes Conversate cue tool returned an invalid cue");
    }
    cues.push({ kind: cue.kind as HostConversateCueKind, text: cue.text });
  }
  return { sessionId: terminal.sessionId, revision: terminal.revision, cues };
}

function parseHostStatusResource(value: unknown): HostSessionStatus | null {
  if (!isRecord(value) || !hasExactKeys(value, ["contents"]) ||
      !Array.isArray(value.contents) || value.contents.length !== 1) return null;
  const block = value.contents[0];
  if (!isRecord(block) || !hasExactKeys(block, ["uri", "mimeType", "text"]) ||
      block.uri !== HOST_STATUS_RESOURCE_URI || block.mimeType !== "application/json" ||
      typeof block.text !== "string" || utf8ByteLength(block.text) > MAX_ERROR_TEXT_CHARS) return null;
  let document: unknown;
  try {
    document = JSON.parse(block.text);
  } catch {
    return null;
  }
  if (!isRecord(document) || !hasExactKeys(document,
    ["schemaVersion", "connectionGeneration", "profile", "transport", "sessionMcp", "cockpit", "companion"]) ||
      document.schemaVersion !== 1 || typeof document.connectionGeneration !== "string" ||
      !/^[A-Za-z0-9._-]{12,128}$/.test(document.connectionGeneration) ||
      document.profile !== "even-g2") return null;
  const transport = document.transport;
  const sessionMcp = document.sessionMcp;
  const cockpit = document.cockpit;
  const companion = document.companion;
  if (!isRecord(transport) || !hasExactKeys(transport, ["state", "authenticated"]) ||
      transport.state !== "online" || transport.authenticated !== true ||
      !isRecord(sessionMcp) || !hasExactKeys(sessionMcp, ["state", "voiceTurnState", "legacyChatFallback"]) ||
      sessionMcp.state !== "ready" || !["idle", "running", "cancelling"].includes(String(sessionMcp.voiceTurnState)) ||
      sessionMcp.legacyChatFallback !== false ||
      !isRecord(cockpit) || !hasExactKeys(cockpit, ["state", "transport", "projection", "sharedSessions", "commandsAvailable"]) ||
      cockpit.state !== "online" || cockpit.transport !== "mcp-resource" || cockpit.projection !== "session-snapshot" ||
      !Number.isSafeInteger(cockpit.sharedSessions) || Number(cockpit.sharedSessions) < 0 || Number(cockpit.sharedSessions) > 8 ||
      typeof cockpit.commandsAvailable !== "boolean" ||
      !isRecord(companion) || !hasExactKeys(companion, ["state", "reason", "commandsAvailable"]) ||
      companion.state !== "unavailable" || companion.reason !== "backend-authority-absent" ||
      companion.commandsAvailable !== false) return null;
  return {
    connectionGeneration: document.connectionGeneration,
    voiceTurnState: sessionMcp.voiceTurnState as HostSessionStatus["voiceTurnState"],
  };
}

function parseCockpitResource(value: unknown): unknown | null {
  if (!isRecord(value) || !hasExactKeys(value, ["contents"]) ||
      !Array.isArray(value.contents) || value.contents.length !== 1) return null;
  const block = value.contents[0];
  if (!isRecord(block) || !hasExactKeys(block, ["uri", "mimeType", "text"]) ||
      block.uri !== COCKPIT_STATE_RESOURCE_URI || block.mimeType !== "application/json" ||
      typeof block.text !== "string" || utf8ByteLength(block.text) > 48 * 1024) return null;
  try {
    const frame = JSON.parse(block.text);
    return isRecord(frame) && frame.type === "snapshot" ? frame : null;
  } catch {
    return null;
  }
}

function jsonRpcError(msg: Record<string, unknown>): Error | null {
  if (msg.error === undefined) return null;
  if (!isRecord(msg.error) || typeof msg.error.code !== "number" || typeof msg.error.message !== "string") {
    return new HostSessionMcpError("Hermes host returned an invalid JSON-RPC error");
  }
  const message = msg.error.message.length <= MAX_ERROR_TEXT_CHARS
    ? msg.error.message
    : "Hermes host returned an oversized error";
  return new HostSessionMcpError(message);
}

function isJsonRpcResponse(msg: Record<string, unknown>): boolean {
  if (msg.jsonrpc !== "2.0" || typeof msg.method === "string") return false;
  const hasResult = Object.prototype.hasOwnProperty.call(msg, "result");
  const hasError = Object.prototype.hasOwnProperty.call(msg, "error");
  return hasResult !== hasError;
}

function isRecord(value: unknown): value is Record<string, any> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isRequestId(value: unknown): value is string | number {
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}

function isBoundedTurnId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_TURN_ID_CHARS;
}

function isBoundedConversateCueRequest(value: HostConversateCuesRequest): boolean {
  return isBoundedTurnId(value.sessionId) && Number.isSafeInteger(value.revision) && value.revision > 0 &&
    isBoundedOneLine(value.transcript, MAX_CUE_TRANSCRIPT_SCALARS);
}

function isBoundedOneLine(value: unknown, maxScalars: number): value is string {
  if (typeof value !== "string" || !value.trim() || Array.from(value).length > maxScalars) return false;
  return !/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/u.test(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function boundedReason(reason: string): string {
  const value = typeof reason === "string" && reason.length > 0 ? reason : "Cancelled";
  return value.slice(0, MAX_ERROR_TEXT_CHARS);
}

function asMcpError(error: unknown, fallback: string): HostSessionMcpError {
  const message = error instanceof Error && error.message ? error.message : fallback;
  return new HostSessionMcpError(message.slice(0, MAX_ERROR_TEXT_CHARS));
}

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length &&
             value.charCodeAt(index + 1) >= 0xdc00 && value.charCodeAt(index + 1) <= 0xdfff) {
      bytes += 4;
      index += 1;
    } else bytes += 3;
  }
  return bytes;
}
