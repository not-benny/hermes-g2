import type { GrayImage } from "../graphics/image";

/**
 * Wearer-facing visual tokens for the G2 renderer.
 *
 * Native rounds an 8-bit gray value to a 4-bit wire shade with
 * `(value + 8) >> 4`. Values here deliberately sit on stable shade centres so
 * adjacent semantic roles cannot collapse during packing. Value 1 is the one
 * exception: it is visually black after packing while remaining opaque on a
 * shell surface where zero is the transparent color key.
 */
export const GLASS_TONE = {
  opaqueBlack: 1,
  selectedFill: 16,
  track: 48,
  divider: 64,
  border: 96,
  hint: 112,
  muted: 144,
  secondary: 176,
  body: 208,
  primary: 224,
  focus: 255,
} as const;

/** Four-pixel rhythm, kept deliberately small for the 576x288 optical band. */
export const GLASS_SPACE = {
  micro: 2,
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
} as const;

export const GLASS_RADIUS = {
  selection: 6,
  control: 8,
  card: 12,
} as const;

/** Short, bounded motion only. No global animation clock is introduced. */
export const GLASS_MOTION = {
  cardEnterMs: 240,
  cardExitMs: 220,
  frameMs: 24,
} as const;

export type GlassPanelOptions = {
  /** Null leaves the existing pixels intact and paints only the outline. */
  fill?: number | null;
  border?: number;
  radius?: number;
};

/** Two-operation opaque card primitive used by glance and modal surfaces. */
export function drawGlassPanel(
  image: GrayImage,
  x: number,
  y: number,
  width: number,
  height: number,
  options: GlassPanelOptions = {},
): void {
  const radius = options.radius ?? GLASS_RADIUS.card;
  const fill =
    options.fill === undefined ? GLASS_TONE.opaqueBlack : options.fill;
  if (fill !== null) image.fillRoundedRect(x, y, width, height, fill, radius);
  image.drawRoundedRect(
    x,
    y,
    width,
    height,
    options.border ?? GLASS_TONE.border,
    radius,
  );
}

/**
 * One selection language for menus, launcher cells, lists, and split panes.
 * A focused selection gains a stable shade-1 fill plus a two-pixel focus rail;
 * an unfocused selection remains an outline, preserving ownership semantics.
 */
export function drawGlassSelection(
  image: GrayImage,
  x: number,
  y: number,
  width: number,
  height: number,
  focused: boolean,
  radius: number = GLASS_RADIUS.selection,
): void {
  if (focused)
    image.fillRoundedRect(x, y, width, height, GLASS_TONE.selectedFill, radius);
  image.drawRoundedRect(
    x,
    y,
    width,
    height,
    focused ? GLASS_TONE.border : GLASS_TONE.divider,
    radius,
  );
  if (focused && height >= 10) {
    const railHeight = Math.max(4, height - GLASS_SPACE.sm);
    image.fillRoundedRect(
      x + GLASS_SPACE.xs,
      y + Math.floor((height - railHeight) / 2),
      GLASS_SPACE.micro,
      railHeight,
      GLASS_TONE.primary,
      1,
    );
  }
}

/** Shared compact progress treatment for media and bounded status values. */
export function drawGlassProgress(
  image: GrayImage,
  x: number,
  y: number,
  width: number,
  height: number,
  progress: number,
): void {
  const bounded = Number.isFinite(progress)
    ? Math.max(0, Math.min(1, progress))
    : 0;
  const radius = Math.max(1, Math.floor(height / 2));
  image.drawRoundedRect(x, y, width, height, GLASS_TONE.track, radius);
  const innerWidth = Math.max(0, Math.round((width - 2) * bounded));
  if (innerWidth > 0) {
    image.fillRoundedRect(
      x + 1,
      y + 1,
      innerWidth,
      Math.max(1, height - 2),
      GLASS_TONE.secondary,
      Math.max(1, radius - 1),
    );
  }
}
