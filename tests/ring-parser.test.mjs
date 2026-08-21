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
  decodeRingFirmwareVersion,
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

// Vital header: [count][timezone i16][day base u32][current timestamp u32]
// [current value][records]. Legacy vectors use zero timezone/day metadata.
function buildHealthPayload(currentTimestampSec, current, records, timezoneOffsetMinutes = 0, dayBaseSec = 0) {
  return Uint8Array.from([
    records.length, ...u16(timezoneOffsetMinutes), ...u32(dayBaseSec),
    ...u32(currentTimestampSec), current & 0xff, ...records.flat(),
  ]);
}
function buildHrvPayload(currentTimestampSec, current, records, timezoneOffsetMinutes = 0, dayBaseSec = 0) {
  const recBytes = records.flatMap(([h, a, mx, mn]) => [h, ...u16(a), ...u16(mx), ...u16(mn)]);
  return Uint8Array.from([
    records.length, ...u16(timezoneOffsetMinutes), ...u32(dayBaseSec),
    ...u32(currentTimestampSec), ...u16(current), ...recBytes,
  ]);
}
function buildActivityPayload(timezoneOffsetMinutes, dayBaseSec, records) {
  return Uint8Array.from([
    records.length,
    ...u16(timezoneOffsetMinutes),
    ...u32(dayBaseSec),
    ...records.flat(),
  ]);
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
  const data = buildHealthPayload(0x628a, 70, [[21, 72, 80, 66]]);
  const inner = buildInner(2, 1, 1, 2, 0x10, data);
  // Split across several fragments to exercise multi-packet reassembly.
  const frames = toFragments(inner, 8);
  assert.ok(frames.length > 1, "expected a multi-packet split");
  const { batchId, inner: out } = reassembleHealthFrames(frames);
  assert.equal(batchId, ringCrc32(inner));
  assert.deepEqual(Array.from(out), Array.from(inner));
});

test("reassembleHealthFrames accepts fragments in any arrival order", () => {
  const inner = buildInner(2, 2, 1, 2, 0x11, buildHealthPayload(0, 0, []));
  const frames = toFragments(inner, 6).reverse();
  const { inner: out } = reassembleHealthFrames(frames);
  assert.deepEqual(Array.from(out), Array.from(inner));
});

test("reassembleHealthFrames rejects a corrupted payload", () => {
  const inner = buildInner(2, 1, 1, 2, 0x12, buildHealthPayload(0, 0, []));
  const frames = toFragments(inner, 32);
  frames[0][6] ^= 0xff; // flip a payload byte so the crc no longer matches
  assert.throws(() => reassembleHealthFrames(frames), /CRC mismatch/);
});

test("reassembleHealthFrames rejects fragments from different batches", () => {
  const a = toFragments(buildInner(2, 1, 1, 2, 1, buildHealthPayload(0, 0, [])), 32)[0];
  const b = toFragments(buildInner(2, 2, 1, 2, 2, buildHealthPayload(0, 0, [])), 32)[0];
  assert.throws(() => reassembleHealthFrames([a, b]), /batch mismatch/);
});

// --- inner-frame envelope --------------------------------------------------

test("parseInnerFrame unwraps module/cmd/subCmd/status and the data region", () => {
  const data = buildHealthPayload(0, 0, []);
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

// Synthetic legacy/unanchored vectors preserve fallback behavior without
// committing captured health readings.
test("decodeDailyData decodes synthetic heart-rate records + live current", () => {
  const payload = buildHealthPayload(0, 70, [[4, 60, 70, 50], [6, 62, 72, 52]]);
  const d = decodeDailyData(payload, "heartRate");
  assert.equal(d.metric, "heartRate");
  assert.equal(d.count, 2);
  assert.equal(d.current, 70);
  assert.equal(d.records.length, 2);
  assert.equal(d.timezoneOffsetMinutes, 0);
  assert.equal(d.dayBaseSec, 0);
  assert.equal(d.currentTimestampSec, null);
  assert.deepEqual(d.records[0], { hourIdx: 4, avg: 60, max: 70, min: 50, timestampSec: null, timezoneOffsetMinutes: null });
  assert.deepEqual(d.records[1], { hourIdx: 6, avg: 62, max: 72, min: 52, timestampSec: null, timezoneOffsetMinutes: null });
  for (const r of d.records) assert.ok(r.min <= r.avg && r.avg <= r.max); // internally consistent
});

test("decodeDailyData decodes synthetic sparse SpO2 hours", () => {
  const payload = buildHealthPayload(0, 98, [[4, 97, 98, 96], [6, 96, 98, 95]]);
  const d = decodeDailyData(payload, "spo2");
  assert.equal(d.count, 2);
  assert.equal(d.current, 98);
  assert.deepEqual(d.records[0], { hourIdx: 4, avg: 97, max: 98, min: 96, timestampSec: null, timezoneOffsetMinutes: null });
  assert.deepEqual(d.records[1], { hourIdx: 6, avg: 96, max: 98, min: 95, timestampSec: null, timezoneOffsetMinutes: null });
});

test("decodeDailyData decodes synthetic HRV u16 records and current", () => {
  const payload = buildHrvPayload(0, 40, [[4, 35, 45, 25], [6, 42, 52, 32]]);
  const d = decodeDailyData(payload, "hrv");
  assert.equal(d.count, 2);
  assert.equal(d.current, 40);
  assert.deepEqual(d.records[0], { hourIdx: 4, avg: 35, max: 45, min: 25, timestampSec: null, timezoneOffsetMinutes: null });
  assert.deepEqual(d.records[1], { hourIdx: 6, avg: 42, max: 52, min: 32, timestampSec: null, timezoneOffsetMinutes: null });
});

test("decodeDailyData stops at the record count and ignores trailing bytes", () => {
  const payload = buildHealthPayload(0x1234, 70, [[8, 62, 70, 55], [9, 66, 72, 58]]);
  payload[0] = 1; // header says 1 record; the second must be ignored
  const decoded = decodeDailyData(payload, "heartRate");
  assert.equal(decoded.records.length, 1);
  assert.deepEqual(decoded.records[0], { hourIdx: 8, avg: 62, max: 70, min: 55, timestampSec: null, timezoneOffsetMinutes: null });
});

test("decodeDailyData anchors vital and HRV records to the validated day base", () => {
  const dayBaseSec = 1_787_180_400;
  const currentTimestampSec = dayBaseSec + 13 * 3600 + 120;
  const hr = decodeDailyData(
    buildHealthPayload(currentTimestampSec, 64, [[6, 60, 70, 55]], 60, dayBaseSec),
    "heartRate",
  );
  assert.equal(hr.timezoneOffsetMinutes, 60);
  assert.equal(hr.dayBaseSec, dayBaseSec);
  assert.equal(hr.currentTimestampSec, currentTimestampSec);
  assert.equal(hr.records[0].timestampSec, dayBaseSec + 6 * 3600);
  assert.equal(hr.records[0].timezoneOffsetMinutes, 60);

  const hrv = decodeDailyData(
    buildHrvPayload(currentTimestampSec, 42, [[23, 40, 50, 30]], 60, dayBaseSec),
    "hrv",
  );
  assert.equal(hrv.records[0].timestampSec, dayBaseSec + 23 * 3600);
  assert.equal(hrv.records[0].timezoneOffsetMinutes, 60);
});

test("decodeDailyData fails closed on invalid day metadata without losing vital values", () => {
  const aligned = 1_787_180_400;
  const cases = [
    buildHealthPayload(aligned + 3600, 64, [[6, 60, 70, 55]], 841, aligned),
    buildHealthPayload(aligned + 3600, 64, [[6, 60, 70, 55]], 60, aligned + 1),
    buildHealthPayload(aligned + 86400, 64, [[24, 60, 70, 55]], 60, aligned),
  ];
  for (const payload of cases) {
    const decoded = decodeDailyData(payload, "heartRate");
    assert.equal(decoded.current, 64);
    assert.equal(decoded.currentTimestampSec, null);
    assert.equal(decoded.records[0].timestampSec, null);
  }
});

test("decodeDailyData rejects a count that declares a truncated final record", () => {
  const full = buildHealthPayload(0, 70, [[8, 62, 70, 55], [9, 66, 72, 58]]);
  const truncated = full.subarray(0, full.length - 2); // chop the last record's tail
  assert.throws(() => decodeDailyData(truncated, "heartRate"), /truncated/);
});

test("decodeDailyData decodes confirmed activity slots, steps, and native calories", () => {
  const dayBaseSec = Math.floor(Date.UTC(2030, 0, 1, 23, 0, 0) / 1000);
  const payload = buildActivityPayload(60, dayBaseSec, [
    [67, ...u16(5), ...u16(5), ...u16(23)],
    [68, ...u16(18), ...u16(5), ...u16(17)],
  ]);
  const decoded = decodeDailyData(payload, "activity");
  assert.equal(decoded.records.length, 2);
  assert.equal(decoded.dayBaseSec, dayBaseSec);
  assert.equal(decoded.timezoneOffsetMinutes, 60);
  assert.deepEqual(decoded.records[0], {
    slot: 67,
    timestampSec: dayBaseSec + 67 * 600,
    steps: 5,
    activeCalories: 5,
    totalCalories: 23,
    restingCalories: 18,
  });
  assert.deepEqual(decoded.records[1], {
    slot: 68,
    timestampSec: dayBaseSec + 68 * 600,
    steps: 18,
    activeCalories: 5,
    totalCalories: 17,
    restingCalories: 12,
  });
});

test("decodeDailyData rejects malformed activity records instead of surfacing partial totals", () => {
  const syntheticDayBaseSec = Math.floor(Date.UTC(2030, 0, 1, 23, 0, 0) / 1000);
  assert.throws(
    () => decodeDailyData(buildActivityPayload(60, syntheticDayBaseSec, [[144, ...u16(1), ...u16(1), ...u16(2)]]), "activity"),
    /slot out of range/,
  );
  assert.throws(
    () => decodeDailyData(buildActivityPayload(60, syntheticDayBaseSec, [[71, ...u16(1), ...u16(16), ...u16(15)]]), "activity"),
    /calories invalid/,
  );
  const truncated = buildActivityPayload(60, syntheticDayBaseSec, [[71, ...u16(1), ...u16(3), ...u16(15)]]).subarray(0, 12);
  assert.throws(() => decodeDailyData(truncated, "activity"), /truncated/);
});

// --- end-to-end: reassemble then decode ------------------------------------

test("a multi-packet SpO2 frame reassembles and decodes end to end", () => {
  const payload = buildHealthPayload(0x628a, 98, [[21, 97, 99, 96]]);
  const inner = buildInner(2, 2, 1, 2, 0x20, payload);
  const frames = toFragments(inner, 7);
  const { inner: out } = reassembleHealthFrames(frames);
  const env = parseInnerFrame(out);
  assert.equal(RING_HEALTH_CMD[env.cmd], "spo2");
  const decoded = decodeDailyData(env.data, "spo2");
  assert.equal(decoded.count, 1);
  assert.equal(decoded.current, 98);
  assert.deepEqual(decoded.records[0], { hourIdx: 21, avg: 97, max: 99, min: 96, timestampSec: null, timezoneOffsetMinutes: null });
});

// --- device status ---------------------------------------------------------

test("decodeRingBattery reads the battery percent from data[0]", () => {
  // deviceStatus data region, battery percent in the first byte (0x61 = 97).
  assert.equal(decodeRingBattery(hexToBytes("61020100000000")), 97);
});

test("decodeRingFirmwareVersion reads the first NUL-padded 16-byte ASCII field", () => {
  const field = Uint8Array.from([
    ...new TextEncoder().encode("2.2.8.0002"),
    0, 0, 0, 0, 0, 0,
    ...new TextEncoder().encode("ignored trailing device data"),
  ]);
  assert.equal(decodeRingFirmwareVersion(field), "2.2.8.0002");
});

test("decodeRingFirmwareVersion rejects non-printable bytes", () => {
  assert.equal(decodeRingFirmwareVersion(Uint8Array.from([0x32, 0x2e, 0x01, 0])), "");
});

test("decodeRingFirmwareVersion never reads past the 16-byte field", () => {
  const bytes = new TextEncoder().encode("1234567890abcdefTRAILING");
  assert.equal(decodeRingFirmwareVersion(bytes), "1234567890abcdef");
});

// --- unobserved layouts ----------------------------------------------------

test("temperature has no separate record; sleep decoder is an unobserved stub", () => {
  // Temperature rides the stride-9 hourly layout (no dedicated record); the
  // stub is a defensive never-call. Sleep is still genuinely unobserved.
  assert.throws(() => decodeTemperatureDetail(new Uint8Array(0)), /no separate ring temperature-detail record/);
  assert.throws(() => decodeSleep(new Uint8Array(0)), /not yet observed/);
});
