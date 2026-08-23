import { createHash, randomBytes } from "node:crypto";

const ID = /^[A-Za-z0-9._-]{12,128}$/;
const SAFE_CODE = /^[A-Za-z0-9._-]{1,64}$/;
const CONTROL_OR_MARKUP = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069<>`]/u;
const SESSION_OPERATIONS = new Set(["open_session", "resume_session", "cancel_session"]);
const OPERATIONS = new Set(["refresh", ...SESSION_OPERATIONS, "new_voice_session"]);

const clone = (value) => structuredClone(value);
const uint = (value) => Number.isSafeInteger(value) && value >= 0;
const boundedText = (value, max) => typeof value === "string" && value.trim() &&
  Array.from(value).length <= max && !CONTROL_OR_MARKUP.test(value) ? value.trim() : null;
const safeCode = (value, fallback) => typeof value === "string" && SAFE_CODE.test(value) ? value : fallback;
const opaque = (prefix = "opaque") => `${prefix}_${randomBytes(16).toString("base64url")}`;

function exact(value, required, optional = []) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => key in value) && Object.keys(value).every((key) => allowed.has(key));
}

function validCommand(command) {
  if (!command || command.v !== 1 || command.chan !== "companion" || !ID.test(command.operation_id ?? "") ||
      !ID.test(command.connection_generation ?? "") || !OPERATIONS.has(command.type)) return false;
  if (SESSION_OPERATIONS.has(command.type)) {
    return exact(command, ["v", "chan", "connection_generation", "type", "operation_id", "session_id", "generation"]) &&
      ID.test(command.session_id ?? "") && uint(command.generation);
  }
  return exact(command, ["v", "chan", "connection_generation", "type", "operation_id"]);
}

/**
 * A metadata-only boundary between a private Hermes loopback gateway and the
 * phone companion protocol. Provider IDs remain in private maps; human text is
 * projected only when the provider explicitly marks it redacted.
 */
export class HermesCompanionAdapter {
  #connectionGeneration = null;
  #sequence = 0;
  #voiceAvailable = false;
  #publicByHermes = new Map();
  #sessionByPublic = new Map();
  #journal = new Map();

  constructor(options = {}) {
    this.now = options.now ?? (() => Date.now());
    this.createOpaque = options.createOpaque ?? opaque;
    this.reserveOperation = options.reserveOperation ?? (() => true);
    for (const record of options.journal ?? []) {
      if (record && typeof record.operationId === "string") this.#journal.set(record.operationId, clone(record));
    }
  }

  connect(connectionGeneration) {
    if (typeof connectionGeneration !== "string" || !ID.test(connectionGeneration)) {
      throw new Error("invalid companion connection generation");
    }
    this.#connectionGeneration = connectionGeneration;
    this.#sequence = 0;
    this.#voiceAvailable = false;
    this.#sessionByPublic.clear();
  }

  disconnect() {
    this.#connectionGeneration = null;
    this.#voiceAvailable = false;
    this.#sessionByPublic.clear();
  }

  authoritativeSnapshot(raw) {
    if (!this.#validAuthoritativeSnapshot(raw)) return null;
    return this.snapshot(raw);
  }

  snapshot(raw = {}) {
    if (!this.#connectionGeneration) return null;
    const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    const claimed = source.capabilities && typeof source.capabilities === "object" ? source.capabilities : {};
    const usage = claimed.usage === true ? this.#usage(source.usage, claimed.cost === true) : null;
    const capabilities = {
      voice: claimed.voice === true,
      usage: Boolean(usage),
      cost: Boolean(usage?.cost),
      tool_activity: claimed.tool_activity === true,
    };
    this.#voiceAvailable = capabilities.voice;
    const sessions = [];
    const seen = new Set();
    for (const item of Array.isArray(source.sessions) ? source.sessions.slice(0, 20) : []) {
      if (!item || typeof item !== "object" || typeof item.id !== "string" || !item.id ||
          Array.from(item.id).length > 512 || CONTROL_OR_MARKUP.test(item.id) ||
          !uint(item.generation) || !uint(item.updated_at_ms) || seen.has(item.id)) continue;
      seen.add(item.id);
      let publicId = this.#publicByHermes.get(item.id);
      if (!publicId) {
        publicId = this.#opaque("session", item.id);
        this.#publicByHermes.set(item.id, publicId);
      }
      const state = ["active", "completed", "failed", "cancelled"].includes(item.state) ? item.state : "failed";
      const projected = {
        session_id: publicId,
        generation: item.generation,
        title: item.title_redacted === true ? boundedText(item.title, 120) ?? "Hermes session" : "Hermes session",
        state,
        updated_at_ms: item.updated_at_ms,
        resumable: state !== "active" && item.resumable === true,
      };
      sessions.push(projected);
      this.#sessionByPublic.set(publicId, { hermesId: item.id, generation: item.generation, state, resumable: projected.resumable });
    }
    for (const [publicId, value] of this.#sessionByPublic) {
      if (!seen.has(value.hermesId)) this.#sessionByPublic.delete(publicId);
    }
    // No historical provider identity is needed once it leaves the current
    // authoritative projection. Pruning also bounds a gateway that rotates
    // private session IDs over the lifetime of this process.
    for (const hermesId of this.#publicByHermes.keys()) {
      if (!seen.has(hermesId)) this.#publicByHermes.delete(hermesId);
    }
    const metadataAllowed = source.metadata_redacted === true;
    const voice = capabilities.voice ? this.#voice(source.voice, metadataAllowed) : null;
    const toolActivity = capabilities.tool_activity ? this.#activity(source.tool_activity) : null;
    return {
      v: 1,
      chan: "companion",
      type: "snapshot",
      connection_generation: this.#connectionGeneration,
      sequence: ++this.#sequence,
      generated_at_ms: this.now(),
      status: ["ready", "degraded", "unavailable"].includes(source.status) ? source.status : "unavailable",
      ...(metadataAllowed && boundedText(source.model, 100) ? { model: boundedText(source.model, 100) } : {}),
      ...(metadataAllowed && boundedText(source.profile, 100) ? { profile: boundedText(source.profile, 100) } : {}),
      ...(uint(source.last_connected_at_ms) ? { last_connected_at_ms: source.last_connected_at_ms } : {}),
      capabilities,
      sessions,
      ...(voice ? { voice } : {}),
      ...(usage ? { usage: { day: usage.day, seven_days: usage.seven_days } } : {}),
      ...(toolActivity ? { tool_activity: toolActivity } : {}),
      recent_errors: this.#errors(source.recent_errors, "Hermes error"),
    };
  }

  unavailableSnapshot() {
    return this.snapshot({ status: "unavailable", capabilities: { voice: false, usage: false, cost: false, tool_activity: false },
      sessions: [], recent_errors: [] });
  }

  handleCommand(command, dispatch) {
    if (typeof dispatch !== "function" || this.preDispatchRejection(command) !== null) return null;
    const binding = SESSION_OPERATIONS.has(command.type) ? this.#sessionByPublic.get(command.session_id) : null;

    const params = command.type === "refresh" ? this.snapshotParams()
      : command.type === "new_voice_session" ? { input_mode: "voice" }
      : { session_id: binding.hermesId, expected_generation: binding.generation };
    const method = {
      refresh: "companion.snapshot",
      open_session: "session.open",
      resume_session: "session.resume",
      cancel_session: "session.cancel",
      new_voice_session: "session.create",
    }[command.type];
    const rpc = { jsonrpc: "2.0", id: command.operation_id, method, params };

    // Revalidate the socket and session authority at the synchronous dispatch
    // boundary, after projection and immediately before durable reservation.
    if (this.preDispatchRejection(command) !== null ||
        (binding && this.#sessionByPublic.get(command.session_id) !== binding)) return null;
    const record = this.#reserve(command);
    if (!record) return null;
    try {
      const result = dispatch(rpc);
      // An in-process gateway can answer synchronously from dispatch; never
      // downgrade a completion that operationReceipt already recorded.
      if (record.status === "reserved") record.status = result === true ? "dispatched" : "outcome_unknown";
      return result === true;
    } catch {
      if (record.status === "reserved") record.status = "outcome_unknown";
      return null;
    }
  }

  reserveRejection(command) {
    if (!validCommand(command) || command.connection_generation !== this.#connectionGeneration) return false;
    return Boolean(this.#reserve(command));
  }

  /**
   * Returns null when a valid current command may dispatch, a bounded rejection
   * code for a valid but stale/unsupported command, and undefined when the frame
   * is malformed, retired, or already reserved.
   */
  preDispatchRejection(command) {
    if (!validCommand(command) || command.connection_generation !== this.#connectionGeneration ||
        this.#journal.has(command.operation_id)) return undefined;
    if (command.type === "new_voice_session" && !this.#voiceAvailable) return "voice_unavailable";
    if (!SESSION_OPERATIONS.has(command.type)) return null;
    const binding = this.#sessionByPublic.get(command.session_id);
    if (!binding || binding.generation !== command.generation) return "stale_session";
    if (command.type === "resume_session" && (binding.state === "active" || !binding.resumable)) {
      return "session_not_resumable";
    }
    if (command.type === "cancel_session" && binding.state !== "active") return "session_not_active";
    return null;
  }

  operationReceipt(command, outcome, code) {
    if (!validCommand(command) || command.connection_generation !== this.#connectionGeneration ||
        !["accepted", "rejected", "duplicate", "outcome_unknown"].includes(outcome)) return null;
    const record = this.#journal.get(command.operation_id);
    if (record) { record.status = "complete"; record.outcome = outcome; }
    return this.#receipt(command, outcome, code);
  }

  replayReceipt(command) {
    if (!validCommand(command) || command.connection_generation !== this.#connectionGeneration) return null;
    const record = this.#journal.get(command.operation_id);
    if (!record || record.fingerprint !== createHash("sha256").update(JSON.stringify(command)).digest("hex")) return null;
    return this.#receipt(command, record.outcome ?? "outcome_unknown",
      record.outcome ? "duplicate" : "reserved_before_restart");
  }

  exportJournal() { return [...this.#journal.values()].map(clone); }
  snapshotParams() { return { limits: { sessions: 20, tool_activity: 12, errors: 5 }, redacted: true }; }

  #receipt(command, outcome, code) {
    return { v: 1, chan: "companion", type: "operation_receipt",
      connection_generation: this.#connectionGeneration, sequence: ++this.#sequence,
      operation_id: command.operation_id, operation: command.type, outcome,
      ...(code ? { code: safeCode(code, "operation_failed") } : {}) };
  }

  #reserve(command) {
    if (this.#journal.has(command.operation_id)) return null;
    const record = { operationId: command.operation_id,
      fingerprint: createHash("sha256").update(JSON.stringify(command)).digest("hex"), status: "reserved" };
    if (this.reserveOperation(clone(record)) !== true) return null;
    this.#journal.set(command.operation_id, record);
    return record;
  }

  #validAuthoritativeSnapshot(value) {
    if (!value || typeof value !== "object" || Array.isArray(value) ||
        !["ready", "degraded", "unavailable"].includes(value.status) ||
        !value.capabilities || typeof value.capabilities !== "object" || Array.isArray(value.capabilities) ||
        !Array.isArray(value.sessions) || !Array.isArray(value.recent_errors)) return false;
    return ["voice", "usage", "cost", "tool_activity"]
      .every((capability) => typeof value.capabilities[capability] === "boolean");
  }

  #voice(value, metadataAllowed) {
    const source = value && typeof value === "object" ? value : {};
    return { utterance_count: uint(source.utterance_count) ? source.utterance_count : 0,
      audio_ms: uint(source.audio_ms) ? source.audio_ms : 0,
      stt_provider: metadataAllowed ? boundedText(source.stt_provider, 80) ?? "Unavailable" : "Unavailable",
      capture_state: ["idle", "listening", "processing", "paused", "unavailable"].includes(source.capture_state)
        ? source.capture_state : "unavailable",
      recent_failures: this.#errors(source.recent_failures, "Voice operation failed") };
  }

  #usage(value, claimedCost) {
    if (!value || typeof value !== "object") return null;
    const period = (item) => {
      if (!item || !uint(item.input_tokens) || !uint(item.output_tokens)) return null;
      const total = item.input_tokens + item.output_tokens;
      if (!Number.isSafeInteger(total)) return null;
      return { input_tokens: item.input_tokens, output_tokens: item.output_tokens,
        total_tokens: total };
    };
    const day = period(value.day), sevenDays = period(value.seven_days);
    if (!day || !sevenDays) return null;
    const currency = boundedText(value.currency, 3)?.toUpperCase();
    const cost = claimedCost && uint(value.day.cost_micros) && uint(value.seven_days.cost_micros) &&
      typeof currency === "string" && /^[A-Z]{3}$/.test(currency);
    if (cost) {
      day.cost_micros = value.day.cost_micros; day.currency = currency;
      sevenDays.cost_micros = value.seven_days.cost_micros; sevenDays.currency = currency;
    }
    return { day, seven_days: sevenDays, cost };
  }

  #activity(value) {
    const result = [];
    for (const item of Array.isArray(value) ? value.slice(0, 12) : []) {
      if (!item || typeof item !== "object" || !uint(item.updated_at_ms)) continue;
      result.push({ activity_id: this.#opaque("activity", String(item.id ?? result.length)),
        label: item.redacted === true ? boundedText(item.label, 100) ?? "Tool activity" : "Tool activity",
        status: ["running", "done", "failed"].includes(item.status) ? item.status : "failed",
        updated_at_ms: item.updated_at_ms,
        ...(item.status === "failed" ? { error_code: safeCode(item.error_code, "tool_failed") } : {}) });
    }
    return result;
  }

  #errors(value, fallback) {
    const result = [];
    for (const item of Array.isArray(value) ? value.slice(0, 5) : []) {
      if (!item || typeof item !== "object" || !uint(item.at_ms)) continue;
      result.push({ id: this.#opaque("error", String(item.id ?? result.length)), at_ms: item.at_ms,
        code: safeCode(item.code, "provider_error"),
        summary: item.redacted === true ? boundedText(item.summary, 160) ?? fallback : fallback });
    }
    return result;
  }

  #opaque(prefix, source) {
    const value = this.createOpaque(prefix, source);
    if (!ID.test(value ?? "")) throw new Error("opaque companion identity is invalid");
    return value;
  }
}
