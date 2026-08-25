const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const;

export type DirectNotificationTimeFormat = "12h" | "24h";

export type DirectNotificationHeaderParts = {
  /** Left-aligned label; it may be truncated without hiding queue position. */
  leading: string;
  /** Right-aligned queue position, or an empty string for a single card. */
  trailing: string;
};

function isSameLocalDay(left: Date, right: Date): boolean {
  return left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate();
}

function formatLocalTime(date: Date, timeFormat: DirectNotificationTimeFormat): string {
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const hour24 = date.getHours();
  return timeFormat === "12h"
    ? `${((hour24 + 11) % 12) + 1}:${minutes} ${hour24 < 12 ? "AM" : "PM"}`
    : `${String(hour24).padStart(2, "0")}:${minutes}`;
}

/**
 * The phone reception time is deliberately labelled as received, rather than
 * looking like a reminder due-time. Queue position is returned separately so
 * the HUD can reserve its pixels even when an old timestamp is long.
 */
export function formatDirectNotificationHeaderParts(
  receivedAtMs: number,
  position: number,
  total: number,
  timeFormat: DirectNotificationTimeFormat,
  nowMs = Date.now(),
): DirectNotificationHeaderParts {
  if (
    !Number.isSafeInteger(receivedAtMs) || receivedAtMs < 0 ||
    !Number.isSafeInteger(nowMs) || nowMs < 0 ||
    !Number.isSafeInteger(position) || position < 1 ||
    !Number.isSafeInteger(total) || total < position
  ) throw new Error("Direct notification header metadata is invalid.");
  const received = new Date(receivedAtMs);
  const now = new Date(nowMs);
  if (!Number.isFinite(received.getTime()) || !Number.isFinite(now.getTime())) {
    throw new Error("Direct notification timestamp is invalid.");
  }

  let datePrefix = "";
  if (!isSameLocalDay(received, now)) {
    datePrefix = `${received.getDate()} ${MONTHS[received.getMonth()]}`;
    if (received.getFullYear() !== now.getFullYear()) {
      datePrefix += ` ${received.getFullYear()}`;
    }
    datePrefix += " ";
  }
  return {
    leading: `Hermes · received ${datePrefix}${formatLocalTime(received, timeFormat)}`,
    trailing: total > 1 ? `${position}/${total}` : "",
  };
}

export function formatDirectNotificationHeader(
  receivedAtMs: number,
  position: number,
  total: number,
  timeFormat: DirectNotificationTimeFormat,
  nowMs = Date.now(),
): string {
  const { leading, trailing } = formatDirectNotificationHeaderParts(
    receivedAtMs,
    position,
    total,
    timeFormat,
    nowMs,
  );
  return trailing ? `${leading} · ${trailing}` : leading;
}
