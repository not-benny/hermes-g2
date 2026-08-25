import {
  getStringSetting,
  hasStoredSecretSetting,
  onSettingsStoreChanged,
  removeSecretSetting,
  setStringSetting,
} from "../native/settings-store";

declare const java: any;

export const CLOCK_STORAGE_KEY = "clock.store.v1";
export const CLOCK_SCHEMA_VERSION = 1;
export const MAX_CLOCK_TIMERS = 64;
export const MAX_CLOCK_ALARMS = 64;
export const MAX_WORLD_CLOCKS = 24;
export const MAX_CLOCK_OCCURRENCES = 128;
export const MAX_CLOCK_OPERATIONS = 256;
export const MAX_CLOCK_LABEL_SCALARS = 80;
export const MAX_CLOCK_STORE_ENCODED_BYTES = 128 * 1024;
export const MAX_TIMER_DURATION_SECONDS = 7 * 24 * 60 * 60;

export const CLOCK_WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type ClockWeekday = (typeof CLOCK_WEEKDAYS)[number];
export type ClockItemKind = "timer" | "alarm";

export type ClockTimerState = "running" | "paused" | "finished";

export type ClockTimer = {
  id: string;
  label: string;
  durationSeconds: number;
  remainingSeconds: number;
  state: ClockTimerState;
  nextFireAtMs: number | null;
  /** Durable identity of this logical native schedule incarnation. */
  scheduleGeneration: number;
  createdAtMs: number;
};

export type ClockAlarm = {
  id: string;
  label: string;
  localTime: string;
  /** Resolved local date for a one-shot alarm; null for a repeating alarm. */
  date: string | null;
  repeatDays: ClockWeekday[];
  enabled: boolean;
  nextFireAtMs: number | null;
  /** Incremented when a disabled/finished alarm is explicitly re-enabled. */
  scheduleGeneration: number;
  createdAtMs: number;
};

export type WorldClock = {
  id: string;
  label: string;
  timeZone: string;
  createdAtMs: number;
};

/** A durable, not-yet-dismissed firing for the alert coordinator. */
export type ClockOccurrence = {
  id: string;
  itemId: string;
  kind: ClockItemKind;
  dueAtMs: number;
  recordedAtMs: number;
  /** Pending alerts may beep; silent alerts remain visual/missed until dismissed. */
  status: "pending" | "silent";
  /** Initial off-head routing, recorded when the alert campaign becomes silent. */
  wasOffHead: boolean | null;
};

type TimerOperation = {
  operationHash: string;
  digest: string;
  itemId: string;
  kind: "timer";
  revision: number;
  nextFireAtMs: number;
  durationSeconds: number;
};

type AlarmOperation = {
  operationHash: string;
  digest: string;
  itemId: string;
  kind: "alarm";
  revision: number;
  nextFireAtMs: number;
  localTime: string;
  date: string | null;
  repeatDays: ClockWeekday[];
};

type ClockOperation = TimerOperation | AlarmOperation;

export type ClockDocument = {
  version: 1;
  revision: number;
  timers: ClockTimer[];
  alarms: ClockAlarm[];
  worldClocks: WorldClock[];
  occurrences: ClockOccurrence[];
  operations: ClockOperation[];
};

export type ClockSnapshot = {
  available: boolean;
  revision: number;
  timers: ClockTimer[];
  alarms: ClockAlarm[];
  worldClocks: WorldClock[];
  occurrences: ClockOccurrence[];
};

export type ClockScheduledTimer = {
  itemId: string;
  kind: "timer";
  label: string;
  nextFireAtMs: number;
  durationSeconds: number;
  scheduleGeneration: number;
};

export type ClockScheduledAlarm = {
  itemId: string;
  kind: "alarm";
  label: string;
  nextFireAtMs: number;
  localTime: string;
  date: string | null;
  repeatDays: ClockWeekday[];
  scheduleGeneration: number;
};

export type ClockScheduledItem = ClockScheduledTimer | ClockScheduledAlarm;

export type ClockElapsedTimerDeadline = {
  itemId: string;
  /** Wall projection of the native elapsed-realtime deadline at this instant. */
  nextFireAtMs: number;
  scheduleGeneration: number;
};

export type ClockNativeFire = {
  itemId: string;
  kind: ClockItemKind;
  dueAtMs: number;
  scheduleGeneration: number;
};

export type ClockSetTimerInput = {
  operationId: string;
  durationSeconds: number;
  label?: string;
};

export type ClockSetAlarmInput = {
  operationId: string;
  localTime: string;
  date?: string;
  repeatDays?: ClockWeekday[];
  label?: string;
};

export type ClockTimerReceipt = {
  status: "acknowledged" | "historical_acknowledgement";
  operation_id: string;
  item_id: string;
  kind: "timer";
  next_fire_at_ms: number;
  clock_revision: number;
  duration_seconds: number;
};

export type ClockAlarmReceipt = {
  status: "acknowledged" | "historical_acknowledgement";
  operation_id: string;
  item_id: string;
  kind: "alarm";
  next_fire_at_ms: number;
  clock_revision: number;
  local_time: string;
  date: string | null;
  repeat_days: ClockWeekday[];
};

export type ClockReceipt = ClockTimerReceipt | ClockAlarmReceipt;

export type AddWorldClockInput = {
  timeZone: string;
  label?: string;
};

export type ClockStoreErrorCode =
  | "invalid_operation_id"
  | "invalid_duration"
  | "invalid_label"
  | "invalid_local_time"
  | "invalid_date"
  | "invalid_repeat_days"
  | "invalid_schedule"
  | "invalid_item_id"
  | "invalid_occurrence_id"
  | "invalid_time_zone"
  | "not_found"
  | "operation_conflict"
  | "capacity"
  | "superseded"
  | "persistence_failed"
  | "unavailable";

export class ClockStoreError extends Error {
  readonly code: ClockStoreErrorCode;

  constructor(code: ClockStoreErrorCode) {
    super(code);
    this.name = "ClockStoreError";
    this.code = code;
  }
}

export type ClockPersistence = {
  hasStoredValue?: () => boolean;
  load: () => string;
  save: (encoded: string) => void;
  purge: () => void;
  subscribe?: (listener: () => void) => () => void;
};

export type ClockStoreDependencies = {
  persistence: ClockPersistence;
  digest: (text: string) => string;
  createItemId: () => string;
  createOccurrenceId: () => string;
  now?: () => number;
  isValidTimeZone?: (timeZone: string) => boolean;
};

const ITEM_ID_PATTERN = /^clk_[a-f0-9]{32}$/;
const OCCURRENCE_ID_PATTERN = /^occ_[a-f0-9]{32}$/;
const OPERATION_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const LOCAL_TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const WEEKDAY_SET = new Set<string>(CLOCK_WEEKDAYS);
const FORBIDDEN_TEXT_SCALARS = new Set([
  0x061c, 0x200e, 0x200f,
  0x2028, 0x2029,
  0x202a, 0x202b, 0x202c, 0x202d, 0x202e,
  0x2066, 0x2067, 0x2068, 0x2069,
]);

const JS_DAY_TO_WEEKDAY: readonly ClockWeekday[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

function emptyDocument(): ClockDocument {
  return {
    version: 1,
    revision: 0,
    timers: [],
    alarms: [],
    worldClocks: [],
    occurrences: [],
    operations: [],
  };
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
    } else if (code >= 0xdc00 && code <= 0xdfff) return Number.POSITIVE_INFINITY;
    else bytes += 3;
  }
  return bytes;
}

function isForbiddenTextScalar(code: number): boolean {
  return (
    code <= 0x1f ||
    (code >= 0x7f && code <= 0x9f) ||
    (code >= 0xd800 && code <= 0xdfff) ||
    FORBIDDEN_TEXT_SCALARS.has(code)
  );
}

export function normalizeClockLabel(value: unknown, fallback: string): string {
  const candidate = value === undefined || value === null ? fallback : value;
  if (typeof candidate !== "string") throw new ClockStoreError("invalid_label");
  for (const scalar of Array.from(candidate)) {
    if (isForbiddenTextScalar(scalar.codePointAt(0)!)) throw new ClockStoreError("invalid_label");
  }
  let label: string;
  try { label = candidate.normalize("NFC").trim(); }
  catch { throw new ClockStoreError("invalid_label"); }
  if (!label || Array.from(label).length > MAX_CLOCK_LABEL_SCALARS || utf8ByteLength(label) > 320) {
    throw new ClockStoreError("invalid_label");
  }
  return label;
}

export function normalizeLocalTime(value: unknown): string {
  if (typeof value !== "string" || !LOCAL_TIME_PATTERN.test(value)) {
    throw new ClockStoreError("invalid_local_time");
  }
  return value;
}

export function normalizeRepeatDays(value: unknown): ClockWeekday[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > CLOCK_WEEKDAYS.length) {
    throw new ClockStoreError("invalid_repeat_days");
  }
  const found = new Set<ClockWeekday>();
  for (const day of value) {
    if (typeof day !== "string" || !WEEKDAY_SET.has(day) || found.has(day as ClockWeekday)) {
      throw new ClockStoreError("invalid_repeat_days");
    }
    found.add(day as ClockWeekday);
  }
  return CLOCK_WEEKDAYS.filter((day) => found.has(day));
}

export function normalizeLocalDate(value: unknown): string {
  if (typeof value !== "string") throw new ClockStoreError("invalid_date");
  const match = DATE_PATTERN.exec(value);
  if (!match) throw new ClockStoreError("invalid_date");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const candidate = new Date(year, month - 1, day, 12, 0, 0, 0);
  if (
    candidate.getFullYear() !== year ||
    candidate.getMonth() !== month - 1 ||
    candidate.getDate() !== day
  ) throw new ClockStoreError("invalid_date");
  return value;
}

function dateParts(localTime: string): { hour: number; minute: number } {
  return { hour: Number(localTime.slice(0, 2)), minute: Number(localTime.slice(3, 5)) };
}

function localDateString(date: Date): string {
  const year = String(date.getFullYear()).padStart(4, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function localDateAt(dateValue: string, localTime: string): Date {
  const dateMatch = DATE_PATTERN.exec(dateValue)!;
  const { hour, minute } = dateParts(localTime);
  return new Date(Number(dateMatch[1]), Number(dateMatch[2]) - 1, Number(dateMatch[3]), hour, minute, 0, 0);
}

/** Resolve a local wall-clock alarm to its next future instant. */
export function nextAlarmFireAt(
  localTimeValue: unknown,
  dateValue: unknown,
  repeatDaysValue: unknown,
  nowMs: number,
): { nextFireAtMs: number; date: string | null; repeatDays: ClockWeekday[] } {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new ClockStoreError("unavailable");
  const localTime = normalizeLocalTime(localTimeValue);
  const repeatDays = normalizeRepeatDays(repeatDaysValue);
  if (dateValue !== undefined && dateValue !== null && repeatDays.length) {
    throw new ClockStoreError("invalid_schedule");
  }
  if (repeatDays.length) {
    const base = new Date(nowMs);
    const { hour, minute } = dateParts(localTime);
    for (let offset = 0; offset <= 7; offset++) {
      const candidate = new Date(
        base.getFullYear(), base.getMonth(), base.getDate() + offset,
        hour, minute, 0, 0,
      );
      if (candidate.getTime() > nowMs && repeatDays.includes(JS_DAY_TO_WEEKDAY[candidate.getDay()]!)) {
        return { nextFireAtMs: candidate.getTime(), date: null, repeatDays };
      }
    }
    throw new ClockStoreError("invalid_schedule");
  }

  if (dateValue !== undefined && dateValue !== null) {
    const date = normalizeLocalDate(dateValue);
    const candidate = localDateAt(date, localTime);
    if (!Number.isSafeInteger(candidate.getTime()) || candidate.getTime() <= nowMs) {
      throw new ClockStoreError("invalid_schedule");
    }
    return { nextFireAtMs: candidate.getTime(), date, repeatDays: [] };
  }

  const now = new Date(nowMs);
  const { hour, minute } = dateParts(localTime);
  let candidate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, 0, 0);
  if (candidate.getTime() <= nowMs) {
    candidate = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, hour, minute, 0, 0);
  }
  if (!Number.isSafeInteger(candidate.getTime())) throw new ClockStoreError("invalid_schedule");
  return { nextFireAtMs: candidate.getTime(), date: localDateString(candidate), repeatDays: [] };
}

function cloneTimer(timer: ClockTimer): ClockTimer { return { ...timer }; }
function cloneAlarm(alarm: ClockAlarm): ClockAlarm { return { ...alarm, repeatDays: [...alarm.repeatDays] }; }
function cloneWorldClock(worldClock: WorldClock): WorldClock { return { ...worldClock }; }
function cloneOccurrence(occurrence: ClockOccurrence): ClockOccurrence { return { ...occurrence }; }
function cloneOperation(operation: ClockOperation): ClockOperation {
  return operation.kind === "timer" ? { ...operation } : { ...operation, repeatDays: [...operation.repeatDays] };
}

function cloneDocument(document: ClockDocument): ClockDocument {
  return {
    version: 1,
    revision: document.revision,
    timers: document.timers.map(cloneTimer),
    alarms: document.alarms.map(cloneAlarm),
    worldClocks: document.worldClocks.map(cloneWorldClock),
    occurrences: document.occurrences.map(cloneOccurrence),
    operations: document.operations.map(cloneOperation),
  };
}

function validateLabel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const label = normalizeClockLabel(value, "Clock");
    return label === value ? label : null;
  } catch { return null; }
}

function validateSafeMs(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function incrementScheduleGeneration(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value >= Number.MAX_SAFE_INTEGER) {
    throw new ClockStoreError("unavailable");
  }
  return value + 1;
}

function validateTimer(raw: unknown): ClockTimer | null {
  if (!isRecord(raw)) return null;
  const legacy = hasExactKeys(raw, [
    "id", "label", "durationSeconds", "remainingSeconds", "state", "nextFireAtMs", "createdAtMs",
  ]);
  if (!legacy && !hasExactKeys(raw, [
    "id", "label", "durationSeconds", "remainingSeconds", "state", "nextFireAtMs",
    "scheduleGeneration", "createdAtMs",
  ])) return null;
  if (typeof raw.id !== "string" || !ITEM_ID_PATTERN.test(raw.id)) return null;
  const label = validateLabel(raw.label);
  if (label === null) return null;
  if (!Number.isSafeInteger(raw.durationSeconds) || (raw.durationSeconds as number) < 1 || (raw.durationSeconds as number) > MAX_TIMER_DURATION_SECONDS) return null;
  if (!Number.isSafeInteger(raw.remainingSeconds) || (raw.remainingSeconds as number) < 0 || (raw.remainingSeconds as number) > (raw.durationSeconds as number)) return null;
  if (raw.state !== "running" && raw.state !== "paused" && raw.state !== "finished") return null;
  if (!validateSafeMs(raw.createdAtMs)) return null;
  const scheduleGeneration = legacy ? 1 : raw.scheduleGeneration;
  if (!Number.isSafeInteger(scheduleGeneration) || (scheduleGeneration as number) < 1) return null;
  if (raw.state === "running") {
    if (!validateSafeMs(raw.nextFireAtMs) || (raw.remainingSeconds as number) < 1) return null;
  } else if (raw.nextFireAtMs !== null) return null;
  if (raw.state === "finished" && raw.remainingSeconds !== 0) return null;
  return {
    id: raw.id,
    label,
    durationSeconds: raw.durationSeconds as number,
    remainingSeconds: raw.remainingSeconds as number,
    state: raw.state,
    nextFireAtMs: raw.nextFireAtMs as number | null,
    scheduleGeneration: scheduleGeneration as number,
    createdAtMs: raw.createdAtMs as number,
  };
}

function validateAlarm(raw: unknown): ClockAlarm | null {
  if (!isRecord(raw)) return null;
  const legacy = hasExactKeys(raw, [
    "id", "label", "localTime", "date", "repeatDays", "enabled", "nextFireAtMs", "createdAtMs",
  ]);
  if (!legacy && !hasExactKeys(raw, [
    "id", "label", "localTime", "date", "repeatDays", "enabled", "nextFireAtMs",
    "scheduleGeneration", "createdAtMs",
  ])) return null;
  if (typeof raw.id !== "string" || !ITEM_ID_PATTERN.test(raw.id)) return null;
  const label = validateLabel(raw.label);
  if (label === null) return null;
  let localTime: string;
  let repeatDays: ClockWeekday[];
  try {
    localTime = normalizeLocalTime(raw.localTime);
    repeatDays = normalizeRepeatDays(raw.repeatDays);
  } catch { return null; }
  if (JSON.stringify(raw.repeatDays) !== JSON.stringify(repeatDays)) return null;
  let date: string | null = null;
  if (raw.date !== null) {
    try { date = normalizeLocalDate(raw.date); } catch { return null; }
  }
  if (repeatDays.length ? date !== null : date === null) return null;
  if (typeof raw.enabled !== "boolean" || !validateSafeMs(raw.createdAtMs)) return null;
  const scheduleGeneration = legacy ? 1 : raw.scheduleGeneration;
  if (!Number.isSafeInteger(scheduleGeneration) || (scheduleGeneration as number) < 1) return null;
  if (raw.enabled ? !validateSafeMs(raw.nextFireAtMs) : raw.nextFireAtMs !== null) return null;
  return {
    id: raw.id,
    label,
    localTime,
    date,
    repeatDays,
    enabled: raw.enabled,
    nextFireAtMs: raw.nextFireAtMs as number | null,
    scheduleGeneration: scheduleGeneration as number,
    createdAtMs: raw.createdAtMs as number,
  };
}

function defaultTimeZoneValidator(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone }).format(0);
    return true;
  } catch { return false; }
}

function normalizeTimeZone(value: unknown, validator = defaultTimeZoneValidator): string {
  if (typeof value !== "string") throw new ClockStoreError("invalid_time_zone");
  const timeZone = value.trim();
  if (!timeZone || timeZone.length > 80 || !/^[A-Za-z0-9_+./-]+$/.test(timeZone) || !validator(timeZone)) {
    throw new ClockStoreError("invalid_time_zone");
  }
  return timeZone;
}

function validateWorldClock(raw: unknown): WorldClock | null {
  if (!isRecord(raw) || !hasExactKeys(raw, ["id", "label", "timeZone", "createdAtMs"])) return null;
  if (typeof raw.id !== "string" || !ITEM_ID_PATTERN.test(raw.id)) return null;
  const label = validateLabel(raw.label);
  if (label === null || !validateSafeMs(raw.createdAtMs)) return null;
  let timeZone: string;
  try { timeZone = normalizeTimeZone(raw.timeZone); } catch { return null; }
  if (timeZone !== raw.timeZone) return null;
  return { id: raw.id, label, timeZone, createdAtMs: raw.createdAtMs as number };
}

function validateOccurrence(raw: unknown): ClockOccurrence | null {
  if (!isRecord(raw) || !hasExactKeys(raw, [
    "id", "itemId", "kind", "dueAtMs", "recordedAtMs", "status", "wasOffHead",
  ])) return null;
  if (typeof raw.id !== "string" || !OCCURRENCE_ID_PATTERN.test(raw.id)) return null;
  if (typeof raw.itemId !== "string" || !ITEM_ID_PATTERN.test(raw.itemId)) return null;
  if (raw.kind !== "timer" && raw.kind !== "alarm") return null;
  if (!validateSafeMs(raw.dueAtMs) || !validateSafeMs(raw.recordedAtMs)) return null;
  if (raw.status !== "pending" && raw.status !== "silent") return null;
  if (raw.wasOffHead !== null && typeof raw.wasOffHead !== "boolean") return null;
  return {
    id: raw.id,
    itemId: raw.itemId,
    kind: raw.kind,
    dueAtMs: raw.dueAtMs as number,
    recordedAtMs: raw.recordedAtMs as number,
    status: raw.status,
    wasOffHead: raw.wasOffHead as boolean | null,
  };
}

function validateOperation(raw: unknown, revision: number): ClockOperation | null {
  if (!isRecord(raw) || raw.kind !== "timer" && raw.kind !== "alarm") return null;
  const commonValid =
    typeof raw.operationHash === "string" && DIGEST_PATTERN.test(raw.operationHash) &&
    typeof raw.digest === "string" && DIGEST_PATTERN.test(raw.digest) &&
    typeof raw.itemId === "string" && ITEM_ID_PATTERN.test(raw.itemId) &&
    Number.isSafeInteger(raw.revision) && (raw.revision as number) >= 1 && (raw.revision as number) <= revision &&
    validateSafeMs(raw.nextFireAtMs);
  if (!commonValid) return null;
  if (raw.kind === "timer") {
    if (!hasExactKeys(raw, ["operationHash", "digest", "itemId", "kind", "revision", "nextFireAtMs", "durationSeconds"])) return null;
    if (!Number.isSafeInteger(raw.durationSeconds) || (raw.durationSeconds as number) < 1 || (raw.durationSeconds as number) > MAX_TIMER_DURATION_SECONDS) return null;
    return {
      operationHash: raw.operationHash as string,
      digest: raw.digest as string,
      itemId: raw.itemId as string,
      kind: "timer",
      revision: raw.revision as number,
      nextFireAtMs: raw.nextFireAtMs as number,
      durationSeconds: raw.durationSeconds as number,
    };
  }
  if (!hasExactKeys(raw, ["operationHash", "digest", "itemId", "kind", "revision", "nextFireAtMs", "localTime", "date", "repeatDays"])) return null;
  let localTime: string;
  let repeatDays: ClockWeekday[];
  try {
    localTime = normalizeLocalTime(raw.localTime);
    repeatDays = normalizeRepeatDays(raw.repeatDays);
  } catch { return null; }
  if (JSON.stringify(raw.repeatDays) !== JSON.stringify(repeatDays)) return null;
  let date: string | null = null;
  if (raw.date !== null) {
    try { date = normalizeLocalDate(raw.date); } catch { return null; }
  }
  if (repeatDays.length ? date !== null : date === null) return null;
  return {
    operationHash: raw.operationHash as string,
    digest: raw.digest as string,
    itemId: raw.itemId as string,
    kind: "alarm",
    revision: raw.revision as number,
    nextFireAtMs: raw.nextFireAtMs as number,
    localTime,
    date,
    repeatDays,
  };
}

/** Strict, fail-closed decoder for the encrypted Clock document. */
export function decodeClockDocument(encoded: string): ClockDocument | null {
  if (!encoded || utf8ByteLength(encoded) > MAX_CLOCK_STORE_ENCODED_BYTES) return null;
  let raw: unknown;
  try { raw = JSON.parse(encoded); } catch { return null; }
  if (!isRecord(raw) || !hasExactKeys(raw, [
    "version", "revision", "timers", "alarms", "worldClocks", "occurrences", "operations",
  ])) return null;
  if (raw.version !== CLOCK_SCHEMA_VERSION || !Number.isSafeInteger(raw.revision) || (raw.revision as number) < 0) return null;
  if (!Array.isArray(raw.timers) || raw.timers.length > MAX_CLOCK_TIMERS) return null;
  if (!Array.isArray(raw.alarms) || raw.alarms.length > MAX_CLOCK_ALARMS) return null;
  if (!Array.isArray(raw.worldClocks) || raw.worldClocks.length > MAX_WORLD_CLOCKS) return null;
  if (!Array.isArray(raw.occurrences) || raw.occurrences.length > MAX_CLOCK_OCCURRENCES) return null;
  if (!Array.isArray(raw.operations) || raw.operations.length > MAX_CLOCK_OPERATIONS) return null;

  const itemIds = new Set<string>();
  const timers: ClockTimer[] = [];
  for (const candidate of raw.timers) {
    const timer = validateTimer(candidate);
    if (!timer || itemIds.has(timer.id)) return null;
    itemIds.add(timer.id);
    timers.push(timer);
  }
  const alarms: ClockAlarm[] = [];
  for (const candidate of raw.alarms) {
    const alarm = validateAlarm(candidate);
    if (!alarm || itemIds.has(alarm.id)) return null;
    itemIds.add(alarm.id);
    alarms.push(alarm);
  }
  const worldClocks: WorldClock[] = [];
  const timeZones = new Set<string>();
  for (const candidate of raw.worldClocks) {
    const worldClock = validateWorldClock(candidate);
    if (!worldClock || itemIds.has(worldClock.id) || timeZones.has(worldClock.timeZone)) return null;
    itemIds.add(worldClock.id);
    timeZones.add(worldClock.timeZone);
    worldClocks.push(worldClock);
  }
  const occurrences: ClockOccurrence[] = [];
  const occurrenceIds = new Set<string>();
  const occurrenceKeys = new Set<string>();
  for (const candidate of raw.occurrences) {
    const occurrence = validateOccurrence(candidate);
    const key = occurrence ? `${occurrence.itemId}\u0000${occurrence.dueAtMs}` : "";
    if (!occurrence || !itemIds.has(occurrence.itemId) || occurrenceIds.has(occurrence.id) || occurrenceKeys.has(key)) return null;
    occurrenceIds.add(occurrence.id);
    occurrenceKeys.add(key);
    occurrences.push(occurrence);
  }
  const operations: ClockOperation[] = [];
  const operationHashes = new Set<string>();
  for (const candidate of raw.operations) {
    const operation = validateOperation(candidate, raw.revision as number);
    if (!operation || operationHashes.has(operation.operationHash)) return null;
    operationHashes.add(operation.operationHash);
    operations.push(operation);
  }
  return {
    version: 1,
    revision: raw.revision as number,
    timers,
    alarms,
    worldClocks,
    occurrences,
    operations,
  };
}

function encodeDocument(document: ClockDocument): string {
  const encoded = JSON.stringify(document);
  if (utf8ByteLength(encoded) > MAX_CLOCK_STORE_ENCODED_BYTES) throw new ClockStoreError("capacity");
  return encoded;
}

function assertItemId(itemId: string): void {
  if (!ITEM_ID_PATTERN.test(itemId)) throw new ClockStoreError("invalid_item_id");
}

function assertOccurrenceId(occurrenceId: string): void {
  if (!OCCURRENCE_ID_PATTERN.test(occurrenceId)) throw new ClockStoreError("invalid_occurrence_id");
}

function canonicalDigest(dependencies: ClockStoreDependencies, text: string): string {
  let digest: string;
  try { digest = dependencies.digest(text).toLowerCase(); }
  catch { throw new ClockStoreError("unavailable"); }
  if (!DIGEST_PATTERN.test(digest)) throw new ClockStoreError("unavailable");
  return digest;
}

export class ClockStore {
  private document = emptyDocument();
  private available = false;
  private lastEncoded = "";
  private listeners = new Set<(snapshot: ClockSnapshot) => void>();
  private unsubscribePersistence: (() => void) | null = null;
  private readonly now: () => number;
  private readonly isValidTimeZone: (timeZone: string) => boolean;

  constructor(private readonly dependencies: ClockStoreDependencies) {
    this.now = dependencies.now ?? (() => Date.now());
    this.isValidTimeZone = dependencies.isValidTimeZone ?? defaultTimeZoneValidator;
    this.reload();
    this.unsubscribePersistence = dependencies.persistence.subscribe?.(() => this.reload()) ?? null;
  }

  dispose(): void {
    this.unsubscribePersistence?.();
    this.unsubscribePersistence = null;
    this.listeners.clear();
  }

  snapshot(): ClockSnapshot {
    return {
      available: this.available,
      revision: this.document.revision,
      timers: this.document.timers.map(cloneTimer),
      alarms: this.document.alarms.map(cloneAlarm),
      worldClocks: this.document.worldClocks.map(cloneWorldClock),
      occurrences: this.document.occurrences.map(cloneOccurrence),
    };
  }

  onChange(listener: (snapshot: ClockSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  setTimer(input: ClockSetTimerInput, guard?: () => boolean): ClockTimerReceipt {
    this.assertAvailable();
    this.assertOperationId(input?.operationId);
    if (!Number.isSafeInteger(input?.durationSeconds) || input.durationSeconds < 1 || input.durationSeconds > MAX_TIMER_DURATION_SECONDS) {
      throw new ClockStoreError("invalid_duration");
    }
    const label = normalizeClockLabel(input.label, "Timer");
    const operationHash = canonicalDigest(this.dependencies, input.operationId);
    const digest = canonicalDigest(this.dependencies, `${input.durationSeconds}\u0000${label}`);
    const prior = this.document.operations.find((operation) => operation.operationHash === operationHash);
    if (prior) {
      if (prior.kind !== "timer" || prior.digest !== digest) throw new ClockStoreError("operation_conflict");
      this.assertGuard(guard);
      return this.timerReceipt("historical_acknowledgement", input.operationId, prior);
    }
    if (this.document.timers.length >= MAX_CLOCK_TIMERS) throw new ClockStoreError("capacity");
    const now = this.safeNow();
    const durationMs = input.durationSeconds * 1000;
    const nextFireAtMs = now + durationMs;
    if (!Number.isSafeInteger(nextFireAtMs)) throw new ClockStoreError("invalid_duration");
    const revision = this.nextRevision();
    const timer: ClockTimer = {
      id: this.nextItemId(),
      label,
      durationSeconds: input.durationSeconds,
      remainingSeconds: input.durationSeconds,
      state: "running",
      nextFireAtMs,
      scheduleGeneration: 1,
      createdAtMs: now,
    };
    const operation: TimerOperation = {
      operationHash,
      digest,
      itemId: timer.id,
      kind: "timer",
      revision,
      nextFireAtMs,
      durationSeconds: input.durationSeconds,
    };
    const next = cloneDocument(this.document);
    next.revision = revision;
    next.timers.push(timer);
    next.operations = [...next.operations, operation].slice(-MAX_CLOCK_OPERATIONS);
    this.commit(next, guard);
    return this.timerReceipt("acknowledged", input.operationId, operation);
  }

  setAlarm(input: ClockSetAlarmInput, guard?: () => boolean): ClockAlarmReceipt {
    this.assertAvailable();
    this.assertOperationId(input?.operationId);
    const localTime = normalizeLocalTime(input?.localTime);
    const requestedDate = input.date === undefined || input.date === null
      ? null
      : normalizeLocalDate(input.date);
    const repeatDays = normalizeRepeatDays(input.repeatDays);
    if (requestedDate !== null && repeatDays.length) throw new ClockStoreError("invalid_schedule");
    const label = normalizeClockLabel(input.label, "Alarm");
    const operationHash = canonicalDigest(this.dependencies, input.operationId);
    const digest = canonicalDigest(
      this.dependencies,
      `${localTime}\u0000${requestedDate ?? ""}\u0000${repeatDays.join(",")}\u0000${label}`,
    );
    const prior = this.document.operations.find((operation) => operation.operationHash === operationHash);
    if (prior) {
      if (prior.kind !== "alarm" || prior.digest !== digest) throw new ClockStoreError("operation_conflict");
      this.assertGuard(guard);
      return this.alarmReceipt("historical_acknowledgement", input.operationId, prior);
    }
    if (this.document.alarms.length >= MAX_CLOCK_ALARMS) throw new ClockStoreError("capacity");
    const now = this.safeNow();
    const resolved = nextAlarmFireAt(localTime, requestedDate, repeatDays, now);
    const revision = this.nextRevision();
    const alarm: ClockAlarm = {
      id: this.nextItemId(),
      label,
      localTime,
      date: resolved.date,
      repeatDays: resolved.repeatDays,
      enabled: true,
      nextFireAtMs: resolved.nextFireAtMs,
      scheduleGeneration: 1,
      createdAtMs: now,
    };
    const operation: AlarmOperation = {
      operationHash,
      digest,
      itemId: alarm.id,
      kind: "alarm",
      revision,
      nextFireAtMs: resolved.nextFireAtMs,
      localTime,
      date: resolved.date,
      repeatDays: [...resolved.repeatDays],
    };
    const next = cloneDocument(this.document);
    next.revision = revision;
    next.alarms.push(alarm);
    next.operations = [...next.operations, operation].slice(-MAX_CLOCK_OPERATIONS);
    this.commit(next, guard);
    return this.alarmReceipt("acknowledged", input.operationId, operation);
  }

  scheduledItems(): ClockScheduledItem[] {
    this.assertAvailable();
    const items: ClockScheduledItem[] = [];
    for (const timer of this.document.timers) {
      if (timer.state === "running" && timer.nextFireAtMs !== null) {
        items.push({
          itemId: timer.id,
          kind: "timer",
          label: timer.label,
          nextFireAtMs: timer.nextFireAtMs,
          durationSeconds: timer.durationSeconds,
          scheduleGeneration: timer.scheduleGeneration,
        });
      }
    }
    for (const alarm of this.document.alarms) {
      if (alarm.enabled && alarm.nextFireAtMs !== null) {
        items.push({
          itemId: alarm.id,
          kind: "alarm",
          label: alarm.label,
          nextFireAtMs: alarm.nextFireAtMs,
          localTime: alarm.localTime,
          date: alarm.date,
          repeatDays: [...alarm.repeatDays],
          scheduleGeneration: alarm.scheduleGeneration,
        });
      }
    }
    return items.sort((left, right) => left.nextFireAtMs - right.nextFireAtMs || left.itemId.localeCompare(right.itemId));
  }

  nextDue(): ClockScheduledItem | null {
    return this.scheduledItems()[0] ?? null;
  }

  /**
   * Persist every item due at/before `atMs` as a pending occurrence, then
   * atomically finish one-shots and rearm repeating alarms.
   */
  reconcileDue(atMs = this.safeNow()): ClockOccurrence[] {
    this.assertAvailable();
    if (!Number.isSafeInteger(atMs) || atMs < 0) throw new ClockStoreError("unavailable");
    const due = this.scheduledItems().filter((item) =>
      item.nextFireAtMs <= atMs &&
      !this.document.occurrences.some((occurrence) =>
        occurrence.itemId === item.itemId && occurrence.dueAtMs === item.nextFireAtMs),
    );
    if (!due.length) return [];
    const next = cloneDocument(this.document);
    const required = Math.max(0, next.occurrences.length + due.length - MAX_CLOCK_OCCURRENCES);
    if (required > 0) {
      const removable = next.occurrences
        .filter((occurrence) => occurrence.status === "silent")
        .sort((left, right) => left.recordedAtMs - right.recordedAtMs || left.id.localeCompare(right.id))
        .slice(0, required);
      if (removable.length < required) throw new ClockStoreError("capacity");
      const removedIds = new Set(removable.map((occurrence) => occurrence.id));
      next.occurrences = next.occurrences.filter((occurrence) => !removedIds.has(occurrence.id));
    }
    const created: ClockOccurrence[] = [];
    for (const item of due) {
      const occurrence: ClockOccurrence = {
        id: this.nextOccurrenceId(next.occurrences),
        itemId: item.itemId,
        kind: item.kind,
        dueAtMs: item.nextFireAtMs,
        recordedAtMs: atMs,
        status: "pending",
        wasOffHead: null,
      };
      next.occurrences.push(occurrence);
      created.push(occurrence);
      if (item.kind === "timer") {
        const timer = next.timers.find((candidate) => candidate.id === item.itemId)!;
        timer.state = "finished";
        timer.remainingSeconds = 0;
        timer.nextFireAtMs = null;
      } else {
        const alarm = next.alarms.find((candidate) => candidate.id === item.itemId)!;
        if (alarm.repeatDays.length) {
          const resolved = nextAlarmFireAt(alarm.localTime, null, alarm.repeatDays, atMs);
          alarm.nextFireAtMs = resolved.nextFireAtMs;
        } else {
          alarm.enabled = false;
          alarm.nextFireAtMs = null;
        }
      }
    }
    if (!created.length) return [];
    next.revision = this.nextRevision();
    this.commit(next);
    return created.map(cloneOccurrence);
  }

  /**
   * Re-project native monotonic timer deadlines onto wall time after TIME_SET,
   * timezone change, process restart, or boot recovery. Alarms are untouched.
   */
  reconcileElapsedTimerSchedules(
    deadlines: readonly ClockElapsedTimerDeadline[],
    atMs = this.safeNow(),
    guard?: () => boolean,
  ): void {
    this.assertAvailable();
    if (!Array.isArray(deadlines) || deadlines.length > MAX_CLOCK_TIMERS ||
        !Number.isSafeInteger(atMs) || atMs < 0) throw new ClockStoreError("unavailable");
    const byId = new Map<string, number>();
    for (const deadline of deadlines) {
      if (!deadline || typeof deadline.itemId !== "string" || !ITEM_ID_PATTERN.test(deadline.itemId) ||
          !validateSafeMs(deadline.nextFireAtMs) || !Number.isSafeInteger(deadline.scheduleGeneration) ||
          deadline.scheduleGeneration < 1 || byId.has(deadline.itemId)) {
        throw new ClockStoreError("unavailable");
      }
      byId.set(deadline.itemId, deadline.nextFireAtMs);
    }
    const next = cloneDocument(this.document);
    let changed = false;
    for (const timer of next.timers) {
      if (timer.state !== "running") continue;
      const projected = byId.get(timer.id);
      const native = deadlines.find((deadline) => deadline.itemId === timer.id);
      // The encrypted store owns schedule incarnation. A failed post-commit
      // native sync may leave the previous generation mirrored briefly; never
      // let that stale elapsed deadline roll a restart/resume back.
      if (!native || native.scheduleGeneration !== timer.scheduleGeneration) continue;
      // The wall projection of one monotonic deadline can vary by a few
      // milliseconds while Java/JS clocks are sampled. Avoid revision/onChange
      // churn; real TIME_SET/TIMEZONE shifts remain far outside this tolerance.
      if (projected === undefined || (timer.nextFireAtMs !== null &&
          Math.abs(timer.nextFireAtMs - projected) <= 1_000)) continue;
      timer.nextFireAtMs = projected;
      timer.remainingSeconds = Math.max(
        1,
        Math.min(timer.durationSeconds, Math.ceil(Math.max(0, projected - atMs) / 1000)),
      );
      changed = true;
    }
    if (!changed) {
      this.assertGuard(guard);
      return;
    }
    next.revision = this.nextRevision();
    this.commit(next, guard);
  }

  /** Materialize one validated native AlarmManager edge, independent of wall jumps. */
  reconcileNativeFire(
    fire: ClockNativeFire,
    recordedAtMs = this.safeNow(),
    guard?: () => boolean,
  ): ClockOccurrence | null {
    this.assertAvailable();
    if (!fire || typeof fire.itemId !== "string" || !ITEM_ID_PATTERN.test(fire.itemId) ||
        (fire.kind !== "timer" && fire.kind !== "alarm") ||
        !validateSafeMs(fire.dueAtMs) || !Number.isSafeInteger(fire.scheduleGeneration) ||
        fire.scheduleGeneration < 1 || !validateSafeMs(recordedAtMs)) {
      throw new ClockStoreError("unavailable");
    }
    const prior = this.document.occurrences.find((occurrence) =>
      occurrence.itemId === fire.itemId && occurrence.dueAtMs === fire.dueAtMs);
    if (prior) {
      this.assertGuard(guard);
      return cloneOccurrence(prior);
    }
    const timer = fire.kind === "timer"
      ? this.document.timers.find((candidate) => candidate.id === fire.itemId)
      : undefined;
    const alarm = fire.kind === "alarm"
      ? this.document.alarms.find((candidate) => candidate.id === fire.itemId)
      : undefined;
    if ((fire.kind === "timer" && (!timer || timer.state !== "running" ||
          timer.scheduleGeneration !== fire.scheduleGeneration)) ||
        (fire.kind === "alarm" && (!alarm || !alarm.enabled ||
          alarm.scheduleGeneration !== fire.scheduleGeneration))) {
      this.assertGuard(guard);
      return null;
    }
    const next = cloneDocument(this.document);
    if (next.occurrences.length >= MAX_CLOCK_OCCURRENCES) {
      const oldestSilent = next.occurrences
        .filter((occurrence) => occurrence.status === "silent")
        .sort((left, right) => left.recordedAtMs - right.recordedAtMs || left.id.localeCompare(right.id))[0];
      if (!oldestSilent) throw new ClockStoreError("capacity");
      next.occurrences = next.occurrences.filter((occurrence) => occurrence.id !== oldestSilent.id);
    }
    const occurrence: ClockOccurrence = {
      id: this.nextOccurrenceId(next.occurrences),
      itemId: fire.itemId,
      kind: fire.kind,
      dueAtMs: fire.dueAtMs,
      recordedAtMs,
      status: "pending",
      wasOffHead: null,
    };
    next.occurrences.push(occurrence);
    if (fire.kind === "timer") {
      const target = next.timers.find((candidate) => candidate.id === fire.itemId)!;
      target.state = "finished";
      target.remainingSeconds = 0;
      target.nextFireAtMs = null;
    } else {
      const target = next.alarms.find((candidate) => candidate.id === fire.itemId)!;
      if (target.repeatDays.length) {
        target.nextFireAtMs = nextAlarmFireAt(target.localTime, null, target.repeatDays, recordedAtMs).nextFireAtMs;
      } else {
        target.enabled = false;
        target.nextFireAtMs = null;
      }
    }
    next.revision = this.nextRevision();
    this.commit(next, guard);
    return cloneOccurrence(occurrence);
  }

  dismissOccurrence(occurrenceId: string, guard?: () => boolean): void {
    assertOccurrenceId(occurrenceId);
    this.assertAvailable();
    const index = this.document.occurrences.findIndex((occurrence) => occurrence.id === occurrenceId);
    if (index < 0) throw new ClockStoreError("not_found");
    const next = cloneDocument(this.document);
    next.revision = this.nextRevision();
    next.occurrences.splice(index, 1);
    this.commit(next, guard);
  }

  /** Stop replaying audio while retaining missed/visual acknowledgement state. */
  markOccurrenceSilent(occurrenceId: string, wasOffHead: boolean, guard?: () => boolean): ClockOccurrence {
    assertOccurrenceId(occurrenceId);
    if (typeof wasOffHead !== "boolean") throw new ClockStoreError("unavailable");
    this.assertAvailable();
    const index = this.document.occurrences.findIndex((occurrence) => occurrence.id === occurrenceId);
    if (index < 0) throw new ClockStoreError("not_found");
    const current = this.document.occurrences[index]!;
    if (current.status === "silent" && current.wasOffHead === wasOffHead) {
      this.assertGuard(guard);
      return cloneOccurrence(current);
    }
    const next = cloneDocument(this.document);
    const occurrence = next.occurrences[index]!;
    occurrence.status = "silent";
    occurrence.wasOffHead = wasOffHead;
    next.revision = this.nextRevision();
    this.commit(next, guard);
    return cloneOccurrence(occurrence);
  }

  dismissOccurrencesForItem(itemId: string, guard?: () => boolean): number {
    assertItemId(itemId);
    this.assertAvailable();
    const remaining = this.document.occurrences.filter((occurrence) => occurrence.itemId !== itemId);
    const removed = this.document.occurrences.length - remaining.length;
    if (!removed) {
      this.assertGuard(guard);
      return 0;
    }
    const next = cloneDocument(this.document);
    next.revision = this.nextRevision();
    next.occurrences = remaining.map(cloneOccurrence);
    this.commit(next, guard);
    return removed;
  }

  pauseTimer(itemId: string, guard?: () => boolean): ClockTimer {
    assertItemId(itemId);
    this.assertAvailable();
    const index = this.document.timers.findIndex((timer) => timer.id === itemId);
    if (index < 0) throw new ClockStoreError("not_found");
    const current = this.document.timers[index]!;
    if (current.state !== "running" || current.nextFireAtMs === null) {
      this.assertGuard(guard);
      return cloneTimer(current);
    }
    const next = cloneDocument(this.document);
    const timer = next.timers[index]!;
    timer.remainingSeconds = Math.max(1, Math.min(timer.durationSeconds, Math.ceil((timer.nextFireAtMs! - this.safeNow()) / 1000)));
    timer.state = "paused";
    timer.nextFireAtMs = null;
    next.revision = this.nextRevision();
    this.commit(next, guard);
    return cloneTimer(timer);
  }

  resumeTimer(itemId: string, guard?: () => boolean): ClockTimer {
    assertItemId(itemId);
    this.assertAvailable();
    const index = this.document.timers.findIndex((timer) => timer.id === itemId);
    if (index < 0) throw new ClockStoreError("not_found");
    const current = this.document.timers[index]!;
    if (current.state !== "paused") {
      this.assertGuard(guard);
      return cloneTimer(current);
    }
    const now = this.safeNow();
    const next = cloneDocument(this.document);
    const timer = next.timers[index]!;
    timer.state = "running";
    timer.nextFireAtMs = now + timer.remainingSeconds * 1000;
    timer.scheduleGeneration = incrementScheduleGeneration(timer.scheduleGeneration);
    next.revision = this.nextRevision();
    this.commit(next, guard);
    return cloneTimer(timer);
  }

  restartTimer(itemId: string, guard?: () => boolean): ClockTimer {
    assertItemId(itemId);
    this.assertAvailable();
    const index = this.document.timers.findIndex((timer) => timer.id === itemId);
    if (index < 0) throw new ClockStoreError("not_found");
    const now = this.safeNow();
    const next = cloneDocument(this.document);
    const timer = next.timers[index]!;
    timer.state = "running";
    timer.remainingSeconds = timer.durationSeconds;
    timer.nextFireAtMs = now + timer.durationSeconds * 1000;
    timer.scheduleGeneration = incrementScheduleGeneration(timer.scheduleGeneration);
    next.occurrences = next.occurrences.filter((occurrence) => occurrence.itemId !== itemId);
    next.revision = this.nextRevision();
    this.commit(next, guard);
    return cloneTimer(timer);
  }

  deleteTimer(itemId: string, guard?: () => boolean): void {
    assertItemId(itemId);
    this.assertAvailable();
    const index = this.document.timers.findIndex((timer) => timer.id === itemId);
    if (index < 0) throw new ClockStoreError("not_found");
    const next = cloneDocument(this.document);
    next.timers.splice(index, 1);
    next.occurrences = next.occurrences.filter((occurrence) => occurrence.itemId !== itemId);
    next.revision = this.nextRevision();
    this.commit(next, guard);
  }

  setAlarmEnabled(itemId: string, enabled: boolean, guard?: () => boolean): ClockAlarm {
    assertItemId(itemId);
    if (typeof enabled !== "boolean") throw new ClockStoreError("unavailable");
    this.assertAvailable();
    const index = this.document.alarms.findIndex((alarm) => alarm.id === itemId);
    if (index < 0) throw new ClockStoreError("not_found");
    const current = this.document.alarms[index]!;
    if (current.enabled === enabled) {
      this.assertGuard(guard);
      return cloneAlarm(current);
    }
    const next = cloneDocument(this.document);
    const alarm = next.alarms[index]!;
    alarm.enabled = enabled;
    if (enabled) {
      const resolved = nextAlarmFireAt(alarm.localTime, null, alarm.repeatDays, this.safeNow());
      alarm.date = resolved.date;
      alarm.nextFireAtMs = resolved.nextFireAtMs;
      alarm.scheduleGeneration = incrementScheduleGeneration(alarm.scheduleGeneration);
    } else {
      alarm.nextFireAtMs = null;
    }
    next.revision = this.nextRevision();
    this.commit(next, guard);
    return cloneAlarm(alarm);
  }

  deleteAlarm(itemId: string, guard?: () => boolean): void {
    assertItemId(itemId);
    this.assertAvailable();
    const index = this.document.alarms.findIndex((alarm) => alarm.id === itemId);
    if (index < 0) throw new ClockStoreError("not_found");
    const next = cloneDocument(this.document);
    next.alarms.splice(index, 1);
    next.occurrences = next.occurrences.filter((occurrence) => occurrence.itemId !== itemId);
    next.revision = this.nextRevision();
    this.commit(next, guard);
  }

  /**
   * Converge local-wall alarms after TIME_SET/TIMEZONE_CHANGED. A one-shot
   * whose local wall time was crossed becomes a durable due occurrence; it is
   * never silently postponed to tomorrow.
   */
  reconcileWallClockSchedules(atMs = this.safeNow(), guard?: () => boolean): ClockOccurrence[] {
    this.assertAvailable();
    if (!Number.isSafeInteger(atMs) || atMs < 0) throw new ClockStoreError("unavailable");
    const next = cloneDocument(this.document);
    const created: ClockOccurrence[] = [];
    let changed = false;
    for (const alarm of next.alarms) {
      if (!alarm.enabled) continue;
      if (alarm.repeatDays.length) {
        const dueAtMs = alarm.nextFireAtMs !== null && alarm.nextFireAtMs <= atMs
          ? alarm.nextFireAtMs
          : null;
        if (dueAtMs !== null && !next.occurrences.some((item) => item.itemId === alarm.id && item.dueAtMs === dueAtMs)) {
          if (next.occurrences.length >= MAX_CLOCK_OCCURRENCES) throw new ClockStoreError("capacity");
          const occurrence: ClockOccurrence = {
            id: this.nextOccurrenceId(next.occurrences),
            itemId: alarm.id,
            kind: "alarm",
            dueAtMs,
            recordedAtMs: atMs,
            status: "pending",
            wasOffHead: null,
          };
          next.occurrences.push(occurrence);
          created.push(occurrence);
          changed = true;
        }
        const resolved = nextAlarmFireAt(alarm.localTime, null, alarm.repeatDays, atMs);
        if (alarm.nextFireAtMs !== resolved.nextFireAtMs) {
          alarm.nextFireAtMs = resolved.nextFireAtMs;
          changed = true;
        }
        continue;
      }

      const candidateAtMs = localDateAt(alarm.date!, alarm.localTime).getTime();
      if (!Number.isSafeInteger(candidateAtMs)) throw new ClockStoreError("invalid_schedule");
      if (candidateAtMs <= atMs) {
        const dueAtMs = alarm.nextFireAtMs !== null && alarm.nextFireAtMs <= atMs
          ? alarm.nextFireAtMs
          : candidateAtMs;
        if (!next.occurrences.some((item) => item.itemId === alarm.id && item.dueAtMs === dueAtMs)) {
          if (next.occurrences.length >= MAX_CLOCK_OCCURRENCES) throw new ClockStoreError("capacity");
          const occurrence: ClockOccurrence = {
            id: this.nextOccurrenceId(next.occurrences),
            itemId: alarm.id,
            kind: "alarm",
            dueAtMs,
            recordedAtMs: atMs,
            status: "pending",
            wasOffHead: null,
          };
          next.occurrences.push(occurrence);
          created.push(occurrence);
        }
        alarm.enabled = false;
        alarm.nextFireAtMs = null;
        changed = true;
      } else if (alarm.nextFireAtMs !== candidateAtMs) {
        alarm.nextFireAtMs = candidateAtMs;
        changed = true;
      }
    }
    if (!changed) {
      this.assertGuard(guard);
      return [];
    }
    next.revision = this.nextRevision();
    this.commit(next, guard);
    return created.map(cloneOccurrence);
  }

  addWorldClock(input: AddWorldClockInput, guard?: () => boolean): WorldClock {
    this.assertAvailable();
    const timeZone = normalizeTimeZone(input?.timeZone, this.isValidTimeZone);
    if (this.document.worldClocks.some((worldClock) => worldClock.timeZone === timeZone)) {
      throw new ClockStoreError("invalid_time_zone");
    }
    if (this.document.worldClocks.length >= MAX_WORLD_CLOCKS) throw new ClockStoreError("capacity");
    const fallback = timeZone.split("/").pop()!.replace(/_/g, " ");
    const worldClock: WorldClock = {
      id: this.nextItemId(),
      label: normalizeClockLabel(input.label, fallback),
      timeZone,
      createdAtMs: this.safeNow(),
    };
    const next = cloneDocument(this.document);
    next.revision = this.nextRevision();
    next.worldClocks.push(worldClock);
    this.commit(next, guard);
    return cloneWorldClock(worldClock);
  }

  removeWorldClock(itemId: string, guard?: () => boolean): void {
    assertItemId(itemId);
    this.assertAvailable();
    const index = this.document.worldClocks.findIndex((worldClock) => worldClock.id === itemId);
    if (index < 0) throw new ClockStoreError("not_found");
    const next = cloneDocument(this.document);
    next.worldClocks.splice(index, 1);
    next.revision = this.nextRevision();
    this.commit(next, guard);
  }

  /** Explicit user-confirmed recovery path for an unreadable encrypted blob. */
  discardUnreadableData(): void {
    if (this.available) throw new ClockStoreError("unavailable");
    try { this.dependencies.persistence.purge(); }
    catch { throw new ClockStoreError("persistence_failed"); }
    this.document = emptyDocument();
    this.lastEncoded = "";
    this.available = true;
    this.emit();
  }

  private timerReceipt(
    status: ClockTimerReceipt["status"],
    operationId: string,
    operation: TimerOperation,
  ): ClockTimerReceipt {
    return {
      status,
      operation_id: operationId,
      item_id: operation.itemId,
      kind: "timer",
      next_fire_at_ms: operation.nextFireAtMs,
      clock_revision: operation.revision,
      duration_seconds: operation.durationSeconds,
    };
  }

  private alarmReceipt(
    status: ClockAlarmReceipt["status"],
    operationId: string,
    operation: AlarmOperation,
  ): ClockAlarmReceipt {
    return {
      status,
      operation_id: operationId,
      item_id: operation.itemId,
      kind: "alarm",
      next_fire_at_ms: operation.nextFireAtMs,
      clock_revision: operation.revision,
      local_time: operation.localTime,
      date: operation.date,
      repeat_days: [...operation.repeatDays],
    };
  }

  private assertOperationId(operationId: unknown): asserts operationId is string {
    if (typeof operationId !== "string" || !OPERATION_ID_PATTERN.test(operationId)) {
      throw new ClockStoreError("invalid_operation_id");
    }
  }

  private nextRevision(): number {
    if (this.document.revision >= Number.MAX_SAFE_INTEGER) throw new ClockStoreError("capacity");
    return this.document.revision + 1;
  }

  private safeNow(): number {
    const now = this.now();
    if (!Number.isSafeInteger(now) || now < 0) throw new ClockStoreError("unavailable");
    return now;
  }

  private nextItemId(): string {
    const retainedIds = new Set<string>([
      ...this.document.timers.map((timer) => timer.id),
      ...this.document.alarms.map((alarm) => alarm.id),
      ...this.document.worldClocks.map((worldClock) => worldClock.id),
      ...this.document.operations.map((operation) => operation.itemId),
    ]);
    for (let attempt = 0; attempt < 8; attempt++) {
      let candidate: string;
      try { candidate = this.dependencies.createItemId(); } catch { continue; }
      if (ITEM_ID_PATTERN.test(candidate) && !retainedIds.has(candidate)) return candidate;
    }
    throw new ClockStoreError("unavailable");
  }

  private nextOccurrenceId(existing: ClockOccurrence[]): string {
    const retainedIds = new Set(existing.map((occurrence) => occurrence.id));
    for (let attempt = 0; attempt < 8; attempt++) {
      let candidate: string;
      try { candidate = this.dependencies.createOccurrenceId(); } catch { continue; }
      if (OCCURRENCE_ID_PATTERN.test(candidate) && !retainedIds.has(candidate)) return candidate;
    }
    throw new ClockStoreError("unavailable");
  }

  private assertAvailable(): void {
    if (!this.available) {
      this.reload();
      if (!this.available) throw new ClockStoreError("unavailable");
    }
  }

  private assertGuard(guard?: () => boolean): void {
    if (!guard) return;
    try { if (guard()) return; } catch { /* denial */ }
    throw new ClockStoreError("superseded");
  }

  private commit(next: ClockDocument, guard?: () => boolean): void {
    const encoded = encodeDocument(next);
    this.assertGuard(guard);
    try { this.dependencies.persistence.save(encoded); }
    catch { throw new ClockStoreError("persistence_failed"); }
    this.document = next;
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
    const decoded = decodeClockDocument(encoded);
    if (!decoded) {
      this.markUnavailable();
      return;
    }
    this.document = decoded;
    this.lastEncoded = encoded;
    this.available = true;
    this.emit();
  }

  private markUnavailable(): void {
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

function nativeItemId(): string {
  return `clk_${String(java.util.UUID.randomUUID()).replace(/-/g, "").toLowerCase()}`;
}

function nativeOccurrenceId(): string {
  return `occ_${String(java.util.UUID.randomUUID()).replace(/-/g, "").toLowerCase()}`;
}

const nativePersistence: ClockPersistence = {
  hasStoredValue: () => hasStoredSecretSetting(CLOCK_STORAGE_KEY),
  load: () => getStringSetting(CLOCK_STORAGE_KEY, ""),
  save: (encoded) => setStringSetting(CLOCK_STORAGE_KEY, encoded),
  purge: () => removeSecretSetting(CLOCK_STORAGE_KEY),
  subscribe: (listener) => onSettingsStoreChanged((key) => {
    if (key === CLOCK_STORAGE_KEY) listener();
  }),
};

/** Phone-owned durable Clock service shared by UI, native alerts, and Hermes. */
export const clockStore = new ClockStore({
  persistence: nativePersistence,
  digest: nativeDigest,
  createItemId: nativeItemId,
  createOccurrenceId: nativeOccurrenceId,
});
