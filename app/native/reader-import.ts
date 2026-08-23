import { AndroidApplication, Application, isAndroid } from "@nativescript/core";
import { dashboardController } from "../g2/dashboard-controller";
import { decodeReaderProgress } from "../apps/files/reader-core";
import { getStringSetting } from "./settings-store";

declare const android: any;
declare const java: any;

export const MAX_READER_IMPORT_BYTES = 512_000;
const READER_REQUEST_CODE = 0x5244;
let registered = false;

type ImportedReaderDocument = {
  uri: string;
  title: string;
  text: string;
};

export function openLocalReaderDocument(): void {
  if (!isAndroid) return;
  ensureReaderResultHandler();
  const activity = Application.android.foregroundActivity ?? Application.android.startActivity;
  if (!activity) throw new Error("No foreground activity is available");
  const intent = new android.content.Intent(android.content.Intent.ACTION_OPEN_DOCUMENT);
  intent.addCategory(android.content.Intent.CATEGORY_OPENABLE);
  intent.setType("text/*");
  const mimeTypes = (Array as any).create("java.lang.String", 3);
  mimeTypes[0] = "text/plain";
  mimeTypes[1] = "text/markdown";
  mimeTypes[2] = "text/x-markdown";
  intent.putExtra(android.content.Intent.EXTRA_MIME_TYPES, mimeTypes);
  intent.addFlags(
    android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION |
      android.content.Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION,
  );
  activity.startActivityForResult(intent, READER_REQUEST_CODE);
}

function ensureReaderResultHandler(): void {
  if (registered) return;
  registered = true;
  Application.android.on(AndroidApplication.activityResultEvent, (args: any) => {
    if (args.requestCode !== READER_REQUEST_CODE || args.resultCode !== android.app.Activity.RESULT_OK) return;
    const uri = args.intent?.getData?.() as any;
    if (!uri) return;
    try {
      const activity = Application.android.foregroundActivity ?? Application.android.startActivity;
      const resolver = activity?.getContentResolver();
      if (!resolver) throw new Error("Document provider is unavailable");
      const flags = args.intent.getFlags() &
        (android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION |
          android.content.Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
      const imported = readReaderDocument(resolver, uri);
      const readFlag = flags & android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION;
      if (!readFlag) throw new Error("Document provider did not grant persistent read access");
      resolver.takePersistableUriPermission(uri, readFlag);
      releaseSupersededReaderGrant(resolver, imported.uri);
      void dashboardController.openLocalTextDocument(imported.title, imported.text, imported.uri);
    } catch (error) {
      dashboardController.reportLocalReaderError(error);
    }
  });
}

function readReaderDocument(
  resolver: any,
  uri: any,
): ImportedReaderDocument {
  const mime = String(resolver.getType(uri) ?? "").toLowerCase();
  if (!mime) throw new Error("Document provider did not identify a text type");
  if (mime !== "text/plain" && mime !== "text/markdown" && mime !== "text/x-markdown") {
    throw new Error("Choose a plain text or Markdown document");
  }
  const stream = resolver.openInputStream(uri);
  if (!stream) throw new Error("The selected document is missing or access was revoked");
  const output = new java.io.ByteArrayOutputStream();
  try {
    const buffer = (Array as any).create("byte", 8192);
    let total = 0;
    let count: number;
    while ((count = stream.read(buffer)) !== -1) {
      total += count;
      if (total > MAX_READER_IMPORT_BYTES) throw new Error("Document is larger than the 512 KB reader limit");
      output.write(buffer, 0, count);
    }
  } finally {
    stream.close();
  }
  const decoder = java.nio.charset.StandardCharsets.UTF_8.newDecoder();
  decoder.onMalformedInput(java.nio.charset.CodingErrorAction.REPORT);
  decoder.onUnmappableCharacter(java.nio.charset.CodingErrorAction.REPORT);
  let text: string;
  try {
    text = String(decoder.decode(java.nio.ByteBuffer.wrap(output.toByteArray())).toString());
  } catch {
    throw new Error("Document is not valid UTF-8 text");
  }
  return { uri: String(uri.toString()), title: queryDisplayName(resolver, uri), text };
}

function releaseSupersededReaderGrant(resolver: any, currentUri: string): void {
  const previous = decodeReaderProgress(getStringSetting("reader.progress.v1", ""));
  if (!previous || previous.uri === currentUri) return;
  try {
    resolver.releasePersistableUriPermission(
      android.net.Uri.parse(previous.uri),
      android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION,
    );
  } catch {
    // The old provider may already have revoked or discarded the grant.
  }
}

function queryDisplayName(resolver: any, uri: any): string {
  const cursor = resolver.query(uri, [android.provider.OpenableColumns.DISPLAY_NAME], null, null, null);
  if (!cursor) return "Local document";
  try {
    if (!cursor.moveToFirst()) return "Local document";
    const index = cursor.getColumnIndex(android.provider.OpenableColumns.DISPLAY_NAME);
    if (index < 0) return "Local document";
    const name = String(cursor.getString(index) ?? "").trim();
    return name.slice(0, 120) || "Local document";
  } finally {
    cursor.close();
  }
}
