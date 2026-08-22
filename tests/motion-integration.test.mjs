import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const bridge = read("app/native/faceclaw-communicator.ts");
const controller = read("app/g2/dashboard-controller.ts");
const java = read("App_Resources/Android/src/main/java/com/faceclaw/app/FaceclawBleCommunicator.java");
const compass = read("app/apps/compass/compass-app.ts");
const accelerometer = read("app/apps/debug-tests/accelerometer-demo.ts");
const persistence = read("app/native/glasses-motion-service.ts");

test("apps consume the one shared service rather than controlling sensors directly", () => {
  assert.match(compass, /\{ compass: true, imuRate: "low" \}/);
  assert.doesNotMatch(compass, /setCompassEnabled|addCompassListener/);
  assert.match(accelerometer, /glassesMotionService\.acquire\(\{ imuRate: "interactive" \}/);
  assert.doesNotMatch(accelerometer, /setImuReportEnabled|addImuListener/);
});

test("dashboard binds motion to connected sessions and retires it before shutdown", () => {
  assert.match(controller, /bindGlassesMotionService\(communicator!, addresses\.right\)/);
  assert.match(controller, /handleScreenStateChanged\(on: boolean\)[\s\S]*?glassesMotionService\.setScreenOn\(on\)/);
  const retire = controller.indexOf("retireGlassesMotionSession(communicator);", controller.indexOf("async disconnect"));
  const shutdown = controller.indexOf("sendShutdown(0)", controller.indexOf("async disconnect"));
  assert.ok(retire > 0 && shutdown > retire, "sensor retirement must precede EvenHub shutdown");
});

test("native bridge coalesces stale controls and captures exact communicator listeners", () => {
  assert.match(bridge, /revision !== this\.imuControlRevision/);
  assert.match(bridge, /revision !== this\.compassControlRevision/);
  assert.match(bridge, /this\.communicator\.removeImuListener\(this\.imuProxy\)/);
  assert.match(bridge, /this\.communicator\.removeCompassListener\(this\.compassProxy\)/);
  assert.match(java, /imuListeners\.toArray\(new FaceclawImuListener\[0\]\)/);
  assert.match(java, /compassListeners\.toArray\(new FaceclawCompassListener\[0\]\)/);
  assert.match(java, /imuMaybeOn/);
  assert.match(java, /enqueueImuControlLocked\(true, false/);
  assert.match(java, /deliveryGeneration != currentGlassesConnectionGeneration/);
});

test("persistence is a compact calibration summary and UI labels uncertainty", () => {
  assert.match(persistence, /motion\.calibration\.v1/);
  assert.match(persistence, /contains no raw motion sample history/);
  assert.match(compass, /Approximate magnetic heading/);
  assert.match(compass, /Heading unreliable: possible interference/);
  assert.match(accelerometer, /posture:/);
});

test("freshness polling repaints only when the truthful snapshot changes", () => {
  assert.match(compass, /lastSnapshotKey/);
  assert.match(compass, /if \(key === this\.lastSnapshotKey\) return/);
  assert.match(accelerometer, /lastSnapshotKey/);
  assert.match(accelerometer, /if \(key === this\.lastSnapshotKey\) return/);
});

test("connect failure retires motion before closing its exact communicator", () => {
  const catchStart = controller.indexOf("} catch (error) {", controller.indexOf("async connect"));
  const close = controller.indexOf("communicator.close()", catchStart);
  const retire = controller.indexOf("retireGlassesMotionSession(communicator);", catchStart);
  assert.ok(retire > catchStart && retire < close);
});

test("overlapping connects cannot publish or retire another motion owner", () => {
  assert.match(controller, /connectAttemptGeneration/);
  assert.match(controller, /isCurrentConnectAttempt\(connectAttempt\)/);
  assert.match(controller, /if \(this\.communicator !== communicator\) return/);
  const adapter = read("app/native/glasses-motion-service.ts");
  assert.match(adapter, /if \(boundCommunicator !== expected\) return false/);
});
