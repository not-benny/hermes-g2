/**
 * Pure historic-logging core for ring health: one DailyHealthSummary per day,
 * plus baseline computation (for the readiness score) and CSV export. No
 * NativeScript imports (only `import type`, elided at transpile) so it is
 * unit-testable like ring-parser.ts. Persistence + file/Hermes export live in
 * the impure health-export module; this module is all data-in / data-out.
 */

import type { MetricBaseline, HeartRateInsights, SleepInsights, ReadinessInsights } from "./health-insights";

export interface DailyHealthSummary {
  dateKey: string; // "YYYY-MM-DD" (local)
  restingHr: number | null;
  hrMin: number | null;
  hrMax: number | null;
  hrvAvg: number | null;
  spo2Avg: number | null;
  steps: number | null;
  sleepScore: number | null;
  sleepDurationMin: number | null;
  sleepDeepMin: number | null;
  sleepRemMin: number | null;
  bodyTempC: number | null;
  readinessScore: number | null;
  updatedAtMs: number;
}

/** Local YYYY-MM-DD for an epoch-ms timestamp. */
export function dateKeyOf(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => (n < 10 ? `0${n}` : String(n));
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export interface DaySummaryInputs {
  hr?: HeartRateInsights;
  sleep?: SleepInsights;
  readiness?: ReadinessInsights;
  hrvAvg?: number | null;
  spo2Avg?: number | null;
  steps?: number | null;
  bodyTempC?: number | null;
  updatedAtMs: number;
}

/** Build one day's summary from the computed insights (all fields nullable). */
export function summarizeDay(dateKey: string, i: DaySummaryInputs): DailyHealthSummary {
  return {
    dateKey,
    restingHr: i.hr?.restingHr ?? null,
    hrMin: i.hr?.min ?? null,
    hrMax: i.hr?.max ?? null,
    hrvAvg: i.hrvAvg ?? null,
    spo2Avg: i.spo2Avg ?? null,
    steps: i.steps ?? null,
    sleepScore: i.sleep?.score ?? null,
    sleepDurationMin: i.sleep?.totalSleepMin ?? null,
    sleepDeepMin: i.sleep?.stages?.deepMin ?? null,
    sleepRemMin: i.sleep?.stages?.remMin ?? null,
    bodyTempC: i.bodyTempC ?? null,
    readinessScore: i.readiness?.score ?? null,
    updatedAtMs: i.updatedAtMs,
  };
}

/**
 * Insert-or-replace a day's summary (keyed by dateKey), keep sorted ascending,
 * and cap to the most recent maxDays. Never overwrites a richer value with null:
 * merges field-by-field so a later same-day partial poll can't erase earlier data.
 */
export function upsertSummary(
  history: readonly DailyHealthSummary[],
  s: DailyHealthSummary,
  maxDays = 90,
): DailyHealthSummary[] {
  const out = history.filter((h) => h.dateKey !== s.dateKey);
  const prev = history.find((h) => h.dateKey === s.dateKey);
  const merged = prev ? mergeSummary(prev, s) : s;
  out.push(merged);
  out.sort((a, b) => a.dateKey.localeCompare(b.dateKey));
  return out.length > maxDays ? out.slice(out.length - maxDays) : out;
}

function mergeSummary(prev: DailyHealthSummary, next: DailyHealthSummary): DailyHealthSummary {
  const pick = <K extends keyof DailyHealthSummary>(k: K): DailyHealthSummary[K] =>
    (next[k] === null || next[k] === undefined ? prev[k] : next[k]);
  return {
    dateKey: next.dateKey,
    restingHr: pick("restingHr"), hrMin: pick("hrMin"), hrMax: pick("hrMax"),
    hrvAvg: pick("hrvAvg"), spo2Avg: pick("spo2Avg"), steps: pick("steps"),
    sleepScore: pick("sleepScore"), sleepDurationMin: pick("sleepDurationMin"),
    sleepDeepMin: pick("sleepDeepMin"), sleepRemMin: pick("sleepRemMin"),
    bodyTempC: pick("bodyTempC"), readinessScore: pick("readinessScore"),
    updatedAtMs: Math.max(prev.updatedAtMs, next.updatedAtMs),
  };
}

function baselineOf(values: number[]): MetricBaseline | undefined {
  if (values.length < 3) return undefined;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) * (b - mean), 0) / values.length;
  return { mean, sd: Math.sqrt(variance), n: values.length };
}

/** Baselines over the trailing `days` (excluding today), min n=3 to be usable. */
export function computeBaselines(
  history: readonly DailyHealthSummary[],
  nowMs: number,
  days = 14,
): { restingHr?: MetricBaseline; hrv?: MetricBaseline; sleepDurationMin?: MetricBaseline; bodyTempC?: MetricBaseline } {
  const today = dateKeyOf(nowMs);
  const cutoff = dateKeyOf(nowMs - days * 86400000);
  const window = history.filter((h) => h.dateKey >= cutoff && h.dateKey < today);
  const nums = (sel: (h: DailyHealthSummary) => number | null): number[] =>
    window.map(sel).filter((v): v is number => typeof v === "number");
  return {
    restingHr: baselineOf(nums((h) => h.restingHr)),
    hrv: baselineOf(nums((h) => h.hrvAvg)),
    sleepDurationMin: baselineOf(nums((h) => h.sleepDurationMin)),
    bodyTempC: baselineOf(nums((h) => h.bodyTempC)),
  };
}

const CSV_COLUMNS: Array<keyof DailyHealthSummary> = [
  "dateKey", "restingHr", "hrMin", "hrMax", "hrvAvg", "spo2Avg", "steps",
  "sleepScore", "sleepDurationMin", "sleepDeepMin", "sleepRemMin", "bodyTempC", "readinessScore",
];

/** Full history as CSV (one row per day, blank cells for null). */
export function historyToCsv(history: readonly DailyHealthSummary[]): string {
  const header = CSV_COLUMNS.join(",");
  const rows = history.map((h) =>
    CSV_COLUMNS.map((c) => (h[c] === null || h[c] === undefined ? "" : String(h[c]))).join(","),
  );
  return [header, ...rows].join("\n") + "\n";
}
