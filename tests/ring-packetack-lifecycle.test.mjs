import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../App_Resources/Android/src/main/java/com/faceclaw/app/FaceclawBleCommunicator.java", import.meta.url), "utf8");

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

test("packetAck retirement atomically increments generation and clears the queue", () => {
  const body = methodBody("private void invalidateRingPacketAckStateLocked()");
  assert.ok(body.indexOf("ringConnectionGeneration++") < body.indexOf("ringPacketAckQueue.clear()"));
});

test("ring disconnect and failed connect retire delayed packetAck work", () => {
  assert.match(methodBody("private int updateDirectRingConnectionStateLocked(boolean connected)"), /invalidateRingPacketAckStateLocked\(\)/);
  assert.match(methodBody("private void handleRingFailure(String reason, Throwable failure)"), /invalidateRingPacketAckStateLocked\(\)/);
});

test("successful replacement and hard transport failure start a clean generation", () => {
  const connect = methodBody("private int connectRing()");
  assert.ok(connect.indexOf("invalidateRingPacketAckStateLocked()") < connect.indexOf("ringNotificationsReady = true"));
  const failure = methodBody("private void hardTransportFailure(String reason)");
  assert.ok(failure.indexOf("ringNotificationsReady = false") < failure.indexOf("invalidateRingPacketAckStateLocked()"));
  assert.ok(failure.indexOf("invalidateRingPacketAckStateLocked()") < failure.indexOf("bleManager.disconnect(rightAddress)"));
});

test("final packetAck write is serialized with lifecycle retirement", () => {
  const send = methodBody("private void sendRingPacketAck(RingPacketAckCursor cursor)");
  assert.match(send, /synchronized \(ringLock\)/);
  assert.match(send, /isRingOperationAllowedLocked\(cursor\.generation\)/);
  assert.ok(send.indexOf("isRingOperationAllowedLocked") < send.indexOf('sendRingCommand("packetAck"'));
});

test("queue remains bounded and callback enqueue cannot write", () => {
  const queue = methodBody("private void queueRingPacketAck(byte[] frame, int generation)");
  assert.match(queue, /isRingOperationAllowedLocked\(generation\)/);
  assert.match(queue, /ringPacketAckQueue\.size\(\) >= 16/);
  assert.match(queue, /ringPacketAckQueue\.removeFirst\(\)/);
  assert.match(queue, /ringPacketAckQueue\.addLast\(/);
  assert.doesNotMatch(queue, /sendRingCommand\(/);
});
