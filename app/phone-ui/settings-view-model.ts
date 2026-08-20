import { Application, Frame, Observable, SegmentedBarItem } from "@nativescript/core";

import { onAnySettingChanged, uiFontSetting } from "../ui/dashboard-settings";
import { isPreviewOnlyMode, setPreviewOnlyMode, setOnboardingCompleted } from "./onboarding-state";
import { clearPreviewDemo } from "../native/preview-demo";

/**
 * Settings-tab hub: navigation into Devices / API keys / WhatsApp (within the
 * Settings tab frame) plus a Font control. uiFontSetting is a shared singleton,
 * so this bar and the Controls-tab Font control read/write the same value;
 * subscribing to onAnySettingChanged keeps this bar in sync when the other
 * control changes it.
 */
export class SettingsViewModel extends Observable {
  private unsubscribe: (() => void) | null = null;
  private _fontItems: SegmentedBarItem[] | null = null;

  constructor() {
    super();
    this.unsubscribe = onAnySettingChanged(() =>
      this.notifyPropertyChange("uiFontIndex", this.uiFontIndex),
    );
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  onDevicesTap(): void { Frame.topmost()?.navigate("phone-ui/config-page"); }
  onApiKeysTap(): void { Frame.topmost()?.navigate("phone-ui/api-keys-page"); }
  onWhatsAppTap(): void { Frame.topmost()?.navigate("phone-ui/whatsapp-page"); }

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
  }
}
