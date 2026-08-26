import {
  getStringSetting,
  hasStoredSecretSetting,
  onSettingsStoreChanged,
  removeSecretSetting,
  setStringSetting,
} from "../native/settings-store";

export const CAPTURE_STORAGE_KEY = "captures.store.v1";
export const CAPTURE_SCHEMA_VERSION = 1 as const;
export const MAX_CAPTURES = 128;
export const MAX_CAPTURE_SCALARS = 2_000;
export const MAX_CAPTURE_BYTES = 8 * 1024;
export const MAX_CAPTURE_DOCUMENT_BYTES = 256 * 1024;

const ID = /^cap_[a-f0-9]{32}$/;
const BIDI = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;

export type CaptureRecord = {
  id: string;
  text: string;
  createdAtMs: number;
  updatedAtMs: number;
};

export type CaptureDocument = {
  version: 1;
  revision: number;
  captures: CaptureRecord[];
};

export type CaptureSnapshot = {
  available: boolean;
  revision: number;
  captures: CaptureRecord[];
};

export type CaptureErrorCode = "invalid_text" | "not_found" | "capacity" | "unavailable" | "persistence_failed";

export class CaptureError extends Error {
  constructor(readonly code: CaptureErrorCode) {
    super(code);
    this.name = "CaptureError";
  }
}

export type CapturePersistence = {
  hasStoredValue?: () => boolean;
  load: () => string;
  save: (encoded: string) => void;
  purge: () => void;
  subscribe?: (listener: () => void) => () => void;
};

export type CaptureStoreDependencies = {
  persistence: CapturePersistence;
  now?: () => number;
  createId?: () => string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function normalizeCaptureText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  for (const scalar of value) {
    const code = scalar.codePointAt(0)!;
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f) || BIDI.test(scalar)) return null;
  }
  let normalized: string;
  try { normalized = value.normalize("NFC").trim(); } catch { return null; }
  if (!normalized || Array.from(normalized).length > MAX_CAPTURE_SCALARS || bytes(normalized) > MAX_CAPTURE_BYTES) return null;
  return normalized;
}

function timestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

export function decodeCaptureDocument(encoded: string): CaptureDocument | null {
  if (!encoded || bytes(encoded) > MAX_CAPTURE_DOCUMENT_BYTES) return null;
  let raw: unknown;
  try { raw = JSON.parse(encoded); } catch { return null; }
  if (!isRecord(raw) || !exact(raw, ["version", "revision", "captures"]) || raw.version !== 1 ||
      !Number.isSafeInteger(raw.revision) || Number(raw.revision) < 0 || !Array.isArray(raw.captures) ||
      raw.captures.length > MAX_CAPTURES) return null;
  const ids = new Set<string>();
  const captures: CaptureRecord[] = [];
  for (const item of raw.captures) {
    if (!isRecord(item) || !exact(item, ["id", "text", "createdAtMs", "updatedAtMs"]) ||
        typeof item.id !== "string" || !ID.test(item.id) || ids.has(item.id) ||
        normalizeCaptureText(item.text) !== item.text || !timestamp(item.createdAtMs) ||
        !timestamp(item.updatedAtMs) || Number(item.updatedAtMs) < Number(item.createdAtMs)) return null;
    ids.add(item.id);
    captures.push({ id: item.id, text: item.text as string, createdAtMs: item.createdAtMs as number, updatedAtMs: item.updatedAtMs as number });
  }
  return { version: 1, revision: raw.revision as number, captures };
}

function encodeCaptureDocument(document: CaptureDocument): string {
  const encoded = JSON.stringify(document);
  if (bytes(encoded) > MAX_CAPTURE_DOCUMENT_BYTES) throw new CaptureError("capacity");
  return encoded;
}

function cloneDocument(document: CaptureDocument): CaptureDocument {
  return { version: 1, revision: document.revision, captures: document.captures.map((capture) => ({ ...capture })) };
}

function emptyDocument(): CaptureDocument {
  return { version: 1, revision: 0, captures: [] };
}

function nativeId(): string {
  const bytesValue = new Uint8Array(16);
  const cryptoObject = (globalThis as any).crypto;
  if (cryptoObject?.getRandomValues) cryptoObject.getRandomValues(bytesValue);
  else {
    for (let index = 0; index < bytesValue.length; index++) bytesValue[index] = Math.floor(Math.random() * 256);
  }
  return `cap_${Array.from(bytesValue, (value) => value.toString(16).padStart(2, "0")).join("")}`;
}

export class CaptureStore {
  private document = emptyDocument();
  private available = true;
  private lastEncoded = "";
  private readonly listeners = new Set<(snapshot: CaptureSnapshot) => void>();
  private readonly now: () => number;
  private readonly createId: () => string;
  private readonly unsubscribePersistence: (() => void) | null;

  constructor(private readonly dependencies: CaptureStoreDependencies) {
    this.now = dependencies.now ?? (() => Date.now());
    this.createId = dependencies.createId ?? nativeId;
    this.reload();
    this.unsubscribePersistence = dependencies.persistence.subscribe?.(() => this.reload()) ?? null;
  }

  dispose(): void {
    this.unsubscribePersistence?.();
    this.listeners.clear();
  }

  snapshot(): CaptureSnapshot {
    return { available: this.available, revision: this.document.revision, captures: this.document.captures.map((capture) => ({ ...capture })) };
  }

  onChange(listener: (snapshot: CaptureSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  create(text: unknown): CaptureRecord {
    this.assertAvailable();
    const normalized = normalizeCaptureText(text);
    if (!normalized) throw new CaptureError("invalid_text");
    if (this.document.captures.length >= MAX_CAPTURES) throw new CaptureError("capacity");
    const now = this.safeNow();
    const id = this.nextId();
    const next = cloneDocument(this.document);
    next.revision = this.nextRevision();
    const record = { id, text: normalized, createdAtMs: now, updatedAtMs: now };
    next.captures.unshift(record);
    this.commit(next);
    return { ...record };
  }

  update(id: string, text: unknown): CaptureRecord {
    this.assertAvailable();
    const normalized = normalizeCaptureText(text);
    if (!normalized) throw new CaptureError("invalid_text");
    const index = this.document.captures.findIndex((capture) => capture.id === id);
    if (index < 0) throw new CaptureError("not_found");
    const next = cloneDocument(this.document);
    const current = next.captures[index]!;
    const updated = { ...current, text: normalized, updatedAtMs: Math.max(current.createdAtMs, this.safeNow()) };
    next.revision = this.nextRevision();
    next.captures[index] = updated;
    this.commit(next);
    return { ...updated };
  }

  remove(id: string): void {
    this.assertAvailable();
    const next = cloneDocument(this.document);
    const before = next.captures.length;
    next.captures = next.captures.filter((capture) => capture.id !== id);
    if (next.captures.length === before) throw new CaptureError("not_found");
    next.revision = this.nextRevision();
    this.commit(next);
  }

  discardUnreadableData(): void {
    if (this.available) throw new CaptureError("unavailable");
    try { this.dependencies.persistence.purge(); } catch { throw new CaptureError("persistence_failed"); }
    this.document = emptyDocument();
    this.available = true;
    this.lastEncoded = "";
    this.emit();
  }

  private nextId(): string {
    const ids = new Set(this.document.captures.map((capture) => capture.id));
    for (let attempt = 0; attempt < 8; attempt++) {
      const candidate = this.createId();
      if (ID.test(candidate) && !ids.has(candidate)) return candidate;
    }
    throw new CaptureError("unavailable");
  }

  private nextRevision(): number {
    if (this.document.revision >= Number.MAX_SAFE_INTEGER) throw new CaptureError("capacity");
    return this.document.revision + 1;
  }

  private safeNow(): number {
    const value = this.now();
    if (!timestamp(value)) throw new CaptureError("unavailable");
    return value;
  }

  private assertAvailable(): void {
    if (!this.available) {
      this.reload();
      if (!this.available) throw new CaptureError("unavailable");
    }
  }

  private commit(next: CaptureDocument): void {
    const encoded = encodeCaptureDocument(next);
    try { this.dependencies.persistence.save(encoded); } catch { throw new CaptureError("persistence_failed"); }
    this.document = next;
    this.available = true;
    this.lastEncoded = encoded;
    this.emit();
  }

  private reload(): void {
    let stored: boolean | null = null;
    try { stored = this.dependencies.persistence.hasStoredValue?.() ?? null; } catch { this.markUnavailable(); return; }
    let encoded: string;
    try { encoded = this.dependencies.persistence.load(); } catch { this.markUnavailable(); return; }
    if (!encoded) {
      if (stored === true) { this.markUnavailable(); return; }
      if (this.available && this.lastEncoded === "") return;
      this.document = emptyDocument();
      this.available = true;
      this.lastEncoded = "";
      this.emit();
      return;
    }
    if (this.available && encoded === this.lastEncoded) return;
    const decoded = decodeCaptureDocument(encoded);
    if (!decoded) { this.markUnavailable(); return; }
    this.document = decoded;
    this.available = true;
    this.lastEncoded = encoded;
    this.emit();
  }

  private markUnavailable(): void {
    this.document = emptyDocument();
    this.available = false;
    this.lastEncoded = "";
    this.emit();
  }

  private emit(): void {
    const snapshot = this.snapshot();
    for (const listener of Array.from(this.listeners)) {
      try { listener(snapshot); } catch { /* observers never own persistence */ }
    }
  }
}

const nativePersistence: CapturePersistence = {
  hasStoredValue: () => hasStoredSecretSetting(CAPTURE_STORAGE_KEY),
  load: () => getStringSetting(CAPTURE_STORAGE_KEY, ""),
  save: (encoded) => setStringSetting(CAPTURE_STORAGE_KEY, encoded),
  purge: () => removeSecretSetting(CAPTURE_STORAGE_KEY),
  subscribe: (listener) => onSettingsStoreChanged((key) => {
    if (key === CAPTURE_STORAGE_KEY) listener();
  }),
};

export const captureStore = new CaptureStore({ persistence: nativePersistence });
