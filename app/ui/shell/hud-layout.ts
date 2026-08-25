export type HudNotificationLayout = {
  /** Full-height boundary immediately before persistent HUD state. */
  separatorX: number;
  /** Inclusive left / exclusive right bounds of the phone-icon region. */
  notificationLeft: number;
  notificationRight: number;
  columns: number;
  rows: 2;
  maxIcons: number;
};

/**
 * Pure geometry for the two-row HUD. Keeping this independent from the paint
 * layer makes the non-overlap and optical-raster limits directly testable.
 */
export function layoutHudNotifications(args: {
  clockRight: number;
  preferredNotificationLeft: number;
  persistentLeft: number;
  visibleRight: number;
  iconSize: number;
  iconGap: number;
}): HudNotificationLayout {
  const notificationLeft = Math.max(args.preferredNotificationLeft, args.clockRight + 10);
  // The production divider is two pixels wide, so reserve both x positions
  // inside the optical raster's exclusive right edge.
  const separatorX = Math.min(args.visibleRight - 2, Math.max(args.clockRight + 4, args.persistentLeft - 8));
  const notificationRight = Math.max(notificationLeft, separatorX - 8);
  const stride = args.iconSize + args.iconGap;
  const columns = Math.max(0, ((notificationRight - notificationLeft + args.iconGap) / stride) | 0);
  return {
    separatorX,
    notificationLeft,
    notificationRight,
    columns,
    rows: 2,
    maxIcons: columns * 2,
  };
}

/** Position an icon in row-major order inside the layout's two rows. */
export function hudNotificationIconPosition(layout: HudNotificationLayout, index: number, args: {
  barTop: number;
  rowHeight: number;
  iconSize: number;
  iconGap: number;
}): { x: number; y: number } | null {
  if (!Number.isInteger(index) || index < 0 || index >= layout.maxIcons || layout.columns <= 0) return null;
  const row = (index / layout.columns) | 0;
  const column = index % layout.columns;
  return {
    x: layout.notificationLeft + column * (args.iconSize + args.iconGap),
    y: args.barTop + 2 + row * args.rowHeight,
  };
}

/**
 * Fit priority-ordered persistent items right-to-left. Once the remaining
 * space is exhausted, only the lower-priority suffix is omitted.
 */
export function fitHudRowItemWidths(widths: readonly number[], rightEdge: number, minLeft: number,
  gap: number): Array<{ index: number; x: number }> {
  const fitted: Array<{ index: number; x: number }> = [];
  let cursor = rightEdge;
  for (let index = 0; index < widths.length; index++) {
    const width = Math.max(0, Math.floor(widths[index] ?? 0));
    const x = cursor - width;
    if (x < minLeft) break;
    fitted.push({ index, x });
    cursor = x - gap;
  }
  return fitted;
}
