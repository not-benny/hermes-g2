import { Frame, Observable, SegmentedBarItem } from "@nativescript/core";
import type { ConfigSettingEnum } from "../ui/dashboard-settings";

import { dashboardController, type DashboardSnapshot } from "../g2/dashboard-controller";
import {
  batteryDisplayModeSetting,
  brightnessSetting,
  lockScreenEnabledSetting,
  notificationAllowedPackagesSetting,
  notificationFilterModeSetting,
  notificationFontSizeSetting,
  dashboardSizeSetting,
  onAnySettingChanged,
  ringSensitivitySetting,
  saveVoiceRecordingsSetting,
  screenTimeoutSetting,
  timeFormatSetting,
  verticalPositionSetting,
  voiceProviderSetting,
  wakeWordActionSetting,
  voiceControlEnabledSetting,
  uiFontSetting,
} from "../ui/dashboard-settings";
import { type RingConnectionState } from "../native/faceclaw-communicator";

type ControlsPhase = DashboardSnapshot["phase"];

const RING_STATUS_LABELS: Record<RingConnectionState, string> = {
  "not-configured": "R1: no address configured",
  idle: "R1: waiting for glasses session",
  retrying: "R1: reconnecting",
  subscribing: "R1: subscribing to events",
  ready: "R1: connected",
};

export class GlassesControlsViewModel extends Observable {
  private _phase: ControlsPhase = "disconnected";
  private _status = "Disconnected.";
  private _screenOn = true;
  private _glassesWorn: boolean | null = null;
  private _glassesLocked = false;
  private _ringConnectionState: RingConnectionState = "not-configured";
  private unsubscribeSnapshot: (() => void) | null = null;
  private unsubscribeSettings: (() => void) | null = null;
  // SegmentedBar items are static per enum (values never change), so build them
  // once and reuse - rebuilding on every getter read would churn the bar.
  private readonly itemsCache = new Map<ConfigSettingEnum<string>, SegmentedBarItem[]>();

  constructor() {
    super();
    this.unsubscribeSnapshot = dashboardController.subscribe((snapshot) => this.applySnapshot(snapshot));
    this.unsubscribeSettings = onAnySettingChanged(() => this.refreshSettingLabels());
  }

  dispose(): void {
    this.unsubscribeSnapshot?.();
    this.unsubscribeSnapshot = null;
    this.unsubscribeSettings?.();
    this.unsubscribeSettings = null;
  }

  get status(): string {
    return this._status;
  }

  get canControl(): boolean {
    return this._phase === "connected";
  }

  get screenActionLabel(): string {
    return this._screenOn ? "Blank screen" : "Wake screen";
  }

  get brightnessLabel(): string {
    return `Brightness: ${brightnessSetting.displayValue()}`;
  }

  get timeoutLabel(): string {
    return `Screen timeout: ${screenTimeoutSetting.displayValue()}`;
  }

  get lockScreenChecked(): boolean {
    return lockScreenEnabledSetting.get();
  }
  set lockScreenChecked(value: boolean) {
    if (value === lockScreenEnabledSetting.get()) return; // guard the notify->write loop
    lockScreenEnabledSetting.set(value);
    this.notifyPropertyChange("lockScreenChecked", value);
    this.setStatus(`Lock screen ${value ? "enabled" : "disabled"}.`);
  }

  get verticalPositionLabel(): string {
    return `Window position: ${verticalPositionSetting.displayValue()}`;
  }

  get timeFormatItems(): SegmentedBarItem[] { return this.enumItems(timeFormatSetting); }
  get timeFormatIndex(): number { return this.enumIndex(timeFormatSetting); }
  set timeFormatIndex(index: number) { this.setEnumIndex(timeFormatSetting, index, "timeFormatIndex"); }

  get batteryDisplayItems(): SegmentedBarItem[] { return this.enumItems(batteryDisplayModeSetting); }
  get batteryDisplayIndex(): number { return this.enumIndex(batteryDisplayModeSetting); }
  set batteryDisplayIndex(index: number) { this.setEnumIndex(batteryDisplayModeSetting, index, "batteryDisplayIndex"); }

  get wearStatus(): string {
    const wearing = this._glassesWorn === null ? "unknown" : this._glassesWorn ? "on head" : "off head";
    return `Wear: ${wearing}${this._glassesLocked ? " · locked" : ""}`;
  }

  get ringStatus(): string {
    return RING_STATUS_LABELS[this._ringConnectionState];
  }

  get ringSensitivityLabel(): string {
    return `Ring sensitivity: ${ringSensitivitySetting.displayValue()}`;
  }

  get voiceControlChecked(): boolean {
    return voiceControlEnabledSetting.get();
  }
  set voiceControlChecked(value: boolean) {
    if (value === voiceControlEnabledSetting.get()) return;
    voiceControlEnabledSetting.set(value);
    this.notifyPropertyChange("voiceControlChecked", value);
    this.setStatus(`Voice control ${value ? "enabled" : "disabled"}.`);
  }

  get uiFontItems(): SegmentedBarItem[] { return this.enumItems(uiFontSetting); }
  get uiFontIndex(): number { return this.enumIndex(uiFontSetting); }
  set uiFontIndex(index: number) { this.setEnumIndex(uiFontSetting, index, "uiFontIndex"); }

  get voiceProviderLabel(): string {
    return `Transcription: ${voiceProviderSetting.displayValue()}`;
  }

  get wakeWordActionItems(): SegmentedBarItem[] { return this.enumItems(wakeWordActionSetting); }
  get wakeWordActionIndex(): number { return this.enumIndex(wakeWordActionSetting); }
  set wakeWordActionIndex(index: number) { this.setEnumIndex(wakeWordActionSetting, index, "wakeWordActionIndex"); }

  get saveVoiceRecordingsChecked(): boolean {
    return saveVoiceRecordingsSetting.get();
  }
  set saveVoiceRecordingsChecked(value: boolean) {
    if (value === saveVoiceRecordingsSetting.get()) return;
    saveVoiceRecordingsSetting.set(value);
    this.notifyPropertyChange("saveVoiceRecordingsChecked", value);
    this.setStatus(`Voice recording diagnostics ${value ? "enabled" : "disabled"}.`);
  }

  get notificationFilterItems(): SegmentedBarItem[] { return this.enumItems(notificationFilterModeSetting); }
  get notificationFilterIndex(): number { return this.enumIndex(notificationFilterModeSetting); }
  set notificationFilterIndex(index: number) { this.setEnumIndex(notificationFilterModeSetting, index, "notificationFilterIndex"); }

  get selectedAppsLabel(): string {
    return `Selected apps: ${notificationAllowedPackagesSetting.displayValue()}`;
  }

  get notificationFontSizeItems(): SegmentedBarItem[] { return this.enumItems(notificationFontSizeSetting); }
  get notificationFontSizeIndex(): number { return this.enumIndex(notificationFontSizeSetting); }
  set notificationFontSizeIndex(index: number) { this.setEnumIndex(notificationFontSizeSetting, index, "notificationFontSizeIndex"); }

  get dashboardSizeItems(): SegmentedBarItem[] { return this.enumItems(dashboardSizeSetting); }
  get dashboardSizeIndex(): number { return this.enumIndex(dashboardSizeSetting); }
  set dashboardSizeIndex(index: number) { this.setEnumIndex(dashboardSizeSetting, index, "dashboardSizeIndex"); }

  async onWakeScreenTap(): Promise<void> {
    const woke = await dashboardController.wakeGlassesScreen();
    this.setStatus(woke ? "Screen awake." : "Could not wake the glasses session.");
  }

  onBlankScreenTap(): void {
    this.setStatus(dashboardController.sleepGlassesScreen() ? "Screen blanked." : "Connect to the glasses first.");
  }

  onBrightnessTap(): void {
    brightnessSetting.set(brightnessSetting.next());
    this.setStatus(`Set ${brightnessSetting.displayValue()} brightness.`);
  }

  onTimeoutTap(): void {
    screenTimeoutSetting.set(screenTimeoutSetting.next());
    this.setStatus(`Set screen timeout to ${screenTimeoutSetting.displayValue()}.`);
  }

  onVerticalPositionTap(): void {
    verticalPositionSetting.set(verticalPositionSetting.next());
    this.setStatus(`Moved windows to ${verticalPositionSetting.displayValue()}.`);
  }

  async onOpenCompassTap(): Promise<void> {
    const opened = await dashboardController.openCompass();
    this.setStatus(opened ? "Compass opened on the glasses." : "Connect to the glasses first.");
  }

  async onRefreshWearTap(): Promise<void> {
    const requested = await dashboardController.refreshWearState();
    this.setStatus(requested ? "Refreshing wear state…" : "Wear status is unavailable until the CFW session is ready.");
  }

  async onReconnectGlassesTap(): Promise<void> {
    const reconnected = await dashboardController.reconnectGlasses();
    this.setStatus(reconnected ? "Reconnecting to glasses…" : "A connection transition is already in progress.");
  }

  async onReconnectRingTap(): Promise<void> {
    const queued = await dashboardController.reconnectRing();
    this.setStatus(queued ? "R1 reconnect requested." : "R1 needs a configured address and an active glasses session.");
  }

  onRingSensitivityTap(): void {
    ringSensitivitySetting.set(ringSensitivitySetting.next());
    this.setStatus(`Ring sensitivity set to ${ringSensitivitySetting.displayValue()}.`);
  }

  onVoiceProviderTap(): void {
    voiceProviderSetting.set(voiceProviderSetting.next());
    this.setStatus(`Voice provider set to ${voiceProviderSetting.displayValue()}.`);
  }

  async onTestVoiceInputTap(): Promise<void> {
    const started = await dashboardController.triggerVoiceTest();
    this.setStatus(started ? "Voice test opened on the glasses." : "Connect to the glasses first.");
  }

  onOpenNotificationAppsTap(): void {
    Frame.topmost()?.navigate("phone-ui/notification-apps-page");
  }

  onOpenMediaAppsTap(): void {
    Frame.topmost()?.navigate("phone-ui/media-apps-page");
  }

  onBackTap(): void {
    Frame.topmost()?.navigate({ moduleName: "phone-ui/main-page", clearHistory: true });
  }

  private applySnapshot(snapshot: DashboardSnapshot): void {
    this._phase = snapshot.phase;
    this._status = snapshot.status;
    this._screenOn = snapshot.screenOn;
    this._glassesWorn = snapshot.glassesWorn;
    this._glassesLocked = snapshot.glassesLocked;
    this._ringConnectionState = snapshot.ringConnectionState;
    for (const property of ["status", "canControl", "screenActionLabel", "wearStatus", "ringStatus"]) {
      this.notifyPropertyChange(property, (this as any)[property]);
    }
  }

  private refreshSettingLabels(): void {
    for (const property of [
      "brightnessLabel",
      "timeoutLabel",
      "lockScreenChecked",
      "verticalPositionLabel",
      "timeFormatIndex",
      "batteryDisplayIndex",
      "dashboardSizeIndex",
      "ringSensitivityLabel",
      "voiceControlChecked",
      "uiFontIndex",
      "voiceProviderLabel",
      "wakeWordActionIndex",
      "saveVoiceRecordingsChecked",
      "notificationFilterIndex",
      "selectedAppsLabel",
      "notificationFontSizeIndex",
    ]) {
      this.notifyPropertyChange(property, (this as any)[property]);
    }
  }

  private setStatus(value: string): void {
    this._status = value;
    this.notifyPropertyChange("status", value);
  }

  // --- SegmentedBar enum helpers -------------------------------------------
  /** Cached SegmentedBarItem list for an enum, titled by its display labels. */
  private enumItems(setting: ConfigSettingEnum<string>): SegmentedBarItem[] {
    let items = this.itemsCache.get(setting);
    if (!items) {
      items = setting.values.map((value) => {
        const item = new SegmentedBarItem();
        item.title = setting.displayValue(value);
        return item;
      });
      this.itemsCache.set(setting, items);
    }
    return items;
  }

  /** The selected index for an enum's current value (0 if somehow unset). */
  private enumIndex(setting: ConfigSettingEnum<string>): number {
    const index = setting.values.indexOf(setting.get());
    return index < 0 ? 0 : index;
  }

  /** Persist an enum from a SegmentedBar selectedIndex; guards the notify loop. */
  private setEnumIndex(setting: ConfigSettingEnum<string>, index: number, property: string): void {
    const value = setting.values[index];
    if (value === undefined || value === setting.get()) return;
    setting.set(value);
    this.notifyPropertyChange(property, index);
    this.setStatus(`${setting.label} set to ${setting.displayValue()}.`);
  }
}
