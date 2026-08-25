import type { ToolExecutionContext, ToolResult } from "./tool-registry";
import type { DynamicAppComponent, DynamicAppPrivacy, DynamicAppState } from "./dynamic-app";
import {
  DYNAMIC_APP_DECK_COMPONENT_BUDGET,
  DYNAMIC_APP_SMALL_LINE_HEIGHT,
  dynamicAppComponentHeight,
} from "./dynamic-app-layout";

export const CONTEXT_DASHBOARD_CAPABILITIES = Object.freeze({
  protocolVersion: 2,
  display: { width: 640, height: 480, contentWidth: 536, contentHeight: 232, grayscaleBits: 4 },
  presentationLifetime: "temporary",
  presentationModes: Object.freeze(["single", "deck"]),
  interactionPriority: "visual-first",
  newAnswerPresentation: "atomic-final-only",
  deckNavigation: "ring-scroll-pages",
  maxDeckPages: 7,
  deckSectionTypes: Object.freeze(["status_grid", "departures", "bar_chart", "list", "message"]),
  preferredVisualSections: Object.freeze(["bar_chart", "status_grid", "departures"]),
  pinSemantics: "encrypted-intent-bookmark",
  regenerationModes: Object.freeze(["self_contained_intent", "current_turn_only"]),
  pinStates: Object.freeze(["available", "saved", "not_pinnable", "limit", "save_failed", "unpin_failed"]),
  maxSpecBytes: 16 * 1024,
  maxTextBytes: 8 * 1024,
  maxSections: 4,
  maxRecords: 20,
  maxSources: 3,
  maxPinned: 5,
  localActions: Object.freeze(["refresh", "pin", "unpin", "section", "follow_up"]),
  providerLocalActions: Object.freeze(["refresh", "section", "follow_up"]),
  phoneLocalActions: Object.freeze(["pin", "unpin"]),
  trustedSourceAttributions: Object.freeze(["open_meteo_ukmo"]),
});

export type ContextDashboardStateName = "loading" | "partial" | "ready" | "empty" | "error" | "offline";
export type ContextDashboardPinState = "available" | "saved" | "not_pinnable" | "limit" | "save_failed" | "unpin_failed";
export type ContextDashboardPresentationMode = "single" | "deck";
type Uncertainty = "exact" | "estimated" | "unknown";
type LocalActionKind = "refresh" | "pin" | "unpin" | "section" | "follow_up";
type LoadState = "pending" | "ready" | "empty" | "error";
type ErrorCode = "timeout" | "offline" | "permission" | "unavailable" | "invalid_data" | "unknown";

type TrustedSourceAttributionId = "open_meteo_ukmo";
type Source = { id: string; label: string; attribution_id?: TrustedSourceAttributionId; observed_at_ms?: number; stale_after_seconds: number; status: "current" | "stale" | "unavailable" | "unknown" };
type LocalAction = { id: string; kind: LocalActionKind; label: string; enabled: boolean };
type SectionBase = { id: string; order: number; title?: string; load_state: LoadState; source_ids: string[]; uncertainty: Uncertainty; note?: string; error_code?: ErrorCode };
type DepartureRow = { id: string; destination: string; scheduled_departure_ms: number; expected_departure_ms?: number; status: "on_time" | "delayed" | "cancelled" | "unknown" | "departed"; platform?: string };
type StatusRow = { id: string; label: string; value: string; tone?: "neutral" | "good" | "warning" | "critical" };
type BarRow = { id: string; label: string; value: number; max: number; unit?: string };
export type ContextDashboardSection =
  | (SectionBase & { type: "departures"; rows: DepartureRow[] })
  | (SectionBase & { type: "status_grid"; rows: StatusRow[] })
  | (SectionBase & { type: "bar_chart"; title: string; bars: BarRow[] })
  | (SectionBase & { type: "list"; items: string[] })
  | (SectionBase & { type: "message"; body: string });

export type ContextDashboardSpec = {
  version: 2;
  presentation_mode?: ContextDashboardPresentationMode;
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
type RegenerationMode = "self_contained_intent" | "current_turn_only";
type PinRecord = { dashboard_key: string; title: string; privacy: "public" | "private"; intent: string; refresh_policy: RefreshPolicy };
export type ContextDashboardRenderState = DynamicAppState & {
  dashboardId: string;
  presentationGeneration: number;
  refreshGeneration: number;
  dashboardState: ContextDashboardStateName;
  contextIntent: string;
  presentationLifetime: "temporary";
  pinned: boolean;
  pinState: ContextDashboardPinState;
  presentationMode: ContextDashboardPresentationMode;
  pageIndex: number;
  pageCount: number;
  pageId: string;
  deckActionHandle?: string;
  deckActionLabel?: string;
  announcement?: { id: string; text: string; policy: "once_when_useful" };
  /** Trusted phone-owned marker: this revision was created atomically as a final answer. */
  answerPresentation?: "atomic-final-only";
};
type Receipt = { status: "acknowledged"; frameId: number };
type Identity = { dashboardId: string; presentationGeneration: number; refreshGeneration: number; revision: number };
type Current = Identity & { connectionKey: string; turnKey: string; dashboardKey: string; intent: string; refreshPolicy: RefreshPolicy; regeneration: RegenerationMode; pinned: boolean; spec: ContextDashboardSpec; render: ContextDashboardRenderState };
type Reservation = Identity & { connectionKey: string; turnKey: string; dashboardKey: string; intent: string; refreshPolicy: RefreshPolicy; regeneration: RegenerationMode; pinned: boolean; spec: ContextDashboardSpec; expiresAtMs: number };
type LocalEvent = { version: 2; event_id: string; dashboard_id: string; presentation_generation: number; revision: number; kind: "refresh" | "section" | "follow_up"; intent: string; dashboard_key: string; title: string; privacy: DynamicAppPrivacy; section_id?: string };
type RenderAction = LocalAction & { componentId: string };
type ContextDashboardPage = {
  id: string;
  title: string;
  components: DynamicAppComponent[];
  action?: RenderAction;
};

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
const PHONE_PIN_COMPONENT_ID = "phone:pin";
// Every deck page reserves a final provenance line. Component-aware packing
// below then uses all remaining space without creating a nested scroll axis.
const DECK_PROVENANCE_HEIGHT = DYNAMIC_APP_SMALL_LINE_HEIGHT + 6;
const DECK_DEPARTURE_PAGE_SIZE = 7;
const TRUSTED_SOURCE_ATTRIBUTIONS: Readonly<Record<TrustedSourceAttributionId, string>> = Object.freeze({
  open_meteo_ukmo: "Weather data by Open-Meteo.com · CC BY-SA 4.0 · UK Met Office",
});

function record(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function exact(value: Record<string, unknown>, keys: readonly string[]): boolean { const allowed = new Set(keys); return Object.keys(value).every((key) => allowed.has(key)); }
function bytes(value: string): number { return typeof TextEncoder !== "undefined" ? new TextEncoder().encode(value).length : encodeURIComponent(value).replace(/%[0-9A-F]{2}|./gi, "x").length; }
function text(value: unknown, points: number, maxBytes = points * 4): value is string {
  return typeof value === "string" && value.trim().length > 0 && Array.from(value).length <= points && bytes(value) <= maxBytes && !FORBIDDEN.test(value) && !URL.test(value);
}
function safeInteger(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 0; }
function boundedDecimal(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1_000_000_000 &&
    Math.abs(value * 1000 - Math.round(value * 1000)) < 1e-7;
}

function validateSource(value: unknown, nowMs: number): boolean {
  return record(value) && exact(value, ["id", "label", "attribution_id", "observed_at_ms", "stale_after_seconds", "status"]) &&
    typeof value.id === "string" && ID.test(value.id) && text(value.label, 40, 160) &&
    (value.attribution_id === undefined || value.attribution_id === "open_meteo_ukmo") &&
    (value.observed_at_ms === undefined || (safeInteger(value.observed_at_ms) && Number(value.observed_at_ms) <= nowMs + 300_000)) && Number.isInteger(value.stale_after_seconds) &&
    Number(value.stale_after_seconds) >= 30 && Number(value.stale_after_seconds) <= 86400 && ["current", "stale", "unavailable", "unknown"].includes(String(value.status));
}

function validateSection(value: unknown): string | null {
  if (!record(value) || typeof value.id !== "string" || !ID.test(value.id) || !Number.isInteger(value.order) || Number(value.order) < 0 || Number(value.order) > 3 ||
      !["pending", "ready", "empty", "error"].includes(String(value.load_state)) || !Array.isArray(value.source_ids) || value.source_ids.length < 1 || value.source_ids.length > 3 ||
      !value.source_ids.every((id) => typeof id === "string" && ID.test(id)) || !UNCERTAINTY.includes(String(value.uncertainty)) ||
      (value.title !== undefined && !text(value.title, 40, 160)) || (value.note !== undefined && !text(value.note, 64, 256)) ||
      (value.load_state === "error") !== (typeof value.error_code === "string" && ERRORS.includes(value.error_code))) return "section envelope is invalid";
  const common = ["id", "order", "type", "title", "load_state", "source_ids", "uncertainty", "note", "error_code"];
  if (value.type === "departures") {
    if (!exact(value, [...common, "rows"]) || !Array.isArray(value.rows) || value.rows.length > 12) return "departures section is invalid";
    const rowIds = new Set<string>();
    for (const row of value.rows) {
      if (!record(row) || !exact(row, ["id", "destination", "scheduled_departure_ms", "expected_departure_ms", "status", "platform"]) ||
          typeof row.id !== "string" || !ID.test(row.id) || rowIds.has(row.id) || !text(row.destination, 40, 160) || !safeInteger(row.scheduled_departure_ms) ||
          (row.expected_departure_ms !== undefined && !safeInteger(row.expected_departure_ms)) || !["on_time", "delayed", "cancelled", "unknown", "departed"].includes(String(row.status)) ||
          (row.platform !== undefined && !text(row.platform, 8, 32))) return "departure row is invalid";
      rowIds.add(row.id);
    }
    return null;
  }
  if (value.type === "status_grid") {
    if (!exact(value, [...common, "rows"]) || !Array.isArray(value.rows) || value.rows.length > 6) return "status section is invalid";
    const rowIds = new Set<string>();
    for (const row of value.rows) {
      if (!record(row) || !exact(row, ["id", "label", "value", "tone"]) || typeof row.id !== "string" || !ID.test(row.id) ||
          rowIds.has(row.id) || !text(row.label, 40, 160) || !text(row.value, 64, 256) ||
          (row.tone !== undefined && !["neutral", "good", "warning", "critical"].includes(String(row.tone)))) return "status row is invalid";
      rowIds.add(row.id);
    }
    return null;
  }
  if (value.type === "bar_chart") {
    if (!exact(value, [...common, "bars"]) || !text(value.title, 40, 160) || !Array.isArray(value.bars) || value.bars.length < 1 || value.bars.length > 5) return "bar chart section is invalid";
    const barIds = new Set<string>();
    for (const bar of value.bars) {
      if (!record(bar) || !exact(bar, ["id", "label", "value", "max", "unit"]) || typeof bar.id !== "string" || !ID.test(bar.id) || barIds.has(bar.id) ||
          !text(bar.label, 24, 96) || !boundedDecimal(bar.value) || !boundedDecimal(bar.max) || Number(bar.max) <= 0 || Number(bar.value) > Number(bar.max) ||
          (bar.unit !== undefined && !text(bar.unit, 8, 32))) return "bar chart row is invalid";
      barIds.add(bar.id);
    }
    return null;
  }
  if (value.type === "list") return exact(value, [...common, "items"]) && Array.isArray(value.items) && value.items.length <= 8 && value.items.every((item) => text(item, 96, 384)) ? null : "list section is invalid";
  if (value.type === "message") return exact(value, [...common, "body"]) && text(value.body, 160, 640) ? null : "message section is invalid";
  return "section type is unsupported";
}

export function validateContextDashboardSpec(value: unknown, nowMs = Date.now()): string | null {
  if (!record(value) || !exact(value, ["version", "presentation_mode", "dashboard_key", "title", "state", "privacy", "summary", "sections", "sources", "local_actions", "announcement", "ttl_seconds"])) return "spec contains unsupported fields";
  let encoded: string;
  try { encoded = JSON.stringify(value); } catch { return "spec is not serializable"; }
  if (bytes(encoded) > CONTEXT_DASHBOARD_CAPABILITIES.maxSpecBytes) return "spec exceeds 16 KiB";
  if (value.version !== 2 || (value.presentation_mode !== undefined && !["single", "deck"].includes(String(value.presentation_mode))) ||
      typeof value.dashboard_key !== "string" || !ID.test(value.dashboard_key) || !text(value.title, 48, 192) || !STATES.includes(String(value.state)) || !["public", "private", "sensitive"].includes(String(value.privacy))) return "dashboard identity is invalid";
  if (!record(value.summary) || !exact(value.summary, ["primary", "secondary", "tone", "uncertainty"]) || !text(value.summary.primary, 64, 256) ||
      (value.summary.secondary !== undefined && !text(value.summary.secondary, 96, 384)) || (value.summary.tone !== undefined && !["neutral", "good", "warning", "critical"].includes(String(value.summary.tone))) || !UNCERTAINTY.includes(String(value.summary.uncertainty))) return "summary is invalid";
  if (!Number.isInteger(value.ttl_seconds) || Number(value.ttl_seconds) < 30 || Number(value.ttl_seconds) > 3600) return "ttl is invalid";
  if (!Array.isArray(value.sources) || value.sources.length < 1 || value.sources.length > 3 || !value.sources.every((source) => validateSource(source, nowMs))) return "sources are invalid";
  const sourceIds = new Set(value.sources.map((source) => (source as Source).id));
  if (sourceIds.size !== value.sources.length) return "source IDs must be unique";
  if (!Array.isArray(value.sections) || value.sections.length < 1 || value.sections.length > 4) return "sections are invalid";
  const sectionIds = new Set<string>(); let records = 0;
  for (const section of value.sections) {
    const error = validateSection(section); if (error) return error;
    const candidate = section as ContextDashboardSection;
    if (sectionIds.has(candidate.id) || candidate.order !== sectionIds.size || candidate.source_ids.some((id) => !sourceIds.has(id))) return "section identity, order, or source is invalid";
    sectionIds.add(candidate.id); records += candidate.type === "departures" || candidate.type === "status_grid" ? candidate.rows.length :
      candidate.type === "bar_chart" ? candidate.bars.length : candidate.type === "list" ? candidate.items.length : 1;
  }
  if (records > 20) return "dashboard exceeds 20 records";
  if (!Array.isArray(value.local_actions) || value.local_actions.length > 3) return "local actions are invalid";
  const actionIds = new Set<string>();
  for (const action of value.local_actions) {
    if (!record(action) || !exact(action, ["id", "kind", "label", "enabled"]) || typeof action.id !== "string" || !ID.test(action.id) || actionIds.has(action.id) ||
        !LOCAL_ACTIONS.includes(String(action.kind)) || (action.kind === "section" && !sectionIds.has(action.id)) ||
        !text(action.label, 24, 96) || typeof action.enabled !== "boolean") return "local action is invalid";
    actionIds.add(action.id);
  }
  if (value.presentation_mode === "deck" && value.local_actions.length > 0) {
    return "deck interfaces cannot contain provider local actions";
  }
  if (value.presentation_mode === "deck") {
    const pages = deckPageCount(value.sections as ContextDashboardSection[], nowMs);
    if (pages > CONTEXT_DASHBOARD_CAPABILITIES.maxDeckPages) return "deck exceeds 7 pages";
  }
  if (value.announcement !== undefined && (!record(value.announcement) || !exact(value.announcement, ["id", "text", "policy"]) || typeof value.announcement.id !== "string" || !ID.test(value.announcement.id) || !text(value.announcement.text, 160, 640) || value.announcement.policy !== "once_when_useful")) return "announcement is invalid";
  return bytes(JSON.stringify({ title: value.title, summary: value.summary, sections: value.sections, sources: value.sources })) <= CONTEXT_DASHBOARD_CAPABILITIES.maxTextBytes ? null : "retained text exceeds 8 KiB";
}

function connectionKey(context?: ToolExecutionContext): string | null {
  return context?.caller === "mcp" && context.profileId === "even-g2" && context.connectionGeneration !== undefined && context.connectionGeneration !== null && context.connectionGeneration !== ""
    ? `mcp:${String(context.connectionGeneration)}`
    : null;
}
function turnKey(context?: ToolExecutionContext): string | null { const connection = connectionKey(context); return connection && context?.turnGeneration ? `${connection}:turn:${String(context.turnGeneration)}` : null; }
function defaultId(): string { const uuid = (globalThis as any).crypto?.randomUUID?.(); if (!uuid) throw new Error("secure random identity is unavailable"); return uuid.replace(/-/g, ""); }
function result(content: object): ToolResult { return { ok: true, content: JSON.stringify(content) }; }
function fail(error: string): ToolResult { return { ok: false, error }; }
function validRefreshPolicy(value: unknown): value is RefreshPolicy { return record(value) && exact(value, ["mode", "min_interval_seconds"]) && ["manual", "on_visible"].includes(String(value.mode)) && Number.isInteger(value.min_interval_seconds) && Number(value.min_interval_seconds) >= 30 && Number(value.min_interval_seconds) <= 86400; }

/**
 * Context dashboard specs have already passed the exact JSON-only schema and
 * byte limits before delivery. Keep an owned copy without relying on the Web
 * structured-clone API, which isn't provided by every NativeScript Android
 * runtime. Clone before installing pixels so a platform capability mismatch
 * can never strand an uncommitted loading layer on the lenses.
 */
function cloneValidatedSpec(spec: ContextDashboardSpec): ContextDashboardSpec {
  return JSON.parse(JSON.stringify(spec)) as ContextDashboardSpec;
}

function lastSundayAtOneUtc(year: number, month: number): number {
  const last = new Date(Date.UTC(year, month + 1, 0));
  return Date.UTC(year, month, last.getUTCDate() - last.getUTCDay(), 1);
}

function londonTime(timestampMs: number): string {
  const DateTimeFormat = (globalThis as any).Intl?.DateTimeFormat;
  if (typeof DateTimeFormat === "function") {
    try {
      return new DateTimeFormat("en-GB", {
        timeZone: "Europe/London", hour: "2-digit", minute: "2-digit", hour12: false,
      }).format(new Date(timestampMs));
    } catch { /* NativeScript may not ship Intl or time-zone data. */ }
  }
  const instant = new Date(timestampMs);
  const year = instant.getUTCFullYear();
  const bst = timestampMs >= lastSundayAtOneUtc(year, 2) && timestampMs < lastSundayAtOneUtc(year, 9);
  const london = new Date(timestampMs + (bst ? 60 * 60_000 : 0));
  return `${String(london.getUTCHours()).padStart(2, "0")}:${String(london.getUTCMinutes()).padStart(2, "0")}`;
}

function effectiveLocalActions(spec: ContextDashboardSpec, pinState: ContextDashboardPinState): RenderAction[] {
  // Pinning is a phone-owned lifecycle control. V2 providers that still send
  // pin/unpin declarations remain compatible, but cannot hide, duplicate, or
  // relabel the local affordance.
  const actions: RenderAction[] = spec.local_actions
    .filter((action) => action.enabled && action.kind !== "pin" && action.kind !== "unpin")
    .map((action) => ({ ...action, componentId: `action:${action.kind}:${action.id}` }));
  if (pinState === "available" || pinState === "saved" || pinState === "save_failed" || pinState === "unpin_failed") {
    const pinned = pinState === "saved" || pinState === "unpin_failed";
    actions.push({
      id: "pin",
      kind: pinned ? "unpin" : "pin",
      label: pinned ? "Unpin" : "Pin",
      enabled: true,
      componentId: PHONE_PIN_COMPONENT_ID,
    });
  }
  return actions;
}

function pinStateFor(spec: ContextDashboardSpec, regeneration: RegenerationMode, pinned: boolean, canPin: boolean): ContextDashboardPinState {
  if (pinned) return "saved";
  if (spec.privacy === "sensitive" || regeneration !== "self_contained_intent") return "not_pinnable";
  return canPin ? "available" : "limit";
}

function pinMatchesRecipe(pin: PinRecord, title: string, privacy: DynamicAppPrivacy, intent: string, refreshPolicy: RefreshPolicy): boolean {
  return pin.title === title && pin.privacy === privacy && pin.intent === intent &&
    pin.refresh_policy.mode === refreshPolicy.mode &&
    pin.refresh_policy.min_interval_seconds === refreshPolicy.min_interval_seconds;
}

function localActionHandle(action: LocalAction): string {
  return `localaction_${action.kind}_${action.id}`.padEnd(16, "_");
}

function uncertaintyLabel(value: Uncertainty): string {
  return value === "estimated" ? " · Est." : value === "unknown" ? " · Uncertain" : "";
}

function provenanceText(sources: Source[], nowMs: number): string {
  return sources.map((item) => {
    // Attribution identifiers select phone-owned literals only. Caller text is
    // still URL-rejected above and can never inject a destination or link.
    const label = item.attribution_id ? TRUSTED_SOURCE_ATTRIBUTIONS[item.attribution_id] : item.label;
    if (item.observed_at_ms === undefined) return `${label}: ${item.status} · freshness unknown`;
    const ageMs = nowMs - item.observed_at_ms;
    if (ageMs < -300_000) return `${label}: clock invalid · freshness unknown`;
    const ageSeconds = Math.max(0, Math.floor(ageMs / 1000));
    const status = item.status === "current" && ageSeconds > item.stale_after_seconds ? "stale" : item.status;
    return `${label}: ${status} · ${ageSeconds < 60 ? `${ageSeconds}s` : `${Math.floor(ageSeconds / 60)}m`} ago`;
  }).join(" · ");
}

function formatBarValue(value: number, unit?: string): string {
  const formatted = Number.isInteger(value) ? String(value) : value.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
  return unit ? `${formatted} ${unit}` : formatted;
}

function sectionComponents(section: ContextDashboardSection, nowMs: number): DynamicAppComponent[] {
  const components: DynamicAppComponent[] = [];
  if (section.note) components.push({ id: `section:${section.id}:note`, type: "text", text: section.note });
  if (section.load_state === "pending") {
    components.push({ id: `section:${section.id}:pending`, type: "text", text: "Loading…" });
  } else if (section.load_state === "error") {
    components.push({ id: `section:${section.id}:error`, type: "status", label: section.title ?? "Section", value: section.error_code ?? "unavailable", tone: "warning" });
  } else if (section.load_state === "empty") {
    components.push({ id: `section:${section.id}:empty`, type: "text", text: "No results" });
  } else if (section.type === "departures") {
    for (const row of section.rows) {
      const time = londonTime(row.expected_departure_ms ?? row.scheduled_departure_ms);
      const suffix = row.status === "on_time" ? time : row.status === "unknown" ? `${time} ?` : `${time} ${row.status}`;
      components.push({ id: `section:${section.id}:row:${row.id}`, type: "status", label: row.destination,
        value: row.platform ? `${suffix} P${row.platform}` : suffix,
        tone: row.status === "cancelled" ? "critical" : row.status === "delayed" ? "warning" : "neutral" });
    }
  } else if (section.type === "status_grid") {
    for (const row of section.rows) components.push({ id: `section:${section.id}:row:${row.id}`, type: "status", label: row.label, value: row.value, tone: row.tone });
  } else if (section.type === "bar_chart") {
    for (const bar of section.bars) components.push({ id: `section:${section.id}:bar:${bar.id}`, type: "progress",
      label: `${bar.label} · ${formatBarValue(bar.value, bar.unit)}`, value: bar.value / bar.max });
  } else if (section.type === "list") {
    for (let index = 0; index < section.items.length; index++) components.push({ id: `section:${section.id}:item:${index}`, type: "text", text: section.items[index]! });
  } else {
    components.push({ id: `section:${section.id}:body`, type: "card", title: section.title ?? "Details", body: section.body });
  }
  return components;
}

/**
 * Pack a section into deterministic page-sized component chunks. Provenance
 * is repeated on every page and reserved up front, so no generated component
 * can be silently clipped below the footer.
 */
function deckComponentChunks(components: DynamicAppComponent[], maxStatusRows = Number.POSITIVE_INFINITY): DynamicAppComponent[][] {
  const contentBudget = DYNAMIC_APP_DECK_COMPONENT_BUDGET - DECK_PROVENANCE_HEIGHT;
  const chunks: DynamicAppComponent[][] = [[]];
  let used = 0;
  let statusRows = 0;
  for (const component of components) {
    const height = dynamicAppComponentHeight(component, DYNAMIC_APP_SMALL_LINE_HEIGHT);
    if (height > contentBudget) {
      throw new Error(`context dashboard component ${component.id} cannot fit a deck page`);
    }
    if (chunks[chunks.length - 1]!.length > 0 &&
        (used + height > contentBudget || (component.type === "status" && statusRows >= maxStatusRows))) {
      chunks.push([]);
      used = 0;
      statusRows = 0;
    }
    chunks[chunks.length - 1]!.push(component);
    used += height;
    if (component.type === "status") statusRows++;
  }
  return chunks;
}

function deckChunksForSection(section: ContextDashboardSection, nowMs: number): DynamicAppComponent[][] {
  return deckComponentChunks(
    sectionComponents(section, nowMs),
    section.type === "departures" && section.load_state === "ready" ? DECK_DEPARTURE_PAGE_SIZE : Number.POSITIVE_INFINITY,
  );
}

function deckPageCount(sections: ContextDashboardSection[], nowMs: number): number {
  return 1 + sections.reduce((total, section) =>
    total + deckChunksForSection(section, nowMs).length, 0);
}

function pinComponents(spec: ContextDashboardSpec, pinState: ContextDashboardPinState): DynamicAppComponent[] {
  const components: DynamicAppComponent[] = [];
  if (pinState === "not_pinnable") {
    components.push({ id: "phone:pin:status", type: "status", label: "Pin", value: "Not pinnable", tone: "neutral" });
  } else if (pinState === "limit") {
    components.push({ id: "phone:pin:status", type: "status", label: "Pins", value: "5/5 full", tone: "warning" });
  } else if (pinState === "save_failed" || pinState === "unpin_failed") {
    components.push({ id: "phone:pin:status", type: "status", label: "Pin",
      value: pinState === "save_failed" ? "Save failed" : "Remove failed", tone: "warning" });
  }
  for (const action of effectiveLocalActions(spec, pinState)) {
    components.push({ id: action.componentId, type: "button", label: action.label, action_handle: localActionHandle(action) });
  }
  return components;
}

function assertUniqueComponents(components: DynamicAppComponent[]): void {
  if (new Set(components.map((component) => component.id)).size !== components.length) {
    throw new Error("context dashboard generated duplicate component identities");
  }
  if (components.length > 64) throw new Error("context dashboard generated more than 64 components");
}

function componentsFor(spec: ContextDashboardSpec, pinState: ContextDashboardPinState, nowMs: number): DynamicAppComponent[] {
  const components: DynamicAppComponent[] = [{ id: "phone:summary", type: "heading", text: `${spec.summary.primary}${uncertaintyLabel(spec.summary.uncertainty)}` }];
  if (spec.summary.secondary) components.push({ id: "phone:summary:detail", type: "text", text: spec.summary.secondary });
  // Provenance follows the answer-first summary so it cannot be pushed below
  // all provider rows on the first viewport.
  components.push({ id: "phone:provenance", type: "text", text: provenanceText(spec.sources, nowMs) });
  for (const section of spec.sections) {
    if (section.title) components.push({ id: `section:${section.id}:heading`, type: "heading", text: `${section.title}${uncertaintyLabel(section.uncertainty)}` });
    components.push(...sectionComponents(section, nowMs));
  }
  components.push(...pinComponents(spec, pinState));
  assertUniqueComponents(components);
  return components;
}

function pagesFor(spec: ContextDashboardSpec, pinState: ContextDashboardPinState, nowMs: number): ContextDashboardPage[] {
  const pinAction = effectiveLocalActions(spec, pinState).find((action) => action.kind === "pin" || action.kind === "unpin");
  const coverComponents: DynamicAppComponent[] = [
    { id: "phone:summary", type: "heading", text: `${spec.summary.primary}${uncertaintyLabel(spec.summary.uncertainty)}` },
    ...(spec.summary.secondary ? [{ id: "phone:summary:detail", type: "text" as const, text: spec.summary.secondary }] : []),
    { id: "phone:provenance", type: "text", text: provenanceText(spec.sources, nowMs) },
    ...pinComponents(spec, pinState),
  ];
  assertUniqueComponents(coverComponents);
  const pages: ContextDashboardPage[] = [{ id: "cover", title: spec.title, components: coverComponents, action: pinAction }];
  for (const section of spec.sections) {
    const chunks = deckChunksForSection(section, nowMs);
    chunks.forEach((chunk, index) => {
      const sources = spec.sources.filter((source) => section.source_ids.includes(source.id));
      const components = [...chunk];
      components.push({ id: `section:${section.id}:provenance:${index}`, type: "text", text: provenanceText(sources, nowMs) });
      assertUniqueComponents(components);
      const continued = chunks.length > 1 ? ` ${index + 1}/${chunks.length}` : "";
      pages.push({ id: `section:${section.id}:page:${index}`,
        title: `${section.title ?? spec.title}${continued}${uncertaintyLabel(section.uncertainty)}`, components });
    });
  }
  if (pages.length > CONTEXT_DASHBOARD_CAPABILITIES.maxDeckPages) throw new Error("context dashboard generated too many deck pages");
  if (new Set(pages.map((page) => page.id)).size !== pages.length) throw new Error("context dashboard generated duplicate page identities");
  return pages;
}

function installDeckPage(render: ContextDashboardRenderState, page: ContextDashboardPage, pageIndex: number, pageCount: number): void {
  render.title = page.title;
  render.components = page.components;
  render.scrollOffset = 0;
  render.selectedAction = 0;
  render.presentationMode = "deck";
  render.pageIndex = pageIndex;
  render.pageCount = pageCount;
  render.pageId = page.id;
  render.deckActionHandle = page.action ? localActionHandle(page.action) : undefined;
  render.deckActionLabel = page.action?.label;
}

function loadingSpec(key: string, title: string, privacy: DynamicAppPrivacy, ttl: number): ContextDashboardSpec {
  return { version: 2, dashboard_key: key, title, state: "loading", privacy,
    summary: { primary: "Preparing a temporary view…", uncertainty: "unknown" },
    sections: [{ id: "results", order: 0, type: "message", load_state: "pending", source_ids: ["pending"], uncertainty: "unknown", body: "Formatting the first useful result" }],
    sources: [{ id: "pending", label: "Current answer", stale_after_seconds: 30, status: "unknown" }],
    local_actions: [], ttl_seconds: ttl };
}

export class ContextDashboardManager {
  private current: Current | null = null;
  /** Offscreen begin/open-pin identity; no loading pixels are ever installed. */
  private reserved: Reservation | null = null;
  private pending: (Identity & { connectionKey: string; turnKey: string; cancelled: boolean }) | null = null;
  private readonly pins: PinRecord[];
  private queue: Promise<unknown> = Promise.resolve();
  private timer: unknown = null;
  private readonly operations = new Map<string, { fingerprint: string; value: ToolResult }>();
  private readonly lastRefreshAt = new Map<string, number>();
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
    const loadedPins = deps.loadPins?.();
    this.pins = this.validatePins(loadedPins);
    if (Array.isArray(loadedPins) && loadedPins.length > 0 && this.pins.length === 0) {
      // The encrypted envelope may be structurally current while one retained
      // record is invalid. Fail closed and overwrite that nonempty hidden data;
      // a genuinely empty valid store is left untouched.
      try { deps.savePins?.([]); } catch { /* remain empty even if secure deletion fails */ }
    }
  }

  begin(args: unknown, signal?: AbortSignal, isAllowed?: () => boolean, context?: ToolExecutionContext): Promise<ToolResult> { return this.enqueue(() => this.beginOnce(args, signal, isAllowed, context)); }
  present(args: unknown, signal?: AbortSignal, isAllowed?: () => boolean, context?: ToolExecutionContext): Promise<ToolResult> { return this.enqueue(() => this.presentOnce(args, signal, isAllowed, context)); }
  openPin(args: unknown, signal?: AbortSignal, isAllowed?: () => boolean, context?: ToolExecutionContext): Promise<ToolResult> { return this.enqueue(() => this.openPinOnce(args, signal, isAllowed, context)); }
  publish(args: unknown, signal?: AbortSignal, isAllowed?: () => boolean, context?: ToolExecutionContext): Promise<ToolResult> { return this.enqueue(() => this.publishOnce(args, signal, isAllowed, context)); }
  startRefresh(args: unknown, signal?: AbortSignal, isAllowed?: () => boolean, context?: ToolExecutionContext): Promise<ToolResult> { return this.enqueue(() => this.refreshOnce(args, signal, isAllowed, context)); }
  close(args: unknown, context?: ToolExecutionContext): ToolResult {
    const connection = connectionKey(context);
    if (!connection || !record(args) || !exact(args, ["operation_id", "dashboard_id", "presentation_generation", "expected_revision"]) ||
        typeof args.operation_id !== "string" || !ID.test(args.operation_id)) {
      return fail("dashboard close owner or presentation is stale");
    }
    const replay = this.replay(connection, args.operation_id, args);
    if (replay) return replay;
    const presentation = this.current ?? this.reserved;
    if (!presentation || presentation.connectionKey !== connection || presentation.dashboardId !== args.dashboard_id ||
        presentation.presentationGeneration !== args.presentation_generation || presentation.revision !== args.expected_revision) {
      return fail("dashboard close owner or presentation is stale");
    }
    const identity = { dashboard_id: presentation.dashboardId, presentation_generation: presentation.presentationGeneration, revision: presentation.revision };
    if (this.pending?.connectionKey === connection && this.pending.dashboardId === presentation.dashboardId) {
      this.cancelPending(this.pending);
    }
    if (this.current === presentation) this.closeCurrent();
    else this.closeReservation();
    return this.remember(connection, args.operation_id, args, result({ status: "closed", ...identity }));
  }
  private enqueue(task: () => Promise<ToolResult>): Promise<ToolResult> { const pending = this.queue.then(task); this.queue = pending.catch(() => undefined); return pending; }
  private replay(owner: string, operationId: string, args: unknown): ToolResult | null {
    const key = `${owner}:${operationId}`;
    const fingerprint = JSON.stringify(args);
    const prior = this.operations.get(key);
    if (!prior) return null;
    if (prior.fingerprint !== fingerprint) return fail("operation_id was reused with different arguments");
    if (!prior.value.ok) return prior.value;
    const parsed = JSON.parse(prior.value.content ?? "{}");
    const exactCurrent = Boolean(this.current && this.current.dashboardId === parsed.dashboard_id && this.current.revision === parsed.revision);
    const exactReservation = Boolean(this.reserved && this.reserved.dashboardId === parsed.dashboard_id && this.reserved.revision === parsed.revision);
    if (parsed.dashboard_id && !exactCurrent && !exactReservation) {
      // A selected pin may disclose its bounded intent only while that exact
      // loading presentation is still current. Historical operation receipts
      // are identity tombstones, not a second intent-read surface.
      delete parsed.intent;
      prior.value = result(parsed);
      return result({ ...parsed, status: "historical_acknowledgement" });
    }
    return prior.value;
  }
  private remember(turn: string, operationId: string, args: unknown, value: ToolResult): ToolResult { this.operations.set(`${turn}:${operationId}`, { fingerprint: JSON.stringify(args), value }); if (this.operations.size > 256) this.operations.delete(this.operations.keys().next().value!); return value; }

  /**
   * Gather-first answer path. Unlike begin/publish, this validates and delivers
   * exactly one terminal revision, so thinking/loading can never reach lenses.
   */
  private async presentOnce(args: unknown, signal?: AbortSignal, isAllowed?: () => boolean, context?: ToolExecutionContext): Promise<ToolResult> {
    const turn = turnKey(context); const connection = connectionKey(context);
    if (!turn || !connection || !record(args) || !exact(args, ["operation_id", "intent", "refresh_policy", "regeneration", "spec"]) ||
        typeof args.operation_id !== "string" || !ID.test(args.operation_id) || !text(args.intent, 240, 960) ||
        !validRefreshPolicy(args.refresh_policy) || !["self_contained_intent", "current_turn_only"].includes(String(args.regeneration))) {
      return fail("present arguments or exact owner are invalid");
    }
    const replay = this.replay(turn, args.operation_id, args); if (replay) return replay;
    const validation = validateContextDashboardSpec(args.spec, this.now());
    if (validation) return fail(`Invalid contextual dashboard spec: ${validation}`);
    const spec = args.spec as ContextDashboardSpec;
    if (!["ready", "empty", "error", "offline"].includes(spec.state) ||
        spec.sections.some((section) => section.load_state === "pending")) {
      return fail("atomic contextual answers must contain one final state with no pending sections");
    }
    const regeneration = args.regeneration as RegenerationMode;
    if (regeneration === "current_turn_only" && spec.local_actions.length > 0) {
      return fail("current-turn-only interfaces cannot publish cross-turn local actions");
    }
    const existingPin = this.pins.find((pin) => pin.dashboard_key === spec.dashboard_key);
    if (existingPin && (regeneration !== "self_contained_intent" ||
        !pinMatchesRecipe(existingPin, spec.title, spec.privacy, String(args.intent), args.refresh_policy))) {
      return fail("dashboard key already belongs to a different pinned recipe");
    }
    const dashboardId = this.createId();
    if (!LONG_ID.test(dashboardId)) return fail("secure dashboard identity generation failed");
    if (this.pending) this.cancelPending(this.pending);
    if (this.current) this.closeCurrent();
    if (this.reserved) this.closeReservation();
    this.events.length = 0;
    this.acknowledgedEvents.clear();
    const delivered = await this.deliver(
      spec,
      { dashboardId, presentationGeneration: 1, refreshGeneration: 1, revision: 1 },
      connection,
      turn,
      String(args.intent),
      args.refresh_policy,
      regeneration,
      Boolean(existingPin),
      signal,
      isAllowed,
      true,
    );
    return this.remember(turn, args.operation_id, args, delivered);
  }

  private async beginOnce(args: unknown, signal?: AbortSignal, isAllowed?: () => boolean, context?: ToolExecutionContext): Promise<ToolResult> {
    const turn = turnKey(context); const connection = connectionKey(context);
    if (!turn || !connection || !record(args) || !exact(args, ["operation_id", "dashboard_key", "title", "privacy", "intent", "refresh_policy", "regeneration", "ttl_seconds"]) || typeof args.operation_id !== "string" || !ID.test(args.operation_id) || typeof args.dashboard_key !== "string" || !ID.test(args.dashboard_key) || !text(args.title, 48, 192) || !["public", "private", "sensitive"].includes(String(args.privacy)) || !text(args.intent, 240, 960) || !validRefreshPolicy(args.refresh_policy) || (args.regeneration !== undefined && !["self_contained_intent", "current_turn_only"].includes(String(args.regeneration))) || !Number.isInteger(args.ttl_seconds) || Number(args.ttl_seconds) < 30 || Number(args.ttl_seconds) > 3600) return fail("begin arguments or exact owner are invalid");
    const replay = this.replay(turn, args.operation_id, args); if (replay) return replay;
    // Legacy callers that omit the V2.1 hint fail safely as current-turn-only.
    const regeneration: RegenerationMode = args.regeneration === "self_contained_intent" ? "self_contained_intent" : "current_turn_only";
    const existingPin = this.pins.find((pin) => pin.dashboard_key === args.dashboard_key);
    if (existingPin && (regeneration !== "self_contained_intent" || !pinMatchesRecipe(existingPin, String(args.title), args.privacy as DynamicAppPrivacy, String(args.intent), args.refresh_policy))) {
      return fail("dashboard key already belongs to a different pinned recipe");
    }
    const pinned = Boolean(existingPin);
    const dashboardId = this.createId(); if (!LONG_ID.test(dashboardId)) return fail("secure dashboard identity generation failed");
    this.events.length = 0;
    this.acknowledgedEvents.clear();
    const reserved = this.reserve(
      loadingSpec(args.dashboard_key, args.title, args.privacy as DynamicAppPrivacy, Number(args.ttl_seconds)),
      { dashboardId, presentationGeneration: 1, refreshGeneration: 1, revision: 1 },
      connection, turn, String(args.intent), args.refresh_policy, regeneration, pinned, signal, isAllowed,
    );
    return this.remember(turn, args.operation_id, args, reserved);
  }

  private async openPinOnce(args: unknown, signal?: AbortSignal, isAllowed?: () => boolean, context?: ToolExecutionContext): Promise<ToolResult> {
    const turn = turnKey(context); const connection = connectionKey(context);
    if (!turn || !connection || !record(args) || !exact(args, ["operation_id", "dashboard_key", "ttl_seconds"]) ||
        typeof args.operation_id !== "string" || !ID.test(args.operation_id) || typeof args.dashboard_key !== "string" || !ID.test(args.dashboard_key) ||
        !Number.isInteger(args.ttl_seconds) || Number(args.ttl_seconds) < 30 || Number(args.ttl_seconds) > 3600) return fail("open pin arguments or exact owner are invalid");
    const replay = this.replay(turn, args.operation_id, args); if (replay) return replay;
    const pin = this.pins.find((candidate) => candidate.dashboard_key === args.dashboard_key);
    if (!pin) return fail("pinned dashboard is unavailable");
    const dashboardId = this.createId(); if (!LONG_ID.test(dashboardId)) return fail("secure dashboard identity generation failed");
    this.events.length = 0; this.acknowledgedEvents.clear();
    const reserved = this.reserve(loadingSpec(pin.dashboard_key, pin.title, pin.privacy, Number(args.ttl_seconds)),
      { dashboardId, presentationGeneration: 1, refreshGeneration: 1, revision: 1 }, connection, turn, pin.intent, pin.refresh_policy,
      "self_contained_intent", true, signal, isAllowed);
    if (!reserved.ok) return this.remember(turn, args.operation_id, args, reserved);
    const receipt = JSON.parse(reserved.content ?? "{}");
    return this.remember(turn, args.operation_id, args, result({ ...receipt, intent: pin.intent }));
  }

  private async publishOnce(args: unknown, signal?: AbortSignal, isAllowed?: () => boolean, context?: ToolExecutionContext): Promise<ToolResult> {
    const turn = turnKey(context); const connection = connectionKey(context);
    if (!turn || !connection || !record(args) || !exact(args, ["operation_id", "dashboard_id", "presentation_generation", "refresh_generation", "expected_revision", "spec"]) || typeof args.operation_id !== "string" || !ID.test(args.operation_id)) return fail("publish arguments or exact owner are invalid");
    const replay = this.replay(turn, args.operation_id, args); if (replay) return replay;
    const current = this.current ?? this.reserved;
    const publishesReservation = this.reserved === current;
    if (!current || current.connectionKey !== connection || current.turnKey !== turn || current.dashboardId !== args.dashboard_id || current.presentationGeneration !== args.presentation_generation || current.refreshGeneration !== args.refresh_generation || current.revision !== args.expected_revision) return fail("dashboard turn, presentation, refresh, or revision is stale");
    const validation = validateContextDashboardSpec(args.spec, this.now()); if (validation) return fail(`Invalid contextual dashboard spec: ${validation}`);
    const spec = args.spec as ContextDashboardSpec;
    if (publishesReservation && (!["ready", "empty", "error", "offline"].includes(spec.state) ||
        spec.sections.some((section) => section.load_state === "pending"))) {
      return fail("reserved contextual dashboards must publish one final state with no pending sections");
    }
    if (spec.dashboard_key !== current.dashboardKey || spec.privacy !== current.spec.privacy) return fail("dashboard key or privacy is stale");
    if (current.regeneration === "current_turn_only" && spec.local_actions.length > 0) return fail("current-turn-only interfaces cannot publish cross-turn local actions");
    const delivered = await this.deliver(spec, { dashboardId: current.dashboardId, presentationGeneration: current.presentationGeneration, refreshGeneration: current.refreshGeneration, revision: current.revision + 1 }, connection, turn, current.intent, current.refreshPolicy, current.regeneration, current.pinned, signal, isAllowed, publishesReservation);
    return this.remember(turn, args.operation_id, args, delivered);
  }

  private async refreshOnce(args: unknown, signal?: AbortSignal, isAllowed?: () => boolean, context?: ToolExecutionContext): Promise<ToolResult> {
    const turn = turnKey(context); const connection = connectionKey(context);
    if (!turn || !connection || !record(args) || !exact(args, ["operation_id", "dashboard_id", "presentation_generation", "expected_revision"]) || typeof args.operation_id !== "string" || !ID.test(args.operation_id)) return fail("refresh arguments or exact owner are invalid");
    const replay = this.replay(connection, args.operation_id, args);
    if (replay) {
      if (replay.ok && this.current) {
        const receipt = JSON.parse(replay.content ?? "{}");
        if (receipt.status !== "historical_acknowledgement" && receipt.dashboard_id === this.current.dashboardId &&
            receipt.presentation_generation === this.current.presentationGeneration &&
            receipt.refresh_generation === this.current.refreshGeneration && receipt.revision === this.current.revision) {
          this.current.turnKey = turn;
        }
      }
      return replay;
    }
    const current = this.current;
    if (!current || current.connectionKey !== connection || current.dashboardId !== args.dashboard_id || current.presentationGeneration !== args.presentation_generation || current.revision !== args.expected_revision) return fail("dashboard presentation or revision is stale");
    if (current.regeneration !== "self_contained_intent") return fail("current-turn-only interfaces cannot be refreshed from a saved intent");
    const lastRefresh = this.lastRefreshAt.get(current.dashboardKey) ?? 0;
    if (this.now() - lastRefresh < current.refreshPolicy.min_interval_seconds * 1000) return fail("dashboard refresh is rate limited by its current policy");
    const spec = { ...current.spec, state: "loading" as const, summary: { ...current.spec.summary, secondary: "Refreshing the current answer", uncertainty: "unknown" as const } };
    const delivered = await this.deliver(spec, { dashboardId: current.dashboardId, presentationGeneration: current.presentationGeneration, refreshGeneration: current.refreshGeneration + 1, revision: current.revision + 1 }, connection, turn, current.intent, current.refreshPolicy, current.regeneration, current.pinned, signal, isAllowed);
    if (delivered.ok) {
      this.lastRefreshAt.delete(current.dashboardKey);
      this.lastRefreshAt.set(current.dashboardKey, this.now());
      while (this.lastRefreshAt.size > 128) this.lastRefreshAt.delete(this.lastRefreshAt.keys().next().value!);
    }
    return this.remember(connection, args.operation_id, args, delivered);
  }

  private async deliver(spec: ContextDashboardSpec, identity: Identity, connection: string, turn: string, intent: string, refreshPolicy: RefreshPolicy, regeneration: RegenerationMode, pinned: boolean, signal?: AbortSignal, isAllowed?: () => boolean, atomicFinal = false): Promise<ToolResult> {
    if (signal?.aborted || (isAllowed && !isAllowed())) return fail("authorizing turn is no longer active");
    if (!this.deps.isDisplayAvailable()) return fail("glasses display is disconnected or unavailable");
    const retainedSpec = cloneValidatedSpec(spec);
    const nowMs = this.now();
    const presentationMode = spec.presentation_mode ?? "single";
    const priorFocusedId = this.current?.dashboardId === identity.dashboardId
      ? this.current.render.components[this.current.render.scrollOffset]?.id
      : undefined;
    const priorPageId = this.current?.dashboardId === identity.dashboardId && this.current.render.presentationMode === "deck"
      ? this.current.render.pageId
      : undefined;
    const pinState = pinStateFor(spec, regeneration, pinned, pinned || this.pins.length < CONTEXT_DASHBOARD_CAPABILITIES.maxPinned);
    const pages = presentationMode === "deck" ? pagesFor(spec, pinState, nowMs) : null;
    const pageIndex = pages ? Math.max(0, pages.findIndex((page) => page.id === priorPageId)) : 0;
    const page = pages?.[pageIndex];
    const renderedComponents = page ? page.components : componentsFor(spec, pinState, nowMs);
    const preservedOffset = priorFocusedId ? renderedComponents.findIndex((component) => component.id === priorFocusedId) : -1;
    const candidateExpiry = nowMs + spec.ttl_seconds * 1000;
    const activeExpiry = this.current && this.current.dashboardId === identity.dashboardId &&
      this.current.presentationGeneration === identity.presentationGeneration && this.current.refreshGeneration === identity.refreshGeneration
      ? this.current.render.expiresAtMs
      : this.reserved && this.reserved.dashboardId === identity.dashboardId &&
        this.reserved.presentationGeneration === identity.presentationGeneration && this.reserved.refreshGeneration === identity.refreshGeneration
        ? this.reserved.expiresAtMs
        : undefined;
    const expiresAtMs = activeExpiry === undefined ? candidateExpiry : Math.min(activeExpiry, candidateExpiry);
    const render: ContextDashboardRenderState = { viewId: identity.dashboardId, revision: identity.revision, ownerKey: connection, title: page?.title ?? spec.title,
      state: spec.state === "partial" ? "ready" : spec.state, privacy: spec.privacy, components: renderedComponents,
      selectedAction: this.current?.dashboardId === identity.dashboardId ? this.current.render.selectedAction : 0,
      scrollOffset: page ? 0 : preservedOffset >= 0 ? preservedOffset : 0,
      expiresAtMs, dashboardId: identity.dashboardId, presentationGeneration: identity.presentationGeneration,
      refreshGeneration: identity.refreshGeneration, dashboardState: spec.state, contextIntent: intent,
      presentationLifetime: "temporary", pinned, pinState, announcement: spec.announcement,
      presentationMode, pageIndex: page ? pageIndex : 0, pageCount: pages?.length ?? 1, pageId: page?.id ?? "single",
      deckActionHandle: page?.action ? localActionHandle(page.action) : undefined, deckActionLabel: page?.action?.label,
      ...(atomicFinal ? { answerPresentation: "atomic-final-only" as const } : {}) };
    const pending = { ...identity, connectionKey: connection, turnKey: turn, cancelled: false };
    this.pending = pending;
    let receipt: Receipt;
    try { receipt = await this.deps.deliver(render, signal, () => !pending.cancelled && !signal?.aborted && (!isAllowed || isAllowed())); }
    catch { if (this.pending === pending) this.pending = null; return fail("glasses delivery was not acknowledged"); }
    if (this.pending === pending) this.pending = null;
    if (receipt.status !== "acknowledged" || !Number.isSafeInteger(receipt.frameId) || receipt.frameId <= 0 || pending.cancelled || signal?.aborted ||
        (isAllowed && !isAllowed()) || !this.deps.isDisplayAvailable()) {
      // cancelPending clears synchronously so a blocked delivery cannot remain
      // visible while its provider is stalled. Do not clear that exact pending
      // revision a second time when the stale delivery eventually settles.
      if (!pending.cancelled) this.deps.clear({ viewId: identity.dashboardId, revision: identity.revision });
      return fail("context dashboard became stale before acknowledged delivery");
    }
    this.current = { ...identity, connectionKey: connection, turnKey: turn, dashboardKey: spec.dashboard_key, intent, refreshPolicy, regeneration, pinned, spec: retainedSpec, render };
    if (this.reserved?.dashboardId === identity.dashboardId) this.reserved = null;
    this.scrubStaleSelectedIntents();
    if (this.timer !== null) this.clearTimer(this.timer);
    const exactIdentity = { dashboardId: identity.dashboardId, presentationGeneration: identity.presentationGeneration, refreshGeneration: identity.refreshGeneration, revision: identity.revision };
    this.timer = this.setTimer(() => { if (this.matches(exactIdentity)) this.closeCurrent(); }, Math.max(0, expiresAtMs - this.now()));
    return result({ status: "acknowledged", dashboard_id: identity.dashboardId, presentation_generation: identity.presentationGeneration, refresh_generation: identity.refreshGeneration, revision: identity.revision, frame_id: receipt.frameId });
  }

  handleInput(type: "scroll-up" | "scroll-down" | "click", foreground: boolean,
      identity?: { viewId: string; revision: number }): boolean {
    if (!foreground || !this.current || (identity &&
        (this.current.dashboardId !== identity.viewId || this.current.revision !== identity.revision))) return false;
    if (this.current.render.presentationMode === "deck") {
      const pages = pagesFor(this.current.spec, this.current.render.pinState, this.now());
      const currentIndex = Math.max(0, pages.findIndex((page) => page.id === this.current!.render.pageId));
      if (type === "scroll-up" || type === "scroll-down") {
        const nextIndex = Math.max(0, Math.min(pages.length - 1, currentIndex + (type === "scroll-down" ? 1 : -1)));
        if (nextIndex === currentIndex) return false;
        installDeckPage(this.current.render, pages[nextIndex]!, nextIndex, pages.length);
        return true;
      }
      const action = pages[currentIndex]?.action;
      if (!action) return false;
      if (action.kind === "pin") this.pinCurrent();
      else if (action.kind === "unpin") this.unpinCurrent();
      else return false;
      return true;
    }
    const actions = effectiveLocalActions(this.current.spec, this.current.render.pinState);
    if (type === "scroll-up") this.current.render.scrollOffset = Math.max(0, this.current.render.scrollOffset - 1);
    else if (type === "scroll-down") this.current.render.scrollOffset = Math.min(Math.max(0, this.current.render.components.length - 1), this.current.render.scrollOffset + 1);
    else {
      const focused = this.current.render.components[this.current.render.scrollOffset];
      const focusedHandle = focused?.type === "button" ? focused.action_handle : null;
      const action = focusedHandle ? actions.find((candidate) => localActionHandle(candidate) === focusedHandle) : undefined;
      if (!action) return false;
      if (action.kind === "pin") this.pinCurrent();
      else if (action.kind === "unpin") this.unpinCurrent();
      else if (this.events.length < 16) {
        this.events.push({ version: 2, event_id: `${this.current.dashboardId}.${this.current.presentationGeneration}.${++this.eventSequence}`,
          dashboard_id: this.current.dashboardId, presentation_generation: this.current.presentationGeneration, revision: this.current.revision,
          kind: action.kind, intent: this.current.intent, dashboard_key: this.current.dashboardKey, title: this.current.spec.title, privacy: this.current.spec.privacy,
          ...(action.kind === "section" ? { section_id: action.id } : {}) });
      }
      this.current.render.selectedAction = Math.max(0, actions.indexOf(action));
    }
    return true;
  }

  listPins(context?: ToolExecutionContext): ToolResult {
    if (!turnKey(context)) return fail("an exact even-g2 MCP turn is required to read pins");
    return result({ pins: this.pins.map((pin) => ({
      dashboard_key: pin.dashboard_key,
      title: pin.title,
      privacy: pin.privacy,
      refresh_policy: { ...pin.refresh_policy },
    })) });
  }
  readEvents(context: ToolExecutionContext | undefined, dashboardId: string, presentationGeneration: number, revision: number, afterEventId: string | null): ToolResult {
    const connection = connectionKey(context);
    if (!connection || !this.current || this.current.connectionKey !== connection || this.current.dashboardId !== dashboardId ||
        this.current.presentationGeneration !== presentationGeneration || revision < 1 || revision > this.current.revision) return fail("dashboard event owner or presentation is stale");
    if (afterEventId && !this.acknowledgedEvents.has(afterEventId)) return fail("dashboard event cursor is not acknowledged");
    return result({ dashboard_id: dashboardId, presentation_generation: presentationGeneration, revision, events: this.events.slice(0, 1) });
  }
  ackEvents(context: ToolExecutionContext | undefined, dashboardId: string, presentationGeneration: number, revision: number, eventId: string): ToolResult {
    const connection = connectionKey(context);
    if (!connection || !this.current || this.current.connectionKey !== connection || this.current.dashboardId !== dashboardId ||
        this.current.presentationGeneration !== presentationGeneration || revision < 1 || revision > this.current.revision ||
        typeof eventId !== "string" || eventId.length > 180) return fail("dashboard event owner or presentation is stale");
    if (this.acknowledgedEvents.has(eventId)) return result({ status: "historical_acknowledgement", through_event_id: eventId });
    if (this.events[0]?.event_id !== eventId) return fail("dashboard events must be acknowledged in queue order");
    if (this.events[0]?.revision !== revision) return fail("dashboard event revision is stale");
    this.events.shift(); this.acknowledgedEvents.add(eventId);
    while (this.acknowledgedEvents.size > 32) this.acknowledgedEvents.delete(this.acknowledgedEvents.values().next().value!);
    return result({ status: "acknowledged", through_event_id: eventId });
  }
  snapshot(): ContextDashboardRenderState | null { return this.current ? { ...this.current.render, components: this.current.render.components.map((component) => component.type === "list" ? { ...component, items: [...component.items] } : { ...component }) } : null; }
  closeConnection(context?: ToolExecutionContext): void {
    const connection = connectionKey(context);
    if (!connection) return;
    if (this.pending?.connectionKey === connection) this.cancelPending(this.pending);
    if (this.current?.connectionKey === connection) this.closeCurrent();
    if (this.reserved?.connectionKey === connection) this.closeReservation();
    for (const key of [...this.operations.keys()]) if (key.startsWith(`${connection}:`)) this.operations.delete(key);
    this.lastRefreshAt.clear();
  }
  closeView(viewId: string, revision: number): void {
    if (this.pending?.dashboardId === viewId && this.pending.revision === revision) {
      this.cancelPending(this.pending);
      if (this.current?.dashboardId === viewId) this.closeCurrent();
      return;
    }
    if (this.current?.dashboardId === viewId && this.current.revision === revision) this.closeCurrent();
  }

  private cancelPending(pending: Identity & { connectionKey: string; turnKey: string; cancelled: boolean }): void {
    if (pending.cancelled) return;
    pending.cancelled = true;
    this.deps.clear({ viewId: pending.dashboardId, revision: pending.revision });
  }

  private pinCurrent(): void {
    if (!this.current || this.current.regeneration !== "self_contained_intent" || this.current.spec.privacy === "sensitive" || this.pins.some((pin) => pin.dashboard_key === this.current!.dashboardKey) || this.pins.length >= 5) return;
    const next = [...this.pins, { dashboard_key: this.current.dashboardKey, title: this.current.spec.title,
      privacy: this.current.spec.privacy as "public" | "private", intent: this.current.intent, refresh_policy: { ...this.current.refreshPolicy } }];
    if (!this.persistPins(next)) { this.refreshPinRender("save_failed"); return; }
    this.pins.splice(0, this.pins.length, ...next);
    this.current.pinned = true;
    this.refreshPinRender();
  }
  private unpinCurrent(): void {
    if (!this.current) return;
    const index = this.pins.findIndex((pin) => pin.dashboard_key === this.current!.dashboardKey);
    if (index < 0) return;
    const next = this.pins.filter((_, candidateIndex) => candidateIndex !== index);
    if (!this.persistPins(next)) { this.refreshPinRender("unpin_failed"); return; }
    this.pins.splice(0, this.pins.length, ...next);
    this.current.pinned = false;
    this.refreshPinRender();
  }
  private refreshPinRender(failure?: "save_failed" | "unpin_failed"): void {
    if (!this.current) return;
    const focusedId = this.current.render.components[this.current.render.scrollOffset]?.id;
    const pageId = this.current.render.pageId;
    const pinState = failure ?? pinStateFor(this.current.spec, this.current.regeneration, this.current.pinned,
      this.current.pinned || this.pins.length < CONTEXT_DASHBOARD_CAPABILITIES.maxPinned);
    if (this.current.render.presentationMode === "deck") {
      const pages = pagesFor(this.current.spec, pinState, this.now());
      const pageIndex = Math.max(0, pages.findIndex((page) => page.id === pageId));
      installDeckPage(this.current.render, pages[pageIndex]!, pageIndex, pages.length);
      this.current.render.pinned = this.current.pinned;
      this.current.render.pinState = pinState;
      return;
    }
    this.current.render.components = componentsFor(this.current.spec, pinState, this.now());
    const preservedOffset = focusedId ? this.current.render.components.findIndex((component) => component.id === focusedId) : -1;
    this.current.render.scrollOffset = preservedOffset >= 0
      ? preservedOffset
      : Math.min(this.current.render.scrollOffset, Math.max(0, this.current.render.components.length - 1));
    this.current.render.pinned = this.current.pinned;
    this.current.render.pinState = pinState;
  }
  private persistPins(next: PinRecord[]): boolean {
    try {
      this.deps.savePins?.(next.map((pin) => ({ ...pin, refresh_policy: { ...pin.refresh_policy } })));
      return true;
    } catch {
      return false;
    }
  }
  private scrubStaleSelectedIntents(): void {
    for (const operation of this.operations.values()) {
      if (!operation.value.ok || !operation.value.content) continue;
      let receipt: unknown;
      try { receipt = JSON.parse(operation.value.content); } catch { continue; }
      if (!record(receipt) || typeof receipt.intent !== "string") continue;
      const selected = this.current ?? this.reserved;
      const exactSelection = Boolean(selected && selected.revision === 1 &&
        (receipt.status === "acknowledged" || receipt.status === "reserved") && receipt.dashboard_id === selected.dashboardId &&
        receipt.presentation_generation === selected.presentationGeneration &&
        receipt.refresh_generation === selected.refreshGeneration && receipt.revision === selected.revision);
      if (exactSelection) continue;
      delete receipt.intent;
      operation.value = result(receipt);
    }
  }
  private validatePins(value: unknown): PinRecord[] { if (!Array.isArray(value)) return []; const pins: PinRecord[] = []; const keys = new Set<string>(); for (const candidate of value.slice(0, 6)) { if (!record(candidate) || !exact(candidate, ["dashboard_key", "title", "privacy", "intent", "refresh_policy"]) || typeof candidate.dashboard_key !== "string" || !ID.test(candidate.dashboard_key) || keys.has(candidate.dashboard_key) || !text(candidate.title, 48, 192) || !["public", "private"].includes(String(candidate.privacy)) || !text(candidate.intent, 240, 960) || !validRefreshPolicy(candidate.refresh_policy)) return []; keys.add(candidate.dashboard_key); pins.push(candidate as PinRecord); } return pins.length <= 5 ? pins : []; }
  private matches(identity: Identity): boolean { return Boolean(this.current && this.current.dashboardId === identity.dashboardId && this.current.presentationGeneration === identity.presentationGeneration && this.current.refreshGeneration === identity.refreshGeneration && this.current.revision === identity.revision); }
  private reserve(spec: ContextDashboardSpec, identity: Identity, connection: string, turn: string, intent: string,
      refreshPolicy: RefreshPolicy, regeneration: RegenerationMode, pinned: boolean, signal?: AbortSignal,
      isAllowed?: () => boolean): ToolResult {
    if (signal?.aborted || (isAllowed && !isAllowed())) return fail("authorizing turn is no longer active");
    if (!this.deps.isDisplayAvailable()) return fail("glasses display is disconnected or unavailable");
    if (this.pending) this.cancelPending(this.pending);
    if (this.current) this.closeCurrent();
    if (this.reserved) this.closeReservation();
    const expiresAtMs = this.now() + spec.ttl_seconds * 1000;
    this.reserved = { ...identity, connectionKey: connection, turnKey: turn, dashboardKey: spec.dashboard_key,
      intent, refreshPolicy, regeneration, pinned, spec: cloneValidatedSpec(spec), expiresAtMs };
    if (this.timer !== null) this.clearTimer(this.timer);
    const exactIdentity = { ...identity };
    this.timer = this.setTimer(() => {
      if (this.reserved && this.reserved.dashboardId === exactIdentity.dashboardId &&
          this.reserved.presentationGeneration === exactIdentity.presentationGeneration &&
          this.reserved.refreshGeneration === exactIdentity.refreshGeneration && this.reserved.revision === exactIdentity.revision) {
        this.closeReservation();
      }
    }, Math.max(0, expiresAtMs - this.now()));
    return result({ status: "reserved", dashboard_id: identity.dashboardId, presentation_generation: identity.presentationGeneration,
      refresh_generation: identity.refreshGeneration, revision: identity.revision });
  }
  private closeReservation(): void {
    if (!this.reserved) return;
    this.reserved = null;
    this.scrubStaleSelectedIntents();
    if (this.timer !== null) { this.clearTimer(this.timer); this.timer = null; }
  }
  private closeCurrent(): void {
    if (!this.current) return;
    const current = this.current;
    // A publish/refresh delivery may still be blocked while the acknowledged
    // revision's TTL fires. Tombstone and clear that same-dashboard pending
    // revision before clearing current so its late receipt cannot reinstall a
    // presentation after expiry.
    if (this.pending?.connectionKey === current.connectionKey && this.pending.dashboardId === current.dashboardId) {
      this.cancelPending(this.pending);
    }
    const identity = { viewId: current.dashboardId, revision: current.revision };
    this.current = null;
    this.scrubStaleSelectedIntents();
    this.events.length = 0;
    this.acknowledgedEvents.clear();
    if (this.timer !== null) { this.clearTimer(this.timer); this.timer = null; }
    this.deps.clear(identity);
  }
}
