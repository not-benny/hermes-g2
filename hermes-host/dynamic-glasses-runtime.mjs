import { randomBytes } from "node:crypto";

function randomHandle() {
  return randomBytes(18).toString("base64url");
}

function identityKey(identity) {
  if (!identity || !identity.tenant || !identity.device || !identity.connectionGeneration || !identity.turnGeneration) {
    throw new Error("exact runtime identity is required");
  }
  return JSON.stringify([identity.tenant, identity.device, identity.connectionGeneration, identity.turnGeneration]);
}

function sanitizeLabel(value) {
  return typeof value === "string" ? value.slice(0, 80) : "Device";
}

/** Hermes-hosted orchestrator. Provider credentials and entity IDs never enter phone tool arguments. */
export class DynamicGlassesRuntime {
  #adapter;
  #phone;
  #createHandle;
  #now;
  #session = null;
  #pendingOpen = null;
  #actions = new Map();
  #operations = new Map();
  #activeOperation = null;

  constructor({ adapter, phone, createHandle = randomHandle, now = Date.now }) {
    if (!adapter || !phone?.callTool) throw new Error("adapter and phone MCP client are required");
    this.#adapter = adapter;
    this.#phone = phone;
    this.#createHandle = createHandle;
    this.#now = now;
  }

  async openLivingRoom(identity, { operationId }) {
    const owner = identityKey(identity);
    if (this.#session?.expiresAtMs <= this.#now()) {
      this.#session = null;
      this.#actions.clear();
    }
    if (this.#session || this.#pendingOpen) throw new Error("a dynamic app session is already open or pending");
    const pending = { owner, cancelled: false };
    this.#pendingOpen = pending;
    try {
    const devices = (await this.#adapter.discover({ kind: "area", label: "Living Room" })).slice(0, 63);
    if (pending.cancelled || this.#pendingOpen !== pending) throw new Error("stale dynamic app open");
    const components = [{ id: "title", type: "heading", text: "Living room" }];
    this.#actions.clear();
    for (let index = 0; index < devices.length; index++) {
      const device = devices[index];
      const componentId = `device-${index + 1}`;
      const actionHandle = this.#mintAction({ owner, capabilityHandle: device.handle, expectedRevision: device.revision, componentId });
      components.push({
        id: componentId,
        type: "toggle",
        label: sanitizeLabel(device.label),
        value: device.value === "on",
        action_handle: actionHandle,
      });
    }
    if (!devices.length) components.push({ id: "empty", type: "text", text: "No available lights or switches in this area" });
    const result = await this.#phone.callTool("glasses.dynamic_apps.create", {
      operation_id: operationId,
      spec: {
        version: 1,
        title: "Living room",
        state: devices.length ? "ready" : "empty",
        privacy: "private",
        components,
        ttl_seconds: 300,
      },
    });
    if (pending.cancelled || this.#pendingOpen !== pending) {
      if (result?.status === "acknowledged" && result.view_id && result.revision === 1) {
        let closeResult;
        try {
          closeResult = await this.#phone.callTool("glasses.dynamic_apps.close", {
            operation_id: `cancel-${randomHandle()}`, view_id: result.view_id, expected_revision: result.revision,
          });
        } catch {
          pending.cleanupFailed = true;
          throw new Error("cancelled phone view cleanup is unconfirmed");
        }
        if ((closeResult?.status !== "closed" && closeResult?.status !== "historical_acknowledgement") ||
            closeResult?.view_id !== result.view_id || closeResult?.revision !== result.revision) {
          pending.cleanupFailed = true;
          throw new Error("cancelled phone view cleanup is unconfirmed");
        }
      }
      throw new Error("stale dynamic app open");
    }
    if (result?.status !== "acknowledged" || !result.view_id || result.revision !== 1) throw new Error("phone did not acknowledge dynamic app delivery");
    this.#session = { owner, viewId: result.view_id, revision: result.revision, expiresAtMs: this.#now() + 300_000, receipts: [] };
    this.#pendingOpen = null;
    return { viewId: result.view_id, revision: result.revision };
    } catch (error) {
      if (this.#pendingOpen === pending && !pending.cleanupFailed) {
        this.#pendingOpen = null;
        if (!this.#session) this.#actions.clear();
      }
      throw error;
    }
  }

  deliverInput(identity, event, { operationId, signal } = {}) {
    let owner;
    try { owner = identityKey(identity); } catch (error) { return Promise.reject(error); }
    const session = this.#session;
    if (!session || session.owner !== owner || session.viewId !== event?.view_id || session.expiresAtMs <= this.#now()) {
      return Promise.reject(new Error("stale dynamic app event"));
    }
    const operationKey = `${owner}:${operationId}`;
    const eventFingerprint = JSON.stringify(event);
    const prior = this.#operations.get(operationKey);
    if (prior) {
      if (prior.eventFingerprint !== eventFingerprint) return Promise.reject(new Error("operation was reused for a different event"));
      return prior.promise;
    }
    if (this.#activeOperation) return Promise.reject(new Error("another dynamic app mutation is in progress"));
    if (session.revision !== event?.revision || event?.kind !== "activate") return Promise.reject(new Error("stale dynamic app event"));
    const action = this.#actions.get(event.action_handle);
    if (!action || action.owner !== owner || action.viewRevision !== session.revision || action.used) {
      return Promise.reject(new Error("stale action capability"));
    }
    action.used = true;
    const token = {};
    this.#activeOperation = token;
    const promise = this.#deliverInputOnce(owner, session, action, event, operationId, signal)
      .finally(() => { if (this.#activeOperation === token) this.#activeOperation = null; });
    this.#operations.set(operationKey, { eventFingerprint, promise });
    return promise;
  }

  async #deliverInputOnce(owner, session, action, event, operationId, signal) {
    const current = await this.#adapter.read(action.capabilityHandle);
    if (current.revision !== action.expectedRevision) throw new Error("provider state changed; refresh required");
    const desired = current.value === "on" ? "off" : "on";
    const receipt = await this.#adapter.setPower({
      operationId,
      handle: action.capabilityHandle,
      value: desired,
      expectedRevision: current.revision,
    }, { isAuthorized: () => this.#isCurrent(owner, event), signal });
    if (this.#session === session) session.receipts.push(receipt);
    if (!this.#isCurrent(owner, event)) throw new Error("stale dynamic app event after provider mutation");

    const nextActionHandle = this.#mintAction({ owner, capabilityHandle: action.capabilityHandle,
      expectedRevision: receipt.after.revision, viewRevision: session.revision + 1, componentId: action.componentId });
    const patched = await this.#phone.callTool("glasses.dynamic_apps.patch", {
      operation_id: `${operationId}.view`,
      view_id: session.viewId,
      expected_revision: session.revision,
      patch: {
        upsert: [{ id: action.componentId, type: "toggle", label: sanitizeLabel(receipt.after.label),
          value: receipt.after.value === "on", action_handle: nextActionHandle }],
        remove: [],
      },
    });
    if (patched?.status !== "acknowledged" || patched.revision !== session.revision + 1) {
      throw new Error("provider changed but refreshed glasses state was not acknowledged");
    }
    session.revision = patched.revision;
    for (const candidate of this.#actions.values()) {
      if (!candidate.used && candidate.owner === owner) candidate.viewRevision = session.revision;
    }
    const acknowledgement = await this.#phone.callTool("glasses.dynamic_apps.ack_events", {
      view_id: session.viewId,
      revision: event.revision,
      through_event_id: event.event_id,
    });
    if (acknowledgement?.status !== "acknowledged" && acknowledgement?.status !== "historical_acknowledgement") {
      throw new Error("phone did not acknowledge the processed input event");
    }
    const result = { state: receipt.after.value, viewId: session.viewId, revision: session.revision, changed: receipt.changed };
    return result;
  }

  async restoreAndClose(identity, { operationId, signal } = {}) {
    const owner = identityKey(identity);
    if (!/^[A-Za-z0-9._-]{1,40}$/.test(operationId ?? "")) throw new Error("bounded restoration operation ID is required");
    const session = this.#session;
    if (!session || session.owner !== owner) throw new Error("stale dynamic app session");
    const restorations = [];
    for (let index = session.receipts.length - 1; index >= 0; index--) {
      if (signal?.aborted) throw new Error("dynamic app restoration was cancelled");
      const result = await this.#adapter.restore(session.receipts[index], {
        operationId: `${operationId}.restore.${session.receipts.length - index}`,
        signal,
        isAuthorized: () => this.#session === session && session.owner === owner,
      });
      restorations.push(result);
    }
    const closed = await this.#phone.callTool("glasses.dynamic_apps.close", {
      operation_id: `${operationId}.close`,
      view_id: session.viewId,
      expected_revision: session.revision,
    });
    if ((closed?.status !== "closed" && closed?.status !== "historical_acknowledgement") ||
        closed?.view_id !== session.viewId || closed?.revision !== session.revision) {
      throw new Error("phone did not acknowledge dynamic app close");
    }
    if (this.#session === session) {
      this.#session = null;
      this.#actions.clear();
    }
    return { restorations, viewId: session.viewId, revision: session.revision };
  }

  close(identity) {
    const owner = identityKey(identity);
    if (this.#pendingOpen?.owner === owner) {
      this.#pendingOpen.cancelled = true;
      return;
    }
    if (!this.#session || this.#session.owner !== owner) return;
    this.#session = null;
    this.#actions.clear();
  }

  #isCurrent(owner, event) {
    return Boolean(this.#session && this.#session.owner === owner && this.#session.viewId === event.view_id &&
      this.#session.revision === event.revision && this.#session.expiresAtMs > this.#now());
  }

  #mintAction({ owner, capabilityHandle, expectedRevision, componentId, viewRevision = 1 }) {
    const handle = this.#createHandle();
    if (typeof handle !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(handle) || this.#actions.has(handle)) {
      throw new Error("secure action handle generation failed");
    }
    this.#actions.set(handle, { owner, capabilityHandle, expectedRevision, componentId, viewRevision, used: false });
    return handle;
  }
}
