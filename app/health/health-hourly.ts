/**
 * Hourly health accumulation (pure). The ring hands over only its recent cached
 * hours per poll and then reports empty, so to build an hour-by-hour history we
 * must persist each poll's hours and merge them over time. Even's deep history
 * is cloud-backfilled (which we don't have), so this local accumulation is how
 * the app grows a real per-hour record across days.
 *
 * No NativeScript imports (unit-tested under Node). The impure load/save/record
 * wrappers live in app/native/health-store.ts.
 */

import { dateKeyOf } from "./health-history";

/** avg/max/min for one metric in one hour. */
export interface HourlyMetric {
  avg: number;
  max: number;
  min: number;
}

/** One hour of health data, keyed by local day + hour-of-day. */
export interface HourlyPoint {
  dateKey: string; // "YYYY-MM-DD" (local)
  hourIdx: number; // 0..23
  /** Absolute epoch second supplied by a validated ring day anchor. */
  timestampSec?: number;
  /** Fixed offset supplied with the ring day anchor. */
  timezoneOffsetMinutes?: number;
  hr?: HourlyMetric;
  spo2?: HourlyMetric;
  hrv?: HourlyMetric;
}

/** Minimal hour record shape the ring parser produces. */
interface RingHour {
  hourIdx: number;
  avg: number;
  max: number;
  min: number;
  timestampSec?: number | null;
  timezoneOffsetMinutes?: number | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Which local date an hour-of-day belongs to, given "now". The ring reports an
 * hour-of-day with no date; an hourIdx later than the current hour hasn't
 * happened today, so it must be yesterday's (e.g. overnight hours pulled after
 * midnight). Everything at or before the current hour is today.
 */
export function dateForHour(hourIdx: number, nowMs: number): string {
  const now = new Date(nowMs);
  const ms = hourIdx > now.getHours() ? nowMs - DAY_MS : nowMs;
  return dateKeyOf(ms);
}

function toMetric(r: RingHour): HourlyMetric {
  return { avg: r.avg, max: r.max, min: r.min };
}

function dateKeyAtOffset(timestampSec: number, timezoneOffsetMinutes: number): string {
  return new Date((timestampSec + timezoneOffsetMinutes * 60) * 1000).toISOString().slice(0, 10);
}

/**
 * Turn a poll's per-metric hour records into merged HourlyPoints, one per
 * (date, hour). Each metric is attached where present.
 */
export function buildHourlyPoints(
  hr: RingHour[],
  spo2: RingHour[],
  hrv: RingHour[],
  nowMs: number,
): HourlyPoint[] {
  const byKey = new Map<string, HourlyPoint>();
  const at = (r: RingHour): HourlyPoint => {
    const timestampSec = Number.isInteger(r.timestampSec) && (r.timestampSec as number) >= 0
      ? r.timestampSec as number
      : undefined;
    const timezoneOffsetMinutes = timestampSec !== undefined && Number.isInteger(r.timezoneOffsetMinutes) &&
      (r.timezoneOffsetMinutes as number) >= -840 && (r.timezoneOffsetMinutes as number) <= 840
      ? r.timezoneOffsetMinutes as number
      : undefined;
    const dateKey = timestampSec === undefined
      ? dateForHour(r.hourIdx, nowMs)
      : timezoneOffsetMinutes === undefined
        ? dateKeyOf(timestampSec * 1000)
        : dateKeyAtOffset(timestampSec, timezoneOffsetMinutes);
    const key = `${dateKey}#${r.hourIdx}`;
    let p = byKey.get(key);
    if (!p) {
      p = {
        dateKey, hourIdx: r.hourIdx,
        ...(timestampSec === undefined ? {} : { timestampSec }),
        ...(timezoneOffsetMinutes === undefined ? {} : { timezoneOffsetMinutes }),
      };
      byKey.set(key, p);
    } else if (p.timestampSec === undefined && timestampSec !== undefined) {
      p.timestampSec = timestampSec;
      if (timezoneOffsetMinutes !== undefined) p.timezoneOffsetMinutes = timezoneOffsetMinutes;
    }
    return p;
  };
  for (const r of hr) at(r).hr = toMetric(r);
  for (const r of spo2) at(r).spo2 = toMetric(r);
  for (const r of hrv) at(r).hrv = toMetric(r);
  return Array.from(byKey.values());
}

function keyOf(p: { dateKey: string; hourIdx: number }): string {
  return `${p.dateKey}#${p.hourIdx}`;
}

/**
 * Merge incoming hours into the stored history: newer metric values win, but a
 * metric the incoming poll lacks never erases one already stored. Points older
 * than `retentionDays` are dropped. Returns a fresh, chronologically sorted
 * array (never mutates the input).
 */
export function upsertHourly(
  store: HourlyPoint[],
  incoming: HourlyPoint[],
  nowMs: number,
  retentionDays = 90,
): HourlyPoint[] {
  const cutoff = dateKeyOf(nowMs - retentionDays * DAY_MS);
  const merged = new Map<string, HourlyPoint>();
  for (const p of store) {
    if (p.dateKey >= cutoff) merged.set(keyOf(p), { ...p });
  }
  for (const p of incoming) {
    if (p.dateKey < cutoff) continue;
    const existing = merged.get(keyOf(p));
    merged.set(keyOf(p), {
      dateKey: p.dateKey,
      hourIdx: p.hourIdx,
      timestampSec: p.timestampSec ?? existing?.timestampSec,
      timezoneOffsetMinutes: p.timezoneOffsetMinutes ?? existing?.timezoneOffsetMinutes,
      hr: p.hr ?? existing?.hr,
      spo2: p.spo2 ?? existing?.spo2,
      hrv: p.hrv ?? existing?.hrv,
    });
  }
  return Array.from(merged.values()).sort((a, b) =>
    a.dateKey === b.dateKey ? a.hourIdx - b.hourIdx : a.dateKey < b.dateKey ? -1 : 1,
  );
}

/** All stored hours for one day, sorted by hour. */
export function hourlyForDay(store: HourlyPoint[], dateKey: string): HourlyPoint[] {
  return store.filter((p) => p.dateKey === dateKey).sort((a, b) => a.hourIdx - b.hourIdx);
}
