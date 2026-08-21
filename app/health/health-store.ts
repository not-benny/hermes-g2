/**
 * Pure model for the app-private ring-health document. Persistence and sharing
 * live in native adapters; this module only validates, merges, prunes, and
 * projects caller-supplied data.
 */
import { upsertSummary, type DailyHealthSummary } from "./health-history";
import type { HourlyMetric, HourlyPoint } from "./health-hourly";
import { canonicalizeActivitySnapshot, type RingActivitySnapshot } from "./ring-health-store";

export const HEALTH_RETENTION_DAYS = 90;

export interface HealthStoreDocument {
  version: 1;
  updatedAtMs: number;
  retentionDays: 90;
  history: DailyHealthSummary[];
  hourly: HourlyPoint[];
  activity: RingActivitySnapshot | null;
}

export interface HealthQueryArgs {
  end_date?: string;
  days?: number;
  include_hourly?: boolean;
}

export interface RingHealthQueryResult {
  source: "hermes-g2-ring";
  schemaVersion: 1;
  generatedAtMs: number;
  retentionDays: 90;
  range: { startDate: string; endDate: string };
  hourlyIncluded: boolean;
  history: DailyHealthSummary[];
  hourly?: HourlyPoint[];
  activityTotals?: {
    dateKey: string;
    totalSteps: number;
    activeCalories: number;
    totalCalories: number;
    restingCalories: number;
  };
}

export type HealthQueryOutcome = {
  ok: boolean;
  value?: RingHealthQueryResult;
  error?: string;
};

const DAILY_METRICS: Array<Exclude<keyof DailyHealthSummary, "dateKey" | "updatedAtMs">> = [
  "restingHr", "hrMin", "hrMax", "hrvAvg", "spo2Avg", "steps", "sleepScore",
  "sleepDurationMin", "sleepDeepMin", "sleepRemMin", "bodyTempC", "readinessScore",
];

/** Local YYYY-MM-DD for a Date, using calendar fields rather than UTC. */
export function localDateKey(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Parse a real local calendar date. Invalid or normalized dates fail closed. */
export function parseLocalDateKey(value: unknown): Date | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  return date;
}

export function retentionStartDateKey(nowMs: number, retentionDays = HEALTH_RETENTION_DAYS): string {
  const now = new Date(nowMs);
  return localDateKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - (retentionDays - 1)));
}

function canonicalDaily(value: unknown): DailyHealthSummary | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (!parseLocalDateKey(raw.dateKey) || typeof raw.updatedAtMs !== "number" || !Number.isFinite(raw.updatedAtMs)) return null;
  const row: Record<string, unknown> = { dateKey: raw.dateKey, updatedAtMs: raw.updatedAtMs };
  for (const field of DAILY_METRICS) {
    const metric = raw[field];
    if (metric === undefined || metric === null) row[field] = null;
    else if (typeof metric === "number" && Number.isFinite(metric)) row[field] = metric;
    else return null;
  }
  return row as unknown as DailyHealthSummary;
}

function canonicalMetric(value: unknown): HourlyMetric | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (![raw.avg, raw.max, raw.min].every((metric) => typeof metric === "number" && Number.isFinite(metric))) return null;
  return { avg: raw.avg as number, max: raw.max as number, min: raw.min as number };
}

function canonicalHourly(value: unknown): HourlyPoint | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (!parseLocalDateKey(raw.dateKey) || !Number.isInteger(raw.hourIdx) || (raw.hourIdx as number) < 0 || (raw.hourIdx as number) > 23) return null;
  const point: HourlyPoint = { dateKey: raw.dateKey as string, hourIdx: raw.hourIdx as number };
  if (raw.timestampSec !== undefined) {
    if (!Number.isInteger(raw.timestampSec) || (raw.timestampSec as number) < 0) return null;
    if (!Number.isInteger(raw.timezoneOffsetMinutes) ||
      (raw.timezoneOffsetMinutes as number) < -840 || (raw.timezoneOffsetMinutes as number) > 840) return null;
    const fixedLocal = new Date(((raw.timestampSec as number) +
      (raw.timezoneOffsetMinutes as number) * 60) * 1000);
    if (fixedLocal.toISOString().slice(0, 10) !== raw.dateKey ||
      fixedLocal.getUTCHours() !== raw.hourIdx) return null;
    point.timestampSec = raw.timestampSec as number;
    point.timezoneOffsetMinutes = raw.timezoneOffsetMinutes as number;
  } else if (raw.timezoneOffsetMinutes !== undefined) {
    return null;
  }
  for (const field of ["hr", "spo2", "hrv"] as const) {
    if (raw[field] === undefined) continue;
    const metric = canonicalMetric(raw[field]);
    if (!metric) return null;
    point[field] = metric;
  }
  return point.hr || point.spo2 || point.hrv ? point : null;
}

function canonicalHistory(value: unknown, cutoff: string, today: string): DailyHealthSummary[] {
  let history: DailyHealthSummary[] = [];
  if (!Array.isArray(value)) return history;
  for (const candidate of value) {
    const row = canonicalDaily(candidate);
    if (!row || row.dateKey < cutoff || row.dateKey > today) continue;
    history = upsertSummary(history, row, HEALTH_RETENTION_DAYS);
  }
  return history;
}

function canonicalHourlyRows(value: unknown, cutoff: string, today: string, nowMs: number): HourlyPoint[] {
  const rows = new Map<string, HourlyPoint>();
  if (!Array.isArray(value)) return [];
  for (const candidate of value) {
    const point = canonicalHourly(candidate);
    if (!point) continue;
    if (point.timestampSec !== undefined) {
      const timestampMs = point.timestampSec * 1000;
      if (timestampMs > nowMs || timestampMs < nowMs - HEALTH_RETENTION_DAYS * 86400000) continue;
    } else if (point.dateKey < cutoff || point.dateKey > today) continue;
    const key = `${point.dateKey}#${point.hourIdx}`;
    const previous = rows.get(key);
    rows.set(key, {
      dateKey: point.dateKey,
      hourIdx: point.hourIdx,
      timestampSec: point.timestampSec ?? previous?.timestampSec,
      timezoneOffsetMinutes: point.timezoneOffsetMinutes ?? previous?.timezoneOffsetMinutes,
      hr: point.hr ?? previous?.hr,
      spo2: point.spo2 ?? previous?.spo2,
      hrv: point.hrv ?? previous?.hrv,
    });
  }
  return Array.from(rows.values()).sort((a, b) =>
    a.dateKey === b.dateKey ? a.hourIdx - b.hourIdx : a.dateKey.localeCompare(b.dateKey),
  );
}

/** Normalize arbitrary persisted JSON into the exact v1 document contract. */
export function canonicalizeHealthDocument(value: unknown, nowMs = Date.now()): HealthStoreDocument {
  const raw = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const today = localDateKey(new Date(nowMs));
  const cutoff = retentionStartDateKey(nowMs);
  return {
    version: 1,
    updatedAtMs: typeof raw.updatedAtMs === "number" && Number.isFinite(raw.updatedAtMs) ? raw.updatedAtMs : nowMs,
    retentionDays: HEALTH_RETENTION_DAYS,
    history: canonicalHistory(raw.history, cutoff, today),
    hourly: canonicalHourlyRows(raw.hourly, cutoff, today, nowMs),
    activity: canonicalizeActivitySnapshot(raw.activity, nowMs),
  };
}

function calendarDaysBefore(date: Date, days: number): string {
  return localDateKey(new Date(date.getFullYear(), date.getMonth(), date.getDate() - days));
}

/** Build the compact, privacy-bounded assistant projection for one date range. */
export function queryHealthDocument(
  document: unknown,
  args: HealthQueryArgs = {},
  nowMs = Date.now(),
): HealthQueryOutcome {
  const today = localDateKey(new Date(nowMs));
  const cutoff = retentionStartDateKey(nowMs);
  const endDate = args.end_date ?? today;
  if (!parseLocalDateKey(endDate)) return { ok: false, error: "end_date must be a real local YYYY-MM-DD date" };
  if (endDate > today) return { ok: false, error: "end_date cannot be in the future" };
  if (endDate < cutoff) return { ok: false, error: `end_date is older than the ${HEALTH_RETENTION_DAYS}-day retained window` };

  const days = args.days ?? 7;
  if (!Number.isInteger(days) || days < 1 || days > 31) {
    return { ok: false, error: "days must be an integer from 1 to 31" };
  }
  if (args.include_hourly !== undefined && typeof args.include_hourly !== "boolean") {
    return { ok: false, error: "include_hourly must be a boolean" };
  }

  const parsedEnd = parseLocalDateKey(endDate)!;
  const requestedStart = calendarDaysBefore(parsedEnd, days - 1);
  const startDate = requestedStart < cutoff ? cutoff : requestedStart;
  const canonical = canonicalizeHealthDocument(document, nowMs);
  const inRange = (dateKey: string) => dateKey >= startDate && dateKey <= endDate;
  const result: RingHealthQueryResult = {
    source: "hermes-g2-ring",
    schemaVersion: 1,
    generatedAtMs: nowMs,
    retentionDays: HEALTH_RETENTION_DAYS,
    range: { startDate, endDate },
    hourlyIncluded: args.include_hourly ?? false,
    history: canonical.history.filter((row) => inRange(row.dateKey)),
  };
  if (result.hourlyIncluded) result.hourly = canonical.hourly.filter((point) => inRange(point.dateKey));
  if (canonical.activity && inRange(today)) {
    result.activityTotals = {
      dateKey: today,
      totalSteps: canonical.activity.totalSteps,
      activeCalories: canonical.activity.activeCalories,
      totalCalories: canonical.activity.totalCalories,
      restingCalories: canonical.activity.restingCalories,
    };
  }
  return { ok: true, value: result };
}
