export const COCKPIT_PROTOCOL_VERSION = 1 as const;

export type CockpitSessionState =
  | "queued"
  | "running"
  | "waiting_human"
  | "interrupting"
  | "completed"
  | "failed"
  | "interrupted";

export type CockpitTimelineRow = {
  id: string;
  kind: "user" | "assistant" | "tool" | "status";
  text: string;
  status?: "running" | "done" | "failed";
};

export type CockpitQuestion = {
  request_id: string;
  nonce: string;
  kind: "question";
  title: string;
  expires_at_ms: number;
  choices: Array<{ id: string; label: string }>;
};

export type CockpitPermission = {
  request_id: string;
  nonce: string;
  kind: "permission";
  title: string;
  expires_at_ms: number;
  action: "read_file" | "write_file" | "network_request" | "other_bounded";
  target: string;
  effect: string;
  choices: Array<"deny" | "allow_once">;
};

export type CockpitInteraction = CockpitQuestion | CockpitPermission;

export type CockpitSession = {
  session_id: string;
  generation: number;
  revision: number;
  title: string;
  state: CockpitSessionState;
  updated_at_ms: number;
  summary?: string;
  timeline: CockpitTimelineRow[];
  pending: CockpitInteraction[];
};

export type CockpitServerFrame =
  | { v: 1; chan: "cockpit"; type: "snapshot"; sequence: number; sessions: CockpitSession[] }
  | { v: 1; chan: "cockpit"; type: "session_state"; sequence: number; session_id: string; generation: number;
      revision: number; state: CockpitSessionState; updated_at_ms: number; summary?: string }
  | { v: 1; chan: "cockpit"; type: "timeline_append"; sequence: number; session_id: string; generation: number;
      revision: number; row: CockpitTimelineRow }
  | { v: 1; chan: "cockpit"; type: "interaction_open"; sequence: number; session_id: string; generation: number;
      revision: number; request: CockpitInteraction }
  | { v: 1; chan: "cockpit"; type: "interaction_closed"; sequence: number; session_id: string; generation: number;
      revision: number; request_id: string; reason: "answered" | "answered_elsewhere" | "denied" | "expired" | "cancelled" }
  | { v: 1; chan: "cockpit"; type: "command_receipt"; sequence: number; command_id: string; session_id: string;
      generation: number; outcome: "accepted" | "rejected" | "duplicate" | "outcome_unknown"; code?: string };

export type CockpitClientCommand =
  | { v: 1; chan: "cockpit"; type: "answer"; command_id: string; session_id: string; generation: number;
      request_id: string; nonce: string; choice_id: string }
  | { v: 1; chan: "cockpit"; type: "permission_decide"; command_id: string; session_id: string; generation: number;
      request_id: string; nonce: string; decision: "deny" | "allow_once" }
  | { v: 1; chan: "cockpit"; type: "steer"; command_id: string; session_id: string; generation: number; text: string }
  | { v: 1; chan: "cockpit"; type: "interrupt"; command_id: string; session_id: string; generation: number };

export type CockpitSnapshot = {
  synchronized: boolean;
  sequence: number;
  sessions: CockpitSession[];
  lastReceipt: { commandId: string; outcome: string; code?: string } | null;
};

const ID = /^[A-Za-z0-9._-]{12,128}$/;
const STATES = new Set<CockpitSessionState>([
  "queued", "running", "waiting_human", "interrupting", "completed", "failed", "interrupted",
]);
const CONTROL_OR_MARKUP = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069<>`]/u;
const TERMINAL_STATES = new Set<CockpitSessionState>(["completed", "failed", "interrupted"]);

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

function text(value: unknown, max = 160, allowEmpty = false): value is string {
  return typeof value === "string" && (allowEmpty || value.trim().length > 0) && Array.from(value).length <= max &&
    !CONTROL_OR_MARKUP.test(value);
}

function id(value: unknown): value is string {
  return typeof value === "string" && ID.test(value);
}

function validTimelineRow(value: unknown): value is CockpitTimelineRow {
  if (!record(value) || !exact(value, ["id", "kind", "text"], ["status"])) return false;
  return id(value.id) && ["user", "assistant", "tool", "status"].includes(String(value.kind)) && text(value.text, 240) &&
    (value.status === undefined || ["running", "done", "failed"].includes(String(value.status)));
}

function validInteraction(value: unknown): value is CockpitInteraction {
  if (!record(value) || !id(value.request_id) || !id(value.nonce) || !text(value.title, 160) || !uint(value.expires_at_ms)) return false;
  if (value.kind === "question") {
    if (!exact(value, ["request_id", "nonce", "kind", "title", "expires_at_ms", "choices"]) ||
        !Array.isArray(value.choices) || value.choices.length < 1 || value.choices.length > 8) return false;
    const ids = new Set<string>();
    return value.choices.every((choice) => {
      if (!record(choice) || !exact(choice, ["id", "label"]) || !id(choice.id) || !text(choice.label, 120) || ids.has(choice.id)) return false;
      ids.add(choice.id);
      return true;
    });
  }
  if (value.kind !== "permission" || !exact(value,
    ["request_id", "nonce", "kind", "title", "expires_at_ms", "action", "target", "effect", "choices"])) return false;
  if (!["read_file", "write_file", "network_request", "other_bounded"].includes(String(value.action)) ||
      !text(value.target, 240) || !text(value.effect, 240) || !Array.isArray(value.choices)) return false;
  return value.choices[0] === "deny" &&
    (value.choices.length === 1 || (value.choices.length === 2 && value.choices[1] === "allow_once"));
}

function validSession(value: unknown): value is CockpitSession {
  if (!record(value) || !exact(value,
    ["session_id", "generation", "revision", "title", "state", "updated_at_ms", "timeline", "pending"], ["summary"])) return false;
  if (!id(value.session_id) || !uint(value.generation) || !uint(value.revision) || !text(value.title, 160) ||
      !STATES.has(value.state as CockpitSessionState) || !uint(value.updated_at_ms) ||
      (value.summary !== undefined && !text(value.summary, 240))) return false;
  if (!Array.isArray(value.timeline) || value.timeline.length > 40 || !value.timeline.every(validTimelineRow)) return false;
  if (!Array.isArray(value.pending) || value.pending.length > 8 || !value.pending.every(validInteraction)) return false;
  const requests = new Set<string>();
  return value.pending.every((request) => !requests.has(request.request_id) && Boolean(requests.add(request.request_id)));
}

export function validateCockpitFrame(value: unknown): string | null {
  if (!record(value)) return "frame must be an object";
  let encoded = "";
  try { encoded = JSON.stringify(value); } catch { return "frame is not serializable"; }
  if (encoded.length > 48 * 1024) return "frame exceeds 48 KiB";
  if (value.v !== 1 || value.chan !== "cockpit" || typeof value.type !== "string" || !uint(value.sequence)) return "invalid envelope";
  switch (value.type) {
    case "snapshot":
      return exact(value, ["v", "chan", "type", "sequence", "sessions"]) && Array.isArray(value.sessions) &&
        value.sessions.length <= 24 && value.sessions.every(validSession) ? null : "invalid snapshot";
    case "session_state":
      return exact(value, ["v", "chan", "type", "sequence", "session_id", "generation", "revision", "state", "updated_at_ms"], ["summary"]) &&
        id(value.session_id) && uint(value.generation) && uint(value.revision) && STATES.has(value.state as CockpitSessionState) &&
        uint(value.updated_at_ms) && (value.summary === undefined || text(value.summary, 240)) ? null : "invalid session state";
    case "timeline_append":
      return exact(value, ["v", "chan", "type", "sequence", "session_id", "generation", "revision", "row"]) &&
        id(value.session_id) && uint(value.generation) && uint(value.revision) && validTimelineRow(value.row) ? null : "invalid timeline event";
    case "interaction_open":
      return exact(value, ["v", "chan", "type", "sequence", "session_id", "generation", "revision", "request"]) &&
        id(value.session_id) && uint(value.generation) && uint(value.revision) && validInteraction(value.request) ? null : "invalid interaction";
    case "interaction_closed":
      return exact(value, ["v", "chan", "type", "sequence", "session_id", "generation", "revision", "request_id", "reason"]) &&
        id(value.session_id) && uint(value.generation) && uint(value.revision) && id(value.request_id) &&
        ["answered", "answered_elsewhere", "denied", "expired", "cancelled"].includes(String(value.reason)) ? null : "invalid interaction closure";
    case "command_receipt":
      return exact(value, ["v", "chan", "type", "sequence", "command_id", "session_id", "generation", "outcome"], ["code"]) &&
        id(value.command_id) && id(value.session_id) && uint(value.generation) &&
        ["accepted", "rejected", "duplicate", "outcome_unknown"].includes(String(value.outcome)) &&
        (value.code === undefined || text(value.code, 80)) ? null : "invalid command receipt";
    default:
      return "unknown frame type";
  }
}

function cloneSession(session: CockpitSession): CockpitSession {
  return {
    ...session,
    timeline: session.timeline.map((row) => ({ ...row })),
    pending: session.pending.map((request) => request.kind === "question"
      ? { ...request, choices: request.choices.map((choice) => ({ ...choice })) }
      : { ...request, choices: [...request.choices] }),
  };
}

function defaultCommandId(): string {
  const bytes = new Uint8Array(16);
  const cryptoObject = (globalThis as any).crypto;
  if (!cryptoObject?.getRandomValues) throw new Error("secure command identity is unavailable");
  cryptoObject.getRandomValues(bytes);
  let result = "command_";
  for (const byte of bytes) result += byte.toString(16).padStart(2, "0");
  return result;
}

export class AgentCockpitStore {
  private sessions = new Map<string, CockpitSession>();
  private synchronized = false;
  private sequence = 0;
  private lastReceipt: CockpitSnapshot["lastReceipt"] = null;
  private readonly submitted = new Set<string>();
  private readonly now: () => number;
  private readonly createCommandId: () => string;

  constructor(options: { now?: () => number; createCommandId?: () => string } = {}) {
    this.now = options.now ?? (() => Date.now());
    this.createCommandId = options.createCommandId ?? defaultCommandId;
  }

  snapshot(): CockpitSnapshot {
    return {
      synchronized: this.synchronized,
      sequence: this.sequence,
      sessions: [...this.sessions.values()].map(cloneSession),
      lastReceipt: this.lastReceipt ? { ...this.lastReceipt } : null,
    };
  }

  markDisconnected(): void {
    this.synchronized = false;
  }

  apply(value: unknown): boolean {
    const error = validateCockpitFrame(value);
    if (error) return false;
    const frame = value as CockpitServerFrame;
    if (frame.type === "snapshot") {
      const replacement = new Map<string, CockpitSession>();
      for (const session of frame.sessions) replacement.set(session.session_id, cloneSession(session));
      this.sessions = replacement;
      this.sequence = frame.sequence;
      this.synchronized = true;
      return true;
    }
    if (!this.synchronized || frame.sequence !== this.sequence + 1) {
      this.synchronized = false;
      return false;
    }
    if (frame.type === "command_receipt") {
      this.lastReceipt = { commandId: frame.command_id, outcome: frame.outcome, ...(frame.code ? { code: frame.code } : {}) };
      this.sequence = frame.sequence;
      return true;
    }
    const session = this.sessions.get(frame.session_id);
    if (!session || session.generation !== frame.generation || frame.revision <= session.revision) {
      this.synchronized = false;
      return false;
    }
    if (frame.type === "session_state") {
      session.state = frame.state;
      session.updated_at_ms = frame.updated_at_ms;
      if (frame.summary !== undefined) session.summary = frame.summary;
      if (TERMINAL_STATES.has(frame.state)) session.pending = [];
    } else if (frame.type === "timeline_append") {
      if (!session.timeline.some((row) => row.id === frame.row.id)) {
        session.timeline.push({ ...frame.row });
        if (session.timeline.length > 40) session.timeline.splice(0, session.timeline.length - 40);
      }
    } else if (frame.type === "interaction_open") {
      const prior = session.pending.findIndex((request) => request.request_id === frame.request.request_id);
      if (prior >= 0) session.pending[prior] = cloneSession({ ...session, pending: [frame.request] }).pending[0]!;
      else session.pending.push(cloneSession({ ...session, pending: [frame.request] }).pending[0]!);
    } else {
      session.pending = session.pending.filter((request) => request.request_id !== frame.request_id);
    }
    session.revision = frame.revision;
    this.sequence = frame.sequence;
    return true;
  }

  prepareAnswer(sessionId: string, generation: number, requestId: string, choiceId: string): CockpitClientCommand | null {
    const session = this.liveSession(sessionId, generation);
    const request = session?.pending.find((item): item is CockpitQuestion => item.request_id === requestId && item.kind === "question");
    if (!request || this.now() >= request.expires_at_ms || !request.choices.some((choice) => choice.id === choiceId)) return null;
    if (!this.reserve(requestId)) return null;
    return { v: 1, chan: "cockpit", type: "answer", command_id: this.createCommandId(), session_id: sessionId,
      generation, request_id: requestId, nonce: request.nonce, choice_id: choiceId };
  }

  preparePermissionDecision(sessionId: string, generation: number, requestId: string,
      decision: "deny" | "allow_once"): CockpitClientCommand | null {
    const session = this.liveSession(sessionId, generation);
    const request = session?.pending.find((item): item is CockpitPermission => item.request_id === requestId && item.kind === "permission");
    if (!request || this.now() >= request.expires_at_ms || !request.choices.includes(decision)) return null;
    if (!this.reserve(requestId)) return null;
    return { v: 1, chan: "cockpit", type: "permission_decide", command_id: this.createCommandId(), session_id: sessionId,
      generation, request_id: requestId, nonce: request.nonce, decision };
  }

  prepareSteer(sessionId: string, generation: number, value: string): CockpitClientCommand | null {
    const session = this.liveSession(sessionId, generation);
    if (!session || session.state !== "running" || !text(value, 500)) return null;
    return { v: 1, chan: "cockpit", type: "steer", command_id: this.createCommandId(), session_id: sessionId, generation, text: value };
  }

  prepareInterrupt(sessionId: string, generation: number): CockpitClientCommand | null {
    const session = this.liveSession(sessionId, generation);
    if (!session || !["running", "waiting_human"].includes(session.state)) return null;
    const key = `interrupt:${sessionId}:${generation}`;
    if (!this.reserve(key)) return null;
    return { v: 1, chan: "cockpit", type: "interrupt", command_id: this.createCommandId(), session_id: sessionId, generation };
  }

  private liveSession(sessionId: string, generation: number): CockpitSession | null {
    if (!this.synchronized) return null;
    const session = this.sessions.get(sessionId);
    return session?.generation === generation && !TERMINAL_STATES.has(session.state) ? session : null;
  }

  private reserve(key: string): boolean {
    if (this.submitted.has(key)) return false;
    this.submitted.add(key);
    return true;
  }
}
