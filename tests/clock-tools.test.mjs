import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const transpile = (source) => ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
}).outputText;
const dataUrl = (source) => "data:text/javascript;base64," + Buffer.from(source).toString("base64");

const storeUrl = dataUrl(`
  export class ClockStoreError extends Error {
    constructor(code) { super(code); this.code = code; }
  }
  export const clockStore = {
    setTimer() { throw new Error("default Clock store must not be used by this test"); },
    setAlarm() { throw new Error("default Clock store must not be used by this test"); },
  };
`);
const schedulerUrl = dataUrl(`
  export const clockSchedulerBridge = { sync() {} };
`);
const registryUrl = dataUrl(transpile(
  readFileSync(new URL("../app/assistant/tool-registry.ts", import.meta.url), "utf8"),
));
const handlerSource = transpile(
  readFileSync(new URL("../app/assistant/clock-handler.ts", import.meta.url), "utf8"),
).replace('"../clock/store"', JSON.stringify(storeUrl));
const handlerUrl = dataUrl(handlerSource);
const bridgeSchemasUrl = dataUrl(transpile(
  readFileSync(new URL("../app/assistant/bridge-phone-contract-schemas.ts", import.meta.url), "utf8"),
));
const toolsSource = transpile(
  readFileSync(new URL("../app/assistant/clock-tools.ts", import.meta.url), "utf8"),
)
  .replace('"../clock/store"', JSON.stringify(storeUrl))
  .replace('"../native/clock-scheduler"', JSON.stringify(schedulerUrl))
  .replace('"./clock-handler"', JSON.stringify(handlerUrl))
  .replace('"./bridge-phone-contract-schemas"', JSON.stringify(bridgeSchemasUrl))
  .replace('"./tool-registry"', JSON.stringify(registryUrl));

const { ClockStoreError } = await import(storeUrl);
const { ToolRegistry } = await import(registryUrl);
const { createClockSetAlarmHandler, createClockSetTimerHandler } = await import(handlerUrl);
const { registerClockTools } = await import(dataUrl(toolsSource));

const context = {
  caller: "mcp", proactive: false, profileId: "even-g2",
  connectionGeneration: "connection-clock-4", turnGeneration: "turn-clock-9",
};
const itemId = "clk_0123456789abcdef0123456789abcdef";
const timerArgs = { operation_id: "clock.voice-9", duration_seconds: 600, label: " Cafe\u0301 " };
const timerReceipt = {
  status: "acknowledged", operation_id: timerArgs.operation_id,
  item_id: itemId, kind: "timer", next_fire_at_ms: 1_787_664_000_000,
  clock_revision: 4, duration_seconds: timerArgs.duration_seconds,
};
const alarmArgs = {
  operation_id: "clock.voice-10", local_time: "07:30",
  repeat_days: ["fri", "mon"], label: "Work",
};
const alarmReceipt = {
  status: "acknowledged", operation_id: alarmArgs.operation_id,
  item_id: itemId, kind: "alarm", next_fire_at_ms: 1_787_664_000_000,
  clock_revision: 5, local_time: "07:30", date: null,
  repeat_days: ["mon", "fri"],
};

const withScheduler = (dependencies) => ({
  scheduledItems: () => [],
  syncScheduler: () => {},
  ...dependencies,
});

test("active even-g2 timer and alarm calls commit through the durable Clock store", () => {
  const calls = [];
  const deps = withScheduler({
    setTimer(input, guard) {
      calls.push(["timer", input]);
      assert.equal(guard(), true);
      return timerReceipt;
    },
    setAlarm(input, guard) {
      calls.push(["alarm", input]);
      assert.equal(guard(), true);
      return alarmReceipt;
    },
  });
  const timer = createClockSetTimerHandler(deps)(timerArgs, undefined, () => true, context);
  const alarm = createClockSetAlarmHandler(deps)(alarmArgs, undefined, () => true, context);

  assert.deepEqual(calls, [
    ["timer", { operationId: timerArgs.operation_id, durationSeconds: 600, label: "Café" }],
    ["alarm", {
      operationId: alarmArgs.operation_id, localTime: "07:30",
      repeatDays: ["mon", "fri"], label: "Work",
    }],
  ]);
  assert.deepEqual(JSON.parse(timer.content), timerReceipt);
  assert.deepEqual(JSON.parse(alarm.content), alarmReceipt);
});

test("an undated one-shot alarm requires the store's concrete resolved local date", () => {
  const args = { operation_id: "clock.next-1", local_time: "22:05" };
  const receipt = {
    ...alarmReceipt, operation_id: args.operation_id, local_time: args.local_time,
    date: "2026-08-25", repeat_days: [],
  };
  const accepted = createClockSetAlarmHandler(withScheduler({
    setTimer() { throw new Error("unused"); },
    setAlarm() { return receipt; },
  }))(args, undefined, () => true, context);
  assert.equal(accepted.ok, true);

  const vague = createClockSetAlarmHandler(withScheduler({
    setTimer() { throw new Error("unused"); },
    setAlarm() { return { ...receipt, date: null }; },
  }))(args, undefined, () => true, context);
  assert.equal(vague.ok, false);
  assert.match(vague.error, /unconfirmed alarm/);
});

test("direct, proactive, unprofiled, and ownerless calls cannot schedule Clock", () => {
  let calls = 0;
  const deps = withScheduler({
    setTimer() { calls++; return timerReceipt; },
    setAlarm() { calls++; return alarmReceipt; },
  });
  for (const denied of [
    { ...context, caller: "direct" },
    { ...context, proactive: true, turnGeneration: null },
    { ...context, profileId: "custom" },
    { ...context, turnGeneration: null },
    { ...context, connectionGeneration: null },
  ]) {
    const timer = createClockSetTimerHandler(deps)(timerArgs, undefined, () => true, denied);
    const alarm = createClockSetAlarmHandler(deps)(alarmArgs, undefined, () => true, denied);
    assert.equal(timer.ok, false);
    assert.equal(alarm.ok, false);
    assert.match(timer.error, /authenticated active turn/);
  }
  assert.equal(calls, 0);
});

test("revoked calls and malformed Clock payloads fail before durable mutation", () => {
  let calls = 0;
  const deps = withScheduler({
    setTimer() { calls++; return timerReceipt; },
    setAlarm() { calls++; return alarmReceipt; },
  });
  const timerHandler = createClockSetTimerHandler(deps);
  const alarmHandler = createClockSetAlarmHandler(deps);
  const controller = new AbortController(); controller.abort();
  assert.equal(timerHandler(timerArgs, controller.signal, () => true, context).ok, false);
  assert.equal(timerHandler(timerArgs, undefined, () => false, context).ok, false);
  for (const invalid of [
    {},
    { ...timerArgs, extra: true },
    { ...timerArgs, operation_id: "bad/id" },
    { ...timerArgs, duration_seconds: 0 },
    { ...timerArgs, duration_seconds: true },
    { ...timerArgs, duration_seconds: 604801 },
    { ...timerArgs, label: "line\nbreak" },
    { ...timerArgs, label: "x".repeat(81) },
  ]) assert.equal(timerHandler(invalid, undefined, () => true, context).ok, false);
  for (const invalid of [
    {},
    { ...alarmArgs, extra: true },
    { ...alarmArgs, local_time: "7:30" },
    { ...alarmArgs, date: "2026-08-25" },
    { operation_id: "clock.bad-date", local_time: "07:30", date: "2026-02-30" },
    { operation_id: "clock.bad-days", local_time: "07:30", repeat_days: [] },
    { operation_id: "clock.bad-days", local_time: "07:30", repeat_days: ["mon", "mon"] },
    { operation_id: "clock.bad-days", local_time: "07:30", repeat_days: ["monday"] },
  ]) assert.equal(alarmHandler(invalid, undefined, () => true, context).ok, false);
  assert.equal(calls, 0);
});

test("Clock store failures stay coarse and operation conflicts remain actionable", () => {
  const timerRun = (code) => createClockSetTimerHandler(withScheduler({
    setTimer() { throw new ClockStoreError(code); },
    setAlarm() { throw new Error("unused"); },
  }))(timerArgs, undefined, () => true, context);
  assert.match(timerRun("operation_conflict").error, /already used/);
  assert.match(timerRun("capacity").error, /full/);
  assert.match(timerRun("superseded").error, /nothing was changed/);
  assert.match(timerRun("persistence_failed").error, /no success was confirmed/);
  assert.doesNotMatch(timerRun("persistence_failed").error, /Café|Cafe/);
});

test("post-commit owner loss and malformed receipts never become Clock success", () => {
  let allowed = true;
  const uncertain = createClockSetTimerHandler(withScheduler({
    setTimer() { allowed = false; return timerReceipt; },
    setAlarm() { throw new Error("unused"); },
  }))(timerArgs, undefined, () => allowed, context);
  assert.equal(uncertain.ok, false);
  assert.match(uncertain.error, /may have been scheduled/);

  for (const malformed of [
    { ...timerReceipt, item_id: "clock_bad" },
    { ...timerReceipt, duration_seconds: 601 },
    { ...timerReceipt, clock_revision: true },
    { ...timerReceipt, extra: true },
  ]) {
    const result = createClockSetTimerHandler(withScheduler({
      setTimer() { return malformed; },
      setAlarm() { throw new Error("unused"); },
    }))(timerArgs, undefined, () => true, context);
    assert.equal(result.ok, false);
    assert.match(result.error, /unconfirmed timer/);
  }
});

test("native schedule mirroring follows the durable commit and gates acknowledgement", () => {
  const scheduled = [{
    itemId, kind: "timer", label: "Timer",
    nextFireAtMs: timerReceipt.next_fire_at_ms, durationSeconds: 600,
  }];
  const order = [];
  const timer = createClockSetTimerHandler(withScheduler({
    setTimer() { order.push("encrypted-commit"); return timerReceipt; },
    setAlarm() { throw new Error("unused"); },
    scheduledItems() { order.push("snapshot"); return scheduled; },
    syncScheduler(items) {
      order.push("native-sync");
      assert.equal(items, scheduled);
    },
  }))(timerArgs, undefined, () => true, context);
  assert.equal(timer.ok, true);
  assert.deepEqual(order, ["encrypted-commit", "snapshot", "native-sync"]);

  const failureOrder = [];
  const alarm = createClockSetAlarmHandler(withScheduler({
    setTimer() { throw new Error("unused"); },
    setAlarm() { failureOrder.push("encrypted-commit"); return alarmReceipt; },
    scheduledItems() { failureOrder.push("snapshot"); return scheduled; },
    syncScheduler() {
      failureOrder.push("native-sync");
      throw new Error("native detail must stay hidden");
    },
  }))(alarmArgs, undefined, () => true, context);
  assert.equal(alarm.ok, false);
  assert.equal(alarm.content, undefined);
  assert.match(alarm.error, /may have been saved.*native scheduling was not confirmed/);
  assert.doesNotMatch(alarm.error, /native detail/);
  assert.deepEqual(failureOrder, ["encrypted-commit", "snapshot", "native-sync"]);
});

test("Clock registration is fixed, bounded, non-proactive, and window-independent", async () => {
  const registry = new ToolRegistry();
  const deps = withScheduler({
    setTimer() { return timerReceipt; },
    setAlarm() { return alarmReceipt; },
  });
  registerClockTools(registry, deps);
  registerClockTools(registry, deps);
  const specs = registry.listTools().filter((spec) => spec.name.startsWith("glasses.clock."));
  assert.deepEqual(specs.map((spec) => spec.name), [
    "glasses.clock.set_timer", "glasses.clock.set_alarm",
  ]);
  assert.ok(specs.every((spec) => spec.availability === "always"));
  assert.ok(specs.every((spec) => spec.proactive !== true));
  assert.ok(specs.every((spec) => spec.inputSchema.additionalProperties === false));
  assert.equal(specs[0].inputSchema.properties.duration_seconds.maximum, 604800);
  assert.deepEqual(specs[1].inputSchema.properties.repeat_days.items.enum,
    ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);
  assert.match(specs[0].description, /Never opens Clock/);
  assert.match(specs[1].description, /Never opens Clock/);
  assert.match(registry.preflightTool("glasses.clock.set_timer", timerArgs, { proactive: true }).error,
    /cannot be called outside a conversation/);

  const source = readFileSync(new URL("../app/assistant/clock-tools.ts", import.meta.url), "utf8");
  assert.match(source, /DashboardController should/);
  assert.doesNotMatch(source, /launchApp|timer\.set|timer\.list|timer\.cancel/);
});
