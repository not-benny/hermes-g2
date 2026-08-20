import { Frame, Observable } from "@nativescript/core";

import { dashboardController, type DashboardSnapshot } from "../g2/dashboard-controller";
import {
  batteryDisplayModeSetting,
  brightnessSetting,
  lockScreenEnabledSetting,
  notificationAllowedPackagesSetting,
  notificationFilterModeSetting,
  notificationFontSizeSetting,
  onAnySettingChanged,
  ringSensitivitySetting,
  saveVoiceRecordingsSetting,
  screenTimeoutSetting,
  timeFormatSetting,
  verticalPositionSetting,
  voiceProviderSetting,
  wakeWordActionSetting,
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

  get lockLabel(): string {
    return `Lock screen: ${lockScreenEnabledSetting.get() ? "On" : "Off"}`;
  }

  get verticalPositionLabel(): string {
    return `Window position: ${verticalPositionSetting.displayValue()}`;
  }

  get timeFormatLabel(): string {
    return `Clock: ${timeFormatSetting.displayValue()}`;
  }

  get batteryDisplayLabel(): string {
    return `Battery display: ${batteryDisplayModeSetting.displayValue()}`;
  }

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

  get voiceProviderLabel(): string {
    return `Transcription: ${voiceProviderSetting.displayValue()}`;
  }

  get wakeWordActionLabel(): string {
    return `Wakeword: ${wakeWordActionSetting.displayValue()}`;
  }

  get voiceRecordingLabel(): string {
    return `Save voice recordings: ${saveVoiceRecordingsSetting.get() ? "On" : "Off"}`;
  }

  get notificationFilterLabel(): string {
    return `Notifications: ${notificationFilterModeSetting.displayValue()}`;
  }

  get selectedAppsLabel(): string {
    return `Selected apps: ${notificationAllowedPackagesSetting.displayValue()}`;
  }

  get notificationFontSizeLabel(): string {
    return `Notification text size: ${notificationFontSizeSetting.displayValue()}`;
  }

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

  onLockScreenTap(): void {
    lockScreenEnabledSetting.toggle();
    this.setStatus(`Lock screen ${lockScreenEnabledSetting.get() ? "enabled" : "disabled"}.`);
  }

  onVerticalPositionTap(): void {
    verticalPositionSetting.set(verticalPositionSetting.next());
    this.setStatus(`Moved windows to ${verticalPositionSetting.displayValue()}.`);
  }

  onTimeFormatTap(): void {
    timeFormatSetting.set(timeFormatSetting.next());
    this.setStatus(`Clock set to ${timeFormatSetting.displayValue()}.`);
  }

  onBatteryDisplayTap(): void {
    batteryDisplayModeSetting.set(batteryDisplayModeSetting.next());
    this.setStatus(`Battery display set to ${batteryDisplayModeSetting.displayValue()}.`);
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

  onWakeWordActionTap(): void {
    wakeWordActionSetting.set(wakeWordActionSetting.next());
    this.setStatus(`Wakeword action set to ${wakeWordActionSetting.displayValue()}.`);
  }

  onSaveVoiceRecordingTap(): void {
    saveVoiceRecordingsSetting.toggle();
    this.setStatus(`Voice recording diagnostics ${saveVoiceRecordingsSetting.get() ? "enabled" : "disabled"}.`);
  }

  async onTestVoiceInputTap(): Promise<void> {
    const started = await dashboardController.triggerVoiceTest();
    this.setStatus(started ? "Voice test opened on the glasses." : "Connect to the glasses first.");
  }

  onNotificationFilterModeTap(): void {
    notificationFilterModeSetting.set(notificationFilterModeSetting.next());
    this.setStatus(`Notification filter set to ${notificationFilterModeSetting.displayValue()}.`);
  }

  onNotificationFontSizeTap(): void {
    notificationFontSizeSetting.set(notificationFontSizeSetting.next());
    this.setStatus(`Notification text size set to ${notificationFontSizeSetting.displayValue()}.`);
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
      "lockLabel",
      "verticalPositionLabel",
      "timeFormatLabel",
      "batteryDisplayLabel",
      "ringSensitivityLabel",
      "voiceProviderLabel",
      "wakeWordActionLabel",
      "voiceRecordingLabel",
      "notificationFilterLabel",
      "selectedAppsLabel",
      "notificationFontSizeLabel",
    ]) {
      this.notifyPropertyChange(property, (this as any)[property]);
    }
  }

  private setStatus(value: string): void {
    this._status = value;
    this.notifyPropertyChange("status", value);
  }
}
