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
import { ringHealthStore } from "../health/ring-health-store";

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
  private _connectionHealth: DashboardSnapshot["connectionHealth"] = {
    g2State: "disconnected", r1State: "idle", failure: "none", r1RetryInMs: 0,
    g2Reconnects: 0, r1Reconnects: 0, acks: 0, ackTimeouts: 0, staleWork: 0,
    lockLatencyLatestMs: 0, lockLatencyMaxMs: 0,
  };
  private _evenAppConflictMessage = "";
  private unsubscribeSnapshot: (() => void) | null = null;
  private unsubscribeSettings: (() => void) | null = null;
  private unsubscribeRingHealth: (() => void) | null = null;
  // SegmentedBar items are static per enum (values never change), so build them
  // once and reuse - rebuilding on every getter read would churn the bar.
  private readonly itemsCache = new Map<ConfigSettingEnum<string>, SegmentedBarItem[]>();

  constructor() {
    super();
    this.unsubscribeSnapshot = dashboardController.subscribe((snapshot) => this.applySnapshot(snapshot));
    this.unsubscribeSettings = onAnySettingChanged(() => this.refreshSettingLabels());
    this.unsubscribeRingHealth = ringHealthStore.onChange(() => {
      this.notifyPropertyChange("ringFirmwareVersion", this.ringFirmwareVersion);
    });
  }

  dispose(): void {
    this.unsubscribeSnapshot?.();
    this.unsubscribeSnapshot = null;
    this.unsubscribeSettings?.();
    this.unsubscribeSettings = null;
    this.unsubscribeRingHealth?.();
    this.unsubscribeRingHealth = null;
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

  get brightnessSliderValue(): number { return this.enumIndex(brightnessSetting); }
  set brightnessSliderValue(value: number) { this.setEnumSlider(brightnessSetting, value, "brightnessValueLabel"); }
  get brightnessSliderMax(): number { return this.enumSliderMax(brightnessSetting); }
  get brightnessValueLabel(): string { return brightnessSetting.displayValue(); }

  // Kept as a button: 5 options ("Never" wraps) don't fit a segmented bar.
  get timeoutLabel(): string { return `Screen timeout: ${screenTimeoutSetting.displayValue()}`; }
  onTimeoutTap(): void {
    screenTimeoutSetting.set(screenTimeoutSetting.next());
    this.setStatus(`Set screen timeout to ${screenTimeoutSetting.displayValue()}.`);
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

  // Kept as a button: 5 options (Top/Upper/Middle/Lower/Bottom) wrap in a bar.
  get verticalPositionLabel(): string { return `Window position: ${verticalPositionSetting.displayValue()}`; }
  onVerticalPositionTap(): void {
    verticalPositionSetting.set(verticalPositionSetting.next());
    this.setStatus(`Moved windows to ${verticalPositionSetting.displayValue()}.`);
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

  get g2HealthStatus(): string {
    return `G2: ${this._connectionHealth.g2State}`;
  }

  get r1HealthStatus(): string {
    const health = this._connectionHealth;
    const retry = health.r1RetryInMs > 0 ? ` · retry in ${Math.ceil(health.r1RetryInMs / 1000)}s` : "";
    const failure = health.failure !== "none" ? ` · ${health.failure}` : "";
    return `R1: ${health.r1State}${failure}${retry}`;
  }

  get connectionDiagnostics(): string {
    const health = this._connectionHealth;
    return `Reconnects G2 ${health.g2Reconnects} / R1 ${health.r1Reconnects} · ACK ${health.acks}`
      + ` (timeouts ${health.ackTimeouts}) · stale ${health.staleWork}`
      + ` · lock ${health.lockLatencyLatestMs}ms (max ${health.lockLatencyMaxMs}ms)`;
  }

  get evenAppConflictMessage(): string { return this._evenAppConflictMessage; }
  get evenAppConflictWarningVisibility(): "visible" | "collapse" {
    return this._evenAppConflictMessage ? "visible" : "collapse";
  }

  get ringFirmwareVersion(): string {
    const version = ringHealthStore.snapshot().firmwareVersion;
    return `R1 firmware: ${version ?? "waiting for device info"}`;
  }

  get ringSensitivitySliderValue(): number { return this.enumIndex(ringSensitivitySetting); }
  set ringSensitivitySliderValue(value: number) { this.setEnumSlider(ringSensitivitySetting, value, "ringSensitivityValueLabel"); }
  get ringSensitivitySliderMax(): number { return this.enumSliderMax(ringSensitivitySetting); }
  get ringSensitivityValueLabel(): string { return ringSensitivitySetting.displayValue(); }

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

  // Kept as a button: its labels ("Screen on") are too long for a 3-segment bar.
  get wakeWordActionLabel(): string { return `Wakeword: ${wakeWordActionSetting.displayValue()}`; }
  onWakeWordActionTap(): void {
    wakeWordActionSetting.set(wakeWordActionSetting.next());
    this.setStatus(`Wakeword action set to ${wakeWordActionSetting.displayValue()}.`);
  }

  get saveVoiceRecordingsChecked(): boolean {
    return saveVoiceRecordingsSetting.get();
  }
  set saveVoiceRecordingsChecked(value: boolean) {
    if (value === saveVoiceRecordingsSetting.get()) return;
    saveVoiceRecordingsSetting.set(value);
    this.notifyPropertyChange("saveVoiceRecordingsChecked", value);
    this.setStatus(`Voice recording diagnostics ${value ? "enabled" : "disabled"}.`);
  }

  // Kept as a button: labels ("Important only", "All non-silent") wrap in a bar.
  get notificationFilterLabel(): string { return `Notifications: ${notificationFilterModeSetting.displayValue()}`; }
  onNotificationFilterModeTap(): void {
    notificationFilterModeSetting.set(notificationFilterModeSetting.next());
    this.setStatus(`Notification filter set to ${notificationFilterModeSetting.displayValue()}.`);
  }

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

  onOpenEvenAppSettingsTap(): void {
    dashboardController.openEvenAppSettings();
  }

  async onRetryRingTap(): Promise<void> {
    const queued = await dashboardController.retryRingAfterEvenAppStop();
    this.setStatus(queued ? "R1 reconnect requested." : "Force stop Even first, then retry R1.");
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
    this._connectionHealth = snapshot.connectionHealth;
    this._evenAppConflictMessage = snapshot.evenAppConflictMessage;
    for (const property of [
      "status", "canControl", "screenActionLabel", "wearStatus", "ringStatus",
      "g2HealthStatus", "r1HealthStatus", "connectionDiagnostics",
      "evenAppConflictMessage", "evenAppConflictWarningVisibility",
    ]) {
      this.notifyPropertyChange(property, (this as any)[property]);
    }
  }

  private refreshSettingLabels(): void {
    for (const property of [
      "brightnessValueLabel",
      "timeoutLabel",
      "lockScreenChecked",
      "verticalPositionLabel",
      "timeFormatIndex",
      "batteryDisplayIndex",
      "dashboardSizeIndex",
      "ringSensitivityValueLabel",
      "voiceControlChecked",
      "uiFontIndex",
      "voiceProviderLabel",
      "wakeWordActionLabel",
      "saveVoiceRecordingsChecked",
      "notificationFilterLabel",
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

  /** Top index for a Slider that runs over an enum's values. */
  private enumSliderMax(setting: ConfigSettingEnum<string>): number {
    return Math.max(0, setting.values.length - 1);
  }

  /**
   * Persist an enum from a Slider value (a continuous float over the value
   * index). Rounds to the nearest value and guards no-op writes so dragging
   * only writes when it crosses into a new value. Deliberately does NOT notify
   * the slider's own value back mid-drag (that would fight the finger); the
   * value chip label is notified instead so it tracks the drag.
   */
  private setEnumSlider(setting: ConfigSettingEnum<string>, sliderValue: number, labelProperty: string): void {
    const index = Math.max(0, Math.min(this.enumSliderMax(setting), Math.round(sliderValue)));
    const value = setting.values[index];
    if (value === undefined || value === setting.get()) return;
    setting.set(value);
    this.notifyPropertyChange(labelProperty, setting.displayValue());
    this.setStatus(`${setting.label} set to ${setting.displayValue()}.`);
  }
}
