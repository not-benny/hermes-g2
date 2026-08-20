/**
 * Explicit user-driven ring-health file export. Canonical persistence is owned
 * solely by health-store.ts; this module only writes and shares a snapshot.
 */

import { File, Utils, knownFolders } from "@nativescript/core";

import { dateKeyOf } from "../health/health-history";
import { loadHealthDocument } from "./health-store";

/** The full canonical local document plus the explicit export timestamp. */
function healthExportDocument(): string {
  return JSON.stringify({ ...loadHealthDocument(), exportedAtMs: Date.now() }, null, 2);
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

declare const android: any;
declare const androidx: any;
declare const java: any;
declare const global: { isAndroid: boolean };
