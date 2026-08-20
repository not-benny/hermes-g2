import { Frame, Observable, ObservableArray } from "@nativescript/core";

import {
  mediaHiddenPackagesSetting,
  onAnySettingChanged,
  parseMediaHiddenPackages,
} from "../ui/dashboard-settings";
import { mediaBrowserBridge, type MediaBrowserApp } from "../native/media-browser";

type MediaAppRow = MediaBrowserApp & {
  enabledGlyph: string;
  detail: string;
};

/**
 * Manage which media-browser apps appear in the Music "Browse library" picker.
 * Mirrors the notification-apps page: a tap toggles an app between shown and
 * hidden. Semantics are a HIDE set (empty means every source is shown), so the
 * junk sources (Bixby, Edge, TikTok, ...) can be turned off.
 */
export class MediaAppsViewModel extends Observable {
  private readonly _apps = new ObservableArray<MediaAppRow>();
  private _status = "Loading media sources...";
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

  get apps(): ObservableArray<MediaAppRow> {
    return this._apps;
  }

  get status(): string {
    return this._status;
  }

  onRefreshTap(): void {
    this.refresh();
  }

  onMediaAppTap(args: { index?: number }): void {
    const index = Number(args.index);
    if (!Number.isInteger(index) || index < 0 || index >= this._apps.length) return;
    const app = this._apps.getItem(index);
    if (!app) return;
    const hidden = new Set(parseMediaHiddenPackages());
    if (hidden.has(app.packageName)) hidden.delete(app.packageName);
    else hidden.add(app.packageName);
    mediaHiddenPackagesSetting.set(Array.from(hidden).sort().join(","));
    this._status = `${app.appName || app.packageName} ${hidden.has(app.packageName) ? "hidden" : "shown"}.`;
    this.notifyPropertyChange("status", this._status);
    this.refreshRows();
  }

  onBackTap(): void {
    Frame.topmost()?.goBack();
  }

  private refresh(): void {
    const apps = mediaBrowserBridge.listBrowsableApps(true);
    this.replaceRows(apps);
    this._status = apps.length
      ? `${apps.length} media sources. Tap to show or hide one in the Browse library picker.`
      : "No media-browser apps found. Open a media app, then refresh.";
    this.notifyPropertyChange("status", this._status);
  }

  private refreshRows(): void {
    this.replaceRows(Array.from(this._apps));
  }

  private replaceRows(apps: readonly MediaBrowserApp[]): void {
    const hidden = new Set(parseMediaHiddenPackages());
    const rows = apps
      .map((app): MediaAppRow => ({
        ...app,
        enabledGlyph: hidden.has(app.packageName) ? "○" : "✓",
        detail: `${app.appName || app.packageName} · ${app.packageName}`,
      }))
      .sort((a, b) => (a.appName || a.packageName).localeCompare(b.appName || b.packageName));
    this._apps.splice(0, this._apps.length, ...rows);
    this.notifyPropertyChange("apps", this.apps);
  }
}
