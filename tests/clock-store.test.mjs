import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

process.env.TZ = "UTC";

const transpile = (source) => ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const dataUrl = (source) => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const nativeStubUrl = dataUrl(`
  export const getStringSetting = (_key, fallback) => fallback;
  export const hasStoredSecretSetting = () => false;
  export const onSettingsStoreChanged = () => () => {};
  export const removeSecretSetting = () => {};
  export const setStringSetting = () => {};
`);
const source = transpile(readFileSync(new URL("../app/clock/store.ts", import.meta.url), "utf8"))
  .replace('"../native/settings-store"', JSON.stringify(nativeStubUrl));
const {
  CLOCK_STORAGE_KEY,
  MAX_TIMER_DURATION_SECONDS,
  ClockStore,
  ClockStoreError,
  decodeClockDocument,
  nextAlarmFireAt,
  normalizeClockLabel,
  normalizeRepeatDays,
} = await import(dataUrl(source));

const sha256 = (value) => createHash("sha256").update(value, "utf8").digest("hex");

function setup(options = {}) {
  let encoded = options.encoded ?? "";
  let present = options.present ?? Boolean(encoded);
  let now = options.now ?? Date.UTC(2026, 7, 24, 8, 0, 0);
  let saveFails = options.saveFails ?? false;
  let changeListener = null;
  let itemSerial = 0;
  let occurrenceSerial = 0;
  const writes = [];
  const persistence = {
    hasStoredValue: () => present,
    load: () => encoded,
    save: (value) => {
      if (saveFails) throw new Error("synthetic encrypted write failure");
      writes.push(value);
      encoded = value;
      present = true;
    },
    purge: () => { encoded = ""; present = false; },
    subscribe: (listener) => {
      changeListener = listener;
      return () => { if (changeListener === listener) changeListener = null; };
    },
  };
  const dependencies = {
    persistence,
    digest: sha256,
    createItemId: () => `clk_${String(++itemSerial).padStart(32, "0")}`,
    createOccurrenceId: () => `occ_${String(++occurrenceSerial).padStart(32, "0")}`,
    now: () => now,
    isValidTimeZone: (value) => ["UTC", "Europe/London", "America/New_York", "Asia/Tokyo"].includes(value),
  };
  const store = new ClockStore(dependencies);
  return {
    store,
    dependencies,
    writes,
    encoded: () => encoded,
    setNow: (value) => { now = value; },
    setSaveFails: (value) => { saveFails = value; },
    replaceStored: (value, isPresent = Boolean(value)) => {
      encoded = value;
      present = isPresent;
      changeListener?.();
    },
  };
}

test("Clock uses the encrypted v1 key and timer commits precede observable state", () => {
  assert.equal(CLOCK_STORAGE_KEY, "clock.store.v1");
  let store;
  let encoded = "";
  const observedDuringCommit = [];
  store = new ClockStore({
    persistence: {
      hasStoredValue: () => Boolean(encoded),
      load: () => encoded,
      save: (value) => { observedDuringCommit.push(store.snapshot()); encoded = value; },
      purge: () => { encoded = ""; },
    },
    digest: sha256,
    createItemId: () => "clk_0123456789abcdef0123456789abcdef",
    createOccurrenceId: () => "occ_0123456789abcdef0123456789abcdef",
    now: () => 1_800_000_000_000,
  });
  const emissions = [];
  store.onChange((snapshot) => emissions.push(snapshot));
  const receipt = store.setTimer({ operationId: "voice.timer-1", durationSeconds: 90, label: "Tea" });
  assert.deepEqual(receipt, {
    status: "acknowledged",
    operation_id: "voice.timer-1",
    item_id: "clk_0123456789abcdef0123456789abcdef",
    kind: "timer",
    next_fire_at_ms: 1_800_000_090_000,
    clock_revision: 1,
    duration_seconds: 90,
  });
  assert.equal(observedDuringCommit[0].revision, 0);
  assert.equal(emissions.length, 1);
  assert.equal(emissions[0].timers[0].label, "Tea");
  assert.ok(decodeClockDocument(encoded));
});

test("hashed operation tombstones give immutable historical acknowledgements and detect conflicts", () => {
  const state = setup();
  const first = state.store.setTimer({ operationId: "stable.timer", durationSeconds: 300, label: "Pasta" });
  state.store.deleteTimer(first.item_id);
  const retry = state.store.setTimer({ operationId: "stable.timer", durationSeconds: 300, label: "Pasta" });
  assert.deepEqual(retry, { ...first, status: "historical_acknowledgement" });
  assert.throws(
    () => state.store.setTimer({ operationId: "stable.timer", durationSeconds: 301, label: "Pasta" }),
    (error) => error instanceof ClockStoreError && error.code === "operation_conflict",
  );
  const raw = JSON.parse(state.encoded());
  assert.equal(raw.operations[0].operationHash, sha256("stable.timer"));
  assert.equal(JSON.stringify(raw).includes("stable.timer"), false);
  assert.equal(state.writes.length, 2, "historical replay and conflict do not rewrite storage");
});

test("alarm requests normalize repeat order and preserve exact replay after time moves", () => {
  const state = setup({ now: Date.UTC(2026, 7, 24, 8, 0) }); // Monday
  const first = state.store.setAlarm({
    operationId: "alarm.weekdays",
    localTime: "08:30",
    repeatDays: ["fri", "mon", "wed"],
    label: "Stand-up",
  });
  assert.deepEqual(first, {
    status: "acknowledged",
    operation_id: "alarm.weekdays",
    item_id: "clk_00000000000000000000000000000001",
    kind: "alarm",
    next_fire_at_ms: Date.UTC(2026, 7, 24, 8, 30),
    clock_revision: 1,
    local_time: "08:30",
    date: null,
    repeat_days: ["mon", "wed", "fri"],
  });
  state.setNow(Date.UTC(2027, 0, 1));
  assert.deepEqual(
    state.store.setAlarm({
      operationId: "alarm.weekdays",
      localTime: "08:30",
      repeatDays: ["wed", "fri", "mon"],
      label: "Stand-up",
    }),
    { ...first, status: "historical_acknowledgement" },
  );
});

test("one-shot and repeating local wall alarms resolve strictly into the future", () => {
  const now = Date.UTC(2026, 7, 24, 8, 30); // Monday
  assert.deepEqual(nextAlarmFireAt("08:30", null, [], now), {
    nextFireAtMs: Date.UTC(2026, 7, 25, 8, 30),
    date: "2026-08-25",
    repeatDays: [],
  });
  assert.deepEqual(nextAlarmFireAt("08:31", undefined, ["fri", "mon"], now), {
    nextFireAtMs: Date.UTC(2026, 7, 24, 8, 31),
    date: null,
    repeatDays: ["mon", "fri"],
  });
  assert.throws(() => nextAlarmFireAt("08:31", "2026-08-24", ["mon"], now), (error) => error.code === "invalid_schedule");
  assert.throws(() => nextAlarmFireAt("08:29", "2026-08-24", [], now), (error) => error.code === "invalid_schedule");
});

test("reconcileDue atomically records pending occurrences, finishes one-shots, and rearms repeats", () => {
  const start = Date.UTC(2026, 7, 24, 8, 0); // Monday
  const state = setup({ now: start });
  state.store.setTimer({ operationId: "timer.same-minute", durationSeconds: 60 });
  state.store.setAlarm({ operationId: "alarm.same-minute", localTime: "08:01", repeatDays: ["mon"] });
  const next = state.store.nextDue();
  assert.equal(next.nextFireAtMs, start + 60_000);
  assert.equal(state.store.scheduledItems().length, 2);
  const writesBefore = state.writes.length;
  const occurrences = state.store.reconcileDue(start + 60_000);
  assert.equal(state.writes.length, writesBefore + 1, "all due transitions use one durable commit");
  assert.equal(occurrences.length, 2);
  assert.ok(occurrences.every((item) => item.status === "pending" && item.wasOffHead === null));
  const snapshot = state.store.snapshot();
  assert.equal(snapshot.timers[0].state, "finished");
  assert.equal(snapshot.timers[0].nextFireAtMs, null);
  assert.equal(snapshot.alarms[0].enabled, true);
  assert.equal(snapshot.alarms[0].nextFireAtMs, Date.UTC(2026, 7, 31, 8, 1));
  assert.deepEqual(state.store.reconcileDue(start + 60_000), [], "same firing cannot be duplicated");
});

test("silent occurrence state is durable and distinct from terminal dismissal", () => {
  const start = Date.UTC(2026, 7, 24, 8, 0);
  const state = setup({ now: start });
  state.store.setTimer({ operationId: "timer.missed", durationSeconds: 1 });
  const [occurrence] = state.store.reconcileDue(start + 1_000);
  const silent = state.store.markOccurrenceSilent(occurrence.id, true);
  assert.equal(silent.status, "silent");
  assert.equal(silent.wasOffHead, true);
  const reloaded = new ClockStore(state.dependencies);
  assert.deepEqual(reloaded.snapshot().occurrences, [silent]);
  reloaded.dismissOccurrence(silent.id);
  assert.deepEqual(reloaded.snapshot().occurrences, []);
  assert.equal(reloaded.snapshot().timers[0].state, "finished", "dismissal retains timer history");
});

test("a forward wall-clock jump records a crossed one-shot instead of postponing it", () => {
  const start = Date.UTC(2026, 7, 24, 8, 0);
  const state = setup({ now: start });
  const alarm = state.store.setAlarm({ operationId: "alarm.clock-jump", localTime: "09:00" });
  const writesBefore = state.writes.length;
  const [occurrence] = state.store.reconcileWallClockSchedules(Date.UTC(2026, 7, 24, 10, 0));
  assert.equal(state.writes.length, writesBefore + 1);
  assert.equal(occurrence.itemId, alarm.item_id);
  assert.equal(occurrence.dueAtMs, Date.UTC(2026, 7, 24, 9, 0));
  assert.equal(occurrence.status, "pending");
  assert.equal(state.store.snapshot().alarms[0].enabled, false);
  assert.equal(state.store.snapshot().alarms[0].nextFireAtMs, null);
});

test("native elapsed deadlines immunize timers from wall jumps and native fire is exact", () => {
  const start = Date.UTC(2026, 7, 24, 8, 0);
  const state = setup({ now: start });
  const receipt = state.store.setTimer({ operationId: "timer.monotonic", durationSeconds: 120 });
  // A TIME_SET forward to noon still leaves the native elapsed timer with 90s.
  const jumpedWall = start + 4 * 60 * 60 * 1000;
  state.store.reconcileElapsedTimerSchedules([
    { itemId: receipt.item_id, nextFireAtMs: jumpedWall + 90_000, scheduleGeneration: 1 },
  ], jumpedWall);
  assert.equal(state.store.snapshot().timers[0].remainingSeconds, 90);
  const stableWrites = state.writes.length;
  state.store.reconcileElapsedTimerSchedules([
    { itemId: receipt.item_id, nextFireAtMs: jumpedWall + 90_500, scheduleGeneration: 1 },
  ], jumpedWall + 500);
  assert.equal(state.writes.length, stableWrites,
    "millisecond sampling skew cannot create an onChange/reconciliation loop");
  assert.deepEqual(state.store.reconcileDue(jumpedWall + 89_999), []);
  const occurrence = state.store.reconcileNativeFire({
    itemId: receipt.item_id,
    kind: "timer",
    dueAtMs: jumpedWall + 90_000,
    scheduleGeneration: 1,
  }, jumpedWall + 90_000);
  assert.equal(occurrence.dueAtMs, jumpedWall + 90_000);
  assert.equal(state.store.snapshot().timers[0].state, "finished");
  assert.deepEqual(
    state.store.reconcileNativeFire({
      itemId: receipt.item_id,
      kind: "timer",
      dueAtMs: jumpedWall + 90_000,
      scheduleGeneration: 1,
    }, jumpedWall + 90_001),
    occurrence,
    "a replayed durable native edge is idempotent",
  );
});

test("a persisted old native fire cannot finish a restarted timer or re-enabled alarm", () => {
  const start = Date.UTC(2026, 7, 24, 8, 0);
  const state = setup({ now: start });
  const timer = state.store.setTimer({ operationId: "timer.generation", durationSeconds: 60 });
  const oldTimerFire = {
    itemId: timer.item_id,
    kind: "timer",
    dueAtMs: timer.next_fire_at_ms,
    scheduleGeneration: 1,
  };
  state.setNow(start + 60_000);
  const restarted = state.store.restartTimer(timer.item_id);
  assert.equal(restarted.scheduleGeneration, 2);
  state.store.reconcileElapsedTimerSchedules([{
    itemId: timer.item_id,
    nextFireAtMs: oldTimerFire.dueAtMs,
    scheduleGeneration: 1,
  }], start + 60_000);
  assert.equal(state.store.snapshot().timers[0].nextFireAtMs, restarted.nextFireAtMs,
    "a failed native sync cannot roll the authoritative restart back to its old generation");
  assert.equal(state.store.reconcileNativeFire(oldTimerFire, start + 60_001), null);
  assert.equal(state.store.snapshot().timers[0].state, "running");

  const alarm = state.store.setAlarm({ operationId: "alarm.generation", localTime: "09:30" });
  const oldAlarmFire = {
    itemId: alarm.item_id,
    kind: "alarm",
    dueAtMs: alarm.next_fire_at_ms,
    scheduleGeneration: 1,
  };
  state.store.setAlarmEnabled(alarm.item_id, false);
  const reenabled = state.store.setAlarmEnabled(alarm.item_id, true);
  assert.equal(reenabled.scheduleGeneration, 2);
  assert.equal(state.store.reconcileNativeFire(oldAlarmFire, start + 60_002), null);
  assert.equal(state.store.snapshot().alarms[0].enabled, true);
});

test("timer pause, resume, restart and failed saves preserve durable state", () => {
  const start = Date.UTC(2026, 7, 24, 8, 0);
  const state = setup({ now: start });
  const receipt = state.store.setTimer({ operationId: "timer.lifecycle", durationSeconds: 120 });
  state.setNow(start + 30_500);
  assert.equal(state.store.pauseTimer(receipt.item_id).remainingSeconds, 90);
  state.setNow(start + 60_000);
  assert.equal(state.store.resumeTimer(receipt.item_id).nextFireAtMs, start + 150_000);
  assert.equal(state.store.restartTimer(receipt.item_id).nextFireAtMs, start + 180_000);
  state.setSaveFails(true);
  const before = state.store.snapshot();
  assert.throws(() => state.store.pauseTimer(receipt.item_id), (error) => error.code === "persistence_failed");
  assert.deepEqual(state.store.snapshot(), before);
});

test("alarm enable/disable and world clocks are durable ring-GUI mutations", () => {
  const state = setup();
  const alarm = state.store.setAlarm({ operationId: "alarm.once", localTime: "09:00" });
  state.store.setAlarmEnabled(alarm.item_id, false);
  assert.equal(state.store.snapshot().alarms[0].nextFireAtMs, null);
  state.store.setAlarmEnabled(alarm.item_id, true);
  assert.equal(state.store.snapshot().alarms[0].enabled, true);
  const london = state.store.addWorldClock({ timeZone: "Europe/London", label: "Home" });
  const tokyo = state.store.addWorldClock({ timeZone: "Asia/Tokyo" });
  assert.equal(tokyo.label, "Tokyo");
  assert.throws(() => state.store.addWorldClock({ timeZone: "Asia/Tokyo" }), (error) => error.code === "invalid_time_zone");
  assert.throws(() => state.store.addWorldClock({ timeZone: "Mars/Olympus" }), (error) => error.code === "invalid_time_zone");
  state.store.removeWorldClock(london.id);
  assert.deepEqual(state.store.snapshot().worldClocks.map((item) => item.timeZone), ["Asia/Tokyo"]);
});

test("bounded inert inputs and strict document decoding fail closed", () => {
  assert.equal(normalizeClockLabel("  Cafe\u0301  ", "Alarm"), "Café");
  for (const label of ["line\nbreak", "bad\u202eoverride", "😀".repeat(81)]) {
    assert.throws(() => normalizeClockLabel(label, "Alarm"), (error) => error.code === "invalid_label");
  }
  assert.throws(() => normalizeClockLabel("", "Alarm"), (error) => error.code === "invalid_label");
  assert.deepEqual(normalizeRepeatDays(["sun", "mon"]), ["mon", "sun"]);
  assert.throws(() => normalizeRepeatDays(["mon", "mon"]), (error) => error.code === "invalid_repeat_days");

  const state = setup();
  state.store.setTimer({ operationId: "timer.valid", durationSeconds: MAX_TIMER_DURATION_SECONDS });
  const valid = JSON.parse(state.encoded());
  assert.ok(decodeClockDocument(JSON.stringify(valid)));
  assert.equal(decodeClockDocument(JSON.stringify({ ...valid, hidden: true })), null);
  assert.equal(decodeClockDocument(JSON.stringify({ ...valid, timers: [valid.timers[0], valid.timers[0]] })), null);
  assert.throws(() => state.store.setTimer({ operationId: "too-long", durationSeconds: MAX_TIMER_DURATION_SECONDS + 1 }), (error) => error.code === "invalid_duration");
  assert.throws(() => state.store.setAlarm({ operationId: "empty-date", localTime: "09:00", date: "" }), (error) => error.code === "invalid_date");
});

test("unreadable encrypted state never degrades to an empty writable Clock", () => {
  const state = setup({ encoded: "{future-or-corrupt", present: true });
  assert.deepEqual(state.store.snapshot(), {
    available: false,
    revision: 0,
    timers: [],
    alarms: [],
    worldClocks: [],
    occurrences: [],
  });
  assert.throws(() => state.store.setTimer({ operationId: "blocked", durationSeconds: 1 }), (error) => error.code === "unavailable");
  assert.equal(state.writes.length, 0);
  state.store.discardUnreadableData();
  assert.equal(state.store.snapshot().available, true);
});
