import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

// ring-parser.ts is a pure, self-contained decoder (no imports); transpile it
// and load it as a module so we exercise the real implementation, not a copy.
const src = readFileSync(new URL("../app/health/ring-parser.ts", import.meta.url), "utf8");
const js = ts.transpileModule(src, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
}).outputText;
const {
  ringCrc32,
  reassembleHealthFrames,
  parseInnerFrame,
  decodeDailyData,
  decodeRingBattery,
  decodeTemperatureDetail,
  decodeSleep,
  RING_HEALTH_CMD,
} = await import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));

// --- helpers (synthetic vectors only) --------------------------------------

const hexToBytes = (h) => Uint8Array.from(h.replace(/\s+/g, "").match(/../g).map((x) => parseInt(x, 16)));

const u16 = (v) => [v & 0xff, (v >>> 8) & 0xff];
const u32 = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];

// Build an inner-frame envelope (matches the Java buildRingFrame inner layout).
function buildInner(module, cmd, subCmd, status, serial, data) {
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
  // crc16 (inner[10..11]) left zero; the parser does not validate it.
  inner.set(data, 12);
  return inner;
}

// Wrap an inner buffer as N notify fragments: [fragIndex u8][batchId u32 LE]
// followed by a slice of the inner buffer. batchId = ringCrc32(inner), and
// fragments are emitted in descending fragIndex order like the ring does.
function toFragments(inner, chunkSize) {
  const batchId = ringCrc32(inner);
  const chunks = [];
  for (let o = 0; o < inner.length; o += chunkSize) {
    chunks.push(inner.subarray(o, Math.min(o + chunkSize, inner.length)));
  }
  // chunks[0] is the head of the inner buffer and carries the highest fragIndex.
  const frames = [];
  for (let i = 0; i < chunks.length; i++) {
    const fragIndex = chunks.length - 1 - i;
    const frame = new Uint8Array(5 + chunks[i].length);
    frame[0] = fragIndex;
    frame.set(u32(batchId), 1);
    frame.set(chunks[i], 5);
    frames.push(frame);
  }
  return frames;
}

// Build a daily-push payload: [count u8][interval u16 LE][base_ts u32 LE][records].
function buildDailyPayload(interval, baseTs, records) {
  return Uint8Array.from([records.length, ...u16(interval), ...u32(baseTs), ...records.flat()]);
}

// --- CRC-32 --------------------------------------------------------------

test("ringCrc32 reproduces a documented frame's stored transport checksum", () => {
  // A public com.even.sg -> ring TX command (healthSettingsStatus GET). The
  // transport stores ringCrc32 of the inner frame little-endian at bytes 1..4;
  // recomputing it over the inner frame must reproduce the stored value.
  const frame = hexToBytes("00d5faceaf640164280000000e0c00912f");
  const inner = frame.subarray(5);
  const stored = (frame[1] | (frame[2] << 8) | (frame[3] << 16) | (frame[4] << 24)) >>> 0;
  assert.equal(ringCrc32(inner), stored);
});

// --- fragment reassembly ---------------------------------------------------

test("reassembleHealthFrames rebuilds the inner buffer and validates crc32==batchId", () => {
  const data = buildDailyPayload(60, 1700000000, [[...u32(1700000000), 70, 21, 72, 80, 66]]);
  const inner = buildInner(2, 1, 1, 2, 0x10, data);
  // Split across several fragments to exercise multi-packet reassembly.
  const frames = toFragments(inner, 8);
  assert.ok(frames.length > 1, "expected a multi-packet split");
  const { batchId, inner: out } = reassembleHealthFrames(frames);
  assert.equal(batchId, ringCrc32(inner));
  assert.deepEqual(Array.from(out), Array.from(inner));
});

test("reassembleHealthFrames accepts fragments in any arrival order", () => {
  const inner = buildInner(2, 2, 1, 2, 0x11, buildDailyPayload(60, 1700000000, []));
  const frames = toFragments(inner, 6).reverse();
  const { inner: out } = reassembleHealthFrames(frames);
  assert.deepEqual(Array.from(out), Array.from(inner));
});

test("reassembleHealthFrames rejects a corrupted payload", () => {
  const inner = buildInner(2, 1, 1, 2, 0x12, buildDailyPayload(60, 1700000000, []));
  const frames = toFragments(inner, 32);
  frames[0][6] ^= 0xff; // flip a payload byte so the crc no longer matches
  assert.throws(() => reassembleHealthFrames(frames), /CRC mismatch/);
});

test("reassembleHealthFrames rejects fragments from different batches", () => {
  const a = toFragments(buildInner(2, 1, 1, 2, 1, buildDailyPayload(60, 1, [])), 32)[0];
  const b = toFragments(buildInner(2, 2, 1, 2, 2, buildDailyPayload(60, 1, [])), 32)[0];
  assert.throws(() => reassembleHealthFrames([a, b]), /batch mismatch/);
});

// --- inner-frame envelope --------------------------------------------------

test("parseInnerFrame unwraps module/cmd/subCmd/status and the data region", () => {
  const data = buildDailyPayload(60, 1700000000, []);
  const inner = buildInner(2, 4, 1, 2, 0x2a, data);
  const f = parseInnerFrame(inner);
  assert.equal(f.module, 2);
  assert.equal(f.cmd, 4);
  assert.equal(f.subCmd, 1);
  assert.equal(f.status, 2);
  assert.equal(f.serial, 0x2a);
  assert.equal(RING_HEALTH_CMD[f.cmd], "hrv");
  assert.deepEqual(Array.from(f.data), Array.from(data));
});

// --- daily-push decode -----------------------------------------------------

test("decodeDailyData decodes the documented SpO2 example to 97 percent", () => {
  // Public spec example: [count][interval=60][base_ts][record...][trailing].
  // The record's latest/avg/max/min are all 0x61 = 97, hour index 0x15 = 21.
  const payload = hexToBytes("01 3c00 f0e3846a 4f0b866a 61 15 61 61 61 00000000");
  const decoded = decodeDailyData(payload, "spo2");
  assert.equal(decoded.metric, "spo2");
  assert.equal(decoded.interval, 60);
  assert.equal(decoded.count, 1);
  assert.equal(decoded.records.length, 1);
  const r = decoded.records[0];
  assert.equal(r.latest, 97);
  assert.equal(r.avg, 97);
  assert.equal(r.max, 97);
  assert.equal(r.min, 97);
  assert.equal(r.hourIdx, 21);
});

test("decodeDailyData round-trips a synthetic heart-rate batch (stride 9)", () => {
  const ts0 = 1700000000;
  const records = [
    [...u32(ts0), 60, 8, 62, 70, 55],
    [...u32(ts0 + 3600), 65, 9, 66, 72, 58],
  ];
  const payload = buildDailyPayload(60, ts0, records);
  const decoded = decodeDailyData(payload, "heartRate");
  assert.equal(decoded.metric, "heartRate");
  assert.equal(decoded.interval, 60);
  assert.equal(decoded.baseTs, ts0);
  assert.equal(decoded.records.length, 2);
  assert.deepEqual(decoded.records[0], { ts: ts0, latest: 60, hourIdx: 8, avg: 62, max: 70, min: 55 });
  assert.equal(decoded.records[1].hourIdx, 9);
  assert.equal(decoded.records[1].min, 58);
});

test("decodeDailyData round-trips a synthetic HRV batch (stride 13)", () => {
  const ts0 = 1700000000;
  const records = [[...u32(ts0), ...u16(55), 21, ...u16(1), ...u16(2), ...u16(3)]];
  const payload = buildDailyPayload(60, ts0, records);
  const decoded = decodeDailyData(payload, "hrv");
  assert.equal(decoded.records.length, 1);
  const r = decoded.records[0];
  assert.equal(r.ts, ts0);
  assert.equal(r.latest, 55);
  assert.equal(r.hourIdx, 21);
  assert.equal(r.field1, 1);
  assert.equal(r.field2, 2);
  assert.equal(r.field3, 3);
});

test("decodeDailyData round-trips a synthetic activity batch (stride 7)", () => {
  const records = [
    [126, ...u16(0), ...u16(2), ...u16(15)],
    [127, ...u16(47), ...u16(12), ...u16(25)],
  ];
  const payload = buildDailyPayload(60, 1700000000, records);
  const decoded = decodeDailyData(payload, "activity");
  assert.equal(decoded.records.length, 2);
  assert.deepEqual(decoded.records[0], { slot: 126, steps: 0, f1: 2, f2: 15 });
  assert.deepEqual(decoded.records[1], { slot: 127, steps: 47, f1: 12, f2: 25 });
});

test("decodeDailyData stops at the record count and ignores trailing bytes", () => {
  const payload = buildDailyPayload(60, 1700000000, [[...u32(1700000000), 60, 8, 62, 70, 55]]);
  const withTrailing = Uint8Array.from([...payload, 0, 0, 0, 0]);
  const decoded = decodeDailyData(withTrailing, "heartRate");
  assert.equal(decoded.records.length, 1);
});

// --- end-to-end: reassemble then decode ------------------------------------

test("a multi-packet SpO2 frame reassembles and decodes end to end", () => {
  const ts0 = 1700003600;
  const payload = buildDailyPayload(60, ts0, [[...u32(ts0), 98, 21, 97, 99, 96]]);
  const inner = buildInner(2, 2, 1, 2, 0x20, payload);
  const frames = toFragments(inner, 7);
  const { inner: out } = reassembleHealthFrames(frames);
  const env = parseInnerFrame(out);
  assert.equal(RING_HEALTH_CMD[env.cmd], "spo2");
  const decoded = decodeDailyData(env.data, "spo2");
  assert.equal(decoded.records[0].latest, 98);
  assert.equal(decoded.records[0].min, 96);
});

// --- device status ---------------------------------------------------------

test("decodeRingBattery reads the battery percent from data[0]", () => {
  // deviceStatus data region, battery percent in the first byte (0x61 = 97).
  assert.equal(decodeRingBattery(hexToBytes("61020100000000")), 97);
});

// --- unobserved layouts ----------------------------------------------------

test("temperature-detail and sleep decoders are explicit unobserved stubs", () => {
  assert.throws(() => decodeTemperatureDetail(new Uint8Array(0)), /not yet observed/);
  assert.throws(() => decodeSleep(new Uint8Array(0)), /not yet observed/);
});
