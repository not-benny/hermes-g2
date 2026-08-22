import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const bridge = readFileSync(new URL("../app/native/faceclaw-communicator.ts", import.meta.url), "utf8");
const controller = readFileSync(new URL("../app/g2/dashboard-controller.ts", import.meta.url), "utf8");
const viewModel = readFileSync(new URL("../app/phone-ui/glasses-controls-view-model.ts", import.meta.url), "utf8");
const page = readFileSync(new URL("../app/phone-ui/glasses-controls-page.xml", import.meta.url), "utf8");

test("phone UI exposes independent redacted G2 and R1 connection health", () => {
  assert.match(bridge, /export type ConnectionHealthSnapshot/);
  assert.match(bridge, /getConnectionHealthSnapshot\(\)/);
  assert.match(controller, /connectionHealth: ConnectionHealthSnapshot/);
  assert.match(viewModel, /get g2HealthStatus\(\)/);
  assert.match(viewModel, /get r1HealthStatus\(\)/);
  assert.match(viewModel, /get connectionDiagnostics\(\)/);
  assert.match(page, /g2HealthStatus/);
  assert.match(page, /r1HealthStatus/);
  assert.match(page, /connectionDiagnostics/);
});

test("connection health wire parser fails closed and never accepts extra identifier fields", () => {
  assert.match(bridge, /parts\.length !== 11/);
  assert.match(bridge, /failure: safeFailure/);
  const healthUi = viewModel.slice(viewModel.indexOf("get g2HealthStatus"), viewModel.indexOf("get evenAppConflictMessage"));
  assert.doesNotMatch(healthUi, /address|uuid|payload|serial/i);
});
