export const COCKPIT_PROTOCOL_VERSION = 1 as const;
/**
 * 640x480 Cockpit geometry leaves a 580 px body. Both shipped 12 px fonts use
 * at most 8 px for a printable ASCII glyph, so the eight-character labels
 * plus 64 detail scalars are guaranteed to render in full on one line.
 */
export const COCKPIT_PERMISSION_DETAIL_MAX_SCALARS = 64;
export const COCKPIT_REVIEW_TEXT_MAX_SCALARS = 64;
export const COCKPIT_TEXT_QUESTION_MAX_SCALARS = COCKPIT_REVIEW_TEXT_MAX_SCALARS;

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

export type CockpitTextQuestion = {
  request_id: string;
  nonce: string;
  kind: "text_question";
  title: string;
  expires_at_ms: number;
  max_length: number;
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

export type CockpitInteraction = CockpitQuestion | CockpitTextQuestion | CockpitPermission;

export function cockpitInteractionFingerprint(request: CockpitInteraction): string {
  if (request.kind === "question") {
    return JSON.stringify([request.kind, request.request_id, request.nonce, request.title,
      request.expires_at_ms, request.choices.map((choice) => [choice.id, choice.label])]);
  }
  if (request.kind === "text_question") {
    return JSON.stringify([request.kind, request.request_id, request.nonce, request.title,
      request.expires_at_ms, request.max_length]);
  }
  return JSON.stringify([request.kind, request.request_id, request.nonce, request.title,
    request.expires_at_ms, request.action, request.target, request.effect, request.choices]);
}

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
  | { v: 1; chan: "cockpit"; type: "snapshot"; connection_generation: string; sequence: number; sessions: CockpitSession[] }
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
  | { v: 1; chan: "cockpit"; connection_generation: string; type: "answer"; command_id: string; session_id: string; generation: number;
      request_id: string; nonce: string; choice_id: string }
  | { v: 1; chan: "cockpit"; connection_generation: string; type: "answer_text"; command_id: string; session_id: string; generation: number;
      request_id: string; nonce: string; text: string }
  | { v: 1; chan: "cockpit"; connection_generation: string; type: "permission_decide"; command_id: string; session_id: string; generation: number;
      request_id: string; nonce: string; decision: "deny" | "allow_once" }
  | { v: 1; chan: "cockpit"; connection_generation: string; type: "steer"; command_id: string; session_id: string; generation: number; text: string }
  | { v: 1; chan: "cockpit"; connection_generation: string; type: "interrupt"; command_id: string; session_id: string; generation: number };

export type CockpitCommandOutcome = {
  commandId: string;
  sessionId: string;
  generation: number;
  outcome: "accepted" | "rejected" | "duplicate" | "outcome_unknown";
  code?: string;
};

export type CockpitSnapshot = {
  synchronized: boolean;
  /** Host status may expose the projection while temporarily denying mutations. */
  commandsAvailable: boolean;
  connectionGeneration: string | null;
  sequence: number;
  sessions: CockpitSession[];
  lastReceipt: CockpitCommandOutcome | null;
};

type IssuedCommand = {
  connectionGeneration: string;
  sessionId: string;
  generation: number;
  reservationKey: string | null;
};

type AwaitingSnapshotCommand = IssuedCommand & {
  /** Receipt sequence proves a snapshot is not older than the terminal receipt. */
  minimumSequence: number | null;
  /** Synthetic outcomes require a resource read begun after that outcome. */
  minimumSnapshotReadEpoch: number | null;
};

const ID = /^[A-Za-z0-9._-]{12,128}$/;
const STATES = new Set<CockpitSessionState>([
  "queued", "running", "waiting_human", "interrupting", "completed", "failed", "interrupted",
]);
const CONTROL_OR_MARKUP = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069<>`]/u;
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

function permissionDetail(value: unknown): value is string {
  return text(value, COCKPIT_PERMISSION_DETAIL_MAX_SCALARS) && /^[\u0020-\u007e]+$/u.test(value);
}

function reviewText(value: unknown): value is string {
  return text(value, COCKPIT_REVIEW_TEXT_MAX_SCALARS) && /^[\u0020-\u007e]+$/u.test(value);
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
  if (!record(value) || !id(value.request_id) || !id(value.nonce) || !reviewText(value.title) || !uint(value.expires_at_ms)) return false;
  if (value.kind === "question") {
    if (!exact(value, ["request_id", "nonce", "kind", "title", "expires_at_ms", "choices"]) ||
        !Array.isArray(value.choices) || value.choices.length < 1 || value.choices.length > 8) return false;
    const ids = new Set<string>();
    return value.choices.every((choice) => {
      if (!record(choice) || !exact(choice, ["id", "label"]) || !id(choice.id) || !reviewText(choice.label) || ids.has(choice.id)) return false;
      ids.add(choice.id);
      return true;
    });
  }
  if (value.kind === "text_question") {
    return exact(value, ["request_id", "nonce", "kind", "title", "expires_at_ms", "max_length"]) &&
      Number.isSafeInteger(value.max_length) && Number(value.max_length) >= 1 &&
      Number(value.max_length) <= COCKPIT_TEXT_QUESTION_MAX_SCALARS;
  }
  if (value.kind !== "permission" || !exact(value,
    ["request_id", "nonce", "kind", "title", "expires_at_ms", "action", "target", "effect", "choices"])) return false;
  if (!["read_file", "write_file", "network_request", "other_bounded"].includes(String(value.action)) ||
      !permissionDetail(value.target) || !permissionDetail(value.effect) || !Array.isArray(value.choices)) return false;
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

function validSnapshotSessions(value: unknown): value is CockpitSession[] {
  if (!Array.isArray(value) || value.length > 8 || !value.every(validSession)) return false;
  const ids = new Set<string>();
  return value.every((session) => !ids.has(session.session_id) && Boolean(ids.add(session.session_id)));
}

export function validateCockpitFrame(value: unknown): string | null {
  if (!record(value)) return "frame must be an object";
  let encoded = "";
  try { encoded = JSON.stringify(value); } catch { return "frame is not serializable"; }
  if (encoded.length > 48 * 1024) return "frame exceeds 48 KiB";
  if (value.v !== 1 || value.chan !== "cockpit" || typeof value.type !== "string" || !uint(value.sequence)) return "invalid envelope";
  switch (value.type) {
    case "snapshot":
      return exact(value, ["v", "chan", "type", "connection_generation", "sequence", "sessions"]) &&
        id(value.connection_generation) && validSnapshotSessions(value.sessions) ? null : "invalid snapshot";
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
    timeline: session.timeline.filter((row) => row.kind !== "tool").map((row) => ({ ...row })),
    pending: session.pending.map((request) => request.kind === "question"
      ? { ...request, choices: request.choices.map((choice) => ({ ...choice })) }
      : request.kind === "text_question"
        ? { ...request }
        : { ...request, choices: [...request.choices] }),
  };
}

function sameSessionProjection(
  left: Map<string, CockpitSession>,
  right: Map<string, CockpitSession>,
): boolean {
  if (left.size !== right.size) return false;
  const ordered = (source: Map<string, CockpitSession>) => [...source.entries()]
    .sort(([leftId], [rightId]) => leftId.localeCompare(rightId))
    .map(([, value]) => value);
  return JSON.stringify(ordered(left)) === JSON.stringify(ordered(right));
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
  private commandsAvailable = false;
  private connectionGeneration: string | null = null;
  /** Retained while offline so a delayed same-generation snapshot cannot reset sequence. */
  private lastSnapshotConnectionGeneration: string | null = null;
  private lastSnapshotSequence = 0;
  private sequence = 0;
  private lastReceipt: CockpitSnapshot["lastReceipt"] = null;
  /** Connection binding is private so retired receipts never leak into a replacement projection. */
  private lastReceiptConnectionGeneration: string | null = null;
  private readonly submitted = new Set<string>();
  /** Commands created by this exact store, retained until a terminal transport outcome. */
  private readonly issuedCommands = new Map<string, IssuedCommand>();
  /** One-shot reservations are released only after a later authoritative snapshot. */
  private readonly awaitingSnapshot = new Map<string, AwaitingSnapshotCommand>();
  private readonly now: () => number;
  private readonly createCommandId: () => string;

  constructor(options: { now?: () => number; createCommandId?: () => string } = {}) {
    this.now = options.now ?? (() => Date.now());
    this.createCommandId = options.createCommandId ?? defaultCommandId;
  }

  snapshot(): CockpitSnapshot {
    return {
      synchronized: this.synchronized,
      commandsAvailable: this.commandsAvailable,
      connectionGeneration: this.connectionGeneration,
      sequence: this.sequence,
      sessions: [...this.sessions.values()].map(cloneSession),
      lastReceipt: this.lastReceipt ? { ...this.lastReceipt } : null,
    };
  }

  markDisconnected(): void {
    this.synchronized = false;
    this.connectionGeneration = null;
  }

  setCommandsAvailable(available: boolean): boolean {
    if (this.commandsAvailable === available) return false;
    this.commandsAvailable = available;
    return true;
  }

  apply(value: unknown, snapshotReadEpoch?: number): boolean {
    const error = validateCockpitFrame(value);
    if (error) return false;
    const frame = value as CockpitServerFrame;
    if (frame.type === "snapshot") {
      if (snapshotReadEpoch !== undefined && !uint(snapshotReadEpoch)) return false;
      const sameSnapshotGeneration = this.lastSnapshotConnectionGeneration === frame.connection_generation;
      if (sameSnapshotGeneration && frame.sequence < this.sequence) {
        this.synchronized = false;
        return false;
      }
      const replacement = new Map<string, CockpitSession>();
      for (const session of frame.sessions) replacement.set(session.session_id, cloneSession(session));
      // An equal-sequence reread is useful proof for an unknown outcome, but it
      // cannot carry a different projection without violating snapshot
      // immutability. Accept an identical one as a no-op; fail closed otherwise.
      if (sameSnapshotGeneration && frame.sequence === this.lastSnapshotSequence &&
          !sameSessionProjection(replacement, this.sessions)) {
        this.synchronized = false;
        return false;
      }
      this.reconcileSnapshot(frame, snapshotReadEpoch);
      this.sessions = replacement;
      this.connectionGeneration = frame.connection_generation;
      this.lastSnapshotConnectionGeneration = frame.connection_generation;
      this.lastSnapshotSequence = frame.sequence;
      this.sequence = frame.sequence;
      this.synchronized = true;
      return true;
    }
    if (frame.type === "command_receipt") {
      // A tool response is already correlated to one exact request by the Host
      // MCP client. It can arrive after a newer resource snapshot, or can skip
      // projection sequence numbers changed while the backend dispatch awaited.
      // Record that terminal command outcome without pretending skipped state
      // is synchronized; a full snapshot repairs any gap.
      if (!this.recordCommandOutcome({
        commandId: frame.command_id,
        sessionId: frame.session_id,
        generation: frame.generation,
        outcome: frame.outcome,
        ...(frame.code ? { code: frame.code } : {}),
      }, { minimumSequence: frame.sequence })) return false;
      if (!this.synchronized || frame.sequence > this.sequence + 1) {
        this.sequence = Math.max(this.sequence, frame.sequence);
        this.synchronized = false;
        return false;
      }
      if (frame.sequence > this.sequence) this.sequence = frame.sequence;
      return true;
    }
    if (!this.synchronized || frame.sequence !== this.sequence + 1) {
      this.synchronized = false;
      return false;
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
      if (frame.row.kind !== "tool" && !session.timeline.some((row) => row.id === frame.row.id)) {
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

  prepareAnswer(sessionId: string, generation: number, requestId: string, choiceId: string,
      reviewedNonce: string, reviewedFingerprint: string): CockpitClientCommand | null {
    const session = this.liveSession(sessionId, generation);
    const request = session?.pending.find((item): item is CockpitQuestion => item.request_id === requestId && item.kind === "question");
    if (!request || request.nonce !== reviewedNonce || cockpitInteractionFingerprint(request) !== reviewedFingerprint ||
        this.now() >= request.expires_at_ms || !request.choices.some((choice) => choice.id === choiceId)) return null;
    if (!this.reserve(requestId)) return null;
    const commandId = this.createCommandId();
    if (!id(commandId)) { this.submitted.delete(requestId); return null; }
    return this.issue({ v: 1, chan: "cockpit", connection_generation: this.connectionGeneration!, type: "answer", command_id: commandId, session_id: sessionId,
      generation, request_id: requestId, nonce: request.nonce, choice_id: choiceId }, requestId);
  }

  preparePermissionDecision(sessionId: string, generation: number, requestId: string,
      decision: "deny" | "allow_once", reviewedNonce: string, reviewedFingerprint: string): CockpitClientCommand | null {
    const session = this.liveSession(sessionId, generation);
    const request = session?.pending.find((item): item is CockpitPermission => item.request_id === requestId && item.kind === "permission");
    if (!request || request.nonce !== reviewedNonce || cockpitInteractionFingerprint(request) !== reviewedFingerprint ||
        this.now() >= request.expires_at_ms || !request.choices.includes(decision)) return null;
    if (!this.reserve(requestId)) return null;
    const commandId = this.createCommandId();
    if (!id(commandId)) { this.submitted.delete(requestId); return null; }
    return this.issue({ v: 1, chan: "cockpit", connection_generation: this.connectionGeneration!, type: "permission_decide", command_id: commandId, session_id: sessionId,
      generation, request_id: requestId, nonce: request.nonce, decision }, requestId);
  }

  prepareAnswerText(sessionId: string, generation: number, requestId: string, value: string,
      reviewedNonce: string, reviewedFingerprint: string): CockpitClientCommand | null {
    const session = this.liveSession(sessionId, generation);
    const request = session?.pending.find((item): item is CockpitTextQuestion =>
      item.request_id === requestId && item.kind === "text_question");
    if (!request || request.nonce !== reviewedNonce || cockpitInteractionFingerprint(request) !== reviewedFingerprint ||
        this.now() >= request.expires_at_ms || !reviewText(value) ||
        Array.from(value).length > request.max_length) return null;
    if (!this.reserve(requestId)) return null;
    const commandId = this.createCommandId();
    if (!id(commandId)) { this.submitted.delete(requestId); return null; }
    return this.issue({ v: 1, chan: "cockpit", connection_generation: this.connectionGeneration!, type: "answer_text",
      command_id: commandId, session_id: sessionId, generation, request_id: requestId, nonce: request.nonce, text: value }, requestId);
  }

  prepareSteer(sessionId: string, generation: number, value: string): CockpitClientCommand | null {
    const session = this.liveSession(sessionId, generation);
    if (!session || session.state !== "running" || !reviewText(value)) return null;
    const commandId = this.createCommandId();
    if (!id(commandId)) return null;
    return this.issue({ v: 1, chan: "cockpit", connection_generation: this.connectionGeneration!, type: "steer", command_id: commandId, session_id: sessionId, generation, text: value }, null);
  }

  prepareInterrupt(sessionId: string, generation: number): CockpitClientCommand | null {
    const session = this.liveSession(sessionId, generation);
    if (!session || !["running", "waiting_human"].includes(session.state)) return null;
    const key = `interrupt:${sessionId}:${generation}`;
    if (!this.reserve(key)) return null;
    const commandId = this.createCommandId();
    if (!id(commandId)) { this.submitted.delete(key); return null; }
    return this.issue({ v: 1, chan: "cockpit", connection_generation: this.connectionGeneration!, type: "interrupt", command_id: commandId, session_id: sessionId, generation }, key);
  }

  /** Release only an intent proven not to have entered the transport. */
  releaseUnsent(command: CockpitClientCommand): boolean {
    const issued = this.issuedCommands.get(command.command_id);
    if (!issued || issued.connectionGeneration !== command.connection_generation ||
        issued.sessionId !== command.session_id || issued.generation !== command.generation) return false;
    this.issuedCommands.delete(command.command_id);
    if (issued.reservationKey !== null) this.submitted.delete(issued.reservationKey);
    return true;
  }

  /** Record one terminal outcome correlated to a command issued by this store. */
  recordCommandOutcome(
    outcome: CockpitCommandOutcome,
    reconciliation: { minimumSequence?: number; minimumSnapshotReadEpoch?: number } = {},
  ): boolean {
    const issued = this.issuedCommands.get(outcome.commandId);
    if (!issued || issued.sessionId !== outcome.sessionId || issued.generation !== outcome.generation ||
        !["accepted", "rejected", "duplicate", "outcome_unknown"].includes(outcome.outcome) ||
        (outcome.code !== undefined && !text(outcome.code, 80)) ||
        (reconciliation.minimumSequence !== undefined && !uint(reconciliation.minimumSequence)) ||
        (reconciliation.minimumSnapshotReadEpoch !== undefined && !uint(reconciliation.minimumSnapshotReadEpoch))) return false;
    this.issuedCommands.delete(outcome.commandId);
    if (issued.reservationKey !== null) this.awaitingSnapshot.set(outcome.commandId, {
      ...issued,
      minimumSequence: reconciliation.minimumSequence ?? null,
      minimumSnapshotReadEpoch: reconciliation.minimumSnapshotReadEpoch ?? null,
    });
    this.lastReceipt = { ...outcome };
    this.lastReceiptConnectionGeneration = issued.connectionGeneration;
    return true;
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

  private issue(command: CockpitClientCommand, reservationKey: string | null): CockpitClientCommand | null {
    if (this.issuedCommands.has(command.command_id) || this.awaitingSnapshot.has(command.command_id)) {
      if (reservationKey !== null) this.submitted.delete(reservationKey);
      return null;
    }
    this.issuedCommands.set(command.command_id, {
      connectionGeneration: command.connection_generation,
      sessionId: command.session_id,
      generation: command.generation,
      reservationKey,
    });
    return command;
  }

  private reconcileSnapshot(
    frame: Extract<CockpitServerFrame, { type: "snapshot" }>,
    snapshotReadEpoch?: number,
  ): void {
    if (this.lastReceiptConnectionGeneration !== null &&
        this.lastReceiptConnectionGeneration !== frame.connection_generation) {
      this.lastReceipt = null;
      this.lastReceiptConnectionGeneration = null;
    }
    // A new Host MCP generation can never produce a receipt for commands
    // bound to the retired generation. The replacement snapshot is therefore
    // the boundary at which their local identities and one-shot guards retire.
    for (const [commandId, issued] of this.issuedCommands) {
      if (issued.connectionGeneration === frame.connection_generation) continue;
      this.issuedCommands.delete(commandId);
      if (issued.reservationKey !== null) this.submitted.delete(issued.reservationKey);
    }
    // Terminal receipts (including synthetic outcome_unknown after a timeout
    // or disconnect) do not themselves unlock a repeated mutation. A snapshot
    // requested after that outcome confirms the server's current state; only
    // then may the same still-live interaction be explicitly reviewed again.
    for (const [commandId, issued] of this.awaitingSnapshot) {
      const replacementGeneration = issued.connectionGeneration !== frame.connection_generation;
      const receiptSequenceSatisfied = issued.minimumSequence !== null &&
        frame.sequence >= issued.minimumSequence;
      const postOutcomeReadSatisfied = issued.minimumSnapshotReadEpoch !== null &&
        snapshotReadEpoch !== undefined && snapshotReadEpoch >= issued.minimumSnapshotReadEpoch;
      if (!replacementGeneration && !receiptSequenceSatisfied && !postOutcomeReadSatisfied) continue;
      this.awaitingSnapshot.delete(commandId);
      if (issued.reservationKey !== null) this.submitted.delete(issued.reservationKey);
    }
  }
}
