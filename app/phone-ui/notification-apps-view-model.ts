import { Frame, Observable, ObservableArray } from "@nativescript/core";

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

type NotificationAppRow = AndroidNotificationApp & {
  enabledGlyph: string;
  detail: string;
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
    this.unsubscribeSettings = onAnySettingChanged(() => this.refreshRows());
  }

  dispose(): void {
    this.unsubscribeSettings?.();
    this.unsubscribeSettings = null;
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
    const selected = new Set(parseNotificationAllowedPackages());
    if (selected.has(app.packageName)) {
      selected.delete(app.packageName);
    } else {
      selected.add(app.packageName);
    }
    notificationAllowedPackagesSetting.set(Array.from(selected).sort().join(","));
    this._status = `${app.appName} ${selected.has(app.packageName) ? "allowed" : "blocked"}.`;
    this.notifyPropertyChange("status", this._status);
    this.refreshRows();
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
      ? `${apps.length} installed apps. Tap an app to allow or block its notifications.`
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
        return {
          ...app,
          enabledGlyph: selected.has(app.packageName) ? "✓" : "○",
          detail: `${app.appName || app.packageName} · ${app.packageName}`,
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
}
