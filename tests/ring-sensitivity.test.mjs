import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const read = (path) =>
  readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const source = read("app/ui/ring-sensitivity.ts");
const js = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText;
const curve = await import(
  `data:text/javascript;base64,${Buffer.from(js).toString("base64")}`
);

const shell = read("app/ui/shell/shell.ts");
const throttleStart = shell.indexOf("private shouldDiscardThrottledScroll");
const throttleEnd = shell.indexOf("\n  /**", throttleStart);
assert.ok(throttleStart >= 0 && throttleEnd > throttleStart);
const throttleMethod = shell.slice(throttleStart, throttleEnd);
const gateSource = `
  ${source.replace(/^export /gm, "")}
  type DashboardInputEvent = { type: string };
  let nowMs = 1_000;
  let sensitivity: RingSensitivity = "4";
  const Date = { now: () => nowMs };
  const ringSensitivitySetting = { get: () => sensitivity };
  class RingGateHarness {
    reorderingWindowId: string | null = null;
    lastScrollHonoredAtMs = 0;
    ${throttleMethod}
    discard(type: string): boolean {
      return this.shouldDiscardThrottledScroll({ type });
    }
    lastHonoredAtMs(): number {
      return this.lastScrollHonoredAtMs;
    }
  }
  const setNow = (value: number) => { nowMs = value; };
  const setSensitivity = (value: RingSensitivity) => { sensitivity = value; };
  export { RingGateHarness, setNow, setSensitivity };
`;
const gateJs = ts.transpileModule(gateSource, {
  compilerOptions: {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText;
const gateRuntime = await import(
  `data:text/javascript;base64,${Buffer.from(gateJs).toString("base64")}`
);

test("ring sensitivity applies a bounded 1.25x gain to the original response curve", () => {
  assert.equal(curve.RING_SENSITIVITY_RESPONSE_GAIN, 1.25);
  assert.deepEqual(
    curve.RING_SENSITIVITY_VALUES.map(curve.ringScrollMinIntervalMs),
    [256, 176, 120, 64, 0],
  );

  for (const interval of curve.RING_SENSITIVITY_VALUES.map(
    curve.ringScrollMinIntervalMs,
  )) {
    assert.equal(Number.isInteger(interval), true);
    assert.ok(interval >= 0 && interval <= 256);
  }
});

test("every ring sensitivity level remains strictly faster than the level below it", () => {
  const intervals = curve.RING_SENSITIVITY_VALUES.map(
    curve.ringScrollMinIntervalMs,
  );
  for (let index = 1; index < intervals.length; index++) {
    assert.ok(intervals[index] < intervals[index - 1]);
  }
  assert.equal(
    intervals.at(-1),
    0,
    "level 5 must preserve the raw event stream",
  );
});

test("the existing setting identity, five levels, current default, and storage survive the gain", () => {
  const settings = read("app/ui/dashboard-settings.ts");
  const settingStart = settings.indexOf("export const ringSensitivitySetting");
  const settingEnd = settings.indexOf(
    "export function ringSensitivityLabel",
    settingStart,
  );
  const definition = settings.slice(settingStart, settingEnd);

  assert.match(definition, /id: "ring-sensitivity"/);
  assert.match(definition, /storageKey: "input\.ringSensitivity"/);
  assert.match(definition, /defaultValue: "5"/);
  assert.match(definition, /values: RING_SENSITIVITY_VALUES/);
  assert.match(
    settings,
    /export type \{ RingSensitivity \} from "\.\/ring-sensitivity"/,
  );
});

test("the shell accelerates only ordinary scroll repeats and preserves gesture safety", () => {
  const gate = new gateRuntime.RingGateHarness();

  gateRuntime.setNow(1_000);
  assert.equal(gate.discard("scroll-up"), false);
  assert.equal(gate.lastHonoredAtMs(), 1_000);

  for (const gesture of ["click", "double-click", "long-press", "wakeword"]) {
    gateRuntime.setNow(1_001);
    assert.equal(gate.discard(gesture), false, gesture);
    assert.equal(
      gate.lastHonoredAtMs(),
      1_000,
      `${gesture} must not touch scroll timing`,
    );
  }

  gateRuntime.setNow(1_063);
  assert.equal(
    gate.discard("scroll-down"),
    true,
    "level 4 rejects a repeat before 64 ms",
  );
  assert.equal(gate.lastHonoredAtMs(), 1_000);
  gateRuntime.setNow(1_064);
  assert.equal(
    gate.discard("scroll-down"),
    false,
    "the 64 ms boundary is accepted",
  );
  assert.equal(gate.lastHonoredAtMs(), 1_064);

  gate.reorderingWindowId = "moving";
  gateRuntime.setNow(1_065);
  assert.equal(
    gate.discard("scroll-up"),
    false,
    "reorder steps bypass repeat filtering",
  );
  assert.equal(gate.lastHonoredAtMs(), 1_064);

  gate.reorderingWindowId = null;
  gateRuntime.setSensitivity("5");
  assert.equal(
    gate.discard("scroll-up"),
    false,
    "level 5 preserves every physical scroll",
  );
  assert.equal(gate.lastHonoredAtMs(), 1_064);
});
