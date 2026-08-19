/**
 * Edge-detent wraparound for scrollable lists, plus a small bounce animation.
 *
 * A plain modulo wrap (last → first on one more scroll) makes it easy to shoot
 * off the end of a list by accident. This adds a detent: the first scroll that
 * pushes past an end stops hard at that end (and bounces); the list only wraps
 * around once scrolling keeps pushing against the same end for `holdMs`.
 * Scrolling the other way, or any move that lands off the edge, disarms it.
 *
 * The caller owns the selected index; step() returns the next index plus an
 * `atEdge` flag (true = "stopped at the end, did not move/wrap this step").
 */
export type EdgeStep = { index: number; atEdge: boolean };

export const DEFAULT_EDGE_HOLD_MS = 450;

// Flip to true to trace detent decisions to logcat while tuning on-device.
const EDGE_DEBUG = false;

export class EdgeWrapScroller {
  private heldDir: -1 | 1 | null = null;
  private heldSince = 0;

  constructor(
    private readonly holdMs: number = DEFAULT_EDGE_HOLD_MS,
    private readonly label = "list",
  ) {}

  /**
   * @param index current selected index
   * @param count number of items
   * @param dir   -1 for scroll-up, 1 for scroll-down
   * @param now   a timestamp in ms (Date.now())
   */
  step(index: number, count: number, dir: -1 | 1, now: number): EdgeStep {
    const result = this.decide(index, count, dir, now);
    if (EDGE_DEBUG) {
      console.log(
        `[edge] ${this.label} i=${index}/${count} dir=${dir} -> i=${result.index} ` +
          `atEdge=${result.atEdge} held=${this.heldDir ?? "-"} dwell=${this.heldDir ? now - this.heldSince : 0}`,
      );
    }
    return result;
  }

  private decide(index: number, count: number, dir: -1 | 1, now: number): EdgeStep {
    if (count <= 1) {
      this.reset();
      return { index: 0, atEdge: false };
    }
    const atEnd = dir === 1 ? index === count - 1 : index === 0;
    if (!atEnd) {
      this.reset();
      return { index: index + dir, atEdge: false };
    }
    if (this.heldDir !== dir) {
      // First push into this end: stop here and arm the detent.
      this.heldDir = dir;
      this.heldSince = now;
      return { index, atEdge: true };
    }
    if (now - this.heldSince >= this.holdMs) {
      // Held long enough — wrap to the far end and disarm.
      this.reset();
      return { index: dir === 1 ? 0 : count - 1, atEdge: false };
    }
    // Still within the hold window: absorb, stay pressed against the end.
    return { index, atEdge: true };
  }

  reset(): void {
    this.heldDir = null;
    this.heldSince = 0;
  }
}

/**
 * A short "bounce" when a list is stopped at an end: the content dips a few
 * pixels toward the wall and springs back over ~200ms. Self-driving — it calls
 * the supplied render callback for each frame via setTimeout, so it animates
 * even when the selection index did not change.
 */
export class EdgeBounce {
  private startedAt = 0;
  private dir: -1 | 0 | 1 = 0;
  private ticking = false;
  private render: () => void = () => {};

  constructor(
    private readonly durationMs = 220,
    private readonly peakPx = 6,
  ) {}

  /** dir: -1 hit the top, 1 hit the bottom. requestRender repaints one frame. */
  trigger(dir: -1 | 1, requestRender: () => void): void {
    this.render = requestRender;
    this.dir = dir;
    this.startedAt = Date.now();
    if (!this.ticking) {
      this.ticking = true;
      this.tick();
    }
  }

  private tick(): void {
    this.render();
    if (this.dir !== 0 && Date.now() - this.startedAt < this.durationMs) {
      setTimeout(() => this.tick(), 24);
    } else {
      this.ticking = false;
      this.dir = 0;
      this.render();
    }
  }

  /**
   * Signed y-offset to add to list content this frame (0 at rest). Rubber-band
   * convention: hitting the bottom (dir=1) dips the content up, hitting the top
   * (dir=-1) dips it down.
   */
  offsetPx(now: number = Date.now()): number {
    if (this.dir === 0) return 0;
    const t = (now - this.startedAt) / this.durationMs;
    if (t <= 0 || t >= 1) return 0;
    return -this.dir * Math.round(this.peakPx * Math.sin(Math.PI * t));
  }
}
