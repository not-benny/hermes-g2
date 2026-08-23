import { G2_LENS_HEIGHT, G2_LENS_WIDTH } from "../../graphics/image";
import { dashboardSizeSetting, verticalPositionSetting } from "../dashboard-settings";

/** Top bar: 24px notification icons plus a little padding. */
export const TOP_BAR_HEIGHT = 28;
/** One sidebar column: 32px window icons plus a little padding. */
export const SIDEBAR_COLUMN_WIDTH = 36;
/**
 * Sidebar icon columns. The right column (against the app area) fills first;
 * windows past that overflow into the left column, so the common few-window
 * case keeps every icon next to the content it belongs to.
 */
export const SIDEBAR_COLUMNS = 2;
export const SIDEBAR_WIDTH = SIDEBAR_COLUMN_WIDTH * SIDEBAR_COLUMNS;

/**
 * On the color-key shell surface, pixel value 0 is transparent; 1 is the
 * darkest opaque shade (identical to 0 after 4bpp quantization). Shell
 * painting must use this for intentional black.
 */
export const SHELL_OPAQUE_BLACK = 1;

/**
 * Windows come in two heights. "min" covers the same 288px band the stock
 * firmware uses, leaving most of the field of view clear; "max" uses the
 * whole 480px screen (terminal views). Both include a top bar drawn by the
 * shell at the window's top edge.
 */
export type WindowHeightMode = "min" | "max";

/** Total height (top bar + content) of a min-height window. */
export const MIN_WINDOW_HEIGHT = 288;
/** Width of the real G2 optical/EvenHub raster inside the 640px framebuffer. */
export const G2_VISIBLE_WIDTH = 576;
/** Farthest down a min-height window can start. */
export const MIN_WINDOW_MAX_TOP = G2_LENS_HEIGHT - MIN_WINDOW_HEIGHT;

/**
 * Top edge (y) of a min-height window, from the Display > Vertical position
 * setting. The sidebar and shell overlays always align to this band, even
 * while a max-height window is foreground.
 */
export function minWindowTop(): number {
  switch (verticalPositionSetting.get()) {
    case "top":
      return 0;
    case "upper":
      return Math.round(MIN_WINDOW_MAX_TOP * 0.25);
    case "lower":
      return Math.round(MIN_WINDOW_MAX_TOP * 0.75);
    case "bottom":
      return MIN_WINDOW_MAX_TOP;
    default:
      return Math.round(MIN_WINDOW_MAX_TOP * 0.5);
  }
}

/** Top edge (y) of a window's top bar; max-height windows pin to the screen top. */
export function windowTop(mode: WindowHeightMode): number {
  return mode === "max" ? 0 : minWindowTop();
}

/**
 * Default height mode for windows that do not force one, from the Dashboard
 * size setting: "full" fills the whole screen height, "standard" keeps the
 * stock 288px band. Windows that force a mode (e.g. Terminal = max) ignore this.
 */
export function windowDefaultHeightMode(): WindowHeightMode {
  return dashboardSizeSetting.get() === "full" ? "max" : "min";
}

/** App-content viewport size for a height mode (independent of vertical position). */
export function appViewportSize(mode: WindowHeightMode): { width: number; height: number } {
  return {
    width: G2_LENS_WIDTH - SIDEBAR_WIDTH,
    height: (mode === "max" ? G2_LENS_HEIGHT : MIN_WINDOW_HEIGHT) - TOP_BAR_HEIGHT,
  };
}

/** Screen rect of a window's app-content viewport (below its top bar). */
export function appViewportRect(mode: WindowHeightMode): {
  x: number;
  y: number;
  width: number;
  height: number;
} {
  return {
    x: SIDEBAR_WIDTH,
    y: windowTop(mode) + TOP_BAR_HEIGHT,
    ...appViewportSize(mode),
  };
}

/**
 * App viewport clipped to the horizontally visible 576px G2 raster. The shell
 * framebuffer is 640px wide, but the wearer-visible image is centred within it;
 * renderers must not use the hidden side gutters as layout space.
 */
export function visibleAppViewportRect(mode: WindowHeightMode): {
  x: number;
  y: number;
  width: number;
  height: number;
} {
  const viewport = appViewportRect(mode);
  const visibleLeft = Math.round((G2_LENS_WIDTH - G2_VISIBLE_WIDTH) / 2);
  const visibleRight = visibleLeft + G2_VISIBLE_WIDTH;
  const x = Math.max(viewport.x, visibleLeft);
  const right = Math.min(viewport.x + viewport.width, visibleRight);
  return { x, y: viewport.y, width: Math.max(0, right - x), height: viewport.height };
}
