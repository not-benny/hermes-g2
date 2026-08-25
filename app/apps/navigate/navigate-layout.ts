export type NavigateLayout = {
  mapSize: number;
  panelX: number;
  panelWidth: number;
  etaY: number;
  statusY: number;
  footerY: number;
};

const MAX_MAP_SIZE = 260;
const PANEL_GAP = 10;
const SMALL_LINE_HEIGHT = 16;

/** Two-pane navigation geometry bounded by the actual worker viewport. */
export function navigateLayout(viewportWidth: number, viewportHeight: number): NavigateLayout {
  const width = Math.max(1, Math.floor(viewportWidth));
  const height = Math.max(1, Math.floor(viewportHeight));
  const mapSize = Math.max(1, Math.min(MAX_MAP_SIZE, height, width - 180));
  const panelX = Math.min(width - 1, mapSize + PANEL_GAP);
  return {
    mapSize,
    panelX,
    panelWidth: Math.max(1, width - panelX),
    etaY: Math.max(0, height - 62),
    statusY: Math.max(0, height - 44),
    footerY: Math.max(0, height - 22),
  };
}

/** Maximum complete text rows that fit before a reserved lower boundary. */
export function visibleTextRows(y: number, bottom: number, lineHeight = SMALL_LINE_HEIGHT): number {
  return Math.max(0, Math.floor((bottom - y) / Math.max(1, lineHeight)));
}
