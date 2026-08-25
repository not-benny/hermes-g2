import {
  ClockStoreError,
  type ClockAlarmReceipt,
  type ClockSetAlarmInput,
  type ClockSetTimerInput,
  type ClockScheduledItem,
  type ClockTimerReceipt,
  type ClockWeekday,
} from "../clock/store";
import type { ToolExecutionContext, ToolHandler, ToolResult } from "./tool-registry";

const OPERATION_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const ITEM_ID_PATTERN = /^clk_[a-f0-9]{32}$/;
const LOCAL_TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const LOCAL_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const CLOCK_WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
const CLOCK_WEEKDAY_SET = new Set<string>(CLOCK_WEEKDAYS);
const MAX_DURATION_SECONDS = 7 * 24 * 60 * 60;
const MAX_LABEL_SCALARS = 80;
const MAX_LABEL_UTF8_BYTES = 320;
const FORBIDDEN_TEXT_SCALARS = new Set([
  0x061c, 0x200e, 0x200f,
  0x2028, 0x2029,
  0x202a, 0x202b, 0x202c, 0x202d, 0x202e,
  0x2066, 0x2067, 0x2068, 0x2069,
]);

export type ClockToolDependencies = {
  setTimer: (input: ClockSetTimerInput, isAllowed?: () => boolean) => ClockTimerReceipt;
  setAlarm: (input: ClockSetAlarmInput, isAllowed?: () => boolean) => ClockAlarmReceipt;
  scheduledItems: () => ClockScheduledItem[];
  syncScheduler: (items: readonly ClockScheduledItem[]) => void;
};

type TimerRequest = {
  operation_id: string;
  duration_seconds: number;
  label?: string;
};

type AlarmRequest = {
  operation_id: string;
  local_time: string;
  date?: string;
  repeat_days?: ClockWeekday[];
  label?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, accepted: readonly string[]): boolean {
  const acceptedSet = new Set(accepted);
  return Object.keys(value).every((key) => acceptedSet.has(key));
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index]);
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

function normalizeOptionalLabel(value: unknown): string {
  if (typeof value !== "string") throw new ClockStoreError("invalid_label");
  for (const scalar of Array.from(value)) {
    const code = scalar.codePointAt(0)!;
    if (
      code <= 0x1f ||
      (code >= 0x7f && code <= 0x9f) ||
      (code >= 0xd800 && code <= 0xdfff) ||
      FORBIDDEN_TEXT_SCALARS.has(code)
    ) throw new ClockStoreError("invalid_label");
  }
  let label: string;
  try { label = value.normalize("NFC").trim(); }
  catch { throw new ClockStoreError("invalid_label"); }
  if (
    !label ||
    Array.from(label).length > MAX_LABEL_SCALARS ||
    utf8ByteLength(label) > MAX_LABEL_UTF8_BYTES
  ) throw new ClockStoreError("invalid_label");
  return label;
}

function normalizeLocalDate(value: unknown): string {
  if (typeof value !== "string") throw new ClockStoreError("invalid_date");
  const match = LOCAL_DATE_PATTERN.exec(value);
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

function normalizeRepeatDays(value: unknown): ClockWeekday[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > CLOCK_WEEKDAYS.length) {
    throw new ClockStoreError("invalid_repeat_days");
  }
  const found = new Set<ClockWeekday>();
  for (const day of value) {
    if (typeof day !== "string" || !CLOCK_WEEKDAY_SET.has(day) || found.has(day as ClockWeekday)) {
      throw new ClockStoreError("invalid_repeat_days");
    }
    found.add(day as ClockWeekday);
  }
  return CLOCK_WEEKDAYS.filter((day) => found.has(day));
}

function normalizeTimerRequest(value: unknown): TimerRequest {
  if (!isRecord(value) || !hasOnlyKeys(value, ["operation_id", "duration_seconds", "label"]) ||
      !("operation_id" in value) || !("duration_seconds" in value) ||
      typeof value.operation_id !== "string" || !OPERATION_ID_PATTERN.test(value.operation_id) ||
      !Number.isSafeInteger(value.duration_seconds) ||
      (value.duration_seconds as number) < 1 || (value.duration_seconds as number) > MAX_DURATION_SECONDS) {
    throw new ClockStoreError("invalid_duration");
  }
  const request: TimerRequest = {
    operation_id: value.operation_id,
    duration_seconds: value.duration_seconds as number,
  };
  if ("label" in value) request.label = normalizeOptionalLabel(value.label);
  return request;
}

function normalizeAlarmRequest(value: unknown): AlarmRequest {
  if (!isRecord(value) ||
      !hasOnlyKeys(value, ["operation_id", "local_time", "date", "repeat_days", "label"]) ||
      !("operation_id" in value) || !("local_time" in value) ||
      typeof value.operation_id !== "string" || !OPERATION_ID_PATTERN.test(value.operation_id) ||
      typeof value.local_time !== "string" || !LOCAL_TIME_PATTERN.test(value.local_time) ||
      ("date" in value && "repeat_days" in value)) {
    throw new ClockStoreError("invalid_schedule");
  }
  const request: AlarmRequest = {
    operation_id: value.operation_id,
    local_time: value.local_time,
  };
  if ("date" in value) request.date = normalizeLocalDate(value.date);
  if ("repeat_days" in value) request.repeat_days = normalizeRepeatDays(value.repeat_days);
  if ("label" in value) request.label = normalizeOptionalLabel(value.label);
  return request;
}

function isActiveAuthenticatedG2Turn(context?: ToolExecutionContext): boolean {
  return context?.caller === "mcp" &&
    context.proactive === false &&
    context.profileId === "even-g2" &&
    typeof context.turnGeneration === "string" &&
    context.turnGeneration.length > 0 &&
    context.connectionGeneration !== undefined &&
    context.connectionGeneration !== null &&
    context.connectionGeneration !== "";
}

function commonReceiptIsExact(
  value: Record<string, unknown>,
  operationId: string,
  kind: "timer" | "alarm",
): boolean {
  return (
    (value.status === "acknowledged" || value.status === "historical_acknowledgement") &&
    value.operation_id === operationId &&
    typeof value.item_id === "string" && ITEM_ID_PATTERN.test(value.item_id) &&
    value.kind === kind &&
    typeof value.next_fire_at_ms === "number" &&
    Number.isSafeInteger(value.next_fire_at_ms) && value.next_fire_at_ms >= 1 &&
    typeof value.clock_revision === "number" &&
    Number.isSafeInteger(value.clock_revision) && value.clock_revision >= 1
  );
}

function timerReceiptIsExact(receipt: unknown, request: TimerRequest): receipt is ClockTimerReceipt {
  if (!isRecord(receipt) || !hasExactKeys(receipt, [
    "status", "operation_id", "item_id", "kind", "next_fire_at_ms",
    "clock_revision", "duration_seconds",
  ])) return false;
  return commonReceiptIsExact(receipt, request.operation_id, "timer") &&
    receipt.duration_seconds === request.duration_seconds;
}

function sameDays(actual: unknown, expected: readonly ClockWeekday[]): boolean {
  return Array.isArray(actual) && actual.length === expected.length &&
    actual.every((day, index) => day === expected[index]);
}

function alarmReceiptIsExact(receipt: unknown, request: AlarmRequest): receipt is ClockAlarmReceipt {
  if (!isRecord(receipt) || !hasExactKeys(receipt, [
    "status", "operation_id", "item_id", "kind", "next_fire_at_ms",
    "clock_revision", "local_time", "date", "repeat_days",
  ]) || !commonReceiptIsExact(receipt, request.operation_id, "alarm") ||
      receipt.local_time !== request.local_time) return false;

  if (request.date !== undefined) {
    return receipt.date === request.date && sameDays(receipt.repeat_days, []);
  }
  if (request.repeat_days !== undefined) {
    return receipt.date === null && sameDays(receipt.repeat_days, request.repeat_days);
  }
  // The store resolves an undated one-shot request to its concrete phone-local
  // date. Require that resolved date rather than accepting a vague null receipt.
  try { normalizeLocalDate(receipt.date); }
  catch { return false; }
  return sameDays(receipt.repeat_days, []);
}

function clockErrorResult(error: unknown): ToolResult {
  const code = error instanceof ClockStoreError
    ? error.code
    : typeof (error as any)?.code === "string"
      ? String((error as any).code)
      : "unavailable";
  switch (code) {
    case "invalid_operation_id":
    case "invalid_duration":
    case "invalid_label":
    case "invalid_local_time":
    case "invalid_date":
    case "invalid_repeat_days":
    case "invalid_schedule":
      return { ok: false, error: "Clock requires a valid opaque operation_id and a bounded timer or phone-local alarm schedule" };
    case "operation_conflict":
      return { ok: false, error: "operation_id was already used for a different Clock item" };
    case "capacity":
      return { ok: false, error: "Clock is full; no timer or alarm was scheduled" };
    case "superseded":
      return { ok: false, error: "The authorizing glasses turn ended before commit; nothing was changed" };
    case "persistence_failed":
    case "unavailable":
    default:
      return { ok: false, error: "Clock could not save the item; no success was confirmed" };
  }
}

function isAuthorized(
  signal?: AbortSignal,
  isSideEffectAllowed?: () => boolean,
): boolean {
  if (signal?.aborted) return false;
  try { return !isSideEffectAllowed || isSideEffectAllowed(); }
  catch { return false; }
}

function synchronizeNativeSchedule(deps: ClockToolDependencies): ToolResult | null {
  try {
    // The encrypted Clock store is authoritative, but an assistant ACK also
    // promises that Android has accepted its complete AlarmManager mirror.
    // Sync after every new or historical write and never roll back durable
    // state if the native boundary fails: the caller must treat that as an
    // unknown outcome and the runtime recovery loop can repair the mirror.
    deps.syncScheduler(deps.scheduledItems());
    return null;
  } catch {
    return {
      ok: false,
      error: "The Clock item may have been saved but native scheduling was not confirmed; check Clock and retry only with the same operation_id",
    };
  }
}

/** Fixed, active-turn-only phone boundary for one durable Clock timer. */
export function createClockSetTimerHandler(deps: ClockToolDependencies): ToolHandler {
  return (args, signal, isSideEffectAllowed, context) => {
    if (!isActiveAuthenticatedG2Turn(context)) {
      return { ok: false, error: "Clock accepts only an authenticated active turn from the even-g2 profile" };
    }
    let request: TimerRequest;
    try { request = normalizeTimerRequest(args); }
    catch (error) { return clockErrorResult(error); }
    const guard = () => isAuthorized(signal, isSideEffectAllowed);
    if (!guard()) {
      return { ok: false, error: "The authorizing glasses turn ended before commit; nothing was changed" };
    }
    let receipt: ClockTimerReceipt;
    try {
      receipt = deps.setTimer({
        operationId: request.operation_id,
        durationSeconds: request.duration_seconds,
        ...(request.label === undefined ? {} : { label: request.label }),
      }, guard);
    } catch (error) { return clockErrorResult(error); }
    const schedulerFailure = synchronizeNativeSchedule(deps);
    if (schedulerFailure) return schedulerFailure;
    if (!timerReceiptIsExact(receipt, request)) {
      return { ok: false, error: "Clock returned an unconfirmed timer result; check Clock before retrying" };
    }
    if (!guard()) {
      return { ok: false, error: "The timer may have been scheduled but the turn ended before confirmation; check Clock and retry only with the same operation_id" };
    }
    return { ok: true, content: JSON.stringify(receipt) };
  };
}

/** Fixed, active-turn-only phone boundary for one durable Clock alarm. */
export function createClockSetAlarmHandler(deps: ClockToolDependencies): ToolHandler {
  return (args, signal, isSideEffectAllowed, context) => {
    if (!isActiveAuthenticatedG2Turn(context)) {
      return { ok: false, error: "Clock accepts only an authenticated active turn from the even-g2 profile" };
    }
    let request: AlarmRequest;
    try { request = normalizeAlarmRequest(args); }
    catch (error) { return clockErrorResult(error); }
    const guard = () => isAuthorized(signal, isSideEffectAllowed);
    if (!guard()) {
      return { ok: false, error: "The authorizing glasses turn ended before commit; nothing was changed" };
    }
    let receipt: ClockAlarmReceipt;
    try {
      receipt = deps.setAlarm({
        operationId: request.operation_id,
        localTime: request.local_time,
        ...(request.date === undefined ? {} : { date: request.date }),
        ...(request.repeat_days === undefined ? {} : { repeatDays: request.repeat_days }),
        ...(request.label === undefined ? {} : { label: request.label }),
      }, guard);
    } catch (error) { return clockErrorResult(error); }
    const schedulerFailure = synchronizeNativeSchedule(deps);
    if (schedulerFailure) return schedulerFailure;
    if (!alarmReceiptIsExact(receipt, request)) {
      return { ok: false, error: "Clock returned an unconfirmed alarm result; check Clock before retrying" };
    }
    if (!guard()) {
      return { ok: false, error: "The alarm may have been scheduled but the turn ended before confirmation; check Clock and retry only with the same operation_id" };
    }
    return { ok: true, content: JSON.stringify(receipt) };
  };
}
