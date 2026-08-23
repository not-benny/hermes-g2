import {
  SearchProviderFailure,
  type SearchActionDescriptor,
  type SearchActionOutcome,
  type SearchProvider,
  type SearchResult,
} from "./core";

type SearchApp = { appId: string; title: string; showInLauncher?: boolean };
type CalendarEventLike = {
  id: number; title: string; location: string; calendarName: string;
  startMs: number; endMs: number; allDay: boolean;
};
type CalendarReadLike =
  | { status: "success"; events: readonly CalendarEventLike[] }
  | { status: "permission_denied" | "provider_unavailable" | "query_failed" };
type NotificationLike = {
  key: string; appName: string; title: string; text: string; bigText: string;
  sender: string; lines: readonly string[]; postTime: number; when: number;
};
type FileEntryLike = {
  name: string; path: string; isDirectory: boolean; sizeBytes: number; modifiedMs: number;
};
type CockpitSessionLike = {
  session_id: string; generation: number; revision: number; title: string;
  summary?: string; updated_at_ms: number;
};
type CockpitSnapshotLike = { synchronized: boolean; sessions: readonly CockpitSessionLike[] };

export type SearchProviderDependencies = {
  apps: () => readonly SearchApp[];
  launchApp: (appId: string) => Promise<boolean>;
  readCalendar: () => CalendarReadLike;
  openCalendar: (eventId: number, startMs: number) => Promise<boolean>;
  notificationAccess: () => boolean;
  readNotifications: () => readonly NotificationLike[];
  openNotification: (key: string) => Promise<boolean>;
  hasFileAccess: () => boolean;
  bookmarkedPaths: () => readonly string[];
  statPath: (path: string) => FileEntryLike | null;
  listDirectory: (path: string) => readonly FileEntryLike[] | null;
  openFile: (path: string, modifiedMs: number) => Promise<boolean>;
  cockpitSnapshot: () => CockpitSnapshotLike;
  openHermesSession: (sessionId: string, generation: number) => Promise<boolean>;
};

const MAX_PROVIDER_RESULTS = 40;

function clean(value: unknown, limit: number): string {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
}

function outcome(value: boolean): SearchActionOutcome {
  return value ? "executed" : "stale";
}

function applicationsProvider(deps: SearchProviderDependencies): SearchProvider {
  return {
    sourceId: "apps",
    label: "Apps",
    privacyClass: "public_metadata",
    search: async () => deps.apps()
      .filter((app) => app.showInLauncher !== false)
      .slice(0, MAX_PROVIDER_RESULTS)
      .map((app): SearchResult => ({
        sourceId: "apps",
        resultId: clean(app.appId, 80),
        title: clean(app.title, 120),
        snippet: "App",
        freshnessMs: 0,
        action: { kind: "open_app", appId: clean(app.appId, 80) },
      })),
    execute: async (action) => action.kind === "open_app" ? outcome(await deps.launchApp(action.appId)) : "denied",
  };
}

function calendarProvider(deps: SearchProviderDependencies): SearchProvider {
  return {
    sourceId: "calendar",
    label: "Calendar",
    privacyClass: "private_content",
    search: async () => {
      const read = deps.readCalendar();
      if (read.status === "permission_denied") throw new SearchProviderFailure("permission_denied");
      if (read.status === "provider_unavailable") throw new SearchProviderFailure("unavailable");
      if (read.status === "query_failed") throw new SearchProviderFailure("error");
      if (read.status !== "success") throw new SearchProviderFailure("error");
      return read.events.slice(0, MAX_PROVIDER_RESULTS).map((event): SearchResult => ({
        sourceId: "calendar",
        resultId: `${event.id}:${event.startMs}`,
        title: clean(event.title || "Untitled event", 120),
        snippet: clean([event.location, event.calendarName].filter(Boolean).join(" · "), 240),
        freshnessMs: event.startMs,
        action: { kind: "open_calendar_event", eventId: event.id, startMs: event.startMs },
      }));
    },
    execute: async (action) => {
      if (action.kind !== "open_calendar_event") return "denied";
      return outcome(await deps.openCalendar(action.eventId, action.startMs));
    },
  };
}

function notificationsProvider(deps: SearchProviderDependencies): SearchProvider {
  return {
    sourceId: "notifications",
    label: "Notifications",
    privacyClass: "private_content",
    search: async () => {
      if (!deps.notificationAccess()) throw new SearchProviderFailure("permission_denied");
      return deps.readNotifications().slice(0, MAX_PROVIDER_RESULTS).map((notification): SearchResult => ({
        sourceId: "notifications",
        resultId: clean(notification.key, 160),
        title: clean([notification.appName, notification.title].filter(Boolean).join(" · "), 120),
        snippet: clean(notification.bigText || notification.text || notification.lines.join(" · "), 240),
        freshnessMs: notification.postTime || notification.when || 0,
        action: { kind: "open_notification", notificationKey: clean(notification.key, 240) },
      }));
    },
    execute: async (action) => {
      if (action.kind !== "open_notification" || !deps.notificationAccess()) return "stale";
      return outcome(await deps.openNotification(action.notificationKey));
    },
  };
}

function filesProvider(deps: SearchProviderDependencies): SearchProvider {
  return {
    sourceId: "files",
    label: "Files",
    privacyClass: "private_content",
    search: async () => {
      if (!deps.hasFileAccess()) throw new SearchProviderFailure("permission_denied");
      const results: SearchResult[] = [];
      for (const bookmark of deps.bookmarkedPaths().slice(0, 20)) {
        const root = deps.statPath(bookmark);
        if (!root) continue;
        const entries = root.isDirectory ? deps.listDirectory(root.path) : [root];
        if (entries === null) throw new SearchProviderFailure("error");
        for (const entry of entries.slice(0, MAX_PROVIDER_RESULTS - results.length)) {
          results.push({
            sourceId: "files",
            resultId: clean(entry.path, 160),
            title: clean(entry.name || "File", 120),
            snippet: entry.isDirectory ? "Folder · bookmarked location" : "File · bookmarked location",
            freshnessMs: entry.modifiedMs,
            action: { kind: "open_file", path: clean(entry.path, 1000), modifiedMs: entry.modifiedMs },
          });
        }
        if (results.length >= MAX_PROVIDER_RESULTS) break;
      }
      return results;
    },
    execute: async (action) => {
      if (action.kind !== "open_file" || !deps.hasFileAccess()) return "stale";
      return outcome(await deps.openFile(action.path, action.modifiedMs));
    },
  };
}

function hermesSessionsProvider(deps: SearchProviderDependencies): SearchProvider {
  return {
    sourceId: "hermes_sessions",
    label: "Hermes",
    privacyClass: "private_content",
    search: async () => {
      const snapshot = deps.cockpitSnapshot();
      if (!snapshot.synchronized) throw new SearchProviderFailure("offline");
      return snapshot.sessions.slice(0, MAX_PROVIDER_RESULTS).map((session): SearchResult => ({
        sourceId: "hermes_sessions",
        resultId: `${clean(session.session_id, 120)}:${session.generation}`,
        title: clean(session.title, 120),
        snippet: clean(session.summary, 240),
        freshnessMs: session.updated_at_ms,
        action: {
          kind: "open_hermes_session",
          sessionId: clean(session.session_id, 160),
          generation: session.generation,
        },
      }));
    },
    execute: async (action) => action.kind === "open_hermes_session"
      ? outcome(await deps.openHermesSession(action.sessionId, action.generation))
      : "denied",
  };
}

function unavailableProvider(
  sourceId: "roam" | "terminal" | "media" | "health",
  label: string,
  privacyClass: "private_content" | "restricted_health" | "terminal_content",
): SearchProvider {
  return {
    sourceId,
    label,
    privacyClass,
    search: async () => { throw new SearchProviderFailure("unavailable"); },
  };
}

export function createSearchProviders(deps: SearchProviderDependencies): readonly SearchProvider[] {
  return [
    applicationsProvider(deps),
    calendarProvider(deps),
    notificationsProvider(deps),
    filesProvider(deps),
    hermesSessionsProvider(deps),
    unavailableProvider("roam", "Roam", "private_content"),
    unavailableProvider("terminal", "Terminal", "terminal_content"),
    unavailableProvider("media", "Media", "private_content"),
    unavailableProvider("health", "Health", "restricted_health"),
  ];
}
