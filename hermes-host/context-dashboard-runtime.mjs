import { createHash, randomUUID } from "node:crypto";

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

function derivedOperationId(base, suffix) {
  if (base.length + suffix.length <= 64) return `${base}${suffix}`;
  return `op-${createHash("sha256").update(`${base}\0${suffix}`).digest("base64url").slice(0, 48)}${suffix}`;
}

function eventOperationId(eventId) {
  return `evt-${createHash("sha256").update(eventId).digest("base64url").slice(0, 48)}`;
}

function normalizedFailure({ dashboardKey, title, privacy, code, now }) {
  return {
    version: 2, dashboard_key: dashboardKey, title, state: code === "offline" ? "offline" : "error", privacy,
    summary: { primary: "This view could not be prepared", secondary: "Try again in a new turn", tone: "warning", uncertainty: "unknown" },
    sections: [{ id: "results", order: 0, type: "message", load_state: "error", source_ids: ["source"], uncertainty: "unknown", error_code: code, body: "No useful answer was produced" }],
    sources: [{ id: "source", label: "Current turn", stale_after_seconds: 30, status: "unavailable" }],
    local_actions: [], ttl_seconds: 60,
  };
}

/**
 * Optional exact-identity lifecycle helper for temporary contextual interfaces.
 * A producer may pass a model-generated/current-turn answer directly, or gather
 * with an already-authorised read-only tool. No domain router, app definition,
 * adapter, API key, or prior setup is required by this runtime.
 */
export class ContextDashboardRuntime {
  #phone;
  #now;
  #deadlineMs;
  #loadingDeadlineMs;
  #active = null;

  constructor({ phone, now = Date.now, loadingDeadlineMs = 1_000, usefulDeadlineMs = 5_000 }) {
    if (!phone?.callTool) throw new Error("phone MCP client is required");
    this.#phone = phone;
    this.#now = now;
    this.#deadlineMs = usefulDeadlineMs;
    this.#loadingDeadlineMs = loadingDeadlineMs;
  }

  async open(identity, options) {
    const owner = exactIdentity(identity);
    if (!options || typeof options.operationId !== "string" || !ID.test(options.operationId) || typeof options.dashboardKey !== "string" || !ID.test(options.dashboardKey) ||
        typeof options.gather !== "function" || typeof options.project !== "function" || !options.refreshPolicy || !["manual", "on_visible"].includes(options.refreshPolicy.mode) ||
        !Number.isInteger(options.refreshPolicy.min_interval_seconds) || options.refreshPolicy.min_interval_seconds < 30 ||
        !["self_contained_intent", "current_turn_only"].includes(options.regeneration)) throw new Error("invalid contextual dashboard request");
    if (options.signal?.aborted) throw new Error("contextual dashboard request was cancelled");
    const request = {
      operation_id: options.operationId, dashboard_key: options.dashboardKey, title: boundedText(options.title, 48), privacy: options.privacy,
      intent: boundedText(options.intent, 240), refresh_policy: { mode: options.refreshPolicy.mode, min_interval_seconds: options.refreshPolicy.min_interval_seconds },
      regeneration: options.regeneration, ttl_seconds: 300,
    };
    const prior = this.#active;
    if (prior) { prior.cancelled = true; prior.controller?.abort(); }
    const active = { owner, cancelled: false, startedAtMs: this.#now() };
    this.#active = active;
    const beginController = new AbortController();
    active.controller = beginController;
    const abortBegin = () => beginController.abort(); options.signal?.addEventListener("abort", abortBegin, { once: true });
    const beginTimer = setTimeout(() => beginController.abort(), this.#loadingDeadlineMs);
    let begin;
    try { begin = await this.#phone.callTool("glasses.context_dashboard.begin", request, { signal: beginController.signal }); }
    finally { clearTimeout(beginTimer); options.signal?.removeEventListener("abort", abortBegin); }
    const beginWasReserved = begin?.status === "reserved" && !Object.hasOwn(begin, "frame_id");
    if (!beginWasReserved || typeof begin.dashboard_id !== "string" || !Number.isSafeInteger(begin.presentation_generation) || begin.presentation_generation < 1 ||
        !Number.isSafeInteger(begin.refresh_generation) || begin.refresh_generation < 1 || begin.revision !== 1) throw new Error("phone did not reserve contextual dashboard identity");
    if (beginController.signal.aborted || this.#active !== active || active.cancelled) {
      await this.#closeStaleAcknowledgedIdentity(begin);
      throw new Error("stale contextual dashboard open");
    }
    active.identity = begin;
    active.loadingAckMs = Math.max(0, this.#now() - active.startedAtMs);

    let timer;
    const gatherController = new AbortController();
    active.controller = gatherController;
    const abortGather = () => gatherController.abort();
    options.signal?.addEventListener("abort", abortGather, { once: true });
    let spec;
    try {
      const remainingMs = Math.max(0, active.startedAtMs + this.#deadlineMs - this.#now());
      const gatherBudgetMs = Math.max(0, remainingMs - Math.min(750, Math.max(1, Math.floor(remainingMs * 0.2))));
      const timeout = new Promise((_, reject) => { timer = setTimeout(() => { reject(new Error("deadline")); gatherController.abort(); }, gatherBudgetMs); });
      const raw = await Promise.race([Promise.resolve().then(() => options.gather({ signal: gatherController.signal })), timeout]);
      if (this.#active !== active || active.cancelled || options.signal?.aborted) throw new Error("stale contextual dashboard gather");
      spec = options.project(raw);
    } catch (error) {
      if (this.#active !== active || active.cancelled || options.signal?.aborted) {
        await this.#closeStaleAcknowledgedIdentity(active.identity);
        throw new Error("stale contextual dashboard gather");
      }
      const code = error instanceof Error && error.message === "deadline" ? "timeout" : "unavailable";
      spec = normalizedFailure({ dashboardKey: options.dashboardKey, title: request.title, privacy: options.privacy, code, now: this.#now() });
    } finally {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", abortGather);
    }
    return this.#publish(active, options.operationId, spec, options.signal);
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
    if (prior) { prior.cancelled = true; prior.controller?.abort(); }
    const active = { owner, cancelled: false, startedAtMs: this.#now() };
    this.#active = active;
    const refreshController = new AbortController();
    active.controller = refreshController;
    const abortRefresh = () => refreshController.abort();
    options.signal?.addEventListener("abort", abortRefresh, { once: true });
    if (options.signal?.aborted) refreshController.abort();
    const refreshTimer = setTimeout(() => refreshController.abort(), this.#loadingDeadlineMs);
    let refreshed;
    try {
      refreshed = await this.#phone.callTool("glasses.context_dashboard.start_refresh", {
        operation_id: eventOperationId(event.event_id), dashboard_id: event.dashboard_id, presentation_generation: event.presentation_generation,
        expected_revision: event.revision,
      }, { signal: refreshController.signal });
    } catch (error) {
      if (this.#active !== active || active.cancelled || refreshController.signal.aborted) throw new Error("stale local dashboard refresh");
      throw error;
    } finally {
      clearTimeout(refreshTimer);
      options.signal?.removeEventListener("abort", abortRefresh);
    }
    if (this.#active !== active || active.cancelled || refreshController.signal.aborted) {
      await this.#closeStaleAcknowledgedIdentity(refreshed);
      throw new Error("stale local dashboard refresh");
    }
    if (!["acknowledged", "historical_acknowledgement"].includes(refreshed?.status) || refreshed.dashboard_id !== event.dashboard_id ||
        refreshed.presentation_generation !== event.presentation_generation || refreshed.refresh_generation < 2 || refreshed.revision !== event.revision + 1 ||
        !Number.isSafeInteger(refreshed.frame_id) || refreshed.frame_id <= 0) {
      throw new Error("phone did not acknowledge current local refresh");
    }
    if (refreshed.status === "historical_acknowledgement") {
      await this.#ackLocalEvent(event, options.signal);
      active.controller = null;
      return { dashboardId: event.dashboard_id, presentationGeneration: event.presentation_generation,
        refreshGeneration: refreshed.refresh_generation, revision: refreshed.revision, historical: true };
    }
    active.identity = refreshed;
    active.loadingAckMs = Math.max(0, this.#now() - active.startedAtMs);
    const gatherController = new AbortController();
    active.controller = gatherController;
    const abortGather = () => gatherController.abort();
    options.signal?.addEventListener("abort", abortGather, { once: true });
    let timer;
    let spec;
    try {
      const remainingMs = Math.max(0, active.startedAtMs + this.#deadlineMs - this.#now());
      const gatherBudgetMs = Math.max(0, remainingMs - Math.min(750, Math.max(1, Math.floor(remainingMs * 0.2))));
      const timeout = new Promise((_, reject) => { timer = setTimeout(() => { reject(new Error("deadline")); gatherController.abort(); }, gatherBudgetMs); });
      const raw = await Promise.race([options.gather({ intent, signal: gatherController.signal }), timeout]);
      if (this.#active !== active || active.cancelled || options.signal?.aborted) throw new Error("stale local refresh gather");
      spec = options.project(raw);
    } catch (error) {
      if (this.#active !== active || active.cancelled || options.signal?.aborted) {
        await this.#closeStaleAcknowledgedIdentity(active.identity);
        throw new Error("stale local refresh gather");
      }
      spec = normalizedFailure({ dashboardKey: event.dashboard_key, title, privacy: event.privacy,
        code: error instanceof Error && error.message === "deadline" ? "timeout" : "unavailable", now: this.#now() });
    } finally {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", abortGather);
    }
    const receipt = await this.#publish(active, eventOperationId(event.event_id), spec, options.signal);
    await this.#ackLocalEvent(event, options.signal);
    return receipt;
  }

  async reopenPinned(identity, pin, { gather, project, signal } = {}) {
    const owner = exactIdentity(identity);
    if (!pin || typeof pin.dashboard_key !== "string" || !ID.test(pin.dashboard_key) || !pin.refresh_policy ||
        !["manual", "on_visible"].includes(pin.refresh_policy.mode) || !["public", "private"].includes(pin.privacy) ||
        typeof gather !== "function" || typeof project !== "function") {
      throw new Error("invalid pinned dashboard refresh request");
    }
    const title = boundedText(pin.title, 48);
    if (signal?.aborted) throw new Error("pinned dashboard reopen was cancelled");
    const prior = this.#active; if (prior) { prior.cancelled = true; prior.controller?.abort(); }
    const active = { owner, cancelled: false, startedAtMs: this.#now() };
    this.#active = active;
    const operationId = `pin-${randomUUID().replace(/-/g, "").slice(0, 32)}`;
    const openController = new AbortController();
    active.controller = openController;
    const abortOpen = () => openController.abort();
    signal?.addEventListener("abort", abortOpen, { once: true });
    if (signal?.aborted) openController.abort();
    const openTimer = setTimeout(() => openController.abort(), this.#loadingDeadlineMs);
    let opened;
    try {
      opened = await this.#phone.callTool("glasses.context_dashboard.open_pin", {
        operation_id: operationId, dashboard_key: pin.dashboard_key, ttl_seconds: 300,
      }, { signal: openController.signal });
    } catch (error) {
      if (this.#active !== active || active.cancelled || openController.signal.aborted) throw new Error("stale pinned dashboard reopen");
      throw error;
    } finally {
      clearTimeout(openTimer);
      signal?.removeEventListener("abort", abortOpen);
    }
    if (this.#active !== active || active.cancelled || openController.signal.aborted) {
      await this.#closeStaleAcknowledgedIdentity(opened);
      throw new Error("stale pinned dashboard reopen");
    }
    const pinWasReserved = opened?.status === "reserved" && !Object.hasOwn(opened, "frame_id");
    if (!pinWasReserved || typeof opened.dashboard_id !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(opened.dashboard_id) ||
        !Number.isSafeInteger(opened.presentation_generation) || opened.presentation_generation < 1 ||
        !Number.isSafeInteger(opened.refresh_generation) || opened.refresh_generation < 1 || opened.revision !== 1) {
      await this.#closeStaleAcknowledgedIdentity(opened);
      throw new Error("phone did not acknowledge pinned dashboard reopen");
    }
    let intent;
    try { intent = boundedText(opened.intent, 240); }
    catch {
      await this.#closeStaleAcknowledgedIdentity(opened);
      throw new Error("phone did not return the selected pinned intent");
    }
    active.identity = opened; active.loadingAckMs = Math.max(0, this.#now() - active.startedAtMs);
    const controller = new AbortController(); active.controller = controller; const abort = () => controller.abort(); signal?.addEventListener("abort", abort, { once: true });
    let timer; let spec;
    try {
      const remainingMs = Math.max(0, active.startedAtMs + this.#deadlineMs - this.#now());
      const gatherBudgetMs = Math.max(0, remainingMs - Math.min(750, Math.max(1, Math.floor(remainingMs * 0.2))));
      const timeout = new Promise((_, reject) => { timer = setTimeout(() => { reject(new Error("deadline")); controller.abort(); }, gatherBudgetMs); });
      const raw = await Promise.race([gather({ intent, signal: controller.signal }), timeout]);
      if (signal?.aborted || this.#active !== active || active.cancelled) throw new Error("stale pinned dashboard reopen");
      spec = project(raw);
    } catch (error) {
      if (signal?.aborted || this.#active !== active || active.cancelled) {
        await this.#closeStaleAcknowledgedIdentity(active.identity);
        throw new Error("stale pinned dashboard reopen");
      }
      spec = normalizedFailure({ dashboardKey: pin.dashboard_key, title, privacy: pin.privacy,
        code: error instanceof Error && error.message === "deadline" ? "timeout" : "unavailable", now: this.#now() });
    } finally {
      if (timer) clearTimeout(timer); signal?.removeEventListener("abort", abort);
    }
    return this.#publish(active, operationId, spec, signal);
  }

  async #ackLocalEvent(event, signal) {
    const acknowledgement = await this.#phone.callTool("glasses.context_dashboard.ack_events", {
      dashboard_id: event.dashboard_id, presentation_generation: event.presentation_generation, revision: event.revision,
      through_event_id: event.event_id,
    }, { signal });
    if (acknowledgement?.status !== "acknowledged" && acknowledgement?.status !== "historical_acknowledgement") throw new Error("phone did not acknowledge processed local dashboard event");
    return acknowledgement.status;
  }

  async #closeStaleAcknowledgedIdentity(receipt) {
    if (!["acknowledged", "reserved"].includes(receipt?.status) || typeof receipt.dashboard_id !== "string" ||
        !/^[A-Za-z0-9_-]{16,128}$/.test(receipt.dashboard_id) || !Number.isSafeInteger(receipt.presentation_generation) ||
        receipt.presentation_generation < 1 || !Number.isSafeInteger(receipt.revision) || receipt.revision < 1) return false;
    const controller = new AbortController();
    let timer;
    const close = Promise.resolve().then(() => this.#phone.callTool("glasses.context_dashboard.close", {
      operation_id: `close-${randomUUID().replace(/-/g, "").slice(0, 32)}`,
      dashboard_id: receipt.dashboard_id,
      presentation_generation: receipt.presentation_generation,
      expected_revision: receipt.revision,
    }, { signal: controller.signal })).catch(() => undefined);
    const deadline = new Promise((resolve) => {
      timer = setTimeout(() => { controller.abort(); resolve(); }, Math.max(1, Math.min(this.#loadingDeadlineMs, 1_000)));
    });
    try { await Promise.race([close, deadline]); }
    catch { /* Cleanup is bounded and must never mask the primary lifecycle failure. */ }
    finally { if (timer) clearTimeout(timer); }
    return true;
  }

  async #publish(active, operationId, spec, externalSignal) {
    if (externalSignal?.aborted || this.#active !== active || active.cancelled) {
      await this.#closeStaleAcknowledgedIdentity(active.identity);
      throw new Error("contextual dashboard publication was cancelled");
    }
    const args = { operation_id: derivedOperationId(operationId, ".useful"), dashboard_id: active.identity.dashboard_id,
      presentation_generation: active.identity.presentation_generation, refresh_generation: active.identity.refresh_generation,
      expected_revision: active.identity.revision, spec };
    const remainingMs = Math.max(0, active.startedAtMs + this.#deadlineMs - this.#now());
    if (remainingMs <= 0) {
      await this.#closeStaleAcknowledgedIdentity(active.identity);
      throw new Error("useful dashboard deadline elapsed before publication");
    }
    const publishController = new AbortController();
    active.controller = publishController;
    const abortPublish = () => publishController.abort(); externalSignal?.addEventListener("abort", abortPublish, { once: true });
    if (externalSignal?.aborted) publishController.abort();
    const timer = setTimeout(() => publishController.abort(), remainingMs);
    let receipt;
    let publishError;
    try { receipt = await this.#phone.callTool("glasses.context_dashboard.publish", args, { signal: publishController.signal }); }
    catch (error) { publishError = error; }
    finally { clearTimeout(timer); externalSignal?.removeEventListener("abort", abortPublish); }
    const ownershipStale = externalSignal?.aborted || this.#active !== active || active.cancelled;
    if (publishError) {
      // Delivery may have committed N+1 even though its acknowledgement was
      // lost. Close that one exact predicted successor first; CAS prevents
      // this cleanup from touching a later N+2 revision.
      await this.#closeStaleAcknowledgedIdentity({
        ...active.identity,
        status: "acknowledged",
        revision: active.identity.revision + 1,
      });
      await this.#closeStaleAcknowledgedIdentity(active.identity);
      if (ownershipStale) throw new Error("contextual dashboard publication was cancelled");
      throw publishError;
    }
    if (ownershipStale || receipt?.status !== "acknowledged" || receipt.dashboard_id !== active.identity.dashboard_id ||
        receipt.presentation_generation !== active.identity.presentation_generation || receipt.refresh_generation !== active.identity.refresh_generation || receipt.revision !== active.identity.revision + 1 ||
        !Number.isSafeInteger(receipt.frame_id) || receipt.frame_id <= 0 || publishController.signal.aborted || this.#now() - active.startedAtMs > this.#deadlineMs) {
      if (!(await this.#closeStaleAcknowledgedIdentity(receipt))) await this.#closeStaleAcknowledgedIdentity(active.identity);
      if (ownershipStale) throw new Error("contextual dashboard publication was cancelled");
      throw new Error("phone did not acknowledge current useful dashboard");
    }
    active.identity = receipt;
    active.controller = null;
    return { dashboardId: receipt.dashboard_id, presentationGeneration: receipt.presentation_generation, refreshGeneration: receipt.refresh_generation, revision: receipt.revision,
      loadingAckMs: active.loadingAckMs ?? 0, usefulAckMs: Math.max(0, this.#now() - active.startedAtMs), announcement: spec.announcement?.text ?? null };
  }

  async close(identity) {
    const owner = exactIdentity(identity);
    const active = this.#active;
    if (!active || active.owner !== owner) return;
    active.cancelled = true;
    active.controller?.abort();
    this.#active = null;
    if (!active.identity) return;
    const receipt = await this.#phone.callTool("glasses.context_dashboard.close", {
      operation_id: `close-${randomUUID().replace(/-/g, "").slice(0, 32)}`,
      dashboard_id: active.identity.dashboard_id,
      presentation_generation: active.identity.presentation_generation,
      expected_revision: active.identity.revision,
    });
    if (receipt?.status !== "closed" && receipt?.status !== "historical_acknowledgement") throw new Error("phone did not acknowledge contextual dashboard close");
  }
}
