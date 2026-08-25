/** Lowest design-space row occupied by the table and its gesture hints. */
export const PINBALL_DESIGN_HEIGHT = 260;

/** Paint at the original geometry, then fit only when the viewport is shorter. */
export function pinballPaintHeight(viewportHeight: number): number {
  return Math.max(PINBALL_DESIGN_HEIGHT, Math.max(1, Math.floor(viewportHeight)));
}

/**
 * Nearest-neighbour vertical fit for the fixed-coordinate pinball playfield.
 * Physics remains in its tuned design space while the complete visual frame
 * (including the plunger and gesture hints) lands inside the compact raster.
 */
export function fitPinballPixels(
  source: { width: number; height: number; pixels: Uint8Array },
  targetHeight: number,
): Uint8Array {
  const height = Math.max(1, Math.floor(targetHeight));
  if (height === source.height) return source.pixels.slice();
  const output = new Uint8Array(source.width * height);
  for (let y = 0; y < height; y++) {
    const sourceY = Math.min(source.height - 1, Math.floor((y * source.height) / height));
    output.set(
      source.pixels.subarray(sourceY * source.width, (sourceY + 1) * source.width),
      y * source.width,
    );
  }
  return output;
}
