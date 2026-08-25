import {
  getStringSetting,
  hasStoredSecretSetting,
  onSettingsStoreChanged,
  removeSecretSetting,
  setStringSetting,
} from "../native/settings-store";
import { validateDisplayText } from "./display-policy";

declare const java: any;

export const DIRECT_NOTIFICATION_STORAGE_KEY = "assistant.directNotifications.v1";
export const DIRECT_NOTIFICATION_SCHEMA_VERSION = 1;
export const MAX_PENDING_DIRECT_NOTIFICATIONS = 32;
export const MAX_DIRECT_NOTIFICATION_TOMBSTONES = 128;
export const MAX_DIRECT_NOTIFICATION_ENCODED_BYTES = 32 * 1024;

const OPERATION_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const MAX_JAVASCRIPT_DATE_MS = 8_640_000_000_000_000;
const FORBIDDEN_BIDI = new Set([
  0x061c, 0x200e, 0x200f,
  0x2028, 0x2029,
  0x202a, 0x202b, 0x202c, 0x202d, 0x202e,
  0x2066, 0x2067, 0x2068, 0x2069,
]);

export type PendingDirectNotification = {
  operationHash: string;
  digest: string;
  text: string;
  receivedAtMs: number;
  insertionRevision: number;
};

type DirectNotificationTombstone = {
  operationHash: string;
  digest: string;
  receivedAtMs: number;
  deliveredAtMs: number;
};

type DirectNotificationDocument = {
  version: 1;
  revision: number;
  pending: PendingDirectNotification[];
  delivered: DirectNotificationTombstone[];
};

export type DirectNotificationSnapshot = {
  available: boolean;
  revision: number;
  pending: PendingDirectNotification[];
};

export type DirectNotificationIdentity = Pick<
  PendingDirectNotification,
  "operationHash" | "digest" | "insertionRevision"
>;

export type DirectNotificationAcceptance = {
  status: "queued" | "historical_acknowledgement";
  identity: DirectNotificationIdentity | null;
};

export type DirectNotificationPersistence = {
  hasStoredValue?: () => boolean;
  load: () => string;
  save: (encoded: string) => void;
  purge: () => void;
  subscribe?: (listener: () => void) => () => void;
};

export type DirectNotificationStoreDependencies = {
  persistence: DirectNotificationPersistence;
  digest: (text: string) => string;
  now?: () => number;
};

export type DirectNotificationErrorCode =
  | "invalid_operation_id"
  | "invalid_text"
  | "operation_conflict"
  | "capacity"
  | "superseded"
  | "persistence_failed"
  | "stale"
  | "unavailable";

/** Content-free failure boundary: notification text must never reach logs or tool errors. */
export class DirectNotificationStoreError extends Error {
  constructor(readonly code: DirectNotificationErrorCode) {
    super(code);
    this.name = "DirectNotificationStoreError";
  }
}

function emptyDocument(): DirectNotificationDocument {
  return { version: 1, revision: 0, pending: [], delivered: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      const low = value.charCodeAt(index + 1);
      if (low < 0xdc00 || low > 0xdfff) return Number.POSITIVE_INFINITY;
      bytes += 4;
      index++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return Number.POSITIVE_INFINITY;
    } else bytes += 3;
  }
  return bytes;
}

function isSafeTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 &&
    (value as number) <= MAX_JAVASCRIPT_DATE_MS;
}

/** Reject raw unsafe scalars before trim/NFC so canonicalisation cannot launder them. */
export function normalizeDirectNotificationText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    let scalar = code;
    if (code >= 0xd800 && code <= 0xdbff) {
      const low = value.charCodeAt(index + 1);
      if (!Number.isInteger(low) || low < 0xdc00 || low > 0xdfff) return null;
      scalar = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00);
      index++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return null;
    }
    if (scalar <= 0x1f || (scalar >= 0x7f && scalar <= 0x9f) || FORBIDDEN_BIDI.has(scalar)) {
      return null;
    }
  }
  let normalized: string;
  try { normalized = value.normalize("NFC").trim(); }
  catch { return null; }
  return validateDisplayText(normalized) === normalized ? normalized : null;
}

function validatePending(raw: unknown, documentRevision: number): PendingDirectNotification | null {
  if (!isRecord(raw) || !hasExactKeys(raw, [
    "operationHash", "digest", "text", "receivedAtMs", "insertionRevision",
  ])) return null;
  if (typeof raw.operationHash !== "string" || !DIGEST_PATTERN.test(raw.operationHash)) return null;
  if (typeof raw.digest !== "string" || !DIGEST_PATTERN.test(raw.digest)) return null;
  if (typeof raw.text !== "string" || normalizeDirectNotificationText(raw.text) !== raw.text) return null;
  if (!isSafeTimestamp(raw.receivedAtMs)) return null;
  if (
    !Number.isSafeInteger(raw.insertionRevision) ||
    (raw.insertionRevision as number) < 1 ||
    (raw.insertionRevision as number) > documentRevision
  ) return null;
  return {
    operationHash: raw.operationHash,
    digest: raw.digest,
    text: raw.text,
    receivedAtMs: raw.receivedAtMs,
    insertionRevision: raw.insertionRevision as number,
  };
}

function validateTombstone(raw: unknown): DirectNotificationTombstone | null {
  if (!isRecord(raw) || !hasExactKeys(raw, [
    "operationHash", "digest", "receivedAtMs", "deliveredAtMs",
  ])) return null;
  if (typeof raw.operationHash !== "string" || !DIGEST_PATTERN.test(raw.operationHash)) return null;
  if (typeof raw.digest !== "string" || !DIGEST_PATTERN.test(raw.digest)) return null;
  if (!isSafeTimestamp(raw.receivedAtMs) || !isSafeTimestamp(raw.deliveredAtMs)) return null;
  return {
    operationHash: raw.operationHash,
    digest: raw.digest,
    receivedAtMs: raw.receivedAtMs,
    deliveredAtMs: raw.deliveredAtMs,
  };
}

/** Strict decoder. Non-empty invalid/future documents remain preserved and unavailable. */
export function decodeDirectNotificationDocument(encoded: string): DirectNotificationDocument | null {
  if (!encoded || utf8ByteLength(encoded) > MAX_DIRECT_NOTIFICATION_ENCODED_BYTES) return null;
  let raw: unknown;
  try { raw = JSON.parse(encoded); } catch { return null; }
  if (!isRecord(raw) || !hasExactKeys(raw, ["version", "revision", "pending", "delivered"])) return null;
  if (raw.version !== DIRECT_NOTIFICATION_SCHEMA_VERSION) return null;
  if (!Number.isSafeInteger(raw.revision) || (raw.revision as number) < 0) return null;
  if (!Array.isArray(raw.pending) || raw.pending.length > MAX_PENDING_DIRECT_NOTIFICATIONS) return null;
  if (!Array.isArray(raw.delivered) || raw.delivered.length > MAX_DIRECT_NOTIFICATION_TOMBSTONES) return null;

  const pending: PendingDirectNotification[] = [];
  const delivered: DirectNotificationTombstone[] = [];
  const operationHashes = new Set<string>();
  let priorInsertionRevision = 0;
  for (const candidate of raw.pending) {
    const record = validatePending(candidate, raw.revision as number);
    if (
      !record || operationHashes.has(record.operationHash) ||
      record.insertionRevision <= priorInsertionRevision
    ) return null;
    operationHashes.add(record.operationHash);
    priorInsertionRevision = record.insertionRevision;
    pending.push(record);
  }
  for (const candidate of raw.delivered) {
    const record = validateTombstone(candidate);
    if (!record || operationHashes.has(record.operationHash)) return null;
    operationHashes.add(record.operationHash);
    delivered.push(record);
  }
  return { version: 1, revision: raw.revision as number, pending, delivered };
}

function clonePending(record: PendingDirectNotification): PendingDirectNotification {
  return { ...record };
}

function cloneDocument(document: DirectNotificationDocument): DirectNotificationDocument {
  return {
    version: 1,
    revision: document.revision,
    pending: document.pending.map(clonePending),
    delivered: document.delivered.map((record) => ({ ...record })),
  };
}

function encodeDocument(document: DirectNotificationDocument): string {
  const encoded = JSON.stringify(document);
  if (utf8ByteLength(encoded) > MAX_DIRECT_NOTIFICATION_ENCODED_BYTES) {
    throw new DirectNotificationStoreError("capacity");
  }
  return encoded;
}

export class DirectNotificationStore {
  private document = emptyDocument();
  private available = false;
  private lastEncoded = "";
  private readonly listeners = new Set<(snapshot: DirectNotificationSnapshot) => void>();
  private unsubscribePersistence: (() => void) | null = null;
  private readonly now: () => number;

  constructor(private readonly dependencies: DirectNotificationStoreDependencies) {
    this.now = dependencies.now ?? (() => Date.now());
    this.reload();
    this.unsubscribePersistence = dependencies.persistence.subscribe?.(() => this.reload()) ?? null;
  }

  dispose(): void {
    this.unsubscribePersistence?.();
    this.unsubscribePersistence = null;
    this.listeners.clear();
  }

  snapshot(): DirectNotificationSnapshot {
    return {
      available: this.available,
      revision: this.document.revision,
      pending: this.document.pending.map(clonePending),
    };
  }

  onChange(listener: (snapshot: DirectNotificationSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  accept(
    input: { operationId: string; text: string },
    guard?: () => boolean,
  ): DirectNotificationAcceptance {
    this.assertAvailable();
    if (typeof input?.operationId !== "string" || !OPERATION_ID_PATTERN.test(input.operationId)) {
      throw new DirectNotificationStoreError("invalid_operation_id");
    }
    const text = normalizeDirectNotificationText(input.text);
    if (!text) throw new DirectNotificationStoreError("invalid_text");
    const operationHash = this.safeDigest(input.operationId);
    const digest = this.safeDigest(text);

    const pending = this.document.pending.find((record) => record.operationHash === operationHash);
    if (pending) {
      if (pending.digest !== digest) throw new DirectNotificationStoreError("operation_conflict");
      this.assertGuard(guard);
      return {
        status: "queued",
        identity: {
          operationHash,
          digest,
          insertionRevision: pending.insertionRevision,
        },
      };
    }
    const delivered = this.document.delivered.find((record) => record.operationHash === operationHash);
    if (delivered) {
      if (delivered.digest !== digest) throw new DirectNotificationStoreError("operation_conflict");
      this.assertGuard(guard);
      return { status: "historical_acknowledgement", identity: null };
    }
    if (this.document.pending.length >= MAX_PENDING_DIRECT_NOTIFICATIONS) {
      throw new DirectNotificationStoreError("capacity");
    }

    const revision = this.nextRevision();
    const record: PendingDirectNotification = {
      operationHash,
      digest,
      text,
      receivedAtMs: this.safeNow(),
      insertionRevision: revision,
    };
    const next = cloneDocument(this.document);
    next.revision = revision;
    next.pending.push(record);
    // Delivered history is lower-value than a new pending reminder. Prune the
    // oldest tombstones as needed so history can never consume the advertised
    // 32-item pending capacity; pending records are never evicted.
    this.commit(next, guard, true);
    return {
      status: "queued",
      identity: { operationHash, digest, insertionRevision: revision },
    };
  }

  /** FIFO head; the returned private text is a detached copy. */
  peek(): PendingDirectNotification | null {
    this.assertAvailable();
    return this.document.pending.length ? clonePending(this.document.pending[0]!) : null;
  }

  /**
   * Remove private text only after the exact current card received a strict frame
   * ACK. A compact content-free tombstone preserves retry idempotency.
   */
  acknowledge(identity: DirectNotificationIdentity, guard?: () => boolean): boolean {
    this.assertAvailable();
    const index = this.document.pending.findIndex((record) =>
      record.operationHash === identity.operationHash &&
      record.digest === identity.digest &&
      record.insertionRevision === identity.insertionRevision,
    );
    if (index < 0) {
      const delivered = this.document.delivered.find((record) =>
        record.operationHash === identity.operationHash && record.digest === identity.digest,
      );
      if (delivered) {
        this.assertGuard(guard);
        return false;
      }
      throw new DirectNotificationStoreError("stale");
    }
    const current = this.document.pending[index]!;
    const next = cloneDocument(this.document);
    next.revision = this.nextRevision();
    next.pending.splice(index, 1);
    next.delivered = [...next.delivered, {
      operationHash: current.operationHash,
      digest: current.digest,
      receivedAtMs: current.receivedAtMs,
      deliveredAtMs: this.safeNow(),
    }].slice(-MAX_DIRECT_NOTIFICATION_TOMBSTONES);
    this.commit(next, guard, true);
    return true;
  }

  /** Explicit recovery hook for a future user-confirmed Settings action. */
  discardUnreadableData(): void {
    if (this.available) throw new DirectNotificationStoreError("unavailable");
    try { this.dependencies.persistence.purge(); }
    catch { throw new DirectNotificationStoreError("persistence_failed"); }
    this.document = emptyDocument();
    this.lastEncoded = "";
    this.available = true;
    this.emit();
  }

  private safeDigest(text: string): string {
    let digest: string;
    try { digest = this.dependencies.digest(text).toLowerCase(); }
    catch { throw new DirectNotificationStoreError("unavailable"); }
    if (!DIGEST_PATTERN.test(digest)) throw new DirectNotificationStoreError("unavailable");
    return digest;
  }

  private safeNow(): number {
    const value = this.now();
    if (!isSafeTimestamp(value)) throw new DirectNotificationStoreError("unavailable");
    return value;
  }

  private nextRevision(): number {
    if (this.document.revision >= Number.MAX_SAFE_INTEGER) throw new DirectNotificationStoreError("capacity");
    return this.document.revision + 1;
  }

  private assertGuard(guard?: () => boolean): void {
    if (!guard) return;
    try { if (guard()) return; } catch { /* failed probes deny */ }
    throw new DirectNotificationStoreError("superseded");
  }

  private assertAvailable(): void {
    if (!this.available) {
      this.reload();
      if (!this.available) throw new DirectNotificationStoreError("unavailable");
    }
  }

  private commit(
    next: DirectNotificationDocument,
    guard?: () => boolean,
    pruneOldestTombstones = false,
  ): void {
    let candidate = next;
    let encoded: string;
    while (true) {
      try {
        encoded = encodeDocument(candidate);
        break;
      } catch (error) {
        if (
          !pruneOldestTombstones ||
          !(error instanceof DirectNotificationStoreError) ||
          error.code !== "capacity" ||
          candidate.delivered.length === 0
        ) throw error;
        candidate = cloneDocument(candidate);
        candidate.delivered.shift();
      }
    }
    // Keep authorization adjacent to the synchronous encrypted transaction.
    this.assertGuard(guard);
    try { this.dependencies.persistence.save(encoded); }
    catch { throw new DirectNotificationStoreError("persistence_failed"); }
    this.document = candidate;
    this.available = true;
    this.lastEncoded = encoded;
    this.emit();
  }

  private reload(): void {
    let storedValuePresent: boolean | null = null;
    try { storedValuePresent = this.dependencies.persistence.hasStoredValue?.() ?? null; }
    catch { this.markUnavailable(); return; }
    let encoded: string;
    try { encoded = this.dependencies.persistence.load(); }
    catch { this.markUnavailable(); return; }
    if (!encoded) {
      if (storedValuePresent === true) { this.markUnavailable(); return; }
      if (this.available && this.lastEncoded === "") return;
      this.document = emptyDocument();
      this.lastEncoded = "";
      this.available = true;
      this.emit();
      return;
    }
    if (this.available && encoded === this.lastEncoded) return;
    const decoded = decodeDirectNotificationDocument(encoded);
    if (!decoded) { this.markUnavailable(); return; }
    this.document = decoded;
    this.lastEncoded = encoded;
    this.available = true;
    this.emit();
  }

  private markUnavailable(): void {
    // Scrub previously decrypted private text from every observable RAM path.
    this.document = emptyDocument();
    this.lastEncoded = "";
    this.available = false;
    this.emit();
  }

  private emit(): void {
    const snapshot = this.snapshot();
    for (const listener of Array.from(this.listeners)) {
      try { listener(snapshot); } catch { /* observers do not own persistence */ }
    }
  }
}

function nativeDigest(text: string): string {
  const bytes = new java.lang.String(text).getBytes(java.nio.charset.StandardCharsets.UTF_8);
  const digest = java.security.MessageDigest.getInstance("SHA-256").digest(bytes);
  let hex = "";
  for (let index = 0; index < digest.length; index++) {
    hex += ((Number(digest[index]) & 0xff) + 0x100).toString(16).slice(1);
  }
  return hex;
}

const nativePersistence: DirectNotificationPersistence = {
  hasStoredValue: () => hasStoredSecretSetting(DIRECT_NOTIFICATION_STORAGE_KEY),
  load: () => getStringSetting(DIRECT_NOTIFICATION_STORAGE_KEY, ""),
  save: (encoded) => setStringSetting(DIRECT_NOTIFICATION_STORAGE_KEY, encoded),
  purge: () => removeSecretSetting(DIRECT_NOTIFICATION_STORAGE_KEY),
  subscribe: (listener) => onSettingsStoreChanged((key) => {
    if (key === DIRECT_NOTIFICATION_STORAGE_KEY) listener();
  }),
};

export const directNotificationStore = new DirectNotificationStore({
  persistence: nativePersistence,
  digest: nativeDigest,
});
