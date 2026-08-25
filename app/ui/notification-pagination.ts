export type SelectionWindow = { start: number; end: number; capacity: number };

/** Return a bounded, selection-centred half-open window. */
export function selectionCenteredWindow(selectedIndex: number, itemCount: number, capacity: number): SelectionWindow {
  const count = Math.max(0, Math.floor(itemCount));
  const visible = Math.max(1, Math.floor(capacity));
  if (count === 0) return { start: 0, end: 0, capacity: visible };
  const selected = Math.max(0, Math.min(count - 1, Math.floor(selectedIndex)));
  const shown = Math.min(count, visible);
  const start = Math.max(0, Math.min(count - shown, selected - Math.floor(shown / 2)));
  return { start, end: start + shown, capacity: visible };
}

export type NotificationDetailMenuLayout = SelectionWindow & {
  menuY: number;
  rowPitch: number;
  highlightHeight: number;
};

export function notificationDetailMenuLayout(
  height: number,
  fontLineHeight: number,
  itemCount: number,
  selectedIndex: number,
): NotificationDetailMenuLayout {
  const menuY = 24;
  const rowPitch = Math.max(22, fontLineHeight + 6);
  const highlightHeight = Math.max(19, fontLineHeight + 3);
  const capacity = Math.max(1, Math.floor((height - menuY - 10) / rowPitch));
  return {
    ...selectionCenteredWindow(selectedIndex, itemCount, capacity),
    menuY,
    rowPitch,
    highlightHeight,
  };
}

export type NotificationDigestLayout = SelectionWindow & {
  listTop: number;
  listBottom: number;
  lineAdvance: number;
};

export function notificationDigestLayout(
  height: number,
  fontLineHeight: number,
  itemCount: number,
  selectedIndex: number,
): NotificationDigestLayout {
  const lineAdvance = fontLineHeight + 2;
  const listTop = 42;
  const listBottom = height - Math.max(30, lineAdvance + 8);
  // The selected digest item owns one extra "Why" line.
  const rowCapacity = Math.max(2, Math.floor((listBottom - listTop) / lineAdvance));
  const capacity = Math.max(1, rowCapacity - 1);
  return {
    ...selectionCenteredWindow(selectedIndex, itemCount, capacity),
    listTop,
    listBottom,
    lineAdvance,
  };
}
