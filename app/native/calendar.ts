import { Utils } from "@nativescript/core";
import { hasCalendarPermission } from "../g2/android-permissions";
import { spanCurrent } from "./frame-timings";

declare const com: any;

/**
 * Reads upcoming calendar events through the Android Calendar provider
 * (FaceclawCalendarProvider). Results are cached briefly so repeated paints of
 * the Calendar app don't re-run the content-provider query every frame.
 */

export type CalendarEvent = {
  id: number;
  title: string;
  startMs: number;
  endMs: number;
  allDay: boolean;
  location: string;
  calendarName: string;
};

export type CalendarReadResult =
  | { status: "success"; events: CalendarEvent[] }
  | { status: "permission_denied" }
  | { status: "provider_unavailable" }
  | { status: "query_failed" };

const DEFAULT_MAX_EVENTS = 50;
const DEFAULT_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
const CACHE_MS = 30_000;

let cache: { events: CalendarEvent[]; atMs: number; maxEvents: number; windowMs: number } | null = null;
let lastPermissionState: boolean | null = null;

/**
 * Upcoming events from now through the given window, ordered by start time.
 * Returns a discriminated result so failures cannot masquerade as an empty
 * calendar. Successful results are cached for CACHE_MS; pass forceRefresh to
 * bypass the cache (e.g. right after the permission grant).
 */
export function readUpcomingEvents(
  maxEvents = DEFAULT_MAX_EVENTS,
  windowMs = DEFAULT_WINDOW_MS,
  forceRefresh = false,
): CalendarReadResult {
  if (!global.isAndroid) return { status: "provider_unavailable" };
  const permissionGranted = hasCalendarPermission();
  if (lastPermissionState !== permissionGranted) cache = null;
  lastPermissionState = permissionGranted;
  if (!permissionGranted) return { status: "permission_denied" };

  const now = Date.now();
  if (
    !forceRefresh &&
    cache &&
    cache.maxEvents === maxEvents &&
    cache.windowMs === windowMs &&
    now - cache.atMs < CACHE_MS
  ) {
    return { status: "success", events: [...cache.events] };
  }

  const context = Utils.android.getApplicationContext();
  if (!context) return { status: "provider_unavailable" };

  try {
    const json = spanCurrent("fetch-calendar-events", () =>
      String(
        com.faceclaw.app.FaceclawCalendarProvider.getUpcomingEventsJson(
          context,
          Math.max(0, Math.round(maxEvents)),
          Math.max(0, Math.round(windowMs)),
        ),
      ),
    );
    const parsed = JSON.parse(json);
    if (!parsed || typeof parsed !== "object") return { status: "query_failed" };
    if (parsed.status !== "success") {
      if (parsed.status === "permission_denied") return { status: "permission_denied" };
      if (parsed.status === "provider_unavailable") return { status: "provider_unavailable" };
      return { status: "query_failed" };
    }
    if (!Array.isArray(parsed.events)) return { status: "query_failed" };
    const normalized = parsed.events.map(normalizeEvent);
    if (normalized.some((event) => event === null)) return { status: "query_failed" };
    const events = normalized as CalendarEvent[];
    cache = { events, atMs: now, maxEvents, windowMs };
    return { status: "success", events: [...events] };
  } catch {
    return { status: "query_failed" };
  }
}

/** Drop the cached events so the next read re-queries the provider. */
export function invalidateCalendarCache(): void {
  cache = null;
  lastPermissionState = null;
}

function normalizeEvent(value: any): CalendarEvent | null {
  if (!value || typeof value !== "object") return null;
  const startMs = Number(value.startMs);
  if (!Number.isFinite(startMs)) return null;
  return {
    id: Number(value.id) || 0,
    title: String(value.title ?? ""),
    startMs,
    endMs: Number(value.endMs) || startMs,
    allDay: Boolean(value.allDay),
    location: String(value.location ?? ""),
    calendarName: String(value.calendarName ?? ""),
  };
}
