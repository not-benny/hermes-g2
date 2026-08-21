import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const java = fs.readFileSync("App_Resources/Android/src/main/java/com/faceclaw/app/FaceclawBleCommunicator.java", "utf8");
const bridge = fs.readFileSync("app/native/faceclaw-communicator.ts", "utf8");
const dashboard = fs.readFileSync("app/g2/dashboard-controller.ts", "utf8");

class TeardownModel {
  constructor() { this.displayAlive = true; this.ringAlive = true; this.cleanup = 0; this.disconnected = 0; this.failCleanup = false; }
  close() {
    if (this.displayAlive || this.ringAlive) return false;
    if (this.cleanup) return true;
    if (this.failCleanup) return false;
    this.cleanup += 1; this.disconnected += 1; return true;
  }
}

test("incomplete dual-worker teardown remains unsuccessful and owns resources", () => {
  const model = new TeardownModel();
  assert.equal(model.close(), false);
  assert.equal(model.cleanup, 0);
  assert.equal(model.disconnected, 0);
  model.displayAlive = false;
  assert.equal(model.close(), false);
  assert.equal(model.cleanup, 0);
  model.ringAlive = false;
  assert.equal(model.close(), true);
  assert.equal(model.close(), true);
  assert.equal(model.cleanup, 1);
  assert.equal(model.disconnected, 1);
});

test("cleanup failure remains retryable and fail-closed", () => {
  const model = new TeardownModel(); model.displayAlive = false; model.ringAlive = false; model.failCleanup = true;
  assert.equal(model.close(), false);
  assert.equal(model.disconnected, 0);
  model.failCleanup = false;
  assert.equal(model.close(), true);
  assert.equal(model.cleanup, 1);
});

test("production teardown and dashboard contracts retain ownership until positive completion", () => {
  assert.match(java, /public boolean disconnect\(\)/);
  assert.match(java, /private boolean completeCleanup\(\)/);
  assert.match(java, /scheduleDeferredCleanup\(\)/);
  assert.match(java, /cleanupThread/);
  assert.match(java, /ringWorkerThread/);
  assert.match(java, /if \(closeRequested && phoneLockReceiverRegistered\)/);
  assert.match(java, /setStateDisplay\("disconnected", "Disconnected\."\)/);
  assert.match(bridge, /async close\(\): Promise<boolean>/);
  assert.match(bridge, /Boolean\(this\.communicator\.close\(\)\)/);
  assert.match(dashboard, /if \(this\.phase !== "disconnected" \|\| this\.communicator !== null\)/);
  assert.match(dashboard, /BLE worker is still stopping; retaining communicator ownership/);
  assert.match(dashboard, /completePendingCommunicatorClose/);
});
