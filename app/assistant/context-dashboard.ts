import type { ToolExecutionContext, ToolResult } from "./tool-registry";
import type { DynamicAppComponent, DynamicAppPrivacy, DynamicAppState } from "./dynamic-app";

export const CONTEXT_DASHBOARD_CAPABILITIES = Object.freeze({
  protocolVersion: 2,
  display: { width: 640, height: 480, contentWidth: 584, contentHeight: 268, grayscaleBits: 4 },
  maxSpecBytes: 16 * 1024,
  maxTextBytes: 8 * 1024,
  maxSections: 4,
  maxRecords: 20,
  maxSources: 3,
  maxPinned: 5,
  localActions: Object.freeze(["refresh", "pin", "unpin", "section", "follow_up"]),
});

export type ContextDashboardStateName = "loading" | "partial" | "ready" | "empty" | "error" | "offline";
type Uncertainty = "exact" | "estimated" | "unknown";
type LocalActionKind = "refresh" | "pin" | "unpin" | "section" | "follow_up";
type LoadState = "pending" | "ready" | "empty" | "error";
type ErrorCode = "timeout" | "offline" | "permission" | "unavailable" | "invalid_data" | "unknown";

type Source = { id: string; label: string; observed_at_ms?: number; stale_after_seconds: number; status: "current" | "stale" | "unavailable" | "unknown" };
type LocalAction = { id: string; kind: LocalActionKind; label: string; enabled: boolean };
type SectionBase = { id: string; order: number; title?: string; load_state: LoadState; source_ids: string[]; uncertainty: Uncertainty; note?: string; error_code?: ErrorCode };
type DepartureRow = { id: string; destination: string; scheduled_departure_ms: number; expected_departure_ms?: number; status: "on_time" | "delayed" | "cancelled" | "unknown" | "departed"; platform?: string };
type StatusRow = { id: string; label: string; value: string; tone?: "neutral" | "good" | "warning" | "critical" };
export type ContextDashboardSection =
  | (SectionBase & { type: "departures"; rows: DepartureRow[] })
  | (SectionBase & { type: "status_grid"; rows: StatusRow[] })
  | (SectionBase & { type: "list"; items: string[] })
  | (SectionBase & { type: "message"; body: string });

export type ContextDashboardSpec = {
  version: 2;
  dashboard_key: string;
  title: string;
  state: ContextDashboardStateName;
  privacy: DynamicAppPrivacy;
  summary: { primary: string; secondary?: string; tone?: "neutral" | "good" | "warning" | "critical"; uncertainty: Uncertainty };
  sections: ContextDashboardSection[];
  sources: Source[];
  local_actions: LocalAction[];
  announcement?: { id: string; text: string; policy: "once_when_useful" };
  ttl_seconds: number;
};

type RefreshPolicy = { mode: "manual" | "on_visible"; min_interval_seconds: number };
type PinRecord = { dashboard_key: string; title: string; privacy: "public" | "private"; intent: string; refresh_policy: RefreshPolicy };
export type ContextDashboardRenderState = DynamicAppState & {
  dashboardId: string;
  presentationGeneration: number;
  refreshGeneration: number;
  dashboardState: ContextDashboardStateName;
  contextIntent: string;
  announcement?: { id: string; text: string; policy: "once_when_useful" };
};
type Receipt = { status: "acknowledged"; frameId: number };
type Identity = { dashboardId: string; presentationGeneration: number; refreshGeneration: number; revision: number };
type Current = Identity & { connectionKey: string; turnKey: string; dashboardKey: string; intent: string; refreshPolicy: RefreshPolicy; pinned: boolean; spec: ContextDashboardSpec; render: ContextDashboardRenderState };
type LocalEvent = { version: 2; event_id: string; dashboard_id: string; presentation_generation: number; revision: number; kind: "refresh" | "section" | "follow_up"; intent: string; section_id?: string };

type Dependencies = {
  isDisplayAvailable: () => boolean;
  deliver: (state: ContextDashboardRenderState, signal?: AbortSignal, isAllowed?: () => boolean) => Promise<Receipt>;
  clear: (identity: { viewId: string; revision: number }) => void;
  createId?: () => string;
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => unknown;
  clearTimer?: (timer: unknown) => void;
  loadPins?: () => unknown;
  savePins?: (pins: PinRecord[]) => void;
};

const ID = /^[A-Za-z0-9._-]{1,64}$/;
const LONG_ID = /^[A-Za-z0-9_-]{16,128}$/;
const FORBIDDEN = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069<>`]/u;
const URL = /(?:[a-z][a-z0-9+.-]*:\/\/|www\.|\b[a-z0-9-]+\.(?:com|org|net|io|dev|app)\b)/iu;
const STATES = ["loading", "partial", "ready", "empty", "error", "offline"];
const UNCERTAINTY = ["exact", "estimated", "unknown"];
const LOCAL_ACTIONS = ["refresh", "pin", "unpin", "section", "follow_up"];
const ERRORS = ["timeout", "offline", "permission", "unavailable", "invalid_data", "unknown"];

function record(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function exact(value: Record<string, unknown>, keys: readonly string[]): boolean { const allowed = new Set(keys); return Object.keys(value).every((key) => allowed.has(key)); }
function bytes(value: string): number { return typeof TextEncoder !== "undefined" ? new TextEncoder().encode(value).length : encodeURIComponent(value).replace(/%[0-9A-F]{2}|./gi, "x").length; }
function text(value: unknown, points: number, maxBytes = points * 4): value is string {
  return typeof value === "string" && value.trim().length > 0 && Array.from(value).length <= points && bytes(value) <= maxBytes && !FORBIDDEN.test(value) && !URL.test(value);
}
function safeInteger(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 0; }

function validateSource(value: unknown): boolean {
  return record(value) && exact(value, ["id", "label", "observed_at_ms", "stale_after_seconds", "status"]) &&
    typeof value.id === "string" && ID.test(value.id) && text(value.label, 40, 160) &&
    (value.observed_at_ms === undefined || safeInteger(value.observed_at_ms)) && Number.isInteger(value.stale_after_seconds) &&
    Number(value.stale_after_seconds) >= 30 && Number(value.stale_after_seconds) <= 86400 && ["current", "stale", "unavailable", "unknown"].includes(String(value.status));
}

function validateSection(value: unknown): string | null {
  if (!record(value) || typeof value.id !== "string" || !ID.test(value.id) || !Number.isInteger(value.order) || Number(value.order) < 0 || Number(value.order) > 3 ||
      !["pending", "ready", "empty", "error"].includes(String(value.load_state)) || !Array.isArray(value.source_ids) || value.source_ids.length > 3 ||
      !value.source_ids.every((id) => typeof id === "string" && ID.test(id)) || !UNCERTAINTY.includes(String(value.uncertainty)) ||
      (value.title !== undefined && !text(value.title, 40, 160)) || (value.note !== undefined && !text(value.note, 64, 256)) ||
      (value.load_state === "error") !== (typeof value.error_code === "string" && ERRORS.includes(value.error_code))) return "section envelope is invalid";
  const common = ["id", "order", "type", "title", "load_state", "source_ids", "uncertainty", "note", "error_code"];
  if (value.type === "departures") {
    if (!exact(value, [...common, "rows"]) || !Array.isArray(value.rows) || value.rows.length > 12) return "departures section is invalid";
    for (const row of value.rows) {
      if (!record(row) || !exact(row, ["id", "destination", "scheduled_departure_ms", "expected_departure_ms", "status", "platform"]) ||
          typeof row.id !== "string" || !ID.test(row.id) || !text(row.destination, 40, 160) || !safeInteger(row.scheduled_departure_ms) ||
          (row.expected_departure_ms !== undefined && !safeInteger(row.expected_departure_ms)) || !["on_time", "delayed", "cancelled", "unknown", "departed"].includes(String(row.status)) ||
          (row.platform !== undefined && !text(row.platform, 8, 32))) return "departure row is invalid";
    }
    return null;
  }
  if (value.type === "status_grid") {
    if (!exact(value, [...common, "rows"]) || !Array.isArray(value.rows) || value.rows.length > 6) return "status section is invalid";
    return value.rows.every((row) => record(row) && exact(row, ["id", "label", "value", "tone"]) && typeof row.id === "string" && ID.test(row.id) &&
      text(row.label, 40, 160) && text(row.value, 64, 256) && (row.tone === undefined || ["neutral", "good", "warning", "critical"].includes(String(row.tone)))) ? null : "status row is invalid";
  }
  if (value.type === "list") return exact(value, [...common, "items"]) && Array.isArray(value.items) && value.items.length <= 8 && value.items.every((item) => text(item, 96, 384)) ? null : "list section is invalid";
  if (value.type === "message") return exact(value, [...common, "body"]) && text(value.body, 160, 640) ? null : "message section is invalid";
  return "section type is unsupported";
}

export function validateContextDashboardSpec(value: unknown): string | null {
  if (!record(value) || !exact(value, ["version", "dashboard_key", "title", "state", "privacy", "summary", "sections", "sources", "local_actions", "announcement", "ttl_seconds"])) return "spec contains unsupported fields";
  let encoded: string;
  try { encoded = JSON.stringify(value); } catch { return "spec is not serializable"; }
  if (bytes(encoded) > CONTEXT_DASHBOARD_CAPABILITIES.maxSpecBytes) return "spec exceeds 16 KiB";
  if (value.version !== 2 || typeof value.dashboard_key !== "string" || !ID.test(value.dashboard_key) || !text(value.title, 48, 192) || !STATES.includes(String(value.state)) || !["public", "private", "sensitive"].includes(String(value.privacy))) return "dashboard identity is invalid";
  if (!record(value.summary) || !exact(value.summary, ["primary", "secondary", "tone", "uncertainty"]) || !text(value.summary.primary, 64, 256) ||
      (value.summary.secondary !== undefined && !text(value.summary.secondary, 96, 384)) || (value.summary.tone !== undefined && !["neutral", "good", "warning", "critical"].includes(String(value.summary.tone))) || !UNCERTAINTY.includes(String(value.summary.uncertainty))) return "summary is invalid";
  if (!Number.isInteger(value.ttl_seconds) || Number(value.ttl_seconds) < 30 || Number(value.ttl_seconds) > 3600) return "ttl is invalid";
  if (!Array.isArray(value.sources) || value.sources.length < 1 || value.sources.length > 3 || !value.sources.every(validateSource)) return "sources are invalid";
  const sourceIds = new Set(value.sources.map((source) => (source as Source).id));
  if (sourceIds.size !== value.sources.length) return "source IDs must be unique";
  if (!Array.isArray(value.sections) || value.sections.length < 1 || value.sections.length > 4) return "sections are invalid";
  const sectionIds = new Set<string>(); let records = 0;
  for (const section of value.sections) {
    const error = validateSection(section); if (error) return error;
    const candidate = section as ContextDashboardSection;
    if (sectionIds.has(candidate.id) || candidate.order !== sectionIds.size || candidate.source_ids.some((id) => !sourceIds.has(id))) return "section identity, order, or source is invalid";
    sectionIds.add(candidate.id); records += candidate.type === "departures" || candidate.type === "status_grid" ? candidate.rows.length : candidate.type === "list" ? candidate.items.length : 1;
  }
  if (records > 20) return "dashboard exceeds 20 records";
  if (!Array.isArray(value.local_actions) || value.local_actions.length > 3) return "local actions are invalid";
  const actionIds = new Set<string>();
  for (const action of value.local_actions) {
    if (!record(action) || !exact(action, ["id", "kind", "label", "enabled"]) || typeof action.id !== "string" || !ID.test(action.id) || actionIds.has(action.id) ||
        !LOCAL_ACTIONS.includes(String(action.kind)) || !text(action.label, 24, 96) || typeof action.enabled !== "boolean") return "local action is invalid";
    actionIds.add(action.id);
  }
  if (value.announcement !== undefined && (!record(value.announcement) || !exact(value.announcement, ["id", "text", "policy"]) || typeof value.announcement.id !== "string" || !ID.test(value.announcement.id) || !text(value.announcement.text, 160, 640) || value.announcement.policy !== "once_when_useful")) return "announcement is invalid";
  return bytes(JSON.stringify({ title: value.title, summary: value.summary, sections: value.sections, sources: value.sources })) <= CONTEXT_DASHBOARD_CAPABILITIES.maxTextBytes ? null : "retained text exceeds 8 KiB";
}

function connectionKey(context?: ToolExecutionContext): string | null {
  return context?.caller === "mcp" && context.connectionGeneration !== undefined && context.connectionGeneration !== null && context.connectionGeneration !== ""
    ? `mcp:${String(context.connectionGeneration)}`
    : null;
}
function turnKey(context?: ToolExecutionContext): string | null { const connection = connectionKey(context); return connection && context?.turnGeneration ? `${connection}:turn:${String(context.turnGeneration)}` : null; }
function defaultId(): string { const uuid = (globalThis as any).crypto?.randomUUID?.(); if (!uuid) throw new Error("secure random identity is unavailable"); return uuid.replace(/-/g, ""); }
function result(content: object): ToolResult { return { ok: true, content: JSON.stringify(content) }; }
function fail(error: string): ToolResult { return { ok: false, error }; }
function validRefreshPolicy(value: unknown): value is RefreshPolicy { return record(value) && exact(value, ["mode", "min_interval_seconds"]) && ["manual", "on_visible"].includes(String(value.mode)) && Number.isInteger(value.min_interval_seconds) && Number(value.min_interval_seconds) >= 30 && Number(value.min_interval_seconds) <= 86400; }

function componentsFor(spec: ContextDashboardSpec, pinned: boolean, nowMs: number): DynamicAppComponent[] {
  const components: DynamicAppComponent[] = [{ id: "summary", type: "heading", text: spec.summary.primary }];
  if (spec.summary.secondary) components.push({ id: "summary-detail", type: "text", text: spec.summary.secondary });
  for (const section of spec.sections) {
    if (section.title) components.push({ id: `${section.id}-heading`, type: "heading", text: section.title });
    if (section.load_state === "pending") components.push({ id: `${section.id}-pending`, type: "text", text: "Loading…" });
    else if (section.load_state === "error") components.push({ id: `${section.id}-error`, type: "status", label: section.title ?? "Section", value: section.error_code ?? "unavailable", tone: "warning" });
    else if (section.type === "departures") for (const row of section.rows) {
      const time = new Date(row.expected_departure_ms ?? row.scheduled_departure_ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      const suffix = row.status === "on_time" ? time : row.status === "unknown" ? `${time} ?` : `${time} ${row.status}`;
      components.push({ id: `${section.id}-${row.id}`, type: "status", label: row.destination, value: row.platform ? `${suffix} P${row.platform}` : suffix, tone: row.status === "cancelled" ? "critical" : row.status === "delayed" ? "warning" : "neutral" });
    } else if (section.type === "status_grid") for (const row of section.rows) components.push({ id: `${section.id}-${row.id}`, type: "status", label: row.label, value: row.value, tone: row.tone });
    else if (section.type === "list") for (let index = 0; index < section.items.length; index++) components.push({ id: `${section.id}-${index}`, type: "text", text: section.items[index]! });
    else if (section.type === "message") components.push({ id: `${section.id}-body`, type: "card", title: section.title ?? "Details", body: section.body });
  }
  const source = spec.sources.map((item) => {
    if (item.observed_at_ms === undefined) return `${item.label}: ${item.status} · freshness unknown`;
    const ageSeconds = Math.max(0, Math.floor((nowMs - item.observed_at_ms) / 1000));
    const status = item.status === "current" && ageSeconds > item.stale_after_seconds ? "stale" : item.status;
    return `${item.label}: ${status} · ${ageSeconds < 60 ? `${ageSeconds}s` : `${Math.floor(ageSeconds / 60)}m`} ago`;
  }).join(" · ");
  components.push({ id: "provenance", type: "text", text: source });
  for (const action of spec.local_actions) if (action.enabled) components.push({ id: `local-${action.id}`, type: "button", label: action.kind === "pin" && pinned ? "Pinned" : action.label, action_handle: `localaction_${action.kind}_${action.id}`.padEnd(16, "_") });
  return components.slice(0, 64);
}

function loadingSpec(key: string, title: string, privacy: DynamicAppPrivacy, ttl: number): ContextDashboardSpec {
  return { version: 2, dashboard_key: key, title, state: "loading", privacy,
    summary: { primary: "Gathering current information…", uncertainty: "unknown" },
    sections: [{ id: "results", order: 0, type: "message", load_state: "pending", source_ids: ["pending"], uncertainty: "unknown", body: "Waiting for the first useful result" }],
    sources: [{ id: "pending", label: "Authorised sources", stale_after_seconds: 30, status: "unknown" }],
    local_actions: [], ttl_seconds: ttl };
}

export class ContextDashboardManager {
  private current: Current | null = null;
  private readonly pins: PinRecord[];
  private queue: Promise<unknown> = Promise.resolve();
  private timer: unknown = null;
  private readonly operations = new Map<string, { fingerprint: string; value: ToolResult }>();
  private readonly events: LocalEvent[] = [];
  private readonly acknowledgedEvents = new Set<string>();
  private eventSequence = 0;
  private readonly createId: () => string;
  private readonly now: () => number;
  private readonly setTimer: (callback: () => void, delayMs: number) => unknown;
  private readonly clearTimer: (timer: unknown) => void;

  constructor(private readonly deps: Dependencies) {
    this.createId = deps.createId ?? defaultId; this.now = deps.now ?? Date.now;
    this.setTimer = deps.setTimer ?? ((callback, delay) => setTimeout(callback, delay));
    this.clearTimer = deps.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
    this.pins = this.validatePins(deps.loadPins?.());
  }

  begin(args: unknown, signal?: AbortSignal, isAllowed?: () => boolean, context?: ToolExecutionContext): Promise<ToolResult> { return this.enqueue(() => this.beginOnce(args, signal, isAllowed, context)); }
  publish(args: unknown, signal?: AbortSignal, isAllowed?: () => boolean, context?: ToolExecutionContext): Promise<ToolResult> { return this.enqueue(() => this.publishOnce(args, signal, isAllowed, context)); }
  startRefresh(args: unknown, signal?: AbortSignal, isAllowed?: () => boolean, context?: ToolExecutionContext): Promise<ToolResult> { return this.enqueue(() => this.refreshOnce(args, signal, isAllowed, context)); }
  private enqueue(task: () => Promise<ToolResult>): Promise<ToolResult> { const pending = this.queue.then(task); this.queue = pending.catch(() => undefined); return pending; }
  private replay(turn: string, operationId: string, args: unknown): ToolResult | null { const key = `${turn}:${operationId}`; const fingerprint = JSON.stringify(args); const prior = this.operations.get(key); if (!prior) return null; return prior.fingerprint === fingerprint ? prior.value : fail("operation_id was reused with different arguments"); }
  private remember(turn: string, operationId: string, args: unknown, value: ToolResult): ToolResult { this.operations.set(`${turn}:${operationId}`, { fingerprint: JSON.stringify(args), value }); if (this.operations.size > 256) this.operations.delete(this.operations.keys().next().value!); return value; }

  private async beginOnce(args: unknown, signal?: AbortSignal, isAllowed?: () => boolean, context?: ToolExecutionContext): Promise<ToolResult> {
    const turn = turnKey(context); const connection = connectionKey(context);
    if (!turn || !connection || !record(args) || !exact(args, ["operation_id", "dashboard_key", "title", "privacy", "intent", "refresh_policy", "ttl_seconds"]) || typeof args.operation_id !== "string" || !ID.test(args.operation_id) || typeof args.dashboard_key !== "string" || !ID.test(args.dashboard_key) || !text(args.title, 48, 192) || !["public", "private", "sensitive"].includes(String(args.privacy)) || !text(args.intent, 240, 960) || !validRefreshPolicy(args.refresh_policy) || !Number.isInteger(args.ttl_seconds) || Number(args.ttl_seconds) < 30 || Number(args.ttl_seconds) > 3600) return fail("begin arguments or exact owner are invalid");
    const replay = this.replay(turn, args.operation_id, args); if (replay) return replay;
    const dashboardId = this.createId(); if (!LONG_ID.test(dashboardId)) return fail("secure dashboard identity generation failed");
    this.events.length = 0;
    this.acknowledgedEvents.clear();
    const pinned = this.pins.some((pin) => pin.dashboard_key === args.dashboard_key);
    const spec = loadingSpec(args.dashboard_key, args.title, args.privacy as DynamicAppPrivacy, Number(args.ttl_seconds));
    const identity = { dashboardId, presentationGeneration: 1, refreshGeneration: 1, revision: 1 };
    const delivered = await this.deliver(spec, identity, connection, turn, String(args.intent), args.refresh_policy, pinned, signal, isAllowed);
    if (!delivered.ok) return delivered;
    return this.remember(turn, args.operation_id, args, delivered);
  }

  private async publishOnce(args: unknown, signal?: AbortSignal, isAllowed?: () => boolean, context?: ToolExecutionContext): Promise<ToolResult> {
    const turn = turnKey(context); const connection = connectionKey(context);
    if (!turn || !connection || !record(args) || !exact(args, ["operation_id", "dashboard_id", "presentation_generation", "refresh_generation", "expected_revision", "spec"]) || typeof args.operation_id !== "string" || !ID.test(args.operation_id)) return fail("publish arguments or exact owner are invalid");
    const replay = this.replay(turn, args.operation_id, args); if (replay) return replay;
    const current = this.current;
    if (!current || current.connectionKey !== connection || current.dashboardId !== args.dashboard_id || current.presentationGeneration !== args.presentation_generation || current.refreshGeneration !== args.refresh_generation || current.revision !== args.expected_revision) return fail("dashboard presentation, refresh, or revision is stale");
    const validation = validateContextDashboardSpec(args.spec); if (validation) return fail(`Invalid contextual dashboard spec: ${validation}`);
    const spec = args.spec as ContextDashboardSpec;
    if (spec.dashboard_key !== current.dashboardKey) return fail("dashboard key is stale");
    const delivered = await this.deliver(spec, { dashboardId: current.dashboardId, presentationGeneration: current.presentationGeneration, refreshGeneration: current.refreshGeneration, revision: current.revision + 1 }, connection, turn, current.intent, current.refreshPolicy, current.pinned, signal, isAllowed);
    return this.remember(turn, args.operation_id, args, delivered);
  }

  private async refreshOnce(args: unknown, signal?: AbortSignal, isAllowed?: () => boolean, context?: ToolExecutionContext): Promise<ToolResult> {
    const turn = turnKey(context); const connection = connectionKey(context);
    if (!turn || !connection || !record(args) || !exact(args, ["operation_id", "dashboard_id", "presentation_generation", "expected_revision"]) || typeof args.operation_id !== "string" || !ID.test(args.operation_id)) return fail("refresh arguments or exact owner are invalid");
    const replay = this.replay(turn, args.operation_id, args); if (replay) return replay;
    const current = this.current;
    if (!current || current.connectionKey !== connection || current.dashboardId !== args.dashboard_id || current.presentationGeneration !== args.presentation_generation || current.revision !== args.expected_revision) return fail("dashboard presentation or revision is stale");
    const spec = { ...current.spec, state: "loading" as const, summary: { ...current.spec.summary, secondary: "Refreshing current authorised sources", uncertainty: "unknown" as const } };
    const delivered = await this.deliver(spec, { dashboardId: current.dashboardId, presentationGeneration: current.presentationGeneration, refreshGeneration: current.refreshGeneration + 1, revision: current.revision + 1 }, connection, turn, current.intent, current.refreshPolicy, current.pinned, signal, isAllowed);
    return this.remember(turn, args.operation_id, args, delivered);
  }

  private async deliver(spec: ContextDashboardSpec, identity: Identity, connection: string, turn: string, intent: string, refreshPolicy: RefreshPolicy, pinned: boolean, signal?: AbortSignal, isAllowed?: () => boolean): Promise<ToolResult> {
    if (signal?.aborted || (isAllowed && !isAllowed())) return fail("authorizing turn is no longer active");
    if (!this.deps.isDisplayAvailable()) return fail("glasses display is disconnected or unavailable");
    const render: ContextDashboardRenderState = { viewId: identity.dashboardId, revision: identity.revision, ownerKey: connection, title: spec.title,
      state: spec.state === "partial" ? "ready" : spec.state, privacy: spec.privacy, components: componentsFor(spec, pinned, this.now()),
      selectedAction: this.current?.dashboardId === identity.dashboardId ? this.current.render.selectedAction : 0,
      scrollOffset: this.current?.dashboardId === identity.dashboardId ? this.current.render.scrollOffset : 0,
      expiresAtMs: this.now() + spec.ttl_seconds * 1000, dashboardId: identity.dashboardId, presentationGeneration: identity.presentationGeneration,
      refreshGeneration: identity.refreshGeneration, dashboardState: spec.state, contextIntent: intent, announcement: spec.announcement };
    let receipt: Receipt;
    try { receipt = await this.deps.deliver(render, signal, () => !signal?.aborted && (!isAllowed || isAllowed())); } catch { return fail("glasses delivery was not acknowledged"); }
    if (receipt.status !== "acknowledged" || !Number.isSafeInteger(receipt.frameId) || signal?.aborted || (isAllowed && !isAllowed()) || !this.deps.isDisplayAvailable()) { this.deps.clear({ viewId: identity.dashboardId, revision: identity.revision }); return fail("context dashboard became stale before acknowledged delivery"); }
    this.current = { ...identity, connectionKey: connection, turnKey: turn, dashboardKey: spec.dashboard_key, intent, refreshPolicy, pinned, spec: structuredClone(spec), render };
    if (this.timer !== null) this.clearTimer(this.timer);
    const exactIdentity = { dashboardId: identity.dashboardId, presentationGeneration: identity.presentationGeneration, refreshGeneration: identity.refreshGeneration, revision: identity.revision };
    this.timer = this.setTimer(() => { if (this.matches(exactIdentity)) this.closeCurrent(); }, spec.ttl_seconds * 1000);
    return result({ status: "acknowledged", dashboard_id: identity.dashboardId, presentation_generation: identity.presentationGeneration, refresh_generation: identity.refreshGeneration, revision: identity.revision, frame_id: receipt.frameId });
  }

  handleInput(type: "scroll-up" | "scroll-down" | "click", foreground: boolean): boolean {
    if (!foreground || !this.current) return false;
    const actions = this.current.spec.local_actions.filter((action) => action.enabled);
    if (type === "scroll-up") this.current.render.selectedAction = actions.length ? Math.max(0, this.current.render.selectedAction - 1) : 0;
    else if (type === "scroll-down") this.current.render.selectedAction = actions.length ? Math.min(actions.length - 1, this.current.render.selectedAction + 1) : 0;
    else {
      const action = actions[this.current.render.selectedAction]; if (!action) return false;
      if (action.kind === "pin") this.pinCurrent();
      else if (action.kind === "unpin") this.unpinCurrent();
      else if (this.events.length < 16) {
        this.events.push({ version: 2, event_id: `${this.current.dashboardId}.${this.current.presentationGeneration}.${++this.eventSequence}`,
          dashboard_id: this.current.dashboardId, presentation_generation: this.current.presentationGeneration, revision: this.current.revision,
          kind: action.kind, intent: this.current.intent,
          ...(action.kind === "section" ? { section_id: this.current.spec.sections[Math.min(this.current.render.scrollOffset, this.current.spec.sections.length - 1)]?.id } : {}) });
      }
      const focused = action ? this.current.render.components.findIndex((component) => component.id === `local-${action.id}`) : -1;
      if (focused >= 0) this.current.render.scrollOffset = focused;
    }
    return true;
  }

  listPins(): PinRecord[] { return this.pins.map((pin) => ({ ...pin, refresh_policy: { ...pin.refresh_policy } })); }
  readEvents(context: ToolExecutionContext | undefined, dashboardId: string, presentationGeneration: number, revision: number, afterEventId: string | null): ToolResult {
    const connection = connectionKey(context);
    if (!connection || !this.current || this.current.connectionKey !== connection || this.current.dashboardId !== dashboardId ||
        this.current.presentationGeneration !== presentationGeneration || this.current.revision !== revision) return fail("dashboard event owner or presentation is stale");
    if (afterEventId && !this.acknowledgedEvents.has(afterEventId)) return fail("dashboard event cursor is not acknowledged");
    return result({ dashboard_id: dashboardId, presentation_generation: presentationGeneration, revision, events: this.events.slice(0, 1) });
  }
  ackEvents(context: ToolExecutionContext | undefined, eventId: string): ToolResult {
    const connection = connectionKey(context);
    if (!connection || !this.current || this.current.connectionKey !== connection || typeof eventId !== "string" || eventId.length > 180) return fail("dashboard event owner is stale");
    if (this.acknowledgedEvents.has(eventId)) return result({ status: "historical_acknowledgement", through_event_id: eventId });
    if (this.events[0]?.event_id !== eventId) return fail("dashboard events must be acknowledged in queue order");
    this.events.shift(); this.acknowledgedEvents.add(eventId);
    while (this.acknowledgedEvents.size > 32) this.acknowledgedEvents.delete(this.acknowledgedEvents.values().next().value!);
    return result({ status: "acknowledged", through_event_id: eventId });
  }
  snapshot(): ContextDashboardRenderState | null { return this.current ? { ...this.current.render, components: this.current.render.components.map((component) => component.type === "list" ? { ...component, items: [...component.items] } : { ...component }) } : null; }
  closeConnection(context?: ToolExecutionContext): void { const connection = connectionKey(context); if (connection && this.current?.connectionKey === connection) this.closeCurrent(); }
  closeView(viewId: string, revision: number): void { if (this.current?.dashboardId === viewId && this.current.revision === revision) this.closeCurrent(); }

  private pinCurrent(): void {
    if (!this.current || this.current.spec.privacy === "sensitive" || this.pins.some((pin) => pin.dashboard_key === this.current!.dashboardKey) || this.pins.length >= 5) return;
    this.pins.push({ dashboard_key: this.current.dashboardKey, title: this.current.spec.title, privacy: this.current.spec.privacy, intent: this.current.intent, refresh_policy: { ...this.current.refreshPolicy } });
    this.current.pinned = true; this.persistPins();
  }
  private unpinCurrent(): void { if (!this.current) return; const index = this.pins.findIndex((pin) => pin.dashboard_key === this.current!.dashboardKey); if (index >= 0) { this.pins.splice(index, 1); this.current.pinned = false; this.persistPins(); } }
  private persistPins(): void { this.deps.savePins?.(this.listPins()); }
  private validatePins(value: unknown): PinRecord[] { if (!Array.isArray(value)) return []; const pins: PinRecord[] = []; const keys = new Set<string>(); for (const candidate of value.slice(0, 6)) { if (!record(candidate) || !exact(candidate, ["dashboard_key", "title", "privacy", "intent", "refresh_policy"]) || typeof candidate.dashboard_key !== "string" || !ID.test(candidate.dashboard_key) || keys.has(candidate.dashboard_key) || !text(candidate.title, 48, 192) || !["public", "private"].includes(String(candidate.privacy)) || !text(candidate.intent, 240, 960) || !validRefreshPolicy(candidate.refresh_policy)) return []; keys.add(candidate.dashboard_key); pins.push(candidate as PinRecord); } return pins.length <= 5 ? pins : []; }
  private matches(identity: Identity): boolean { return Boolean(this.current && this.current.dashboardId === identity.dashboardId && this.current.presentationGeneration === identity.presentationGeneration && this.current.refreshGeneration === identity.refreshGeneration && this.current.revision === identity.revision); }
  private closeCurrent(): void { if (!this.current) return; const identity = { viewId: this.current.dashboardId, revision: this.current.revision }; this.current = null; this.events.length = 0; this.acknowledgedEvents.clear(); if (this.timer !== null) { this.clearTimer(this.timer); this.timer = null; } this.deps.clear(identity); }
}
