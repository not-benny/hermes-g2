/**
 * Pure health-insight math for the R1 ring: heart-rate insights, sleep insights,
 * and a Readiness/Productivity score. No NativeScript imports - transpile-and-
 * import testable like ring-parser.ts. Everything degrades gracefully: each
 * function returns nulls / "unavailable" until the relevant data is present, and
 * the Readiness score renormalizes its weights over whatever contributors exist,
 * so it works the day HR alone starts flowing and improves as more metrics land.
 *
 * Honesty (verified via the Even app's decoded DB + the wire-format research):
 * the HOURLY temperature metric (cmd 3) is reserved/never sent, but the NIGHTLY
 * body temperature rides the sleep record (`body_temp`, deci-degC, populated on
 * full nights) and is shown - like Oura - as a VARIATION from baseline; it is a
 * readiness contributor. HRV/HR byte layouts are provisional until a worn
 * capture confirms them, so the module tolerates any input being absent.
 */

import type { RingHealthSample, RingHrvSample, RingActivitySample } from "./ring-parser";

export interface MetricBaseline {
  mean: number;
  sd: number;
  n: number;
}

/** Assembled sleep session (from the cmd=6 decoder + store assembly). */
export interface SleepSession {
  startTs: number; // epoch seconds
  endTs: number; // epoch seconds
  totalSleepMin: number | null;
  timeInBedMin: number | null;
  deepMin: number | null;
  lightMin: number | null;
  remMin: number | null;
  awakeMin: number | null;
  efficiencyPct: number | null;
  /** Data confidence: none (undecoded), duration-only, or full stage breakdown. */
  available: "none" | "duration-only" | "full";
}

export interface InsightInputs {
  heartRate?: RingHealthSample[]; // today's hourly records
  hrv?: RingHrvSample[];
  activity?: RingActivitySample[];
  sleep?: SleepSession | null;
  liveHr?: number | null; // from the point-push stream when wired
  bodyTempC?: number | null; // latest night's skin temperature, degC
  baselines?: {
    restingHr?: MetricBaseline;
    hrv?: MetricBaseline;
    sleepDurationMin?: MetricBaseline;
    bodyTempC?: MetricBaseline;
  };
  targets?: { sleepMin?: number };
  nowMs?: number;
}

export interface HeartRateInsights {
  current: number | null;
  source: "live" | "hourly" | null;
  restingHr: number | null;
  min: number | null;
  max: number | null;
  avg: number | null;
  trend: { direction: "up" | "down" | "flat"; deltaBpm: number } | null;
}

export interface SleepInsights {
  totalSleepMin: number | null;
  timeInBedMin: number | null;
  efficiencyPct: number | null;
  stages: { awakeMin: number; lightMin: number; deepMin: number; remMin: number } | null;
  score: number | null;
  available: "none" | "duration-only" | "full";
}

export interface TemperatureInsights {
  /** Latest night's skin temperature, degC (null if no full night yet). */
  currentC: number | null;
  /** Deviation from the personal baseline, degC (null until baseline n>=3). */
  deviationC: number | null;
  available: boolean;
}

export interface Contributor {
  key: "restingHr" | "hrv" | "sleep" | "temperature" | "recovery";
  label: string;
  score: number;
  weight: number;
  available: boolean;
}

export interface ReadinessInsights {
  score: number | null;
  band: "low" | "moderate" | "good" | "optimal";
  contributors: Contributor[];
  coverage: number;
  confidence: "low" | "medium" | "high";
}

// --- helpers -----------------------------------------------------------------
function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}
function clamp01(x: number): number {
  return clamp(x, 0, 1);
}
function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

// --- heart-rate insights -----------------------------------------------------
export function heartRateInsights(i: InsightInputs): HeartRateInsights {
  const recs = i.heartRate ?? [];
  if (!recs.length) {
    const live = typeof i.liveHr === "number" ? i.liveHr : null;
    return {
      current: live,
      source: live !== null ? "live" : null,
      restingHr: null, min: null, max: null, avg: null, trend: null,
    };
  }
  const min = Math.min(...recs.map((r) => r.min));
  const max = Math.max(...recs.map((r) => r.max));
  const avg = Math.round(mean(recs.map((r) => r.avg)));
  const current = typeof i.liveHr === "number"
    ? i.liveHr
    : Math.round(recs[recs.length - 1]!.avg);
  const source: "live" | "hourly" = typeof i.liveHr === "number" ? "live" : "hourly";

  // Resting HR: mean of the lowest quartile of hourly averages (robust to noise,
  // approximates sleeping/resting HR without needing sleep staging).
  const sortedAvgs = recs.map((r) => r.avg).sort((a, b) => a - b);
  const q = Math.max(1, Math.floor(sortedAvgs.length / 4));
  const restingHr = Math.round(mean(sortedAvgs.slice(0, q)));

  let trend: HeartRateInsights["trend"] = null;
  const base = i.baselines?.restingHr;
  if (base && base.n >= 3) {
    const deltaBpm = Math.round(restingHr - base.mean);
    const direction = deltaBpm <= -2 ? "down" : deltaBpm >= 2 ? "up" : "flat";
    trend = { direction, deltaBpm };
  }
  return { current, source, restingHr, min, max, avg, trend };
}

// --- sleep insights ----------------------------------------------------------
export function sleepInsights(i: InsightInputs): SleepInsights {
  const s = i.sleep;
  if (!s || s.available === "none") {
    return { totalSleepMin: null, timeInBedMin: null, efficiencyPct: null, stages: null, score: null, available: "none" };
  }
  const target = i.targets?.sleepMin ?? 480;
  const total = s.totalSleepMin;
  if (s.available === "duration-only" || s.deepMin === null || s.lightMin === null || s.remMin === null || s.awakeMin === null) {
    const durationScore = total !== null ? clamp01(total / target) * 100 : null;
    return {
      totalSleepMin: total, timeInBedMin: s.timeInBedMin, efficiencyPct: s.efficiencyPct,
      stages: null, score: durationScore === null ? null : Math.round(durationScore), available: "duration-only",
    };
  }
  const stages = { awakeMin: s.awakeMin, lightMin: s.lightMin, deepMin: s.deepMin, remMin: s.remMin };
  const totalMin = total ?? (stages.lightMin + stages.deepMin + stages.remMin);
  const eff = s.efficiencyPct ?? (s.timeInBedMin ? (totalMin / s.timeInBedMin) * 100 : 0);
  const durationScore = clamp01(totalMin / target) * 100;
  const efficiencyScore = clamp((eff - 75) / (95 - 75), 0, 1) * 100;
  const deepRemScore = clamp((stages.deepMin + stages.remMin) / (0.4 * Math.max(1, totalMin)), 0, 1) * 100;
  const restfulnessScore = clamp(1 - stages.awakeMin / 60, 0, 1) * 100;
  const score = weightedRenorm([
    [durationScore, 0.4], [efficiencyScore, 0.2], [deepRemScore, 0.25], [restfulnessScore, 0.15],
  ]);
  return {
    totalSleepMin: totalMin, timeInBedMin: s.timeInBedMin, efficiencyPct: Math.round(eff),
    stages, score: Math.round(score), available: "full",
  };
}

// --- temperature (nightly body-temp variation from baseline) ----------------
export function temperatureInsights(i: InsightInputs): TemperatureInsights {
  const currentC = typeof i.bodyTempC === "number" ? i.bodyTempC : null;
  const base = i.baselines?.bodyTempC;
  const deviationC = currentC !== null && base && base.n >= 3
    ? Math.round((currentC - base.mean) * 10) / 10
    : null;
  return { currentC, deviationC, available: currentC !== null };
}

/** Readiness sub-score from |deviation|: on-baseline = 100, a large swing = low. */
function temperatureScore(deviationC: number): number {
  return clamp(100 - (Math.abs(deviationC) / 0.5) * 40, 20, 100);
}

function weightedRenorm(pairs: Array<[number, number]>): number {
  const totalW = pairs.reduce((a, [, w]) => a + w, 0);
  if (totalW === 0) return 0;
  return pairs.reduce((a, [v, w]) => a + v * w, 0) / totalW;
}

// --- readiness / productivity score -----------------------------------------
function restingHrScore(rhr: number, base?: MetricBaseline): number {
  if (base && base.n >= 3) {
    const z = (base.mean - rhr) / Math.max(base.sd, 1); // lower rhr = better
    return clamp(50 + z * 20, 0, 100);
  }
  if (rhr <= 50) return 100;
  if (rhr >= 85) return 20;
  return 100 - ((rhr - 50) / (85 - 50)) * (100 - 20);
}
function hrvScore(hrvMs: number, base?: MetricBaseline): number {
  if (base && base.n >= 3) {
    const z = (hrvMs - base.mean) / Math.max(base.sd, 1); // higher hrv = better
    return clamp(50 + z * 20, 0, 100);
  }
  if (hrvMs >= 70) return 100;
  if (hrvMs <= 15) return 20;
  return 20 + ((hrvMs - 15) / (70 - 15)) * (100 - 20);
}

export function readinessScore(i: InsightInputs): ReadinessInsights {
  const hr = heartRateInsights(i);
  const sleep = sleepInsights(i);
  const temp = temperatureInsights(i);
  const hrvRecs = i.hrv ?? [];
  const hrvAvg = hrvRecs.length ? mean(hrvRecs.map((r) => r.latest)) : null;

  const contributors: Contributor[] = [
    {
      key: "restingHr", label: "Resting HR", weight: 0.2,
      available: hr.restingHr !== null,
      score: hr.restingHr !== null ? restingHrScore(hr.restingHr, i.baselines?.restingHr) : 0,
    },
    {
      key: "hrv", label: "HRV", weight: 0.25,
      available: hrvAvg !== null,
      score: hrvAvg !== null ? hrvScore(hrvAvg, i.baselines?.hrv) : 0,
    },
    {
      key: "sleep", label: "Sleep", weight: 0.3,
      available: sleep.score !== null,
      score: sleep.score ?? 0,
    },
    {
      key: "temperature", label: "Body temp", weight: 0.1,
      available: temp.deviationC !== null,
      score: temp.deviationC !== null ? temperatureScore(temp.deviationC) : 0,
    },
    {
      key: "recovery", label: "Recovery", weight: 0.15,
      available: false, // prior-day strain: weak signal, off until wired
      score: 60,
    },
  ];

  const present = contributors.filter((c) => c.available);
  if (present.length === 0) {
    return { score: null, band: "low", contributors, coverage: 0, confidence: "low" };
  }
  const totalW = present.reduce((a, c) => a + c.weight, 0);
  const score = Math.round(present.reduce((a, c) => a + c.score * c.weight, 0) / totalW);
  const coverage = totalW; // weights sum to 1.0 when all present
  const has = (k: Contributor["key"]) => present.some((c) => c.key === k);
  const confidence: ReadinessInsights["confidence"] =
    has("sleep") && has("hrv") && has("restingHr") ? "high" : present.length >= 2 ? "medium" : "low";
  const band: ReadinessInsights["band"] =
    score >= 85 ? "optimal" : score >= 65 ? "good" : score >= 40 ? "moderate" : "low";
  return { score, band, contributors, coverage, confidence };
}
