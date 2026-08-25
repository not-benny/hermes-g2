import { G2_LENS_HEIGHT, G2_LENS_WIDTH } from "../../graphics/image";
import { dashboardSizeSetting, verticalPositionSetting } from "../dashboard-settings";

/**
 * Two-line visual HUD. Two 24px notification rows plus a small gutter fit
 * without touching the content divider, while the clock can span both rows.
 */
export const TOP_BAR_HEIGHT = 56;
/** One sidebar column: 32px window icons plus a little padding. */
export const SIDEBAR_COLUMN_WIDTH = 36;
/**
 * The shell still reserves two columns (72px) so app geometry and protocol
 * surfaces remain stable. Only the right column is optically useful: the
 * centred 576px wearer raster begins at x=32, leaving almost all of x=0..35
 * invisible, so window tabs scroll within x=36..71 instead of overflowing.
 */
export const SIDEBAR_COLUMNS = 2;
export const SIDEBAR_VISIBLE_COLUMNS = 1;
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
 * Shared sizing for the assistant's compact glance cards. The logical shell
 * is 640px wide, but only the centred 576px optical raster reaches the wearer.
 * Keeping these cards at 448px leaves a real 64px optical margin on each side
 * and, on the shell surface, keeps them clear of the sidebar.
 */
export const ASSISTANT_CARD_WIDTH = 448;
export const ASSISTANT_STATUS_CARD_WIDTH = 320;
export const ASSISTANT_CAPTURE_CARD_HEIGHT = 112;
export const ASSISTANT_REVIEW_CARD_HEIGHT = 144;
export const ASSISTANT_STATUS_CARD_HEIGHT = 64;
export const ASSISTANT_ERROR_CARD_HEIGHT = 96;

export type ShellRect = { x: number; y: number; width: number; height: number };

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

/**
 * Host rectangle for shell-owned content overlays.
 *
 * On the 640x480 shell, overlays must skip both sidebar and HUD and stay in
 * the centred wearer-visible app raster. Nested/app-local stacks are already
 * below the HUD; keep their local origin while clipping the hidden right
 * gutter of a full 568px app surface.
 */
export function shellContentOverlayViewport(baseSize: { width: number; height: number }): ShellRect {
  const optical = visibleAppViewportRect("min");
  if (baseSize.width === G2_LENS_WIDTH && baseSize.height === G2_LENS_HEIGHT) return optical;
  return {
    x: 0,
    y: 0,
    width: Math.max(0, Math.min(baseSize.width, optical.width)),
    height: Math.max(0, baseSize.height),
  };
}

/**
 * Coordinate space available to a shell assistant card.
 *
 * VoiceInputLayer is used both directly on the 640x480 shell and inside the
 * notification modal's 532x196 local LayerStack. The old dialog mixed those
 * coordinate spaces by always adding minWindowTop(), which clipped most of a
 * notification reply at lower vertical-position settings. A full shell stack
 * uses the optical 576px raster below the top bar; a nested stack uses its own
 * complete local canvas and must not apply a second global offset.
 */
export function assistantCardViewport(baseSize: { width: number; height: number }): ShellRect {
  if (baseSize.width === G2_LENS_WIDTH && baseSize.height === G2_LENS_HEIGHT) {
    return {
      x: Math.round((G2_LENS_WIDTH - G2_VISIBLE_WIDTH) / 2),
      y: minWindowTop() + TOP_BAR_HEIGHT,
      width: G2_VISIBLE_WIDTH,
      height: MIN_WINDOW_HEIGHT - TOP_BAR_HEIGHT,
    };
  }
  return { x: 0, y: 0, width: baseSize.width, height: baseSize.height };
}

/** Centre a compact assistant card inside the correct shell or local viewport. */
export function assistantCardRect(
  baseSize: { width: number; height: number },
  preferredHeight: number,
  preferredWidth = ASSISTANT_CARD_WIDTH,
): ShellRect {
  const viewport = assistantCardViewport(baseSize);
  // Retain a small boundary even in an unexpectedly tiny host. The known
  // shell/modal hosts both fit the preferred sizes without reduction.
  const width = Math.max(1, Math.min(preferredWidth, viewport.width - Math.min(32, viewport.width - 1)));
  const height = Math.max(1, Math.min(preferredHeight, viewport.height - Math.min(16, viewport.height - 1)));
  return {
    x: viewport.x + Math.floor((viewport.width - width) / 2),
    y: viewport.y + Math.floor((viewport.height - height) / 2),
    width,
    height,
  };
}
