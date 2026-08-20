import { File, knownFolders } from "@nativescript/core";

/**
 * Persistence for whether the shell's Health side card is hidden, so the choice
 * survives a restart. Mirrors open-apps-persistence: versioned JSON in the docs
 * dir, a debounced writer, and a default-on-error reader (default: visible).
 */

const STATE_VERSION = 1;
const FILE_NAME = "health-tab.json";
const WRITE_DELAY_MS = 1000;

function filePath(): string {
  return `${knownFolders.documents().path}/${FILE_NAME}`;
}

/** Whether the Health card was hidden; false (visible) if missing or unreadable. */
export function loadHealthTabHidden(): boolean {
  try {
    const path = filePath();
    if (!File.exists(path)) return false;
    const parsed = JSON.parse(File.fromPath(path).readTextSync()) as { version?: number; hidden?: unknown };
    if (parsed.version !== STATE_VERSION) return false;
    return parsed.hidden === true;
  } catch (error) {
    console.warn("health-tab state read failed", error);
    return false;
  }
}

let writeTimer: ReturnType<typeof setTimeout> | null = null;
let pendingHidden: boolean | null = null;

/** Save the hidden flag (debounced; the latest value wins). */
export function saveHealthTabHidden(hidden: boolean): void {
  pendingHidden = hidden;
  if (writeTimer !== null) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    const value = pendingHidden;
    pendingHidden = null;
    if (value === null) return;
    try {
      File.fromPath(filePath()).writeTextSync(JSON.stringify({ version: STATE_VERSION, hidden: value }));
    } catch (error) {
      console.warn("health-tab state write failed", error);
    }
  }, WRITE_DELAY_MS);
}
