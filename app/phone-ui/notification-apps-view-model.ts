import { Frame, Observable, ObservableArray } from "@nativescript/core";

import {
  notificationAllowedPackagesSetting,
  onAnySettingChanged,
  parseNotificationAllowedPackages,
} from "../ui/dashboard-settings";
import { readInstalledNotificationApps, type AndroidNotificationApp } from "../native/notification-icons";

type NotificationAppRow = AndroidNotificationApp & {
  enabledGlyph: string;
  detail: string;
};

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

  onBackTap(): void {
    Frame.topmost()?.navigate({ moduleName: "phone-ui/glasses-controls-page", clearHistory: true });
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
    const rows = apps
      .map((app): NotificationAppRow => ({
        ...app,
        enabledGlyph: selected.has(app.packageName) ? "✓" : "○",
        detail: `${app.appName || app.packageName} · ${app.packageName}`,
      }))
      .sort((a, b) => a.appName.localeCompare(b.appName));
    this._apps.splice(0, this._apps.length, ...rows);
    this.notifyPropertyChange("apps", this.apps);
  }
}
