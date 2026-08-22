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
      const token = getToken();
      if (typeof token !== "string" || token.length < 8) throw new HomeAssistantError("credential unavailable");
      let response;
      try {
        response = await fetchImpl(`${root}${path}`, {
          method,
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
          redirect: "error",
          signal,
        });
      } catch {
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
  return { entityId: value.entity_id, domain, label: label.trim(), value: value.state, revision: entityRevision(value) };
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

  async read(handle, signal) {
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
    return { handle, kind: entity.domain, label: entity.label, value: entity.value, revision: entity.revision, observedAtMs: this.#now() };
  }

  async setPower(request, context) {
    if (!request || !/^[A-Za-z0-9._-]{1,64}$/.test(request.operationId ?? "") || !SAFE_STATES.has(request.value)) {
      throw new HomeAssistantError("mutation rejected");
    }
    const prior = this.#operations.get(request.operationId);
    if (prior) {
      if (!sameRequest(prior.request, request)) throw new HomeAssistantError("operation reused for different mutation");
      return prior.receipt;
    }
    const capability = this.#resolve(request.handle);
    const before = await this.read(request.handle, context?.signal);
    if (before.revision !== request.expectedRevision) throw new HomeAssistantError("revision is stale");
    if (before.value === request.value) {
      const receipt = { operationId: request.operationId, changed: false, before, after: before };
      this.#operations.set(request.operationId, { request: structuredClone(request), receipt });
      return receipt;
    }
    if (context?.signal?.aborted || context?.isAuthorized?.() !== true) throw new HomeAssistantError("mutation no longer authorized");
    const service = request.value === "on" ? "turn_on" : "turn_off";
    try {
      await this.#transport.request({
        method: "POST", path: `/api/services/${capability.domain}/${service}`,
        body: { entity_id: capability.entityId }, signal: context?.signal,
      });
    } catch (error) {
      if (error instanceof HomeAssistantError) throw error;
      throw new HomeAssistantError("mutation outcome unknown");
    }
    const after = await this.read(request.handle, context?.signal);
    if (after.value !== request.value) throw new HomeAssistantError("mutation outcome unknown");
    const receipt = { operationId: request.operationId, changed: true, before, after };
    this.#operations.set(request.operationId, { request: structuredClone(request), receipt });
    return receipt;
  }

  async restore(receipt, context) {
    if (!receipt?.changed) return { restored: true, snapshot: receipt?.before };
    const prior = this.#restores.get(context?.operationId);
    if (prior) return prior;
    const current = await this.read(receipt.after.handle, context?.signal);
    if (current.revision !== receipt.after.revision) return { restored: false, reason: "state-changed" };
    const restoredReceipt = await this.setPower({
      operationId: context.operationId,
      handle: receipt.after.handle,
      value: receipt.before.value,
      expectedRevision: current.revision,
    }, context);
    const result = { restored: true, snapshot: restoredReceipt.after };
    this.#restores.set(context.operationId, result);
    return result;
  }
}
