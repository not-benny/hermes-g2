/**
 * Heart-rate-based calorie (energy expenditure) estimation. The R1 ring does not
 * give us a decoded calories value, so this ESTIMATES it from heart rate using
 * the Keytel et al. (2005) regression, which predicts energy expenditure from
 * HR + age + weight + sex. It is an approximation (best in the exercise HR range
 * ~74-150 bpm) and is clearly labelled as an estimate in the UI.
 *
 * Pure (no imports beyond types) so it is unit-tested directly. The persisted
 * user profile lives in app/native/calorie-profile.ts.
 */

export type Sex = "male" | "female";

export interface CalorieProfile {
  weightKg: number;
  ageYears: number;
  sex: Sex;
}

/**
 * Keytel energy expenditure at a heart rate, in kcal per minute (clamped to >=0;
 * the regression can go slightly negative at low HR / light weight). Coefficients
 * give kJ/min; divide by 4.184 for kcal.
 */
export function kcalPerMinute(hrBpm: number, p: CalorieProfile): number {
  const kJ =
    p.sex === "female"
      ? -20.4022 + 0.4472 * hrBpm - 0.1263 * p.weightKg + 0.074 * p.ageYears
      : -55.0969 + 0.6309 * hrBpm + 0.1988 * p.weightKg + 0.2017 * p.ageYears;
  return Math.max(0, kJ / 4.184);
}

/**
 * Estimated calories across a set of hourly average heart rates: each hour
 * contributes its average HR sustained for 60 minutes. Only hours we have HR for
 * count, so the figure grows through the day as more hours accumulate.
 */
export function estimateCaloriesFromHours(hours: Array<{ avg: number }>, p: CalorieProfile): number {
  return Math.round(hours.reduce((sum, h) => sum + kcalPerMinute(h.avg, p) * 60, 0));
}
