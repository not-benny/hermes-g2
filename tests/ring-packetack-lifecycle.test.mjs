import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(
  new URL("../App_Resources/Android/src/main/java/com/faceclaw/app/FaceclawBleCommunicator.java", import.meta.url),
  "utf8",
);

function methodBody(signature) {
  const start = source.indexOf(signature);
  assert.notEqual(start, -1, `missing ${signature}`);
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    if (source[i] === "}" && --depth === 0) return source.slice(open, i + 1);
  }
  assert.fail(`unterminated ${signature}`);
}

function assertRetiresPacketAck(body, label) {
  assert.match(body, /(?:ringConnectionGeneration\+\+|retireRingPacketAckStateLocked\(\))/,
    `${label} must invalidate delayed cursors`);
}

test("packetAck retirement atomically increments generation and clears the queue", () => {
  const retire = methodBody("private void retireRingPacketAckStateLocked()");
  assert.match(retire, /ringConnectionGeneration\+\+/);
  assert.match(retire, /ringPacketAckQueue\.clear\(\)/);
  assert.ok(retire.indexOf("ringConnectionGeneration++") < retire.indexOf("ringPacketAckQueue.clear()"));
});

test("ring disconnect retires queued packetAck cursors before reconnect", () => {
  const callback = methodBody("@Override public void onConnectionStateChange(String address, boolean connected)");
  const ringBranch = callback.slice(callback.indexOf("if (isConfiguredRingAddress(address))"));
  assertRetiresPacketAck(ringBranch, "ring disconnect");
  assert.ok(ringBranch.indexOf("ringConnectionGeneration++") < ringBranch.indexOf("ringPacketAckQueue.clear()"));
});

test("successful ring replacement starts a new generation and empty queue", () => {
  const connect = methodBody("private void connectRing()");
  assertRetiresPacketAck(connect.slice(connect.indexOf("synchronized (lock)")), "ring reconnect");
});

test("failed ring connect retires stale delayed packetAck work", () => {
  const attempt = methodBody("private void tryConnectRing(String reason)");
  const failure = attempt.slice(attempt.indexOf("} catch (Throwable t)"));
  assertRetiresPacketAck(failure, "failed ring connect");
  assert.match(failure, /retireRingPacketAckStateLocked\(\)/);
});

test("hard transport failure retires packetAck work before manager teardown", () => {
  const failure = methodBody("private void hardTransportFailure(String reason)");
  assertRetiresPacketAck(failure, "hard transport failure");
  assert.match(failure, /retireRingPacketAckStateLocked\(\)/);
  assert.ok(failure.indexOf("retireRingPacketAckStateLocked()") < failure.indexOf("bleManager.disconnect(rightAddress)"));
});

test("final packetAck write is under the lifecycle lock and rejects stale work", () => {
  const send = methodBody("private void sendRingPacketAck(RingPacketAckCursor cursor)");
  assert.match(send, /synchronized \(lock\)/);
  assert.match(send, /!ringConnected/);
  assert.match(send, /!ringNotificationsReady/);
  assert.match(send, /cursor\.generation != ringConnectionGeneration/);
  assert.ok(send.indexOf("cursor.generation != ringConnectionGeneration") < send.indexOf('sendRingCommand("packetAck"'));
});

test("multi-packet history remains bounded and preserves valid cursor order", () => {
  const queue = methodBody("private void queueRingPacketAck(byte[] frame)");
  assert.match(queue, /if \(frame == null \|\| frame\.length < 17/);
  assert.match(queue, /storedCrc != ringCrc32\(frame, 5, innerLen\)/);
  assert.match(queue, /ringPacketAckQueue\.size\(\) >= 16/);
  assert.match(queue, /ringPacketAckQueue\.addLast\(new RingPacketAckCursor\(payload, ringConnectionGeneration\)\)/);
  const drain = methodBody("private void drainRingPacketAcks()");
  assert.match(drain, /cursor = ringPacketAckQueue\.pollFirst\(\)/);
  assert.match(drain, /sendRingPacketAck\(cursor\)/);
});
