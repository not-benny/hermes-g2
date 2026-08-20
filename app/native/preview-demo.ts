/**
 * Preview-mode demo data. A "Preview only" user has no glasses and no ring, so
 * the Health tab and the on-phone HUD would be empty. This seeds ANONYMOUS mock
 * health data (no real identifiers) so the experience is explorable, and wipes
 * every trace when the user exits preview mode.
 *
 * The data is written to the same stores the real app uses (so charts/insights/
 * tiles/HUD light up unchanged) plus a mock ring snapshot; a flag records that it
 * is demo so we can clear exactly it on exit.
 */

import { ApplicationSettings } from "@nativescript/core";

import { ringHealthStore, type RingHealthSnapshot } from "../health/ring-health-store";
import { dateKeyOf, type DailyHealthSummary } from "../health/health-history";
import { type HourlyPoint } from "../health/health-hourly";
import { isPreviewOnlyMode } from "../phone-ui/onboarding-state";

const HOURLY_KEY = "health.hourly.v1";
const HISTORY_KEY = "health.history.v1";
const DEMO_FLAG = "preview.demoSeeded";
const DAY_MS = 24 * 60 * 60 * 1000;

// Deterministic, plausible daytime heart-rate curve (hours 6..20), bpm.
const HR_AVG = [58, 61, 66, 72, 74, 70, 76, 79, 75, 71, 68, 65, 63, 60, 57];
const HR_HOURS = HR_AVG.map((avg, i) => ({ hourIdx: 6 + i, avg, min: avg - 6, max: avg + (i % 3 === 0 ? 34 : 14) }));

function demoHourly(nowMs: number): HourlyPoint[] {
  const dateKey = dateKeyOf(nowMs);
  return HR_HOURS.map((h) => ({
    dateKey,
    hourIdx: h.hourIdx,
    hr: { avg: h.avg, max: h.max, min: h.min },
    spo2: { avg: 97, max: 99, min: 95 },
    hrv: { avg: 44 + (h.hourIdx % 5) * 3, max: 62, min: 38 },
  }));
}

function demoHistory(nowMs: number): DailyHealthSummary[] {
  const scores = [74, 66, 81, 69, 77]; // oldest -> newest
  return scores.map((readinessScore, i) => {
    const ms = nowMs - (scores.length - 1 - i) * DAY_MS;
    return {
      dateKey: dateKeyOf(ms),
      restingHr: 56 + (i % 3),
      hrMin: 52,
      hrMax: 128,
      hrvAvg: 45 + i,
      spo2Avg: 97,
      steps: 6200 + i * 400,
      sleepScore: null,
      sleepDurationMin: null,
      sleepDeepMin: null,
      sleepRemMin: null,
      bodyTempC: null,
      readinessScore,
      updatedAtMs: ms,
    };
  });
}

function demoSnapshot(nowMs: number): RingHealthSnapshot {
  const series = HR_HOURS.map((h) => ({ hourIdx: h.hourIdx, avg: h.avg, max: h.max, min: h.min }));
  const spo2Series = HR_HOURS.map((h) => ({ hourIdx: h.hourIdx, avg: 97, max: 99, min: 95 }));
  const hrvSeries = HR_HOURS.map((h) => ({ hourIdx: h.hourIdx, avg: 44 + (h.hourIdx % 5) * 3, max: 62, min: 38 }));
  const newest = series[series.length - 1];
  return {
    heartRate: newest,
    spo2: spo2Series[spo2Series.length - 1],
    temperature: null,
    hrv: hrvSeries[hrvSeries.length - 1],
    activity: { slots: [], totalSteps: 6480 },
    batteryPercent: 84,
    firmwareVersion: null,
    updatedAtMs: nowMs,
    heartRateSeries: series,
    spo2Series,
    hrvSeries,
    currentHr: 72,
    bodyTempC: null,
  };
}

/**
 * Seed anonymous demo health data when in preview mode. Persistent data is
 * written once (idempotent across restarts via DEMO_FLAG); the in-memory ring
 * snapshot is (re)installed every launch. No-op outside preview mode.
 */
export function seedPreviewDemo(nowMs: number = Date.now()): void {
  if (!isPreviewOnlyMode()) return;
  if (!ApplicationSettings.getBoolean(DEMO_FLAG, false)) {
    ApplicationSettings.setString(HOURLY_KEY, JSON.stringify(demoHourly(nowMs)));
    ApplicationSettings.setString(HISTORY_KEY, JSON.stringify(demoHistory(nowMs)));
    ApplicationSettings.setBoolean(DEMO_FLAG, true);
  }
  ringHealthStore.seedMock(demoSnapshot(nowMs));
}

/** Whether preview demo data has been seeded (drives the "demo data" note). */
export function isPreviewDemoSeeded(): boolean {
  return ApplicationSettings.getBoolean(DEMO_FLAG, false);
}

/** Delete every trace of the preview demo data (called on exiting preview). */
export function clearPreviewDemo(): void {
  ApplicationSettings.remove(HOURLY_KEY);
  ApplicationSettings.remove(HISTORY_KEY);
  ApplicationSettings.remove(DEMO_FLAG);
  ringHealthStore.reset();
}
