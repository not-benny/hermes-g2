import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const dataUrl = (js) => "data:text/javascript;base64," + Buffer.from(js).toString("base64");
const transpile = (src) =>
  ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
  }).outputText;

// The store imports ./ring-parser; both are framework-free, so transpile the
// parser to a data: URL and point the store's import at it.
const parserUrl = dataUrl(transpile(read("app/health/ring-parser.ts")));
const storeJs = transpile(read("app/health/ring-health-store.ts")).replace(
  '"./ring-parser"',
  JSON.stringify(parserUrl),
);
const { ringCrc32 } = await import(parserUrl);
const { RingHealthStore, canonicalizeActivitySnapshot } = await import(dataUrl(storeJs));

// --- wire-format builders (layout per notes/ring-health-protocol) -----------

function buildInner(module, cmd, subCmd, status, data) {
  const innerLen = 12 + data.length;
  const inner = new Uint8Array(innerLen);
  inner[0] = 0x64;
  inner[1] = module;
  inner[2] = 0x64;
  inner[3] = 0x01; // serial u16 LE
  inner[4] = 0x00;
  inner[5] = status;
  inner[6] = cmd;
  inner[7] = subCmd;
  inner[8] = innerLen & 0xff;
  inner[9] = (innerLen >>> 8) & 0xff;
  inner.set(data, 12);
  const crc16 = ringCrc16Modbus(inner);
  inner[10] = crc16 & 0xff;
  inner[11] = (crc16 >>> 8) & 0xff;
  return inner;
}

function ringCrc16Modbus(bytes) {
  const copy = Uint8Array.from(bytes);
  copy[10] = 0; copy[11] = 0;
  let crc = 0xffff;
  for (const byte of copy) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc & 1) ? (crc >>> 1) ^ 0xa001 : crc >>> 1;
  }
  return crc & 0xffff;
}

/** Split an inner buffer into notify frames, fragIndex counting down to 0. */
function fragments(inner, chunks) {
  const batchId = ringCrc32(inner);
  const sizes = chunks ?? [inner.length];
  const frames = [];
  let off = 0;
  for (let i = 0; i < sizes.length; i++) {
    const fragIndex = sizes.length - 1 - i;
    const payload = inner.subarray(off, off + sizes[i]);
    off += sizes[i];
    const frame = new Uint8Array(5 + payload.length);
    frame[0] = fragIndex;
    frame[1] = batchId & 0xff;
    frame[2] = (batchId >>> 8) & 0xff;
    frame[3] = (batchId >>> 16) & 0xff;
    frame[4] = (batchId >>> 24) & 0xff;
    frame.set(payload, 5);
    frames.push(frame);
  }
  assert.equal(off, inner.length, "chunk sizes must cover the inner buffer");
  return frames;
}

function u32le(value) {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
}

/**
 * Daily payload (real layout): [count u8][6 reserved][base u32 LE][current u8]
 * + 4-byte records [hourIdx][avg][max][min]. See ring-daily-layout notes.
 */
function dailyHealth(current, records) {
  const bytes = [records.length, 0, 0, 0, 0, 0, 0, ...u32le(0x628a), current & 0xff];
  for (const r of records) bytes.push(r.hourIdx ?? 0, r.avg ?? 0, r.max ?? 0, r.min ?? 0);
  return new Uint8Array(bytes);
}

function activityPayload(timezoneOffsetMinutes, dayBaseSec, records) {
  const bytes = [records.length, timezoneOffsetMinutes & 0xff, (timezoneOffsetMinutes >>> 8) & 0xff, ...u32le(dayBaseSec)];
  for (const r of records) {
    bytes.push(
      r.slot,
      r.steps & 0xff, (r.steps >>> 8) & 0xff,
      r.activeCalories & 0xff, (r.activeCalories >>> 8) & 0xff,
      r.totalCalories & 0xff, (r.totalCalories >>> 8) & 0xff,
    );
  }
  return new Uint8Array(bytes);
}

// --- tests -------------------------------------------------------------------

test("heart-rate daily push decodes across fragments and picks the newest record", () => {
  const store = new RingHealthStore();
  const events = [];
  store.onChange((snapshot) => events.push(snapshot));

  const payload = dailyHealth(106, [
    { hourIdx: 4, avg: 73, max: 88, min: 59 },
    { hourIdx: 6, avg: 113, max: 116, min: 111 }, // highest hour -> newest
    { hourIdx: 5, avg: 95, max: 99, min: 90 },
  ]);
  const inner = buildInner(2, 1, 1, 3, payload); // module=health, cmd=heartRate
  const frames = fragments(inner, [10, inner.length - 10]);
  for (const frame of frames) store.ingestFrame(frame);

  assert.equal(events.length, 1, "one change event per applied batch");
  const hr = store.snapshot().heartRate;
  assert.ok(hr, "heart rate populated");
  assert.equal(hr.avg, 113, "newest-by-hour record wins");
  assert.equal(hr.max, 116);
  assert.equal(store.snapshot().currentHr, 106, "frame current -> currentHr");
  assert.equal(store.snapshot().heartRateSeries.length, 3, "full day series kept");
  assert.equal(store.snapshot().spo2, null, "other metrics untouched");
});

test("deviceStatus response populates the ring battery percent", () => {
  const store = new RingHealthStore();
  const inner = buildInner(1, 0, 1, 3, new Uint8Array([97, 0, 0]));
  for (const frame of fragments(inner)) store.ingestFrame(frame);
  assert.equal(store.snapshot().batteryPercent, 97);
});

test("deviceInfo response populates the read-only ring firmware version", () => {
  const store = new RingHealthStore();
  const version = new TextEncoder().encode("2.2.8.0002");
  const data = new Uint8Array(32);
  data.set(version);
  const inner = buildInner(1, 0, 2, 3, data);
  for (const frame of fragments(inner)) store.ingestFrame(frame);
  assert.equal(store.snapshot().firmwareVersion, "2.2.8.0002");
});

test("deviceInfo push status cannot populate the firmware version", () => {
  const store = new RingHealthStore();
  const data = new Uint8Array(16);
  data.set(new TextEncoder().encode("2.2.8.0002"));
  const inner = buildInner(1, 0, 2, 2, data); // status=push, not ack
  for (const frame of fragments(inner)) store.ingestFrame(frame);
  assert.equal(store.snapshot().firmwareVersion, null);
});

test("confirmed activity push populates steps and ring-native calorie totals", () => {
  const store = new RingHealthStore(() => 1_787_224_000_000);
  const dayBaseSec = 1_787_180_400;
  const data = activityPayload(60, dayBaseSec, [
    { slot: 67, steps: 5, activeCalories: 5, totalCalories: 23 },
    { slot: 68, steps: 18, activeCalories: 5, totalCalories: 17 },
  ]);
  const inner = buildInner(2, 5, 1, 2, data);
  for (const frame of fragments(inner)) store.ingestFrame(frame);
  assert.deepEqual(store.snapshot().activity, {
    slots: [
      { slot: 67, timestampSec: dayBaseSec + 67 * 600, steps: 5, activeCalories: 5, totalCalories: 23, restingCalories: 18 },
      { slot: 68, timestampSec: dayBaseSec + 68 * 600, steps: 18, activeCalories: 5, totalCalories: 17, restingCalories: 12 },
    ],
    dayBaseSec,
    timezoneOffsetMinutes: 60,
    totalSteps: 23,
    activeCalories: 10,
    totalCalories: 40,
    restingCalories: 30,
  });
});

test("activity ACK status cannot populate native totals", () => {
  const store = new RingHealthStore();
  const data = activityPayload(60, 1_787_180_400, [
    { slot: 71, steps: 1, activeCalories: 3, totalCalories: 15 },
  ]);
  for (const frame of fragments(buildInner(2, 5, 1, 3, data))) store.ingestFrame(frame);
  assert.equal(store.snapshot().activity, null);
});

test("activity pushes merge by day and replace duplicate slots", () => {
  const store = new RingHealthStore(() => 1_787_224_000_000);
  const dayBaseSec = 1_787_180_400;
  const ingest = (records) => {
    const data = activityPayload(60, dayBaseSec, records);
    for (const frame of fragments(buildInner(2, 5, 1, 2, data))) store.ingestFrame(frame);
  };
  ingest([{ slot: 71, steps: 0, activeCalories: 3, totalCalories: 15 }]);
  ingest([
    { slot: 71, steps: 2, activeCalories: 4, totalCalories: 16 },
    { slot: 72, steps: 9, activeCalories: 6, totalCalories: 19 },
  ]);
  assert.deepEqual(store.snapshot().activity, {
    slots: [
      { slot: 71, timestampSec: dayBaseSec + 71 * 600, steps: 2, activeCalories: 4, totalCalories: 16, restingCalories: 12 },
      { slot: 72, timestampSec: dayBaseSec + 72 * 600, steps: 9, activeCalories: 6, totalCalories: 19, restingCalories: 13 },
    ],
    dayBaseSec,
    timezoneOffsetMinutes: 60,
    totalSteps: 11,
    activeCalories: 10,
    totalCalories: 35,
    restingCalories: 25,
  });
});

test("activity push without a day base remains gated off", () => {
  const store = new RingHealthStore();
  const data = activityPayload(0, 0, [{ slot: 19, steps: 5, activeCalories: 5, totalCalories: 23 }]);
  for (const frame of fragments(buildInner(2, 5, 1, 2, data))) store.ingestFrame(frame);
  assert.equal(store.snapshot().activity, null);
});

test("activity ingestion rejects non-daily, bad-inner-CRC, and non-current-day frames", () => {
  const nowMs = 1_787_224_000_000;
  const store = new RingHealthStore(() => nowMs);
  const currentBase = 1_787_180_400;
  const data = activityPayload(60, currentBase, [{ slot: 71, steps: 5, activeCalories: 3, totalCalories: 15 }]);
  for (const frame of fragments(buildInner(2, 5, 2, 2, data))) store.ingestFrame(frame);
  assert.equal(store.snapshot().activity, null, "point subcommand rejected");

  const badCrcInner = buildInner(2, 5, 1, 2, data);
  badCrcInner[10] ^= 0xff;
  for (const frame of fragments(badCrcInner)) store.ingestFrame(frame);
  assert.equal(store.snapshot().activity, null, "bad inner CRC rejected");

  const future = activityPayload(60, currentBase + 86400, [{ slot: 71, steps: 5, activeCalories: 3, totalCalories: 15 }]);
  for (const frame of fragments(buildInner(2, 5, 1, 2, future))) store.ingestFrame(frame);
  assert.equal(store.snapshot().activity, null, "future day rejected");

  const stale = activityPayload(60, currentBase - 86400, [{ slot: 71, steps: 5, activeCalories: 3, totalCalories: 15 }]);
  for (const frame of fragments(buildInner(2, 5, 1, 2, stale))) store.ingestFrame(frame);
  assert.equal(store.snapshot().activity, null, "stale day rejected");
});

test("persisted activity is deduplicated and all derived fields are rebuilt", () => {
  const nowMs = 1_787_224_000_000;
  const base = 1_787_180_400;
  const canonical = canonicalizeActivitySnapshot({
    dayBaseSec: base,
    timezoneOffsetMinutes: 60,
    slots: [
      { slot: 71, timestampSec: 1, steps: 2, activeCalories: 3, totalCalories: 15, restingCalories: 999 },
      { slot: 71, timestampSec: 2, steps: 5, activeCalories: 4, totalCalories: 16, restingCalories: 999 },
    ],
  }, nowMs);
  assert.deepEqual(canonical, {
    dayBaseSec: base,
    timezoneOffsetMinutes: 60,
    slots: [{ slot: 71, timestampSec: base + 71 * 600, steps: 5, activeCalories: 4, totalCalories: 16, restingCalories: 12 }],
    totalSteps: 5,
    activeCalories: 4,
    totalCalories: 16,
    restingCalories: 12,
  });
});

test("interleaved batches both decode", () => {
  const store = new RingHealthStore();
  const hrFrames = fragments(buildInner(2, 1, 1, 3, dailyHealth(70, [{ hourIdx: 10, avg: 70, max: 75, min: 65 }])), null);
  const spo2Inner = buildInner(2, 2, 1, 3, dailyHealth(98, [{ hourIdx: 20, avg: 98, max: 99, min: 96 }]));
  const spo2Frames = fragments(spo2Inner, [6, spo2Inner.length - 6]);
  // spo2 head, then the whole hr batch, then the spo2 tail.
  store.ingestFrame(spo2Frames[0]);
  for (const frame of hrFrames) store.ingestFrame(frame);
  store.ingestFrame(spo2Frames[1]);
  assert.equal(store.snapshot().heartRate?.avg, 70);
  assert.equal(store.snapshot().spo2?.avg, 98);
});

test("garbage, unknown metrics and CRC mismatches are dropped without throwing", () => {
  const store = new RingHealthStore();
  const logs = [];
  store.setLog((line) => logs.push(line));

  store.ingestFrame(new Uint8Array([1, 2])); // too short for a fragment header
  assert.ok(logs.some((l) => l.includes("bad fragment")), "short frame logged");

  // sleep (cmd 6) has no decoded layout: reassembles fine, then is ignored.
  const sleep = fragments(buildInner(2, 6, 1, 3, new Uint8Array([1, 60, 0, 0, 0, 0, 0])));
  for (const frame of sleep) store.ingestFrame(frame);

  // Corrupt a payload byte after computing the batch id: CRC must reject it.
  const inner = buildInner(2, 1, 1, 3, dailyHealth(60, [{ hourIdx: 5, avg: 60, max: 65, min: 55 }]));
  const [frame] = fragments(inner);
  frame[frame.length - 1] ^= 0xff;
  store.ingestFrame(frame);
  assert.ok(logs.some((l) => l.includes("dropped")), "CRC mismatch logged");

  assert.equal(store.snapshot().heartRate, null);
  assert.equal(store.snapshot().updatedAtMs, null, "nothing applied");
});

test("reset clears decoded values and emits", () => {
  const store = new RingHealthStore();
  for (const frame of fragments(buildInner(1, 0, 1, 3, new Uint8Array([50])))) {
    store.ingestFrame(frame);
  }
  assert.equal(store.snapshot().batteryPercent, 50);
  let emitted = null;
  store.onChange((snapshot) => (emitted = snapshot));
  store.reset();
  assert.equal(store.snapshot().batteryPercent, null);
  assert.ok(emitted, "reset notifies listeners");
});
