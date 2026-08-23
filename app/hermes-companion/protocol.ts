export const HERMES_COMPANION_PROTOCOL_VERSION = 1 as const;

export type HermesBackendStatus = "ready" | "degraded" | "unavailable";
export type HermesCompanionSupport = "unknown" | "supported" | "unsupported";
export type HermesSessionState = "active" | "completed" | "failed" | "cancelled";
export type HermesCaptureState = "idle" | "listening" | "processing" | "paused" | "unavailable";

export type HermesCompanionCapabilities = {
  voice: boolean;
  usage: boolean;
  cost: boolean;
  tool_activity: boolean;
};

export type HermesCompanionSession = {
  session_id: string;
  generation: number;
  title: string;
  state: HermesSessionState;
  updated_at_ms: number;
  resumable: boolean;
};

export type HermesVoiceSummary = {
  utterance_count: number;
  audio_ms: number;
  stt_provider: string;
  capture_state: HermesCaptureState;
  recent_failures: Array<{ id: string; at_ms: number; code: string; summary: string }>;
};

export type HermesUsagePeriod = {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cost_micros?: number;
  currency?: string;
};

export type HermesUsageSummary = {
  day: HermesUsagePeriod;
  seven_days: HermesUsagePeriod;
};

export type HermesToolActivity = {
  activity_id: string;
  label: string;
  status: "running" | "done" | "failed";
  updated_at_ms: number;
  error_code?: string;
};

export type HermesCompanionData = {
  status: HermesBackendStatus;
  model?: string;
  profile?: string;
  last_connected_at_ms?: number;
  capabilities: HermesCompanionCapabilities;
  sessions: HermesCompanionSession[];
  voice?: HermesVoiceSummary;
  usage?: HermesUsageSummary;
  tool_activity?: HermesToolActivity[];
  recent_errors: Array<{ id: string; at_ms: number; code: string; summary: string }>;
};

export type HermesCompanionServerFrame =
  | ({
      v: 1;
      chan: "companion";
      type: "snapshot";
      connection_generation: string;
      sequence: number;
      generated_at_ms: number;
    } & HermesCompanionData)
  | {
      v: 1;
      chan: "companion";
      type: "operation_receipt";
      connection_generation: string;
      sequence: number;
      operation_id: string;
      operation: HermesCompanionOperation;
      outcome: "accepted" | "rejected" | "duplicate" | "outcome_unknown";
      code?: string;
    };

export type HermesCompanionOperation =
  | "refresh"
  | "open_session"
  | "resume_session"
  | "cancel_session"
  | "new_voice_session";

type CommandBase<T extends HermesCompanionOperation> = {
  v: 1;
  chan: "companion";
  connection_generation: string;
  type: T;
  operation_id: string;
};

export type HermesCompanionClientCommand =
  | CommandBase<"refresh">
  | CommandBase<"new_voice_session">
  | (CommandBase<"open_session" | "resume_session" | "cancel_session"> & {
      session_id: string;
      generation: number;
    });

export type HermesCompanionProjection = {
  support: HermesCompanionSupport;
  synchronized: boolean;
  connectionGeneration: string | null;
  sequence: number;
  generatedAtMs: number | null;
  data: HermesCompanionData | null;
  pendingOperations: string[];
  lastReceipt: {
    operationId: string;
    operation: HermesCompanionOperation;
    outcome: "accepted" | "rejected" | "duplicate" | "outcome_unknown";
    code?: string;
  } | null;
};

const ID = /^[A-Za-z0-9._-]{12,128}$/;
const CONTROL_OR_MARKUP = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069<>`]/u;
const STATES = new Set<HermesSessionState>(["active", "completed", "failed", "cancelled"]);

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exact(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => key in value) && Object.keys(value).every((key) => allowed.has(key));
}

function uint(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function text(value: unknown, max: number, allowEmpty = false): value is string {
  return typeof value === "string" && (allowEmpty || value.trim().length > 0) &&
    Array.from(value).length <= max && !CONTROL_OR_MARKUP.test(value);
}

function id(value: unknown): value is string {
  return typeof value === "string" && ID.test(value);
}

function validCapabilities(value: unknown): value is HermesCompanionCapabilities {
  return record(value) && exact(value, ["voice", "usage", "cost", "tool_activity"]) &&
    [value.voice, value.usage, value.cost, value.tool_activity].every((item) => typeof item === "boolean") &&
    (!value.cost || value.usage === true);
}

function validSession(value: unknown): value is HermesCompanionSession {
  return record(value) && exact(value,
    ["session_id", "generation", "title", "state", "updated_at_ms", "resumable"]) &&
    id(value.session_id) && uint(value.generation) && text(value.title, 120) &&
    STATES.has(value.state as HermesSessionState) && uint(value.updated_at_ms) &&
    typeof value.resumable === "boolean" && (value.state !== "active" || value.resumable === false);
}

function validRedactedError(value: unknown): boolean {
  return record(value) && exact(value, ["id", "at_ms", "code", "summary"]) && id(value.id) &&
    uint(value.at_ms) && text(value.code, 64) && text(value.summary, 160);
}

function validVoice(value: unknown): value is HermesVoiceSummary {
  return record(value) && exact(value,
    ["utterance_count", "audio_ms", "stt_provider", "capture_state", "recent_failures"]) &&
    uint(value.utterance_count) && uint(value.audio_ms) && text(value.stt_provider, 80) &&
    ["idle", "listening", "processing", "paused", "unavailable"].includes(String(value.capture_state)) &&
    Array.isArray(value.recent_failures) && value.recent_failures.length <= 5 &&
    value.recent_failures.every(validRedactedError);
}

function validUsagePeriod(value: unknown, cost: boolean): value is HermesUsagePeriod {
  if (!record(value) || !exact(value, ["input_tokens", "output_tokens", "total_tokens"],
    cost ? ["cost_micros", "currency"] : [])) return false;
  if (![value.input_tokens, value.output_tokens, value.total_tokens].every(uint) ||
      value.total_tokens !== Number(value.input_tokens) + Number(value.output_tokens)) return false;
  if (!cost) return value.cost_micros === undefined && value.currency === undefined;
  return uint(value.cost_micros) && typeof value.currency === "string" && /^[A-Z]{3}$/.test(value.currency);
}

function validUsage(value: unknown, cost: boolean): value is HermesUsageSummary {
  return record(value) && exact(value, ["day", "seven_days"]) &&
    validUsagePeriod(value.day, cost) && validUsagePeriod(value.seven_days, cost);
}

function validActivity(value: unknown): value is HermesToolActivity {
  return record(value) && exact(value, ["activity_id", "label", "status", "updated_at_ms"], ["error_code"]) &&
    id(value.activity_id) && text(value.label, 100) && ["running", "done", "failed"].includes(String(value.status)) &&
    uint(value.updated_at_ms) && (value.error_code === undefined || text(value.error_code, 64));
}

function validSnapshot(value: Record<string, unknown>): boolean {
  if (!exact(value, ["v", "chan", "type", "connection_generation", "sequence", "generated_at_ms", "status",
    "capabilities", "sessions", "recent_errors"], ["model", "profile", "last_connected_at_ms", "voice", "usage", "tool_activity"])) return false;
  if (!id(value.connection_generation) || !uint(value.sequence) || !uint(value.generated_at_ms) ||
      !["ready", "degraded", "unavailable"].includes(String(value.status)) || !validCapabilities(value.capabilities) ||
      !Array.isArray(value.sessions) || value.sessions.length > 20 || !value.sessions.every(validSession) ||
      (value.model !== undefined && !text(value.model, 100)) || (value.profile !== undefined && !text(value.profile, 100)) ||
      (value.last_connected_at_ms !== undefined && !uint(value.last_connected_at_ms)) ||
      !Array.isArray(value.recent_errors) || value.recent_errors.length > 5 || !value.recent_errors.every(validRedactedError)) return false;
  const capabilities = value.capabilities as HermesCompanionCapabilities;
  if ((capabilities.voice ? !validVoice(value.voice) : value.voice !== undefined) ||
      (capabilities.usage ? !validUsage(value.usage, capabilities.cost) : value.usage !== undefined) ||
      (capabilities.tool_activity
        ? !Array.isArray(value.tool_activity) || value.tool_activity.length > 12 || !value.tool_activity.every(validActivity)
        : value.tool_activity !== undefined)) return false;
  const ids = new Set<string>();
  return value.sessions.every((item) => !ids.has(item.session_id) && Boolean(ids.add(item.session_id)));
}

export function validateHermesCompanionFrame(value: unknown): string | null {
  if (!record(value)) return "frame must be an object";
  let encoded = "";
  try { encoded = JSON.stringify(value); } catch { return "frame is not serializable"; }
  if (encoded.length > 48 * 1024) return "frame exceeds 48 KiB";
  if (value.v !== 1 || value.chan !== "companion" || typeof value.type !== "string" || !uint(value.sequence)) {
    return "invalid envelope";
  }
  if (value.type === "snapshot") return validSnapshot(value) ? null : "invalid snapshot";
  if (value.type !== "operation_receipt" || !exact(value,
    ["v", "chan", "type", "connection_generation", "sequence", "operation_id", "operation", "outcome"], ["code"])) {
    return "unknown or invalid frame type";
  }
  return id(value.connection_generation) && id(value.operation_id) &&
    ["refresh", "open_session", "resume_session", "cancel_session", "new_voice_session"].includes(String(value.operation)) &&
    ["accepted", "rejected", "duplicate", "outcome_unknown"].includes(String(value.outcome)) &&
    (value.code === undefined || text(value.code, 64)) ? null : "invalid operation receipt";
}

function cloneData(data: HermesCompanionData): HermesCompanionData {
  return {
    ...data,
    capabilities: { ...data.capabilities },
    sessions: data.sessions.map((session) => ({ ...session })),
    ...(data.voice ? { voice: { ...data.voice, recent_failures: data.voice.recent_failures.map((item) => ({ ...item })) } } : {}),
    ...(data.usage ? { usage: { day: { ...data.usage.day }, seven_days: { ...data.usage.seven_days } } } : {}),
    ...(data.tool_activity ? { tool_activity: data.tool_activity.map((item) => ({ ...item })) } : {}),
    recent_errors: data.recent_errors.map((item) => ({ ...item })),
  };
}

function defaultOperationId(): string {
  const bytes = new Uint8Array(16);
  const cryptoObject = (globalThis as any).crypto;
  if (!cryptoObject?.getRandomValues) throw new Error("secure operation identity is unavailable");
  cryptoObject.getRandomValues(bytes);
  let result = "operation_";
  for (const byte of bytes) result += byte.toString(16).padStart(2, "0");
  return result;
}

export class HermesCompanionStore {
  private support: HermesCompanionSupport = "unknown";
  private synchronized = false;
  private connectionGeneration: string | null = null;
  private sequence = 0;
  private generatedAtMs: number | null = null;
  private data: HermesCompanionData | null = null;
  private readonly pending = new Map<string, string>();
  private readonly operationKey = new Map<string, string>();
  private readonly completed = new Map<string, HermesCompanionOperation>();
  private lastReceipt: HermesCompanionProjection["lastReceipt"] = null;
  private readonly createOperationId: () => string;
  private readonly now: () => number;

  constructor(options: { createOperationId?: () => string; now?: () => number } = {}) {
    this.createOperationId = options.createOperationId ?? defaultOperationId;
    this.now = options.now ?? (() => Date.now());
  }

  snapshot(): HermesCompanionProjection {
    return {
      support: this.support,
      synchronized: this.synchronized,
      connectionGeneration: this.connectionGeneration,
      sequence: this.sequence,
      generatedAtMs: this.generatedAtMs,
      data: this.data ? cloneData(this.data) : null,
      pendingOperations: [...this.pending.keys()],
      lastReceipt: this.lastReceipt ? { ...this.lastReceipt } : null,
    };
  }

  markDisconnected(): void {
    this.support = "unknown";
    this.synchronized = false;
    this.connectionGeneration = null;
    this.pending.clear();
    this.operationKey.clear();
    this.completed.clear();
  }

  setSupported(supported: boolean): boolean {
    const next: HermesCompanionSupport = supported ? "supported" : "unsupported";
    if (this.support === next && (supported || (!this.synchronized && this.data === null))) return false;
    this.support = next;
    if (!supported) {
      this.synchronized = false;
      this.connectionGeneration = null;
      this.sequence = 0;
      this.generatedAtMs = null;
      this.data = null;
      this.pending.clear();
      this.operationKey.clear();
      this.completed.clear();
      this.lastReceipt = null;
    }
    return true;
  }

  apply(value: unknown): boolean {
    if (validateHermesCompanionFrame(value)) return false;
    const frame = value as HermesCompanionServerFrame;
    if (frame.type === "snapshot") {
      if (this.connectionGeneration === frame.connection_generation && frame.sequence <= this.sequence) return false;
      if (this.connectionGeneration !== frame.connection_generation) {
        this.pending.clear();
        this.operationKey.clear();
        this.completed.clear();
      }
      this.connectionGeneration = frame.connection_generation;
      this.support = "supported";
      this.sequence = frame.sequence;
      this.generatedAtMs = frame.generated_at_ms;
      const { v: _v, chan: _chan, type: _type, connection_generation: _generation,
        sequence: _sequence, generated_at_ms: _generated, ...data } = frame;
      this.data = cloneData(data);
      this.synchronized = true;
      return true;
    }
    if (this.synchronized && frame.connection_generation === this.connectionGeneration && frame.sequence === this.sequence &&
        this.completed.get(frame.operation_id) === frame.operation) return true;
    if (!this.synchronized || frame.connection_generation !== this.connectionGeneration || frame.sequence !== this.sequence + 1) {
      this.synchronized = false;
      return false;
    }
    const key = this.pending.get(frame.operation_id);
    if (!key && this.completed.get(frame.operation_id) === frame.operation) {
      this.sequence = frame.sequence;
      this.lastReceipt = { operationId: frame.operation_id, operation: frame.operation, outcome: frame.outcome,
        ...(frame.code ? { code: frame.code } : {}) };
      return true;
    }
    if (!key || frame.operation !== key.split(":", 1)[0]) {
      this.synchronized = false;
      return false;
    }
    this.pending.delete(frame.operation_id);
    this.operationKey.delete(key);
    this.completed.set(frame.operation_id, frame.operation);
    if (this.completed.size > 64) this.completed.delete(this.completed.keys().next().value!);
    this.sequence = frame.sequence;
    this.lastReceipt = { operationId: frame.operation_id, operation: frame.operation, outcome: frame.outcome,
      ...(frame.code ? { code: frame.code } : {}) };
    return true;
  }

  prepareRefresh(): HermesCompanionClientCommand | null {
    return this.prepare("refresh", "refresh", true);
  }

  prepareNewVoiceSession(): HermesCompanionClientCommand | null {
    if (!this.isFresh() || !this.data?.capabilities.voice) return null;
    return this.prepare("new_voice_session", "new_voice_session");
  }

  prepareOpen(sessionId: string, generation: number): HermesCompanionClientCommand | null {
    const session = this.liveSession(sessionId, generation);
    if (!session) return null;
    return this.prepareSession("open_session", session);
  }

  prepareResume(sessionId: string, generation: number): HermesCompanionClientCommand | null {
    const session = this.liveSession(sessionId, generation);
    if (!session || !session.resumable || session.state === "active") return null;
    return this.prepareSession("resume_session", session);
  }

  prepareCancel(sessionId: string, generation: number): HermesCompanionClientCommand | null {
    const session = this.liveSession(sessionId, generation);
    if (!session || session.state !== "active") return null;
    return this.prepareSession("cancel_session", session);
  }

  private liveSession(sessionId: string, generation: number): HermesCompanionSession | null {
    if (!this.isFresh() || !this.connectionGeneration || !this.data) return null;
    const session = this.data.sessions.find((item) => item.session_id === sessionId);
    return session?.generation === generation ? session : null;
  }

  private prepareSession(operation: "open_session" | "resume_session" | "cancel_session",
      session: HermesCompanionSession): HermesCompanionClientCommand | null {
    const command = this.prepare(operation, `${operation}:${session.session_id}:${session.generation}`);
    return command ? { ...command, session_id: session.session_id, generation: session.generation } as HermesCompanionClientCommand : null;
  }

  private prepare(operation: HermesCompanionOperation, key: string, allowDesynchronized = false): CommandBase<any> | null {
    if ((!this.synchronized && !allowDesynchronized) || !this.connectionGeneration || this.operationKey.has(key)) return null;
    const operationId = this.createOperationId();
    if (!id(operationId) || this.pending.has(operationId)) throw new Error("operation identity must be unique and opaque");
    this.pending.set(operationId, key);
    this.operationKey.set(key, operationId);
    return { v: 1, chan: "companion", connection_generation: this.connectionGeneration,
      type: operation, operation_id: operationId };
  }

  private isFresh(): boolean {
    if (!this.synchronized || this.generatedAtMs === null) return false;
    const now = this.now();
    return this.generatedAtMs <= now + 5 * 60_000 && now <= this.generatedAtMs + 2 * 60_000;
  }
}
