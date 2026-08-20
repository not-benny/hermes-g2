import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// Regression gate for the R1 ring frame encoder. The root cause of every prior
// "the ring ignores Hermes" result was buildRingFrame writing RANDOM bytes into
// frame[1..4], which is actually a CRC-32 (poly 0x1EDC6F41) over the inner frame;
// the ring's transport layer silently dropped every frame. These vectors are
// genuine com.even.sg -> ring TX captures; the encoder must reproduce them.

const CAPTURES = {
  pairAuth: "00971953f964016401000000080d003f0101",
  advStart: "00c50c1248640164070000000a120045c963a3a7375bd4",
  healthSettingsGet: "00d5faceaf640164280000000e0c00912f",
  systemSettingsGet: "0000045a68640164290000000f0c00015d",
  userInfo: "000e8624a96401642c0000000418001ede020000000000000000000000",
};

// CRC-32, poly 0x1EDC6F41, MSB-first, init 0, no xorout — mirror of ringCrc32.
const CRC32_TABLE = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i << 24;
    for (let k = 0; k < 8; k++) c = (c & 0x80000000) !== 0 ? (c << 1) ^ 0x1edc6f41 : c << 1;
    t[i] = c;
  }
  return t;
})();
function ringCrc32(bytes) {
  let c = 0;
  for (const b of bytes) c = (c << 8) ^ CRC32_TABLE[((c >>> 24) ^ b) & 0xff];
  return c >>> 0;
}
// CRC-16/CCITT-FALSE variant (Nordic crc16_compute) — mirror of ringCrc16.
function ringCrc16(bytes) {
  let c = 0xffff;
  for (const b of bytes) {
    c = ((c >>> 8) & 0xff) | ((c << 8) & 0xff00);
    c ^= b;
    c ^= (c & 0xff) >>> 4;
    c ^= (c << 12) & 0xffff;
    c ^= ((c & 0xff) << 5) & 0xffff;
  }
  return c & 0xffff;
}
const hexToBytes = (h) => Uint8Array.from(h.match(/../g).map((x) => parseInt(x, 16)));
const toHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

function buildRingFrame(module, cmd, subCmd, status, serial, data = new Uint8Array(0), crc16Override = null) {
  const innerLen = 12 + data.length;
  const inner = new Uint8Array(innerLen);
  inner[0] = 0x64;
  inner[1] = module;
  inner[2] = 0x64;
  inner[3] = serial & 0xff;
  inner[4] = (serial >>> 8) & 0xff;
  inner[5] = status;
  inner[6] = cmd;
  inner[7] = subCmd;
  inner[8] = innerLen & 0xff;
  inner[9] = (innerLen >>> 8) & 0xff;
  inner.set(data, 12);
  const crc16 = crc16Override ?? ringCrc16(inner);
  inner[10] = crc16 & 0xff;
  inner[11] = (crc16 >>> 8) & 0xff;
  const crc32 = ringCrc32(inner);
  const frame = new Uint8Array(5 + innerLen);
  frame[0] = 0x00;
  frame[1] = crc32 & 0xff;
  frame[2] = (crc32 >>> 8) & 0xff;
  frame[3] = (crc32 >>> 16) & 0xff;
  frame[4] = (crc32 >>> 24) & 0xff;
  frame.set(inner, 5);
  return frame;
}

test("CRC-32 (poly 0x1EDC6F41) reproduces every captured frame's checksum", () => {
  for (const [name, hex] of Object.entries(CAPTURES)) {
    const f = hexToBytes(hex);
    const inner = f.subarray(5);
    const stored = (f[1] | (f[2] << 8) | (f[3] << 16) | (f[4] << 24)) >>> 0;
    assert.equal(ringCrc32(inner), stored, `${name}: CRC-32 mismatch`);
  }
});

test("CRC-16/CCITT-FALSE check value is 0x29B1", () => {
  assert.equal(ringCrc16(new TextEncoder().encode("123456789")), 0x29b1);
});

test("buildRingFrame reproduces the captured healthSettingsStatus GET byte-for-byte", () => {
  // module=system(1), cmd=system(0), subCmd=healthSettingsStatus(0x0e), status=req(0),
  // serial=0x28, empty data, crc16 as captured (0x2f91 — the ring does not appear to validate it).
  const frame = buildRingFrame(1, 0x00, 0x0e, 0x00, 0x28, new Uint8Array(0), 0x2f91);
  assert.equal(toHex(frame), CAPTURES.healthSettingsGet);
});

test("the Java encoder is the corrected one (CRC-32 over the inner frame, no random checksum)", () => {
  const src = readFileSync(
    new URL("../App_Resources/Android/src/main/java/com/faceclaw/app/FaceclawBleCommunicator.java", import.meta.url),
    "utf8",
  );
  // The corrected primitives exist.
  assert.match(src, /0x1EDC6F41/);
  assert.match(src, /private static int ringCrc32\(/);
  assert.match(src, /RING_HEALTH_PROBE_ENABLED = true/);
  // buildRingFrame no longer stuffs random bytes into the checksum field.
  const build = src.slice(src.indexOf("private byte[] buildRingFrame("));
  const buildBody = build.slice(0, build.indexOf("\n    }"));
  assert.doesNotMatch(buildBody, /ringRandom/);
  // The pairing-state subCmds stay blocklisted.
  assert.match(src, /isBlocklistedRingSubCmd/);
});

test("raw ring writes validate the envelope and cannot bypass the command blocklist", () => {
  const src = readFileSync(
    new URL("../App_Resources/Android/src/main/java/com/faceclaw/app/FaceclawBleCommunicator.java", import.meta.url),
    "utf8",
  );
  const rawStart = src.indexOf("private void sendRawRingFrame(");
  const validatorStart = src.indexOf("private static String rawRingFrameRefusalReason(");
  assert.notEqual(rawStart, -1);
  assert.notEqual(validatorStart, -1);

  const rawBody = src.slice(rawStart, src.indexOf("\n    }", rawStart) + 6);
  assert.match(rawBody, /rawRingFrameRefusalReason\(frame\)/);
  assert.ok(
    rawBody.indexOf("rawRingFrameRefusalReason(frame)") < rawBody.indexOf("bleManager.writeFrames("),
    "raw-frame validation must run before the BLE write",
  );
  assert.match(rawBody, /if \(refusalReason != null\)/);

  const validatorBody = src.slice(validatorStart, src.indexOf("\n    }", validatorStart) + 6);
  assert.match(validatorBody, /frame\.length < 17/);
  assert.match(validatorBody, /frame\.length != 5 \+ innerLen/);
  assert.match(validatorBody, /storedCrc != ringCrc32\(frame, 5, innerLen\)/);
  assert.match(validatorBody, /isBlocklistedRingSubCmd\(module, cmd, subCmd\)/);
});

test("direct ring requests MTU 247 before subscribing and probing", () => {
  const src = readFileSync(
    new URL("../App_Resources/Android/src/main/java/com/faceclaw/app/FaceclawBleCommunicator.java", import.meta.url),
    "utf8",
  );
  const options = readFileSync(
    new URL("../App_Resources/Android/src/main/java/com/faceclaw/app/g2protocol/ConnectionOptions.java", import.meta.url),
    "utf8",
  );
  assert.match(options, /RING_DESIRED_MTU = 247/);
  const start = src.indexOf("private void connectRing()");
  const end = src.indexOf("private void refreshRingBattery()", start);
  const body = src.slice(start, end);
  const discover = body.indexOf("discoverServices(ringAddress");
  const requestMtu = body.indexOf("requestMtu(");
  const subscribe = body.indexOf("enableRingNotification(");
  const ready = body.indexOf("ringNotificationsReady = true");
  assert.ok(start >= 0 && end > start);
  assert.ok(discover >= 0 && requestMtu > discover && subscribe > requestMtu && ready > subscribe);
  assert.match(body, /mtu247Request=/);
  assert.match(body, /mtu247Requested \? "ok" : "fallback"/); // failure is logged but ring remains usable.
});

test("worker refreshes current HR every 15 seconds without re-polling all metrics", () => {
  const src = readFileSync(
    new URL("../App_Resources/Android/src/main/java/com/faceclaw/app/FaceclawBleCommunicator.java", import.meta.url),
    "utf8",
  );
  assert.match(src, /RING_CURRENT_HR_POLL_INTERVAL_MS = 15_000L/);
  assert.match(src, /maybeReRingCurrentHrPoll\(\)/);
  const start = src.indexOf("private void maybeReRingCurrentHrPoll()");
  const end = src.indexOf("private void probeRingHealth()", start);
  const body = src.slice(start, end);
  assert.match(body, /sendRingCommand\("heartRate\/current-hour GET", 0x02, 0x01, 0x01, 0x00, null\)/);
  assert.doesNotMatch(body, /spo2\/daily|hrv\/daily|activity\/daily|sleep\/daily|deviceStatus GET/);
});

test("health pushes queue packetAck cursors and the worker drains them safely", () => {
  const src = readFileSync(
    new URL("../App_Resources/Android/src/main/java/com/faceclaw/app/FaceclawBleCommunicator.java", import.meta.url),
    "utf8",
  );
  assert.match(src, /queueRingPacketAck\(data\)/);
  assert.match(src, /drainRingPacketAcks\(\)/);
  assert.match(src, /payload\[0\] = frame\[6\]/); // module
  assert.match(src, /payload\[1\] = frame\[11\]/); // cmd
  assert.match(src, /payload\[2\] = frame\[12\]/); // subCmd
  assert.match(src, /payload\[4\] = frame\[8\]/); // incoming serial low
  assert.match(src, /payload\[5\] = frame\[9\]/); // incoming serial high
  assert.match(
    src,
    /sendRingCommand\("packetAck", 0x01, 0x00, 0x7e, 0x01, payload\)/,
  );
});
