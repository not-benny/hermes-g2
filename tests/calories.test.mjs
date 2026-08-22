import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../app/health/calories.ts", import.meta.url), "utf8");
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
}).outputText;
const { kcalPerMinute, estimateActiveCalories } = await import(
  "data:text/javascript;base64," + Buffer.from(js).toString("base64")
);

const MALE = { weightKg: 75, ageYears: 30, sex: "male" };
const FEMALE = { weightKg: 65, ageYears: 30, sex: "female" };

test("kcalPerMinute follows the Keytel regression (male + female)", () => {
  // Male 75kg/30, HR 120: (-55.0969 + 0.6309*120 + 0.1988*75 + 0.2017*30)/4.184
  assert.ok(Math.abs(kcalPerMinute(120, MALE) - 9.94) < 0.05);
  // Female 65kg/30, HR 120: (-20.4022 + 0.4472*120 - 0.1263*65 + 0.074*30)/4.184
  assert.ok(Math.abs(kcalPerMinute(120, FEMALE) - 6.52) < 0.05);
});

test("kcalPerMinute clamps to zero at low HR (regression can go negative)", () => {
  assert.equal(kcalPerMinute(35, { weightKg: 50, ageYears: 20, sex: "male" }), 0);
});

test("kcalPerMinute rises with heart rate", () => {
  assert.ok(kcalPerMinute(140, MALE) > kcalPerMinute(80, MALE));
});

test("estimateActiveCalories counts only burn above the resting-HR baseline", () => {
  // Two hours at 120 bpm with resting 60: each hour = (rate@120 - rate@60) * 60.
  const active = (kcalPerMinute(120, MALE) - kcalPerMinute(60, MALE)) * 60;
  assert.equal(estimateActiveCalories([{ avg: 120 }, { avg: 120 }], MALE, 60), Math.round(active * 2));
  // A sedentary hour at resting contributes ~0 (not a full basal burn).
  assert.equal(estimateActiveCalories([{ avg: 62 }], MALE, 62), 0);
  assert.equal(estimateActiveCalories([], MALE, 60), 0);
});
