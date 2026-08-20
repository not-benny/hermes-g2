import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("the onboarding wizard is a 5-step guided flow with progress", () => {
  const vm = read("app/phone-ui/onboarding-view-model.ts");
  const xml = read("app/phone-ui/onboarding-page.xml");

  assert.match(vm, /TOTAL_STEPS = 5/);
  assert.match(vm, /get stepLabel\(\): string/);
  assert.match(vm, /Step \$\{this\._step\} of \$\{TOTAL_STEPS\}/);
  // progress dots rendered in the page
  assert.match(xml, /\{\{ dot1Class \}\}/);
  assert.match(xml, /\{\{ dot5Class \}\}/);
  assert.match(xml, /\{\{ stepLabel \}\}/);
});

test("onboarding is honest that Hermes rides on top of the Even app (T4)", () => {
  const vm = read("app/phone-ui/onboarding-view-model.ts");
  // A dedicated hand-off step, not buried firmware prose.
  assert.match(vm, /How Hermes works/);
  assert.match(vm, /alongside the official Even Realities app/);
  assert.match(vm, /disconnect the glasses/i);
  assert.match(vm, /Set up your G2 glasses and R1 ring in the official Even app first/);
  assert.match(vm, /installed but leave it closed or disabled/);
});

test("onboarding requests the runtime permissions it needs, with live status", () => {
  const vm = read("app/phone-ui/onboarding-view-model.ts");
  const xml = read("app/phone-ui/onboarding-page.xml");

  // Reuses the existing permission helpers (not reinvented).
  assert.match(vm, /ensureBlePermissions|hasBlePermissions/);
  assert.match(vm, /isNotificationListenerEnabled|requestNotificationListenerAccess/);
  assert.match(vm, /isIgnoringBatteryOptimizations|requestIgnoreBatteryOptimizations/);
  // Grant handlers + a permissions step in the page.
  assert.match(vm, /onGrantBle|onGrantNotif|onGrantBattery/);
  assert.match(vm, /refreshPermissions\(\)/);
  assert.match(xml, /\{\{ permsVisibility \}\}/);
  assert.match(xml, /onGrantBle|onGrantNotif|onGrantBattery/);
});

test("onboarding still reuses the existing flash + preview-only exits", () => {
  const vm = read("app/phone-ui/onboarding-view-model.ts");
  assert.match(vm, /phone-ui\/config-page/); // flash path
  assert.match(vm, /setPreviewOnlyMode\(true\)/); // preview-only path
  assert.match(vm, /setOnboardingCompleted\(true\)/);
});
