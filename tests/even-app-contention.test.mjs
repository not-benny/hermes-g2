import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("direct R1 failures surface the Even-app contention warning", () => {
  const native = read("App_Resources/Android/src/main/java/com/faceclaw/app/FaceclawBleCommunicator.java");
  const ringCatch = native.slice(
    native.indexOf("private void tryConnectRing"),
    native.indexOf("private void connectRing", native.indexOf("private void tryConnectRing")),
  );
  assert.match(ringCatch, /maybeEmitEvenAppConflictLocked\("ring connect failed"\)/);
  assert.match(native, /ring connect failed/);
  assert.match(native, /hold the R1 ring or glasses BLE link/);
});

test("contention recovery clears and retries after Even releases Bluetooth", () => {
  const controller = read("app/g2/dashboard-controller.ts");
  assert.match(controller, /retryRingAfterEvenAppStop/);
  assert.match(controller, /startEvenAppReleasePoll/);
  assert.match(controller, /refreshEvenAppStatus\(\)/);
  assert.match(controller, /this\.reconnectRing\(\)/);
  assert.match(controller, /clearEvenAppReleasePoll/);
});

test("main, Controls, and Health expose contention recovery", () => {
  const mainPage = read("app/phone-ui/main-page.xml");
  const mainVm = read("app/phone-ui/main-view-model.ts");
  const controlsPage = read("app/phone-ui/glasses-controls-page.xml");
  const controlsVm = read("app/phone-ui/glasses-controls-view-model.ts");
  const healthPage = read("app/phone-ui/even-health-page.xml");
  const healthVm = read("app/phone-ui/even-health-view-model.ts");

  assert.match(mainPage, /Retry R1/);
  assert.match(mainVm, /onRetryRingTap/);
  for (const page of [controlsPage, healthPage]) {
    assert.match(page, /evenAppConflictWarningVisibility/);
    assert.match(page, /Open Even app settings/);
    assert.match(page, /Retry R1/);
  }
  for (const vm of [controlsVm, healthVm]) {
    assert.match(vm, /evenAppConflictMessage/);
    assert.match(vm, /onOpenEvenAppSettingsTap/);
    assert.match(vm, /onRetryRingTap/);
  }
});
