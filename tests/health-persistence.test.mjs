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

  hasKey(key) { return this.values.has(key); }
  getString(key, fallback = "") {
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
  remove(key) { this.values.delete(key); }
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

test("an existing canonical document is authoritative and stale legacy values are not merged", () => {
  const settings = new FakeSettings();
  settings.values.set(HEALTH_STORE_KEY, JSON.stringify({ version: 1, updatedAtMs: NOW, retentionDays: 90,
    history: [daily("2026-08-20", { steps: 10 })], hourly: [], activity: null }));
  settings.values.set(LEGACY_HISTORY_KEY, JSON.stringify([daily("2026-08-20", { steps: 999 })]));
  const document = createHealthPersistence(settings, () => NOW).loadHealthDocument();
  assert.equal(document.history[0].steps, 10);
  assert.equal(settings.values.has(LEGACY_HISTORY_KEY), false);
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

test("clear removes canonical and all legacy health traces", () => {
  const settings = new FakeSettings();
  for (const key of [HEALTH_STORE_KEY, LEGACY_HISTORY_KEY, LEGACY_HOURLY_KEY, LEGACY_ACTIVITY_KEY]) settings.values.set(key, "data");
  createHealthPersistence(settings, () => NOW).clearHealthData();
  for (const key of [HEALTH_STORE_KEY, LEGACY_HISTORY_KEY, LEGACY_HOURLY_KEY, LEGACY_ACTIVITY_KEY]) {
    assert.equal(settings.values.has(key), false);
  }
});
