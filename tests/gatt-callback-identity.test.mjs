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
  assert.ok(guard < callback.indexOf("connectResults.put(address, true)"));
  assert.ok(guard < callback.indexOf("dispatchConnectionState(address, true)"));
  assert.ok(guard < callback.indexOf("connectResults.put(address, false)"));
  assert.match(callback, /if \(newState == BluetoothProfile\.STATE_DISCONNECTED\) \{\s*gatt\.close\(\);/s);
});

test("connect waits outside the callback identity lock", () => {
  const connect = methodBody("public boolean connect(String address, int timeoutMs)");
  assert.ok(connect.indexOf("if (!awaitLatch(latch, timeoutMs))") > connect.indexOf("// Do not hold the identity/API lock"));
  assert.match(connect, /gattClients\.get\(address\) == gatt/);
});
