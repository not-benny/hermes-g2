/**
 * Process-wide persistence for decoded ring health.
 *
 * The phone Health view is optional UI and may never be instantiated during a
 * background/overnight ring session. This coordinator therefore owns durable
 * hourly accumulation and the derived daily/readiness row. It is framework
 * agnostic so the real single-key persistence adapter and restart behaviour can
 * be exercised under Node without constructing NativeScript UI.
 */

import {
  heartRateInsights,
  readinessScore,
  sleepInsights,
  sleepSessionFromRing,
  temperatureInsights,
  type HeartRateInsights,
  type ReadinessInsights,
  type SleepInsights,
  type TemperatureInsights,
} from "./health-insights";
import {
  computeBaselines,
  dateKeyOf,
  summarizeDay,
  type DailyHealthSummary,
  type DaySummaryInputs,
} from "./health-history";
import {
  buildHourlyPoints,
  hourlyForDay,
  upsertHourly,
  type HourlyPoint,
} from "./health-hourly";
import {
  canonicalizeActivitySnapshot,
  type RingActivitySnapshot,
  type RingHealthSnapshot,
} from "./ring-health-store";
import type { RingSleepData } from "./ring-parser";

type RingHour = {
  hourIdx: number;
  avg: number;
  max: number;
  min: number;
  timestampSec: number | null;
  timezoneOffsetMinutes: number | null;
};

export interface HealthPersistencePort {
  loadHealthHistory(): DailyHealthSummary[];
  recordHealthDay(inputs: DaySummaryInputs): DailyHealthSummary[];
  loadHourly(): HourlyPoint[];
  recordHourly(hr: RingHour[], spo2: RingHour[], hrv: RingHour[], nowMs: number): HourlyPoint[];
  loadActivity(nowMs?: number): RingActivitySnapshot | null;
  recordActivity(activity: RingActivitySnapshot | null): void;
  loadSleep(nowMs?: number): RingSleepData | null;
  recordSleep(sleep: RingSleepData | null): void;
}

export interface RestorableRingHealthStore {
  restoreActivity(activity: RingActivitySnapshot | null): void;
  restoreSleep(sleep: RingSleepData | null): void;
}

export type PersistedHealthProjection = {
  hourlyToday: HourlyPoint[];
  heartRate: HeartRateInsights;
  sleep: SleepInsights;
  temperature: TemperatureInsights;
  readiness: ReadinessInsights;
  latestHrv: RingHour | null;
  latestSpo2: RingHour | null;
};

const SUMMARY_FIELDS: ReadonlyArray<Exclude<keyof DailyHealthSummary, "dateKey" | "updatedAtMs">> = [
  "restingHr", "hrMin", "hrMax", "hrvAvg", "spo2Avg", "steps",
  "sleepScore", "sleepDurationMin", "sleepDeepMin", "sleepRemMin",
  "bodyTempC", "readinessScore",
];

function hoursFor(points: HourlyPoint[], metric: "hr" | "spo2" | "hrv"): RingHour[] {
  return points.flatMap((point) => {
    const value = point[metric];
    return value ? [{
      hourIdx: point.hourIdx,
      timestampSec: point.timestampSec ?? null,
      timezoneOffsetMinutes: point.timezoneOffsetMinutes ?? null,
      ...value,
    }] : [];
  });
}

function latestHour(hours: RingHour[]): RingHour | null {
  let latest: RingHour | null = null;
  for (const hour of hours) if (!latest || hour.hourIdx >= latest.hourIdx) latest = hour;
  return latest;
}

function dateKeyAtFixedOffset(timestampSec: number, timezoneOffsetMinutes: number): string {
  return new Date((timestampSec + timezoneOffsetMinutes * 60) * 1000).toISOString().slice(0, 10);
}

function sleepDateKey(sleep: RingSleepData | null): string | null {
  return sleep && Number.isInteger(sleep.timezoneOffsetMinutes) &&
    sleep.timezoneOffsetMinutes >= -840 && sleep.timezoneOffsetMinutes <= 840
    ? dateKeyAtFixedOffset(sleep.endTs, sleep.timezoneOffsetMinutes)
    : null;
}

function activityDateKey(activity: RingActivitySnapshot | null): string | null {
  return activity
    ? dateKeyAtFixedOffset(activity.dayBaseSec, activity.timezoneOffsetMinutes)
    : null;
}

function localMiddayMs(dateKey: string): number {
  const [year, month, day] = dateKey.split("-").map(Number);
  return new Date(year!, month! - 1, day!, 12, 0, 0, 0).getTime();
}

/**
 * `recordHealthDay` currently keys a row from `updatedAtMs` in the phone's
 * local timezone. Preserve a real source timestamp whenever it maps to the
 * authoritative ring date; at a phone/ring date boundary use local noon on
 * that calendar date so the adapter cannot assign the row to the adjacent day.
 */
function timestampForDateKey(dateKey: string, preferredMs: number): number {
  return dateKeyOf(preferredMs) === dateKey ? preferredMs : localMiddayMs(dateKey);
}

function isCurrentHourlyPoint(point: HourlyPoint, nowMs: number): boolean {
  if (point.timestampSec !== undefined && point.timezoneOffsetMinutes !== undefined) {
    const currentAtSource = dateKeyAtFixedOffset(
      Math.floor(nowMs / 1000),
      point.timezoneOffsetMinutes,
    );
    return point.dateKey === currentAtSource;
  }
  return point.dateKey === dateKeyOf(nowMs);
}

function sameHourly(left: HourlyPoint[], right: HourlyPoint[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function needsDailyWrite(history: DailyHealthSummary[], candidate: DailyHealthSummary): boolean {
  const previous = history.find((row) => row.dateKey === candidate.dateKey);
  if (!previous) return SUMMARY_FIELDS.some((field) => candidate[field] !== null);
  return SUMMARY_FIELDS.some((field) => candidate[field] !== null && candidate[field] !== previous[field]);
}

function deriveHealthProjectionForDay(
  snapshot: RingHealthSnapshot,
  hourly: HourlyPoint[],
  history: DailyHealthSummary[],
  nowMs: number,
  dayKey: string,
  includeSleep: boolean,
  baselineReferenceMs: number,
): PersistedHealthProjection {
  const hourlyToday = hourlyForDay(hourly, dayKey);
  const heartRateHours = hoursFor(hourlyToday, "hr");
  const spo2Hours = hoursFor(hourlyToday, "spo2");
  const hrvHours = hoursFor(hourlyToday, "hrv");
  const sleepSession = includeSleep ? sleepSessionFromRing(snapshot.sleep, nowMs) : null;
  const bodyTempC = sleepSession && snapshot.sleep?.bodyTemperatureDeciC !== null
    ? snapshot.sleep!.bodyTemperatureDeciC / 10
    : null;
  const inputs = {
    heartRate: heartRateHours,
    hrv: hrvHours,
    sleep: sleepSession,
    liveHr: snapshot.currentHr,
    bodyTempC,
    baselines: computeBaselines(history, baselineReferenceMs),
    nowMs,
  };
  return {
    hourlyToday,
    heartRate: heartRateInsights(inputs),
    sleep: sleepInsights(inputs),
    temperature: temperatureInsights(inputs),
    readiness: readinessScore(inputs),
    latestHrv: latestHour(hrvHours),
    latestSpo2: latestHour(spo2Hours),
  };
}

/** Derive the current UI projection; a fresh prior night may drive readiness for 36 hours. */
export function derivePersistedHealthProjection(
  snapshot: RingHealthSnapshot,
  hourly: HourlyPoint[],
  history: DailyHealthSummary[],
  nowMs: number,
): PersistedHealthProjection {
  return deriveHealthProjectionForDay(
    snapshot,
    hourly,
    history,
    nowMs,
    dateKeyOf(nowMs),
    true,
    nowMs,
  );
}

export class RingHealthPersistenceCoordinator {
  // RingHealthStore replaces a series array only when that metric receives a
  // new daily push. Remember those identities so an unrelated battery,
  // device-info, activity, or sleep emission cannot replay unanchored hours
  // under a different date after midnight.
  private lastHeartRateSeries: RingHealthSnapshot["heartRateSeries"] | null = null;
  private lastSpo2Series: RingHealthSnapshot["spo2Series"] | null = null;
  private lastHrvSeries: RingHealthSnapshot["hrvSeries"] | null = null;

  constructor(
    private readonly persistence: HealthPersistencePort,
    private readonly now: () => number = () => Date.now(),
    private readonly onError: (message: string) => void = () => {},
  ) {}

  /** Restore display-worthy current-day activity and the latest valid night before UI boot. */
  restoreInto(store: RestorableRingHealthStore): void {
    const nowMs = this.now();
    try { store.restoreActivity(this.persistence.loadActivity(nowMs)); }
    catch (error) { this.report("restore activity", error); }
    try { store.restoreSleep(this.persistence.loadSleep(nowMs)); }
    catch (error) { this.report("restore sleep", error); }
  }

  /** Persist one store emission. Errors stay outside the ring decode/notify path. */
  persist(snapshot: RingHealthSnapshot): PersistedHealthProjection | null {
    const nowMs = this.now();
    // A process can remain alive across local midnight. Canonicalize again at
    // the persistence boundary so a stale snapshot from any producer cannot
    // write yesterday's steps into today's daily summary.
    const activity = canonicalizeActivitySnapshot(snapshot.activity, nowMs);
    try { this.persistence.recordActivity(activity); }
    catch (error) { this.report("record activity", error); }
    try { this.persistence.recordSleep(snapshot.sleep); }
    catch (error) { this.report("record sleep", error); }

    const heartRateChanged = snapshot.heartRateSeries !== this.lastHeartRateSeries;
    const spo2Changed = snapshot.spo2Series !== this.lastSpo2Series;
    const hrvChanged = snapshot.hrvSeries !== this.lastHrvSeries;
    const heartRateSeries = heartRateChanged ? snapshot.heartRateSeries : [];
    const spo2Series = spo2Changed ? snapshot.spo2Series : [];
    const hrvSeries = hrvChanged ? snapshot.hrvSeries : [];

    let hourly: HourlyPoint[];
    let incomingHourly: HourlyPoint[] = [];
    try {
      const stored = this.persistence.loadHourly();
      const incoming = buildHourlyPoints(
        heartRateSeries,
        spo2Series,
        hrvSeries,
        nowMs,
      );
      incomingHourly = incoming;
      const merged = upsertHourly(stored, incoming, nowMs);
      if (!sameHourly(stored, merged)) {
        this.persistence.recordHourly(
          heartRateSeries,
          spo2Series,
          hrvSeries,
          nowMs,
        );
        hourly = this.persistence.loadHourly();
        if (!sameHourly(hourly, merged)) {
          throw new Error("hourly health write could not be verified");
        }
      } else {
        hourly = stored;
      }
      // Remember only after the durable comparison/write path succeeds. A
      // persistence failure leaves the changed identity eligible for retry.
      this.lastHeartRateSeries = snapshot.heartRateSeries;
      this.lastSpo2Series = snapshot.spo2Series;
      this.lastHrvSeries = snapshot.hrvSeries;
    } catch (error) {
      this.report("record hourly health", error);
      try { hourly = this.persistence.loadHourly(); } catch { hourly = []; }
    }

    let history: DailyHealthSummary[];
    try { history = this.persistence.loadHealthHistory(); }
    catch (error) {
      this.report("load health history", error);
      history = [];
    }
    // currentHr is delivered with the heart-rate daily push. Do not let a
    // retained point reading become today's evidence on an unrelated emission.
    const projection = derivePersistedHealthProjection({
      ...snapshot,
      currentHr: heartRateChanged ? snapshot.currentHr : null,
    }, hourly, history, nowMs);
    const sleepSession = sleepSessionFromRing(snapshot.sleep, nowMs);
    const sleepDay = sleepSession ? sleepDateKey(snapshot.sleep) : null;
    const activityDay = activityDateKey(activity);
    const durableDays = new Set<string>();
    if (sleepDay) durableDays.add(sleepDay);
    if (activityDay) durableDays.add(activityDay);
    for (const point of incomingHourly) durableDays.add(point.dateKey);
    // On restart there may be no fresh series identity, but today's accumulated
    // canonical hours are still evidence from which a missing summary can be
    // repaired. Anchored points choose "today" in their own fixed offset.
    for (const point of hourly) if (isCurrentHourlyPoint(point, nowMs)) durableDays.add(point.dateKey);
    if (durableDays.size === 0) return projection;

    for (const dayKey of [...durableDays].sort()) {
      const includeSleep = sleepDay === dayKey;
      const dayActivity = activityDay === dayKey ? activity : null;
      const dayHours = hourlyForDay(hourly, dayKey);
      if (!includeSleep && !dayActivity && dayHours.length === 0) continue;

      // A fresh prior night remains part of the returned UI readiness projection,
      // but it must never become sleep/temperature/readiness evidence on a later
      // activity or hourly row. Recompute each durable day from only its own
      // sources; when the wake date matches, all contributors combine normally.
      const dayProjection = deriveHealthProjectionForDay({
        ...snapshot,
        activity: dayActivity,
        sleep: includeSleep ? snapshot.sleep : null,
        currentHr: null,
      }, hourly, history, nowMs, dayKey, includeSleep, localMiddayMs(dayKey));
      const preferredUpdatedAtMs = includeSleep && sleepSession
        ? sleepSession.endTs * 1000
        : nowMs;
      const updatedAtMs = timestampForDateKey(dayKey, preferredUpdatedAtMs);
      const inputs: DaySummaryInputs = {
        hr: dayProjection.heartRate,
        sleep: dayProjection.sleep,
        readiness: dayProjection.readiness,
        hrvAvg: dayProjection.latestHrv?.avg ?? null,
        spo2Avg: dayProjection.latestSpo2?.avg ?? null,
        steps: dayActivity?.totalSteps ?? null,
        bodyTempC: dayProjection.temperature.currentC,
        updatedAtMs,
      };
      const candidate = summarizeDay(dayKey, inputs);
      if (!needsDailyWrite(history, candidate)) continue;
      try {
        const written = this.persistence.recordHealthDay(inputs);
        if (Array.isArray(written)) history = written;
      } catch (error) {
        this.report("record daily health", error);
      }
    }
    return projection;
  }

  private report(operation: string, error: unknown): void {
    try { this.onError(`${operation} failed: ${String(error)}`); } catch { /* diagnostics are non-authoritative */ }
  }
}
