export type WindowWidthClass = "compact" | "medium" | "expanded";
export type WindowHeightClass = "compact" | "medium" | "expanded";
export type WindowOrientation = "portrait" | "landscape";

export type PhoneWindowLayout = {
  width: number;
  height: number;
  widthClass: WindowWidthClass;
  heightClass: WindowHeightClass;
  orientation: WindowOrientation;
};

/**
 * Classify the current application window, never the physical display. Fold,
 * rotation, freeform, and split-screen transitions can all change these bounds
 * while the process and activity stay alive.
 */
export function classifyPhoneWindow(width: number, height: number): PhoneWindowLayout {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error("window bounds must be positive finite values");
  }
  return {
    width,
    height,
    widthClass: width < 600 ? "compact" : width < 840 ? "medium" : "expanded",
    heightClass: height < 480 ? "compact" : height < 900 ? "medium" : "expanded",
    orientation: width > height ? "landscape" : "portrait",
  };
}

/**
 * NativeScript can report a transient 0×0 page while constructing a fragment.
 * Defer layout work until real bounds arrive without weakening the strict
 * classifier used by callers that require valid geometry.
 */
export function tryClassifyPhoneWindow(width: number, height: number): PhoneWindowLayout | null {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }
  return classifyPhoneWindow(width, height);
}

/**
 * The Glasses tab's side-by-side preview needs room for its fixed 320-DIP
 * controls column. Compact landscape/split windows stay stacked and scroll;
 * orientation alone is not enough to choose the wide layout.
 */
export function usesWideGlassesLayout(layout: PhoneWindowLayout): boolean {
  return layout.orientation === "landscape" && layout.widthClass !== "compact";
}

/**
 * Height for the stacked lens preview. In compact landscape, deriving height
 * from width alone can consume the whole short window and strand the controls
 * below the fold. Portrait keeps the exact lens aspect; compact landscape
 * gives the preview at most 36% of the live content height.
 */
export function stackedGlassesPreviewHeight(
  width: number,
  height: number,
  aspectRatio: number,
): number {
  if (![width, height, aspectRatio].every(Number.isFinite) || width <= 0 || height <= 0 || aspectRatio <= 0) {
    throw new Error("preview bounds and aspect ratio must be positive finite values");
  }
  const aspectHeight = width / aspectRatio;
  if (width <= height) return aspectHeight;
  return Math.min(aspectHeight, Math.max(96, Math.floor(height * 0.36)));
}
