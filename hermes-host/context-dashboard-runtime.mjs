const ID = /^[A-Za-z0-9._-]{1,64}$/;
const SAFE_TEXT = /^[^\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069<>`]+$/u;

function boundedText(value, max) {
  if (typeof value !== "string") throw new Error("bounded inert text is required");
  const trimmed = value.trim();
  if (!trimmed || Array.from(trimmed).length > max || !SAFE_TEXT.test(trimmed) || /(?:[a-z][a-z0-9+.-]*:\/\/|www\.)/iu.test(trimmed)) {
    throw new Error("bounded inert text is required");
  }
  return trimmed;
}

function exactIdentity(identity) {
  if (!identity || identity.profile !== "even-g2" || !boundedText(identity.device, 64) || !boundedText(identity.connectionGeneration, 128) || !boundedText(identity.turnGeneration, 128)) {
    throw new Error("context dashboards are restricted to the dedicated even-g2 profile and an exact live identity");
  }
  return JSON.stringify([identity.profile, identity.device, identity.connectionGeneration, identity.turnGeneration]);
}

function timeLabel(epochMs) {
  return new Date(epochMs).toISOString().slice(11, 16);
}

function derivedOperationId(base, suffix) {
  return `${base.slice(0, 64 - suffix.length)}${suffix}`;
}

function normalizeDeparture(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.id !== "string" || !ID.test(value.id) ||
      !Number.isSafeInteger(value.scheduledDepartureMs) || value.scheduledDepartureMs < 0 ||
      (value.expectedDepartureMs !== undefined && (!Number.isSafeInteger(value.expectedDepartureMs) || value.expectedDepartureMs < 0)) ||
      !["on_time", "delayed", "cancelled", "unknown", "departed"].includes(value.status)) throw new Error("invalid departure data");
  return {
    id: value.id,
    destination: boundedText(value.destination, 40),
    scheduled_departure_ms: value.scheduledDepartureMs,
    ...(value.expectedDepartureMs === undefined ? {} : { expected_departure_ms: value.expectedDepartureMs }),
    status: value.status,
    ...(value.platform === undefined ? {} : { platform: boundedText(String(value.platform), 8) }),
  };
}

/** Typed, deterministic acceptance projector for the mandatory Liverpool Lime Street prompt. */
export function projectLiverpoolLimeStreetDepartures(input) {
  if (!input || input.stationName !== "Liverpool Lime Street" || !Array.isArray(input.departures) ||
      !Number.isSafeInteger(input.observedAtMs) || !Number.isSafeInteger(input.nowMs)) throw new Error("invalid Liverpool Lime Street departure response");
  const sourceLabel = boundedText(input.sourceLabel, 40);
  const rows = input.departures.map(normalizeDeparture)
    .filter((row) => row.status !== "departed" && (row.expected_departure_ms ?? row.scheduled_departure_ms) >= input.nowMs)
    .sort((left, right) => (left.expected_departure_ms ?? left.scheduled_departure_ms) - (right.expected_departure_ms ?? right.scheduled_departure_ms) ||
      left.scheduled_departure_ms - right.scheduled_departure_ms || left.destination.localeCompare(right.destination) || left.id.localeCompare(right.id))
    .slice(0, 12);
  const first = rows[0];
  const summary = first
    ? { primary: `Next: ${timeLabel(first.expected_departure_ms ?? first.scheduled_departure_ms)} ${first.destination}`,
        secondary: first.status === "cancelled" ? "This service is cancelled" : first.status === "delayed" ? "Delayed" : first.status === "unknown" ? "Expected time unknown" : "Expected on time",
        tone: first.status === "cancelled" ? "critical" : first.status === "delayed" ? "warning" : "neutral", uncertainty: first.status === "unknown" ? "unknown" : "exact" }
    : { primary: "No upcoming departures found", secondary: "The source returned no future services", tone: "neutral", uncertainty: "exact" };
  const spokenStatus = !first ? "no upcoming departures were found." : first.status === "cancelled" ? "this service is cancelled." : first.status === "delayed" ? "it is delayed." : first.status === "unknown" ? "its expected time is unknown." : "expected on time.";
  return {
    version: 2,
    dashboard_key: "rail-liverpool-lime-street",
    title: "Liverpool Lime Street",
    state: rows.length ? "ready" : "empty",
    privacy: "private",
    summary,
    sections: [{ id: "departures", order: 0, type: "departures", title: "All destinations", load_state: rows.length ? "ready" : "empty",
      source_ids: ["rail"], uncertainty: rows.some((row) => row.status === "unknown") ? "unknown" : "exact", rows }],
    sources: [{ id: "rail", label: sourceLabel, observed_at_ms: input.observedAtMs, stale_after_seconds: 120,
      status: input.nowMs - input.observedAtMs <= 120_000 ? "current" : "stale" }],
    local_actions: [
      { id: "refresh", kind: "refresh", label: "Refresh", enabled: true },
      { id: "pin", kind: "pin", label: "Pin", enabled: true },
      { id: "follow-up", kind: "follow_up", label: "Ask follow-up", enabled: true },
    ],
    announcement: { id: `rail-${input.observedAtMs}`, text: first
      ? `Liverpool Lime Street: next is the ${timeLabel(first.expected_departure_ms ?? first.scheduled_departure_ms)} to ${first.destination}, ${spokenStatus}`
      : `Liverpool Lime Street: ${spokenStatus}`, policy: "once_when_useful" },
    ttl_seconds: 300,
  };
}

function normalizedFailure({ dashboardKey, title, privacy, code, now }) {
  return {
    version: 2, dashboard_key: dashboardKey, title, state: code === "offline" ? "offline" : "error", privacy,
    summary: { primary: "Current information is unavailable", secondary: "Try refresh when the source is available", tone: "warning", uncertainty: "unknown" },
    sections: [{ id: "results", order: 0, type: "message", load_state: "error", source_ids: ["source"], uncertainty: "unknown", error_code: code, body: "No useful current data was received" }],
    sources: [{ id: "source", label: "Authorised sources", observed_at_ms: now, stale_after_seconds: 30, status: "unavailable" }],
    local_actions: [{ id: "refresh", kind: "refresh", label: "Refresh", enabled: true }], ttl_seconds: 60,
  };
}

/** Dedicated-profile router: ordinary questions select only trusted read-only adapters. */
export class ContextDashboardAgent {
  #runtime;
  #readers;
  #adapters;

  constructor({ runtime, readers, adapters = [] }) {
    if (!runtime?.open || !readers?.railDepartures || !Array.isArray(adapters)) throw new Error("context dashboard agent adapters are required");
    this.#runtime = runtime;
    this.#readers = readers;
    this.#adapters = [...adapters];
  }

  async handleQuestion(identity, question) {
    exactIdentity(identity);
    const intent = boundedText(question, 240);
    if (/^when is the next train at liverpool lime street\??$/iu.test(intent)) {
      return this.#runtime.open(identity, {
        operationId: `rail-${Date.now().toString(36)}`,
        dashboardKey: "rail-liverpool-lime-street",
        title: "Liverpool Lime Street",
        privacy: "private",
        intent,
        refreshPolicy: { mode: "on_visible", min_interval_seconds: 60 },
        gather: async ({ signal } = {}) => {
          const response = await this.#readers.railDepartures({ station: "Liverpool Lime Street", allDestinations: true, signal });
          return { ...response, stationName: "Liverpool Lime Street", sourceLabel: response.sourceLabel ?? "Rail departures",
            observedAtMs: response.observedAtMs ?? Date.now(), nowMs: response.nowMs ?? Date.now() };
        },
        project: projectLiverpoolLimeStreetDepartures,
      });
    }
    for (const adapter of this.#adapters) {
      if (typeof adapter?.matches !== "function" || typeof adapter?.options !== "function" || !adapter.matches(intent)) continue;
      return this.#runtime.open(identity, adapter.options(intent));
    }
    return null;
  }
}

/** Hermes-hosted read-only dashboard lifecycle; all data gatherers are trusted profile-local adapters. */
export class ContextDashboardRuntime {
  #phone;
  #now;
  #deadlineMs;
  #active = null;

  constructor({ phone, now = Date.now, usefulDeadlineMs = 5_000 }) {
    if (!phone?.callTool) throw new Error("phone MCP client is required");
    this.#phone = phone;
    this.#now = now;
    this.#deadlineMs = usefulDeadlineMs;
  }

  async open(identity, options) {
    const owner = exactIdentity(identity);
    if (!options || typeof options.operationId !== "string" || !ID.test(options.operationId) || typeof options.dashboardKey !== "string" || !ID.test(options.dashboardKey) ||
        typeof options.gather !== "function" || typeof options.project !== "function" || !options.refreshPolicy || !["manual", "on_visible"].includes(options.refreshPolicy.mode) ||
        !Number.isInteger(options.refreshPolicy.min_interval_seconds) || options.refreshPolicy.min_interval_seconds < 30) throw new Error("invalid contextual dashboard request");
    if (options.signal?.aborted) throw new Error("contextual dashboard request was cancelled");
    const request = {
      operation_id: options.operationId, dashboard_key: options.dashboardKey, title: boundedText(options.title, 48), privacy: options.privacy,
      intent: boundedText(options.intent, 240), refresh_policy: { mode: options.refreshPolicy.mode, min_interval_seconds: options.refreshPolicy.min_interval_seconds }, ttl_seconds: 300,
    };
    const prior = this.#active;
    if (prior) prior.cancelled = true;
    const active = { owner, cancelled: false, startedAtMs: this.#now(), request };
    this.#active = active;
    const begin = await this.#phone.callTool("glasses.context_dashboard.begin", request, { signal: options.signal });
    if (this.#active !== active || active.cancelled) throw new Error("stale contextual dashboard open");
    if (begin?.status !== "acknowledged" || typeof begin.dashboard_id !== "string" || !Number.isSafeInteger(begin.presentation_generation) || !Number.isSafeInteger(begin.refresh_generation) || begin.revision !== 1) throw new Error("phone did not acknowledge loading dashboard");
    active.identity = begin;
    active.loadingAckMs = Math.max(0, this.#now() - active.startedAtMs);

    let timer;
    const gatherController = new AbortController();
    const abortGather = () => gatherController.abort();
    options.signal?.addEventListener("abort", abortGather, { once: true });
    let spec;
    try {
      const timeout = new Promise((_, reject) => { timer = setTimeout(() => { reject(new Error("deadline")); gatherController.abort(); }, this.#deadlineMs); });
      const raw = await Promise.race([Promise.resolve().then(() => options.gather({ signal: gatherController.signal })), timeout]);
      if (this.#active !== active || active.cancelled || options.signal?.aborted) throw new Error("stale contextual dashboard gather");
      spec = options.project(raw);
    } catch (error) {
      if (this.#active !== active || active.cancelled || options.signal?.aborted) throw new Error("stale contextual dashboard gather");
      const code = error instanceof Error && error.message === "deadline" ? "timeout" : "unavailable";
      spec = normalizedFailure({ dashboardKey: options.dashboardKey, title: request.title, privacy: options.privacy, code, now: this.#now() });
    } finally {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", abortGather);
    }
    return this.#publish(active, options.operationId, spec);
  }

  async refreshFromLocalEvent(identity, event, options) {
    const owner = exactIdentity(identity);
    if (!event || event.version !== 2 || event.kind !== "refresh" || typeof event.event_id !== "string" || event.event_id.length > 180 ||
        typeof event.dashboard_id !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(event.dashboard_id) || !Number.isSafeInteger(event.presentation_generation) ||
        !Number.isSafeInteger(event.revision) || typeof event.dashboard_key !== "string" || !ID.test(event.dashboard_key) ||
        !["public", "private", "sensitive"].includes(event.privacy) || !options || typeof options.operationId !== "string" || !ID.test(options.operationId) ||
        typeof options.gather !== "function" || typeof options.project !== "function") throw new Error("invalid local read-only refresh event");
    const intent = boundedText(event.intent, 240);
    const title = boundedText(event.title, 48);
    if (options.signal?.aborted) throw new Error("local dashboard refresh was cancelled");
    const prior = this.#active;
    if (prior) prior.cancelled = true;
    const active = { owner, cancelled: false, startedAtMs: this.#now(), request: { intent } };
    this.#active = active;
    const refreshed = await this.#phone.callTool("glasses.context_dashboard.start_refresh", {
      operation_id: options.operationId, dashboard_id: event.dashboard_id, presentation_generation: event.presentation_generation,
      expected_revision: event.revision,
    }, { signal: options.signal });
    if (this.#active !== active || active.cancelled || refreshed?.status !== "acknowledged" || refreshed.dashboard_id !== event.dashboard_id ||
        refreshed.presentation_generation !== event.presentation_generation || refreshed.refresh_generation < 2 || refreshed.revision !== event.revision + 1) {
      throw new Error("phone did not acknowledge current local refresh");
    }
    active.identity = refreshed;
    active.loadingAckMs = Math.max(0, this.#now() - active.startedAtMs);
    const gatherController = new AbortController();
    const abortGather = () => gatherController.abort();
    options.signal?.addEventListener("abort", abortGather, { once: true });
    let timer;
    let spec;
    try {
      const timeout = new Promise((_, reject) => { timer = setTimeout(() => { reject(new Error("deadline")); gatherController.abort(); }, this.#deadlineMs); });
      const raw = await Promise.race([options.gather({ intent, signal: gatherController.signal }), timeout]);
      if (this.#active !== active || active.cancelled || options.signal?.aborted) throw new Error("stale local refresh gather");
      spec = options.project(raw);
    } catch (error) {
      if (this.#active !== active || active.cancelled || options.signal?.aborted) throw new Error("stale local refresh gather");
      spec = normalizedFailure({ dashboardKey: event.dashboard_key, title, privacy: event.privacy,
        code: error instanceof Error && error.message === "deadline" ? "timeout" : "unavailable", now: this.#now() });
    } finally {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", abortGather);
    }
    const receipt = await this.#publish(active, options.operationId, spec);
    const acknowledgement = await this.#phone.callTool("glasses.context_dashboard.ack_events", {
      dashboard_id: event.dashboard_id, presentation_generation: event.presentation_generation, revision: event.revision,
      through_event_id: event.event_id,
    }, { signal: options.signal });
    if (acknowledgement?.status !== "acknowledged" && acknowledgement?.status !== "historical_acknowledgement") {
      throw new Error("phone did not acknowledge processed local dashboard event");
    }
    return receipt;
  }

  async #publish(active, operationId, spec) {
    const args = { operation_id: derivedOperationId(operationId, ".useful"), dashboard_id: active.identity.dashboard_id,
      presentation_generation: active.identity.presentation_generation, refresh_generation: active.identity.refresh_generation,
      expected_revision: active.identity.revision, spec };
    const receipt = await this.#phone.callTool("glasses.context_dashboard.publish", args);
    if (this.#active !== active || active.cancelled || receipt?.status !== "acknowledged" || receipt.dashboard_id !== active.identity.dashboard_id ||
        receipt.presentation_generation !== active.identity.presentation_generation || receipt.refresh_generation !== active.identity.refresh_generation || receipt.revision !== active.identity.revision + 1) {
      throw new Error("phone did not acknowledge current useful dashboard");
    }
    active.identity = receipt;
    return { dashboardId: receipt.dashboard_id, presentationGeneration: receipt.presentation_generation, refreshGeneration: receipt.refresh_generation, revision: receipt.revision,
      loadingAckMs: active.loadingAckMs ?? 0, usefulAckMs: Math.max(0, this.#now() - active.startedAtMs), announcement: spec.announcement?.text ?? null };
  }

  async close(identity) {
    const owner = exactIdentity(identity);
    const active = this.#active;
    if (!active || active.owner !== owner || !active.identity) return;
    active.cancelled = true;
    this.#active = null;
    const receipt = await this.#phone.callTool("glasses.context_dashboard.close", {
      operation_id: `close-${Date.now().toString(36)}`,
      dashboard_id: active.identity.dashboard_id,
      presentation_generation: active.identity.presentation_generation,
      expected_revision: active.identity.revision,
    });
    if (receipt?.status !== "closed" && receipt?.status !== "historical_acknowledgement") throw new Error("phone did not acknowledge contextual dashboard close");
  }
}
