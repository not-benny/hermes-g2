import { File, knownFolders } from "@nativescript/core";

/**
 * Persistence for the set of open apps, so a restart (usually installing a new
 * development build) reopens the same windows. Deliberately shallow: only
 * which apps were open and which was foreground, not within-app state.
 */

export type PersistedOpenApps = {
  /** App ids in sidebar (registration) order, launcher excluded. */
  open: string[];
  foreground: string | null;
};

const STATE_VERSION = 1;
const FILE_NAME = "open-apps.json";
// Coalesces bursts (restore, sidebar scrolling) into one write; short enough
// that a build-reinstall kill right after a change rarely loses it.
const WRITE_DELAY_MS = 1000;

function openAppsFilePath(): string {
  return `${knownFolders.documents().path}/${FILE_NAME}`;
}

/** The saved open-app state, or an empty state if missing or unreadable. */
export function loadPersistedOpenApps(): PersistedOpenApps {
  const empty: PersistedOpenApps = { open: [], foreground: null };
  try {
    const path = openAppsFilePath();
    if (!File.exists(path)) return empty;
    const parsed = JSON.parse(File.fromPath(path).readTextSync()) as {
      version?: number;
      open?: unknown;
      foreground?: unknown;
    };
    if (parsed.version !== STATE_VERSION || !Array.isArray(parsed.open)) return empty;
    const open: string[] = [];
    for (const value of parsed.open) {
      if (typeof value !== "string") continue;
      // Transcribe was replaced by Conversate. Preserve a user's open-window
      // intent across an install without keeping a second legacy launcher app.
      const migratedAppId = value === "transcribe" ? "conversate" : value;
      const appId = migratedAppId === "timer" ? "clock" : migratedAppId;
      // Terminal/G2Mirror is intentionally retired from every reachable UI.
      // Ignore an old persisted window without deleting its dormant settings.
      if (appId === "terminal") continue;
      if (!open.includes(appId)) open.push(appId);
    }
    const foreground = typeof parsed.foreground === "string"
      ? parsed.foreground === "terminal"
        ? null
        : parsed.foreground === "transcribe" ? "conversate"
          : parsed.foreground === "timer" ? "clock" : parsed.foreground
      : null;
    return { open, foreground };
  } catch (error) {
    console.warn("open-apps state read failed", error);
    return empty;
  }
}

let writeTimer: ReturnType<typeof setTimeout> | null = null;
let pendingState: PersistedOpenApps | null = null;

/** Save the open-app state (debounced; the latest state wins). */
export function savePersistedOpenApps(state: PersistedOpenApps): void {
  pendingState = state;
  if (writeTimer !== null) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    const state = pendingState;
    pendingState = null;
    if (!state) return;
    try {
      File.fromPath(openAppsFilePath()).writeTextSync(
        JSON.stringify({ version: STATE_VERSION, ...state }),
      );
    } catch (error) {
      console.warn("open-apps state write failed", error);
    }
  }, WRITE_DELAY_MS);
}
