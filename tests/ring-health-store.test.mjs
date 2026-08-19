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
const { RingHealthStore } = await import(dataUrl(storeJs));

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
  // crc16 at [10..11] is not validated by the parser; leave zero.
  inner.set(data, 12);
  return inner;
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

 * Daily payload: [count u8][interval u16 LE][base_ts u32 LE] + stride-9
 * records [ts u32][latest][hourIdx][avg][max][min].
 */
function dailyStride9(records) {
  const bytes = [records.length, 60, 0, ...u32le(1_700_000_000)];
  for (const r of records) {
    bytes.push(...u32le(r.ts), r.latest, r.hourIdx ?? 0, r.avg ?? 0, r.max ?? 0, r.min ?? 0);
  }
  return new Uint8Array(bytes);
}

// --- tests -------------------------------------------------------------------

test("heart-rate daily push decodes across fragments and picks the newest record", () => {
  const store = new RingHealthStore();
  const events = [];
  store.onChange((snapshot) => events.push(snapshot));

  const payload = dailyStride9([
    { ts: 1000, latest: 88 },
    { ts: 2000, latest: 111, avg: 113, max: 116, min: 111 },
    { ts: 1500, latest: 95 },
  ]);
  const inner = buildInner(2, 1, 1, 3, payload); // module=health, cmd=heartRate
  const frames = fragments(inner, [10, inner.length - 10]);
  for (const frame of frames) store.ingestFrame(frame);

  assert.equal(events.length, 1, "one change event per applied batch");
  const hr = store.snapshot().heartRate;
  assert.ok(hr, "heart rate populated");
  assert.equal(hr.latest, 111, "newest-by-ts record wins");
  assert.equal(hr.max, 116);
  assert.equal(store.snapshot().spo2, null, "other metrics untouched");
});

test("deviceStatus response populates the ring battery percent", () => {
  const store = new RingHealthStore();
  const inner = buildInner(1, 0, 1, 3, new Uint8Array([97, 0, 0]));
  for (const frame of fragments(inner)) store.ingestFrame(frame);
  assert.equal(store.snapshot().batteryPercent, 97);
});

test("interleaved batches both decode", () => {
  const store = new RingHealthStore();
  const hrFrames = fragments(buildInner(2, 1, 1, 3, dailyStride9([{ ts: 10, latest: 70 }])), null);
  const spo2Inner = buildInner(2, 2, 1, 3, dailyStride9([{ ts: 20, latest: 98 }]));
  const spo2Frames = fragments(spo2Inner, [6, spo2Inner.length - 6]);
  // spo2 head, then the whole hr batch, then the spo2 tail.
  store.ingestFrame(spo2Frames[0]);
  for (const frame of hrFrames) store.ingestFrame(frame);
  store.ingestFrame(spo2Frames[1]);
  assert.equal(store.snapshot().heartRate?.latest, 70);
  assert.equal(store.snapshot().spo2?.latest, 98);
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
  const inner = buildInner(2, 1, 1, 3, dailyStride9([{ ts: 5, latest: 60 }]));
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
