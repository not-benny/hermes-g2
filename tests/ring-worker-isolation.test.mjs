import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const communicator = read("App_Resources/Android/src/main/java/com/faceclaw/app/FaceclawBleCommunicator.java");
const manager = read("App_Resources/Android/src/main/java/com/faceclaw/app/FaceclawBleManager.java");

function methodBody(source, signature) {
  const start = source.indexOf(signature);
  assert.notEqual(start, -1, `missing ${signature}`);
  const open = source.indexOf("{", start);
  assert.notEqual(open, -1, `missing body for ${signature}`);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  assert.fail(`unterminated body for ${signature}`);
}

function synchronizedBodies(source, lockName) {
  const bodies = [];
  const marker = `synchronized (${lockName})`;
  let cursor = 0;
  while ((cursor = source.indexOf(marker, cursor)) !== -1) {
    const open = source.indexOf("{", cursor + marker.length);
    let depth = 0;
    for (let i = open; i < source.length; i += 1) {
      if (source[i] === "{") depth += 1;
      if (source[i] === "}" && --depth === 0) {
        bodies.push(source.slice(open + 1, i));
        cursor = i + 1;
        break;
      }
    }
  }
  return bodies;
}

test("a dedicated FaceclawRingLink loop owns every blocking ring action", () => {
  assert.match(communicator, /new Thread\([^\n]*runRingLoop[^\n]*"FaceclawRingLink"\)/);
  const displayRun = methodBody(communicator, "@Override public void run()");
  for (const call of [
    "shouldAttemptRingConnect()",
    "tryConnectRing(",
    "drainRingPacketAcks()",
    "maybeReRingHealthPoll()",
    "maybeReRingCurrentHrPoll()",
  ]) {
    assert.doesNotMatch(displayRun, new RegExp(call.replace(/[()]/g, "\\$&")));
  }
  const ringRun = methodBody(communicator, "private void runRingLoop()");
  for (const call of [
    "shouldAttemptRingConnect()",
    "tryConnectRing(",
    "drainRingPacketAcks()",
    "maybeReRingHealthPoll()",
    "maybeReRingCurrentHrPoll()",
  ]) {
    assert.match(ringRun, new RegExp(call.replace(/[()]/g, "\\$&")));
  }
  assert.doesNotMatch(methodBody(communicator, "private void connectLoopOnce()"), /tryConnectRing\(/);
});

test("ring lifecycle state and wakeups are isolated from the display sleeper", () => {
  assert.match(communicator, /private final Object ringLock = new Object\(\)/);
  assert.match(communicator, /private final InterruptibleSleep ringInterruptibleSleep = new InterruptibleSleep\(\)/);
  assert.match(methodBody(communicator, "public boolean requestRingReconnect()"), /ringInterruptibleSleep\.interrupt\(\)/);
  assert.doesNotMatch(methodBody(communicator, "public boolean requestRingReconnect()"), /interruptibleSleep\.interrupt\(\)/);
  assert.match(methodBody(communicator, "private void queueRingPacketAck(byte[] frame)"), /synchronized \(ringLock\)/);
  assert.match(methodBody(communicator, "private void queueRingPacketAck(byte[] frame)"), /ringInterruptibleSleep\.interrupt\(\)/);
  assert.match(methodBody(communicator, "private void sendRingPacketAck(RingPacketAckCursor cursor)"), /synchronized \(ringLock\)/);
});

test("disconnect quiesces both workers before closing BLE", () => {
  const body = methodBody(communicator, "public void disconnect()");
  const ringInterrupt = body.indexOf("ringThreadToJoin.interrupt()");
  const ringJoin = body.indexOf("ringThreadToJoin.join(");
  const managerClose = body.indexOf("bleManager.close()");
  assert.ok(ringInterrupt >= 0 && ringJoin > ringInterrupt && managerClose > ringJoin);
  assert.ok(
    body.indexOf("threadToJoin.interrupt()") < body.indexOf("threadToJoin.join("),
    "display worker is interrupted before either bounded join",
  );
  assert.ok(
    ringInterrupt < body.indexOf("threadToJoin.join("),
    "ring worker is interrupted before waiting for the display worker",
  );
  assert.match(body, /ringInterruptibleSleep\.interrupt\(\)/);
});

test("BLE waits serialize per address while the process-wide API lock is initiation-only", () => {
  assert.match(manager, /ConcurrentHashMap<String, Object> operationLocks/);
  assert.match(manager, /private static final Object BLUETOOTH_API_LOCK = new Object\(\)/);
  assert.match(methodBody(manager, "private Object gattLock(String address)"), /operationLocks\.computeIfAbsent/);
  const apiBodies = synchronizedBodies(manager, "BLUETOOTH_API_LOCK");
  assert.ok(apiBodies.length >= 8, "all immediate BluetoothGatt API starts must use the process-wide lock");
  for (const body of apiBodies) {
    assert.doesNotMatch(body, /awaitLatch\(|Thread\.sleep\(|listener\./);
  }
  for (const callback of [
    "onConnectionStateChange(",
    "onServicesDiscovered(",
    "onMtuChanged(",
    "onDescriptorWrite(",
    "onCharacteristicWrite(",
    "onCharacteristicRead(",
    "onCharacteristicChanged(",
  ]) {
    assert.match(methodBody(manager, callback), /isCurrentGatt\(address, gatt\)/);
  }
  for (const signature of [
    "public boolean connect(",
    "public boolean requestMtu(",
    "public boolean discoverServices(",
    "public byte[] readCharacteristic(",
    "public boolean enableNotifications(",
    "public boolean writeFrames(",
    "public void disconnect(",
  ]) {
    assert.match(methodBody(manager, signature), /synchronized \(gattLock\(address\)\)|synchronized \(operationLock\)/);
  }
});
