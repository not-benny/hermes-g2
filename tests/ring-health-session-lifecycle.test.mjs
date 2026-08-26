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

const crc32Table = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let value = i << 24;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 0x80000000) !== 0 ? (value << 1) ^ 0x1edc6f41 : value << 1;
    }
    table[i] = value;
  }
  return table;
})();

function ringCrc32(bytes) {
  let crc = 0;
  for (const byte of bytes) crc = (crc << 8) ^ crc32Table[((crc >>> 24) ^ byte) & 0xff];
  return crc >>> 0;
}

function incomingCrc16Modbus(inner) {
  let crc = 0xffff;
  for (let i = 0; i < inner.length; i += 1) {
    crc ^= i === 10 || i === 11 ? 0 : inner[i];
    for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? (crc >>> 1) ^ 0xa001 : crc >>> 1;
  }
  return crc & 0xffff;
}

test("R1 health readiness requires the command-response notification channel", () => {
  const connect = methodBody("private int connectRing(long glassesAttemptGeneration)");
  assert.match(connect, /boolean dataNotify = enableRingNotification\(BleProtocol\.R1_NOTIFY_CHAR_UUID\)/);
  assert.match(connect, /if \(!dataNotify\)[\s\S]*Failure\.PROTOCOL/);
  assert.doesNotMatch(connect, /if \(!phoneNotify && !dataNotify\)/);
});

test("pairAuth acknowledgement, not GATT write completion, establishes the health session", () => {
  const probe = methodBody("private void probeRingHealth(int generation)");
  const accept = methodBody("private void acceptRingPairAuthAck(byte[] frame, int generation)");
  const validate = methodBody("private static boolean isSuccessfulRingPairAuthAck(byte[] frame)");
  const awaitAck = methodBody("private boolean awaitRingPairAuthAck(int generation)");

  assert.match(probe, /openSession = !ringHealthSessionEstablished/);
  assert.match(probe, /ringPairAuthAckGeneration = -1/);
  assert.match(probe, /ringPairAuthPendingGeneration = generation[\s\S]*sendRawRingFrameForGeneration/);
  assert.match(probe, /awaitRingPairAuthAck\(generation\)/);
  assert.match(probe, /Failure\.PROTOCOL/);
  assert.doesNotMatch(probe, /ringHealthSessionEstablished = true/);

  assert.match(accept, /isSuccessfulRingPairAuthAck\(frame\)/);
  assert.match(accept, /isRingOperationAllowedLocked\(generation\)/);
  assert.match(accept, /ringPairAuthPendingGeneration != generation/);
  assert.match(accept, /ringHealthSessionEstablished = true/);
  assert.match(accept, /ringPairAuthAckGeneration = generation/);
  assert.match(accept, /ringPairAuthPendingGeneration = -1/);
  assert.match(accept, /ringLock\.notifyAll\(\)/);

  // Canonical single-fragment system/pairAuth statusAck.ok, fixed request serial 1.
  assert.match(validate, /frame\.length != 18/);
  assert.match(validate, /storedCrc != ringCrc32\(frame, 5, innerLen\)/);
  assert.match(validate, /storedInnerCrc != ringIncomingCrc16Modbus\(frame, 5, innerLen\)/);
  assert.match(validate, /serial == 1/);
  assert.match(validate, /frame\[10\].*== 0x03/);
  assert.match(validate, /frame\[12\].*== 0x08/);
  assert.match(validate, /frame\[17\].*== 0x00/);

  assert.match(awaitAck, /RING_PAIR_AUTH_ACK_TIMEOUT_MS/);
  assert.match(awaitAck, /ringPairAuthPendingGeneration == generation/);
  assert.match(awaitAck, /ringPairAuthAckGeneration != generation/);
  assert.match(awaitAck, /isRingOperationAllowedLocked\(generation\)/);
});

test("stale pairAuth ACKs cannot open a replacement generation before its fresh request", () => {
  const probe = methodBody("private void probeRingHealth(int generation)");
  const accept = methodBody("private void acceptRingPairAuthAck(byte[] frame, int generation)");
  const arm = probe.indexOf("ringPairAuthPendingGeneration = generation");
  const write = probe.indexOf('sendRawRingFrameForGeneration(generation, "pairAuth (session open)"');
  assert.ok(arm >= 0 && write > arm, "pending authority must arm before the write to allow a synchronous ACK");
  assert.match(probe, /finally[\s\S]*ringPairAuthPendingGeneration == generation[\s\S]*ringPairAuthPendingGeneration = -1/);
  assert.match(accept, /ringPairAuthPendingGeneration != generation\) return/);
});

test("captured canonical pairAuth ACK has the incoming MODBUS CRC, and transport CRC alone is insufficient", () => {
  const capturedAck = Uint8Array.from(Buffer.from("00a25aac9264016401000300080d00a76400", "hex"));
  const inner = capturedAck.subarray(5);
  const storedTransport = capturedAck[1] | (capturedAck[2] << 8)
    | (capturedAck[3] << 16) | (capturedAck[4] << 24);
  const storedInner = inner[10] | (inner[11] << 8);
  assert.equal(storedTransport >>> 0, ringCrc32(inner));
  assert.equal(storedInner, incomingCrc16Modbus(inner));

  // A forged frame can carry a valid outer checksum over a bad inner checksum.
  // The pairAuth authority gate must reject it at the independent MODBUS check.
  const forged = capturedAck.slice();
  forged[15] ^= 0x01;
  const forgedTransport = ringCrc32(forged.subarray(5));
  forged[1] = forgedTransport & 0xff;
  forged[2] = (forgedTransport >>> 8) & 0xff;
  forged[3] = (forgedTransport >>> 16) & 0xff;
  forged[4] = (forgedTransport >>> 24) & 0xff;
  assert.equal((forged[1] | (forged[2] << 8) | (forged[3] << 16) | (forged[4] << 24)) >>> 0,
    ringCrc32(forged.subarray(5)));
  assert.notEqual(forged[15] | (forged[16] << 8), incomingCrc16Modbus(forged.subarray(5)));
});

test("pairAuth ACK deadline is capture-bounded with conservative scheduling slack", () => {
  assert.match(source, /Successful pairAuth replies arrived 22-160ms/);
  assert.match(source, /RING_PAIR_AUTH_ACK_TIMEOUT_MS = 1_500/);
});

test("failed current-generation health writes retire the GATT instead of leaving false ready state", () => {
  const send = methodBody("private boolean sendRawRingFrameForGeneration(int generation, String label, byte[] frame)");
  assert.match(send, /if \(!ok\)[\s\S]*new RingFailureException\(ConnectionHealthTracker\.Failure\.TRANSPORT\)/);
  assert.match(send, /catch \(RingFailureException failure\)[\s\S]*throw failure/);
  assert.match(send, /catch \(Throwable t\)[\s\S]*!isRingOperationAllowedLocked\(generation\)[\s\S]*classifyRingFailure\(t\)/);
});

test("optional systemTime failure cannot abort the mandatory health poll", () => {
  const probe = methodBody("private void probeRingHealth(int generation)");
  const clock = probe.indexOf('"systemTime SET"');
  const catchOptional = probe.indexOf("catch (RingFailureException optionalClockFailure)", clock);
  const battery = probe.indexOf('"deviceStatus GET (battery)"', catchOptional);
  const heart = probe.indexOf('"heartRate/daily GET"', battery);
  assert.ok(clock >= 0 && catchOptional > clock && battery > catchOptional && heart > battery);
  assert.match(probe.slice(clock, battery), /continuing health poll/);
  assert.doesNotMatch(probe.slice(clock, battery), /throw optionalClockFailure/);
});

test("replacement ring generations re-arm setup and poll immediately", () => {
  const connect = methodBody("private int connectRing(long glassesAttemptGeneration)");
  const poll = methodBody("private void maybeReRingHealthPoll()");
  const probe = methodBody("private void probeRingHealth(int generation)");
  assert.match(connect, /ringHealthSessionEstablished = false/);
  assert.match(connect, /ringPairAuthAckGeneration = -1/);
  assert.match(connect, /ringPairAuthPendingGeneration = -1/);
  assert.match(connect, /lastRingHealthPollMs = 0/);
  assert.match(connect, /lastRingCurrentHrPollMs = 0/);
  assert.match(probe, /ringWriteSeq = 2/);
  assert.match(poll, /lastRingHealthPollMs > 0/);
});

test("contention failures keep exponential backoff until pairAuth and a mandatory write succeed", () => {
  const connect = methodBody("private int connectRing(long glassesAttemptGeneration)");
  const probe = methodBody("private void probeRingHealth(int generation)");
  assert.doesNotMatch(connect, /ringConsecutiveFailures = 0/,
    "notification subscription alone must not forgive a pairAuth timeout");
  const deviceStatus = probe.indexOf('"deviceStatus GET (battery)"');
  const reset = probe.indexOf("ringConsecutiveFailures = 0", deviceStatus);
  assert.ok(deviceStatus >= 0 && reset > deviceStatus);
  assert.match(probe.slice(deviceStatus, reset), /ringHealthSessionEstablished/);
});
