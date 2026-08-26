import { readUpcomingEvents, type CalendarEvent } from "../native/calendar";
import { readActiveNotifications, type AndroidNotification } from "../native/notification-icons";
import { captureStore } from "../captures/store";
import { workTasksStore } from "../work-tasks/store";

export type AttentionKind = "notification" | "calendar" | "reminder" | "task" | "health";

export type AttentionItem = {
  id: string;
  kind: AttentionKind;
  title: string;
  summary: string;
  priority: number;
  dueAtMs: number;
  unread: boolean;
  stale: boolean;
  source: string;
  text?: string;
};

export type AttentionSnapshot = {
  revision: number;
  available: boolean;
  items: AttentionItem[];
};

export type AttentionSourceInput = {
  notifications?: readonly AndroidNotification[];
  calendarEvents?: readonly CalendarEvent[];
  nowMs?: number;
};

const MAX_ITEMS = 64;

function clone(item: AttentionItem): AttentionItem {
  return { ...item };
}

function priorityForNotification(notification: AndroidNotification): number {
  if (notification.category === "call" || notification.category === "alarm") return 100;
  if (notification.importance >= 4) return 90;
  return 65;
}

function notificationItem(notification: AndroidNotification, nowMs: number): AttentionItem {
  const title = [notification.appName, notification.title].filter(Boolean).join(" · ") || "Notification";
  const summary = notification.bigText || notification.text || notification.summaryText || notification.lines.join(" · ") || "";
  return {
    id: `notification:${notification.key}`,
    kind: "notification",
    title,
    summary,
    priority: priorityForNotification(notification),
    dueAtMs: notification.postTime || notification.when || nowMs,
    unread: true,
    stale: false,
    source: notification.packageName,
    text: [title, summary].filter(Boolean).join("\n"),
  };
}

function calendarItem(event: CalendarEvent, nowMs: number): AttentionItem {
  const title = event.title || "Untitled event";
  const minutes = Math.max(0, Math.round((event.startMs - nowMs) / 60_000));
  const priority = minutes <= 30 ? 95 : minutes <= 120 ? 82 : 58;
  return {
    id: `calendar:${event.id}:${event.startMs}`,
    kind: "calendar",
    title,
    summary: event.allDay ? "All day" : `${new Date(event.startMs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}${event.location ? ` · ${event.location}` : ""}`,
    priority,
    dueAtMs: event.startMs,
    unread: false,
    stale: event.startMs < nowMs,
    source: event.calendarName || "Calendar",
    text: [title, event.location, event.calendarName].filter(Boolean).join("\n"),
  };
}

export function collectAttentionSources(input: AttentionSourceInput = {}): AttentionItem[] {
  const nowMs = input.nowMs ?? Date.now();
  const notifications = input.notifications ?? readActiveNotifications(32);
  const calendar = input.calendarEvents ?? (() => {
    const result = readUpcomingEvents(32);
    return result.status === "success" ? result.events : [];
  })();
  const items = [
    ...notifications.map((notification) => notificationItem(notification, nowMs)),
    ...calendar.map((event) => calendarItem(event, nowMs)),
    ...workTasksStore.snapshot().tasks
      .filter((task) => task.lane !== "done")
      .map((task): AttentionItem => ({
        id: `task:${task.id}`,
        kind: "task",
        title: task.title,
        summary: `${task.lane}${task.blocked ? " · blocked" : ""}`,
        priority: task.blocked ? 86 : task.lane === "today" ? 78 : 52,
        dueAtMs: task.updatedAtMs,
        unread: task.lane === "inbox",
        stale: false,
        source: "Work Tasks",
        text: task.title,
      })),
    ...captureStore.snapshot().captures.map((capture): AttentionItem => ({
      id: `capture:${capture.id}`,
      kind: "reminder",
      title: "Capture",
      summary: capture.text,
      priority: 44,
      dueAtMs: capture.updatedAtMs,
      unread: true,
      stale: false,
      source: "Captures",
      text: capture.text,
    })),
  ];
  const byId = new Map<string, AttentionItem>();
  for (const item of items) byId.set(item.id, item);
  return Array.from(byId.values())
    .sort((left, right) => right.priority - left.priority || left.dueAtMs - right.dueAtMs || left.id.localeCompare(right.id))
    .slice(0, MAX_ITEMS)
    .map(clone);
}

export class AttentionHubStore {
  private revisionValue = 0;
  private items: AttentionItem[] = [];
  private readonly listeners = new Set<(snapshot: AttentionSnapshot) => void>();

  snapshot(): AttentionSnapshot {
    return { revision: this.revisionValue, available: true, items: this.items.map(clone) };
  }

  onChange(listener: (snapshot: AttentionSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  refresh(input: AttentionSourceInput = {}): AttentionSnapshot {
    this.items = collectAttentionSources(input);
    this.revisionValue = Math.min(Number.MAX_SAFE_INTEGER, this.revisionValue + 1);
    const snapshot = this.snapshot();
    for (const listener of Array.from(this.listeners)) {
      try { listener(snapshot); } catch { /* observer boundary */ }
    }
    return snapshot;
  }

  markRead(id: string): void {
    const item = this.items.find((candidate) => candidate.id === id);
    if (!item || !item.unread) return;
    item.unread = false;
    this.revisionValue++;
    this.emit();
  }

  dismiss(id: string): void {
    const next = this.items.filter((item) => item.id !== id);
    if (next.length === this.items.length) return;
    this.items = next;
    this.revisionValue++;
    this.emit();
  }

  private emit(): void {
    const snapshot = this.snapshot();
    for (const listener of Array.from(this.listeners)) {
      try { listener(snapshot); } catch { /* observer boundary */ }
    }
  }
}

export const attentionHubStore = new AttentionHubStore();
