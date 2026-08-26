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
const insightsUrl = dataUrl(transpile(read("app/health/health-insights.ts")));
const parserUrl = dataUrl(transpile(read("app/health/ring-parser.ts")));
const ringStoreUrl = dataUrl(replaceImport(transpile(read("app/health/ring-health-store.ts")), "./ring-parser", parserUrl));
let modelJs = transpile(read("app/health/health-store.ts"));
modelJs = replaceImport(modelJs, "./health-history", historyUrl);
modelJs = replaceImport(modelJs, "./health-hourly", hourlyUrl);
modelJs = replaceImport(modelJs, "./ring-health-store", ringStoreUrl);
const modelUrl = dataUrl(modelJs);
const nativeStubUrl = dataUrl("export const ApplicationSettings = {};\n");
let persistenceJs = transpile(read("app/native/health-store.ts"));
persistenceJs = replaceImport(persistenceJs, "@nativescript/core", nativeStubUrl);
persistenceJs = replaceImport(persistenceJs, "../health/health-store", modelUrl);
persistenceJs = replaceImport(persistenceJs, "../health/health-history", historyUrl);
persistenceJs = replaceImport(persistenceJs, "../health/health-hourly", hourlyUrl);
persistenceJs = replaceImport(persistenceJs, "../health/ring-health-store", ringStoreUrl);
persistenceJs = replaceImport(persistenceJs, "../health/ring-parser", parserUrl);
const {
  HEALTH_STORE_KEY,
  LEGACY_ACTIVITY_KEY,
  LEGACY_HISTORY_KEY,
  LEGACY_HOURLY_KEY,
  HERMES_CONSENT_KEY,
  HEALTH_RING_SCOPE_KEY,
  createHealthPersistence,
} = await import(dataUrl(persistenceJs));
const { RingHealthStore } = await import(ringStoreUrl);
let coordinatorJs = transpile(read("app/health/health-persistence-coordinator.ts"));
coordinatorJs = replaceImport(coordinatorJs, "./health-insights", insightsUrl);
coordinatorJs = replaceImport(coordinatorJs, "./health-history", historyUrl);
coordinatorJs = replaceImport(coordinatorJs, "./health-hourly", hourlyUrl);
coordinatorJs = replaceImport(coordinatorJs, "./ring-health-store", ringStoreUrl);
const { RingHealthPersistenceCoordinator, derivePersistedHealthProjection } = await import(dataUrl(coordinatorJs));

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

const sleepNight = (endTs = Math.floor(NOW / 1000) - 3600) => ({
  recordType: 1,
  efficiencyPct: 93,
  score: 87,
  bodyTemperatureDeciC: 344,
  timezoneOffsetMinutes: -new Date(endTs * 1000).getTimezoneOffset(),
  startTs: endTs - 480 * 60,
  endTs,
  totalSleepSec: 450 * 60,
  awakeSec: 30 * 60,
  remSec: 90 * 60,
  lightSec: 270 * 60,
  deepSec: 90 * 60,
  stages: [
    { type: 0, halfMinutes: 60 },
    { type: 2, halfMinutes: 240 },
    { type: 3, halfMinutes: 90 },
    { type: 2, halfMinutes: 300 },
    { type: 1, halfMinutes: 180 },
    { type: 3, halfMinutes: 90 },
  ],
});

const activitySnapshotAt = (nowMs, timezoneOffsetMinutes, steps = 240) => {
  const nowSec = Math.floor(nowMs / 1000);
  const dayBaseSec = Math.floor((nowSec + timezoneOffsetMinutes * 60) / 86400) * 86400
    - timezoneOffsetMinutes * 60;
  const localHour = Math.floor((nowSec - dayBaseSec) / 3600);
  const slot = Math.max(0, Math.min(143, localHour * 6));
  return {
    dayBaseSec,
    timezoneOffsetMinutes,
    slots: [{
      slot,
      timestampSec: dayBaseSec + slot * 600,
      steps,
      activeCalories: 18,
      totalCalories: 30,
      restingCalories: 12,
    }],
    totalSteps: steps,
    activeCalories: 18,
    totalCalories: 30,
    restingCalories: 12,
  };
};

class FakeSettings {
  values = new Map();
  stringWrites = [];
  failWrites = false;
  corruptReadBack = false;
  throwOnReadBack = false;
  removeCalls = [];
  failRemoveAfter = null;
  flushCalls = 0;
  flushResults = [];

  hasKey(key) { return this.values.has(key); }
  getString(key, fallback = "") {
    if (key === HEALTH_STORE_KEY && this.throwOnReadBack && this.stringWrites.length) throw new Error("synthetic read-back failure");
    const value = this.values.has(key) ? this.values.get(key) : fallback;
    if (key === HEALTH_STORE_KEY && this.corruptReadBack && this.stringWrites.length) return `${value}corrupt`;
    return typeof value === "string" ? value : fallback;
  }
  setString(key, value) {
    this.stringWrites.push([key, value]);
    if (this.failWrites) throw new Error("synthetic write failure");
    this.values.set(key, value);
  }
  getBoolean(key, fallback = false) {
    const value = this.values.get(key);
    return typeof value === "boolean" ? value : fallback;
  }
  setBoolean(key, value) { this.values.set(key, value); }
  remove(key) {
    this.removeCalls.push(key);
    if (this.failRemoveAfter !== null && this.removeCalls.length > this.failRemoveAfter) throw new Error("synthetic cleanup failure");
    this.values.delete(key);
  }
  flush() {
    this.flushCalls += 1;
    return this.flushResults.length ? this.flushResults.shift() : true;
  }
}

test("successful migration writes one canonical document, verifies it, then removes legacy keys", () => {
  const settings = new FakeSettings();
  settings.values.set(LEGACY_HISTORY_KEY, JSON.stringify([daily("2026-08-20", { steps: 123 })]));
  settings.values.set(LEGACY_HOURLY_KEY, JSON.stringify([
    { dateKey: "2026-08-20", hourIdx: 8, hr: { avg: 60, max: 70, min: 50 } },
  ]));
  settings.values.set(LEGACY_ACTIVITY_KEY, "malformed independently");
  const store = createHealthPersistence(settings, () => NOW);

  const document = store.loadHealthDocument();
  assert.equal(document.history[0].steps, 123);
  assert.equal(document.hourly.length, 1);
  assert.equal(document.activity, null);
  assert.equal(settings.stringWrites.length, 1);
  assert.equal(settings.stringWrites[0][0], HEALTH_STORE_KEY);
  assert.equal(settings.values.has(LEGACY_HISTORY_KEY), false);
  assert.equal(settings.values.has(LEGACY_HOURLY_KEY), false);
  assert.equal(settings.values.has(LEGACY_ACTIVITY_KEY), false);
});

test("failed or unverifiable canonical migration preserves every legacy key", () => {
  for (const mode of ["throw", "corrupt"]) {
    const settings = new FakeSettings();
    settings.values.set(LEGACY_HISTORY_KEY, JSON.stringify([daily("2026-08-20", { steps: 123 })]));
    settings.values.set(LEGACY_HOURLY_KEY, "[]");
    settings.values.set(LEGACY_ACTIVITY_KEY, "null");
    settings.failWrites = mode === "throw";
    settings.corruptReadBack = mode === "corrupt";
    const document = createHealthPersistence(settings, () => NOW).loadHealthDocument();
    assert.equal(document.history[0].steps, 123);
    assert.equal(settings.values.has(LEGACY_HISTORY_KEY), true, mode);
    assert.equal(settings.values.has(LEGACY_HOURLY_KEY), true, mode);
    assert.equal(settings.values.has(LEGACY_ACTIVITY_KEY), true, mode);
  }
});

test("an unverifiable first migration retries legacy data after restart", () => {
  const settings = new FakeSettings();
  const timezoneOffsetMinutes = -new Date(NOW).getTimezoneOffset();
  const dayBaseSec = Math.floor((NOW / 1000 + timezoneOffsetMinutes * 60) / 86400) * 86400
    - timezoneOffsetMinutes * 60;
  settings.values.set(LEGACY_HISTORY_KEY, JSON.stringify([daily("2026-08-20", { steps: 321 })]));
  settings.values.set(LEGACY_HOURLY_KEY, JSON.stringify([
    { dateKey: "2026-08-20", hourIdx: 9, hr: { avg: 61, max: 71, min: 51 } },
  ]));
  settings.values.set(LEGACY_ACTIVITY_KEY, JSON.stringify({
    slots: [{ slot: 72, timestampSec: dayBaseSec + 72 * 600, steps: 12, activeCalories: 3, totalCalories: 4, restingCalories: 1 }],
    dayBaseSec,
    timezoneOffsetMinutes,
    totalSteps: 12,
    activeCalories: 3,
    totalCalories: 4,
    restingCalories: 1,
  }));
  settings.corruptReadBack = true;

  const firstDocument = createHealthPersistence(settings, () => NOW).loadHealthDocument();
  assert.equal(firstDocument.history[0].steps, 321);
  assert.equal(settings.values.has(HEALTH_STORE_KEY), false, "failed candidate must not mask legacy data");

  settings.corruptReadBack = false;
  settings.stringWrites = [];
  const restartedDocument = createHealthPersistence(settings, () => NOW).loadHealthDocument();
  assert.equal(restartedDocument.history[0].steps, 321);
  assert.equal(restartedDocument.hourly.length, 1);
  assert.equal(restartedDocument.activity?.totalSteps, 12);
  assert.equal(settings.values.has(HEALTH_STORE_KEY), true);
  assert.equal(settings.values.has(LEGACY_HISTORY_KEY), false);
  assert.equal(settings.values.has(LEGACY_HOURLY_KEY), false);
  assert.equal(settings.values.has(LEGACY_ACTIVITY_KEY), false);
});

test("an existing canonical document is authoritative and stale legacy values are not merged", () => {
  const settings = new FakeSettings();
  settings.values.set(HEALTH_STORE_KEY, JSON.stringify({ version: 1, updatedAtMs: NOW, retentionDays: 90,
    history: [daily("2026-08-20", { steps: 10 })], hourly: [], activity: null }));
  settings.values.set(LEGACY_HISTORY_KEY, JSON.stringify([daily("2026-08-20", { steps: 999 })]));
  const document = createHealthPersistence(settings, () => NOW).loadHealthDocument();
  assert.equal(document.history[0].steps, 10);
  assert.equal(settings.values.has(LEGACY_HISTORY_KEY), false);
});

test("verified canonical data survives partial legacy cleanup and retries remaining keys", () => {
  const settings = new FakeSettings();
  settings.values.set(LEGACY_HISTORY_KEY, JSON.stringify([daily("2026-08-20", { steps: 5 })]));
  settings.values.set(LEGACY_HOURLY_KEY, "[]");
  settings.values.set(LEGACY_ACTIVITY_KEY, "null");
  settings.failRemoveAfter = 1;
  const store = createHealthPersistence(settings, () => NOW);
  assert.equal(store.loadHealthDocument().history[0].steps, 5);
  assert.equal(settings.values.has(HEALTH_STORE_KEY), true);
  assert.equal(settings.values.has(LEGACY_HISTORY_KEY), false);
  assert.equal(settings.values.has(LEGACY_HOURLY_KEY), true);
  settings.failRemoveAfter = null;
  store.loadHealthDocument();
  assert.equal(settings.values.has(LEGACY_HOURLY_KEY), false);
  assert.equal(settings.values.has(LEGACY_ACTIVITY_KEY), false);
});

test("malformed canonical values are preserved as an error outcome", () => {
  const settings = new FakeSettings();
  const raw = "not-json";
  settings.values.set(HEALTH_STORE_KEY, raw);
  settings.values.set(LEGACY_HISTORY_KEY, JSON.stringify([daily("2026-08-20", { steps: 77 })]));
  const result = createHealthPersistence(settings, () => NOW).loadHealthDocumentResult();
  assert.equal(result.ok, false);
  assert.equal(settings.values.get(HEALTH_STORE_KEY), raw);
  assert.equal(settings.values.has(LEGACY_HISTORY_KEY), true);
});

test("structurally invalid canonical values are preserved byte-for-byte", () => {
  const invalidValues = [
    { history: [daily("2026-02-31")] },
    { hourly: [{ dateKey: "2026-08-20", hourIdx: 8 }] },
    { hourly: [{ dateKey: "2026-08-20", hourIdx: 8, timestampSec: 1,
      timezoneOffsetMinutes: 0, hr: { avg: 60, max: 70, min: 50 } }] },
    { activity: { slots: [], dayBaseSec: 0, timezoneOffsetMinutes: 0,
      totalSteps: "bad", activeCalories: 0, totalCalories: 0, restingCalories: 0 } },
    { battery: { ringId: "AA:BB:CC:DD:EE:FF", percent: 50, updatedAtMs: NOW + 300_001 } },
    { sleep: { ...sleepNight(), score: 101 } },
  ];
  for (const fields of invalidValues) {
    const settings = new FakeSettings();
    const raw = JSON.stringify({ version: 1, retentionDays: 90, updatedAtMs: NOW,
      history: [], hourly: [], activity: null, ...fields });
    settings.values.set(HEALTH_STORE_KEY, raw);
    settings.values.set(LEGACY_HISTORY_KEY, JSON.stringify([daily("2026-08-20", { steps: 77 })]));
    const result = createHealthPersistence(settings, () => NOW).loadHealthDocumentResult();
    assert.equal(result.ok, false);
    assert.equal(settings.values.get(HEALTH_STORE_KEY), raw);
    assert.equal(settings.values.has(LEGACY_HISTORY_KEY), true);
  }
});

test("a first migration removes an unverifiable candidate and retries legacy data", () => {
  const settings = new FakeSettings();
  settings.values.set(LEGACY_HISTORY_KEY, JSON.stringify([daily("2026-08-20", { steps: 88 })]));
  settings.throwOnReadBack = true;
  const first = createHealthPersistence(settings, () => NOW).loadHealthDocumentResult();
  assert.equal(first.ok, false);
  assert.equal(settings.values.has(HEALTH_STORE_KEY), false);
  assert.equal(settings.values.has(LEGACY_HISTORY_KEY), true);
  settings.throwOnReadBack = false;
  const retry = createHealthPersistence(settings, () => NOW).loadHealthDocumentResult();
  assert.equal(retry.ok, true);
  assert.equal(retry.document?.history[0].steps, 88);
});

test("unsupported future canonical values are preserved through every ordinary mutation", () => {
  for (const mutate of [
    (store) => store.recordHealthDay({ steps: 1, updatedAtMs: NOW }),
    (store) => store.recordHourly([{ hourIdx: 8, avg: 60, max: 70, min: 50 }], [], [], NOW),
    (store) => store.recordActivity({ slots: [], dayBaseSec: 0, timezoneOffsetMinutes: 0,
      totalSteps: 0, activeCalories: 0, totalCalories: 0, restingCalories: 0 }),
  ]) {
    const settings = new FakeSettings();
    const raw = JSON.stringify({ version: 2, history: [], hourly: [], activity: null });
    settings.values.set(HEALTH_STORE_KEY, raw);
    mutate(createHealthPersistence(settings, () => NOW));
    assert.equal(settings.values.get(HEALTH_STORE_KEY), raw);
  }
});

test("failed replacement exposes failure and does not claim persistence", () => {
  const settings = new FakeSettings();
  settings.failWrites = true;
  const result = createHealthPersistence(settings, () => NOW).replaceHealthDocument({ history: [], hourly: [], activity: null });
  assert.equal(result.ok, false);
  assert.equal(result.document, undefined);
});
test("consent defaults off, is preserved separately, and clear does not revoke it", () => {
  const settings = new FakeSettings();
  const store = createHealthPersistence(settings, () => NOW);
  assert.equal(store.getHermesConsent(), false);
  store.setHermesConsent(true);
  assert.equal(settings.values.get(HERMES_CONSENT_KEY), true);
  store.clearHealthData();
  assert.equal(store.getHermesConsent(), true);
});

test("consent and health deletion require a verified synchronous flush", () => {
  const settings = new FakeSettings();
  const store = createHealthPersistence(settings, () => NOW);
  settings.flushResults = [false];
  assert.throws(() => store.setHermesConsent(true), /flush failed/);
  settings.flushResults = [true];
  store.setHermesConsent(true);
  assert.equal(store.getHermesConsent(), true);

  store.loadHealthDocument();
  settings.flushResults = [false];
  assert.throws(() => store.clearHealthData(), /flush failed/);
  settings.flushResults = [true];
  store.clearHealthData();
  assert.equal(settings.values.has(HEALTH_STORE_KEY), false);
});

test("record operations update only the single canonical data key", () => {
  const settings = new FakeSettings();
  const store = createHealthPersistence(settings, () => NOW);
  store.loadHealthDocument();
  settings.stringWrites = [];
  store.recordHealthDay({ steps: 45, updatedAtMs: NOW });
  store.recordHourly([{ hourIdx: 8, avg: 60, max: 70, min: 50 }], [], [], NOW);
  assert.deepEqual(settings.stringWrites.map(([key]) => key), [HEALTH_STORE_KEY, HEALTH_STORE_KEY]);
  assert.equal(settings.values.has(LEGACY_HISTORY_KEY), false);
  assert.equal(settings.values.has(LEGACY_HOURLY_KEY), false);
  const document = store.loadHealthDocument();
  assert.equal(document.history[0].steps, 45);
  assert.equal(document.hourly.length, 1);
});

test("an overnight restart prunes yesterday's activity without hiding durable vitals", () => {
  const settings = new FakeSettings();
  let clock = NOW;
  const timezoneOffsetMinutes = -new Date(clock).getTimezoneOffset();
  const dayBaseSec = Math.floor((clock / 1000 + timezoneOffsetMinutes * 60) / 86400) * 86400
    - timezoneOffsetMinutes * 60;
  const firstRun = createHealthPersistence(settings, () => clock);
  firstRun.loadHealthDocument();
  firstRun.recordHealthDay({
    hrvAvg: 42,
    readiness: { score: 71, band: "good", contributors: [], coverage: 0.45, confidence: "medium" },
    updatedAtMs: clock,
  });
  firstRun.recordHourly(
    [{ hourIdx: 8, avg: 61, max: 70, min: 54 }],
    [],
    [{ hourIdx: 8, avg: 42, max: 50, min: 35 }],
    clock,
  );
  firstRun.recordActivity({
    dayBaseSec,
    timezoneOffsetMinutes,
    slots: [{
      slot: 72,
      timestampSec: dayBaseSec + 72 * 600,
      steps: 12,
      activeCalories: 3,
      totalCalories: 4,
      restingCalories: 1,
    }],
    totalSteps: 12,
    activeCalories: 3,
    totalCalories: 4,
    restingCalories: 1,
  });

  clock = new Date(2026, 7, 21, 12, 0, 0).getTime();
  const restarted = createHealthPersistence(settings, () => clock);
  const loaded = restarted.loadHealthDocumentResult();
  assert.equal(loaded.ok, true);
  assert.equal(loaded.document?.activity, null, "day-scoped activity should expire normally");
  assert.equal(loaded.document?.history[0].readinessScore, 71);
  assert.equal(loaded.document?.hourly.length, 1);
  assert.equal(JSON.parse(settings.values.get(HEALTH_STORE_KEY)).activity, null,
    "the verified canonical value should self-heal on disk");

  restarted.recordHealthDay({
    hrvAvg: 45,
    readiness: { score: 74, band: "good", contributors: [], coverage: 0.45, confidence: "medium" },
    updatedAtMs: clock,
  });
  const afterWrite = restarted.loadHealthDocumentResult();
  assert.equal(afterWrite.ok, true, "the pruned store must remain writable after restart");
  assert.deepEqual(afterWrite.document?.history.map((day) => day.readinessScore), [71, 74]);
});

test("activity validation accepts exact local-midnight anchors at both UTC offset boundaries", () => {
  for (const timezoneOffsetMinutes of [-14 * 60, 14 * 60]) {
    const localMidnightUtcMs = Date.UTC(2026, 7, 20) - timezoneOffsetMinutes * 60 * 1000;
    const dayBaseSec = Math.floor(localMidnightUtcMs / 1000);
    const activity = {
      dayBaseSec,
      timezoneOffsetMinutes,
      slots: [{
        slot: 0,
        timestampSec: dayBaseSec,
        steps: 7,
        activeCalories: 2,
        totalCalories: 3,
        restingCalories: 1,
      }],
      totalSteps: 7,
      activeCalories: 2,
      totalCalories: 3,
      restingCalories: 1,
    };
    const settings = new FakeSettings();
    settings.values.set(HEALTH_STORE_KEY, JSON.stringify({
      version: 1,
      retentionDays: 90,
      updatedAtMs: dayBaseSec * 1000,
      history: [],
      hourly: [],
      activity,
    }));
    const store = createHealthPersistence(settings, () => dayBaseSec * 1000);
    const loaded = store.loadHealthDocumentResult();
    assert.equal(loaded.ok, true, `UTC offset ${timezoneOffsetMinutes}`);
    assert.equal(loaded.document?.activity?.dayBaseSec, dayBaseSec);
  }
});

test("process-wide coordinator persists hourly readiness and restores health without constructing the Health UI", () => {
  const settings = new FakeSettings();
  const timezoneOffsetMinutes = -new Date(NOW).getTimezoneOffset();
  const dayBaseSec = Math.floor((NOW / 1000 + timezoneOffsetMinutes * 60) / 86400) * 86400
    - timezoneOffsetMinutes * 60;
  const activity = {
    dayBaseSec,
    timezoneOffsetMinutes,
    slots: [{
      slot: 48,
      timestampSec: dayBaseSec + 48 * 600,
      steps: 240,
      activeCalories: 18,
      totalCalories: 30,
      restingCalories: 12,
    }],
    totalSteps: 240,
    activeCalories: 18,
    totalCalories: 30,
    restingCalories: 12,
  };
  const sleep = sleepNight();
  const firstRun = createHealthPersistence(settings, () => NOW);
  firstRun.loadHealthDocument();
  const coordinator = new RingHealthPersistenceCoordinator(firstRun, () => NOW);
  const sample = (hourIdx, avg, max, min) => ({
    hourIdx, avg, max, min, timestampSec: null, timezoneOffsetMinutes: null,
  });
  const snapshot = {
    heartRate: sample(8, 61, 72, 53),
    spo2: sample(8, 97, 99, 95),
    temperature: null,
    hrv: sample(8, 46, 58, 35),
    activity,
    sleep,
    batteryPercent: null,
    batteryUpdatedAtMs: null,
    firmwareVersion: null,
    updatedAtMs: NOW,
    heartRateSeries: [sample(8, 61, 72, 53)],
    spo2Series: [sample(8, 97, 99, 95)],
    hrvSeries: [sample(8, 46, 58, 35)],
    currentHr: 63,
    bodyTempC: 34.4,
  };

  const projection = coordinator.persist(snapshot);
  assert.ok(projection?.readiness.score !== null);
  const saved = firstRun.loadHealthDocumentResult().document;
  assert.equal(saved?.hourly.length, 1);
  assert.equal(saved?.history.length, 1);
  assert.equal(saved?.history[0].readinessScore, projection.readiness.score);
  assert.equal(saved?.history[0].sleepScore, 87);

  // Simulate a fresh process: only the canonical settings value survives. No
  // EvenHealthViewModel is imported or instantiated anywhere in this test.
  const restartMs = NOW + 60 * 60 * 1000;
  const restarted = createHealthPersistence(settings, () => restartMs);
  const restartedStore = new RingHealthStore(() => restartMs);
  const restartedCoordinator = new RingHealthPersistenceCoordinator(restarted, () => restartMs);
  restartedCoordinator.restoreInto(restartedStore);
  assert.equal(restartedStore.snapshot().activity?.totalSteps, 240);
  assert.equal(restartedStore.snapshot().sleep?.score, 87);
  const restoredProjection = restartedCoordinator.persist(restartedStore.snapshot());
  assert.equal(restoredProjection?.hourlyToday.length, 1);
  assert.equal(restoredProjection?.readiness.score, projection.readiness.score);
  assert.equal(restarted.loadHealthDocumentResult().document?.history[0].readinessScore,
    projection.readiness.score);
});

test("a fresh prior night remains in UI readiness but is durable only on its ring-local wake date", () => {
  const clock = new Date(2026, 7, 21, 10, 0, 0).getTime();
  const sleepEndMs = new Date(2026, 7, 20, 8, 0, 0).getTime();
  const phoneOffset = -new Date(clock).getTimezoneOffset();
  const sleep = {
    ...sleepNight(Math.floor(sleepEndMs / 1000)),
    timezoneOffsetMinutes: -new Date(sleepEndMs).getTimezoneOffset(),
  };
  const activity = activitySnapshotAt(clock, phoneOffset, 1337);
  const sample = (hourIdx, avg, max, min) => ({
    hourIdx, avg, max, min, timestampSec: null, timezoneOffsetMinutes: null,
  });
  const heartRateSeries = [sample(8, 62, 70, 54)];
  const spo2Series = [sample(8, 97, 99, 95)];
  const hrvSeries = [sample(8, 46, 55, 37)];
  const snapshot = {
    heartRate: heartRateSeries[0],
    spo2: spo2Series[0],
    temperature: null,
    hrv: hrvSeries[0],
    activity,
    sleep,
    batteryPercent: null,
    batteryUpdatedAtMs: null,
    firmwareVersion: null,
    updatedAtMs: clock,
    heartRateSeries,
    spo2Series,
    hrvSeries,
    currentHr: 64,
    bodyTempC: 34.4,
  };
  const settings = new FakeSettings();
  const persistence = createHealthPersistence(settings, () => clock);
  persistence.loadHealthDocument();
  const coordinator = new RingHealthPersistenceCoordinator(persistence, () => clock);

  const uiProjection = coordinator.persist(snapshot);
  assert.equal(uiProjection?.sleep.score, 87, "the prior night remains useful to the current UI");
  assert.equal(uiProjection?.readiness.contributors.find((item) => item.key === "sleep").available, true);

  const firstDocument = persistence.loadHealthDocument();
  assert.deepEqual(firstDocument.history.map((row) => row.dateKey), ["2026-08-20", "2026-08-21"]);
  const wakeDay = firstDocument.history.find((row) => row.dateKey === "2026-08-20");
  const currentDay = firstDocument.history.find((row) => row.dateKey === "2026-08-21");
  assert.equal(wakeDay?.sleepScore, 87);
  assert.equal(wakeDay?.sleepDurationMin, 450);
  assert.equal(wakeDay?.bodyTempC, 34.4);
  assert.equal(wakeDay?.readinessScore, 87, "sleep-derived readiness stays with the wake date");
  assert.equal(currentDay?.steps, 1337);
  assert.equal(currentDay?.sleepScore, null);
  assert.equal(currentDay?.sleepDurationMin, null);
  assert.equal(currentDay?.bodyTempC, null);

  const withoutPriorSleep = derivePersistedHealthProjection(
    { ...snapshot, sleep: null, bodyTempC: null },
    firstDocument.hourly,
    [],
    clock,
  );
  assert.equal(currentDay?.readinessScore, withoutPriorSleep.readiness.score,
    "the current durable score is recomputed without the prior night's contributors");
  assert.notEqual(currentDay?.readinessScore, uiProjection?.readiness.score,
    "UI readiness may still combine the fresh prior night with current vitals");

  const stableHistory = JSON.stringify(firstDocument.history);
  coordinator.persist({ ...snapshot, batteryPercent: 82, batteryUpdatedAtMs: clock });
  const afterUnrelatedEmission = persistence.loadHealthDocument();
  assert.equal(JSON.stringify(afterUnrelatedEmission.history), stableHistory,
    "a retained night cannot later become a permanent field on the current row");
  assert.equal(afterUnrelatedEmission.history.find((row) => row.dateKey === "2026-08-21")?.sleepScore, null);
});

test("ring-local tomorrow is retained only when timezone authority places current evidence there", () => {
  const clock = Date.UTC(2026, 7, 20, 10, 30, 0);
  const ringOffset = 14 * 60;
  const activity = activitySnapshotAt(clock, ringOffset, 321);
  const sleep = {
    ...sleepNight(Math.floor(clock / 1000)),
    timezoneOffsetMinutes: ringOffset,
  };
  const hour = {
    hourIdx: 0,
    avg: 61,
    max: 68,
    min: 55,
    timestampSec: activity.dayBaseSec,
    timezoneOffsetMinutes: ringOffset,
  };
  const snapshot = {
    heartRate: hour,
    spo2: null,
    temperature: null,
    hrv: null,
    activity,
    sleep,
    batteryPercent: null,
    batteryUpdatedAtMs: null,
    firmwareVersion: null,
    updatedAtMs: clock,
    heartRateSeries: [hour],
    spo2Series: [],
    hrvSeries: [],
    currentHr: 61,
    bodyTempC: 34.4,
  };
  const settings = new FakeSettings();
  const persistence = createHealthPersistence(settings, () => clock);
  persistence.loadHealthDocument();
  new RingHealthPersistenceCoordinator(persistence, () => clock).persist(snapshot);

  let document = persistence.loadHealthDocument();
  assert.deepEqual(document.history.map((row) => row.dateKey), ["2026-08-21"],
    "UTC+14 current data may be one calendar date ahead of the phone");
  assert.equal(document.history[0].steps, 321);
  assert.equal(document.history[0].sleepScore, 87);
  assert.equal(document.hourly[0].dateKey, "2026-08-21");

  persistence.replaceHealthDocument({
    ...document,
    history: [...document.history, daily("2026-08-22", { steps: 999 })],
  });
  document = persistence.loadHealthDocument();
  assert.deepEqual(document.history.map((row) => row.dateKey), ["2026-08-21"],
    "the bounded timezone exception must not admit two-day-future rows");
});

test("a live process cannot carry yesterday's activity into a post-midnight summary", () => {
  const settings = new FakeSettings();
  let clock = NOW;
  const timezoneOffsetMinutes = -new Date(clock).getTimezoneOffset();
  const dayBaseSec = Math.floor((clock / 1000 + timezoneOffsetMinutes * 60) / 86400) * 86400
    - timezoneOffsetMinutes * 60;
  const activity = {
    dayBaseSec,
    timezoneOffsetMinutes,
    slots: [{
      slot: 48,
      timestampSec: dayBaseSec + 48 * 600,
      steps: 975,
      activeCalories: 25,
      totalCalories: 40,
      restingCalories: 15,
    }],
    totalSteps: 975,
    activeCalories: 25,
    totalCalories: 40,
    restingCalories: 15,
  };
  const sample = (hourIdx, avg) => ({
    hourIdx, avg, max: avg + 7, min: avg - 7,
    timestampSec: null, timezoneOffsetMinutes: null,
  });
  const persistence = createHealthPersistence(settings, () => clock);
  persistence.loadHealthDocument();
  const coordinator = new RingHealthPersistenceCoordinator(persistence, () => clock);
  const heartRateSeries = [sample(12, 63)];
  const spo2Series = [sample(12, 97)];
  const hrvSeries = [sample(12, 44)];
  const snapshot = {
    heartRate: heartRateSeries[0],
    spo2: spo2Series[0],
    temperature: null,
    hrv: hrvSeries[0],
    activity,
    sleep: null,
    batteryPercent: null,
    batteryUpdatedAtMs: null,
    firmwareVersion: null,
    updatedAtMs: clock,
    heartRateSeries,
    spo2Series,
    hrvSeries,
    currentHr: 63,
    bodyTempC: null,
  };
  coordinator.persist(snapshot);
  assert.equal(persistence.loadHealthDocument().history.at(-1)?.steps, 975);

  // The same process and producer still hold yesterday's object, but a fresh
  // unrelated battery/device-info emission arrives after local midnight. Its
  // unchanged array identity must not replay the unanchored HR sample as a new
  // day, and its retained live HR is not fresh evidence either.
  clock += 24 * 60 * 60 * 1000;
  coordinator.persist({
    ...snapshot,
    batteryPercent: 81,
    batteryUpdatedAtMs: clock,
    updatedAtMs: clock,
  });
  let document = persistence.loadHealthDocument();
  assert.equal(document.activity, null, "stale in-memory activity is cleared durably");
  assert.equal(document.hourly.length, 1, "unchanged unanchored hours are not replayed after midnight");
  assert.equal(document.history.length, 1, "retained currentHr cannot invent a new-day summary");

  // A genuinely new heart-rate push has a new series identity and still
  // persists normally, without attributing yesterday's steps to its day.
  coordinator.persist({
    ...snapshot,
    heartRate: sample(12, 66),
    heartRateSeries: [sample(12, 66)],
    currentHr: 66,
    updatedAtMs: clock,
  });
  document = persistence.loadHealthDocument();
  const today = document.history.find((row) => row.updatedAtMs === clock);
  assert.equal(document.hourly.length, 2, "the genuinely changed series is persisted");
  const newestHour = document.hourly.at(-1);
  assert.ok(newestHour.hr, "the changed HR series reaches the new day");
  assert.equal(newestHour.spo2, undefined, "unchanged SpO2 series is not replayed");
  assert.equal(newestHour.hrv, undefined, "unchanged HRV series is not replayed");
  assert.ok(today, "the new vital still creates today's health row");
  assert.equal(today.steps, null, "yesterday's steps never leak into today's row");
});

test("a silently failed hourly write leaves the same series eligible for retry", () => {
  const settings = new FakeSettings();
  const persistence = createHealthPersistence(settings, () => NOW);
  persistence.loadHealthDocument();
  const errors = [];
  const coordinator = new RingHealthPersistenceCoordinator(
    persistence,
    () => NOW,
    (message) => errors.push(message),
  );
  const hour = {
    hourIdx: 12, avg: 64, max: 71, min: 57,
    timestampSec: null, timezoneOffsetMinutes: null,
  };
  const snapshot = {
    heartRate: hour,
    spo2: null,
    temperature: null,
    hrv: null,
    activity: null,
    sleep: null,
    batteryPercent: null,
    batteryUpdatedAtMs: null,
    firmwareVersion: null,
    updatedAtMs: NOW,
    heartRateSeries: [hour],
    spo2Series: [],
    hrvSeries: [],
    currentHr: 64,
    bodyTempC: null,
  };

  settings.failWrites = true;
  coordinator.persist(snapshot);
  assert.equal(persistence.loadHourly().length, 0);
  assert.ok(errors.some((message) => message.includes("could not be verified")));

  settings.failWrites = false;
  coordinator.persist({ ...snapshot, batteryPercent: 80, batteryUpdatedAtMs: NOW });
  assert.equal(persistence.loadHourly().length, 1,
    "the unchanged array identity retries because the failed write was never marked durable");
});

test("a retained stale night cannot drive current sleep or temperature readiness", () => {
  const stale = sleepNight(Math.floor(NOW / 1000) - 37 * 60 * 60);
  const projection = derivePersistedHealthProjection({
    heartRate: null,
    spo2: null,
    temperature: null,
    hrv: null,
    activity: null,
    sleep: stale,
    batteryPercent: null,
    batteryUpdatedAtMs: null,
    firmwareVersion: null,
    updatedAtMs: null,
    heartRateSeries: [],
    spo2Series: [],
    hrvSeries: [],
    currentHr: null,
    bodyTempC: 34.4,
  }, [], [], NOW);
  assert.equal(projection.sleep.score, null);
  assert.equal(projection.temperature.currentC, null);
  assert.equal(projection.readiness.contributors.find((item) => item.key === "sleep").available, false);
  assert.equal(projection.readiness.contributors.find((item) => item.key === "temperature").available, false);
});

test("a verified ring battery survives an overnight app restart", () => {
  const settings = new FakeSettings();
  const ringId = "AA:BB:CC:DD:EE:FF";
  const firstRun = createHealthPersistence(settings, () => NOW);
  firstRun.loadHealthDocument();
  firstRun.recordBattery(ringId, 97, NOW);

  const nextMorning = NOW + 12 * 60 * 60 * 1000;
  const restarted = createHealthPersistence(settings, () => nextMorning);
  assert.deepEqual(restarted.loadBattery(ringId), { ringId, percent: 97, updatedAtMs: NOW });
  assert.equal(restarted.loadBattery("11:22:33:44:55:66"), null, "a replacement ring cannot inherit the old battery");
  assert.equal(restarted.loadBattery(""), null, "removing the ring cannot expose its old battery");
});

test("ring A to B and removal scrub current sources across relaunch while preserving completed daily history", () => {
  const settings = new FakeSettings();
  const ringA = "AA:BB:CC:DD:EE:FF";
  const ringB = "11:22:33:44:55:66";
  const timezoneOffsetMinutes = -new Date(NOW).getTimezoneOffset();
  const dayBaseSec = Math.floor((NOW / 1000 + timezoneOffsetMinutes * 60) / 86400) * 86400
    - timezoneOffsetMinutes * 60;
  const activity = {
    slots: [{ slot: 72, timestampSec: dayBaseSec + 72 * 600, steps: 12,
      activeCalories: 3, totalCalories: 4, restingCalories: 1 }],
    dayBaseSec,
    timezoneOffsetMinutes,
    totalSteps: 12,
    activeCalories: 3,
    totalCalories: 4,
    restingCalories: 1,
  };
  const firstRun = createHealthPersistence(settings, () => NOW);
  assert.equal(firstRun.transitionRingIdentity(ringA, ringA).ok, true, "first boot adopts the configured ring");
  firstRun.replaceHealthDocument({
    history: [
      daily("2026-08-19", { steps: 8000, readinessScore: 79, updatedAtMs: NOW - 48 * 60 * 60 * 1000 }),
      daily("2026-08-20", { steps: 12, readinessScore: 64 }),
    ],
    hourly: [
      { dateKey: "2026-08-19", hourIdx: 20, hr: { avg: 60, max: 66, min: 55 } },
      { dateKey: "2026-08-20", hourIdx: 12, hr: { avg: 67, max: 72, min: 61 } },
    ],
    activity,
    sleep: sleepNight(),
    battery: { ringId: ringA, percent: 91, updatedAtMs: NOW },
  });

  const switched = firstRun.transitionRingIdentity(ringA, ringB);
  assert.equal(switched.ok, true);
  assert.deepEqual(switched.document.history.map((row) => row.dateKey), ["2026-08-19"]);
  assert.equal(switched.document.history[0].readinessScore, 79);
  assert.deepEqual(switched.document.hourly, [], "unscoped source hours cannot cross hardware");
  assert.equal(switched.document.activity, null);
  assert.equal(switched.document.sleep, null);
  assert.equal(switched.document.battery, null);
  assert.deepEqual(JSON.parse(settings.values.get(HEALTH_RING_SCOPE_KEY)), { version: 1, ringId: ringB });

  const restarted = createHealthPersistence(settings, () => NOW + 60_000);
  assert.equal(restarted.transitionRingIdentity(ringB, ringB).ok, true);
  const liveAfterRelaunch = new RingHealthStore(() => NOW + 60_000);
  new RingHealthPersistenceCoordinator(restarted, () => NOW + 60_000).restoreInto(liveAfterRelaunch);
  assert.equal(liveAfterRelaunch.snapshot().activity, null);
  assert.equal(liveAfterRelaunch.snapshot().sleep, null);
  assert.deepEqual(restarted.loadHealthDocument().history.map((row) => row.dateKey), ["2026-08-19"]);

  restarted.replaceHealthDocument({
    ...restarted.loadHealthDocument(),
    history: [...restarted.loadHealthHistory(), daily("2026-08-20", { readinessScore: 70 })],
    hourly: [{ dateKey: "2026-08-20", hourIdx: 12, hrv: { avg: 40, max: 50, min: 30 } }],
    activity,
    sleep: sleepNight(),
  });
  const removed = restarted.transitionRingIdentity(ringB, "");
  assert.equal(removed.ok, true);
  assert.deepEqual(removed.document.history.map((row) => row.dateKey), ["2026-08-19"]);
  assert.deepEqual(removed.document.hourly, []);
  assert.equal(removed.document.activity, null);
  assert.equal(removed.document.sleep, null);
  assert.deepEqual(JSON.parse(settings.values.get(HEALTH_RING_SCOPE_KEY)), { version: 1, ringId: "" });
});

test("identity scrub rejects a recently updated phone-yesterday row from a lagging ring timezone", () => {
  const settings = new FakeSettings();
  const ringA = "AA:BB:CC:DD:EE:FF";
  const ringB = "11:22:33:44:55:66";
  const store = createHealthPersistence(settings, () => NOW);
  assert.equal(store.transitionRingIdentity(ringA, ringA).ok, true);
  store.replaceHealthDocument({
    history: [
      daily("2026-08-18", { readinessScore: 81, updatedAtMs: NOW - 48 * 60 * 60 * 1000 }),
      // A fixed ring offset/travel can still label A's active source day as
      // phone-yesterday. Freshness, not the phone date alone, must remove it.
      daily("2026-08-19", { readinessScore: 63, updatedAtMs: NOW - 5 * 60 * 1000 }),
    ],
    hourly: [], activity: null, sleep: null,
  });
  const switched = store.transitionRingIdentity(ringA, ringB);
  assert.equal(switched.ok, true);
  assert.deepEqual(switched.document.history.map((row) => row.dateKey), ["2026-08-18"]);
});

test("first boot with no configured ring scrubs legacy current data before adopting the empty scope", () => {
  const settings = new FakeSettings();
  const legacy = createHealthPersistence(settings, () => NOW);
  legacy.loadHealthDocument();
  legacy.replaceHealthDocument({
    history: [daily("2026-08-20", { readinessScore: 60 })],
    hourly: [{ dateKey: "2026-08-20", hourIdx: 12, hr: { avg: 66, max: 70, min: 60 } }],
    activity: null,
    sleep: sleepNight(),
  });
  assert.equal(settings.values.has(HEALTH_RING_SCOPE_KEY), false);
  const upgraded = createHealthPersistence(settings, () => NOW);
  const bound = upgraded.transitionRingIdentity("", "");
  assert.equal(bound.ok, true);
  assert.deepEqual(bound.document.history, []);
  assert.deepEqual(bound.document.hourly, []);
  assert.equal(bound.document.sleep, null);
  assert.deepEqual(JSON.parse(settings.values.get(HEALTH_RING_SCOPE_KEY)), { version: 1, ringId: "" });
});

test("a failed SharedPreferences flush is not durable and a later unchanged load retries it", () => {
  const settings = new FakeSettings();
  const store = createHealthPersistence(settings, () => NOW);
  store.loadHealthDocument();
  const timezoneOffsetMinutes = -new Date(NOW).getTimezoneOffset();
  const dayBaseSec = Math.floor((NOW / 1000 + timezoneOffsetMinutes * 60) / 86400) * 86400
    - timezoneOffsetMinutes * 60;
  const candidate = {
    history: [daily("2026-08-20", { readinessScore: 71 })],
    hourly: [{ dateKey: "2026-08-20", hourIdx: 12, hrv: { avg: 42, max: 51, min: 31 } }],
    activity: {
      slots: [{ slot: 72, timestampSec: dayBaseSec + 72 * 600, steps: 15,
        activeCalories: 3, totalCalories: 5, restingCalories: 2 }],
      dayBaseSec, timezoneOffsetMinutes, totalSteps: 15,
      activeCalories: 3, totalCalories: 5, restingCalories: 2,
    },
    sleep: sleepNight(),
  };
  settings.flushResults = [false, true];
  const failed = store.replaceHealthDocument(candidate);
  assert.equal(failed.ok, false, "in-memory readback after apply must not count as durable");
  const retried = store.loadHealthDocumentResult();
  assert.equal(retried.ok, true, "the pending candidate is synchronously flushed on retry");
  assert.equal(retried.document.history[0].readinessScore, 71);
  assert.equal(retried.document.hourly[0].hrv.avg, 42);
  assert.equal(retried.document.activity.totalSteps, 15);
  assert.equal(retried.document.sleep.score, 87);
});

test("a canonical sleep night and authoritative ring score survive app restart", () => {
  const settings = new FakeSettings();
  const firstRun = createHealthPersistence(settings, () => NOW);
  firstRun.loadHealthDocument();
  const night = sleepNight();
  firstRun.recordSleep(night);

  const restarted = createHealthPersistence(settings, () => NOW + 12 * 60 * 60 * 1000);
  const restored = restarted.loadSleep();
  assert.deepEqual(restored, night);
  assert.equal(restored.score, 87, "the wire score must not be replaced by a derived score");
  assert.equal(restarted.loadHealthDocument().sleep.score, 87);
});

test("an older stored sleep reply cannot overwrite a newer persisted night", () => {
  const settings = new FakeSettings();
  const store = createHealthPersistence(settings, () => NOW);
  store.loadHealthDocument();
  const newer = sleepNight();
  const older = sleepNight(newer.endTs - 24 * 60 * 60);
  older.score = 72;
  store.recordSleep(newer);
  store.recordSleep(older);
  assert.deepEqual(store.loadSleep(), newer);
});

test("unchanged battery polls persist at most hourly", () => {
  const settings = new FakeSettings();
  const ringId = "AA:BB:CC:DD:EE:FF";
  let clock = NOW;
  const store = createHealthPersistence(settings, () => clock);
  store.loadHealthDocument();
  settings.stringWrites = [];
  store.recordBattery(ringId, 60, NOW);
  clock = NOW + 60_000;
  store.recordBattery(ringId, 60, NOW + 60_000);
  assert.equal(settings.stringWrites.length, 1);
  clock = NOW + 3_600_000;
  store.recordBattery(ringId, 60, NOW + 3_600_000);
  assert.equal(settings.stringWrites.length, 2);
});

test("optional anchored hourly timestamps survive canonical persistence while legacy rows remain valid", () => {
  const settings = new FakeSettings();
  const store = createHealthPersistence(settings, () => NOW);
  store.loadHealthDocument();
  const timestampSec = Math.floor(new Date(2026, 7, 20, 8, 0, 0).getTime() / 1000);
  const timezoneOffsetMinutes = -new Date(timestampSec * 1000).getTimezoneOffset();
  store.recordHourly([{ hourIdx: 8, avg: 60, max: 70, min: 50, timestampSec, timezoneOffsetMinutes }], [], [], NOW);
  assert.equal(store.loadHealthDocumentResult().document?.hourly[0].timestampSec, timestampSec);

  const legacySettings = new FakeSettings();
  legacySettings.values.set(HEALTH_STORE_KEY, JSON.stringify({
    version: 1, updatedAtMs: NOW, retentionDays: 90, history: [], activity: null,
    hourly: [{ dateKey: "2026-08-20", hourIdx: 8, hr: { avg: 60, max: 70, min: 50 } }],
  }));
  assert.equal(createHealthPersistence(legacySettings, () => NOW).loadHealthDocumentResult().ok, true);
});

test("clear removes canonical and all legacy health traces", () => {
  const settings = new FakeSettings();
  for (const key of [HEALTH_STORE_KEY, LEGACY_HISTORY_KEY, LEGACY_HOURLY_KEY, LEGACY_ACTIVITY_KEY]) settings.values.set(key, "data");
  createHealthPersistence(settings, () => NOW).clearHealthData();
  for (const key of [HEALTH_STORE_KEY, LEGACY_HISTORY_KEY, LEGACY_HOURLY_KEY, LEGACY_ACTIVITY_KEY]) {
    assert.equal(settings.values.has(key), false);
  }
});
