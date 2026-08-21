import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const manager = readFileSync(new URL("../App_Resources/Android/src/main/java/com/faceclaw/app/FaceclawBleManager.java", import.meta.url), "utf8");
const listener = readFileSync(new URL("../App_Resources/Android/src/main/java/com/faceclaw/app/FaceclawBleListener.java", import.meta.url), "utf8");
const registry = readFileSync(new URL("../App_Resources/Android/src/main/java/com/faceclaw/app/GattCallbackRegistry.java", import.meta.url), "utf8");

function body(signature) {
  const start = manager.indexOf(signature);
  assert.notEqual(start, -1, `missing ${signature}`);
  const open = manager.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < manager.length; i += 1) {
    if (manager[i] === "{") depth += 1;
    if (manager[i] === "}" && --depth === 0) return manager.slice(open, i + 1);
  }
  assert.fail(`unterminated ${signature}`);
}

test("GATT callbacks copy data and enqueue external listener work", () => {
  for (const signature of [
    "public void onCharacteristicChanged(BluetoothGatt gatt, BluetoothGattCharacteristic characteristic, byte[] value)",
    "public void onCharacteristicChanged(BluetoothGatt gatt, BluetoothGattCharacteristic characteristic)",
    "public void onConnectionStateChange(BluetoothGatt gatt, int status, int newState)",
  ]) {
    assert.doesNotMatch(body(signature), /current\.on(?:Notification|ConnectionStateChange)/);
  }
  assert.match(manager, /Executors\.newSingleThreadExecutor/);
  assert.match(manager, /callbackExecutor\.execute/);
  assert.match(manager, /byte\[\] copy = value != null \? value\.clone\(\)/);
  assert.match(manager, /enqueueCallback\(\(\) ->\s*dispatchNotification/);
  assert.match(manager, /enqueueCallback\(\(\) -> dispatchConnectionState/);
  assert.match(manager, /current\.onNotification\(gatt, address, characteristicUuid, copy, lease\)/);
  assert.match(manager, /current\.onConnectionStateChange\(gatt, address, connected, lease\)/);
});

test("queued callbacks revalidate the exact generation under the dispatch gate", () => {
  assert.match(listener, /GattCallbackRegistry\.DispatchLease<BluetoothGatt>/);
  assert.match(registry, /boolean dispatchIfCurrent\(Consumer<DispatchLease<G>> dispatch\)/);
  assert.match(registry, /ReentrantLock gate = registry\.dispatchGates\.computeIfAbsent/);
  assert.match(registry, /if \(!current && !terminal\) return false/);
  assert.doesNotMatch(manager, /enqueueCallback\(\(\) -> lease\.dispatchIfCurrent/);
});

test("stale states retire only the exact obsolete GATT", () => {
  const connection = body("public void onConnectionStateChange(BluetoothGatt gatt, int status, int newState)");
  assert.match(connection, /callbackRegistry\.retireStale\(gatt\)/);
  assert.match(connection, /closeGatt\(gatt\)/);
  assert.match(connection, /closeDisconnectedGatt\(gatt\)/);
  assert.match(registry, /currentGatts\.containsValue\(gatt\)/);
  assert.match(registry, /isRetired\(gatt\)/);
});

test("close invalidates queued effects and terminates the ordered executor", () => {
  const close = body("public void close()");
  assert.match(close, /closed = true/);
  assert.match(close, /callbackExecutor\.shutdownNow\(\)/);
  assert.match(manager, /if \(!closed\) callback\.run\(\)/);
});
