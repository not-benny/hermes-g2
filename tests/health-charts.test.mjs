import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../app/phone-ui/health-chart-data.ts", import.meta.url), "utf8");
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
}).outputText;
const {
  clamp01,
  frac,
  hrZoneColor,
  readinessColor,
  buildHrDayBars,
  buildTrendBars,
} = await import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));

test("frac maps a value across its domain to 0..1 and clamps", () => {
  assert.equal(frac(50, 0, 100), 0.5);
  assert.equal(frac(0, 0, 100), 0);
  assert.equal(frac(100, 0, 100), 1);
  assert.equal(frac(-10, 0, 100), 0);
  assert.equal(frac(999, 0, 100), 1);
});

test("frac guards a degenerate (flat / inverted) domain", () => {
  assert.equal(frac(5, 10, 10), 0);
  assert.equal(frac(5, 10, 0), 0);
});

test("clamp01 pins to the unit interval", () => {
  assert.equal(clamp01(-0.2), 0);
  assert.equal(clamp01(1.5), 1);
  assert.equal(clamp01(0.3), 0.3);
});

test("hrZoneColor buckets bpm into rest/normal/elevated/high", () => {
  assert.equal(hrZoneColor(52), "#4C9DF5");
  assert.equal(hrZoneColor(72), "#57D8A6");
  assert.equal(hrZoneColor(120), "#F5C542");
  assert.equal(hrZoneColor(150), "#E5484D");
});

test("readinessColor matches the hero band thresholds (65 / 40)", () => {
  assert.equal(readinessColor(90), "#57D8A6");
  assert.equal(readinessColor(65), "#57D8A6");
  assert.equal(readinessColor(64), "#F5C542");
  assert.equal(readinessColor(40), "#F5C542");
  assert.equal(readinessColor(39), "#E5484D");
});

test("buildHrDayBars places each hour by hourIdx and marks the average", () => {
  const hours = [
    { hourIdx: 0, min: 58, max: 66, avg: 61 },
    { hourIdx: 12, min: 70, max: 92, avg: 80 },
    { hourIdx: 23, min: 60, max: 68, avg: 63 },
  ];
  const { bars, baselineFrac } = buildHrDayBars(hours, 59);
  assert.equal(bars.length, 3);
  assert.equal(bars[0].xFrac, 0);
  assert.equal(bars[2].xFrac, 1);
  assert.equal(bars[1].xFrac, 12 / 23);
  assert.ok(bars[1].highFrac > bars[0].highFrac);
  assert.ok(bars[1].midFrac > bars[0].midFrac);
  assert.equal(bars[1].color, "#57D8A6");
  assert.ok(baselineFrac !== null && baselineFrac >= 0 && baselineFrac <= 1);
});

test("buildHrDayBars returns nothing for an empty day", () => {
  const { bars, baselineFrac } = buildHrDayBars([], 60);
  assert.equal(bars.length, 0);
  assert.equal(baselineFrac, null);
});

test("buildTrendBars drops null days but keeps their x-slot honest", () => {
  const bars = buildTrendBars([80, null, 40, 90], readinessColor);
  assert.equal(bars.length, 3);
  assert.equal(bars[0].xFrac, 0 / 3);
  assert.equal(bars[1].xFrac, 2 / 3);
  assert.equal(bars[2].xFrac, 3 / 3);
  assert.equal(bars[0].highFrac, 0.8);
  assert.equal(bars[1].color, "#F5C542");
});

test("buildTrendBars centres a single day", () => {
  const bars = buildTrendBars([72], readinessColor);
  assert.equal(bars.length, 1);
  assert.equal(bars[0].xFrac, 0.5);
});
