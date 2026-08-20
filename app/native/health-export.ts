/**
 * Impure adapter for ring-health historic logging + export. Persists a rolling
 * DailyHealthSummary[] via ApplicationSettings, writes a CSV file the user can
 * share, and can push the history JSON to the Hermes bridge. All pure math is in
 * app/health/health-history.ts + health-insights.ts; this module only does IO.
 */

import { ApplicationSettings, File, Http, Utils, knownFolders } from "@nativescript/core";

import {
  summarizeDay,
  upsertSummary,
  dateKeyOf,
  type DailyHealthSummary,
  type DaySummaryInputs,
} from "../health/health-history";
import { buildHourlyPoints, upsertHourly, type HourlyPoint } from "../health/health-hourly";
import { canonicalizeActivitySnapshot, type RingActivitySnapshot } from "../health/ring-health-store";
import {
  assistantBridgeHostSetting,
  assistantBridgePortSetting,
  assistantBridgeTokenSetting,
} from "../ui/dashboard-settings";

const HISTORY_KEY = "health.history.v1";
const HOURLY_KEY = "health.hourly.v1";
const ACTIVITY_KEY = "health.activity.v1";
const MAX_DAYS = 90;

/**
 * User consent to share ring health with the Hermes bridge. Off by default:
 * nothing leaves the device until the user turns the toggle on, after which the
 * Health tab pushes on an interval while the app is running.
 */
const HERMES_CONSENT_KEY = "health.hermes.consent.v1";

export function getHermesConsent(): boolean {
  return ApplicationSettings.getBoolean(HERMES_CONSENT_KEY, false);
}

export function setHermesConsent(on: boolean): void {
  ApplicationSettings.setBoolean(HERMES_CONSENT_KEY, on);
}

export function loadHealthHistory(): DailyHealthSummary[] {
  try {
    const raw = ApplicationSettings.getString(HISTORY_KEY, "");
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as DailyHealthSummary[]) : [];
  } catch {
    return [];
  }
}

function saveHealthHistory(history: DailyHealthSummary[]): void {
  try {
    ApplicationSettings.setString(HISTORY_KEY, JSON.stringify(history));
  } catch (error) {
    console.error(`[health-export] save failed: ${error}`);
  }
}

/**
 * Log today's summary: merges into the stored day (never erasing earlier values
 * with nulls) and persists. Call periodically from the Health view-model.
 */
export function recordHealthDay(inputs: DaySummaryInputs): DailyHealthSummary[] {
  const dateKey = dateKeyOf(inputs.updatedAtMs);
  const summary = summarizeDay(dateKey, inputs);
  const history = upsertSummary(loadHealthHistory(), summary, MAX_DAYS);
  saveHealthHistory(history);
  return history;
}

/** Minimal per-hour record shape from the ring parser (hourIdx + avg/max/min). */
type RingHour = { hourIdx: number; avg: number; max: number; min: number };

export function loadHourly(): HourlyPoint[] {
  try {
    const raw = ApplicationSettings.getString(HOURLY_KEY, "");
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as HourlyPoint[]) : [];
  } catch {
    return [];
  }
}

function saveHourly(points: HourlyPoint[]): void {
  try {
    ApplicationSettings.setString(HOURLY_KEY, JSON.stringify(points));
  } catch (error) {
    console.error(`[health-export] hourly save failed: ${error}`);
  }
}

/**
 * Merge this poll's hour records into the persisted hourly history (accumulate,
 * never erase) and save. This is what turns the ring's transient recent-hours
 * push into a lasting hour-by-hour record across days.
 */
export function recordHourly(hr: RingHour[], spo2: RingHour[], hrv: RingHour[], nowMs: number): HourlyPoint[] {
  const points = buildHourlyPoints(hr, spo2, hrv, nowMs);
  const stored = loadHourly();
  if (points.length === 0) return stored;
  const merged = upsertHourly(stored, points, nowMs, MAX_DAYS);
  saveHourly(merged);
  return merged;
}

/** Load today's locally accumulated 10-minute ring activity buckets. */
export function loadActivity(nowMs = Date.now()): RingActivitySnapshot | null {
  try {
    const raw = ApplicationSettings.getString(ACTIVITY_KEY, "");
    if (!raw) return null;
    return canonicalizeActivitySnapshot(JSON.parse(raw), nowMs);
  } catch {
    return null;
  }
}

/** Persist the store's merge-safe current-day activity snapshot. */
export function recordActivity(activity: RingActivitySnapshot | null): void {
  if (!activity) return;
  try {
    ApplicationSettings.setString(ACTIVITY_KEY, JSON.stringify(activity));
  } catch (error) {
    console.error(`[health-export] activity save failed: ${error}`);
  }
}

/** The consolidated export document (JSON): the same shape the Hermes push sends. */
function healthExportDocument(): string {
  return JSON.stringify(
    { source: "hermes-g2", exportedAt: dateKeyOf(Date.now()), history: loadHealthHistory(), hourly: loadHourly(), activity: loadActivity() },
    null,
    2,
  );
}

/** Write the history to a JSON file in the app documents dir; returns the path. */
export function writeHealthJson(): string {
  const path = `${knownFolders.documents().path}/hermes-health-${dateKeyOf(Date.now())}.json`;
  const file = File.fromPath(path);
  file.writeTextSync(healthExportDocument(), (err) => {
    if (err) console.error(`[health-export] json write failed: ${err}`);
  });
  return path;
}

/**
 * Share the health history as a real JSON file, not inline text: the file is
 * written to disk and handed to the Android share chooser as a content:// URI
 * via our FileProvider, so it lands as a proper attachment. Returns the on-disk
 * path (the file stays there).
 */
export function shareHealthJson(): string {
  return shareHealthFile(writeHealthJson(), "application/json");
}

function shareHealthFile(path: string, mime: string): string {
  if (!global.isAndroid) return path;
  try {
    const context = Utils.android.getApplicationContext();
    const authority = `${context.getPackageName()}.fileprovider`;
    const uri = androidx.core.content.FileProvider.getUriForFile(context, authority, new java.io.File(path));
    const intent = new android.content.Intent(android.content.Intent.ACTION_SEND);
    intent.setType(mime);
    intent.putExtra(android.content.Intent.EXTRA_STREAM, uri);
    intent.putExtra(android.content.Intent.EXTRA_SUBJECT, "Hermes G2 ring health export");
    // ClipData carries the grant to the chooser's own preview process too (the
    // bare EXTRA_STREAM grant only reaches the finally-picked target, so the
    // preview thumbnail/name read would otherwise SecurityException).
    intent.setClipData(android.content.ClipData.newRawUri("Hermes G2 health export", uri));
    intent.addFlags(android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION);
    const chooser = android.content.Intent.createChooser(intent, "Export health data");
    chooser.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
    context.startActivity(chooser);
  } catch (error) {
    console.error(`[health-export] share failed: ${error}`);
  }
  return path;
}

/**
 * Push the health history to the Hermes bridge (best-effort). POSTs JSON to
 * http://<bridgeHost>:<bridgePort>/health with the bridge bearer token. Resolves
 * true on 2xx. The bridge ingest endpoint is added on the Hermes side.
 */
export async function pushHealthToHermes(): Promise<boolean> {
  const host = assistantBridgeHostSetting.get().trim();
  const port = assistantBridgePortSetting.get().trim();
  const token = assistantBridgeTokenSetting.get().trim();
  if (!host || !port) {
    console.error("[health-export] hermes push: no bridge host/port configured");
    return false;
  }
  try {
    const res = await Http.request({
      url: `http://${host}:${port}/health`,
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      content: JSON.stringify({ source: "hermes-g2", history: loadHealthHistory(), hourly: loadHourly(), activity: loadActivity() }),
      timeout: 8000,
    });
    const ok = typeof res.statusCode === "number" && res.statusCode >= 200 && res.statusCode < 300;
    if (!ok) console.error(`[health-export] hermes push status ${res.statusCode}`);
    return ok;
  } catch (error) {
    console.error(`[health-export] hermes push failed: ${error}`);
    return false;
  }
}

declare const android: any;
declare const androidx: any;
declare const java: any;
declare const global: { isAndroid: boolean };
