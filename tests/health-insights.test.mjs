import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

// health-insights.ts is pure (only `import type` from ring-parser, elided by
// transpile). Load the real implementation and exercise it against the actual
// decoded values pulled from the official Even app's health DB.
const src = readFileSync(new URL("../app/health/health-insights.ts", import.meta.url), "utf8");
const js = ts.transpileModule(src, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
}).outputText;
const { heartRateInsights, sleepInsights, readinessScore, temperatureInsights } = await import(
  "data:text/javascript;base64," + Buffer.from(js).toString("base64")
);

// Real HR hourly series (Even DB, 08-18 14:00..22:00): avg/max/min per hour.
const HR = [
  { hourIdx: 14, avg: 87, min: 71, max: 107 },
  { hourIdx: 15, avg: 102, min: 88, max: 115 },
  { hourIdx: 16, avg: 96, min: 80, max: 116 },
  { hourIdx: 17, avg: 104, min: 100, max: 107 },
  { hourIdx: 18, avg: 106, min: 97, max: 119 },
  { hourIdx: 19, avg: 105, min: 103, max: 108 },
  { hourIdx: 20, avg: 115, min: 111, max: 121 },
  { hourIdx: 22, avg: 98, min: 76, max: 116 },
];
const HRV = [{ hourIdx: 22, avg: 45, min: 40, max: 54 }];
// Real sleep sessions from the Even DB.
const GOOD_NIGHT = {
  startTs: 1000, endTs: 1000 + 481 * 60, totalSleepMin: 447, timeInBedMin: 481,
  deepMin: 74, lightMin: 288, remMin: 85, awakeMin: 31, efficiencyPct: 93, available: "full",
};

test("heartRateInsights derives current, resting (lowest-quartile), and range", () => {
  const hr = heartRateInsights({ heartRate: HR });
  assert.equal(hr.source, "hourly");
  assert.equal(hr.current, 98); // newest record's avg
  assert.equal(hr.min, 71);
  assert.equal(hr.max, 121);
  // resting = mean of lowest floor(8/4)=2 hourly avgs: (87+96)/2 = 91.5 -> 92
  assert.equal(hr.restingHr, 92);
  assert.equal(hr.trend, null); // no baseline yet
});

test("heartRateInsights prefers a live HR reading when present", () => {
  const hr = heartRateInsights({ heartRate: HR, liveHr: 72 });
  assert.equal(hr.current, 72);
  assert.equal(hr.source, "live");
});

test("heartRateInsights is empty (nulls) with no records and no live HR", () => {
  const hr = heartRateInsights({});
  assert.equal(hr.current, null);
  assert.equal(hr.restingHr, null);
});

test("sleepInsights scores a full night from real stage data", () => {
  const s = sleepInsights({ sleep: GOOD_NIGHT });
  assert.equal(s.available, "full");
  assert.deepEqual(s.stages, { awakeMin: 31, lightMin: 288, deepMin: 74, remMin: 85 });
  assert.equal(s.totalSleepMin, 447);
  assert.ok(s.score >= 75 && s.score <= 95, `good-night score ${s.score} in band`);
});

test("sleepInsights degrades to duration-only, then none", () => {
  const dur = sleepInsights({ sleep: { ...GOOD_NIGHT, available: "duration-only", deepMin: null, lightMin: null, remMin: null, awakeMin: null, efficiencyPct: null } });
  assert.equal(dur.available, "duration-only");
  assert.equal(dur.stages, null);
  assert.ok(dur.score !== null);
  const none = sleepInsights({ sleep: null });
  assert.equal(none.available, "none");
  assert.equal(none.score, null);
});

test("readinessScore degrades gracefully: HR-only -> +HRV -> +sleep", () => {
  const hrOnly = readinessScore({ heartRate: HR });
  assert.ok(hrOnly.score !== null);
  assert.equal(hrOnly.confidence, "low"); // single contributor
  assert.equal(hrOnly.contributors.find((c) => c.key === "restingHr").available, true);
  assert.equal(hrOnly.contributors.find((c) => c.key === "hrv").available, false);

  const withHrv = readinessScore({ heartRate: HR, hrv: HRV });
  assert.equal(withHrv.confidence, "medium"); // 2 contributors

  const full = readinessScore({ heartRate: HR, hrv: HRV, sleep: GOOD_NIGHT });
  assert.equal(full.confidence, "high"); // resting HR + HRV + sleep
  assert.ok(full.score >= 0 && full.score <= 100);
  assert.ok(["low", "moderate", "good", "optimal"].includes(full.band));
});

test("temperatureInsights reports nightly body-temp deviation vs baseline", () => {
  // Real Even-DB body temps: 35.5degC on a good night; baseline ~34.9.
  const base = { mean: 34.9, sd: 0.2, n: 5 };
  const t = temperatureInsights({ bodyTempC: 35.5, baselines: { bodyTempC: base } });
  assert.equal(t.currentC, 35.5);
  assert.equal(t.available, true);
  assert.ok(Math.abs(t.deviationC - 0.6) < 0.001); // +0.6degC deviation
  // no baseline -> no deviation, but still reports current
  const t2 = temperatureInsights({ bodyTempC: 35.5 });
  assert.equal(t2.deviationC, null);
  assert.equal(t2.available, true);
});

test("readinessScore includes temperature once a body-temp baseline exists", () => {
  const withTemp = readinessScore({
    heartRate: HR, hrv: HRV, sleep: GOOD_NIGHT,
    bodyTempC: 34.9, baselines: { bodyTempC: { mean: 34.9, sd: 0.2, n: 5 } },
  });
  const temp = withTemp.contributors.find((c) => c.key === "temperature");
  assert.equal(temp.available, true);
  assert.ok(temp.score >= 90); // on baseline -> near-perfect temp sub-score
});

test("readinessScore is null with no contributors", () => {
  const r = readinessScore({});
  assert.equal(r.score, null);
  assert.equal(r.coverage, 0);
});
