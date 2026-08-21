/**
 * The assistant's tool registry: the single place that knows which tools exist,
 * whether each is currently callable, and how to invoke it. Both assistant
 * backends (direct provider loop, external agent bridge) list and call tools
 * through here, so gating and timeouts are enforced in one spot rather than
 * trusted to a model or a remote agent.
 *
 * Availability tiers (see notes/voice-assistant-design.md):
 *   - "always"     system/shell tools; no app involved.
 *   - "installed"  app tool live whenever the app is installed (no window
 *                  needed) -- e.g. "start a 5 minute timer".
 *   - "open"       app tool live while the app has a window open, foreground
 *                  or backgrounded -- e.g. "next track".
 *   - "foreground" app tool live only while the app owns the foreground window
 *                  -- e.g. "scroll down".
 *
 * Phase 1 only registers "always" tools; the tier machinery is here so the
 * app-tool phases slot in without reshaping the registry.
 */

export type ToolAvailability = "always" | "installed" | "open" | "foreground";

export type ToolSpec = {
  /** Namespaced, e.g. "glasses.get_state" or "app.terminal.send_input". */
  name: string;
  description: string;
  /** JSON Schema for the tool's arguments. */
  inputSchema: object;
  availability: ToolAvailability;
  /** May be invoked outside an active voice turn (external mode proactive calls). */
  proactive?: boolean;
  /** Round-trip cap; the registry rejects with a tool error past it. Default 10s. */
  timeoutMs?: number;
};

/**
 * A tool's outcome. Flat (not a discriminated union) on purpose: this project
 * builds with strictNullChecks off, so `ok: true|false` would widen to boolean
 * and defeat union narrowing. Read `content` when ok, `error` when not.
 */
export type ToolResult = {
  ok: boolean;
  /** Text payload back to the model (when ok). */
  content?: string;
  /** Error message back to the model (when not ok). */
  error?: string;
};

export type ToolHandler = (args: any, signal?: AbortSignal, isSideEffectAllowed?: () => boolean) => Promise<ToolResult> | ToolResult;

export type ToolRegistration = {
  spec: ToolSpec;
  handler: ToolHandler;
  /**
   * Whether the tool is currently live. Absent means always live (the "always"
   * tier). App-tool phases supply a predicate keyed on window/foreground state.
   */
  isAvailable?: () => boolean;
};

type OwnedToolRegistration = ToolRegistration & { ownerWindowId?: string };

export type ListToolsOptions = {
  /** Only tools flagged proactive (for calls outside an active turn). */
  proactiveOnly?: boolean;
};

export type CallToolOptions = {
  /** The call is happening outside an active voice turn; enforce proactive gating. */
  proactive?: boolean;
  /** Last-moment caller/policy gate, checked immediately before the handler. */
  isCallAllowed?: () => string | null;
  /** Stable generation that authorized this side effect. */
  turnGeneration?: string | null;
  /** Revalidate the authorizing turn immediately before invocation. */
  isTurnGenerationActive?: () => boolean;
};

const DEFAULT_TOOL_TIMEOUT_MS = 10_000;

/** One registration as seen by the shell's tool-debug dialog. */
export type ToolDebugEntry = {
  spec: ToolSpec;
  /** The window that contributed the tool, or null for system-registered tools. */
  windowId: string | null;
  /** Whether the tool is callable right now (availability gate at snapshot time). */
  live: boolean;
};

/** How the shell reaches a window's tool handler and gates its foreground tools. */
export type AppToolProvider = {
  windowId: string;
  appId: string;
  /** The window's declared specs, with UNPREFIXED names (registry adds the prefix). */
  specs: ToolSpec[];
  /** Invoke a tool on the window by its unprefixed name. */
  invoke: (toolName: string, args: unknown) => Promise<ToolResult> | ToolResult;
  /** Whether the window currently owns the foreground (gates `foreground` tools). */
  isForeground: () => boolean;
};

/** Opaque identity for one installed generation of an app window's tools. */
export type AppToolLease = {
  readonly windowId: string;
  readonly generation: symbol;
};

export class ToolRegistry {
  private readonly registrations = new Map<string, OwnedToolRegistration>();
  private readonly changeListeners = new Set<() => void>();
  // windowId -> the canonical (prefixed) tool names it contributed, for bulk
  // removal when the window closes or re-declares.
  private readonly windowToolNames = new Map<string, string[]>();
  private readonly windowRegistrations = new Map<string, Map<string, OwnedToolRegistration>>();
  private readonly windowLeases = new Map<string, AppToolLease>();

  /** Register (or replace) a tool. Names are unique across all tiers. */
  register(registration: ToolRegistration): void {
    this.addRegistration(registration);
    this.fireToolsChanged();
  }

  /** Convenience for the always-live system tools. */
  registerSystemTool(
    spec: Omit<ToolSpec, "availability">,
    handler: ToolHandler,
  ): void {
    this.register({ spec: { ...spec, availability: "always" }, handler });
  }

  unregister(name: string): void {
    if (this.registrations.delete(name)) {
      this.fireToolsChanged();
    }
  }

  /**
   * Declare (replacing any prior set) the tools contributed by one app window.
   * Names are prefixed `app.<appId>.` so windows can't shadow system tools or
   * each other. `open` tools stay live while the window exists; `foreground`
   * tools are gated on `isForeground()` at both list and call time.
   */
  setAppTools(provider: AppToolProvider): AppToolLease {
    this.clearWindowTools(provider.windowId, false);
    const lease: AppToolLease = { windowId: provider.windowId, generation: Symbol(provider.windowId) };
    this.windowLeases.set(provider.windowId, lease);
    const names: string[] = [];
    const owned = new Map<string, OwnedToolRegistration>();
    for (const spec of provider.specs) {
      if (spec.availability !== "open" && spec.availability !== "foreground") {
        console.warn(`app tool ${spec.name} has non-app availability ${spec.availability}; skipping`);
        continue;
      }
      const canonical = `app.${provider.appId}.${spec.name}`;
      const toolName = spec.name;
      this.addRegistration({
        spec: { ...spec, name: canonical },
        handler: (args) => provider.invoke(toolName, args),
        isAvailable: spec.availability === "foreground" ? () => provider.isForeground() : undefined,
      }, provider.windowId);
      owned.set(canonical, this.registrations.get(canonical)!);
      names.push(canonical);
    }
    this.windowToolNames.set(provider.windowId, names);
    this.windowRegistrations.set(provider.windowId, owned);
    this.fireToolsChanged();
    return lease;
  }

  /** Remove one installed generation; stale or repeated releases are no-ops. */
  removeAppTools(windowId: string, lease: AppToolLease): void {
    if (this.windowLeases.get(windowId) !== lease) return;
    this.clearWindowTools(windowId, true);
  }

  private clearWindowTools(windowId: string, fire: boolean): void {
    const names = this.windowToolNames.get(windowId);
    if (!names) return;
    this.windowRegistrations.delete(windowId);
    this.windowLeases.delete(windowId);
    for (const name of names) {
      if (this.registrations.get(name)?.ownerWindowId !== windowId) continue;
      this.registrations.delete(name);
      let fallback: OwnedToolRegistration | undefined;
      for (const registrations of this.windowRegistrations.values()) {
        fallback = registrations.get(name) ?? fallback;
      }
      if (fallback) this.registrations.set(name, fallback);
    }
    this.windowToolNames.delete(windowId);
    if (fire) this.fireToolsChanged();
  }

  private addRegistration(registration: ToolRegistration, ownerWindowId?: string): void {
    this.registrations.set(registration.spec.name, { ...registration, ownerWindowId });
  }

  /** Specs for the tools callable right now, given the availability tiers. */
  listTools(options: ListToolsOptions = {}): ToolSpec[] {
    const specs: ToolSpec[] = [];
    for (const registration of this.registrations.values()) {
      try { if (!this.isLive(registration)) continue; }
      catch (error) { console.warn(`tool ${registration.spec.name} availability check failed`, error); continue; }
      if (options.proactiveOnly && !registration.spec.proactive) continue;
      specs.push(registration.spec);
    }
    return specs;
  }

  /**
   * Snapshot of every registration, including ones not currently live — for
   * the shell's debug dialog only; backends must use listTools.
   */
  listToolsForDebug(): ToolDebugEntry[] {
    const entries: ToolDebugEntry[] = [];
    for (const registration of this.registrations.values()) {
      let live = false;
      try { live = this.isLive(registration); } catch { live = false; }
      entries.push({ spec: registration.spec, windowId: registration.ownerWindowId ?? null, live });
    }
    return entries;
  }

  /**
   * Invoke a tool by name. Never throws: a missing/unavailable tool, a
   * proactive-gating rejection, a handler exception, or a timeout all come back
   * as `{ ok: false }` so the agent loop can surface them as tool errors.
   */
  preflightTool(name: string, args: unknown, options: CallToolOptions = {}): ToolResult | null {
    const registration = this.registrations.get(name);
    if (!registration) return { ok: false, error: `Unknown tool: ${name}` };
    let live = false;
    try { live = this.isLive(registration); }
    catch (error) { return { ok: false, error: `Tool ${name} availability check failed: ${describeError(error)}` }; }
    if (!live) return { ok: false, error: `Tool ${name} is not currently available` };
    const schemaError = validateJsonSchema(registration.spec.inputSchema, args);
    if (schemaError) return { ok: false, error: `Invalid arguments for ${name}: ${schemaError}` };
    if (options.proactive && !registration.spec.proactive) {
      return { ok: false, error: `Tool ${name} cannot be called outside a conversation` };
    }
    return null;
  }

  async callTool(name: string, args: unknown, options: CallToolOptions = {}): Promise<ToolResult> {
    const preflight = this.preflightTool(name, args, options);
    if (preflight) return preflight;
    const registration = this.registrations.get(name)!;
    const timeoutMs = registration.spec.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
    try {
      if (options.turnGeneration && options.isTurnGenerationActive && !options.isTurnGenerationActive()) {
        return { ok: false, error: "The authorizing assistant turn is no longer active; no side effect was sent." };
      }
      const callDenied = options.isCallAllowed?.();
      if (callDenied) return { ok: false, error: callDenied };
      const controller = new AbortController();
      return await this.withTimeout(
        registration.handler(args, controller.signal, options.isTurnGenerationActive),
        timeoutMs,
        name,
        controller,
      );
    } catch (error) {
      return { ok: false, error: `Tool ${name} failed: ${describeError(error)}` };
    }
  }

  /** Subscribe to add/remove/availability changes (drives MCP list_changed). */
  onToolsChanged(listener: () => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  /** App-tool phases call this after a foreground/window change re-gates tools. */
  fireToolsChanged(): void {
    for (const listener of this.changeListeners) {
      try {
        listener();
      } catch (error) {
        console.warn("onToolsChanged listener failed", error);
      }
    }
  }

  private isLive(registration: ToolRegistration): boolean {
    return registration.isAvailable ? registration.isAvailable() : true;
  }

  private withTimeout(
    result: Promise<ToolResult> | ToolResult,
    timeoutMs: number,
    name: string,
    controller?: AbortController,
  ): Promise<ToolResult> {
    if (!(result instanceof Promise)) return Promise.resolve(result);
    return new Promise<ToolResult>((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        controller?.abort();
        resolve({ ok: false, error: `Tool ${name} timed out after ${timeoutMs}ms` });
      }, timeoutMs);
      result.then(
        (value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({ ok: false, error: `Tool ${name} failed: ${describeError(error)}` });
        },
      );
    });
  }
}

function validateJsonSchema(schemaValue: object, value: unknown, path = "$"): string | null {
  const schema = schemaValue as any;
  if (!schema || typeof schema !== "object") return "invalid schema";
  const supported = new Set([
    "type", "properties", "required", "additionalProperties", "enum", "description", "title", "default",
    "minimum", "maximum", "minLength", "maxLength", "items", "minItems", "maxItems",
  ]);
  for (const keyword of Object.keys(schema)) {
    if (!supported.has(keyword)) return `unsupported schema keyword ${keyword}`;
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((v: unknown) => Object.is(v, value))) return `${path} is not allowed`;
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) return `${path} must be an object`;
    const record = value as Record<string, unknown>;
    const props = schema.properties && typeof schema.properties === "object" ? schema.properties : {};
    for (const key of Array.isArray(schema.required) ? schema.required : []) {
      if (!Object.prototype.hasOwnProperty.call(record, key)) return `${path}.${key} is required`;
    }
    for (const key of Object.keys(record)) {
      if (Object.prototype.hasOwnProperty.call(props, key)) continue;
      if (schema.additionalProperties === false) return `${path}.${key} is not allowed`;
      if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
        const error = validateJsonSchema(schema.additionalProperties, record[key], `${path}.${key}`);
        if (error) return error;
      } else if (schema.additionalProperties !== undefined && schema.additionalProperties !== true) {
        return `${path} has invalid additionalProperties schema`;
      }
    }
    for (const [key, child] of Object.entries(props)) {
      if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
      const error = validateJsonSchema(child as object, record[key], `${path}.${key}`);
      if (error) return error;
    }
    return null;
  }
  if (schema.type === "string") {
    if (typeof value !== "string") return `${path} must be a string`;
    if (Number.isInteger(schema.maxLength) && value.length > schema.maxLength) return `${path} is too long`;
    if (Number.isInteger(schema.minLength) && value.length < schema.minLength) return `${path} is too short`;
    return null;
  }
  if (schema.type === "number" || schema.type === "integer") {
    if (typeof value !== "number" || !Number.isFinite(value)) return `${path} must be a finite number`;
    if (schema.type === "integer" && !Number.isInteger(value)) return `${path} must be an integer`;
    if (typeof schema.minimum === "number" && value < schema.minimum) return `${path} is below minimum`;
    if (typeof schema.maximum === "number" && value > schema.maximum) return `${path} is above maximum`;
    return null;
  }
  if (schema.type === "boolean") return typeof value === "boolean" ? null : `${path} must be a boolean`;
  if (schema.type === "array") {
    if (!Array.isArray(value)) return `${path} must be an array`;
    if (Number.isInteger(schema.minItems) && value.length < schema.minItems) return `${path} has too few items`;
    if (Number.isInteger(schema.maxItems) && value.length > schema.maxItems) return `${path} has too many items`;
    if (schema.items) for (let i = 0; i < value.length; i++) {
      const error = validateJsonSchema(schema.items, value[i], `${path}[${i}]`); if (error) return error;
    }
    return null;
  }
  return schema.type === undefined ? null : `${path} uses unsupported schema type ${String(schema.type)}`;
}

function describeError(error: unknown): string {
  return "The tool could not complete safely.";
}

/** The process-wide registry; system tools register into it at startup. */
export const toolRegistry = new ToolRegistry();
