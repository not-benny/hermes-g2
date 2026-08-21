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
  assert.match(
    ringRun,
    /tryConnectRing\("retry"\);[\s\S]*ringInterruptibleSleep\.sleep\(1\);[\s\S]*continue;/,
    "the connect callback's sticky wake is consumed before cancellable probe spacing",
  );
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
  const stoppingGate = body.indexOf("stopping = true");
  const framebufferRelease = body.indexOf("releaseFaceclawFramebufferLease()");
  const ringInterrupt = body.indexOf("ringThreadToJoin.interrupt()");
  const ringJoin = body.indexOf("joinWorker(ringThreadToJoin)");
  const managerClose = body.indexOf("bleManager.close()");
  assert.ok(stoppingGate >= 0 && framebufferRelease > stoppingGate, "ring work is excluded before framebuffer release can wait");
  assert.ok(ringInterrupt >= 0 && ringJoin > ringInterrupt && managerClose > ringJoin);
  assert.ok(
    body.indexOf("threadToJoin.interrupt()") < body.indexOf("joinWorker(threadToJoin)"),
    "display worker is interrupted before either bounded join",
  );
  assert.ok(
    ringInterrupt < body.indexOf("joinWorker(threadToJoin)"),
    "ring worker is interrupted before waiting for the display worker",
  );
  assert.match(body, /ringInterruptibleSleep\.interrupt\(\)/);
  assert.match(body, /synchronized \(lifecycleLock\)/, "start and teardown share one lifecycle serialization lock");
  assert.match(methodBody(communicator, "public void start()"), /synchronized \(lifecycleLock\)/);
  assert.match(methodBody(communicator, "public void start()"), /if \(running \|\| stopping\)/);

  const joinWorker = methodBody(communicator, "private boolean joinWorker(Thread thread)");
  assert.match(joinWorker, /thread\.join\(5_000\)/);
  assert.match(joinWorker, /return !thread\.isAlive\(\)/);
  const quiescenceGuard = body.indexOf("if (!displayWorkerStopped || !ringWorkerStopped)");
  assert.ok(quiescenceGuard > ringJoin, "both bounded joins are checked before teardown continues");
  assert.ok(body.indexOf("resetSessionStateLocked()") > quiescenceGuard);
  assert.ok(body.indexOf("resetRingStateLocked()") > quiescenceGuard);
  assert.ok(managerClose > quiescenceGuard, "BLE manager close is unreachable after a live-worker join");
});

test("stopping is a durable gate for every direct-ring entry and side effect", () => {
  assert.match(communicator, /private volatile boolean stopping/);
  for (const signature of [
    "public boolean requestRingReconnect()",
    "private boolean shouldAttemptRingConnect()",
    "private void tryConnectRing(String reason)",
    "private void handleRingFailure(String reason, Throwable failure)",
    "private int connectRing()",
    "private void queueRingPacketAck(byte[] frame)",
    "private boolean isRingOperationAllowedLocked(int generation)",
    "private void sendRawRingFrame(String label, byte[] frame)",
  ]) {
    assert.match(methodBody(communicator, signature), /stopping/, `${signature} must reject work during teardown`);
  }
  assert.match(methodBody(communicator, "private void runRingLoop()"), /!stopping/);
  assert.match(methodBody(communicator, "public void onConnectionStateChange(String address, boolean connected)"), /if \(stopping\)[^{]*\{\s*return;/);

  const managerGate = methodBody(communicator, "private <T> T withRingManagerOperation(");
  const gateCheck = managerGate.indexOf("if (stopping || !running");
  const sideEffect = managerGate.indexOf("operation.run()");
  assert.match(managerGate, /synchronized \(ringLock\)/);
  assert.ok(gateCheck >= 0 && sideEffect > gateCheck, "the stopping/generation gate is held through the manager call");

  const ringSection = communicator.slice(
    communicator.indexOf("private void handleRingFailure("),
    communicator.indexOf("private void sendPrelude()"),
  ).replace(/\s+/g, " ");
  const directManagerCalls = [...ringSection.matchAll(/bleManager\.(?:connect|discoverServices|requestConnectionPriority|requestMtu|enableNotifications|readCharacteristic|describeServices|writeFrames|disconnect)\(\s*ringAddress\b/g)];
  assert.ok(directManagerCalls.length >= 9, "the audit must cover connect, recovery, diagnostics, and writes");
  for (const call of directManagerCalls) {
    const prefix = ringSection.slice(Math.max(0, call.index - 400), call.index);
    assert.ok(
      prefix.lastIndexOf("withRingManagerOperation(") > prefix.lastIndexOf(";"),
      `${call[0]} must begin only inside the shared atomic ring manager gate`,
    );
  }
});

test("BLE waits serialize per address while the process-wide API lock is initiation-only", () => {
  assert.match(manager, /ConcurrentHashMap<String, Object> operationLocks/);
  assert.match(manager, /GattCallbackRegistry<BluetoothGatt> callbackRegistry/);
  assert.match(manager, /private static final Object BLUETOOTH_API_LOCK = new Object\(\)/);
  assert.match(methodBody(manager, "private Object gattLock(String address)"), /operationLocks\.computeIfAbsent/);
  const apiBodies = synchronizedBodies(manager, "BLUETOOTH_API_LOCK");
  assert.ok(apiBodies.length >= 8, "all immediate BluetoothGatt API starts must use the process-wide lock");
  for (const body of apiBodies) {
    assert.doesNotMatch(body, /await(?:Latch|Operation)\(|Thread\.sleep\(|listener\./);
  }
  assert.match(methodBody(manager, "onConnectionStateChange("), /callbackRegistry\.(?:completeConnect|disconnectIfCurrent)\(/);
  for (const callback of ["onServicesDiscovered(", "onMtuChanged(", "onDescriptorWrite(", "onCharacteristicWrite(", "onCharacteristicRead("]) {
    assert.match(methodBody(manager, callback), /callbackRegistry\.completeOperation\(/);
  }
  assert.match(methodBody(manager, "onCharacteristicChanged("), /callbackRegistry\.dispatchIfCurrent\(/);
  assert.doesNotMatch(manager, /ConcurrentHashMap<String, CountDownLatch>/, "latches must be identity-bound operation contexts, not address-keyed globals");
  assert.doesNotMatch(manager, /isCurrentGatt\(/, "standalone identity checks are check-then-act races");
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
