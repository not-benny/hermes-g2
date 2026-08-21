import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const javaPath = "App_Resources/Android/src/main/java/com/faceclaw/app/FaceclawBleCommunicator.java";
const listenerPath = "App_Resources/Android/src/main/java/com/faceclaw/app/FaceclawBleCommunicatorListener.java";
const bridgePath = "app/native/faceclaw-communicator.ts";

const read = (path) => fs.readFileSync(path, "utf8");

test("wake APIs register asynchronous barriers without monitor waits", () => {
  const java = read(javaPath);
  const wakeApi = java.slice(java.indexOf("public long setFaceclawWakeLeaseEnabled"), java.indexOf("private boolean sendShutdownInternal"));
  assert.match(wakeApi, /public long setFaceclawWakeLeaseEnabled/);
  assert.match(wakeApi, /public long awaitEvenHubSessionReady/);
  assert.match(wakeApi, /public long resumeEvenHubSession/);
  assert.doesNotMatch(wakeApi, /lock\.wait|waitForFaceclawWakeControlDelivery/);
  assert.match(java, /progressWakeBarrierLocked\(now\)/);
  assert.match(java, /faceclawWakeControlGeneration != wakeBarrierGeneration/);
  assert.match(java, /onWakeBarrierComplete\(requestToken, success\)/);
});

test("wake completion crosses the listener and bridge with bounded stale-safe waiters", () => {
  const listener = read(listenerPath);
  const bridge = read(bridgePath);
  assert.match(listener, /onWakeBarrierComplete\(long requestToken, boolean success\)/);
  assert.match(bridge, /onWakeBarrierComplete:/);
  assert.match(bridge, /wakeBarrierCompletions/);
  assert.match(bridge, /wakeBarrierWaiters/);
  assert.match(bridge, /setTimeout\(\(\) => finish\(false\)/);
});
