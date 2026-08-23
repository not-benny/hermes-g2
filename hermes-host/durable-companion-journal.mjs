import { randomBytes } from "node:crypto";
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";

const OPERATION_ID = /^[A-Za-z0-9._-]{12,128}$/;
const FINGERPRINT = /^[a-f0-9]{64}$/;
const OUTCOMES = new Set(["accepted", "rejected", "duplicate", "outcome_unknown"]);

function validateRecord(record) {
  const allowed = new Set(["operationId", "fingerprint", "status", "outcome"]);
  return record && typeof record === "object" && !Array.isArray(record) &&
    Object.keys(record).every((key) => allowed.has(key)) &&
    OPERATION_ID.test(record.operationId ?? "") &&
    FINGERPRINT.test(record.fingerprint ?? "") && ["reserved", "dispatched", "complete", "outcome_unknown"].includes(record.status) &&
    (record.outcome === undefined || OUTCOMES.has(record.outcome)) &&
    (record.status === "complete" ? record.outcome !== undefined : record.outcome === undefined);
}

/**
 * Minimal synchronous operation-ID journal for the low-volume companion RPCs.
 * It stores only opaque IDs, SHA-256 fingerprints, and outcomes—never command
 * bodies, provider IDs, credentials, prompts, or response payloads.
 */
export class DurableCompanionJournal {
  #path;
  #records = new Map();

  constructor({ path }) {
    if (typeof path !== "string" || !isAbsolute(path)) throw new Error("companion journal path must be absolute");
    this.#path = path;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    if (existsSync(path)) {
      const metadata = lstatSync(path);
      if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.nlink !== 1 || (metadata.mode & 0o077) !== 0 ||
          (typeof process.getuid === "function" && metadata.uid !== process.getuid())) {
        throw new Error("companion journal must be one owner-only regular non-linked file");
      }
      let parsed;
      try { parsed = JSON.parse(readFileSync(path, "utf8")); }
      catch { throw new Error("companion journal is malformed"); }
      if (parsed?.version !== 1 || !Array.isArray(parsed.records) || !parsed.records.every(validateRecord)) {
        throw new Error("companion journal is malformed");
      }
      for (const record of parsed.records) {
        if (this.#records.has(record.operationId)) throw new Error("companion journal contains duplicate operation IDs");
        this.#records.set(record.operationId, structuredClone(record));
      }
    }
  }

  records() { return [...this.#records.values()].map((record) => structuredClone(record)); }

  reserve(record) {
    if (!validateRecord(record) || record.status !== "reserved" || record.outcome !== undefined) {
      throw new Error("companion reservation is invalid");
    }
    const existing = this.#records.get(record.operationId);
    if (existing) {
      if (existing.fingerprint !== record.fingerprint) throw new Error("operation ID fingerprint conflict");
      return false;
    }
    this.#records.set(record.operationId, structuredClone(record));
    try { this.#save(); }
    catch (error) { this.#records.delete(record.operationId); throw error; }
    return true;
  }

  complete(operationId, outcome) {
    if (!OPERATION_ID.test(operationId ?? "") || !OUTCOMES.has(outcome)) throw new Error("companion outcome is invalid");
    const existing = this.#records.get(operationId);
    if (!existing) throw new Error("companion operation was not reserved");
    if (existing.status === "complete") return existing.outcome === outcome;
    this.#records.set(operationId, { ...existing, status: "complete", outcome });
    this.#save();
    return true;
  }

  #save() {
    const temporary = `${this.#path}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
    let descriptor = null;
    try {
      descriptor = openSync(temporary, "wx", 0o600);
      writeFileSync(descriptor, `${JSON.stringify({ version: 1, records: this.records() })}\n`, "utf8");
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = null;
      renameSync(temporary, this.#path);
      const directory = openSync(dirname(this.#path), "r");
      try { fsyncSync(directory); } finally { closeSync(directory); }
    } finally {
      if (descriptor !== null) closeSync(descriptor);
      try { unlinkSync(temporary); } catch (error) { if (error?.code !== "ENOENT") throw error; }
    }
  }
}
