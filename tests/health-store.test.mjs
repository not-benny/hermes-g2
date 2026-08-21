import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const transpile = (source) => ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
}).outputText;
const dataUrl = (js) => `data:text/javascript;base64,${Buffer.from(js).toString("base64")}`;
const replaceImport = (js, specifier, url) => js.replaceAll(JSON.stringify(specifier), JSON.stringify(url));

const historyUrl = dataUrl(transpile(read("app/health/health-history.ts")));
const hourlyUrl = dataUrl(replaceImport(transpile(read("app/health/health-hourly.ts")), "./health-history", historyUrl));
const parserUrl = dataUrl(transpile(read("app/health/ring-parser.ts")));
const ringStoreUrl = dataUrl(replaceImport(transpile(read("app/health/ring-health-store.ts")), "./ring-parser", parserUrl));
let storeJs = transpile(read("app/health/health-store.ts"));
storeJs = replaceImport(storeJs, "./health-history", historyUrl);
storeJs = replaceImport(storeJs, "./health-hourly", hourlyUrl);
storeJs = replaceImport(storeJs, "./ring-health-store", ringStoreUrl);
const {
  HEALTH_RETENTION_DAYS,
  canonicalizeHealthDocument,
  localDateKey,
  queryHealthDocument,
  retentionStartDateKey,
} = await import(dataUrl(storeJs));

const NOW = new Date(2026, 7, 20, 12, 0, 0).getTime();
const daily = (dateKey, over = {}) => ({
  dateKey,
  restingHr: null,
  hrMin: null,
  hrMax: null,
  hrvAvg: null,
  spo2Avg: null,
  steps: null,
  sleepScore: null,
  sleepDurationMin: null,
  sleepDeepMin: null,
  sleepRemMin: null,
  bodyTempC: null,
  readinessScore: null,
  updatedAtMs: NOW,
  ...over,
});

function dateDaysBefore(days) {
  const now = new Date(NOW);
  return localDateKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - days));
}

test("canonical document has the exact v1 top-level shape", () => {
  const doc = canonicalizeHealthDocument({}, NOW);
  assert.deepEqual(Object.keys(doc), ["version", "updatedAtMs", "retentionDays", "history", "hourly", "activity"]);
  assert.equal(doc.version, 1);
  assert.equal(doc.updatedAtMs, NOW);
  assert.equal(doc.retentionDays, HEALTH_RETENTION_DAYS);
  assert.deepEqual(doc.history, []);
  assert.deepEqual(doc.hourly, []);
  assert.equal(doc.activity, null);
});

test("retention is today plus exactly 89 previous local calendar dates", () => {
  const doc = canonicalizeHealthDocument({
    updatedAtMs: NOW - 1,
    history: [daily(dateDaysBefore(90)), daily(dateDaysBefore(89)), daily(dateDaysBefore(0))],
  }, NOW);
  assert.deepEqual(doc.history.map((row) => row.dateKey), [dateDaysBefore(89), dateDaysBefore(0)]);
  assert.equal(doc.updatedAtMs, NOW - 1);
});

test("retention cutoff uses local calendar arithmetic across DST boundaries", () => {
  const afterSpringDst = new Date(2026, 2, 30, 0, 30, 0).getTime();
  const date = new Date(afterSpringDst);
  const expected = localDateKey(new Date(date.getFullYear(), date.getMonth(), date.getDate() - 89));
  assert.equal(retentionStartDateKey(afterSpringDst), expected);
});

test("malformed and future daily rows are dropped while duplicates merge without null erasure", () => {
  const today = dateDaysBefore(0);
  const doc = canonicalizeHealthDocument({ history: [
    { dateKey: dateDaysBefore(2), updatedAtMs: NOW, steps: 5 },
    daily(today, { restingHr: 61 }),
    daily(today, { restingHr: null, hrvAvg: 44, updatedAtMs: NOW + 1 }),
    daily(dateDaysBefore(-1)),
    daily("2026-02-30"),
    daily(dateDaysBefore(1), { steps: "not-a-number" }),
  ] }, NOW);
  assert.equal(doc.history.length, 2);
  assert.equal(doc.history[0].restingHr, null, "missing nullable migration fields become null");
  assert.equal(doc.history[1].restingHr, 61);
  assert.equal(doc.history[1].hrvAvg, 44);
  assert.equal(doc.history[1].updatedAtMs, NOW + 1);
});

test("hourly rows require valid bounds and finite metrics, merge partial duplicates, and sort", () => {
  const today = dateDaysBefore(0);
  const doc = canonicalizeHealthDocument({ hourly: [
    { dateKey: today, hourIdx: 8, hr: { avg: 60, max: 70, min: 50 } },
    { dateKey: today, hourIdx: 7, hrv: { avg: 40, max: 50, min: 30 } },
    { dateKey: today, hourIdx: 8, spo2: { avg: 97, max: 99, min: 95 } },
    { dateKey: today, hourIdx: 24, hr: { avg: 60, max: 70, min: 50 } },
    { dateKey: today, hourIdx: 9, hr: { avg: Number.NaN, max: 70, min: 50 } },
  ] }, NOW);
  assert.deepEqual(doc.hourly.map((point) => point.hourIdx), [7, 8]);
  assert.deepEqual(doc.hourly[1].hr, { avg: 60, max: 70, min: 50 });
  assert.deepEqual(doc.hourly[1].spo2, { avg: 97, max: 99, min: 95 });
});

test("anchored hourly rows survive a phone timezone/date-line change", () => {
  const timestampSec = Math.floor(Date.UTC(2026, 7, 20, 10, 0, 0) / 1000);
  const doc = canonicalizeHealthDocument({ hourly: [{
    dateKey: "2026-08-21",
    hourIdx: 0,
    timestampSec,
    timezoneOffsetMinutes: 840,
    hr: { avg: 60, max: 70, min: 50 },
  }] }, timestampSec * 1000);
  assert.equal(doc.hourly.length, 1);
  assert.equal(doc.hourly[0].dateKey, "2026-08-21");
});

test("canonical hourly rows keep distinct anchored identities for repeated local hours", () => {
  const utc = Math.floor(Date.UTC(2026, 7, 20, 10, 0, 0) / 1000);
  const utcPlusOne = Math.floor(Date.UTC(2026, 7, 20, 9, 0, 0) / 1000);
  const doc = canonicalizeHealthDocument({ hourly: [
    { dateKey: "2026-08-20", hourIdx: 10, timestampSec: utc, timezoneOffsetMinutes: 0,
      hr: { avg: 60, max: 70, min: 50 } },
    { dateKey: "2026-08-20", hourIdx: 10, timestampSec: utcPlusOne, timezoneOffsetMinutes: 60,
      spo2: { avg: 97, max: 99, min: 95 } },
  ] }, utc * 1000);
  assert.equal(doc.hourly.length, 2);
  assert.ok(doc.hourly.some((point) => point.hr && !point.spo2));
  assert.ok(doc.hourly.some((point) => point.spo2 && !point.hr));
});

test("activity is accepted only for the current local day and recomputes totals from slots", () => {
  const timezoneOffsetMinutes = -new Date(NOW).getTimezoneOffset();
  const nowSec = Math.floor(NOW / 1000);
  const dayBaseSec = Math.floor((nowSec + timezoneOffsetMinutes * 60) / 86400) * 86400 - timezoneOffsetMinutes * 60;
  const doc = canonicalizeHealthDocument({ activity: {
    dayBaseSec,
    timezoneOffsetMinutes,
    slots: [{ slot: 3, steps: 12, activeCalories: 2, totalCalories: 5 }],
    totalSteps: 999,
    activeCalories: 999,
    totalCalories: 999,
    restingCalories: 999,
  } }, NOW);
  assert.equal(doc.activity.totalSteps, 12);
  assert.equal(doc.activity.restingCalories, 3);
  assert.equal(canonicalizeHealthDocument({ activity: { ...doc.activity, dayBaseSec: dayBaseSec - 86400 } }, NOW).activity, null);
});

test("bounded query defaults to seven days and omits hourly and raw activity fields", () => {
  const timezoneOffsetMinutes = -new Date(NOW).getTimezoneOffset();
  const nowSec = Math.floor(NOW / 1000);
  const dayBaseSec = Math.floor((nowSec + timezoneOffsetMinutes * 60) / 86400) * 86400 - timezoneOffsetMinutes * 60;
  const document = canonicalizeHealthDocument({
    history: Array.from({ length: 10 }, (_, index) => daily(dateDaysBefore(index), { steps: index })),
    hourly: [{ dateKey: dateDaysBefore(0), hourIdx: 8, hr: { avg: 60, max: 70, min: 50 } }],
    activity: { dayBaseSec, timezoneOffsetMinutes, slots: [{ slot: 3, steps: 12, activeCalories: 2, totalCalories: 5 }] },
  }, NOW);
  const result = queryHealthDocument(document, {}, NOW);
  assert.equal(result.ok, true);
  assert.equal(result.value.history.length, 7);
  assert.equal(result.value.hourlyIncluded, false);
  assert.equal("hourly" in result.value, false);
  assert.deepEqual(result.value.activityTotals, {
    dateKey: dateDaysBefore(0), totalSteps: 12, activeCalories: 2, totalCalories: 5, restingCalories: 3,
  });
  assert.equal(JSON.stringify(result.value).includes("slots"), false);
  assert.equal(JSON.stringify(result.value).includes("dayBaseSec"), false);
  assert.deepEqual(Object.keys(result.value), [
    "source", "schemaVersion", "generatedAtMs", "retentionDays", "range", "hourlyIncluded", "history", "activityTotals",
  ]);
});

test("bounded query validates dates, clamps to retention, and includes hourly only on request", () => {
  const document = canonicalizeHealthDocument({
    history: [daily(dateDaysBefore(89)), daily(dateDaysBefore(0))],
    hourly: [{ dateKey: dateDaysBefore(89), hourIdx: 1, hr: { avg: 60, max: 70, min: 50 } }],
  }, NOW);
  for (const end_date of ["2026-02-30", dateDaysBefore(-1), dateDaysBefore(90)]) {
    const result = queryHealthDocument(document, { end_date }, NOW);
    assert.equal(result.ok, false, end_date);
  }
  assert.equal(queryHealthDocument(document, { days: 0 }, NOW).ok, false);
  assert.equal(queryHealthDocument(document, { days: 32 }, NOW).ok, false);
  const result = queryHealthDocument(document, { end_date: dateDaysBefore(89), days: 31, include_hourly: true }, NOW);
  assert.equal(result.ok, true);
  assert.equal(result.value.range.startDate, dateDaysBefore(89));
  assert.equal(result.value.hourlyIncluded, true);
  assert.equal(result.value.hourly.length, 1);
  assert.equal("activityTotals" in result.value, false);
});
