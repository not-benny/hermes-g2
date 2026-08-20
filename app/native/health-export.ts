/**
 * Impure adapter for ring-health historic logging + export. Persists a rolling
 * DailyHealthSummary[] via ApplicationSettings, writes a CSV file the user can
 * share, and can push the history JSON to the Hermes bridge. All pure math is in
 * app/health/health-history.ts + health-insights.ts; this module only does IO.
 */

import { ApplicationSettings, File, Http, Utils, knownFolders } from "@nativescript/core";

import {
  historyToCsv,
  summarizeDay,
  upsertSummary,
  dateKeyOf,
  type DailyHealthSummary,
  type DaySummaryInputs,
} from "../health/health-history";
import {
  assistantBridgeHostSetting,
  assistantBridgePortSetting,
  assistantBridgeTokenSetting,
} from "../ui/dashboard-settings";

const HISTORY_KEY = "health.history.v1";
const MAX_DAYS = 90;

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

/** Write the full history to a CSV file in the app documents dir; returns the path. */
export function writeHealthCsv(): string {
  const csv = historyToCsv(loadHealthHistory());
  const path = `${knownFolders.documents().path}/hermes-health-${dateKeyOf(Date.now())}.csv`;
  const file = File.fromPath(path);
  file.writeTextSync(csv, (err) => {
    if (err) console.error(`[health-export] csv write failed: ${err}`);
  });
  return path;
}

/**
 * Export the health history as CSV: writes the file and fires an Android share
 * chooser (the CSV as text/csv EXTRA_TEXT, so no FileProvider is required). The
 * file also stays on disk at the returned path.
 */
export function shareHealthCsv(): string {
  const path = writeHealthCsv();
  if (!global.isAndroid) return path;
  try {
    const csv = File.fromPath(path).readTextSync();
    const intent = new android.content.Intent(android.content.Intent.ACTION_SEND);
    intent.setType("text/csv");
    intent.putExtra(android.content.Intent.EXTRA_TEXT, csv);
    intent.putExtra(android.content.Intent.EXTRA_SUBJECT, "Hermes G2 ring health export");
    const chooser = android.content.Intent.createChooser(intent, "Export health CSV");
    chooser.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
    Utils.android.getApplicationContext().startActivity(chooser);
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
      content: JSON.stringify({ source: "hermes-g2", history: loadHealthHistory() }),
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
declare const global: { isAndroid: boolean };
