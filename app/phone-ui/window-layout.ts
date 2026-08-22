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
