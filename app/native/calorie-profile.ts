/**
 * Persisted user profile (weight / age / sex) for the HR-based calorie estimate.
 * Stored in ApplicationSettings; defaults to a generic adult until the user sets
 * their own in Settings > Health profile.
 */

import { ApplicationSettings } from "@nativescript/core";

import { type CalorieProfile, type Sex } from "../health/calories";

const KEY = "health.profile.v1";
const DEFAULT: CalorieProfile = { weightKg: 75, ageYears: 30, sex: "male" };

export function loadCalorieProfile(): CalorieProfile {
  try {
    const raw = ApplicationSettings.getString(KEY, "");
    if (!raw) return { ...DEFAULT };
    const p = JSON.parse(raw) as Partial<CalorieProfile>;
    return {
      weightKg: typeof p.weightKg === "number" && p.weightKg > 0 ? p.weightKg : DEFAULT.weightKg,
      ageYears: typeof p.ageYears === "number" && p.ageYears > 0 ? p.ageYears : DEFAULT.ageYears,
      sex: p.sex === "female" ? "female" : "male",
    };
  } catch {
    return { ...DEFAULT };
  }
}

export function saveCalorieProfile(p: CalorieProfile): void {
  try {
    ApplicationSettings.setString(KEY, JSON.stringify(p));
  } catch (error) {
    console.error(`[calorie-profile] save failed: ${error}`);
  }
}

/** Whether the user has explicitly set a profile (vs the generic default). */
export function hasCalorieProfile(): boolean {
  return ApplicationSettings.getString(KEY, "").length > 0;
}

export type { CalorieProfile, Sex };
