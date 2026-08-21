import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const manager = readFileSync(new URL("../App_Resources/Android/src/main/java/com/faceclaw/app/FaceclawBleManager.java", import.meta.url), "utf8");

function methodBody(signature) {
  const start = manager.indexOf(signature);
  assert.notEqual(start, -1, `missing ${signature}`);
  const bodyStart = manager.indexOf("{", start);
  let depth = 0;
  for (let i = bodyStart; i < manager.length; i += 1) {
    if (manager[i] === "{") depth += 1;
    if (manager[i] === "}" && --depth === 0) return manager.slice(bodyStart, i + 1);
  }
  assert.fail(`unterminated ${signature}`);
}

test("both notification callback overloads preserve and gate source GATT identity", () => {
  const modern = methodBody("public void onCharacteristicChanged(BluetoothGatt gatt, BluetoothGattCharacteristic characteristic, byte[] value)");
  const deprecated = methodBody("public void onCharacteristicChanged(BluetoothGatt gatt, BluetoothGattCharacteristic characteristic)");
  assert.match(modern, /dispatchNotification\(gatt,/);
  assert.match(deprecated, /dispatchNotification\(gatt,/);
  const dispatch = methodBody("private void dispatchNotification(BluetoothGatt gatt,");
  assert.match(dispatch, /gattClients\.get\(address\) != gatt/);
  assert.ok(dispatch.indexOf("gattClients.get(address) != gatt") < dispatch.indexOf("current.onNotification"));
});

test("connection callbacks reject stale GATTs before state or latch publication", () => {
  const callback = methodBody("public void onConnectionStateChange(BluetoothGatt gatt, int status, int newState)");
  assert.match(callback, /gattClients\.get\(address\) != gatt/);
  const guard = callback.indexOf("gattClients.get(address) != gatt");
  assert.ok(guard < callback.indexOf("attempt.result = true"));
  assert.ok(guard < callback.indexOf("dispatchConnectionState(gatt, address, true)"));
  assert.ok(guard < callback.indexOf("attempt.result = false"));
  assert.match(callback, /closeStale = newState == BluetoothProfile\.STATE_DISCONNECTED/);
  assert.match(callback, /if \(closeStale\) \{[\s\S]*?gatt\.close\(\);/);
  assert.match(callback, /dispatchConnectionState\(gatt, address, true\)/);
  assert.match(callback, /dispatchConnectionState\(gatt, address, false\)/);
});

test("connect owns one exact-GATT attempt and disconnect releases its waiters", () => {
  const connect = methodBody("public boolean connect(String address, int timeoutMs)");
  assert.ok(connect.indexOf("if (!awaitLatch(attempt.latch, timeoutMs))") > connect.indexOf("// All callers for an address await the same exact-GATT attempt"));
  assert.match(connect, /connectionAttempts\.get\(address\)/);
  assert.match(connect, /attempt\.gatt/);
  assert.match(connect, /connectionAttempts\.get\(address\) == attempt/);
  const disconnect = methodBody("public void disconnect(String address)");
  assert.match(disconnect, /attempt\.completed = true/);
  assert.match(disconnect, /attempt\.latch\.countDown\(\)/);
  assert.match(manager, /if \(!ownsAttempt\) \{\s*return false;/s);
});

test("listener delivery carries exact GATT and occurs after the identity lock", () => {
  assert.match(manager, /current\.onNotification\(gatt, address, characteristicUuid, copy\)/);
  assert.match(manager, /current\.onConnectionStateChange\(gatt, address, connected\)/);
  const dispatch = methodBody("private void dispatchNotification(BluetoothGatt gatt,");
  assert.ok(dispatch.indexOf("}") < dispatch.indexOf("current.onNotification"));
  assert.match(readFileSync(new URL("../App_Resources/Android/src/main/java/com/faceclaw/app/FaceclawBleListener.java", import.meta.url), "utf8"), /default void onNotification\(BluetoothGatt gatt/);
});

test("every production listener consumes the exact-GATT boundary", () => {
  const sources = [
    "FaceclawBleCommunicator.java",
    "FaceclawFlashPromptCommunicator.java",
    "FaceclawDeviceInfoProbe.java",
    "FaceclawFirmwareFlasher.java",
  ].map((name) => readFileSync(new URL(`../App_Resources/Android/src/main/java/com/faceclaw/app/${name}`, import.meta.url), "utf8"));
  for (const source of sources) {
    assert.match(source, /onConnectionStateChange\(BluetoothGatt gatt, String address, boolean connected\)/);
    assert.match(source, /onNotification\(BluetoothGatt gatt, String address, String characteristicUuid, byte\[\] data\)/);
    assert.match(source, /bleManager\.isCurrentGatt\(gatt, address\)/);
  }
});
