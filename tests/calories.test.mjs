import assert from "node:assert/strict";
import test from "node:test";

import { kcalPerMinute, estimateCaloriesFromHours } from "../app/health/calories.ts";

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

test("estimateCaloriesFromHours sums each hour as 60 minutes at its avg HR", () => {
  const perMin = kcalPerMinute(120, MALE);
  const twoHours = estimateCaloriesFromHours([{ avg: 120 }, { avg: 120 }], MALE);
  assert.equal(twoHours, Math.round(perMin * 60 * 2));
  assert.equal(estimateCaloriesFromHours([], MALE), 0);
});
