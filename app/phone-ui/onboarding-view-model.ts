import { Frame, Observable } from "@nativescript/core";

import { setOnboardingCompleted, setPreviewOnlyMode } from "./onboarding-state";
import { ensureBlePermissions, hasBlePermissions } from "../g2/android-permissions";
import { isNotificationListenerEnabled, requestNotificationListenerAccess } from "../native/notification-access";
import { isIgnoringBatteryOptimizations, requestIgnoreBatteryOptimizations } from "../native/battery-optimization";

// 1 Welcome · 2 Disclaimer · 3 How it works (Even hand-off) · 4 Permissions · 5 Firmware.
type OnboardingStep = 1 | 2 | 3 | 4 | 5;
const TOTAL_STEPS = 5;

type StepContent = {
  headline: string;
  tagline: string;
  body: string;
  primaryLabel: string;
  secondaryLabel: string;
  showLogo: boolean;
  showTagline: boolean;
  showSecondary: boolean;
  showPerms: boolean;
};

const STEP_CONTENT: Record<OnboardingStep, StepContent> = {
  1: {
    headline: "Hermes G2",
    tagline: "Hermes on your Even G2",
    body: "",
    primaryLabel: "Get started",
    secondaryLabel: "",
    showLogo: true,
    showTagline: true,
    showSecondary: false,
    showPerms: false,
  },
  2: {
    headline: "Before you continue",
    tagline: "",
    body:
      "This unofficial software provides a custom interface and functionality for the Even Realities G2 smart glasses. It is not created or supported by Even Realities. If this software somehow breaks my headset, this is not Even's fault and is not covered by the hardware's warranty. If it doesn't break my headset, using it may void the warranty anyway, at Even Realities' sole discretion. This is a development prototype and may not be relied on for anything important. It may be broken at any time by Even's software or firmware updates, and that will not be Even's fault.",
    primaryLabel: "I agree",
    secondaryLabel: "Back",
    showLogo: false,
    showTagline: false,
    showSecondary: true,
    showPerms: false,
  },
  3: {
    headline: "How Hermes works",
    tagline: "",
    body:
      "Hermes G2 is an independent add-on. It works alongside the official Even Realities app, not instead of it.\n\n" +
      "Before you start:\n" +
      "1.  Set up your G2 glasses and R1 ring in the official Even app first (pairing, firmware).\n" +
      "2.  In the Even app, disconnect the glasses: Home, select your glasses, open Connection, press Disconnect. Only one app can hold the connection at a time.\n" +
      "3.  Keep the Even app installed but leave it closed or disabled. It is still needed for ring setup and firmware updates; Hermes handles everything day to day.\n\n" +
      "You can switch back any time by reopening the Even app.",
    primaryLabel: "Next",
    secondaryLabel: "Back",
    showLogo: false,
    showTagline: false,
    showSecondary: true,
    showPerms: false,
  },
  4: {
    headline: "Permissions",
    tagline: "",
    body: "Hermes needs a few permissions to reach your glasses and mirror notifications. Grant what you can; you can change these later in Settings.",
    primaryLabel: "Continue",
    secondaryLabel: "Back",
    showLogo: false,
    showTagline: false,
    showSecondary: true,
    showPerms: true,
  },
  5: {
    headline: "Custom firmware",
    tagline: "",
    body:
      "Hermes runs on G2 glasses flashed with Hermes custom firmware.\n\n" +
      "• Flash firmware — install it now and use Hermes for real. Hermes connects to your glasses, asks for confirmation on the lens, then downloads and prepares the firmware.\n" +
      "• Preview only — explore the interface on your phone's screen; nothing is written to a headset.\n\n" +
      "Flashing replaces the official firmware and, like any firmware update, carries a risk of bricking the device. Make sure you disconnected the glasses in the Even app (previous step).",
    primaryLabel: "Flash firmware",
    secondaryLabel: "Preview only",
    showLogo: false,
    showTagline: false,
    showSecondary: true,
    showPerms: false,
  },
};

const GRANTED = "Granted";
const NEEDED = "Not granted yet";

export class OnboardingViewModel extends Observable {
  private _step: OnboardingStep = 1;

  constructor() {
    super();
    this.publish();
  }

  // --- navigation ------------------------------------------------------------
  onPrimaryTap(): void {
    if (this._step < 5) {
      this.setStep((this._step + 1) as OnboardingStep);
      return;
    }
    // Step 5 primary: begin flashing — configure device addresses, then unpair
    // the official app, then check firmware and flash.
    Frame.topmost()?.navigate({
      moduleName: "phone-ui/config-page",
      context: { onboarding: true },
    });
  }

  onSecondaryTap(): void {
    if (this._step === 5) {
      // Step 5 secondary: skip flashing, use the on-phone preview only.
      setPreviewOnlyMode(true);
      setOnboardingCompleted(true);
      Frame.topmost()?.navigate({ moduleName: "phone-ui/shell-page", clearHistory: true });
      return;
    }
    if (this._step > 1) {
      this.setStep((this._step - 1) as OnboardingStep);
    }
  }

  // --- permissions (step 4) --------------------------------------------------
  /** Re-read permission state (call when the page regains focus after a grant). */
  refreshPermissions(): void {
    this.notifyPropertyChange("bleStatusLabel", this.bleStatusLabel);
    this.notifyPropertyChange("bleStatusClass", this.bleStatusClass);
    this.notifyPropertyChange("bleButtonEnabled", this.bleButtonEnabled);
    this.notifyPropertyChange("notifStatusLabel", this.notifStatusLabel);
    this.notifyPropertyChange("notifStatusClass", this.notifStatusClass);
    this.notifyPropertyChange("notifButtonEnabled", this.notifButtonEnabled);
    this.notifyPropertyChange("batteryStatusLabel", this.batteryStatusLabel);
    this.notifyPropertyChange("batteryStatusClass", this.batteryStatusClass);
    this.notifyPropertyChange("batteryButtonEnabled", this.batteryButtonEnabled);
  }

  async onGrantBle(): Promise<void> {
    try { await ensureBlePermissions(); } catch (e) { console.error(`[onboarding] ble grant: ${e}`); }
    this.refreshPermissions();
  }
  onGrantNotif(): void {
    requestNotificationListenerAccess();
  }
  onGrantBattery(): void {
    requestIgnoreBatteryOptimizations();
  }

  get bleStatusLabel(): string { return hasBlePermissions() ? GRANTED : NEEDED; }
  get bleStatusClass(): string { return hasBlePermissions() ? "onb-ok" : "onb-todo"; }
  get bleButtonEnabled(): boolean { return !hasBlePermissions(); }
  get notifStatusLabel(): string { return isNotificationListenerEnabled() ? GRANTED : NEEDED; }
  get notifStatusClass(): string { return isNotificationListenerEnabled() ? "onb-ok" : "onb-todo"; }
  get notifButtonEnabled(): boolean { return !isNotificationListenerEnabled(); }
  get batteryStatusLabel(): string { return isIgnoringBatteryOptimizations() ? GRANTED : NEEDED; }
  get batteryStatusClass(): string { return isIgnoringBatteryOptimizations() ? "onb-ok" : "onb-todo"; }
  get batteryButtonEnabled(): boolean { return !isIgnoringBatteryOptimizations(); }

  // --- bound content ---------------------------------------------------------
  get headline(): string { return STEP_CONTENT[this._step].headline; }
  get tagline(): string { return STEP_CONTENT[this._step].tagline; }
  get body(): string { return STEP_CONTENT[this._step].body; }
  get primaryLabel(): string { return STEP_CONTENT[this._step].primaryLabel; }
  get secondaryLabel(): string { return STEP_CONTENT[this._step].secondaryLabel; }
  get logoVisibility(): "visible" | "collapse" { return STEP_CONTENT[this._step].showLogo ? "visible" : "collapse"; }
  get taglineVisibility(): "visible" | "collapse" { return STEP_CONTENT[this._step].showTagline ? "visible" : "collapse"; }
  get secondaryVisibility(): "visible" | "collapse" { return STEP_CONTENT[this._step].showSecondary ? "visible" : "collapse"; }
  get permsVisibility(): "visible" | "collapse" { return STEP_CONTENT[this._step].showPerms ? "visible" : "collapse"; }
  get stepLabel(): string { return `Step ${this._step} of ${TOTAL_STEPS}`; }

  // Progress dots (fixed at 5): filled up to and including the current step.
  get dot1Class(): string { return this.dotClass(1); }
  get dot2Class(): string { return this.dotClass(2); }
  get dot3Class(): string { return this.dotClass(3); }
  get dot4Class(): string { return this.dotClass(4); }
  get dot5Class(): string { return this.dotClass(5); }
  private dotClass(n: number): string { return `onb-dot ${n <= this._step ? "onb-dot-on" : "onb-dot-off"}`; }

  private setStep(step: OnboardingStep): void {
    if (this._step === step) return;
    this._step = step;
    this.publish();
  }

  private publish(): void {
    for (const p of [
      "headline", "tagline", "body", "primaryLabel", "secondaryLabel", "stepLabel",
      "logoVisibility", "taglineVisibility", "secondaryVisibility", "permsVisibility",
      "dot1Class", "dot2Class", "dot3Class", "dot4Class", "dot5Class",
    ]) {
      this.notifyPropertyChange(p, (this as any)[p]);
    }
    if (this._step === 4) this.refreshPermissions();
  }
}
