import { createHash, randomBytes } from "node:crypto";

const STATES = new Set(["queued", "running", "waiting_human", "interrupting", "completed", "failed", "interrupted"]);
const ACTIONS = new Set(["read_file", "write_file", "network_request", "other_bounded"]);
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069<>`]/u;

function boundedText(value, max) {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069<>`]/gu, " ").trim();
  if (!normalized) return null;
  return Array.from(normalized).slice(0, max).join("");
}

function opaque(prefix, source = randomBytes(16).toString("hex")) {
  return `${prefix}_${createHash("sha256").update(String(source)).digest("base64url").slice(0, 22)}`;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

/**
 * Metadata-only projection between Hermes' authenticated TUI gateway RPC and
 * the existing private WSS bridge. This module deliberately has no logger and
 * never retains raw event objects, tool arguments/results, prompts, or secrets.
 */
export class HermesCockpitAdapter {
  #byPublic = new Map();
  #publicByHermes = new Map();
  #pending = new Map();
  #consumed = new Set();
  #sequence = 0;
  #connected = true;

  constructor(options = {}) {
    this.now = options.now ?? (() => Date.now());
    this.createOpaque = options.createOpaque ?? opaque;
  }

  share({ publicSessionId, hermesSessionId, generation, title }) {
    if (typeof publicSessionId !== "string" || typeof hermesSessionId !== "string" ||
        !Number.isSafeInteger(generation) || generation < 0) throw new Error("invalid explicit share");
    const old = this.#byPublic.get(publicSessionId);
    if (old && old.hermesSessionId !== hermesSessionId) this.#publicByHermes.delete(old.hermesSessionId);
    if (old && old.generation !== generation) this.#retirePending(publicSessionId);
    const session = {
      publicSessionId,
      hermesSessionId,
      generation,
      revision: (old?.revision ?? 0) + 1,
      title: boundedText(title, 160) ?? "Shared Hermes session",
      state: "running",
      updatedAtMs: this.now(),
      summary: null,
      timeline: old?.generation === generation ? old.timeline : [],
    };
    this.#byPublic.set(publicSessionId, session);
    this.#publicByHermes.set(hermesSessionId, publicSessionId);
    this.#connected = true;
    return this.#projectSession(session);
  }

  unshare(publicSessionId) {
    const session = this.#byPublic.get(publicSessionId);
    if (!session) return false;
    this.#byPublic.delete(publicSessionId);
    this.#publicByHermes.delete(session.hermesSessionId);
    this.#retirePending(publicSessionId);
    return true;
  }

  disconnect() {
    this.#connected = false;
  }

  observeSession(hermesSessionId, update) {
    const session = this.#sharedByHermes(hermesSessionId);
    if (!session) return null;
    if (STATES.has(update?.state)) session.state = update.state;
    else if (typeof update?.running === "boolean") session.state = update.running ? "running" : "completed";
    if (boundedText(update?.summary, 240)) session.summary = boundedText(update.summary, 240);
    session.updatedAtMs = this.now();
    session.revision++;
    if (["completed", "failed", "interrupted"].includes(session.state)) this.#retirePending(session.publicSessionId);
    return this.#sessionState(session);
  }

  snapshot() {
    this.#connected = true;
    return {
      v: 1,
      chan: "cockpit",
      type: "snapshot",
      sequence: ++this.#sequence,
      sessions: [...this.#byPublic.values()].map((session) => this.#projectSession(session)),
    };
  }

  ingest(event) {
    if (!event || typeof event !== "object" || typeof event.type !== "string") return null;
    const session = this.#sharedByHermes(event.session_id);
    if (!session) return null;
    const data = event.data && typeof event.data === "object" ? event.data : {};
    if (event.type === "reasoning.delta" || event.type === "thinking.delta") return null;
    if (event.type === "message.delta" || event.type === "message.complete") {
      const text = boundedText(data.text, 240);
      if (!text) return null;
      return this.#appendTimeline(session, "assistant", text, "done", event.type);
    }
    if (["tool.start", "tool.progress", "tool.complete"].includes(event.type)) {
      const name = boundedText(data.name, 80) ?? "tool";
      const status = event.type === "tool.start" || event.type === "tool.progress" ? "running" : data.error ? "failed" : "done";
      return this.#appendTimeline(session, "tool", `${name} · ${status}`, status, `${event.type}:${session.revision}`);
    }
    if (event.type === "clarify.request") return this.#openQuestion(session, data);
    if (event.type === "approval.request") return this.#openPermission(session, data);
    if (["clarify.expire", "approval.expire"].includes(event.type)) return this.#closeProviderRequest(session, data.request_id, "expired");
    if (event.type === "session.completed") return this.observeSession(event.session_id, { state: "completed", summary: data.summary });
    if (event.type === "session.failed") return this.observeSession(event.session_id, { state: "failed", summary: data.message });
    if (event.type === "session.interrupted") return this.observeSession(event.session_id, { state: "interrupted", summary: "Stopped" });
    return null;
  }

  handleCommand(command) {
    if (!this.#connected || !command || command.v !== 1 || command.chan !== "cockpit" || typeof command.command_id !== "string") return null;
    if (this.#consumed.has(command.command_id)) return null;
    const session = this.#byPublic.get(command.session_id);
    if (!session || session.generation !== command.generation || ["completed", "failed", "interrupted"].includes(session.state)) return null;

    let rpc = null;
    if (command.type === "answer" || command.type === "permission_decide") {
      const pending = this.#pending.get(command.request_id);
      if (!pending || pending.publicSessionId !== session.publicSessionId || pending.generation !== session.generation ||
          pending.nonce !== command.nonce || this.now() >= pending.expiresAtMs) return null;
      if (command.type === "answer") {
        if (pending.kind !== "question") return null;
        const answer = pending.choices.get(command.choice_id);
        if (!answer) return null;
        rpc = this.#rpc(command.command_id, "clarify.respond", {
          session_id: session.hermesSessionId, request_id: pending.providerRequestId, answer,
        });
      } else {
        if (pending.kind !== "permission" || !["deny", "allow_once"].includes(command.decision) ||
            (command.decision === "allow_once" && !pending.allowOnce)) return null;
        rpc = this.#rpc(command.command_id, "approval.respond", {
          session_id: session.hermesSessionId, request_id: pending.providerRequestId,
          choice: command.decision === "allow_once" ? "once" : "deny", all: false,
        });
      }
      this.#pending.delete(command.request_id);
    } else if (command.type === "steer") {
      const text = boundedText(command.text, 500);
      if (!text || session.state !== "running") return null;
      rpc = this.#rpc(command.command_id, "session.steer", { session_id: session.hermesSessionId, text });
    } else if (command.type === "interrupt") {
      if (!["running", "waiting_human"].includes(session.state)) return null;
      session.state = "interrupting";
      session.revision++;
      this.#retirePending(session.publicSessionId);
      rpc = this.#rpc(command.command_id, "session.interrupt", { session_id: session.hermesSessionId });
    }
    if (!rpc) return null;
    this.#consumed.add(command.command_id);
    return rpc;
  }

  #rpc(id, method, params) {
    return { jsonrpc: "2.0", id, method, params };
  }

  #sharedByHermes(hermesSessionId) {
    const publicId = this.#publicByHermes.get(hermesSessionId);
    return publicId ? this.#byPublic.get(publicId) ?? null : null;
  }

  #projectSession(session) {
    return {
      session_id: session.publicSessionId,
      generation: session.generation,
      revision: session.revision,
      title: session.title,
      state: session.state,
      updated_at_ms: session.updatedAtMs,
      ...(session.summary ? { summary: session.summary } : {}),
      timeline: session.timeline.map(clone),
      pending: [...this.#pending.values()]
        .filter((item) => item.publicSessionId === session.publicSessionId && item.generation === session.generation)
        .map((item) => clone(item.projected)),
    };
  }

  #sessionState(session) {
    return {
      v: 1, chan: "cockpit", type: "session_state", sequence: ++this.#sequence,
      session_id: session.publicSessionId, generation: session.generation, revision: session.revision,
      state: session.state, updated_at_ms: session.updatedAtMs,
      ...(session.summary ? { summary: session.summary } : {}),
    };
  }

  #appendTimeline(session, kind, text, status, source) {
    session.revision++;
    session.updatedAtMs = this.now();
    const row = { id: this.createOpaque("row", `${session.publicSessionId}:${session.generation}:${source}:${session.revision}`), kind, text, status };
    session.timeline.push(row);
    if (session.timeline.length > 40) session.timeline.splice(0, session.timeline.length - 40);
    return {
      v: 1, chan: "cockpit", type: "timeline_append", sequence: ++this.#sequence,
      session_id: session.publicSessionId, generation: session.generation, revision: session.revision, row: clone(row),
    };
  }

  #openQuestion(session, data) {
    const title = boundedText(data.question, 160);
    if (!title || typeof data.request_id !== "string" || !data.request_id ||
        this.#hasProviderRequest(session, data.request_id) || !Array.isArray(data.options) ||
        data.options.length < 1 || data.options.length > 8) return null;
    const labels = data.options.map((item) => boundedText(item, 120));
    if (labels.some((item) => !item)) return null;
    const publicRequestId = this.createOpaque("request", `${session.publicSessionId}:${session.generation}:${data.request_id}`);
    const nonce = this.createOpaque("nonce", `${publicRequestId}:${session.revision}`);
    const choices = new Map();
    const projectedChoices = labels.map((label, index) => {
      const choiceId = this.createOpaque("choice", `${publicRequestId}:${index}`);
      choices.set(choiceId, label);
      return { id: choiceId, label };
    });
    const projected = { request_id: publicRequestId, nonce, kind: "question", title,
      expires_at_ms: this.now() + 120_000, choices: projectedChoices };
    this.#pending.set(publicRequestId, { publicSessionId: session.publicSessionId, generation: session.generation,
      providerRequestId: String(data.request_id), nonce, kind: "question", choices, expiresAtMs: projected.expires_at_ms, projected });
    session.state = "waiting_human";
    return this.#interactionFrame(session, projected);
  }

  #openPermission(session, data) {
    if (typeof data.request_id !== "string" || !data.request_id || this.#hasProviderRequest(session, data.request_id)) return null;
    const scope = data.cockpit_scope && typeof data.cockpit_scope === "object" ? data.cockpit_scope : null;
    const supported = scope && ACTIONS.has(scope.action) && scope.action !== "other_bounded" &&
      boundedText(scope.target, 240) && boundedText(scope.effect, 240);
    const publicRequestId = this.createOpaque("request", `${session.publicSessionId}:${session.generation}:${data.request_id}`);
    const nonce = this.createOpaque("nonce", `${publicRequestId}:${session.revision}`);
    const projected = supported ? {
      request_id: publicRequestId, nonce, kind: "permission", title: "Exact permission request",
      expires_at_ms: this.now() + 60_000, action: scope.action, target: boundedText(scope.target, 240),
      effect: boundedText(scope.effect, 240), choices: ["deny", "allow_once"],
    } : {
      request_id: publicRequestId, nonce, kind: "permission", title: "Unsupported permission scope",
      expires_at_ms: this.now() + 60_000, action: "other_bounded", target: "Scope unavailable",
      effect: "This request can only be denied on the glasses", choices: ["deny"],
    };
    this.#pending.set(publicRequestId, { publicSessionId: session.publicSessionId, generation: session.generation,
      providerRequestId: data.request_id, nonce, kind: "permission", allowOnce: Boolean(supported),
      expiresAtMs: projected.expires_at_ms, projected });
    session.state = "waiting_human";
    return this.#interactionFrame(session, projected);
  }

  #interactionFrame(session, projected) {
    session.revision++;
    session.updatedAtMs = this.now();
    return { v: 1, chan: "cockpit", type: "interaction_open", sequence: ++this.#sequence,
      session_id: session.publicSessionId, generation: session.generation, revision: session.revision,
      request: clone(projected) };
  }

  #closeProviderRequest(session, providerRequestId, reason) {
    const found = [...this.#pending.entries()].find(([, item]) =>
      item.publicSessionId === session.publicSessionId && item.providerRequestId === providerRequestId);
    if (!found) return null;
    this.#pending.delete(found[0]);
    session.revision++;
    return { v: 1, chan: "cockpit", type: "interaction_closed", sequence: ++this.#sequence,
      session_id: session.publicSessionId, generation: session.generation, revision: session.revision,
      request_id: found[0], reason };
  }

  #retirePending(publicSessionId) {
    for (const [id, item] of this.#pending) if (item.publicSessionId === publicSessionId) this.#pending.delete(id);
  }

  #hasProviderRequest(session, providerRequestId) {
    return [...this.#pending.values()].some((item) => item.publicSessionId === session.publicSessionId &&
      item.generation === session.generation && item.providerRequestId === providerRequestId);
  }
}
