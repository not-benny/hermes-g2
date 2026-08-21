import { Frame, Observable, SegmentedBarItem } from "@nativescript/core";

import { loadCalorieProfile, saveCalorieProfile } from "../native/calorie-profile";

/**
 * Weight / age / sex used by the HR-based calorie estimate on the Health card.
 * Kept local until Save so a half-typed weight never corrupts the estimate.
 */
export class HealthProfileViewModel extends Observable {
  private profile = loadCalorieProfile();
  private _status = "";
  private _sexItems: SegmentedBarItem[] | null = null;

  get weight(): string { return String(this.profile.weightKg); }
  set weight(value: string) {
    const n = parseFloat(value);
    if (!Number.isNaN(n) && n > 0) this.profile.weightKg = n;
  }

  get age(): string { return String(this.profile.ageYears); }
  set age(value: string) {
    const n = parseInt(value, 10);
    if (!Number.isNaN(n) && n > 0) this.profile.ageYears = n;
  }

  get sexItems(): SegmentedBarItem[] {
    if (!this._sexItems) {
      this._sexItems = ["Male", "Female"].map((label) => {
        const item = new SegmentedBarItem();
        item.title = label;
        return item;
      });
    }
    return this._sexItems;
  }
  get sexIndex(): number { return this.profile.sex === "female" ? 1 : 0; }
  set sexIndex(index: number) {
    const sex = index === 1 ? "female" : "male";
    if (sex === this.profile.sex) return;
    this.profile.sex = sex;
    this.notifyPropertyChange("sexIndex", index);
  }

  get status(): string { return this._status; }

  onSaveTap(): void {
    saveCalorieProfile(this.profile);
    this._status = "Saved. Calories on the Health card now use this profile.";
    this.notifyPropertyChange("status", this._status);
  }

  onBackTap(): void {
    Frame.topmost()?.goBack();
  }
}
