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

test("preview mode seeds anonymous demo health on boot, only in preview", () => {
  const app = read("app/app.ts");
  const demo = read("app/health/../native/preview-demo.ts");
  assert.match(app, /seedPreviewDemo\(\)/); // hooked into boot
  assert.match(demo, /if \(!isPreviewOnlyMode\(\)\) return;/); // gated on preview
  // Seeds the canonical store the real app reads (so charts/tiles/HUD light up).
  assert.match(demo, /ringHealthStore\.seedMock/);
  assert.match(demo, /replaceHealthDocument\(\{ history: demoHistory\(nowMs\), hourly: demoHourly\(nowMs\), activity: null \}\)/);
  assert.doesNotMatch(demo, /ApplicationSettings\.setString/);
});

test("exiting preview after migration clears canonical, legacy, flag, and live ring state", async () => {
  const settingsUrl = dataUrl(`
    export const values = new Map([
      ["health.store.v1", "canonical-demo"],
      ["health.history.v1", "legacy-history"],
      ["health.hourly.v1", "legacy-hourly"],
      ["health.activity.v1", "legacy-activity"],
      ["preview.demoSeeded", true],
    ]);
    export const ApplicationSettings = {
      getBoolean(key, fallback = false) { return values.has(key) ? values.get(key) : fallback; },
      setBoolean(key, value) { values.set(key, value); },
      remove(key) { values.delete(key); },
    };
  `);
  const ringStoreUrl = dataUrl(`
    export const state = { resetCalls: 0 };
    export const ringHealthStore = {
      reset() { state.resetCalls += 1; },
      seedMock() {},
    };
  `);
  const healthStoreUrl = dataUrl(`
    import { ApplicationSettings } from ${JSON.stringify(settingsUrl)};
    export function clearHealthData() {
      for (const key of ["health.store.v1", "health.history.v1", "health.hourly.v1", "health.activity.v1"])
        ApplicationSettings.remove(key);
    }
    export function replaceHealthDocument() {}
  `);
  const historyUrl = dataUrl("export const dateKeyOf = () => '2026-08-20';\n");
  const hourlyUrl = dataUrl("export {};\n");
  const onboardingUrl = dataUrl("export const isPreviewOnlyMode = () => true;\n");
  let demoJs = transpile(read("app/native/preview-demo.ts"));
  demoJs = replaceImport(demoJs, "@nativescript/core", settingsUrl);
  demoJs = replaceImport(demoJs, "../health/ring-health-store", ringStoreUrl);
  demoJs = replaceImport(demoJs, "../health/health-history", historyUrl);
  demoJs = replaceImport(demoJs, "../health/health-hourly", hourlyUrl);
  demoJs = replaceImport(demoJs, "../phone-ui/onboarding-state", onboardingUrl);
  demoJs = replaceImport(demoJs, "./health-store", healthStoreUrl);

  const [{ clearPreviewDemo }, { values }, { state }] = await Promise.all([
    import(dataUrl(demoJs)),
    import(settingsUrl),
    import(ringStoreUrl),
  ]);
  clearPreviewDemo();

  for (const key of [
    "health.store.v1",
    "health.history.v1",
    "health.hourly.v1",
    "health.activity.v1",
    "preview.demoSeeded",
  ]) assert.equal(values.has(key), false, key);
  assert.equal(state.resetCalls, 1);
});

test("Settings offers an Exit-preview control that re-onboards, only in preview", () => {
  const vm = read("app/phone-ui/settings-view-model.ts");
  const xml = read("app/phone-ui/settings-page.xml");
  assert.match(vm, /onExitPreviewTap\(\): void/);
  assert.match(vm, /clearPreviewDemo\(\)/);
  assert.match(vm, /setPreviewOnlyMode\(false\)/);
  assert.match(vm, /setOnboardingCompleted\(false\)/);
  assert.match(vm, /phone-ui\/onboarding-page/);
  assert.match(vm, /get previewModeVisibility/);
  assert.match(xml, /\{\{ previewModeVisibility \}\}/);
  assert.match(xml, /Exit preview mode/);
});

test("the health store exposes a mock-seed for preview only", () => {
  const store = read("app/health/ring-health-store.ts");
  assert.match(store, /seedMock\(snapshot: RingHealthSnapshot\): void/);
});
