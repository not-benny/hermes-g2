import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("debug diagnostics live under Settings Developer instead of the launcher registry", () => {
  const apps = read("app/apps/all-apps.ts");
  const settings = read("app/ui/dashboard/settings-menus.ts");
  const diagnostics = read("app/apps/debug-tests/debug-tests-app.ts");

  assert.doesNotMatch(apps, /debugTestsApp|\.\/debug-tests/);
  assert.match(settings, /label: "Developer"[\s\S]*label: "Debug tests"/);
  assert.match(settings, /createDebugTestsMenu\("settings"\)/);
  for (const label of ["Dither test", "Buzzer demo", "Accelerometer demo", "Show resource usage"]) {
    assert.match(diagnostics, new RegExp(`label: "${label}"`));
  }
  assert.match(diagnostics, /AccelerometerDemoLayer\(windowId/);
  assert.match(diagnostics, /ResourceUsageLayer\(windowId/);
});

test("debug-control retains its exact app allowlist through a Settings alias", () => {
  const controller = read("app/g2/dashboard-controller.ts");
  const settings = read("app/apps/settings/index.ts");
  const definition = read("app/apps/app-definition.ts");
  const protocol = read("debug-control/control-protocol.ts");

  assert.match(protocol, /"debug-tests", "settings"/);
  assert.match(controller, /appId === "debug-tests"[\s\S]*launchApp\("settings", \{ section: "Developer", subsection: "debug-tests" \}\)/);
  assert.match(controller, /if \(!ALL_APPS\.some\(\(app\) => app\.appId === appId\)\)/);
  assert.match(definition, /subsection\?: string/);
  assert.match(settings, /params\?\.subsection === "debug-tests"/);
  assert.match(settings, /openDebugTests/);
});
