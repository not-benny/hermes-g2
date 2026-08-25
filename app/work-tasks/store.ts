import {
  getStringSetting,
  hasStoredSecretSetting,
  onSettingsStoreChanged,
  removeSecretSetting,
  setStringSetting,
} from "../native/settings-store";

declare const java: any;

export const WORK_TASKS_STORAGE_KEY = "work.tasks.store.v1";
export const WORK_TASKS_SCHEMA_VERSION = 1;
export const MAX_WORK_TASKS = 64;
export const MAX_WORK_TASK_OPERATIONS = 128;
export const MAX_WORK_TASK_TITLE_SCALARS = 120;
export const MAX_WORK_TASK_TITLE_BYTES = 480;
export const MAX_WORK_TASKS_ENCODED_BYTES = 64 * 1024;

export const WORK_TASK_LANES = ["inbox", "today", "doing", "done"] as const;
export const WORK_TASK_CREATION_LANES = ["inbox", "today", "doing"] as const;

export type WorkTaskLane = (typeof WORK_TASK_LANES)[number];
export type WorkTaskCreationLane = (typeof WORK_TASK_CREATION_LANES)[number];

export type WorkTask = {
  id: string;
  title: string;
  lane: WorkTaskLane;
  blocked: boolean;
  createdAtMs: number;
  updatedAtMs: number;
};

type WorkTaskOperation = {
  operationHash: string;
  digest: string;
  taskId: string;
  lane: WorkTaskCreationLane;
  revision: number;
};

type WorkTasksDocument = {
  version: 1;
  revision: number;
  tasks: WorkTask[];
  operations: WorkTaskOperation[];
};

export type WorkTasksSnapshot = {
  available: boolean;
  revision: number;
  tasks: WorkTask[];
};

export type WorkTaskAddInput = {
  operationId: string;
  title: string;
  lane?: WorkTaskCreationLane;
};

export type WorkTaskReceipt = {
  status: "acknowledged" | "historical_acknowledgement";
  operation_id: string;
  task_id: string;
  lane: WorkTaskCreationLane;
  board_revision: number;
};

export type WorkTasksErrorCode =
  | "invalid_operation_id"
  | "invalid_title"
  | "invalid_lane"
  | "invalid_task_id"
  | "not_found"
  | "operation_conflict"
  | "capacity"
  | "superseded"
  | "persistence_failed"
  | "unavailable";

/** A deliberately content-free error boundary suitable for assistant tools. */
export class WorkTasksError extends Error {
  readonly code: WorkTasksErrorCode;

  constructor(code: WorkTasksErrorCode) {
    super(code);
    this.name = "WorkTasksError";
    this.code = code;
  }
}

export type WorkTasksPersistence = {
  hasStoredValue?: () => boolean;
  load: () => string;
  save: (encoded: string) => void;
  purge: () => void;
  subscribe?: (listener: () => void) => () => void;
};

export type WorkTasksStoreDependencies = {
  persistence: WorkTasksPersistence;
  digest: (text: string) => string;
  createTaskId: () => string;
  now?: () => number;
};

const TASK_ID_PATTERN = /^wt_[a-f0-9]{32}$/;
const OPERATION_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const CREATE_LANE_SET = new Set<string>(WORK_TASK_CREATION_LANES);
const LANE_SET = new Set<string>(WORK_TASK_LANES);
const FORBIDDEN_BIDI = new Set([
  0x061c, 0x200e, 0x200f,
  0x2028, 0x2029,
  0x202a, 0x202b, 0x202c, 0x202d, 0x202e,
  0x2066, 0x2067, 0x2068, 0x2069,
]);

function emptyDocument(): WorkTasksDocument {
  return { version: 1, revision: 0, tasks: [], operations: [] };
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
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

/** Validate and canonicalise task text without ever interpreting it as markup or a command. */
export function normalizeWorkTaskTitle(value: unknown): string {
  if (typeof value !== "string") throw new WorkTasksError("invalid_title");
  // Inspect the raw input first: trim must never launder a leading/trailing
  // newline, control, bidi mark, or unpaired surrogate into accepted text.
  for (const scalar of Array.from(value)) {
    if (isForbiddenTitleScalar(scalar.codePointAt(0)!)) throw new WorkTasksError("invalid_title");
  }
  let title: string;
  try {
    title = value.normalize("NFC").trim();
  } catch {
    throw new WorkTasksError("invalid_title");
  }
  const scalars = Array.from(title);
  if (!title || scalars.length > MAX_WORK_TASK_TITLE_SCALARS || utf8ByteLength(title) > MAX_WORK_TASK_TITLE_BYTES) {
    throw new WorkTasksError("invalid_title");
  }
  for (const scalar of scalars) {
    if (isForbiddenTitleScalar(scalar.codePointAt(0)!)) throw new WorkTasksError("invalid_title");
  }
  return title;
}

function isForbiddenTitleScalar(code: number): boolean {
  return (
    code <= 0x1f ||
    (code >= 0x7f && code <= 0x9f) ||
    (code >= 0xd800 && code <= 0xdfff) ||
    FORBIDDEN_BIDI.has(code)
  );
}

function validateTask(raw: unknown): WorkTask | null {
  if (!isRecord(raw) || !hasExactKeys(raw, ["id", "title", "lane", "blocked", "createdAtMs", "updatedAtMs"])) return null;
  if (typeof raw.id !== "string" || !TASK_ID_PATTERN.test(raw.id)) return null;
  if (typeof raw.title !== "string") return null;
  let title: string;
  try { title = normalizeWorkTaskTitle(raw.title); } catch { return null; }
  if (title !== raw.title) return null;
  if (typeof raw.lane !== "string" || !LANE_SET.has(raw.lane)) return null;
  if (typeof raw.blocked !== "boolean") return null;
  if (!Number.isSafeInteger(raw.createdAtMs) || (raw.createdAtMs as number) < 0) return null;
  if (!Number.isSafeInteger(raw.updatedAtMs) || (raw.updatedAtMs as number) < (raw.createdAtMs as number)) return null;
  return {
    id: raw.id,
    title,
    lane: raw.lane as WorkTaskLane,
    blocked: raw.blocked,
    createdAtMs: raw.createdAtMs as number,
    updatedAtMs: raw.updatedAtMs as number,
  };
}

function validateOperation(raw: unknown, boardRevision: number): WorkTaskOperation | null {
  if (!isRecord(raw) || !hasExactKeys(raw, ["operationHash", "digest", "taskId", "lane", "revision"])) return null;
  if (typeof raw.operationHash !== "string" || !DIGEST_PATTERN.test(raw.operationHash)) return null;
  if (typeof raw.digest !== "string" || !DIGEST_PATTERN.test(raw.digest)) return null;
  if (typeof raw.taskId !== "string" || !TASK_ID_PATTERN.test(raw.taskId)) return null;
  if (typeof raw.lane !== "string" || !CREATE_LANE_SET.has(raw.lane)) return null;
  if (!Number.isSafeInteger(raw.revision) || (raw.revision as number) < 1 || (raw.revision as number) > boardRevision) return null;
  return {
    operationHash: raw.operationHash,
    digest: raw.digest,
    taskId: raw.taskId,
    lane: raw.lane as WorkTaskCreationLane,
    revision: raw.revision as number,
  };
}

/** Strict, fail-closed decoder for the encrypted versioned document. */
export function decodeWorkTasksDocument(encoded: string): WorkTasksDocument | null {
  if (!encoded || utf8ByteLength(encoded) > MAX_WORK_TASKS_ENCODED_BYTES) return null;
  let raw: unknown;
  try { raw = JSON.parse(encoded); } catch { return null; }
  if (!isRecord(raw) || !hasExactKeys(raw, ["version", "revision", "tasks", "operations"])) return null;
  if (raw.version !== WORK_TASKS_SCHEMA_VERSION) return null;
  if (!Number.isSafeInteger(raw.revision) || (raw.revision as number) < 0) return null;
  if (!Array.isArray(raw.tasks) || raw.tasks.length > MAX_WORK_TASKS) return null;
  if (!Array.isArray(raw.operations) || raw.operations.length > MAX_WORK_TASK_OPERATIONS) return null;
  const tasks: WorkTask[] = [];
  const taskIds = new Set<string>();
  for (const candidate of raw.tasks) {
    const task = validateTask(candidate);
    if (!task || taskIds.has(task.id)) return null;
    taskIds.add(task.id);
    tasks.push(task);
  }
  const operations: WorkTaskOperation[] = [];
  const operationHashes = new Set<string>();
  for (const candidate of raw.operations) {
    const operation = validateOperation(candidate, raw.revision as number);
    if (!operation || operationHashes.has(operation.operationHash)) return null;
    operationHashes.add(operation.operationHash);
    operations.push(operation);
  }
  return { version: 1, revision: raw.revision as number, tasks, operations };
}

function cloneTask(task: WorkTask): WorkTask {
  return { ...task };
}

function cloneDocument(document: WorkTasksDocument): WorkTasksDocument {
  return {
    version: 1,
    revision: document.revision,
    tasks: document.tasks.map(cloneTask),
    operations: document.operations.map((operation) => ({ ...operation })),
  };
}

function encodeDocument(document: WorkTasksDocument): string {
  const encoded = JSON.stringify(document);
  if (utf8ByteLength(encoded) > MAX_WORK_TASKS_ENCODED_BYTES) throw new WorkTasksError("capacity");
  return encoded;
}

function assertTaskId(taskId: string): void {
  if (!TASK_ID_PATTERN.test(taskId)) throw new WorkTasksError("invalid_task_id");
}

/**
 * Phone-local Work Tasks state. Every mutation serialises and commits the
 * complete encrypted document before replacing observable in-memory state.
 */
export class WorkTasksStore {
  private document = emptyDocument();
  private available = false;
  private lastEncoded = "";
  private listeners = new Set<(snapshot: WorkTasksSnapshot) => void>();
  private unsubscribePersistence: (() => void) | null = null;
  private readonly now: () => number;

  constructor(private readonly dependencies: WorkTasksStoreDependencies) {
    this.now = dependencies.now ?? (() => Date.now());
    this.reload();
    this.unsubscribePersistence = dependencies.persistence.subscribe?.(() => this.reload()) ?? null;
  }

  dispose(): void {
    this.unsubscribePersistence?.();
    this.unsubscribePersistence = null;
    this.listeners.clear();
  }

  snapshot(): WorkTasksSnapshot {
    return {
      available: this.available,
      revision: this.document.revision,
      tasks: this.document.tasks.map(cloneTask),
    };
  }

  onChange(listener: (snapshot: WorkTasksSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  addTask(input: WorkTaskAddInput, guard?: () => boolean): WorkTaskReceipt {
    this.assertAvailable();
    if (typeof input?.operationId !== "string" || !OPERATION_ID_PATTERN.test(input.operationId)) {
      throw new WorkTasksError("invalid_operation_id");
    }
    const title = normalizeWorkTaskTitle(input.title);
    const lane = input.lane ?? "inbox";
    if (!CREATE_LANE_SET.has(lane)) throw new WorkTasksError("invalid_lane");
    let operationHash: string;
    let digest: string;
    try {
      operationHash = this.dependencies.digest(input.operationId).toLowerCase();
      digest = this.dependencies.digest(`${title}\u0000${lane}`).toLowerCase();
    } catch {
      throw new WorkTasksError("unavailable");
    }
    if (!DIGEST_PATTERN.test(operationHash) || !DIGEST_PATTERN.test(digest)) throw new WorkTasksError("unavailable");

    const prior = this.document.operations.find((operation) => operation.operationHash === operationHash);
    if (prior) {
      if (prior.digest !== digest) throw new WorkTasksError("operation_conflict");
      this.assertGuard(guard);
      return {
        status: "historical_acknowledgement",
        operation_id: input.operationId,
        task_id: prior.taskId,
        lane: prior.lane,
        board_revision: prior.revision,
      };
    }
    if (this.document.tasks.length >= MAX_WORK_TASKS) throw new WorkTasksError("capacity");
    if (this.document.revision >= Number.MAX_SAFE_INTEGER) throw new WorkTasksError("capacity");

    const taskId = this.nextTaskId();
    const timestamp = this.safeNow();
    const revision = this.document.revision + 1;
    const task: WorkTask = { id: taskId, title, lane, blocked: false, createdAtMs: timestamp, updatedAtMs: timestamp };
    const operation: WorkTaskOperation = { operationHash, digest, taskId, lane, revision };
    const next: WorkTasksDocument = {
      version: 1,
      revision,
      tasks: [...this.document.tasks.map(cloneTask), task],
      operations: [...this.document.operations.map((item) => ({ ...item })), operation].slice(-MAX_WORK_TASK_OPERATIONS),
    };
    this.commit(next, guard);
    return {
      status: "acknowledged",
      operation_id: input.operationId,
      task_id: taskId,
      lane,
      board_revision: revision,
    };
  }

  moveTask(taskId: string, lane: WorkTaskLane, guard?: () => boolean): WorkTask {
    assertTaskId(taskId);
    if (!LANE_SET.has(lane)) throw new WorkTasksError("invalid_lane");
    return this.updateTask(taskId, (task) => task.lane === lane
      ? task
      : { ...task, lane, updatedAtMs: this.monotonicUpdatedAt(task) }, guard);
  }

  advanceTask(taskId: string, guard?: () => boolean): WorkTask {
    assertTaskId(taskId);
    this.assertAvailable();
    const task = this.document.tasks.find((candidate) => candidate.id === taskId);
    if (!task) throw new WorkTasksError("not_found");
    const index = WORK_TASK_LANES.indexOf(task.lane);
    return index >= WORK_TASK_LANES.length - 1
      ? cloneTask(task)
      : this.moveTask(taskId, WORK_TASK_LANES[index + 1]!, guard);
  }

  setBlocked(taskId: string, blocked: boolean, guard?: () => boolean): WorkTask {
    assertTaskId(taskId);
    if (typeof blocked !== "boolean") throw new WorkTasksError("unavailable");
    return this.updateTask(taskId, (task) => task.blocked === blocked
      ? task
      : { ...task, blocked, updatedAtMs: this.monotonicUpdatedAt(task) }, guard);
  }

  renameTask(taskId: string, titleValue: unknown, guard?: () => boolean): WorkTask {
    assertTaskId(taskId);
    const title = normalizeWorkTaskTitle(titleValue);
    return this.updateTask(taskId, (task) => task.title === title
      ? task
      : { ...task, title, updatedAtMs: this.monotonicUpdatedAt(task) }, guard);
  }

  deleteTask(taskId: string, guard?: () => boolean): void {
    assertTaskId(taskId);
    this.assertAvailable();
    const index = this.document.tasks.findIndex((task) => task.id === taskId);
    if (index < 0) throw new WorkTasksError("not_found");
    const next = cloneDocument(this.document);
    next.revision = this.nextRevision();
    next.tasks.splice(index, 1);
    this.commit(next, guard);
  }

  clearDone(guard?: () => boolean): number {
    this.assertAvailable();
    const remaining = this.document.tasks.filter((task) => task.lane !== "done");
    const removed = this.document.tasks.length - remaining.length;
    if (!removed) {
      this.assertGuard(guard);
      return 0;
    }
    const next = cloneDocument(this.document);
    next.revision = this.nextRevision();
    next.tasks = remaining.map(cloneTask);
    this.commit(next, guard);
    return removed;
  }

  /** Explicit user-confirmed recovery path for an unreadable encrypted blob. */
  discardUnreadableData(): void {
    if (this.available) throw new WorkTasksError("unavailable");
    try {
      this.dependencies.persistence.purge();
    } catch {
      throw new WorkTasksError("persistence_failed");
    }
    this.document = emptyDocument();
    this.lastEncoded = "";
    this.available = true;
    this.emit();
  }

  private updateTask(taskId: string, update: (task: WorkTask) => WorkTask, guard?: () => boolean): WorkTask {
    this.assertAvailable();
    const index = this.document.tasks.findIndex((task) => task.id === taskId);
    if (index < 0) throw new WorkTasksError("not_found");
    const current = this.document.tasks[index]!;
    const updated = update(cloneTask(current));
    if (
      updated.title === current.title && updated.lane === current.lane &&
      updated.blocked === current.blocked && updated.updatedAtMs === current.updatedAtMs
    ) {
      this.assertGuard(guard);
      return cloneTask(current);
    }
    const next = cloneDocument(this.document);
    next.revision = this.nextRevision();
    next.tasks[index] = updated;
    this.commit(next, guard);
    return cloneTask(updated);
  }

  private nextRevision(): number {
    if (this.document.revision >= Number.MAX_SAFE_INTEGER) throw new WorkTasksError("capacity");
    return this.document.revision + 1;
  }

  private safeNow(): number {
    const now = this.now();
    if (!Number.isSafeInteger(now) || now < 0) throw new WorkTasksError("unavailable");
    return now;
  }

  private monotonicUpdatedAt(task: WorkTask): number {
    return Math.max(task.createdAtMs, task.updatedAtMs, this.safeNow());
  }

  private nextTaskId(): string {
    const retainedIds = new Set([
      ...this.document.tasks.map((task) => task.id),
      ...this.document.operations.map((operation) => operation.taskId),
    ]);
    for (let attempt = 0; attempt < 8; attempt++) {
      let candidate: string;
      try { candidate = this.dependencies.createTaskId(); } catch { continue; }
      if (TASK_ID_PATTERN.test(candidate) && !retainedIds.has(candidate)) return candidate;
    }
    throw new WorkTasksError("unavailable");
  }

  private assertAvailable(): void {
    if (!this.available) {
      // Invalid encrypted data whose purge previously failed is retried here.
      this.reload();
      if (!this.available) throw new WorkTasksError("unavailable");
    }
  }

  private assertGuard(guard?: () => boolean): void {
    if (!guard) return;
    try {
      if (guard()) return;
    } catch {
      // A failed authorization probe is a denial.
    }
    throw new WorkTasksError("superseded");
  }

  private commit(next: WorkTasksDocument, guard?: () => boolean): void {
    const encoded = encodeDocument(next);
    // The authorization check is intentionally adjacent to the synchronous
    // secure commit. Observable state and listeners are updated only after it.
    this.assertGuard(guard);
    try {
      this.dependencies.persistence.save(encoded);
    } catch {
      throw new WorkTasksError("persistence_failed");
    }
    this.document = next;
    this.available = true;
    this.lastEncoded = encoded;
    this.emit();
  }

  private reload(): void {
    let storedValuePresent: boolean | null = null;
    try {
      storedValuePresent = this.dependencies.persistence.hasStoredValue?.() ?? null;
    } catch {
      this.markUnavailable();
      return;
    }
    let encoded: string;
    try {
      encoded = this.dependencies.persistence.load();
    } catch {
      this.markUnavailable();
      return;
    }
    if (!encoded) {
      // A present secret that cannot be decrypted is not an empty board. Keep
      // it unavailable until an explicit user reset or a later successful read.
      if (storedValuePresent === true) {
        this.markUnavailable();
        return;
      }
      if (this.available && this.lastEncoded === "") return;
      this.document = emptyDocument();
      this.lastEncoded = "";
      this.available = true;
      this.emit();
      return;
    }
    if (encoded === this.lastEncoded && this.available) return;
    const decoded = decodeWorkTasksDocument(encoded);
    if (!decoded) {
      // Preserve every nonempty unreadable blob. It may be a valid schema from
      // a newer app after rollback, and automatic purge would be data loss.
      // The glasses UI exposes a safe-default, user-confirmed reset instead.
      this.markUnavailable();
      return;
    }
    this.document = decoded;
    this.lastEncoded = encoded;
    this.available = true;
    this.emit();
  }

  private markUnavailable(): void {
    // Fail closed in RAM as well as at the mutation boundary: a previously
    // loaded title must not remain observable after storage becomes unreadable.
    this.document = emptyDocument();
    this.lastEncoded = "";
    this.available = false;
    this.emit();
  }

  private emit(): void {
    const snapshot = this.snapshot();
    for (const listener of Array.from(this.listeners)) {
      try { listener(snapshot); } catch { /* listeners do not own persistence */ }
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

function nativeTaskId(): string {
  return `wt_${String(java.util.UUID.randomUUID()).replace(/-/g, "").toLowerCase()}`;
}

const nativePersistence: WorkTasksPersistence = {
  hasStoredValue: () => hasStoredSecretSetting(WORK_TASKS_STORAGE_KEY),
  load: () => getStringSetting(WORK_TASKS_STORAGE_KEY, ""),
  save: (encoded) => setStringSetting(WORK_TASKS_STORAGE_KEY, encoded),
  purge: () => removeSecretSetting(WORK_TASKS_STORAGE_KEY),
  subscribe: (listener) => onSettingsStoreChanged((key) => {
    if (key === WORK_TASKS_STORAGE_KEY) listener();
  }),
};

/** Shared phone-owned service used by the glasses app and the authenticated Hermes tool. */
export const workTasksStore = new WorkTasksStore({
  persistence: nativePersistence,
  digest: nativeDigest,
  createTaskId: nativeTaskId,
});
