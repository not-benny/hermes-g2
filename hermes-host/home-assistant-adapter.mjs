import { createHash, randomBytes } from "node:crypto";

const SAFE_DOMAINS = new Set(["light", "switch"]);
const SAFE_STATES = new Set(["on", "off"]);

export class HomeAssistantError extends Error {
  constructor(code) {
    super(`Home Assistant ${code}`);
    this.name = "HomeAssistantError";
    this.code = code;
  }

  toJSON() {
    return { name: this.name, code: this.code };
  }
}

export function createHomeAssistantTransport({ baseUrl, getToken, fetchImpl = globalThis.fetch }) {
  let origin;
  try { origin = new URL(baseUrl); } catch { throw new Error("Home Assistant requires a valid HTTPS URL"); }
  if (origin.protocol !== "https:" || origin.username || origin.password || origin.search || origin.hash) {
    throw new Error("Home Assistant requires a credential-free HTTPS origin");
  }
  if (typeof getToken !== "function" || typeof fetchImpl !== "function") throw new Error("Home Assistant transport is not configured");
  const root = origin.href.replace(/\/$/, "");
  return {
    async request({ method, path, body, signal }) {
      if ((method !== "GET" && method !== "POST") || typeof path !== "string" || !path.startsWith("/api/")) {
        throw new HomeAssistantError("request rejected");
      }
      let response;
      try {
        const token = getToken();
        if (typeof token !== "string" || token.length < 8) throw new HomeAssistantError("credential unavailable");
        response = await fetchImpl(`${root}${path}`, {
          method,
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
          redirect: "error",
          signal,
        });
      } catch (error) {
        if (error instanceof HomeAssistantError) throw error;
        throw new HomeAssistantError("unreachable");
      }
      if (!response?.ok) {
        const code = response?.status === 401 || response?.status === 403 ? "authorization failed" : "request failed";
        throw new HomeAssistantError(code);
      }
      try { return await response.json(); } catch { throw new HomeAssistantError("response malformed"); }
    },
  };
}

function opaqueHandle() {
  return randomBytes(18).toString("base64url");
}

function entityRevision(entity) {
  const canonical = JSON.stringify({
    state: entity.state,
    last_updated: entity.last_updated,
    context: entity.context?.id ?? null,
    attributes: entity.attributes ?? {},
  });
  return createHash("sha256").update(canonical).digest("base64url");
}

function parseEntity(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.entity_id !== "string") return null;
  const separator = value.entity_id.indexOf(".");
  if (separator <= 0) return null;
  const domain = value.entity_id.slice(0, separator);
  if (!SAFE_DOMAINS.has(domain) || !SAFE_STATES.has(value.state)) return null;
  const label = value.attributes?.friendly_name;
  if (typeof label !== "string" || !label.trim() || label.length > 80) return null;
  if (typeof value.last_updated !== "string" || typeof value.context?.id !== "string") return null;
  return { entityId: value.entity_id, domain, label: label.trim(), value: value.state, revision: entityRevision(value), contextId: value.context.id };
}

function sameRequest(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

export class HomeAssistantAdapter {
  #transport;
  #createHandle;
  #now;
  #generation = 0;
  #capabilities = new Map();
  #issuedHandles = new Set();
  #operations = new Map();
  #restores = new Map();
  #issuedReceipts = new WeakSet();

  constructor({ transport, createHandle = opaqueHandle, now = Date.now }) {
    if (!transport?.request) throw new Error("Home Assistant transport is required");
    this.#transport = transport;
    this.#createHandle = createHandle;
    this.#now = now;
  }

  async discover(scope, signal) {
    if (scope?.kind !== "area" || scope.label !== "Living Room") throw new HomeAssistantError("area scope rejected");
    const generation = ++this.#generation;
    this.#capabilities.clear();
    let areaEntities;
    let states;
    try {
      areaEntities = await this.#transport.request({
        method: "POST", path: "/api/template",
        body: { template: "{{ area_entities(area) | tojson }}", variables: { area: scope.label } }, signal,
      });
      states = await this.#transport.request({ method: "GET", path: "/api/states", signal });
    } catch (error) {
      if (error instanceof HomeAssistantError) throw error;
      throw new HomeAssistantError("discovery failed");
    }
    if (typeof areaEntities === "string") {
      try { areaEntities = JSON.parse(areaEntities); } catch { throw new HomeAssistantError("area response malformed"); }
    }
    if (!Array.isArray(areaEntities) || !Array.isArray(states) || areaEntities.length > 512 || states.length > 4096) {
      throw new HomeAssistantError("discovery response malformed");
    }
    const allowed = new Set(areaEntities.filter((id) => typeof id === "string" && id.length <= 128));
    const result = [];
    for (const raw of states) {
      const entity = parseEntity(raw);
      if (!entity || !allowed.has(entity.entityId)) continue;
      const handle = this.#createHandle();
      if (typeof handle !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(handle) || this.#issuedHandles.has(handle)) {
        throw new HomeAssistantError("secure handle generation failed");
      }
      this.#issuedHandles.add(handle);
      this.#capabilities.set(handle, { ...entity, generation });
      result.push({ handle, kind: entity.domain, label: entity.label, value: entity.value, revision: entity.revision, observedAtMs: this.#now() });
      if (result.length >= 64) break;
    }
    return result;
  }

  #resolve(handle) {
    const capability = this.#capabilities.get(handle);
    if (!capability || capability.generation !== this.#generation) throw new HomeAssistantError("stale capability");
    return capability;
  }

  async #readCurrent(handle, signal) {
    const capability = this.#resolve(handle);
    let raw;
    try {
      raw = await this.#transport.request({ method: "GET", path: `/api/states/${encodeURIComponent(capability.entityId)}`, signal });
    } catch (error) {
      if (error instanceof HomeAssistantError) throw error;
      throw new HomeAssistantError("read failed");
    }
    const entity = parseEntity(raw);
    if (!entity || entity.entityId !== capability.entityId || entity.domain !== capability.domain) throw new HomeAssistantError("entity unavailable");
    return {
      entity,
      snapshot: Object.freeze({ handle, kind: entity.domain, label: entity.label, value: entity.value,
        revision: entity.revision, observedAtMs: this.#now() }),
    };
  }

  async read(handle, signal) {
    return (await this.#readCurrent(handle, signal)).snapshot;
  }

  async #assertInScope(capability, signal) {
    let members = await this.#transport.request({
      method: "POST", path: "/api/template",
      body: { template: "{{ area_entities(area) | tojson }}", variables: { area: "Living Room" } }, signal,
    });
    if (typeof members === "string") {
      try { members = JSON.parse(members); } catch { throw new HomeAssistantError("area scope malformed"); }
    }
    if (!Array.isArray(members) || !members.includes(capability.entityId)) throw new HomeAssistantError("area scope is stale");
  }

  setPower(request, context) {
    if (!request || !/^[A-Za-z0-9._-]{1,64}$/.test(request.operationId ?? "") || !SAFE_STATES.has(request.value)) {
      return Promise.reject(new HomeAssistantError("mutation rejected"));
    }
    if (context?.signal?.aborted || context?.isAuthorized?.() !== true) {
      return Promise.reject(new HomeAssistantError("mutation no longer authorized"));
    }
    try { this.#resolve(request.handle); } catch (error) { return Promise.reject(error); }
    const prior = this.#operations.get(request.operationId);
    if (prior) {
      if (!sameRequest(prior.request, request)) return Promise.reject(new HomeAssistantError("operation reused for different mutation"));
      return prior.promise;
    }
    const promise = this.#setPowerOnce(structuredClone(request), context);
    this.#operations.set(request.operationId, { request: structuredClone(request), promise });
    return promise;
  }

  async #setPowerOnce(request, context) {
    const capability = this.#resolve(request.handle);
    const { snapshot: before } = await this.#readCurrent(request.handle, context?.signal);
    if (before.revision !== request.expectedRevision) throw new HomeAssistantError("revision is stale");
    if (before.value === request.value) {
      const receipt = Object.freeze({ operationId: request.operationId, changed: false, restorable: true, before, after: before });
      this.#issuedReceipts.add(receipt);
      return receipt;
    }
    await this.#assertInScope(capability, context?.signal);
    if (this.#resolve(request.handle) !== capability) throw new HomeAssistantError("stale capability");
    const { snapshot: immediate } = await this.#readCurrent(request.handle, context?.signal);
    if (immediate.revision !== request.expectedRevision) throw new HomeAssistantError("revision changed before mutation");
    if (context?.signal?.aborted || context?.isAuthorized?.() !== true) throw new HomeAssistantError("mutation no longer authorized");
    const service = request.value === "on" ? "turn_on" : "turn_off";
    let serviceResponse;
    try {
      serviceResponse = await this.#transport.request({
        method: "POST", path: `/api/services/${capability.domain}/${service}`,
        body: { entity_id: capability.entityId }, signal: context?.signal,
      });
      const { entity: afterEntity, snapshot: after } = await this.#readCurrent(request.handle, context?.signal);
      if (after.value !== request.value) throw new HomeAssistantError("mutation outcome unknown");
      const responseEntity = Array.isArray(serviceResponse)
        ? serviceResponse.map(parseEntity).find((entity) => entity?.entityId === capability.entityId)
        : null;
      const contextDigest = responseEntity?.contextId === afterEntity.contextId
        ? createHash("sha256").update(afterEntity.contextId).digest("base64url")
        : null;
      const receipt = Object.freeze({ operationId: request.operationId, changed: true, restorable: contextDigest !== null,
        restorationProof: contextDigest, before, after });
      this.#issuedReceipts.add(receipt);
      return receipt;
    } catch {
      throw new HomeAssistantError("mutation outcome unknown");
    }
  }

  async restore(receipt, context) {
    if (!receipt || !this.#issuedReceipts.has(receipt)) throw new HomeAssistantError("restoration receipt is untrusted");
    if (!receipt.changed) return { restored: true, snapshot: receipt.before };
    if (!receipt.restorable || !receipt.restorationProof) return { restored: false, reason: "causality-unproven" };
    if (context?.signal?.aborted || context?.isAuthorized?.() !== true) throw new HomeAssistantError("restoration no longer authorized");
    const prior = this.#restores.get(context?.operationId);
    if (prior) return prior;
    const promise = (async () => {
      const { entity, snapshot: current } = await this.#readCurrent(receipt.after.handle, context?.signal);
      const currentProof = createHash("sha256").update(entity.contextId).digest("base64url");
      if (current.revision !== receipt.after.revision || currentProof !== receipt.restorationProof) {
        return { restored: false, reason: "state-changed" };
      }
      const restoredReceipt = await this.setPower({
        operationId: context.operationId,
        handle: receipt.after.handle,
        value: receipt.before.value,
        expectedRevision: current.revision,
      }, context);
      return { restored: true, snapshot: restoredReceipt.after };
    })();
    this.#restores.set(context.operationId, promise);
    return promise;
  }
}
