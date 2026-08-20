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
 * Estimated ACTIVE calories across a set of hourly average heart rates: for each
 * hour, the energy expended ABOVE the resting-HR baseline, sustained for 60
 * minutes. Subtracting the resting rate is what makes a sedentary day read low
 * (raw Keytel EE would count basal burn too and reach ~1500+ kcal/day). Hours at
 * or below resting contribute nothing. `restingHr` falls back to the lowest
 * tracked hour, then to 60 bpm.
 */
export function estimateActiveCalories(
  hours: Array<{ avg: number }>,
  p: CalorieProfile,
  restingHr: number | null,
): number {
  if (hours.length === 0) return 0;
  const restHr = restingHr ?? Math.min(...hours.map((h) => h.avg), 60);
  const basePerMin = kcalPerMinute(restHr, p);
  return Math.round(hours.reduce((sum, h) => sum + Math.max(0, kcalPerMinute(h.avg, p) - basePerMin) * 60, 0));
}
