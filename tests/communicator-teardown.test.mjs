import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const java = fs.readFileSync(
  "App_Resources/Android/src/main/java/com/faceclaw/app/FaceclawBleCommunicator.java",
  "utf8",
);
const bridge = fs.readFileSync("app/native/faceclaw-communicator.ts", "utf8");
const dashboard = fs.readFileSync("app/g2/dashboard-controller.ts", "utf8");

test("communicator teardown is an explicit quiescence result", () => {
  assert.match(java, /public boolean disconnect\(\)/);
  assert.match(java, /threadToJoin\.isAlive\(\)/);
  assert.match(java, /return false;/);
  assert.match(java, /private boolean completeCleanupIfQuiescent\(\)/);
  assert.match(java, /if \(cleanupComplete\)/);
  assert.match(java, /completeCleanupIfQuiescent\(\);/);
  assert.match(java, /if \(closeRequested && phoneLockReceiverRegistered\)/);
  assert.match(bridge, /async close\(\): Promise<boolean>/);
  assert.match(bridge, /Boolean\(this\.communicator\.close\(\)\)/);
});

test("dashboard retains ownership when close is incomplete", () => {
  assert.match(dashboard, /const closed = await communicator\?\.close\(\)/);
  assert.match(dashboard, /BLE worker is still stopping; retaining communicator ownership/);
  assert.match(dashboard, /if \(closed !== true\)/);
  assert.match(dashboard, /if \(this\.communicator === communicator\) this\.communicator = null/);
});
