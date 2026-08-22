import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../app/motion/motion-service.ts", import.meta.url), "utf8");
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
}).outputText;
const motion = await import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));
const { MotionService, circularDelta, normalizeHeading, deriveOrientation } = motion;

function backend() {
  const calls = [];
  let imu = null;
  let compass = null;
  return {
    calls,
    source: {
      setImuEnabled(enabled, pace) { calls.push(["imu", enabled, pace]); },
      setCompassEnabled(enabled) { calls.push(["compass", enabled]); },
      onImu(listener) { imu = listener; return () => { if (imu === listener) imu = null; }; },
      onCompass(listener) { compass = listener; return () => { if (compass === listener) compass = null; }; },
    },
    imu(value) { imu?.(value); },
    compass(value) { compass?.(value); },
    staleImu() { return imu; },
    staleCompass() { return compass; },
  };
}

function store(initial = null) {
  let value = initial;
  return { load: () => value, save: (next) => { value = next; return true; }, value: () => value };
}

test("heading helpers handle wraparound deterministically", () => {
  assert.equal(normalizeHeading(-1), 359);
  assert.equal(normalizeHeading(361), 1);
  assert.equal(circularDelta(359, 1), 2);
  assert.equal(circularDelta(1, 359), -2);
});

test("orientation rejects implausible vectors and derives level posture", () => {
  assert.equal(deriveOrientation({ x: 0, y: 0, z: 0 }), null);
  assert.equal(deriveOrientation({ x: Number.NaN, y: 0, z: 1 }), null);
  const flat = deriveOrientation({ x: 0, y: 0, z: 1 });
  assert.ok(flat);
  assert.ok(Math.abs(flat.pitchDegrees) < 0.01);
  assert.ok(Math.abs(flat.rollDegrees) < 0.01);
  assert.equal(flat.level, true);
});

test("shared leases arbitrate rate and disable only after final release", () => {
  const io = backend();
  const service = new MotionService({ now: () => 1_000, persistence: store() });
  service.bind(io.source, { deviceId: "G2-A", sessionGeneration: 1 });
  service.setScreenOn(true);
  const a = service.acquire({ imuRate: "low" }, () => {});
  const b = service.acquire({ imuRate: "interactive", compass: true }, () => {});
  a.release();
  b.release();
  b.release();
  assert.deepEqual(io.calls, [
    ["imu", true, 500],
    ["imu", true, 200],
    ["compass", true],
    ["imu", false, 200],
    ["compass", false],
  ]);
});

test("screen off stops streams and screen on restores retained demand", () => {
  const io = backend();
  const service = new MotionService({ now: () => 1_000, persistence: store() });
  service.bind(io.source, { deviceId: "G2-A", sessionGeneration: 1 });
  service.setScreenOn(true);
  service.acquire({ imuRate: "low", compass: true }, () => {});
  service.setScreenOn(false);
  service.setScreenOn(true);
  assert.deepEqual(io.calls, [
    ["imu", true, 500], ["compass", true],
    ["imu", false, 500], ["compass", false],
    ["imu", true, 500], ["compass", true],
  ]);
});

test("warmed session reasserts retained demand after an early native skip", () => {
  const io = backend();
  const service = new MotionService({ now: () => 1_000, persistence: store() });
  service.bind(io.source, { deviceId: "G2-A", sessionGeneration: 1 });
  service.setScreenOn(true);
  service.acquire({ imuRate: "low", compass: true }, () => {});
  service.reassertSourceState();
  assert.deepEqual(io.calls, [
    ["imu", true, 500], ["compass", true],
    ["imu", true, 500], ["compass", true],
  ]);
});

test("callbacks from an old session and released leases are rejected", () => {
  let now = 1_000;
  const first = backend();
  const second = backend();
  const received = [];
  const service = new MotionService({ now: () => now, persistence: store() });
  service.bind(first.source, { deviceId: "G2-A", sessionGeneration: 1 });
  service.setScreenOn(true);
  const lease = service.acquire({ imuRate: "low", compass: true }, (snapshot) => received.push(snapshot));
  received.length = 0;
  const oldImu = first.staleImu();
  const oldCompass = first.staleCompass();
  service.bind(second.source, { deviceId: "G2-A", sessionGeneration: 2 });
  oldImu({ x: 0, y: 0, z: 1, source: 1 });
  oldCompass({ command: 15, headingDegrees: 10 });
  assert.equal(received.length, 0);
  second.imu({ x: 0, y: 0, z: 1, source: 1 });
  assert.equal(received.length, 1);
  lease.release();
  now += 1;
  second.imu({ x: 0, y: 0, z: 1, source: 1 });
  assert.equal(received.length, 1);
});

test("heading filtering crosses north, rejects outliers and reports interference honestly", () => {
  let now = 1_000;
  const io = backend();
  const values = [];
  const service = new MotionService({ now: () => now, persistence: store() });
  service.bind(io.source, { deviceId: "G2-A", sessionGeneration: 1 });
  service.setScreenOn(true);
  service.acquire({ compass: true }, (snapshot) => values.push(snapshot));
  for (const headingDegrees of [358, 359, 0, 1, 2]) {
    now += 100;
    io.compass({ command: 15, headingDegrees });
  }
  assert.ok(values.at(-1).headingDegrees < 10 || values.at(-1).headingDegrees > 350);
  now += 100;
  io.compass({ command: 15, headingDegrees: 200 });
  assert.notEqual(Math.round(values.at(-1).headingDegrees), 200);
  for (const headingDegrees of [170, 5, 175, 10]) {
    now += 100;
    io.compass({ command: 15, headingDegrees });
  }
  assert.equal(service.snapshot().compassQuality, "interference");
});

test("a sustained legitimate turn reacquires instead of staying interference-locked", () => {
  let now = 1_000;
  const io = backend();
  const service = new MotionService({ now: () => now, persistence: store() });
  service.bind(io.source, { deviceId: "G2-A", sessionGeneration: 1 });
  service.setScreenOn(true);
  service.acquire({ compass: true }, () => {});
  for (const headingDegrees of [0, 90, 100, 110]) {
    now += 200;
    io.compass({ command: 15, headingDegrees });
  }
  assert.ok(service.snapshot().headingDegrees > 90);
  assert.notEqual(service.snapshot().compassQuality, "interference");
});

test("calibration completion without a matching start fails closed", () => {
  let now = 10_000;
  const persisted = store();
  const io = backend();
  const service = new MotionService({ now: () => now, persistence: persisted });
  service.bind(io.source, { deviceId: "G2-A", sessionGeneration: 1 });
  service.setScreenOn(true);
  service.acquire({ imuRate: "low", compass: true }, () => {});
  for (let i = 0; i < 12; i++) {
    now += 100;
    io.imu({ x: 0, y: 0, z: 1, source: 1 });
    io.compass({ command: 15, headingDegrees: 42 + (i % 2) });
  }
  io.compass({ command: 17, headingDegrees: -1 });
  assert.equal(service.snapshot().calibrationQuality, "uncalibrated");
  assert.equal(persisted.value(), null);
});

test("calibration persistence is versioned, device-bound and stores no raw history", () => {
  let now = 10_000;
  const persisted = store();
  const io = backend();
  const first = new MotionService({ now: () => now, persistence: persisted });
  first.bind(io.source, { deviceId: "G2-A", sessionGeneration: 1 });
  first.setScreenOn(true);
  first.acquire({ imuRate: "low", compass: true }, () => {});
  io.compass({ command: 16, headingDegrees: -1 });
  for (let i = 0; i < 12; i++) {
    now += 100;
    io.imu({ x: 0, y: 0, z: 1, source: 1 });
    io.compass({ command: 15, headingDegrees: 42 + (i % 2) });
  }
  io.compass({ command: 17, headingDegrees: -1 });
  const json = JSON.stringify(persisted.value());
  assert.match(json, /"schemaVersion":1/);
  assert.match(json, /"deviceId":"G2-A"/);
  assert.doesNotMatch(json, /samples|history|readings/);

  const restarted = new MotionService({ now: () => now, persistence: persisted });
  restarted.bind(backend().source, { deviceId: "G2-A", sessionGeneration: 2 });
  assert.notEqual(restarted.snapshot().calibrationQuality, "uncalibrated");
  const otherDevice = new MotionService({ now: () => now, persistence: persisted });
  otherDevice.bind(backend().source, { deviceId: "G2-B", sessionGeneration: 1 });
  assert.equal(otherDevice.snapshot().calibrationQuality, "uncalibrated");
});

test("restart rejects future, negative, expired, and impossible calibration metadata", () => {
  const now = 200 * 24 * 60 * 60 * 1_000;
  const base = {
    schemaVersion: 1,
    algorithmVersion: "motion-v1",
    deviceId: "G2-A",
    quality: "fair",
    calibratedAtMs: now,
    neutralVector: { x: 0, y: 0, z: 1 },
    headingOffsetDegrees: 0,
  };
  for (const invalid of [
    { ...base, calibratedAtMs: -1 },
    { ...base, calibratedAtMs: now + 60_001 },
    { ...base, calibratedAtMs: 1 },
    { ...base, headingOffsetDegrees: 181 },
  ]) {
    const service = new MotionService({ now: () => now, persistence: store(invalid) });
    service.bind(backend().source, { deviceId: "G2-A", sessionGeneration: 1 });
    assert.equal(service.snapshot().calibrationQuality, "uncalibrated");
  }
});

test("persistence failure never publishes a durable calibration quality", () => {
  let now = 10_000;
  const io = backend();
  const service = new MotionService({
    now: () => now,
    persistence: { load: () => null, save: () => { throw new Error("write failed"); } },
  });
  service.bind(io.source, { deviceId: "G2-A", sessionGeneration: 1 });
  service.setScreenOn(true);
  service.acquire({ imuRate: "low", compass: true }, () => {});
  io.compass({ command: 16, headingDegrees: -1 });
  for (let i = 0; i < 12; i++) {
    now += 100;
    io.imu({ x: 0, y: 0, z: 1, source: 1 });
    io.compass({ command: 15, headingDegrees: 42 + (i % 2) });
  }
  io.compass({ command: 17, headingDegrees: -1 });
  assert.equal(service.snapshot().calibrationQuality, "poor");
});

test("stale samples are never presented as exact", () => {
  let now = 1_000;
  const io = backend();
  const service = new MotionService({ now: () => now, persistence: store() });
  service.bind(io.source, { deviceId: "G2-A", sessionGeneration: 1 });
  service.setScreenOn(true);
  service.acquire({ imuRate: "low", compass: true }, () => {});
  io.imu({ x: 0, y: 0, z: 1, source: 1 });
  io.compass({ command: 15, headingDegrees: 80 });
  now += 3_001;
  const snapshot = service.snapshot();
  assert.equal(snapshot.headingDegrees, null);
  assert.equal(snapshot.orientation, null);
  assert.equal(snapshot.state, "stale");
});
