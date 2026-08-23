import { assistantBridge } from "../../assistant/bridge-client";
import { getDefaultMediumFont, getDefaultSmallFont } from "../../graphics/bdffont";
import { GrayImage } from "../../graphics/image";
import { truncateText, wrapText } from "../../graphics/textwrap";
import { readUpcomingEvents } from "../../native/calendar";
import {
  canonicalPath,
  hasAllFilesAccess,
  listDirectory,
  statPath,
} from "../../native/file-access";
import { isNotificationListenerEnabled } from "../../native/notification-access";
import {
  readActiveNotifications,
  readNotificationByKey,
} from "../../native/notification-icons";
import { SearchController, type SearchSourceId } from "../../search/core";
import { createSearchProviders } from "../../search/providers";
import { SearchViewModel } from "../../search/view-model";
import { type AppContext } from "../app-definition";
import { getBookmarkedPaths } from "../files/file-browser";
import { type DashboardInputEvent, type Layer, type LayerContext } from "../../ui/layers";
import { drawSelectionHighlight, type MenuItem } from "../../ui/menu";
import {
  createInProcessWindow,
  type InProcessAppOptions,
  type InProcessWindow,
} from "../../ui/shell/in-process-window";
import { shell } from "../../ui/shell/shell";

export const UNIVERSAL_SEARCH_WINDOW_ID = "universal-search";
export const UNIVERSAL_SEARCH_SURFACE_ID = "window:universal-search";
const SOURCE_FILTERS: ReadonlyArray<{ id: SearchSourceId; label: string }> = [
  { id: "apps", label: "Apps" },
  { id: "calendar", label: "Calendar" },
  { id: "notifications", label: "Notifications" },
  { id: "files", label: "Files" },
  { id: "hermes_sessions", label: "Hermes sessions" },
  { id: "roam", label: "Roam (unavailable)" },
  { id: "terminal", label: "Terminal (unavailable)" },
  { id: "media", label: "Media (unavailable)" },
  { id: "health", label: "Health (unavailable)" },
];
function formatFreshness(freshnessMs: number): string {
  if (freshnessMs <= 0) return "static";
  return new Date(freshnessMs).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

class SearchDetailLayer implements Layer {
  constructor(private readonly title: string, private readonly lines: readonly string[]) {}

  paint(ctx: LayerContext): GrayImage {
    const { width, height } = ctx.stack.getBaseSize();
    const image = new GrayImage(width, height, 0);
    const medium = getDefaultMediumFont();
    const small = getDefaultSmallFont();
    image.drawText(medium, 24, 14, truncateText(medium, this.title, width - 48), 235);
    image.drawLine(24, 38, width - 24, 38, 70);
    let y = 52;
    for (const paragraph of this.lines) {
      for (const line of wrapText(small, paragraph, width - 48).slice(0, 3)) {
        if (y >= height - 34) break;
        image.drawText(small, 24, y, line, 175);
        y += small.lineHeight + 5;
      }
    }
    image.drawText(small, 24, height - 22, "double-click back", 95);
    return image;
  }

  handleInput(event: DashboardInputEvent, ctx: LayerContext): void {
    if (event.type === "double-click") ctx.stack.pop();
  }
}

class UniversalSearchLayer implements Layer {
  private readonly model = new SearchViewModel(["apps"], 4);
  private readonly controller: SearchController;
  private requestRender = () => {};
  private stopped = false;
  private actionStatus = "";

  constructor(private readonly appContext: AppContext) {
    const pushDetail = (title: string, lines: readonly string[]) => {
      if (this.stopped || !this.stack) return false;
      this.stack.push(new SearchDetailLayer(title, lines));
      return true;
    };
    this.controller = new SearchController(createSearchProviders({
      apps: () => appContext.apps,
      launchApp: async (appId, signal) => {
        if (signal.aborted || !appContext.apps.some((app) => app.appId === appId && app.showInLauncher !== false)) return false;
        if (signal.aborted) return false;
        await appContext.launchApp(appId);
        return true;
      },
      readCalendar: () => readUpcomingEvents(),
      openCalendar: async (eventId, startMs, signal) => {
        if (signal.aborted) return false;
        const read = readUpcomingEvents();
        if (read.status !== "success") return false;
        const event = read.events.find((event) => event.id === eventId && event.startMs === startMs);
        return event && !signal.aborted ? pushDetail(event.title || "Calendar event", [
          new Date(event.startMs).toLocaleString(),
          event.location,
          event.calendarName,
        ].filter(Boolean)) : false;
      },
      notificationAccess: () => isNotificationListenerEnabled(),
      readNotifications: () => readActiveNotifications(50),
      openNotification: async (key, postTime, signal) => {
        if (signal.aborted || !isNotificationListenerEnabled()) return false;
        const notification = readNotificationByKey(key);
        if (!notification || notification.postTime !== postTime || signal.aborted) return false;
        return pushDetail(notification.title || notification.appName || "Notification", [
          notification.appName,
          notification.sender,
          notification.bigText || notification.text || notification.lines.join(" · "),
        ].filter(Boolean));
      },
      hasFileAccess: () => hasAllFilesAccess(),
      bookmarkedPaths: () => getBookmarkedPaths(),
      statPath,
      listDirectory,
      openFile: async (path, rootPath, modifiedMs, signal) => {
        if (signal.aborted || !hasAllFilesAccess() || !getBookmarkedPaths().includes(rootPath)) return false;
        const rootEntry = statPath(rootPath);
        if (!rootEntry || rootEntry.isSymbolicLink) return false;
        const canonicalRoot = canonicalPath(rootPath);
        const canonicalEntry = canonicalPath(path);
        const inScope = canonicalRoot !== null && canonicalEntry !== null &&
          (canonicalEntry === canonicalRoot || canonicalEntry.startsWith(`${canonicalRoot.replace(/\/+$/, "")}/`));
        const entry = inScope ? statPath(path) : null;
        if (!entry || entry.isSymbolicLink || entry.modifiedMs !== modifiedMs || signal.aborted) return false;
        return pushDetail(entry.name, [entry.isDirectory ? "Folder" : "File", `${entry.sizeBytes} bytes`, "Bookmarked location"]);
      },
      cockpitSnapshot: () => assistantBridge.cockpit.snapshot(),
      openHermesSession: async (sessionId, generation, signal) => {
        if (signal.aborted) return false;
        const snapshot = assistantBridge.cockpit.snapshot();
        if (!snapshot.synchronized) return false;
        const session = snapshot.sessions.find((session) => session.session_id === sessionId && session.generation === generation);
        return session && !signal.aborted ? pushDetail(session.title, [session.summary ?? "", session.state]) : false;
      },
    }), { providerTimeoutMs: 1500, resultLimit: 40 });
  }

  private stack: LayerContext["stack"] | null = null;

  bindRender(requestRender: () => void): void {
    this.requestRender = requestRender;
  }

  stop(): void {
    this.stopped = true;
    this.controller.dispose();
  }

  onRemoved(): void {
    this.stop();
  }

  receiveReviewedQuery(text: string): void {
    if (this.stopped) return;
    this.actionStatus = "";
    void this.runSearch(text);
  }

  menuItems(): MenuItem[] {
    const enabled = new Set(this.model.enabledSources());
    return [
      ...SOURCE_FILTERS.map(({ id, label }): MenuItem => ({
        label: `${enabled.has(id) ? "✓" : "○"} ${label}`,
        onSelect: (ctx) => {
          ctx.stack.pop();
          this.toggleSource(id);
        },
      })),
      {
        label: "Clear query",
        disabled: () => !this.model.screen().query,
        onSelect: (ctx) => {
          ctx.stack.pop();
          this.controller.dispose();
          this.model.clear();
          this.actionStatus = "Cleared";
          this.requestRender();
        },
      },
    ];
  }

  toggleSource(sourceId: SearchSourceId): void {
    this.model.toggleSource(sourceId);
    const query = this.model.screen().query;
    if (query) void this.runSearch(query);
    else this.requestRender();
  }

  paint(ctx: LayerContext): GrayImage {
    this.stack = ctx.stack;
    const { width, height } = ctx.stack.getBaseSize();
    const image = new GrayImage(width, height, 0);
    const medium = getDefaultMediumFont();
    const small = getDefaultSmallFont();
    const screen = this.model.screen();
    image.drawText(medium, 24, 10, "Search", 240);
    image.drawText(small, 24, 31, truncateText(small, screen.query ? `“${screen.query}”` : "long-press · Voice input", width - 48), 125);
    image.drawLine(24, 47, width - 24, 47, 65);
    let y = 57;
    if (!screen.rows.length) {
      const message = screen.query ? "No matching results" : "Apps only by default. Enable private sources in the window menu.";
      for (const line of wrapText(small, message, width - 48).slice(0, 3)) {
        image.drawText(small, 24, y, line, 145);
        y += small.lineHeight + 5;
      }
    }
    for (const row of screen.rows) {
      if (row.selected) drawSelectionHighlight(image, 19, y - 3, width - 38, 35, true, 5);
      image.drawText(small, 25, y, truncateText(small, `${row.selected ? "›" : " "} ${row.sourceLabel} · ${row.title}`, width - 50), 210);
      image.drawText(small, 35, y + 16, truncateText(small, `${formatFreshness(row.freshnessMs)} · ${row.snippet}`, width - 70), 115);
      y += 40;
    }
    const footer = this.actionStatus || `${screen.page}/${screen.pageCount} · ${screen.status || "filters in menu"}`;
    image.drawLine(24, height - 31, width - 24, height - 31, 60);
    image.drawText(small, 24, height - 22, truncateText(small, footer, width - 48), 95);
    return image;
  }

  async handleInput(event: DashboardInputEvent, ctx: LayerContext): Promise<void> {
    this.stack = ctx.stack;
    if (event.type === "scroll-up") this.model.move(-1);
    else if (event.type === "scroll-down") this.model.move(1);
    else if (event.type === "click") {
      const result = await this.controller.executeAction(this.model.selectedActionHandle());
      if (this.stopped) return;
      this.actionStatus = result === "executed" ? "Opened exact result" : result === "consumed" ? "Already opened" : "Result is no longer available";
      this.requestRender();
    } else if (event.type === "double-click") {
      shell.yieldFocusToSidebar();
    }
  }

  private async runSearch(text: string): Promise<void> {
    const enabled = new Set(this.model.enabledSources());
    await this.controller.search(text, enabled, (state) => {
      if (this.stopped) return;
      this.model.setState(state);
      this.requestRender();
    });
  }
}

export function createUniversalSearchWindow(appContext: AppContext, options: InProcessAppOptions): InProcessWindow {
  let requestRender = () => {};
  const layer = new UniversalSearchLayer(appContext);
  const app = createInProcessWindow({
    appId: "universal-search",
    windowId: UNIVERSAL_SEARCH_WINDOW_ID,
    title: "Search",
    iconLetter: "S",
    icon: "search",
    closeable: true,
    actions: options.actions,
    baseLayer: layer,
    menuItems: () => layer.menuItems(),
    receiveTextInput: (text) => layer.receiveReviewedQuery(text),
    submitFrame: options.submitFrame,
    setSurfaceVisible: options.setSurfaceVisible,
    removeSurface: options.removeSurface,
    onClosed: () => {
      layer.stop();
      options.onClosed();
    },
  });
  requestRender = app.requestRender;
  layer.bindRender(() => requestRender());
  return app;
}
