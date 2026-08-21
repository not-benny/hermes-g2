import { ApplicationSettings, Frame, Observable } from "@nativescript/core";

import {
  requestWhatsAppPairing,
  whatsAppStatus,
} from "../native/whatsapp-node";

const PAIR_PHONE_PREF = "whatsapp.pairPhone";
// WhatsApp holds an unentered pairing socket ~40s before closing it (428). Give
// the code a matching countdown so the UI expires it in step with the server.
const CODE_TTL_SECONDS = 40;
const STATUS_POLL_MS = 2500;

/**
 * WhatsApp linking screen. Enter the phone number, request an 8-char pairing
 * code, and enter it in WhatsApp > Linked devices > Link with phone number. The
 * embedded engine (whatsapp-node) mints the code and reports link state; this
 * page shows the code with a countdown and flips to a linked view on success.
 */
export class WhatsAppViewModel extends Observable {
  private _status = "Checking WhatsApp link...";
  private _phoneNumber = "";
  private _code = "";
  private _countdownLabel = "";
  private _linkedUser = "";
  private _busy = false;
  private _formVisibility = "visible";
  private _codeVisibility = "collapse";
  private _linkedVisibility = "collapse";

  private statusTimer: any = null;
  private countdownTimer: any = null;
  private secondsLeft = 0;

  constructor() {
    super();
    // Stored as bare E.164 digits; display with the leading + so the field
    // reads naturally and the phone keypad's + can be edited in.
    const storedDigits = ApplicationSettings.getString(PAIR_PHONE_PREF, "");
    this._phoneNumber = storedDigits ? `+${storedDigits}` : "";
    void this.refreshStatus();
    this.statusTimer = setInterval(() => void this.refreshStatus(), STATUS_POLL_MS);
  }

  dispose(): void {
    if (this.statusTimer) clearInterval(this.statusTimer);
    if (this.countdownTimer) clearInterval(this.countdownTimer);
    this.statusTimer = null;
    this.countdownTimer = null;
  }

  get status(): string { return this._status; }
  get phoneNumber(): string { return this._phoneNumber; }
  set phoneNumber(v: string) {
    if (v === this._phoneNumber) return;
    this._phoneNumber = v;
    this.notifyPropertyChange("phoneNumber", v);
  }
  get code(): string { return this._code; }
  get countdownLabel(): string { return this._countdownLabel; }
  get linkedUser(): string { return this._linkedUser; }
  get busy(): boolean { return this._busy; }
  get canPair(): boolean { return !this._busy; }
  get formVisibility(): string { return this._formVisibility; }
  get codeVisibility(): string { return this._codeVisibility; }
  get linkedVisibility(): string { return this._linkedVisibility; }

  private setBusy(v: boolean): void {
    this._busy = v;
    this.notifyPropertyChange("busy", v);
    this.notifyPropertyChange("canPair", this.canPair);
  }
  private setStatus(v: string): void {
    this._status = v;
    this.notifyPropertyChange("status", v);
  }

  async onGetCode(): Promise<void> {
    const digits = this._phoneNumber.replace(/[^0-9]/g, "");
    if (digits.length < 8) {
      this.setStatus("Enter your full number in international format, e.g. +447700900123.");
      return;
    }
    // A valid international (E.164) number never starts with 0 - a leading 0 is
    // the national trunk prefix. Reject it: pairing 07597... instead of 447597...
    // mints a code for a number WhatsApp cannot resolve, so the link fails.
    if (digits.startsWith("0")) {
      this.setStatus("Use your international number (country code first, e.g. +44...), not the 0-prefixed national form.");
      return;
    }
    ApplicationSettings.setString(PAIR_PHONE_PREF, digits);
    this.phoneNumber = `+${digits}`;
    this.setBusy(true);
    this.setStatus("Requesting a pairing code...");
    this.showCode("");
    const code = await requestWhatsAppPairing(digits);
    this.setBusy(false);
    if (!code) {
      this.setStatus("Could not get a code. Check the number and try again.");
      return;
    }
    this.showCode(code);
    this.startCountdown();
    this.setStatus("In WhatsApp: Settings > Linked devices > Link a device > Link with phone number. Enter this code quickly.");
  }

  onBackTap(): void {
    Frame.topmost()?.goBack();
  }

  private showCode(code: string): void {
    // Space the 8 chars into 2 groups of 4 for readability; keep raw for logic.
    this._code = code ? `${code.slice(0, 4)} ${code.slice(4)}` : "";
    this.notifyPropertyChange("code", this._code);
    this.setVisibility(code ? "collapse" : "visible", code ? "visible" : "collapse", "collapse");
  }

  private startCountdown(): void {
    if (this.countdownTimer) clearInterval(this.countdownTimer);
    this.secondsLeft = CODE_TTL_SECONDS;
    this.tickCountdown();
    this.countdownTimer = setInterval(() => this.tickCountdown(), 1000);
  }

  private tickCountdown(): void {
    if (this.secondsLeft <= 0) {
      if (this.countdownTimer) clearInterval(this.countdownTimer);
      this.countdownTimer = null;
      this._countdownLabel = "";
      this.notifyPropertyChange("countdownLabel", "");
      this.showCode("");
      this.setStatus("Code expired. Tap Get pairing code for a new one.");
      return;
    }
    this._countdownLabel = `Expires in ${this.secondsLeft}s`;
    this.notifyPropertyChange("countdownLabel", this._countdownLabel);
    this.secondsLeft -= 1;
  }

  private async refreshStatus(): Promise<void> {
    const s = await whatsAppStatus();
    if (!s) {
      // Engine may still be booting; don't clobber an active pairing message.
      if (!this._code && !this._busy) this.setStatus("Starting WhatsApp engine...");
      return;
    }
    if (s.state === "connected") {
      const name = s.user?.name || s.user?.id || "your account";
      this._linkedUser = `Linked as ${name}`;
      this.notifyPropertyChange("linkedUser", this._linkedUser);
      this.setVisibility("collapse", "collapse", "visible");
      this.setStatus("WhatsApp is linked to Hermes G2.");
      if (this.countdownTimer) { clearInterval(this.countdownTimer); this.countdownTimer = null; }
      return;
    }
    // Not connected: keep the form/code view. Surface a failed attempt.
    if (this._linkedVisibility === "visible") {
      this.setVisibility("visible", "collapse", "collapse");
    }
    if (!this._code && !this._busy) {
      if (s.lastError === "pairing_failed_401") {
        this.setStatus("WhatsApp rejected the attempt - this is its rate limit from repeated tries. Wait a few minutes, then request ONE code and enter it right away.");
      } else if (s.state === "connecting" || s.state === "pairing") {
        this.setStatus("Connecting to WhatsApp...");
      } else {
        this.setStatus("Not linked. Enter your number and get a pairing code.");
      }
    }
  }

  private setVisibility(form: string, code: string, linked: string): void {
    this._formVisibility = form;
    this._codeVisibility = code;
    this._linkedVisibility = linked;
    this.notifyPropertyChange("formVisibility", form);
    this.notifyPropertyChange("codeVisibility", code);
    this.notifyPropertyChange("linkedVisibility", linked);
  }
}
