function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function validEvent(event, viewId, revision) {
  return event && typeof event === "object" && !Array.isArray(event) &&
    typeof event.event_id === "string" && event.event_id.length >= 1 && event.event_id.length <= 160 &&
    event.view_id === viewId && event.revision === revision && event.kind === "activate" &&
    typeof event.action_handle === "string" && /^[A-Za-z0-9_-]{16,128}$/.test(event.action_handle);
}

/** Deterministic read-events -> provider action loop for one exact bridge turn. */
export class PrivateDynamicHaTurn {
  #runtime;
  #phone;
  #pollIntervalMs;
  #sleep;
  #now;
  #maxSessionMs;

  constructor({ runtime, phone, pollIntervalMs = 250, sleep = defaultSleep, now = Date.now, maxSessionMs = 300_000 }) {
    if (!runtime || !phone?.callTool || typeof sleep !== "function") throw new Error("private dynamic turn dependencies are required");
    this.#runtime = runtime;
    this.#phone = phone;
    this.#pollIntervalMs = pollIntervalMs;
    this.#sleep = sleep;
    this.#now = now;
    this.#maxSessionMs = maxSessionMs;
  }

  async run(identity, { operationId, signal } = {}) {
    if (!/^[A-Za-z0-9._-]{1,40}$/.test(operationId ?? "")) throw new Error("bounded evaluation operation ID is required");
    const started = this.#now();
    let opened = null;
    let revision = 0;
    let actions = 0;
    try {
      opened = await this.#runtime.openLivingRoom(identity, { operationId: `${operationId}.open` });
      if (!opened || typeof opened.viewId !== "string" || !Number.isSafeInteger(opened.revision)) throw new Error("dynamic app open response is malformed");
      revision = opened.revision;
      while (!signal?.aborted && this.#now() - started < this.#maxSessionMs) {
        const batch = await this.#phone.callTool("glasses.dynamic_apps.read_events", {
          view_id: opened.viewId,
          revision,
          after_event_id: null,
        });
        if (!batch || batch.view_id !== opened.viewId || batch.revision !== revision || !Array.isArray(batch.events) || batch.events.length > 1) {
          throw new Error("phone event batch is malformed or stale");
        }
        if (batch.events.length === 1) {
          const event = batch.events[0];
          if (!validEvent(event, opened.viewId, revision)) throw new Error("phone event is malformed or stale");
          const result = await this.#runtime.deliverInput(identity, event, { operationId: `${operationId}.action.${++actions}` });
          if (!result || result.viewId !== opened.viewId || !Number.isSafeInteger(result.revision) || result.revision <= revision) {
            throw new Error("dynamic app action result is malformed or stale");
          }
          revision = result.revision;
          return { actions, reason: signal?.aborted ? "cancelled" : "complete" };
        }
        await this.#sleep(this.#pollIntervalMs);
      }
      return { actions, reason: signal?.aborted ? "cancelled" : "expired" };
    } finally {
      if (opened) await this.#runtime.restoreAndClose(identity, { operationId, signal: undefined });
    }
  }
}
