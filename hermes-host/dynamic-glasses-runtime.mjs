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
  #actions = new Map();
  #operations = new Map();

  constructor({ adapter, phone, createHandle = randomHandle, now = Date.now }) {
    if (!adapter || !phone?.callTool) throw new Error("adapter and phone MCP client are required");
    this.#adapter = adapter;
    this.#phone = phone;
    this.#createHandle = createHandle;
    this.#now = now;
  }

  async openLivingRoom(identity, { operationId }) {
    const owner = identityKey(identity);
    if (this.#session) throw new Error("a dynamic app session is already open");
    const devices = await this.#adapter.discover({ kind: "area", label: "Living Room" });
    const components = [{ id: "title", type: "heading", text: "Living room" }];
    this.#actions.clear();
    for (let index = 0; index < devices.length; index++) {
      const device = devices[index];
      const actionHandle = this.#mintAction({ owner, capabilityHandle: device.handle, expectedRevision: device.revision });
      components.push({
        id: `device-${index + 1}`,
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
    if (result?.status !== "acknowledged" || !result.view_id || result.revision !== 1) throw new Error("phone did not acknowledge dynamic app delivery");
    this.#session = { owner, viewId: result.view_id, revision: result.revision, expiresAtMs: this.#now() + 300_000 };
    return { viewId: result.view_id, revision: result.revision };
  }

  async deliverInput(identity, event, { operationId }) {
    const prior = this.#operations.get(operationId);
    if (prior) {
      if (prior.eventId !== event?.event_id) throw new Error("operation was reused for a different event");
      return prior.result;
    }
    const owner = identityKey(identity);
    const session = this.#session;
    if (!session || session.owner !== owner || session.viewId !== event?.view_id || session.revision !== event?.revision ||
        session.expiresAtMs <= this.#now()) throw new Error("stale dynamic app event");
    const action = this.#actions.get(event.action_handle);
    if (!action || action.owner !== owner || action.viewRevision !== session.revision || action.used) throw new Error("stale action capability");

    const current = await this.#adapter.read(action.capabilityHandle);
    if (current.revision !== action.expectedRevision) throw new Error("provider state changed; refresh required");
    const desired = current.value === "on" ? "off" : "on";
    const receipt = await this.#adapter.setPower({
      operationId,
      handle: action.capabilityHandle,
      value: desired,
      expectedRevision: current.revision,
    }, { isAuthorized: () => this.#isCurrent(owner, event), signal: undefined });
    if (!this.#isCurrent(owner, event)) throw new Error("stale dynamic app event after provider mutation");

    const nextActionHandle = this.#mintAction({ owner, capabilityHandle: action.capabilityHandle,
      expectedRevision: receipt.after.revision, viewRevision: session.revision + 1 });
    const patched = await this.#phone.callTool("glasses.dynamic_apps.patch", {
      operation_id: `${operationId}.view`,
      view_id: session.viewId,
      expected_revision: session.revision,
      patch: {
        upsert: [{ id: this.#componentIdFor(action.capabilityHandle), type: "toggle", label: sanitizeLabel(receipt.after.label),
          value: receipt.after.value === "on", action_handle: nextActionHandle }],
        remove: [],
      },
    });
    if (patched?.status !== "acknowledged" || patched.revision !== session.revision + 1) {
      throw new Error("provider changed but refreshed glasses state was not acknowledged");
    }
    action.used = true;
    session.revision = patched.revision;
    await this.#phone.callTool("glasses.dynamic_apps.ack_events", {
      view_id: session.viewId,
      revision: event.revision,
      through_event_id: event.event_id,
    });
    const result = { state: receipt.after.value, viewId: session.viewId, revision: session.revision, changed: receipt.changed };
    this.#operations.set(operationId, { eventId: event.event_id, result });
    return result;
  }

  close(identity) {
    const owner = identityKey(identity);
    if (!this.#session || this.#session.owner !== owner) return;
    this.#session = null;
    this.#actions.clear();
  }

  #isCurrent(owner, event) {
    return Boolean(this.#session && this.#session.owner === owner && this.#session.viewId === event.view_id &&
      this.#session.revision === event.revision && this.#session.expiresAtMs > this.#now());
  }

  #mintAction({ owner, capabilityHandle, expectedRevision, viewRevision = 1 }) {
    const handle = this.#createHandle();
    if (typeof handle !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(handle) || this.#actions.has(handle)) {
      throw new Error("secure action handle generation failed");
    }
    this.#actions.set(handle, { owner, capabilityHandle, expectedRevision, viewRevision, used: false });
    return handle;
  }

  #componentIdFor(capabilityHandle) {
    const action = [...this.#actions.values()].find((candidate) => candidate.capabilityHandle === capabilityHandle);
    if (!action) throw new Error("stale action capability");
    const devices = [...new Set([...this.#actions.values()].map((candidate) => candidate.capabilityHandle))];
    return `device-${devices.indexOf(capabilityHandle) + 1}`;
  }
}
