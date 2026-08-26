import { Frame, Observable, ObservableArray } from "@nativescript/core";
import { notificationRulesStore } from "../notifications/rules-store";
import type { NotificationRule, NotificationTier } from "../notifications/triage-policy";

const TIERS: NotificationTier[] = ["mute", "digest", "immediate", "urgent"];

type RuleRow = NotificationRule & {
  label: string;
  detail: string;
  tierLabel: string;
  onTierTap: () => void;
  onDeleteTap: () => void;
};

function ruleLabel(rule: NotificationRule): string {
  if (rule.scope === "default") return "Default";
  if (rule.scope === "app") return `App · ${rule.packageName}`;
  return `${rule.scope[0]!.toUpperCase()}${rule.scope.slice(1)} · ${rule.value}`;
}

export class NotificationRulesViewModel extends Observable {
  private readonly _rules = new ObservableArray<RuleRow>();
  private _status = "Rules are encrypted on this phone.";
  private _appPackage = "";
  private unsubscribe: (() => void) | null = null;

  constructor() {
    super();
    this.refresh();
    this.unsubscribe = notificationRulesStore.onChange(() => this.refresh());
  }

  dispose(): void { this.unsubscribe?.(); this.unsubscribe = null; }

  get rules(): ObservableArray<RuleRow> { return this._rules; }
  get status(): string { return this._status; }
  get appPackage(): string { return this._appPackage; }
  set appPackage(value: string) { this._appPackage = value; this.notifyPropertyChange("appPackage", value); }

  onAddDefaultTap(): void {
    this.upsert({ scope: "default", tier: "immediate" });
  }

  onAddAppTap(): void {
    const packageName = this._appPackage.normalize("NFC").trim();
    if (!packageName) { this.setStatus("Enter an Android package name first."); return; }
    this.upsert({ scope: "app", packageName, tier: "immediate" });
    this.appPackage = "";
  }

  onResetTap(): void {
    try { notificationRulesStore.reset(); this.setStatus("All notification rules reset."); }
    catch { this.setStatus("Rules are unavailable; no changes were made."); }
  }

  onBackTap(): void { Frame.topmost()?.goBack(); }

  private refresh(): void {
    const snapshot = notificationRulesStore.snapshot();
    const rows = snapshot.rules.map((rule): RuleRow => ({
      ...rule,
      label: ruleLabel(rule),
      detail: rule.scope === "default" ? "Fallback for any unmatched notification" : "More specific rules take precedence",
      tierLabel: `Priority: ${rule.tier}`,
      onTierTap: () => {
        const next = TIERS[(TIERS.indexOf(rule.tier) + 1) % TIERS.length]!;
        this.upsert({ ...rule, tier: next });
      },
      onDeleteTap: () => {
        try { notificationRulesStore.remove(rule); this.setStatus(`${ruleLabel(rule)} removed.`); }
        catch { this.setStatus("Rule could not be removed."); }
      },
    }));
    this._rules.splice(0, this._rules.length, ...rows);
    this.notifyPropertyChange("rules", this._rules);
    if (!snapshot.available) this.setStatus("Encrypted rules are unavailable. No changes will be made.");
  }

  private upsert(rule: NotificationRule): void {
    try { notificationRulesStore.upsert(rule); this.setStatus(`${ruleLabel(rule)} set to ${rule.tier}.`); }
    catch { this.setStatus("Rule was rejected; no changes were made."); }
  }

  private setStatus(status: string): void { this._status = status; this.notifyPropertyChange("status", status); }
}
