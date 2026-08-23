import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, rename, unlink } from "node:fs/promises";
import { createServer } from "node:net";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

function validateOperationId(operationId) {
  if (typeof operationId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(operationId) ||
      operationId === "constructor" || operationId === "prototype") {
    throw new Error("durable ledger operation ID is invalid");
  }
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

function fingerprint(value) {
  return JSON.stringify(canonicalize(value));
}

function publicRecord(record, replay) {
  const metadata = { purpose: record.purpose ?? "mutation", parentOperationId: record.parentOperationId ?? null };
  if (record.state === "completed") return { state: "completed", replay, outcome: structuredClone(record.outcome), ...metadata };
  if (record.state === "rejected") return { state: "rejected", replay, code: record.code, ...metadata };
  return { state: "pending", replay, ...metadata };
}

export async function acquireDurableLedgerLease(path) {
  if (typeof path !== "string" || !isAbsolute(path)) throw new Error("durable ledger path must be absolute");
  const normalized = resolve(path);
  await mkdir(dirname(normalized), { recursive: true, mode: 0o700 });
  try {
    const metadata = await lstat(normalized);
    if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.nlink !== 1 || (metadata.mode & 0o077) !== 0 ||
        (typeof process.getuid === "function" && metadata.uid !== process.getuid())) {
      throw new Error("durable ledger must be one owner-only regular non-linked file");
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const canonicalPath = join(await realpath(dirname(normalized)), basename(normalized));
  if (process.platform === "linux") {
    const name = `\0hermes-g2-ledger-${createHash("sha256").update(canonicalPath).digest("hex")}`;
    const server = createServer();
    try {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(name, resolve);
      });
    } catch (error) {
      if (error?.code === "EADDRINUSE") throw new Error("durable ledger is already owned by a live process");
      throw error;
    }
    let released = false;
    const release = async () => {
      if (released) return;
      released = true;
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    };
    release.canonicalPath = canonicalPath;
    return release;
  }

  const lockPath = `${canonicalPath}.lock`;
  const owner = `${process.pid}:${randomBytes(16).toString("hex")}`;
  let handle;
  try { handle = await open(lockPath, "wx", 0o600); }
  catch (error) {
    if (error?.code === "EEXIST") throw new Error("durable ledger lease exists; remove it only after proving the owner is dead");
    throw error;
  }
  await handle.writeFile(`${owner}\n`, "utf8");
  await handle.sync();
  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    await handle.close();
    const current = await readFile(lockPath, "utf8").catch(() => "");
    if (current.trim() === owner) await unlink(lockPath);
  };
  release.canonicalPath = canonicalPath;
  return release;
}

/**
 * Small private-host JSON ledger for provider mutation idempotency. The file may
 * contain provider IDs and state snapshots, so it is always written mode 0600
 * and must remain outside the repository. It never stores credentials.
 */
export class DurableMutationLedger {
  #path;
  #queue = Promise.resolve();

  constructor({ path }) {
    if (typeof path !== "string" || !isAbsolute(path)) throw new Error("durable ledger path must be absolute");
    this.#path = path;
  }

  reserve(operationId, payload, { purpose = "mutation", parentOperationId = null } = {}) {
    try { validateOperationId(operationId); } catch (error) { return Promise.reject(error); }
    if ((purpose !== "mutation" && purpose !== "restore") || (parentOperationId !== null && typeof parentOperationId !== "string")) {
      return Promise.reject(new Error("durable ledger operation metadata is invalid"));
    }
    if (parentOperationId !== null) {
      try { validateOperationId(parentOperationId); } catch (error) { return Promise.reject(error); }
    }
    return this.#serialized(async () => {
      const data = await this.#load();
      const existing = data.operations[operationId];
      const payloadFingerprint = fingerprint(payload);
      if (existing) {
        if (existing.payloadFingerprint !== payloadFingerprint || (existing.purpose ?? "mutation") !== purpose ||
            (existing.parentOperationId ?? null) !== parentOperationId) {
          throw new Error("operation ID was reused for a different payload or purpose");
        }
        return publicRecord(existing, true);
      }
      data.operations[operationId] = { state: "pending", purpose, parentOperationId,
        payloadFingerprint, payload: canonicalize(structuredClone(payload)) };
      await this.#save(data);
      return publicRecord(data.operations[operationId], false);
    });
  }

  complete(operationId, outcome) {
    return this.#finish(operationId, { state: "completed", outcome: canonicalize(structuredClone(outcome)) });
  }

  reject(operationId, code) {
    if (typeof code !== "string" || !/^[a-z_]{1,64}$/.test(code)) return Promise.reject(new Error("ledger rejection code is invalid"));
    return this.#finish(operationId, { state: "rejected", code });
  }

  get(operationId) {
    try { validateOperationId(operationId); } catch (error) { return Promise.reject(error); }
    return this.#serialized(async () => {
      const record = (await this.#load()).operations[operationId];
      return record ? { ...publicRecord(record, true), payload: structuredClone(record.payload) } : null;
    });
  }

  list() {
    return this.#serialized(async () => {
      const data = await this.#load();
      return Object.entries(data.operations).map(([operationId, record]) => ({
        operationId, ...publicRecord(record, true), payload: structuredClone(record.payload),
      }));
    });
  }

  forget(operationId) {
    try { validateOperationId(operationId); } catch (error) { return Promise.reject(error); }
    return this.#serialized(async () => {
      const data = await this.#load();
      if (!data.operations[operationId]) return false;
      delete data.operations[operationId];
      await this.#save(data);
      return true;
    });
  }

  #finish(operationId, patch) {
    try { validateOperationId(operationId); } catch (error) { return Promise.reject(error); }
    return this.#serialized(async () => {
      const data = await this.#load();
      const existing = data.operations[operationId];
      if (!existing) throw new Error("operation was not reserved");
      if (existing.state !== "pending") return publicRecord(existing, true);
      data.operations[operationId] = { ...existing, ...patch };
      await this.#save(data);
      return publicRecord(data.operations[operationId], false);
    });
  }

  #serialized(task) {
    const result = this.#queue.then(task);
    this.#queue = result.catch(() => undefined);
    return result;
  }

  async #load() {
    try {
      const parsed = JSON.parse(await readFile(this.#path, "utf8"));
      if (parsed?.version !== 1 || !parsed.operations || typeof parsed.operations !== "object" || Array.isArray(parsed.operations)) {
        throw new Error("durable ledger is malformed");
      }
      return parsed;
    } catch (error) {
      if (error?.code === "ENOENT") return { version: 1, operations: {} };
      if (error instanceof SyntaxError) throw new Error("durable ledger is malformed");
      throw error;
    }
  }

  async #save(data) {
    await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
    const temporary = `${this.#path}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
    let handle;
    try {
      handle = await open(temporary, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(data)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = null;
      await rename(temporary, this.#path);
      const directory = await open(dirname(this.#path), "r");
      try { await directory.sync(); } finally { await directory.close(); }
    } finally {
      if (handle) await handle.close().catch(() => undefined);
      await unlink(temporary).catch((error) => { if (error?.code !== "ENOENT") throw error; });
    }
  }
}
