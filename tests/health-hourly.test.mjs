import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

// health-hourly imports ./health-history (which imports only `type` from
// health-insights, elided). Transpile both and point the import at a data: URL.
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const dataUrl = (js) => "data:text/javascript;base64," + Buffer.from(js).toString("base64");
const transpile = (src) =>
  ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
  }).outputText;

const historyUrl = dataUrl(transpile(read("app/health/health-history.ts")));
const hourlyJs = transpile(read("app/health/health-hourly.ts")).replace(
  '"./health-history"',
  JSON.stringify(historyUrl),
);
const { dateForHour, buildHourlyPoints, upsertHourly, hourlyForDay } = await import(dataUrl(hourlyJs));

// A fixed "now": 2026-08-20 13:30 local.
const NOW = new Date(2026, 7, 20, 13, 30, 0).getTime();
const YDAY = new Date(2026, 7, 19, 13, 30, 0).getTime();
const keyOf = (ms) => {
  const d = new Date(ms);
  const p = (n) => (n < 10 ? `0${n}` : `${n}`);
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

test("dateForHour: hours up to now are today, later hours are yesterday", () => {
  assert.equal(dateForHour(6, NOW), keyOf(NOW)); // 6am today
  assert.equal(dateForHour(13, NOW), keyOf(NOW)); // current hour = today
  assert.equal(dateForHour(20, NOW), keyOf(YDAY)); // 8pm hasn't happened today -> yesterday
  assert.equal(dateForHour(23, NOW), keyOf(YDAY));
});

test("buildHourlyPoints groups metrics by (date,hour) and attaches each", () => {
  const points = buildHourlyPoints(
    [{ hourIdx: 6, avg: 60, max: 70, min: 55 }, { hourIdx: 20, avg: 80, max: 90, min: 72 }],
    [{ hourIdx: 6, avg: 97, max: 98, min: 96 }],
    [{ hourIdx: 6, avg: 45, max: 54, min: 40 }],
    NOW,
  );
  const today = keyOf(NOW), yday = keyOf(YDAY);
  const h6 = points.find((p) => p.dateKey === today && p.hourIdx === 6);
  assert.deepEqual(h6.hr, { avg: 60, max: 70, min: 55 });
  assert.deepEqual(h6.spo2, { avg: 97, max: 98, min: 96 });
  assert.deepEqual(h6.hrv, { avg: 45, max: 54, min: 40 });
  // hour 20 is yesterday and only has HR.
  const h20 = points.find((p) => p.dateKey === yday && p.hourIdx === 20);
  assert.deepEqual(h20.hr, { avg: 80, max: 90, min: 72 });
  assert.equal(h20.spo2, undefined);
});

test("buildHourlyPoints uses anchored timestamps and preserves them across metric merges", () => {
  const historical = Math.floor(Date.UTC(2026, 6, 3, 23, 0, 0) / 1000);
  const points = buildHourlyPoints(
    [{ hourIdx: 6, avg: 60, max: 70, min: 55, timestampSec: historical, timezoneOffsetMinutes: 420 }],
    [{ hourIdx: 6, avg: 97, max: 98, min: 96, timestampSec: historical, timezoneOffsetMinutes: 420 }],
    [],
    NOW,
  );
  assert.equal(points.length, 1);
  assert.equal(points[0].dateKey, "2026-07-04");
  assert.equal(points[0].timestampSec, historical);
  assert.equal(points[0].timezoneOffsetMinutes, 420);
  assert.deepEqual(points[0].spo2, { avg: 97, max: 98, min: 96 });
});

test("upsertHourly accumulates and never erases a metric with an absent one", () => {
  const today = keyOf(NOW);
  const store = upsertHourly([], buildHourlyPoints([{ hourIdx: 6, avg: 60, max: 70, min: 55 }], [], [], NOW), NOW);
  // A later poll for the SAME hour brings SpO2 but no HR: HR must survive.
  const next = upsertHourly(store, buildHourlyPoints([], [{ hourIdx: 6, avg: 97, max: 98, min: 96 }], [], NOW), NOW);
  const h6 = hourlyForDay(next, today)[0];
  assert.deepEqual(h6.hr, { avg: 60, max: 70, min: 55 }, "HR preserved across the SpO2-only poll");
  assert.deepEqual(h6.spo2, { avg: 97, max: 98, min: 96 });
});

test("upsertHourly overwrites a metric when a newer poll provides it", () => {
  const today = keyOf(NOW);
  let store = upsertHourly([], buildHourlyPoints([{ hourIdx: 6, avg: 60, max: 70, min: 55 }], [], [], NOW), NOW);
  store = upsertHourly(store, buildHourlyPoints([{ hourIdx: 6, avg: 64, max: 72, min: 58 }], [], [], NOW), NOW);
  assert.deepEqual(hourlyForDay(store, today)[0].hr, { avg: 64, max: 72, min: 58 });
  assert.equal(hourlyForDay(store, today).length, 1, "same hour is not duplicated");
});

test("upsertHourly upgrades legacy points and never erases an anchored timestamp", () => {
  const today = keyOf(NOW);
  const timestampSec = Math.floor(new Date(2026, 7, 20, 6, 0, 0).getTime() / 1000);
  const legacy = [{ dateKey: today, hourIdx: 6, hr: { avg: 60, max: 70, min: 55 } }];
  const timezoneOffsetMinutes = -new Date(timestampSec * 1000).getTimezoneOffset();
  const anchored = [{ dateKey: today, hourIdx: 6, timestampSec, timezoneOffsetMinutes, spo2: { avg: 97, max: 98, min: 96 } }];
  const upgraded = upsertHourly(legacy, anchored, NOW);
  assert.equal(upgraded[0].timestampSec, timestampSec);
  const unanchored = upsertHourly(upgraded, [
    { dateKey: today, hourIdx: 6, hrv: { avg: 40, max: 50, min: 30 } },
  ], NOW);
  assert.equal(unanchored[0].timestampSec, timestampSec);
});

test("upsertHourly drops points older than the retention window and sorts", () => {
  const oldPoint = { dateKey: "2026-01-01", hourIdx: 3, hr: { avg: 50, max: 55, min: 45 } };
  const store = upsertHourly([oldPoint], buildHourlyPoints([{ hourIdx: 6, avg: 60, max: 70, min: 55 }], [], [], NOW), NOW, 90);
  assert.ok(!store.some((p) => p.dateKey === "2026-01-01"), "stale day dropped");
  // sorted chronologically
  const keys = store.map((p) => `${p.dateKey}#${p.hourIdx}`);
  assert.deepEqual(keys, [...keys].sort());
});

test("hourlyForDay returns only that day's hours, hour-sorted", () => {
  const today = keyOf(NOW);
  const store = upsertHourly(
    [],
    buildHourlyPoints(
      [{ hourIdx: 10, avg: 70, max: 80, min: 60 }, { hourIdx: 6, avg: 60, max: 70, min: 55 }],
      [],
      [],
      NOW,
    ),
    NOW,
  );
  const day = hourlyForDay(store, today);
  assert.deepEqual(day.map((p) => p.hourIdx), [6, 10]);
});
