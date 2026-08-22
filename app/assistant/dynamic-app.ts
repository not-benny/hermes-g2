import type { ToolExecutionContext, ToolResult } from "./tool-registry";

export const DYNAMIC_APP_CAPABILITIES = Object.freeze({
  protocolVersion: 1,
  display: { width: 640, height: 480, grayscaleBits: 4 },
  maxSpecBytes: 24 * 1024,
  maxTextBytes: 12 * 1024,
  maxComponents: 64,
  maxListItems: 32,
  maxEvents: 32,
  componentTypes: Object.freeze([
    "heading", "text", "status", "card", "list", "progress", "icon", "toggle", "button", "confirmation", "divider",
  ]),
  input: Object.freeze(["scroll-up", "scroll-down", "click", "double-click", "long-press"]),
});

export type DynamicAppStateName = "loading" | "ready" | "empty" | "error" | "offline";
export type DynamicAppPrivacy = "public" | "private" | "sensitive";
export type DynamicAppComponent =
  | { id: string; type: "heading" | "text"; text: string }
  | { id: string; type: "status"; label: string; value: string; tone?: "neutral" | "good" | "warning" | "critical" }
  | { id: string; type: "card"; title: string; body: string }
  | { id: string; type: "list"; items: string[] }
  | { id: string; type: "progress"; label: string; value: number }
  | { id: string; type: "icon"; name: "info" | "check" | "warning" | "error"; label: string }
  | { id: string; type: "toggle"; label: string; value: boolean; action_handle: string; confirmation?: string }
  | { id: string; type: "button"; label: string; action_handle: string; confirmation?: string }
  | { id: string; type: "confirmation"; text: string; confirm_handle: string; cancel_handle: string }
  | { id: string; type: "divider" };

export type DynamicAppSpec = {
  version: 1;
  title: string;
  state: DynamicAppStateName;
  privacy: DynamicAppPrivacy;
  components: DynamicAppComponent[];
  ttl_seconds: number;
};

export type DynamicAppState = {
  viewId: string;
  revision: number;
  ownerKey: string;
  title: string;
  state: DynamicAppStateName;
  privacy: DynamicAppPrivacy;
  components: DynamicAppComponent[];
  selectedAction: number;
  scrollOffset: number;
  expiresAtMs: number;
};

export type DynamicAppEvent = {
  version: 1;
  event_id: string;
  view_id: string;
  revision: number;
  action_handle: string;
  kind: "activate";
};

type DeliveryReceipt = { status: "acknowledged"; frameId: number };
type TimerHandle = unknown;
type Identity = { viewId: string; revision: number };
type OperationRecord = { fingerprint: string; result: ToolResult; viewId?: string; revision?: number };

export type DynamicAppDependencies = {
  isDisplayAvailable: () => boolean;
  deliver: (state: DynamicAppState, signal?: AbortSignal, isAllowed?: () => boolean) => Promise<DeliveryReceipt>;
  clear: (identity: Identity) => void;
  createId?: () => string;
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimer?: (timer: TimerHandle) => void;
};

const ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const VIEW_ID_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const HANDLE_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const FORBIDDEN_TEXT = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069<>`]/u;
const URL_LIKE = /(?:[a-z][a-z0-9+.-]*:\/\/|www\.|\b[a-z0-9-]+\.(?:com|org|net|io|dev|app)\b)/iu;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(record: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = new Set(allowed);
  return Object.keys(record).every((key) => keys.has(key));
}

function utf8Bytes(value: string): number {
  if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(value).length;
  return encodeURIComponent(value).replace(/%[0-9A-F]{2}|./gi, "x").length;
}

function validText(value: unknown, maxCodePoints = 1024, maxBytes = 2048): value is string {
  return typeof value === "string" && value.trim().length > 0 && Array.from(value).length <= maxCodePoints &&
    utf8Bytes(value) <= maxBytes && !FORBIDDEN_TEXT.test(value) && !URL_LIKE.test(value);
}

function validHandle(value: unknown): value is string {
  return typeof value === "string" && HANDLE_PATTERN.test(value);
}

function validateComponent(value: unknown): string | null {
  if (!isRecord(value) || typeof value.type !== "string" || typeof value.id !== "string" || !ID_PATTERN.test(value.id)) {
    return "component identity is invalid";
  }
  switch (value.type) {
    case "heading":
    case "text":
      return exactKeys(value, ["id", "type", "text"]) && validText(value.text) ? null : `${value.type} component is invalid`;
    case "status":
      return exactKeys(value, ["id", "type", "label", "value", "tone"]) && validText(value.label, 80, 320) &&
        validText(value.value, 160, 640) && (value.tone === undefined || ["neutral", "good", "warning", "critical"].includes(String(value.tone)))
        ? null : "status component is invalid";
    case "card":
      return exactKeys(value, ["id", "type", "title", "body"]) && validText(value.title, 80, 320) && validText(value.body)
        ? null : "card component is invalid";
    case "list":
      return exactKeys(value, ["id", "type", "items"]) && Array.isArray(value.items) && value.items.length <= DYNAMIC_APP_CAPABILITIES.maxListItems &&
        value.items.every((item) => validText(item, 160, 640)) ? null : "list component is invalid";
    case "progress":
      return exactKeys(value, ["id", "type", "label", "value"]) && validText(value.label, 80, 320) && typeof value.value === "number" &&
        Number.isFinite(value.value) && value.value >= 0 && value.value <= 1 ? null : "progress component is invalid";
    case "icon":
      return exactKeys(value, ["id", "type", "name", "label"]) && ["info", "check", "warning", "error"].includes(String(value.name)) &&
        validText(value.label, 160, 640) ? null : "icon component is invalid";
    case "toggle":
      return exactKeys(value, ["id", "type", "label", "value", "action_handle", "confirmation"]) && validText(value.label, 80, 320) &&
        typeof value.value === "boolean" && validHandle(value.action_handle) &&
        (value.confirmation === undefined || validText(value.confirmation, 160, 640)) ? null : "toggle component is invalid";
    case "button":
      return exactKeys(value, ["id", "type", "label", "action_handle", "confirmation"]) && validText(value.label, 80, 320) &&
        validHandle(value.action_handle) && (value.confirmation === undefined || validText(value.confirmation, 160, 640)) ? null : "button component is invalid";
    case "confirmation":
      return exactKeys(value, ["id", "type", "text", "confirm_handle", "cancel_handle"]) && validText(value.text, 160, 640) &&
        validHandle(value.confirm_handle) && validHandle(value.cancel_handle) && value.confirm_handle !== value.cancel_handle
        ? null : "confirmation component is invalid";
    case "divider":
      return exactKeys(value, ["id", "type"]) ? null : "divider component is invalid";
    default:
      return "component type is unsupported";
  }
}

export function validateDynamicAppSpec(value: unknown): string | null {
  if (!isRecord(value) || !exactKeys(value, ["version", "title", "state", "privacy", "components", "ttl_seconds"])) {
    return "spec contains unsupported fields";
  }
  let encoded: string;
  try { encoded = JSON.stringify(value); } catch { return "spec is not serializable"; }
  if (utf8Bytes(encoded) > DYNAMIC_APP_CAPABILITIES.maxSpecBytes) return "spec exceeds 24 KiB";
  if (value.version !== 1) return "version must be 1";
  if (!validText(value.title, 80, 320)) return "title must be bounded inert text";
  if (!["loading", "ready", "empty", "error", "offline"].includes(String(value.state))) return "state is invalid";
  if (!["public", "private", "sensitive"].includes(String(value.privacy))) return "privacy is invalid";
  if (!Number.isInteger(value.ttl_seconds) || Number(value.ttl_seconds) < 30 || Number(value.ttl_seconds) > 3600) return "ttl is invalid";
  if (!Array.isArray(value.components) || value.components.length > DYNAMIC_APP_CAPABILITIES.maxComponents) return "components exceed 64";
  const ids = new Set<string>();
  let textBytes = utf8Bytes(value.title as string);
  for (const component of value.components) {
    const error = validateComponent(component);
    if (error) return error;
    const id = (component as { id: string }).id;
    if (ids.has(id)) return "component IDs must be unique";
    ids.add(id);
    textBytes += utf8Bytes(JSON.stringify(component));
  }
  return textBytes <= DYNAMIC_APP_CAPABILITIES.maxTextBytes ? null : "component text exceeds 12 KiB";
}

function cloneComponents(components: DynamicAppComponent[]): DynamicAppComponent[] {
  return components.map((component) => component.type === "list" ? { ...component, items: [...component.items] } : { ...component });
}

function ownerKey(context?: ToolExecutionContext): string | null {
  if (!context?.turnGeneration) return null;
  if (context.caller === "mcp") {
    if (context.connectionGeneration === undefined || context.connectionGeneration === null || context.connectionGeneration === "") return null;
    return `mcp:${String(context.connectionGeneration)}:turn:${String(context.turnGeneration)}`;
  }
  return `direct:turn:${String(context.turnGeneration)}`;
}

function ownerConnectionPrefix(context?: ToolExecutionContext): string | null {
  if (context?.caller !== "mcp" || context.connectionGeneration === undefined || context.connectionGeneration === null) return null;
  return `mcp:${String(context.connectionGeneration)}:turn:`;
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

function operationFingerprint(value: unknown): string {
  return JSON.stringify(value);
}

function actionHandles(component: DynamicAppComponent): string[] {
  if (component.type === "toggle" || component.type === "button") return [component.action_handle];
  if (component.type === "confirmation") return [component.confirm_handle, component.cancel_handle];
  return [];
}

export class DynamicAppManager {
  private current: DynamicAppState | null = null;
  private timer: TimerHandle | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private pending: (Identity & { ownerKey: string; cancelled: boolean }) | null = null;
  private readonly operations = new Map<string, OperationRecord>();
  private readonly events: DynamicAppEvent[] = [];
  private readonly acknowledgedEventIds = new Map<string, number>();
  private eventSequence = 0;
  private readonly now: () => number;
  private readonly setTimer: (callback: () => void, delayMs: number) => TimerHandle;
  private readonly clearTimer: (timer: TimerHandle) => void;
  private readonly createId: () => string;

  constructor(private readonly deps: DynamicAppDependencies) {
    this.now = deps.now ?? (() => Date.now());
    this.setTimer = deps.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.clearTimer = deps.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
    this.createId = deps.createId ?? defaultId;
  }

  create(args: unknown, signal?: AbortSignal, isAllowed?: () => boolean, context?: ToolExecutionContext): Promise<ToolResult> {
    return this.enqueue(() => this.createSerialized(args, signal, isAllowed, context));
  }

  update(args: unknown, signal?: AbortSignal, isAllowed?: () => boolean, context?: ToolExecutionContext): Promise<ToolResult> {
    return this.enqueue(() => this.updateSerialized(args, signal, isAllowed, context));
  }

  patch(args: unknown, signal?: AbortSignal, isAllowed?: () => boolean, context?: ToolExecutionContext): Promise<ToolResult> {
    return this.enqueue(() => this.patchSerialized(args, signal, isAllowed, context));
  }

  private enqueue(task: () => Promise<ToolResult>): Promise<ToolResult> {
    const pending = this.queue.then(task);
    this.queue = pending.catch(() => undefined);
    return pending;
  }

  private replay(owner: string, operationId: string, args: unknown): ToolResult | null {
    const prior = this.operations.get(`${owner}:${operationId}`);
    if (!prior) return null;
    if (prior.fingerprint !== operationFingerprint(args)) return { ok: false, error: "operation_id was reused with different arguments" };
    if (prior.result.ok && prior.viewId && (!this.current || this.current.viewId !== prior.viewId || this.current.revision < (prior.revision ?? 0))) {
      const parsed = JSON.parse(prior.result.content ?? "{}");
      return { ok: true, content: JSON.stringify({ ...parsed, status: "historical_acknowledgement" }) };
    }
    return prior.result;
  }

  private remember(owner: string, operationId: string, args: unknown, result: ToolResult, identity?: Identity): void {
    this.operations.set(`${owner}:${operationId}`, { fingerprint: operationFingerprint(args), result, ...identity });
    if (this.operations.size > 256) this.operations.delete(this.operations.keys().next().value!);
  }

  private async createSerialized(args: unknown, signal?: AbortSignal, isAllowed?: () => boolean, context?: ToolExecutionContext): Promise<ToolResult> {
    if (!isRecord(args) || !exactKeys(args, ["operation_id", "spec"]) || typeof args.operation_id !== "string" || !ID_PATTERN.test(args.operation_id)) {
      return { ok: false, error: "create requires operation_id and spec" };
    }
    const owner = ownerKey(context);
    if (!owner) return { ok: false, error: "an exact authenticated connection and turn owner is required" };
    const replay = this.replay(owner, args.operation_id, args);
    if (replay) return replay;
    const validation = validateDynamicAppSpec(args.spec);
    if (validation) return { ok: false, error: `Invalid dynamic app spec: ${validation}` };
    if (this.current) return { ok: false, error: "a dynamic app view is already open" };
    const viewId = this.createId();
    if (!VIEW_ID_PATTERN.test(viewId)) return { ok: false, error: "secure view identity generation failed" };
    return this.commit(args, args.operation_id, args.spec as DynamicAppSpec, { viewId, revision: 1 }, owner, signal, isAllowed);
  }

  private async updateSerialized(args: unknown, signal?: AbortSignal, isAllowed?: () => boolean, context?: ToolExecutionContext): Promise<ToolResult> {
    if (!isRecord(args) || !exactKeys(args, ["operation_id", "view_id", "expected_revision", "spec"]) || typeof args.operation_id !== "string" ||
        !ID_PATTERN.test(args.operation_id) || typeof args.view_id !== "string" || !VIEW_ID_PATTERN.test(args.view_id) || !Number.isSafeInteger(args.expected_revision)) {
      return { ok: false, error: "update requires bounded operation, view and revision identities" };
    }
    const owner = ownerKey(context);
    if (!owner) return { ok: false, error: "an exact authenticated connection and turn owner is required" };
    const replay = this.replay(owner, args.operation_id, args);
    if (replay) return replay;
    const validation = validateDynamicAppSpec(args.spec);
    if (validation) return { ok: false, error: `Invalid dynamic app spec: ${validation}` };
    if (!this.matches(owner, args.view_id, Number(args.expected_revision))) return { ok: false, error: "view owner, turn, identity, or revision is stale" };
    return this.commit(args, args.operation_id, args.spec as DynamicAppSpec,
      { viewId: args.view_id, revision: Number(args.expected_revision) + 1 }, owner, signal, isAllowed);
  }

  private async patchSerialized(args: unknown, signal?: AbortSignal, isAllowed?: () => boolean, context?: ToolExecutionContext): Promise<ToolResult> {
    if (!isRecord(args) || !exactKeys(args, ["operation_id", "view_id", "expected_revision", "patch"]) || typeof args.operation_id !== "string" ||
        !ID_PATTERN.test(args.operation_id) || typeof args.view_id !== "string" || !Number.isSafeInteger(args.expected_revision) || !isRecord(args.patch) ||
        !exactKeys(args.patch, ["upsert", "remove"]) || !Array.isArray(args.patch.upsert) || !Array.isArray(args.patch.remove)) {
      return { ok: false, error: "patch shape is invalid" };
    }
    const owner = ownerKey(context);
    if (!owner) return { ok: false, error: "an exact authenticated connection and turn owner is required" };
    const replay = this.replay(owner, args.operation_id, args);
    if (replay) return replay;
    if (!this.matches(owner, args.view_id, Number(args.expected_revision))) return { ok: false, error: "view owner, turn, identity, or revision is stale" };
    const upsertIds = new Set<string>();
    for (const component of args.patch.upsert) {
      const validation = validateComponent(component);
      if (validation) return { ok: false, error: validation };
      const id = (component as { id: string }).id;
      if (upsertIds.has(id)) return { ok: false, error: "patch component IDs must be unique" };
      upsertIds.add(id);
    }
    if (!args.patch.remove.every((id) => typeof id === "string" && ID_PATTERN.test(id)) || new Set(args.patch.remove).size !== args.patch.remove.length) {
      return { ok: false, error: "patch removals are invalid" };
    }
    const removed = new Set(args.patch.remove as string[]);
    const replacements = new Map((args.patch.upsert as DynamicAppComponent[]).map((component) => [component.id, component]));
    const components = this.current!.components.filter((component) => !removed.has(component.id))
      .map((component) => replacements.get(component.id) ?? component);
    for (const component of args.patch.upsert as DynamicAppComponent[]) {
      if (!this.current!.components.some((existing) => existing.id === component.id)) components.push(component);
    }
    const spec: DynamicAppSpec = {
      version: 1, title: this.current!.title, state: this.current!.state, privacy: this.current!.privacy,
      components, ttl_seconds: Math.max(30, Math.min(3600, Math.ceil((this.current!.expiresAtMs - this.now()) / 1000))),
    };
    const validation = validateDynamicAppSpec(spec);
    if (validation) return { ok: false, error: `Invalid patched app: ${validation}` };
    return this.commit(args, args.operation_id, spec, { viewId: args.view_id, revision: Number(args.expected_revision) + 1 }, owner, signal, isAllowed);
  }

  private async commit(args: unknown, operationId: string, spec: DynamicAppSpec, identity: Identity, owner: string,
      signal?: AbortSignal, isAllowed?: () => boolean): Promise<ToolResult> {
    if (signal?.aborted || (isAllowed && !isAllowed())) return { ok: false, error: "authorizing turn is no longer active" };
    if (!this.deps.isDisplayAvailable()) return { ok: false, error: "glasses display is disconnected or unavailable" };
    const candidate: DynamicAppState = {
      ...identity, ownerKey: owner, title: spec.title, state: spec.state, privacy: spec.privacy,
      components: cloneComponents(spec.components), selectedAction: 0, scrollOffset: 0,
      expiresAtMs: this.now() + spec.ttl_seconds * 1000,
    };
    const pending = { ...identity, ownerKey: owner, cancelled: false };
    this.pending = pending;
    let receipt: DeliveryReceipt;
    try {
      receipt = await this.deps.deliver(candidate, signal, () => !signal?.aborted && (!isAllowed || isAllowed()));
    } catch {
      if (this.pending === pending) this.pending = null;
      return { ok: false, error: "glasses delivery was not acknowledged" };
    }
    if (this.pending === pending) this.pending = null;
    if (receipt.status !== "acknowledged" || !Number.isSafeInteger(receipt.frameId) || pending.cancelled || signal?.aborted ||
        (isAllowed && !isAllowed()) || !this.deps.isDisplayAvailable()) {
      if (!pending.cancelled) this.deps.clear(identity);
      return { ok: false, error: "dynamic app became stale before acknowledged delivery" };
    }
    this.current = candidate;
    if (identity.revision === 1) {
      this.events.length = 0;
      this.acknowledgedEventIds.clear();
    } else if (this.events.length > 1) {
      // Preserve only the queue head being processed. Other intents were
      // produced by the replaced revision and must not head-block the new view.
      this.events.splice(1);
    }
    this.armTimer(candidate);
    const result: ToolResult = { ok: true, content: JSON.stringify({
      status: "acknowledged", view_id: identity.viewId, revision: identity.revision, frame_id: receipt.frameId,
    }) };
    this.remember(owner, operationId, args, result, identity);
    return result;
  }

  close(args: unknown, context?: ToolExecutionContext): ToolResult {
    if (!isRecord(args) || !exactKeys(args, ["operation_id", "view_id", "expected_revision"]) || typeof args.operation_id !== "string" ||
        !ID_PATTERN.test(args.operation_id) || typeof args.view_id !== "string" || !VIEW_ID_PATTERN.test(args.view_id) || !Number.isSafeInteger(args.expected_revision)) {
      return { ok: false, error: "close requires bounded operation, view and revision identities" };
    }
    const owner = ownerKey(context);
    if (!owner) return { ok: false, error: "an exact authenticated connection and turn owner is required" };
    const replay = this.replay(owner, args.operation_id, args);
    if (replay) return replay;
    if (!this.matches(owner, args.view_id, Number(args.expected_revision))) return { ok: false, error: "view owner, turn, identity, or revision is stale" };
    this.closeExact(args.view_id, Number(args.expected_revision));
    const result = { ok: true, content: JSON.stringify({ status: "closed", view_id: args.view_id, revision: args.expected_revision }) };
    this.remember(owner, args.operation_id, args, result);
    return result;
  }

  readEvents(context: ToolExecutionContext | undefined, viewId: string, revision: number, afterEventId: string | null): ToolResult {
    const owner = ownerKey(context);
    if (!owner || !this.matches(owner, viewId, revision)) return { ok: false, error: "view owner, turn, identity, or revision is stale" };
    if (afterEventId && !this.acknowledgedEventIds.has(afterEventId)) return { ok: false, error: "event cursor is not acknowledged" };
    // Expose only the queue head. A later event must never execute before an
    // earlier event and then cumulatively acknowledge/discard it.
    return { ok: true, content: JSON.stringify({ view_id: viewId, revision, events: this.events.slice(0, 1) }) };
  }

  ackEvents(context: ToolExecutionContext | undefined, viewId: string, revision: number, throughEventId: string): ToolResult {
    const owner = ownerKey(context);
    if (!owner || !this.current || this.current.ownerKey !== owner || this.current.viewId !== viewId ||
        revision > this.current.revision || revision < 1) return { ok: false, error: "view owner, turn, identity, or revision is stale" };
    const index = this.events.findIndex((event) => event.event_id === throughEventId);
    if (index < 0) {
      if (this.acknowledgedEventIds.has(throughEventId)) {
        if (this.acknowledgedEventIds.get(throughEventId) !== revision) {
          return { ok: false, error: "historical event acknowledgement revision is stale" };
        }
        return { ok: true, content: JSON.stringify({ status: "historical_acknowledgement", through_event_id: throughEventId }) };
      }
      return { ok: false, error: "event acknowledgement identity is unknown or stale" };
    }
    if (index !== 0) return { ok: false, error: "events must be acknowledged in queue order" };
    if (this.events[index]!.revision !== revision) return { ok: false, error: "event acknowledgement revision is stale" };
    for (const event of this.events.splice(0, index + 1)) this.acknowledgedEventIds.set(event.event_id, event.revision);
    while (this.acknowledgedEventIds.size > 64) this.acknowledgedEventIds.delete(this.acknowledgedEventIds.keys().next().value!);
    return { ok: true, content: JSON.stringify({ status: "acknowledged", through_event_id: throughEventId }) };
  }

  handleInput(type: "scroll-up" | "scroll-down" | "click" | "double-click" | "long-press", foreground: boolean): boolean {
    if (!foreground || !this.current || type === "double-click" || type === "long-press") return false;
    const targets = this.current.components.flatMap((component, componentIndex) =>
      actionHandles(component).map((handle) => ({ handle, componentIndex })),
    );
    if (!targets.length) {
      if (type === "scroll-up") this.current.scrollOffset = Math.max(0, this.current.scrollOffset - 1);
      if (type === "scroll-down") this.current.scrollOffset = Math.min(Math.max(0, this.current.components.length - 1), this.current.scrollOffset + 1);
      return type !== "click";
    }
    if (type === "scroll-up") this.current.selectedAction = (this.current.selectedAction + targets.length - 1) % targets.length;
    else if (type === "scroll-down") this.current.selectedAction = (this.current.selectedAction + 1) % targets.length;
    else {
      const target = targets[this.current.selectedAction];
      if (!target) return false;
      if (this.events.length >= DYNAMIC_APP_CAPABILITIES.maxEvents) return false;
      this.events.push({ version: 1, event_id: `${this.current.viewId}.${this.current.revision}.${++this.eventSequence}`,
        view_id: this.current.viewId, revision: this.current.revision, action_handle: target.handle, kind: "activate" });
    }
    this.current.scrollOffset = targets[this.current.selectedAction]?.componentIndex ?? this.current.scrollOffset;
    return true;
  }

  snapshot(): DynamicAppState | null {
    return this.current ? { ...this.current, components: cloneComponents(this.current.components) } : null;
  }

  closeOwner(context: ToolExecutionContext | undefined): void {
    const exact = ownerKey(context);
    const connectionPrefix = ownerConnectionPrefix(context);
    const matches = (owner: string) => exact === owner || (Boolean(connectionPrefix) && owner.startsWith(connectionPrefix!));
    if (this.pending && matches(this.pending.ownerKey)) this.cancelPending(this.pending);
    if (this.current && matches(this.current.ownerKey)) this.closeExact(this.current.viewId, this.current.revision);
  }

  closeView(viewId: string, revision: number): void {
    if (this.pending?.viewId === viewId && this.pending.revision === revision) this.cancelPending(this.pending);
    else this.closeExact(viewId, revision);
  }

  private matches(owner: string, viewId: string, revision: number): boolean {
    return Boolean(this.current && this.current.ownerKey === owner && this.current.viewId === viewId && this.current.revision === revision);
  }

  private cancelPending(pending: Identity & { ownerKey: string; cancelled: boolean }): void {
    if (pending.cancelled) return;
    pending.cancelled = true;
    if (this.current?.ownerKey === pending.ownerKey) this.closeExact(this.current.viewId, this.current.revision);
    this.deps.clear(pending);
  }

  private armTimer(state: DynamicAppState): void {
    if (this.timer !== null) this.clearTimer(this.timer);
    const identity = { viewId: state.viewId, revision: state.revision };
    this.timer = this.setTimer(() => this.closeExact(identity.viewId, identity.revision), Math.max(0, state.expiresAtMs - this.now()));
  }

  private closeExact(viewId: string, revision: number): void {
    if (!this.current || this.current.viewId !== viewId || this.current.revision !== revision) return;
    if (this.pending && this.pending.viewId === viewId && this.pending.ownerKey === this.current.ownerKey) {
      this.pending.cancelled = true;
      this.deps.clear({ viewId: this.pending.viewId, revision: this.pending.revision });
    }
    this.current = null;
    this.events.length = 0;
    this.acknowledgedEventIds.clear();
    if (this.timer !== null) { this.clearTimer(this.timer); this.timer = null; }
    this.deps.clear({ viewId, revision });
  }
}
