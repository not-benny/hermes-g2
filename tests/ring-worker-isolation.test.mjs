import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const communicator = read("App_Resources/Android/src/main/java/com/faceclaw/app/FaceclawBleCommunicator.java");
const manager = read("App_Resources/Android/src/main/java/com/faceclaw/app/FaceclawBleManager.java");

function methodBody(source, signature) {
  const start = source.indexOf(signature); assert.notEqual(start, -1, `missing ${signature}`);
  const open = source.indexOf("{", start); let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    if (source[i] === "}" && --depth === 0) return source.slice(open + 1, i);
  }
  assert.fail(`unterminated body for ${signature}`);
}

test("dedicated ring worker and lifecycle coordinator own teardown", () => {
  assert.match(communicator, /new Thread\(this::runRingLoop, "FaceclawRingLink"\)/);
  assert.match(communicator, /private void runRingLoop\(\)/);
  assert.match(communicator, /public boolean disconnect\(\)/);
  assert.match(communicator, /private boolean completeCleanup\(\)/);
  assert.match(communicator, /private void scheduleDeferredCleanup\(\)/);
  assert.match(communicator, /workerThread\.isAlive\(\)/);
  assert.match(communicator, /ringWorkerThread\.isAlive\(\)/);
  assert.match(communicator, /managerCleanupComplete/);
  assert.match(communicator, /receiverCleanupComplete/);
});

test("ring lifecycle rejects work after stopping and keeps callbacks outside locks", () => {
  assert.match(communicator, /private volatile boolean stopping/);
  assert.match(methodBody(communicator, "public boolean requestRingReconnect()"), /stopping/);
  assert.match(methodBody(communicator, "private void runRingLoop()"), /!stopping/);
  assert.match(communicator, /Object callbackLock = ringCallback \? ringLock : lock/);
  assert.match(communicator, /finishDirectRingConnectionStateChange/);
});

test("BLE manager uses a process API lock without waiting under it", () => {
  assert.match(manager, /private static final Object BLUETOOTH_API_LOCK = new Object\(\)/);
  const callback = methodBody(manager, "public void onConnectionStateChange(BluetoothGatt gatt, int status, int newState)");
  assert.doesNotMatch(callback, /BLUETOOTH_API_LOCK/);
  assert.match(manager, /awaitOperation\(operation, timeoutMs\)/);
});
