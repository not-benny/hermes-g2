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

export function createHomeAssistantTransport({ baseUrl, getToken, fetchImpl = globalThis.fetch,
  atomicMutationPath = null, requestTimeoutMs = 15_000 }) {
  let origin;
  try { origin = new URL(baseUrl); } catch { throw new Error("Home Assistant requires a valid HTTPS URL"); }
  if (origin.protocol !== "https:" || origin.username || origin.password || origin.search || origin.hash) {
    throw new Error("Home Assistant requires a credential-free HTTPS origin");
  }
  if (typeof getToken !== "function" || typeof fetchImpl !== "function") throw new Error("Home Assistant transport is not configured");
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 10 || requestTimeoutMs > 60_000) {
    throw new Error("Home Assistant request timeout is invalid");
  }
  if (atomicMutationPath !== null && (typeof atomicMutationPath !== "string" || !atomicMutationPath.startsWith("/api/") || atomicMutationPath.length > 160)) {
    throw new Error("Home Assistant atomic mutation path is invalid");
  }
  const root = origin.href.replace(/\/$/, "");
  const transport = {
    async request({ method, path, body, signal }) {
      if ((method !== "GET" && method !== "POST") || typeof path !== "string" || !path.startsWith("/api/")) {
        throw new HomeAssistantError("request rejected");
      }
      let response;
      const controller = new AbortController();
      let rejectInterrupt;
      const interrupt = new Promise((_, reject) => { rejectInterrupt = reject; });
      const onAbort = () => {
        rejectInterrupt(new HomeAssistantError("request cancelled"));
        controller.abort();
      };
      const timer = setTimeout(() => {
        rejectInterrupt(new HomeAssistantError("request timeout"));
        controller.abort();
      }, requestTimeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
      try {
        const token = getToken();
        if (typeof token !== "string" || token.length < 8) throw new HomeAssistantError("credential unavailable");
        response = await Promise.race([fetchImpl(`${root}${path}`, {
          method,
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
          redirect: "error",
          signal: controller.signal,
        }), interrupt]);
      } catch (error) {
        cleanup();
        if (error instanceof HomeAssistantError) throw error;
        throw new HomeAssistantError("unreachable");
      }
      if (!response?.ok) {
        cleanup();
        const code = response?.status === 401 || response?.status === 403 ? "authorization failed" : "request failed";
        throw new HomeAssistantError(code);
      }
      try { return await Promise.race([response.json(), interrupt]); }
      catch (error) {
        if (error instanceof HomeAssistantError) throw error;
        throw new HomeAssistantError("response malformed");
      } finally { cleanup(); }
    },
  };
  transport.mutateBinaryCapability = async (request, signal) => {
    if (!atomicMutationPath) throw new HomeAssistantError("atomic mutation unavailable");
    return transport.request({ method: "POST", path: atomicMutationPath, body: request, signal });
  };
  return transport;
}

function opaqueHandle() {
  return randomBytes(18).toString("base64url");
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

function entityRevision(entity) {
  const canonical = JSON.stringify(canonicalize({
    state: entity.state,
    last_updated: entity.last_updated,
    context: entity.context?.id ?? null,
    attributes: entity.attributes ?? {},
  }));
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
  #ledger;
  #generation = 0;
  #capabilities = new Map();
  #issuedHandles = new Set();
  #operations = new Map();
  #restores = new Map();
  #issuedReceipts = new WeakSet();

  constructor({ transport, createHandle = opaqueHandle, now = Date.now, ledger = null }) {
    if (!transport?.request) throw new Error("Home Assistant transport is required");
    if (ledger !== null && ["reserve", "complete", "reject", "get", "list", "forget"].some((name) => typeof ledger[name] !== "function")) {
      throw new Error("Home Assistant durable ledger is invalid");
    }
    this.#transport = transport;
    this.#createHandle = createHandle;
    this.#now = now;
    this.#ledger = ledger;
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
    const entry = { request: structuredClone(request), promise };
    this.#operations.set(request.operationId, entry);
    if (this.#ledger) {
      void promise.catch(() => {
        if (this.#operations.get(request.operationId) === entry) this.#operations.delete(request.operationId);
      });
    }
    return promise;
  }

  async #setPowerOnce(request, context) {
    const capability = this.#resolve(request.handle);
    const providerRequest = {
      version: 1,
      operation_id: request.operationId,
      area: "Living Room",
      entity_id: capability.entityId,
      domain: capability.domain,
      expected_revision: request.expectedRevision,
      target: request.value,
    };
    const durableMetadata = {
      purpose: context?.durablePurpose === "restore" ? "restore" : "mutation",
      parentOperationId: context?.durablePurpose === "restore" ? context?.parentOperationId ?? null : null,
    };
    let durable = null;
    if (this.#ledger) {
      const existing = await this.#ledger.get(request.operationId);
      if (existing) {
        durable = await this.#ledger.reserve(request.operationId, providerRequest, durableMetadata);
        if (durable.state === "completed") return this.#receiptFromMutationResult(request, capability, durable.outcome);
        if (durable.state === "rejected") throw new HomeAssistantError(durable.code.replace(/_/g, " "));
      }
    }
    if (!durable) {
      const { snapshot: before } = await this.#readCurrent(request.handle, context?.signal);
      if (before.revision !== request.expectedRevision) {
        throw new HomeAssistantError("revision is stale");
      }
      if (before.value === request.value) {
        const receipt = Object.freeze({ operationId: request.operationId, changed: false, restorable: true, before, after: before });
        this.#issuedReceipts.add(receipt);
        return receipt;
      }
      if (this.#ledger) durable = await this.#ledger.reserve(request.operationId, providerRequest, durableMetadata);
    }
    if (context?.signal?.aborted || context?.isAuthorized?.() !== true) throw new HomeAssistantError("mutation no longer authorized");
    if (typeof this.#transport.mutateBinaryCapability !== "function") throw new HomeAssistantError("atomic mutation unavailable");
    try {
      const result = await this.#transport.mutateBinaryCapability(providerRequest, context?.signal);
      if (result?.applied === false && ["stale_scope", "stale_revision", "unavailable"].includes(result.code)) {
        if (this.#ledger && durableMetadata.purpose === "restore" && result.code !== "stale_revision") {
          await this.#ledger.forget(request.operationId);
        } else {
          await this.#ledger?.reject(request.operationId, result.code);
        }
        throw new HomeAssistantError(result.code.replace(/_/g, " "));
      }
      const receipt = this.#receiptFromMutationResult(request, capability, result);
      await this.#ledger?.complete(request.operationId, result);
      return receipt;
    } catch (error) {
      if (error instanceof HomeAssistantError && ["Home Assistant stale scope", "Home Assistant stale revision", "Home Assistant unavailable"].includes(error.message)) {
        throw error;
      }
      throw new HomeAssistantError("mutation outcome unknown");
    }
  }

  #receiptFromMutationResult(request, capability, result) {
    const beforeEntity = parseEntity(result?.before);
    const afterEntity = parseEntity(result?.after);
    if (result?.applied !== true || result?.area !== "Living Room" || !beforeEntity || !afterEntity ||
        beforeEntity.entityId !== capability.entityId || afterEntity.entityId !== capability.entityId ||
        beforeEntity.revision !== request.expectedRevision || afterEntity.value !== request.value) {
      throw new HomeAssistantError("mutation outcome unknown");
    }
    const before = Object.freeze({ handle: request.handle, kind: beforeEntity.domain, label: beforeEntity.label,
      value: beforeEntity.value, revision: beforeEntity.revision, observedAtMs: this.#now() });
    const after = Object.freeze({ handle: request.handle, kind: afterEntity.domain, label: afterEntity.label,
      value: afterEntity.value, revision: afterEntity.revision, observedAtMs: this.#now() });
    const contextDigest = createHash("sha256").update(afterEntity.contextId).digest("base64url");
    const receipt = Object.freeze({ operationId: request.operationId, changed: true, restorable: true,
      restorationProof: contextDigest, before, after });
    this.#issuedReceipts.add(receipt);
    return receipt;
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
        if (this.#ledger && typeof context?.operationId === "string") {
          await this.#ledger.reserve(context.operationId, {
            version: 1, resolution: "state_changed", parent_operation_id: receipt.operationId,
          }, { purpose: "restore", parentOperationId: receipt.operationId });
          await this.#ledger.reject(context.operationId, "stale_revision");
        }
        return { restored: false, reason: "state-changed" };
      }
      const restoredReceipt = await this.setPower({
        operationId: context.operationId,
        handle: receipt.after.handle,
        value: receipt.before.value,
        expectedRevision: current.revision,
      }, { ...context, durablePurpose: "restore", parentOperationId: receipt.operationId });
      return { restored: true, snapshot: restoredReceipt.after };
    })();
    this.#restores.set(context.operationId, promise);
    if (this.#ledger) {
      void promise.catch(() => {
        if (this.#restores.get(context.operationId) === promise) this.#restores.delete(context.operationId);
      });
    }
    return promise;
  }

  async recoverUnrestoredMutations(context) {
    if (!this.#ledger) throw new HomeAssistantError("durable ledger unavailable");
    if (context?.isAuthorized?.() !== true) throw new HomeAssistantError("recovery no longer authorized");
    let records = await this.#ledger.list();
    for (const record of records.filter((item) => item.purpose === "restore" && item.state === "pending")) {
      try { await this.#replayDurableRecord(record, context); }
      catch (error) {
        if (!(error instanceof HomeAssistantError)) throw error;
      }
    }
    records = await this.#ledger.list();
    const resolvedParents = new Set(records.filter((item) => item.purpose === "restore" &&
      (item.state === "completed" || (item.state === "rejected" && item.code === "stale_revision")))
      .map((item) => item.parentOperationId).filter(Boolean));
    const receipts = [];
    for (const record of records) {
      if (record.purpose !== "mutation" || record.state === "rejected" || resolvedParents.has(record.operationId)) continue;
      receipts.push(await this.#replayDurableRecord(record, context));
    }
    return receipts;
  }

  #replayDurableRecord(record, context) {
    const payload = record.payload;
    if (!payload || payload.area !== "Living Room" || !SAFE_DOMAINS.has(payload.domain) || !SAFE_STATES.has(payload.target) ||
        typeof payload.entity_id !== "string" || typeof payload.expected_revision !== "string") {
      return Promise.reject(new HomeAssistantError("durable record malformed"));
    }
    const capabilityEntry = [...this.#capabilities.entries()].find(([, capability]) =>
      capability.entityId === payload.entity_id && capability.domain === payload.domain && capability.generation === this.#generation);
    if (!capabilityEntry) return Promise.reject(new HomeAssistantError("durable entity unavailable"));
    return this.setPower({ operationId: record.operationId, handle: capabilityEntry[0], value: payload.target,
      expectedRevision: payload.expected_revision }, {
      ...context,
      durablePurpose: record.purpose,
      parentOperationId: record.parentOperationId,
    });
  }
}
