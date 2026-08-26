import { Application, Frame, Observable, SegmentedBarItem, TabView } from "@nativescript/core";

import {
  brightnessSetting,
  dashboardSizeSetting,
  onAnySettingChanged,
  screenTimeoutSetting,
  uiFontSetting,
  verticalPositionSetting,
} from "../ui/dashboard-settings";
import { isValidMacAddress, loadDeviceAddresses } from "../g2/device-addresses";
import { isPreviewOnlyMode, setPreviewOnlyMode, setOnboardingCompleted } from "./onboarding-state";
import { clearPreviewDemo } from "../native/preview-demo";

const CONTROLS_TAB_INDEX = 2;

/**
 * Settings-tab hub: current device/display summaries, navigation into local
 * configuration pages, and a direct route to the existing Controls tab.
 * uiFontSetting is a shared singleton, so this bar and the Controls-tab Font
 * control read/write the same value; onAnySettingChanged keeps both in sync.
 */
export class SettingsViewModel extends Observable {
  private unsubscribe: (() => void) | null = null;
  private _fontItems: SegmentedBarItem[] | null = null;

  constructor() {
    super();
    this.unsubscribe = onAnySettingChanged(() => this.refresh());
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  onDevicesTap(): void { Frame.topmost()?.navigate("phone-ui/config-page"); }
  onApiKeysTap(): void { Frame.topmost()?.navigate("phone-ui/api-keys-page"); }
  onCaptionSettingsTap(): void { Frame.topmost()?.navigate("phone-ui/caption-settings-page"); }

  onHealthProfileTap(): void { Frame.topmost()?.navigate("phone-ui/health-profile-page"); }

  /**
   * Display settings already live in the Controls tab. Switch the shell tab
   * instead of pushing a second copy of its root page into the Settings frame;
   * retain a standalone-page fallback for previews and XML harnesses.
   */
  onControlsTap(): void {
    const root = Application.getRootView();
    const tabs = root?.getViewById<TabView>("shellTabs");
    if (tabs) {
      tabs.selectedIndex = CONTROLS_TAB_INDEX;
      return;
    }
    Frame.topmost()?.navigate("phone-ui/glasses-controls-page");
  }

  get deviceSummary(): string {
    const addresses = loadDeviceAddresses();
    const glassesConfigured = isValidMacAddress(addresses.right) && isValidMacAddress(addresses.left);
    const hasRingAddress = addresses.ring.trim().length > 0;
    const ringConfigured = hasRingAddress && isValidMacAddress(addresses.ring);
    if (!glassesConfigured) return "Glasses setup incomplete";
    if (hasRingAddress && !ringConfigured) return "Glasses configured · R1 address needs review";
    return ringConfigured ? "Glasses and R1 configured" : "Glasses configured · no R1 saved";
  }

  get displaySummary(): string {
    return [
      `Brightness ${brightnessSetting.displayValue()}`,
      dashboardSizeSetting.displayValue(),
      `${verticalPositionSetting.displayValue()} position`,
      `${screenTimeoutSetting.displayValue()} timeout`,
    ].join(" · ");
  }

  get fontSummary(): string {
    return `${uiFontSetting.displayValue()} is used for text rendered on the glasses.`;
  }

  /** Refresh summaries after returning from a nested settings page. */
  refresh(): void {
    for (const property of ["deviceSummary", "displaySummary", "fontSummary", "uiFontIndex"]) {
      this.notifyPropertyChange(property, (this as any)[property]);
    }
  }

  // --- preview mode ----------------------------------------------------------
  get previewModeVisibility(): "visible" | "collapse" { return isPreviewOnlyMode() ? "visible" : "collapse"; }

  /**
   * Leave preview mode: delete all the anonymous demo data, clear the preview
   * flag, and re-run onboarding so the user can set up real glasses.
   */
  onExitPreviewTap(): void {
    clearPreviewDemo();
    setPreviewOnlyMode(false);
    setOnboardingCompleted(false);
    // Navigate the ROOT frame, not Frame.topmost() (which is this Settings tab's
    // frame): onboarding must replace the whole shell, or it renders inside the
    // tab and Finish nests a second shell -> a double tab bar.
    const root = Application.getRootView() as Frame;
    root?.navigate({ moduleName: "phone-ui/onboarding-page", clearHistory: true });
  }

  get uiFontItems(): SegmentedBarItem[] {
    if (!this._fontItems) {
      this._fontItems = uiFontSetting.values.map((value) => {
        const item = new SegmentedBarItem();
        item.title = uiFontSetting.displayValue(value);
        return item;
      });
    }
    return this._fontItems;
  }
  get uiFontIndex(): number {
    const i = uiFontSetting.values.indexOf(uiFontSetting.get());
    return i < 0 ? 0 : i;
  }
  set uiFontIndex(index: number) {
    const value = uiFontSetting.values[index];
    if (value === undefined || value === uiFontSetting.get()) return;
    uiFontSetting.set(value);
    this.notifyPropertyChange("uiFontIndex", index);
    this.notifyPropertyChange("fontSummary", this.fontSummary);
  }
}
