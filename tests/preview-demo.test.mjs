import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("preview mode seeds anonymous demo health on boot, only in preview", () => {
  const app = read("app/app.ts");
  const demo = read("app/health/../native/preview-demo.ts");
  assert.match(app, /seedPreviewDemo\(\)/); // hooked into boot
  assert.match(demo, /if \(!isPreviewOnlyMode\(\)\) return;/); // gated on preview
  // Seeds the same stores the real app reads (so charts/tiles/HUD light up).
  assert.match(demo, /ringHealthStore\.seedMock/);
  assert.match(demo, /"health\.hourly\.v1"/);
  assert.match(demo, /"health\.history\.v1"/);
});

test("exiting preview mode deletes every trace of the demo data", () => {
  const demo = read("app/native/preview-demo.ts");
  // clearPreviewDemo removes the persisted keys AND resets the live store.
  assert.match(demo, /export function clearPreviewDemo/);
  assert.match(demo, /ApplicationSettings\.remove\(HOURLY_KEY\)/);
  assert.match(demo, /ApplicationSettings\.remove\(HISTORY_KEY\)/);
  assert.match(demo, /ApplicationSettings\.remove\(ACTIVITY_KEY\)/);
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
