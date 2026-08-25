import { toolRegistry, type ToolRegistry } from "./tool-registry";

/**
 * Minimal MCP (Model Context Protocol) server surface over the assistant
 * bridge's `mcp` channel. The phone serves its ToolRegistry to the external
 * agent: `tools/list`, `tools/call`, and `notifications/tools/list_changed`
 * (emitted by the bridge client when the registry changes).
 *
 * Transport-agnostic: the bridge client hands decoded JSON-RPC messages to
 * handleMessage and provides `send` to deliver replies/notifications.
 */

const MCP_PROTOCOL_VERSION = "2025-06-18";

/** Proactive display actions are rate-limited to this many per minute. */
const PROACTIVE_CALLS_PER_MINUTE = 6;

function createAbortController(): AbortController {
  const NativeController = (globalThis as any).AbortController;
  if (typeof NativeController === "function") return new NativeController();
  const listeners = new Set<() => void>();
  const signal = {
    aborted: false,
    addEventListener(type: string, listener: () => void) { if (type === "abort") listeners.add(listener); },
    removeEventListener(type: string, listener: () => void) { if (type === "abort") listeners.delete(listener); },
  } as unknown as AbortSignal;
  return {
    signal,
    abort() {
      if (signal.aborted) return;
      (signal as unknown as { aborted: boolean }).aborted = true;
      for (const listener of [...listeners]) {
        try { listener(); } catch { /* one bad listener must not block cancellation */ }
      }
      listeners.clear();
    },
  } as AbortController;
}

export type McpServerOptions = {
  send: (msg: object) => void;
  /** Whether a voice turn is currently in flight (calls outside one are "proactive"). */
  isTurnActive: () => boolean;
  /** Stable unique generation for the currently authorized voice turn. */
  getTurnGeneration?: () => string | null;
  /** Master setting gate for proactive calls (assistant.allowProactive). */
  allowProactive: () => boolean;
  /** True only for direct/on-device or server-authenticated confidential callers. */
  isHealthCallerTrusted?: () => boolean;
  /** Unique generation of the connection owning this MCP server. */
  connectionGeneration?: string | number;
  /** Authenticated deployment profile bound to this MCP server. */
  profileId?: string;
  /** Dynamic authenticated profile claim from the completed bridge handshake. */
  getProfileId?: () => string | null;
  /** Revalidates that this server's connection is still the live one. */
  isConnectionGenerationActive?: () => boolean;
  registry?: ToolRegistry;
};

export type McpCallAuthorization =
  | { turnGeneration: string; proactive?: false }
  | { proactive: true; turnGeneration?: never };

export class AssistantMcpServer {
  private readonly registry: ToolRegistry;
  private readonly proactiveCallTimes: number[] = [];
  private lifecycle: "new" | "initializing" | "initialized" = "new";
  private closed = false;
  private epoch = 0;
  private readonly activeRequestIds = new Set<string>();
  private readonly completedRequestIds = new Set<string>();
  private readonly completedRequestOrder: string[] = [];
  private readonly activeCallControllers = new Map<string, AbortController>();

  constructor(private readonly options: McpServerOptions) {
    this.registry = options.registry ?? toolRegistry;
  }

  /** Notify the agent that the live tool set changed. */
  sendToolsChanged(): void {
    if (this.closed || this.lifecycle !== "initialized") return;
    this.options.send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
  }

  handleMessage(msg: any, authorization?: McpCallAuthorization): void {
    if (this.closed) return;
    const id = msg?.id;
    const validId = typeof id === "string" || typeof id === "number";
    if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string" || id === null) {
      if (validId) this.replyError(id, -32600, "Invalid Request");
      return;
    }
    const isNotification = id === undefined;

    switch (msg.method) {
      case "initialize":
        if (!validId || this.lifecycle !== "new") {
          if (validId) this.replyError(id, -32600, "Already initialized");
          return;
        }
        this.lifecycle = "initializing";
        this.reply(id, {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: "hermes-g2", version: "1.0.0" },
        });
        return;
      case "notifications/initialized":
        if (isNotification && this.lifecycle === "initializing") this.lifecycle = "initialized";
        return;
      case "notifications/cancelled": {
        if (!isNotification || this.lifecycle !== "initialized" || !msg.params ||
            typeof msg.params !== "object" || Array.isArray(msg.params)) return;
        const keys = Object.keys(msg.params);
        if (!keys.includes("requestId") || keys.some((key) => key !== "requestId" && key !== "reason")) return;
        const requestId = msg.params.requestId;
        if (typeof requestId !== "string" && typeof requestId !== "number") return;
        if (msg.params.reason !== undefined && typeof msg.params.reason !== "string") return;
        this.activeCallControllers.get(`${typeof requestId}:${String(requestId)}`)?.abort();
        return;
      }
      case "ping":
        this.reply(id, {});
        return;
      case "tools/list":
        if (!validId) return;
        if (!this.requireInitialized(id)) return;
        this.reply(id, {
          tools: this.registry.listTools().filter((spec) => this.isHealthVisible(spec.name) && this.profilePolicyError(spec.name) === null).map((spec) => ({
            name: spec.name,
            description: spec.description,
            inputSchema: spec.inputSchema,
          })),
        });
        return;
      case "tools/call":
        if (!validId) return; // never execute side effects from notifications
        if (!this.requireInitialized(id)) return;
        if (!msg.params || typeof msg.params !== "object" || typeof msg.params.name !== "string" ||
            (msg.params.arguments !== undefined && (!msg.params.arguments || typeof msg.params.arguments !== "object" || Array.isArray(msg.params.arguments)))) {
          this.replyError(id, -32602, "Invalid tools/call parameters");
          return;
        }
        const requestKey = `${typeof id}:${String(id)}`;
        if (this.activeRequestIds.has(requestKey) || this.completedRequestIds.has(requestKey)) {
          this.replyError(id, -32600, "Duplicate request id");
          return;
        }
        this.activeRequestIds.add(requestKey);
        void this.handleToolCall(id, msg.params, requestKey, authorization);
        return;
      default:
        if (!isNotification) {
          this.options.send({
            jsonrpc: "2.0",
            id,
            error: { code: -32601, message: `Method not supported: ${msg.method}` },
          });
        }
        return;
    }
  }

  private async handleToolCall(
    id: unknown,
    params: any,
    requestKey: string,
    authorization?: McpCallAuthorization,
  ): Promise<void> {
    const epoch = this.epoch;
    const callController = createAbortController();
    this.activeCallControllers.set(requestKey, callController);
    try {
      const name = typeof params?.name === "string" ? params.name : "";
      const args = params?.arguments ?? {};
      const profileDenied = this.profilePolicyError(name);
      if (profileDenied) {
        this.replyToolError(id, profileDenied);
        return;
      }
      const healthDenied = this.healthPolicyError(name);
      if (healthDenied) {
        this.replyToolError(id, healthDenied);
        return;
      }
      const proactive = authorization?.proactive === true;
      const turnGeneration = proactive ? null : authorization?.turnGeneration ?? null;
      if (!proactive && (!turnGeneration || !this.options.isTurnActive() || this.options.getTurnGeneration?.() !== turnGeneration)) {
        this.replyToolError(id, "The MCP request is not bound to the exact current assistant turn");
        return;
      }
      if (name === "health.get_ring_data" && !proactive && !turnGeneration) {
        this.replyToolError(id, "No current assistant turn authorizes this action");
        return;
      }
      if (proactive && !this.options.allowProactive()) {
        this.replyToolError(id, "Proactive assistant actions are disabled in Settings");
        return;
      }
      const preflight = this.registry.preflightTool(name, args, { proactive });
      if (preflight) {
        if (preflight.error?.startsWith("Unknown tool:") || preflight.error?.startsWith("Invalid arguments")) {
          this.replyError(id, -32602, preflight.error);
        } else {
          this.replyToolError(id, preflight.error ?? "Tool unavailable");
        }
        return;
      }
      if (proactive && !this.admitProactiveCall()) {
        this.replyToolError(id, "Proactive action rate limit exceeded; try again later");
        return;
      }
      const isProactiveStillAllowed = () => !proactive || this.options.allowProactive();
      const result = await this.registry.callTool(name, args, {
        proactive,
        turnGeneration,
        isTurnGenerationActive: () =>
          !callController.signal.aborted &&
          (this.options.isConnectionGenerationActive?.() ?? false) &&
          isProactiveStillAllowed() &&
          (proactive || (this.options.isTurnActive() && this.options.getTurnGeneration?.() === turnGeneration)),
        isCallAllowed: () => {
          if (!(this.options.isConnectionGenerationActive?.() ?? false)) return "The owning MCP connection is no longer active";
          if (!isProactiveStillAllowed()) return "Proactive assistant actions are disabled in Settings";
          return this.healthPolicyError(name, turnGeneration);
        },
        signal: callController.signal,
        executionContext: {
          caller: "mcp",
          proactive,
          profileId: this.options.getProfileId?.() ?? this.options.profileId,
          connectionGeneration: this.options.connectionGeneration,
          turnGeneration,
        },
      });
      if (callController.signal.aborted) return;
      if (this.closed || epoch !== this.epoch) return;
      if (
        proactive &&
        !this.options.allowProactive() &&
        !(name === "glasses.notify_result" && result.ok)
      ) {
        this.replyToolError(id, "Proactive assistant actions were disabled before completion; no success was reported");
        return;
      }
      this.reply(id, {
        content: [{ type: "text", text: result.ok ? result.content ?? "" : result.error ?? "Tool error" }],
        isError: !result.ok,
      });
    } catch (error) {
      if (!callController.signal.aborted && !this.closed && epoch === this.epoch) {
        this.replyError(id, -32603, String((error as Error)?.message ?? error));
      }
    } finally {
      this.activeCallControllers.delete(requestKey);
      this.activeRequestIds.delete(requestKey);
      if (!this.closed && epoch === this.epoch) this.rememberCompleted(requestKey);
    }
  }

  private isHealthVisible(name: string): boolean {
    return name !== "health.get_ring_data" || this.healthPolicyError(name) === null;
  }

  private profilePolicyError(name: string): string | null {
    const requiresEvenG2 =
      name === "glasses.notify_result" ||
      name.startsWith("glasses.work_board.") ||
      name.startsWith("glasses.clock.") ||
      name.startsWith("glasses.context_dashboard.");
    if (!requiresEvenG2 || (this.options.getProfileId?.() ?? this.options.profileId) === "even-g2") return null;
    return name === "glasses.notify_result"
      ? "Direct glasses result notifications are available only to the authenticated even-g2 profile"
      : name.startsWith("glasses.work_board.")
        ? "Work Tasks is available only to the authenticated even-g2 profile"
      : name.startsWith("glasses.clock.")
        ? "Clock is available only to the authenticated even-g2 profile"
      : "Context dashboards are available only to the authenticated even-g2 profile";
  }

  private healthPolicyError(name: string, expectedTurnGeneration?: string | null): string | null {
    if (name !== "health.get_ring_data") return null;
    if (!this.options.isHealthCallerTrusted?.()) return "Health data is unavailable to an unverified external caller";
    if (this.options.connectionGeneration === undefined || this.options.connectionGeneration === "") {
      return "Health data requires a live connection generation";
    }
    if (typeof this.options.isConnectionGenerationActive !== "function" || !this.options.isConnectionGenerationActive()) {
      return "Health data requires the current live connection";
    }
    if (typeof this.options.getTurnGeneration !== "function") {
      return "Health data requires a unique live assistant turn";
    }
    const turnGeneration = this.options.getTurnGeneration();
    if (!this.options.isTurnActive() || !turnGeneration) {
      return "Health data requires a unique live assistant turn";
    }
    if (expectedTurnGeneration !== undefined && turnGeneration !== expectedTurnGeneration) {
      return "The authorizing assistant turn is no longer active; no side effect was sent.";
    }
    return null;
  }

  /** Sliding-window rate limiter for proactive calls. */
  private admitProactiveCall(): boolean {
    const now = Date.now();
    while (this.proactiveCallTimes.length && now - this.proactiveCallTimes[0]! > 60_000) {
      this.proactiveCallTimes.shift();
    }
    if (this.proactiveCallTimes.length >= PROACTIVE_CALLS_PER_MINUTE) return false;
    this.proactiveCallTimes.push(now);
    return true;
  }

  private reply(id: unknown, result: object): void {
    if (id === undefined || id === null) return;
    this.options.send({ jsonrpc: "2.0", id, result });
  }

  private replyToolError(id: unknown, text: string): void {
    this.reply(id, { content: [{ type: "text", text }], isError: true });
  }

  private requireInitialized(id: unknown): boolean {
    if (this.lifecycle === "initialized") return true;
    this.replyError(id, -32002, "MCP server is not initialized");
    return false;
  }

  private replyError(id: unknown, code: number, message: string): void {
    if (id === undefined || id === null) return;
    this.options.send({ jsonrpc: "2.0", id, error: { code, message } });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.epoch += 1;
    for (const controller of this.activeCallControllers.values()) controller.abort();
    this.activeCallControllers.clear();
    if (this.options.connectionGeneration !== undefined) {
      this.registry.closeExecutionOwner({
        caller: "mcp",
        proactive: false,
        profileId: this.options.getProfileId?.() ?? this.options.profileId,
        connectionGeneration: this.options.connectionGeneration,
        turnGeneration: null,
      });
    }
    this.activeRequestIds.clear();
    this.completedRequestIds.clear();
    this.completedRequestOrder.length = 0;
  }

  private rememberCompleted(requestKey: string): void {
    this.completedRequestIds.add(requestKey);
    this.completedRequestOrder.push(requestKey);
    while (this.completedRequestOrder.length > 128) {
      this.completedRequestIds.delete(this.completedRequestOrder.shift()!);
    }
  }
}
