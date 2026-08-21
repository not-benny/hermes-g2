/**
 * Dependency-free chart rendering for the Health tab, drawn with plain
 * NativeScript views inside an AbsoluteLayout (the same technique as the
 * readiness ring gauge). NativeScript core ships no chart widget and the app
 * avoids native chart plugins, so these render column / range charts from
 * positioned StackLayout rectangles.
 *
 * All value->pixel math lives in the pure, unit-tested ./health-chart-data
 * module; this file only does the view plumbing and reads its own laid-out size.
 */

import { AbsoluteLayout, Color, StackLayout } from "@nativescript/core";

import { clamp01, type ChartBar } from "./health-chart-data";

export {
  clamp01,
  frac,
  hrZoneColor,
  readinessColor,
  buildHrDayBars,
  buildTrendBars,
  type ChartBar,
  type HourHr,
} from "./health-chart-data";

export interface ChartOpts {
  /** Bar width in DIPs; auto-fit from the column count when omitted. */
  barWidth?: number;
  /** Shortest drawable bar in DIPs, so a zero-range column still shows. */
  minBarHeight?: number;
  /** Point-marker colour + size in DIPs. */
  midColor?: string;
  midSize?: number;
  /** Optional horizontal reference line (e.g. resting HR), 0..1; null to omit. */
  baselineFrac?: number | null;
  baselineColor?: string;
  /** Bar corner radius in DIPs; defaults to a pill (barWidth/2). */
  radius?: number;
}

function rect(w: number, h: number, radius: number, color: string, left: number, top: number): StackLayout {
  const box = new StackLayout();
  box.width = w;
  box.height = h;
  box.borderRadius = radius;
  box.backgroundColor = new Color(color);
  AbsoluteLayout.setLeft(box, Math.round(left));
  AbsoluteLayout.setTop(box, Math.round(top));
  return box;
}

/**
 * Clear `host` and redraw it as a column/range chart. Safe to call before the
 * host has been laid out (it no-ops until it has a non-zero size) and safe to
 * call repeatedly as data changes.
 */
export function renderColumnChart(host: AbsoluteLayout, bars: ChartBar[], opts: ChartOpts = {}): void {
  const { width: W, height: H } = host.getActualSize();
  host.removeChildren();
  if (!W || !H || bars.length === 0) return;

  const barWidth = opts.barWidth ?? Math.max(3, Math.min(14, (W / bars.length) * 0.6));
  const radius = opts.radius ?? barWidth / 2;
  const minBarHeight = opts.minBarHeight ?? 3;

  if (opts.baselineFrac != null) {
    const y = (1 - clamp01(opts.baselineFrac)) * H;
    host.addChild(rect(W, 1, 0, opts.baselineColor ?? "#3A4A40", 0, y));
  }

  for (const b of bars) {
    const lo = clamp01(b.lowFrac);
    const hi = clamp01(Math.max(b.highFrac, b.lowFrac));
    const cx = clamp01(b.xFrac) * W;
    const top = (1 - hi) * H;
    const h = Math.max(minBarHeight, (hi - lo) * H);
    host.addChild(rect(barWidth, h, radius, b.color, cx - barWidth / 2, top));

    if (b.midFrac != null) {
      const size = opts.midSize ?? 5;
      const my = (1 - clamp01(b.midFrac)) * H - size / 2;
      host.addChild(rect(size, size, size / 2, opts.midColor ?? "#EAF2EC", cx - size / 2, my));
    }
  }
}
