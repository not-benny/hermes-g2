import { Frame, Observable } from "@nativescript/core";

import {
  evenAccountEmailSetting,
  evenAccountPasswordSetting,
  evenApiAccessKeySetting,
  evenApiAccessSecretSetting,
  evenApiAesIvSetting,
  evenApiAesKeySetting,
  evenApiAppIdSetting,
} from "../ui/dashboard-settings";
import { evenGetLatestHealth, evenIsSignedIn, evenLogin, evenSignOut } from "../native/even-api";

type TextChangeArgs = { value?: string; object?: { text?: string } };

/**
 * Phone screen to configure the Even account + API signing credentials and
 * test the cloud health fetch. It's the validation surface: sign in, then fetch
 * health, and the on-screen status shows the real API result or error so the
 * signing can be corrected if the reconstructed scheme is off.
 */
export class EvenHealthViewModel extends Observable {
  private _status = "EXPERIMENTAL / untested — this likely does not work yet (see the warning above).";
  private _health = "";
  private _email = evenAccountEmailSetting.get();
  private _password = "";
  private _appId = "";
  private _accessKey = "";
  private _accessSecret = "";
  private _aesKey = "";
  private _aesIv = "";

  get status(): string { return this._status; }
  get health(): string { return this._health; }
  get email(): string { return this._email; }
  set email(value: string) { this._email = value ?? ""; }
  get signInState(): string { return evenIsSignedIn() ? "Signed in" : "Signed out"; }
  get appIdConfigured(): string { return configuredLabel("app_id", evenApiAppIdSetting.get()); }
  get accessKeyConfigured(): string { return configuredLabel("accessKey", evenApiAccessKeySetting.get()); }
  get accessSecretConfigured(): string { return configuredLabel("accessKeySecret", evenApiAccessSecretSetting.get()); }
  get aesKeyConfigured(): string { return configuredLabel("password AES key", evenApiAesKeySetting.get()); }
  get aesIvConfigured(): string { return configuredLabel("password AES IV", evenApiAesIvSetting.get()); }
  get passwordConfigured(): string { return configuredLabel("password", evenAccountPasswordSetting.get()); }

  onEmailTextChange(args: TextChangeArgs): void { this._email = args.object?.text ?? args.value ?? ""; }
  onPasswordTextChange(args: TextChangeArgs): void { this._password = args.object?.text ?? args.value ?? ""; }
  onAppIdTextChange(args: TextChangeArgs): void { this._appId = args.object?.text ?? args.value ?? ""; }
  onAccessKeyTextChange(args: TextChangeArgs): void { this._accessKey = args.object?.text ?? args.value ?? ""; }
  onAccessSecretTextChange(args: TextChangeArgs): void { this._accessSecret = args.object?.text ?? args.value ?? ""; }
  onAesKeyTextChange(args: TextChangeArgs): void { this._aesKey = args.object?.text ?? args.value ?? ""; }
  onAesIvTextChange(args: TextChangeArgs): void { this._aesIv = args.object?.text ?? args.value ?? ""; }

  onSaveTap(): void {
    const email = this._email.trim();
    if (email) evenAccountEmailSetting.set(email);
    replaceIfProvided(evenAccountPasswordSetting, this._password);
    replaceIfProvided(evenApiAppIdSetting, this._appId);
    replaceIfProvided(evenApiAccessKeySetting, this._accessKey);
    replaceIfProvided(evenApiAccessSecretSetting, this._accessSecret);
    replaceIfProvided(evenApiAesKeySetting, this._aesKey);
    replaceIfProvided(evenApiAesIvSetting, this._aesIv);
    this._password = this._appId = this._accessKey = this._accessSecret = this._aesKey = this._aesIv = "";
    this.setStatus("Saved. Secret values stay hidden.");
    this.refresh();
  }

  async onSignInTap(): Promise<void> {
    this.setStatus("Signing in…");
    const result = await evenLogin();
    this.setStatus(result.ok ? "Signed in." : `Sign-in failed: ${result.error}`);
    this.refresh();
  }

  onSignOutTap(): void {
    evenSignOut();
    this.setStatus("Signed out.");
    this.refresh();
  }

  async onFetchHealthTap(): Promise<void> {
    this.setStatus("Fetching health…");
    const result = await evenGetLatestHealth();
    if (!result.ok) {
      this.setStatus(`Fetch failed: ${result.error}`);
      this.refresh();
      return;
    }
    const h = result.data!;
    const line = (label: string, value: number | null, unit = "") =>
      `${label}: ${value === null ? "—" : `${value}${unit}`}`;
    this._health = [
      line("Steps", h.steps),
      line("Heart rate", h.heartRate, " bpm"),
      line("HRV", h.hrv, " ms"),
      line("SpO₂", h.spo2, "%"),
      line("Body temp", h.bodyTempC, "°C"),
      line("Calories", h.caloriesKcal, " kcal"),
      line("Sleep", h.sleepMinutes, " min"),
    ].join("\n");
    this.setStatus("Health fetched.");
    this.refresh();
  }

  onBackTap(): void {
    Frame.topmost()?.navigate({ moduleName: "phone-ui/main-page", clearHistory: true });
  }

  private setStatus(value: string): void {
    this._status = value;
  }

  private refresh(): void {
    for (const property of [
      "status",
      "health",
      "signInState",
      "appIdConfigured",
      "accessKeyConfigured",
      "accessSecretConfigured",
      "aesKeyConfigured",
      "aesIvConfigured",
      "passwordConfigured",
    ]) {
      this.notifyPropertyChange(property, (this as any)[property]);
    }
  }
}

function replaceIfProvided(setting: { set(value: string): string }, value: string): void {
  const replacement = value.trim();
  if (replacement) setting.set(replacement);
}

function configuredLabel(label: string, value: string): string {
  return `${label}: ${value.trim() ? "configured" : "not set"}`;
}
