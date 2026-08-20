/**
 * Pure chart-data math for the Health tab: value->fraction scaling plus the
 * domain builders that turn ring series into positioned bars. No NativeScript
 * imports, so it runs under plain Node and is unit-tested directly. The view
 * plumbing that consumes these lives in app/phone-ui/health-charts.ts.
 */

/** Clamp to the unit interval. */
export function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** Map a value in [min,max] to a 0..1 fraction (clamped). Flat domain -> 0. */
export function frac(value: number, min: number, max: number): number {
  if (!(max > min)) return 0;
  return clamp01((value - min) / (max - min));
}

/** One column: a range bar (low..high) with an optional point marker (mid). */
export interface ChartBar {
  /** Horizontal centre, 0 (left) .. 1 (right). */
  xFrac: number;
  /** Bar bottom, 0 (chart floor) .. 1 (chart ceiling). */
  lowFrac: number;
  /** Bar top, 0 .. 1 (coerced to >= lowFrac by the renderer). */
  highFrac: number;
  /** Optional marker height (e.g. hourly average), 0..1; null to omit. */
  midFrac?: number | null;
  /** Bar fill colour (hex). */
  color: string;
}

/** Heart-rate zone colour (app palette): rest / normal / elevated / high. */
export function hrZoneColor(bpm: number): string {
  if (bpm < 60) return "#4C9DF5";
  if (bpm < 100) return "#57D8A6";
  if (bpm < 140) return "#F5C542";
  return "#E5484D";
}

/** Readiness band colour, matching the hero thresholds (85 / 65 / 40). */
export function readinessColor(score: number): string {
  if (score >= 65) return "#57D8A6";
  if (score >= 40) return "#F5C542";
  return "#E5484D";
}

/** One hour of heart rate: the range (min..max) plus the hourly average. */
export interface HourHr {
  hourIdx: number;
  min: number;
  max: number;
  avg: number;
}

/**
 * Build the 24-hour heart-rate chart: a zone-coloured range bar per populated
 * hour with the hourly average as a marker, over an auto-padded shared domain,
 * plus the resting-HR baseline fraction. Empty in -> empty out.
 */
export function buildHrDayBars(
  hours: HourHr[],
  restingHr: number | null,
): { bars: ChartBar[]; baselineFrac: number | null; domain: { min: number; max: number } | null } {
  if (hours.length === 0) return { bars: [], baselineFrac: null, domain: null };
  let lo = Infinity;
  let hi = -Infinity;
  for (const h of hours) {
    lo = Math.min(lo, h.min);
    hi = Math.max(hi, h.max);
  }
  if (restingHr !== null) {
    lo = Math.min(lo, restingHr);
    hi = Math.max(hi, restingHr);
  }
  const pad = Math.max(2, (hi - lo) * 0.08);
  const dMin = lo - pad;
  const dMax = hi + pad;
  const bars: ChartBar[] = hours.map((h) => ({
    xFrac: clamp01(h.hourIdx / 23),
    lowFrac: frac(h.min, dMin, dMax),
    highFrac: frac(h.max, dMin, dMax),
    midFrac: frac(h.avg, dMin, dMax),
    color: hrZoneColor(h.avg),
  }));
  return {
    bars,
    baselineFrac: restingHr === null ? null : frac(restingHr, dMin, dMax),
    // The padded axis range, for drawing bpm scale labels.
    domain: { min: Math.round(dMin), max: Math.round(dMax) },
  };
}

/**
 * Build a day-by-day trend chart from a fixed 0..100 domain (readiness, sleep
 * score, ...). Null days are dropped but still consume their x-slot so the time
 * axis stays honest. `colorFor` maps each score to a bar colour.
 */
export function buildTrendBars(
  scores: Array<number | null>,
  colorFor: (score: number) => string,
): ChartBar[] {
  const n = scores.length;
  const bars: ChartBar[] = [];
  scores.forEach((s, i) => {
    if (s === null) return;
    bars.push({
      xFrac: n <= 1 ? 0.5 : i / (n - 1),
      lowFrac: 0,
      highFrac: clamp01(s / 100),
      color: colorFor(s),
    });
  });
  return bars;
}
