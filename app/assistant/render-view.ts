import type { ToolExecutionContext, ToolHandler, ToolResult } from "./tool-registry";

export const RENDER_VIEW_MAX_SPEC_BYTES = 16 * 1024;
export const RENDER_VIEW_MAX_TEXT_BYTES = 8 * 1024;
export const RENDER_VIEW_MAX_BLOCKS = 32;
export const RENDER_VIEW_MAX_ACTIONS = 8;
export const RENDER_VIEW_MIN_TTL_SECONDS = 30;
export const RENDER_VIEW_MAX_TTL_SECONDS = 3600;

export type RenderViewBlock =
  | { type: "text"; text: string; emphasis?: "normal" | "strong" }
  | { type: "key_value"; label: string; value: string }
  | { type: "progress"; label: string; value: number }
  | { type: "divider" };

export type RenderViewAction = { id: string; label: string };

export type RenderViewSpec = {
  version: 1;
  view_id?: string;
  expected_revision?: number;
  title: string;
  blocks: RenderViewBlock[];
  actions?: RenderViewAction[];
  ttl_seconds: number;
};

export type RenderViewState = {
  viewId: string;
  revision: number;
  ownerKey: string;
  title: string;
  blocks: RenderViewBlock[];
  actions: RenderViewAction[];
  selectedAction: number;
  expiresAtMs: number;
};

export type RenderViewEvent = {
  version: 1;
  event_id: string;
  view_id: string;
  revision: number;
  action_id: string;
  kind: "activate";
};

type TimerHandle = unknown;

export type RenderViewDependencies = {
  isDisplayAvailable: () => boolean;
  render: (state: RenderViewState, signal?: AbortSignal, isAllowed?: () => boolean) => Promise<void>;
  clear: (identity: { viewId: string; revision: number }) => void;
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimer?: (timer: TimerHandle) => void;
  createId?: () => string;
};

type OperationRecord = { fingerprint: string; result: ToolResult };

const ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const VIEW_ID_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const FORBIDDEN_TEXT = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069<>`]/u;
const URL_LIKE = /(?:https?:\/\/|www\.|\b[a-z0-9-]+\.(?:com|org|net|io|dev|app)\b)/iu;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(record: Record<string, unknown>, allowed: readonly string[]): boolean {
  const set = new Set(allowed);
  return Object.keys(record).every((key) => set.has(key));
}

function codePoints(value: string): number {
  return Array.from(value).length;
}

function utf8Bytes(value: string): number {
  if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(value).length;
  return encodeURIComponent(value).replace(/%[0-9A-F]{2}|./gi, "x").length;
}

function validText(value: unknown, maxCodePoints: number, maxBytes: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && codePoints(value) <= maxCodePoints &&
    utf8Bytes(value) <= maxBytes && !FORBIDDEN_TEXT.test(value) && !URL_LIKE.test(value);
}

/** Imperative validator for the discriminated, byte-bounded V1 view contract. */
export function validateRenderViewSpec(value: unknown): string | null {
  if (!isRecord(value)) return "spec must be an object";
  if (!exactKeys(value, ["version", "view_id", "expected_revision", "title", "blocks", "actions", "ttl_seconds"])) {
    return "spec contains an unsupported field";
  }
  let encoded = "";
  try { encoded = JSON.stringify(value); } catch { return "spec is not serializable"; }
  if (utf8Bytes(encoded) > RENDER_VIEW_MAX_SPEC_BYTES) return "spec exceeds 16 KiB";
  if (value.version !== 1) return "version must be 1";
  if (!validText(value.title, 80, 320)) return "title must be bounded inert text";
  if (!Number.isInteger(value.ttl_seconds) || (value.ttl_seconds as number) < RENDER_VIEW_MIN_TTL_SECONDS ||
      (value.ttl_seconds as number) > RENDER_VIEW_MAX_TTL_SECONDS) return "ttl_seconds is outside 30..3600";
  const hasViewId = Object.prototype.hasOwnProperty.call(value, "view_id");
  const hasRevision = Object.prototype.hasOwnProperty.call(value, "expected_revision");
  if (hasViewId !== hasRevision) return "view_id and expected_revision must be supplied together";
  if (hasViewId && (typeof value.view_id !== "string" || !VIEW_ID_PATTERN.test(value.view_id))) return "view_id is invalid";
  if (hasRevision && (!Number.isSafeInteger(value.expected_revision) || (value.expected_revision as number) < 1)) {
    return "expected_revision is invalid";
  }
  if (!Array.isArray(value.blocks) || value.blocks.length > RENDER_VIEW_MAX_BLOCKS) return "blocks exceeds 32";
  const actions = value.actions ?? [];
  if (!Array.isArray(actions) || actions.length > RENDER_VIEW_MAX_ACTIONS) return "actions exceeds 8";
  let totalTextBytes = utf8Bytes(value.title as string);
  for (const block of value.blocks) {
    if (!isRecord(block) || typeof block.type !== "string") return "block is invalid";
    switch (block.type) {
      case "text":
        if (!exactKeys(block, ["type", "text", "emphasis"]) || !validText(block.text, 1024, 1024) ||
            (block.emphasis !== undefined && block.emphasis !== "normal" && block.emphasis !== "strong")) return "text block is invalid";
        totalTextBytes += utf8Bytes(block.text);
        break;
      case "key_value":
        if (!exactKeys(block, ["type", "label", "value"]) || !validText(block.label, 80, 320) || !validText(block.value, 160, 640)) {
          return "key_value block is invalid";
        }
        totalTextBytes += utf8Bytes(block.label) + utf8Bytes(block.value);
        break;
      case "progress":
        if (!exactKeys(block, ["type", "label", "value"]) || !validText(block.label, 80, 320) ||
            typeof block.value !== "number" || !Number.isFinite(block.value) || block.value < 0 || block.value > 1) {
          return "progress block is invalid";
        }
        totalTextBytes += utf8Bytes(block.label);
        break;
      case "divider":
        if (!exactKeys(block, ["type"])) return "divider block is invalid";
        break;
      default:
        return "block type is unsupported";
    }
  }
  const actionIds = new Set<string>();
  for (const action of actions) {
    if (!isRecord(action) || !exactKeys(action, ["id", "label"]) || typeof action.id !== "string" ||
        !ID_PATTERN.test(action.id) || !validText(action.label, 40, 160) || actionIds.has(action.id)) return "action is invalid";
    actionIds.add(action.id);
    totalTextBytes += utf8Bytes(action.label);
  }
  return totalTextBytes <= RENDER_VIEW_MAX_TEXT_BYTES ? null : "display text exceeds 8 KiB";
}

function ownerKey(context?: ToolExecutionContext): string | null {
  if (!context) return null;
  if (context.caller === "mcp") {
    if (context.connectionGeneration === undefined || context.connectionGeneration === null || context.connectionGeneration === "") return null;
    return `mcp:${String(context.connectionGeneration)}`;
  }
  return context.turnGeneration ? "direct" : null;
}

function fingerprint(value: unknown): string {
  return JSON.stringify(value);
}

function defaultId(): string {
  const bytes = new Uint8Array(16);
  const cryptoObject = (globalThis as any).crypto;
  if (!cryptoObject?.getRandomValues) throw new Error("secure random identity is unavailable");
  cryptoObject.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export class RenderViewManager {
  private current: RenderViewState | null = null;
  private timer: TimerHandle | null = null;
  private readonly operations = new Map<string, OperationRecord>();
  private readonly operationOrder: string[] = [];
  private readonly createOperationOrder: string[] = [];
  private readonly acceptedAtMs: number[] = [];
  private readonly events: RenderViewEvent[] = [];
  private eventSequence = 0;
  private pendingIdentity: { viewId: string; revision: number; ownerKey: string; cancelled: boolean } | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly now: () => number;
  private readonly setTimer: (callback: () => void, delayMs: number) => TimerHandle;
  private readonly clearTimer: (timer: TimerHandle) => void;
  private readonly createId: () => string;

  constructor(private readonly deps: RenderViewDependencies) {
    this.now = deps.now ?? (() => Date.now());
    this.setTimer = deps.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.clearTimer = deps.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
    this.createId = deps.createId ?? defaultId;
  }

  readonly handler: ToolHandler = (args, signal, isAllowed, context) => this.render(args, signal, isAllowed, context);

  render(args: any, signal?: AbortSignal, isAllowed?: () => boolean, context?: ToolExecutionContext): Promise<ToolResult> {
    const pending = this.queue.then(() => this.renderSerialized(args, signal, isAllowed, context));
    this.queue = pending.catch(() => undefined);
    return pending;
  }

  private async renderSerialized(args: any, signal?: AbortSignal, isAllowed?: () => boolean, context?: ToolExecutionContext): Promise<ToolResult> {
    if (!isRecord(args) || !exactKeys(args, ["operation_id", "spec"]) || typeof args.operation_id !== "string" ||
        !ID_PATTERN.test(args.operation_id)) return { ok: false, error: "render_view requires a bounded operation_id and spec" };
    const validation = validateRenderViewSpec(args.spec);
    if (validation) return { ok: false, error: `Invalid render_view spec: ${validation}` };
    const owner = ownerKey(context);
    if (!owner) return { ok: false, error: "render_view requires an exact authenticated turn and connection owner" };
    const operationKey = `${owner}:${args.operation_id}`;
    const argsFingerprint = fingerprint(args);
    const prior = this.operations.get(operationKey);
    if (prior) return prior.fingerprint === argsFingerprint ? prior.result : { ok: false, error: "operation_id was reused with different arguments" };
    if (signal?.aborted || (isAllowed && !isAllowed())) return { ok: false, error: "The authorizing assistant turn is no longer active; no view was rendered." };
    if (!this.deps.isDisplayAvailable()) return { ok: false, error: "The glasses display is unavailable; no view was rendered." };

    const spec = args.spec as RenderViewSpec;
    const updating = spec.view_id !== undefined;
    if (updating) {
      if (!this.current || this.current.viewId !== spec.view_id || this.current.ownerKey !== owner ||
          this.current.revision !== spec.expected_revision) return { ok: false, error: "The view owner, identity, or expected revision is stale" };
    } else if (this.current) {
      return { ok: false, error: "A remote view already exists; replace it with view_id and expected_revision" };
    }
    const now = this.now();
    while (this.acceptedAtMs.length && now - this.acceptedAtMs[0]! >= 1000) this.acceptedAtMs.shift();
    if (this.acceptedAtMs.length >= 2) return { ok: false, error: "render_view update rate exceeded" };

    const candidate: RenderViewState = {
      viewId: updating ? spec.view_id! : this.createId(),
      revision: updating ? this.current!.revision + 1 : 1,
      ownerKey: owner,
      title: spec.title,
      blocks: spec.blocks.map((block) => ({ ...block })),
      actions: (spec.actions ?? []).map((action) => ({ ...action })),
      selectedAction: 0,
      expiresAtMs: now + spec.ttl_seconds * 1000,
    };
    if (!VIEW_ID_PATTERN.test(candidate.viewId)) return { ok: false, error: "Secure view identity generation failed" };
    const pendingIdentity = { viewId: candidate.viewId, revision: candidate.revision, ownerKey: owner, cancelled: false };
    this.pendingIdentity = pendingIdentity;
    try {
      await this.deps.render(candidate, signal, () => !signal?.aborted && (!isAllowed || isAllowed()));
    } catch {
      if (this.pendingIdentity === pendingIdentity) this.pendingIdentity = null;
      return { ok: false, error: "The glasses could not render the view; no success was reported." };
    }
    if (this.pendingIdentity === pendingIdentity) this.pendingIdentity = null;
    if (pendingIdentity.cancelled || signal?.aborted || (isAllowed && !isAllowed()) || !this.deps.isDisplayAvailable()) {
      if (!pendingIdentity.cancelled) this.deps.clear({ viewId: candidate.viewId, revision: candidate.revision });
      return { ok: false, error: "The render_view operation became stale before delivery completed" };
    }
    this.current = candidate;
    this.events.length = 0;
    this.acceptedAtMs.push(now);
    this.armTimer(candidate);
    const result: ToolResult = { ok: true, content: JSON.stringify({
      status: "rendered", view_id: candidate.viewId, revision: candidate.revision, ttl_seconds: spec.ttl_seconds,
    }) };
    this.rememberOperation(operationKey, argsFingerprint, result, !updating);
    return result;
  }

  readEvents(context: ToolExecutionContext | undefined, viewId: string, revision: number): ToolResult {
    const owner = ownerKey(context);
    if (!owner || !this.current || this.current.ownerKey !== owner || this.current.viewId !== viewId || this.current.revision !== revision) {
      return { ok: false, error: "The view owner, identity, or revision is stale" };
    }
    const events = this.events.splice(0);
    return { ok: true, content: JSON.stringify({ view_id: viewId, revision, events }) };
  }

  handleGesture(type: "scroll-up" | "scroll-down" | "click" | "double-click" | "long-press", foreground: boolean): boolean {
    const state = this.current;
    if (!foreground || !state) return false;
    if (type === "double-click" || type === "long-press") return false;
    if (!state.actions.length) return false;
    if (type === "scroll-up") {
      state.selectedAction = (state.selectedAction + state.actions.length - 1) % state.actions.length;
      return true;
    }
    if (type === "scroll-down") {
      state.selectedAction = (state.selectedAction + 1) % state.actions.length;
      return true;
    }
    const action = state.actions[state.selectedAction];
    if (!action) return false;
    if (this.events.length >= 16) this.events.shift();
    this.events.push({
      version: 1,
      event_id: `${state.viewId}.${state.revision}.${++this.eventSequence}`,
      view_id: state.viewId,
      revision: state.revision,
      action_id: action.id,
      kind: "activate",
    });
    return true;
  }

  snapshot(): RenderViewState | null {
    return this.current ? { ...this.current, blocks: this.current.blocks.map((block) => ({ ...block })), actions: this.current.actions.map((action) => ({ ...action })) } : null;
  }

  closeOwner(context: ToolExecutionContext | undefined): void {
    const owner = ownerKey(context);
    if (!owner) return;
    if (this.pendingIdentity?.ownerKey === owner) this.cancelPending(this.pendingIdentity);
    if (this.current?.ownerKey === owner) this.closeExact(this.current.viewId, this.current.revision);
  }

  closeOwnerKey(owner: string): void {
    if (this.pendingIdentity?.ownerKey === owner) this.cancelPending(this.pendingIdentity);
    if (this.current?.ownerKey === owner) this.closeExact(this.current.viewId, this.current.revision);
  }

  closeView(viewId: string, revision: number): void {
    const pending = this.pendingIdentity;
    if (pending && pending.viewId === viewId && pending.revision === revision) {
      this.cancelPending(pending);
      return;
    }
    this.closeExact(viewId, revision);
  }

  private cancelPending(pending: { viewId: string; revision: number; ownerKey: string; cancelled: boolean }): void {
    if (pending.cancelled) return;
    pending.cancelled = true;
    if (this.current?.ownerKey === pending.ownerKey) this.closeExact(this.current.viewId, this.current.revision);
    this.deps.clear({ viewId: pending.viewId, revision: pending.revision });
  }

  private armTimer(state: RenderViewState): void {
    if (this.timer !== null) this.clearTimer(this.timer);
    const identity = { viewId: state.viewId, revision: state.revision };
    this.timer = this.setTimer(() => this.closeExact(identity.viewId, identity.revision), Math.max(0, state.expiresAtMs - this.now()));
  }

  private closeExact(viewId: string, revision: number): void {
    if (!this.current || this.current.viewId !== viewId || this.current.revision !== revision) return;
    const identity = { viewId, revision };
    this.current = null;
    this.events.length = 0;
    if (this.timer !== null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
    this.deps.clear(identity);
  }

  private rememberOperation(key: string, fingerprintValue: string, result: ToolResult, create: boolean): void {
    this.operations.set(key, { fingerprint: fingerprintValue, result });
    const order = create ? this.createOperationOrder : this.operationOrder;
    order.push(key);
    while (order.length > 64) this.operations.delete(order.shift()!);
  }
}
