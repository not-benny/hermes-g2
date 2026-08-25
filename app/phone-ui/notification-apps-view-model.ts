import { EventData, Frame, Observable, ObservableArray, View } from "@nativescript/core";

import {
  notificationAllowedPackagesSetting,
  notificationAppTiersSetting,
  onAnySettingChanged,
  parseNotificationAppTiers,
  parseNotificationAllowedPackages,
  setNotificationAppTier,
  type NotificationAppTier,
} from "../ui/dashboard-settings";
import { readInstalledNotificationApps, type AndroidNotificationApp } from "../native/notification-icons";
import { toggleAllowedNotificationPackage } from "../notifications/app-selection";

type NotificationAppRow = AndroidNotificationApp & {
  enabledGlyph: string;
  detail: string;
  toggleLabel: string;
  toggleAccessibilityLabel: string;
  onToggleTap: () => void;
  tierLabel: string;
  onTierTap: () => void;
};

const TIER_ORDER: NotificationAppTier[] = ["default", "immediate", "digest", "urgent", "mute"];

export class NotificationAppsViewModel extends Observable {
  private readonly _apps = new ObservableArray<NotificationAppRow>();
  private _status = "Loading installed apps…";
  private unsubscribeSettings: (() => void) | null = null;

  constructor() {
    super();
    this.refresh();
    this.activate();
  }

  /** Re-arm cross-isolate refresh after this page returns from a hidden tab. */
  activate(): void {
    if (this.unsubscribeSettings) return;
    this.unsubscribeSettings = onAnySettingChanged(() => this.refreshRows());
    this.refreshRows();
  }

  deactivate(): void {
    this.unsubscribeSettings?.();
    this.unsubscribeSettings = null;
  }

  dispose(): void {
    this.deactivate();
  }

  get apps(): ObservableArray<NotificationAppRow> {
    return this._apps;
  }

  get status(): string {
    return this._status;
  }

  onRefreshTap(): void {
    this.refresh();
  }

  onNotificationAppTap(args: { index?: number }): void {
    const index = Number(args.index);
    if (!Number.isInteger(index) || index < 0 || index >= this._apps.length) return;
    const app = this._apps.getItem(index);
    if (!app) return;
    this.togglePackage(app);
  }

  onResetPrioritiesTap(): void {
    notificationAppTiersSetting.set("{}");
    this._status = "Per-app priorities reset to Default.";
    this.notifyPropertyChange("status", this._status);
    this.refreshRows();
  }

  onBackTap(): void {
    Frame.topmost()?.goBack();
  }

  private refresh(): void {
    const apps = readInstalledNotificationApps();
    this.replaceRows(apps);
    this._status = apps.length
      ? `${apps.length} installed apps. Use Allow or Block for each notification source.`
      : "No installed apps could be read. Grant notification access, then refresh.";
    this.notifyPropertyChange("status", this._status);
  }

  private refreshRows(): void {
    this.replaceRows(Array.from(this._apps));
  }

  private replaceRows(apps: readonly AndroidNotificationApp[]): void {
    const selected = new Set(parseNotificationAllowedPackages());
    const tiers = parseNotificationAppTiers();
    const rows = apps
      .map((app): NotificationAppRow => {
        const tier = tiers[app.packageName] ?? "default";
        const enabled = selected.has(app.packageName);
        return {
          ...app,
          enabledGlyph: enabled ? "✓" : "○",
          detail: `${app.appName || app.packageName} · ${app.packageName}`,
          toggleLabel: enabled ? "Block" : "Allow",
          toggleAccessibilityLabel: `${enabled ? "Block" : "Allow"} ${app.appName || app.packageName} notifications`,
          onToggleTap: () => this.togglePackage(app),
          tierLabel: `Priority: ${tier[0]!.toUpperCase()}${tier.slice(1)}`,
          onTierTap: () => {
            const current = parseNotificationAppTiers()[app.packageName] ?? "default";
            const next = TIER_ORDER[(TIER_ORDER.indexOf(current) + 1) % TIER_ORDER.length]!;
            setNotificationAppTier(app.packageName, next);
            this._status = `${app.appName} priority: ${next}.`;
            this.notifyPropertyChange("status", this._status);
            this.refreshRows();
          },
        };
      })
      .sort((a, b) => a.appName.localeCompare(b.appName));
    this._apps.splice(0, this._apps.length, ...rows);
    this.notifyPropertyChange("apps", this.apps);
  }

  private togglePackage(app: AndroidNotificationApp): void {
    const next = toggleAllowedNotificationPackage(
      parseNotificationAllowedPackages(),
      app.packageName,
    );
    notificationAllowedPackagesSetting.set(next.join(","));
    const allowed = next.includes(app.packageName);
    this._status = `${app.appName || app.packageName} ${allowed ? "allowed" : "blocked"}.`;
    this.notifyPropertyChange("status", this._status);
    this.refreshRows();
  }
}
