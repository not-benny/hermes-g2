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
const {
  HEALTH_STORE_KEY,
  LEGACY_ACTIVITY_KEY,
  LEGACY_HISTORY_KEY,
  LEGACY_HOURLY_KEY,
  HERMES_CONSENT_KEY,
  createHealthPersistence,
} = await import(dataUrl(persistenceJs));

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

class FakeSettings {
  values = new Map();
  stringWrites = [];
  failWrites = false;
  corruptReadBack = false;
  throwOnReadBack = false;
  removeCalls = [];
  failRemoveAfter = null;

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
