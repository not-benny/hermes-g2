import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const src = readFileSync(new URL("../app/health/health-history.ts", import.meta.url), "utf8");
const js = ts.transpileModule(src, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
}).outputText;
const { dateKeyOf, summarizeDay, upsertSummary, computeBaselines, historyToCsv } = await import(
  "data:text/javascript;base64," + Buffer.from(js).toString("base64")
);

const day = (dateKey, over = {}) => ({
  dateKey, restingHr: null, hrMin: null, hrMax: null, hrvAvg: null, spo2Avg: null,
  steps: null, sleepScore: null, sleepDurationMin: null, sleepDeepMin: null,
  sleepRemMin: null, readinessScore: null, updatedAtMs: 1, ...over,
});

test("summarizeDay maps insights into a daily row", () => {
  const s = summarizeDay("2026-08-18", {
    hr: { restingHr: 61, min: 71, max: 121, current: 98, source: "hourly", avg: 100, trend: null },
    sleep: { score: 85, totalSleepMin: 447, stages: { awakeMin: 31, lightMin: 288, deepMin: 74, remMin: 85 }, available: "full", timeInBedMin: 481, efficiencyPct: 93 },
    readiness: { score: 78, band: "good", contributors: [], coverage: 1, confidence: "high" },
    hrvAvg: 45, spo2Avg: 99, steps: 8500, updatedAtMs: 123,
  });
  assert.equal(s.restingHr, 61);
  assert.equal(s.sleepScore, 85);
  assert.equal(s.sleepDeepMin, 74);
  assert.equal(s.readinessScore, 78);
  assert.equal(s.steps, 8500);
});

test("upsertSummary inserts, sorts, and merges without erasing with null", () => {
  let h = [];
  h = upsertSummary(h, day("2026-08-17", { restingHr: 60 }));
  h = upsertSummary(h, day("2026-08-16", { restingHr: 58 }));
  assert.deepEqual(h.map((d) => d.dateKey), ["2026-08-16", "2026-08-17"]); // sorted
  // same-day partial poll: sleep arrives later, must NOT erase the earlier restingHr
  h = upsertSummary(h, day("2026-08-17", { sleepScore: 90 }));
  const d17 = h.find((d) => d.dateKey === "2026-08-17");
  assert.equal(d17.restingHr, 60); // preserved
  assert.equal(d17.sleepScore, 90); // added
});

test("upsertSummary caps to maxDays most-recent", () => {
  let h = [];
  for (let i = 1; i <= 40; i++) h = upsertSummary(h, day(`2026-09-${i < 10 ? "0" + i : i}`), 30);
  assert.equal(h.length, 30);
  assert.equal(h[0].dateKey, "2026-09-11"); // oldest 10 dropped
});

test("computeBaselines needs >=3 days in the trailing window, excludes today", () => {
  const now = new Date("2026-08-20T12:00:00").getTime();
  const h = [
    day("2026-08-17", { restingHr: 60, hrvAvg: 42 }),
    day("2026-08-18", { restingHr: 62, hrvAvg: 46 }),
    day("2026-08-19", { restingHr: 61, hrvAvg: 44 }),
    day("2026-08-20", { restingHr: 99, hrvAvg: 99 }), // today - excluded
  ];
  const b = computeBaselines(h, now, 14);
  assert.ok(b.restingHr && b.restingHr.n === 3);
  assert.ok(Math.abs(b.restingHr.mean - 61) < 0.5);
  assert.ok(b.hrv && b.hrv.n === 3);
  // fewer than 3 -> undefined
  const b2 = computeBaselines([day("2026-08-19", { restingHr: 61 })], now, 14);
  assert.equal(b2.restingHr, undefined);
});

test("historyToCsv emits a header and one row per day with blank nulls", () => {
  const csv = historyToCsv([day("2026-08-18", { restingHr: 61, sleepScore: 85 })]);
  const lines = csv.trim().split("\n");
  assert.match(lines[0], /^dateKey,restingHr,/);
  assert.match(lines[1], /^2026-08-18,61,/);
  assert.match(lines[1], /,85,/); // sleepScore present
  assert.ok(lines[1].includes(",,")); // some null cells blank
});

test("dateKeyOf formats local YYYY-MM-DD", () => {
  assert.match(dateKeyOf(new Date("2026-01-05T10:00:00").getTime()), /^2026-01-05$/);
});
