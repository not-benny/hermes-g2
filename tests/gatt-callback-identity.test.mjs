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
  assert.match(modern, /callbackRegistry\.dispatchIfCurrent\(/);
  assert.match(deprecated, /callbackRegistry\.dispatchIfCurrent\(/);
  assert.match(modern, /dispatchNotification\(gatt,/);
  assert.match(deprecated, /dispatchNotification\(gatt,/);
  assert.match(manager, /dispatchNotification\(BluetoothGatt gatt,/);
});

test("connection callbacks reject stale GATTs before state or latch publication", () => {
  const callback = methodBody("public void onConnectionStateChange(BluetoothGatt gatt, int status, int newState)");
  assert.match(callback, /callbackRegistry\.completeConnect\(/);
  assert.match(callback, /callbackRegistry\.disconnectIfCurrent\(/);
  assert.match(callback, /dispatchConnectionState\(gatt, address, true\)/);
  assert.match(callback, /dispatchConnectionState\(gatt, address, false\)/);
});

test("connect owns one exact-GATT attempt and disconnect releases its waiters", () => {
  const connect = methodBody("public boolean connect(String address, int timeoutMs)");
  assert.match(connect, /GattCallbackRegistry\.Operation<BluetoothGatt> operation/);
  assert.match(connect, /callbackRegistry\.bindConnectReturn\(/);
  assert.match(connect, /awaitOperation\(operation, timeoutMs\)/);
  const disconnect = methodBody("public void disconnect(String address)");
  assert.match(disconnect, /callbackRegistry\.retire\(/);
});

test("listener delivery carries exact GATT and is serialized against retirement", () => {
  assert.match(manager, /current\.onNotification\(gatt, address, characteristicUuid, copy\)/);
  assert.match(manager, /current\.onConnectionStateChange\(gatt, address, connected\)/);
  assert.match(manager, /current\.onNotification\(gatt, address, characteristicUuid, copy\)/);
  assert.match(manager, /current\.onConnectionStateChange\(gatt, address, connected\)/);
  assert.match(manager, /callbackRegistry\.dispatchIfCurrent\(/);
  assert.match(readFileSync(new URL("../App_Resources/Android/src/main/java/com/faceclaw/app/FaceclawBleListener.java", import.meta.url), "utf8"), /default void onNotification\(BluetoothGatt gatt/);
});

test("communicator retires state before synchronously requesting manager teardown", () => {
  const communicator = readFileSync(new URL("../App_Resources/Android/src/main/java/com/faceclaw/app/FaceclawBleCommunicator.java", import.meta.url), "utf8");
  const failure = methodBodyFrom(communicator, "private void hardTransportFailure(String reason)");
  const stateClose = failure.indexOf("clearAllMessagesLocked");
  const rightDisconnect = failure.indexOf("bleManager.disconnect(rightAddress)");
  const lockClose = failure.indexOf("}\n        // Complete communicator state retirement");
  assert.ok(stateClose >= 0);
  assert.ok(rightDisconnect > stateClose);
  assert.ok(lockClose >= 0, "manager teardown must follow the communicator monitor");
  assert.ok(!failure.includes("mainHandler.post"), "teardown must not be delayed by an unversioned runnable");
  assert.ok(lockClose < rightDisconnect);
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
    assert.doesNotMatch(source, /bleManager\.isCurrentGatt\(gatt, address\)/);
  }
});

function methodBodyFrom(source, signature) {
  const start = source.indexOf(signature);
  assert.notEqual(start, -1, `missing ${signature}`);
  const bodyStart = source.indexOf("{", start);
  let depth = 0;
  for (let i = bodyStart; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    if (source[i] === "}" && --depth === 0) return source.slice(bodyStart, i + 1);
  }
  assert.fail(`unterminated ${signature}`);
}
