import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

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

test("exiting preview mode deletes every trace of the demo data", () => {
  const demo = read("app/native/preview-demo.ts");
  // clearHealthData removes canonical + migrated legacy traces and the live
  // ring snapshot is reset as well.
  assert.match(demo, /export function clearPreviewDemo/);
  assert.match(demo, /clearHealthData\(\)/);
  assert.match(demo, /ApplicationSettings\.remove\(DEMO_FLAG\)/);
  assert.match(demo, /ringHealthStore\.reset\(\)/);
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
