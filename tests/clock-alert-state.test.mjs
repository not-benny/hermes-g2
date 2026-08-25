import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const dataModule = async (source) => {
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`);
};

const state = await dataModule(read("app/clock/alert-state.ts"));
const {
  ClockAlertTimeline,
  CLOCK_ALERT_LOW_MS,
  CLOCK_ALERT_WORN_TOTAL_MS,
  CLOCK_ALERT_OFF_HEAD_TOTAL_MS,
} = state;

const occurrence = (id, dueAtMs = 1_000) => ({
  id,
  itemId: `item-${id}`,
  kind: "timer",
  label: id,
  dueAtMs,
});

test("worn Clock campaign is exactly one minute low then one minute high", () => {
  const timeline = new ClockAlertTimeline();
  timeline.add(occurrence("worn"), "worn");
  assert.equal(timeline.project(1_000).phase, "low");
  assert.equal(timeline.project(1_000 + CLOCK_ALERT_LOW_MS - 1).phase, "low");
  assert.equal(timeline.project(1_000 + CLOCK_ALERT_LOW_MS).phase, "high");
  const terminal = timeline.project(1_000 + CLOCK_ALERT_WORN_TOTAL_MS);
  assert.equal(terminal.phase, "idle");
  assert.deepEqual(terminal.expired.map((entry) => entry.id), ["worn"]);
});

test("off-head and unknown route fail-safe through two high minutes", () => {
  for (const wear of ["not-worn", "unknown"]) {
    const timeline = new ClockAlertTimeline();
    timeline.add(occurrence(wear), wear);
    assert.equal(timeline.project(1_000 + CLOCK_ALERT_WORN_TOTAL_MS).phase, "high", wear);
    assert.equal(timeline.project(1_000 + CLOCK_ALERT_OFF_HEAD_TOTAL_MS).phase, "idle", wear);
  }
});

test("unknown to worn is classification while confirmed removal extends campaign", () => {
  const unknown = new ClockAlertTimeline();
  unknown.add(occurrence("unknown"), "unknown");
  unknown.setWearState("worn");
  assert.equal(unknown.entriesSnapshot()[0].confirmedOffHead, false);
  assert.equal(unknown.project(1_000 + CLOCK_ALERT_WORN_TOTAL_MS).phase, "idle");

  const removed = new ClockAlertTimeline();
  removed.add(occurrence("removed"), "worn");
  removed.setWearState("not-worn");
  assert.equal(removed.entriesSnapshot()[0].confirmedOffHead, true);
  assert.equal(removed.project(1_000 + CLOCK_ALERT_WORN_TOTAL_MS).phase, "high");
});

test("concurrent occurrences aggregate loudest phase without restarting old deadline", () => {
  const timeline = new ClockAlertTimeline();
  timeline.add(occurrence("old", 1_000), "worn");
  timeline.add(occurrence("new", 50_000), "worn");
  const projection = timeline.project(70_000);
  assert.equal(projection.phase, "high");
  assert.deepEqual(projection.active.map((entry) => entry.id).sort(), ["new", "old"]);
  assert.equal(projection.nextTransitionAtMs, 110_000,
    "new low-to-high boundary wins without extending old +120 s deadline");
});

test("Clock firmware phrases are bounded to 48 steps and exactly one minute", async () => {
  let soundEffects = read("app/ui/sound-effects.ts");
  soundEffects = soundEffects.slice(0, soundEffects.indexOf("// ============================ musical helpers"));
  const alertSound = read("app/clock/alert-sound.ts")
    .replace(/import[\s\S]*?from "\.\.\/ui\/sound-effects";\n/, "");
  const sound = await dataModule(`${soundEffects}\n${alertSound}`);
  for (const intensity of ["low", "high"]) {
    const steps = sound.clockAlertSteps(intensity);
    assert.equal(steps.length, 48);
    assert.equal(steps.reduce((sum, step) => sum + step.ms, 0), 60_000);
    const payload = sound.buildClockAlertPayload(intensity);
    assert.equal(payload.length, 3 + 48 * 5);
    assert.deepEqual(Array.from(payload.slice(0, 3)), [5, 4, 48]);
  }
  assert.ok(sound.clockAlertSteps("low")[0].duty < sound.clockAlertSteps("high")[0].duty);
  assert.deepEqual(Array.from(sound.CLOCK_ALERT_STOP_PAYLOAD), [5, 2, 0]);
});

test("a campaign consumes no duration until accepted and preserves a late phrase", () => {
  const timeline = new ClockAlertTimeline();
  timeline.add(occurrence("accepted", 1_000), "worn", null);
  assert.equal(timeline.project(40_000).phase, "low");
  assert.equal(timeline.project(200_000).phase, "low", "session preparation cannot consume audio time");
  assert.deepEqual(timeline.startPending(200_000), ["accepted"]);
  assert.equal(timeline.project(259_999).phase, "low");
  assert.equal(timeline.project(260_000).phase, "high");
  timeline.shiftStarted(["accepted"], 5_000);
  assert.equal(timeline.project(320_000).phase, "high");
  assert.equal(timeline.project(325_000).phase, "idle");
});

test("confirmed off-head routing survives restart between firmware phrases", () => {
  const live = new ClockAlertTimeline();
  live.add(occurrence("restart-route", 1_000), "unknown", 2_000);
  live.setWearState("not-worn");
  const persisted = live.entriesSnapshot()[0];
  assert.equal(persisted.confirmedOffHead, true);
  assert.equal(persisted.extendedForOffHead, true);

  const restored = new ClockAlertTimeline();
  restored.add(occurrence("restart-route", 1_000), "unknown", persisted.startedAtMs);
  restored.restoreRouting(
    persisted.id,
    persisted.extendedForOffHead,
    persisted.confirmedOffHead,
  );
  assert.equal(restored.entriesSnapshot()[0].confirmedOffHead, true,
    "fresh ON_HEAD handling can still recognize a real put-on edge after process death");
});

test("initial worn classification survives restart after an unknown first ACK", () => {
  const live = new ClockAlertTimeline();
  live.add(occurrence("worn-route", 1_000), "unknown", 2_000);
  live.setWearState("worn");
  const persisted = live.entriesSnapshot()[0];
  assert.equal(persisted.confirmedOffHead, false);
  assert.equal(persisted.extendedForOffHead, false);

  const restored = new ClockAlertTimeline();
  restored.add(occurrence("worn-route", 1_000), "unknown", persisted.startedAtMs);
  restored.restoreRouting(persisted.id, persisted.extendedForOffHead, persisted.confirmedOffHead);
  assert.equal(restored.project(2_000 + CLOCK_ALERT_WORN_TOTAL_MS).phase, "idle");
});

test("elapsed campaign timing rebases across forward and backward wall-clock changes", () => {
  const timeline = new ClockAlertTimeline();
  const originalWall = 10_000_000;
  timeline.add(occurrence("wall-rebase", originalWall), "worn", originalWall);

  const forwardWall = originalWall + 60 * 60 * 1000;
  timeline.restoreTiming("wall-rebase", forwardWall);
  assert.equal(timeline.project(forwardWall + 30_000).phase, "low");
  assert.equal(timeline.project(forwardWall + 60_000).phase, "high");

  const backwardWall = originalWall - 30 * 60 * 1000;
  timeline.restoreTiming("wall-rebase", backwardWall);
  assert.equal(timeline.project(backwardWall + 30_000).phase, "low",
    "the immutable pre-change dueAt cannot gate an already accepted campaign");
  assert.equal(timeline.project(backwardWall + 120_000).phase, "idle");
});
