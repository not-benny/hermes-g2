/**
 * The Health side card: a pinned, uncloseable in-process shell window that
 * shows a compact ring-health summary on the glasses. Modelled on the launcher
 * (a pinned window, not the transient music-card overlay). It reads
 * ringHealthStore directly each paint and repaints on any change. Long-press
 * offers "Hide health tab"; the shell then removes it (its surface + object
 * survive) until unhidden from the Apps card's menu.
 */

import { getDefaultSmallFont, getFont, type BdfFont } from "../../graphics/bdffont";
import { GrayImage } from "../../graphics/image";
import { renderIcon } from "../../graphics/icons";
import {
  type DashboardInputEvent,
  type Layer,
  type LayerActions,
  type LayerContext,
  type PaintBelow,
} from "../../ui/layers";
import { createInProcessWindow, YieldAtRootLayer } from "../../ui/shell/in-process-window";
import { shell, type ShellWindow } from "../../ui/shell/shell";
import { ringHealthStore } from "../../health/ring-health-store";
import {
  heartRateInsights,
  readinessScore,
  type HeartRateInsights,
  type ReadinessInsights,
} from "../../health/health-insights";
import { computeBaselines, dateKeyOf } from "../../health/health-history";
import { hourlyForDay } from "../../health/health-hourly";
import { buildHrDayBars, type HourHr } from "../../phone-ui/health-chart-data";
import { loadHourly, loadHealthHistory } from "../../native/health-export";
import { estimateActiveCalories } from "../../health/calories";
import { loadCalorieProfile } from "../../native/calorie-profile";

export const HEALTH_WINDOW_ID = "health";
export const HEALTH_SURFACE_ID = "window:health";

const VERDICT: Record<ReadinessInsights["band"], string> = {
  optimal: "Primed",
  good: "Ready",
  moderate: "Take it easy",
  low: "Recover",
};

/**
 * Health insights computed exactly as the phone Health tab does (accumulated
 * hourly + baselines + live HR), so the glasses card matches the phone. Cheap
 * enough for the paint path (recomputed only when the card repaints).
 */
function liveHealth(): { readiness: ReadinessInsights; hr: HeartRateInsights; hours: HourHr[] } {
  const nowMs = Date.now();
  const hourly = hourlyForDay(loadHourly(), dateKeyOf(nowMs));
  const s = ringHealthStore.snapshot();
  const hours: HourHr[] = hourly.filter((p) => p.hr).map((p) => ({ hourIdx: p.hourIdx, min: p.hr!.min, max: p.hr!.max, avg: p.hr!.avg }));
  const inputs = {
    heartRate: hours.map((h) => ({ hourIdx: h.hourIdx, avg: h.avg, max: h.max, min: h.min })),
    hrv: hourly.filter((p) => p.hrv).map((p) => ({ hourIdx: p.hourIdx, ...p.hrv! })),
    sleep: null,
    liveHr: s.currentHr,
    bodyTempC: s.bodyTempC,
    baselines: computeBaselines(loadHealthHistory(), nowMs),
    nowMs,
  };
  return { readiness: readinessScore(inputs), hr: heartRateInsights(inputs), hours };
}

export type HealthOptions = {
  actions: LayerActions;
  submitFrame: (image: GrayImage, paintMs: number, frameId: number) => Promise<void>;
  setSurfaceVisible: (visible: boolean) => void;
};

/** Centre a string of `font` horizontally around cx and draw it at baseline y. */
function drawCentered(img: GrayImage, font: BdfFont, cx: number, y: number, text: string, value: number): void {
  img.drawText(font, Math.round(cx - font.measureText(text) / 2), y, text, value);
}

/**
 * Draw the day's HR as a min-max range chart with average markers + a dashed
 * resting-HR line, plus a left gutter of bpm scale labels (top = max, bottom =
 * min) so the bars have units.
 */
function drawHrChart(img: GrayImage, x: number, y: number, w: number, h: number, hours: HourHr[], restingHr: number | null, small: BdfFont): void {
  const { bars, baselineFrac, domain } = buildHrDayBars(hours, restingHr);
  const gutter = 32;
  const cx0 = x + gutter;
  const cw = w - gutter;

  // y-axis bpm scale (units)
  if (domain) {
    img.drawText(small, x, y - 2, String(domain.max), 135);
    img.drawText(small, x, y + h - 13, String(domain.min), 135);
    img.drawText(small, x, y + Math.round(h / 2) - 6, "bpm", 95);
  }

  if (baselineFrac !== null) {
    const by = y + Math.round((1 - baselineFrac) * h);
    for (let px = cx0; px < x + w; px += 6) img.fillRect(px, by, 3, 1, 70);
  }
  for (const b of bars) {
    const bx = cx0 + Math.round(b.xFrac * cw);
    const top = y + Math.round((1 - b.highFrac) * h);
    const bot = y + Math.round((1 - b.lowFrac) * h);
    img.fillRect(bx, top, 3, Math.max(2, bot - top), 150);
    if (b.midFrac != null) {
      const my = y + Math.round((1 - b.midFrac) * h);
      img.fillRect(bx - 1, my - 1, 5, 3, 240);
    }
  }
}

/**
 * Display-only layer for the standard 288px band, filled with big blocky numbers
 * and graphics: a readiness hero + bar, a large HR readout with resting/range
 * context and a heart accent, a 24h HR range chart, and a metric strip.
 */
class HealthCardLayer implements Layer {
  paint(ctx: LayerContext, _paintBelow: PaintBelow): GrayImage {
    const W = ctx.stack.getBaseSize().width;
    const H = ctx.stack.getBaseSize().height;
    const img = new GrayImage(W, H, 0);
    const big = getFont("terminus32");
    const med = getFont("terminus24");
    const small = getDefaultSmallFont();
    const s = ringHealthStore.snapshot();
    const { readiness: r, hr: hrI, hours } = liveHealth();
    const M = 16;

    // --- readiness hero: label, big score, verdict + confidence, filled bar --
    img.drawText(small, M, 1, "READINESS", 150);
    const scoreStr = r.score === null ? "--" : String(r.score);
    img.drawText(big, M, 12, scoreStr, 250);
    const afterScore = M + big.measureText(scoreStr) + 14;
    img.drawText(med, afterScore, 14, r.score === null ? "Not enough data" : VERDICT[r.band], 225);
    // Confidence sits beside the score (above the bar), not across the gauge.
    if (r.score !== null) img.drawText(small, afterScore, 38, `${r.confidence} confidence`, 130);

    const barY = 52;
    const barH = 14;
    img.fillRoundedRect(M, barY, W - 2 * M, barH, 45, barH / 2);
    if (r.score !== null) {
      img.fillRoundedRect(M, barY, Math.max(barH, Math.round((W - 2 * M) * (r.score / 100))), barH, 210, barH / 2);
    }

    // --- big HR readout with a pulse icon + resting/range context -----------
    const hrY = barY + barH + 8;
    const icon = renderIcon("activity", 24);
    if (icon) img.bitBlt(icon, M, hrY + 3);
    const hrStr = hrI.current === null ? "--" : String(hrI.current);
    const hrX = M + (icon ? icon.width + 10 : 0);
    img.drawText(big, hrX, hrY, hrStr, 245);
    const afterHr = hrX + big.measureText(hrStr) + 8;
    img.drawText(small, afterHr, hrY + 3, "bpm", 150);
    img.drawText(small, afterHr, hrY + 18, "heart rate", 120);
    const ctxParts: string[] = [];
    if (hrI.restingHr !== null) ctxParts.push(`rest ${hrI.restingHr}`);
    if (hrI.min !== null && hrI.max !== null) ctxParts.push(`${hrI.min}-${hrI.max}`);
    if (ctxParts.length) {
      const ctxStr = ctxParts.join("   ");
      img.drawText(small, W - M - small.measureText(ctxStr), hrY + 10, ctxStr, 150);
    }

    // --- 24h HR range chart (shrunk on Y, with a bpm scale) -----------------
    const chartTop = hrY + 42;
    // Leave ~58px below the chart for the metric strip so labels never clip.
    const chartH = Math.min(64, H - 58 - chartTop);
    const haveChart = hours.length > 0 && chartH >= 24;
    if (haveChart) {
      img.drawText(small, M, chartTop - 12, "LAST 24H", 110);
      drawHrChart(img, M, chartTop, W - 2 * M, chartH, hours, hrI.restingHr, small);
    }

    // --- metric strip sits just below the chart (no dead gap, no clipping) ---
    const dividerY = (haveChart ? chartTop + chartH : hrY + big.lineHeight) + 10;
    const valueY = dividerY + 10;
    const labelY = valueY + 24;
    const kcal = hours.length ? estimateActiveCalories(hours, loadCalorieProfile(), hrI.restingHr) : null;
    const tiles: Array<[string, string]> = [
      [kcal === null ? "--" : String(kcal), "active kcal *"],
      [s.batteryPercent === null ? "--" : `${s.batteryPercent}`, "ring %"],
      [s.spo2 ? `${s.spo2.avg}` : "--", "SpO2 %"],
      [s.hrv ? `${s.hrv.avg}` : "--", "HRV ms"],
      [s.activity ? String(s.activity.totalSteps) : "--", "steps"],
    ];
    img.fillRect(M, dividerY, W - 2 * M, 1, 45);
    const tileW = W / tiles.length;
    tiles.forEach(([value, label], i) => {
      const cx = i * tileW + tileW / 2;
      drawCentered(img, med, cx, valueY, value, 235);
      drawCentered(img, small, cx, labelY, label, 140);
    });

    return img;
  }

  handleInput(_event: DashboardInputEvent, _ctx: LayerContext): void {
    // Display-only; double-click yields to the sidebar via YieldAtRootLayer.
  }
}

/** Create the pinned, uncloseable Health side card window. */
export function createHealthWindow(options: HealthOptions): ShellWindow {
  const created = createInProcessWindow({
    appId: "health",
    windowId: HEALTH_WINDOW_ID,
    title: "Health",
    iconLetter: "H",
    icon: "activity",
    closeable: false,
    actions: options.actions,
    baseLayer: new YieldAtRootLayer(new HealthCardLayer()),
    submitFrame: options.submitFrame,
    setSurfaceVisible: options.setSurfaceVisible,
    menuItems: () => [
      { label: "Hide health tab", onSelect: (ctx) => { ctx.stack.pop(); shell.setHealthHidden(true); } },
    ],
  });
  // Repaint on any ring-health change, and feed the HUD heart the ring's live
  // spot reading (frame-header `current`). Per the rule: the live value if we
  // have one, "--" otherwise -- so we pass currentHr straight through (null when
  // frames come back empty) and never fall back to an hourly average, which is
  // not a live reading. The card is pinned for the app's lifetime, so this
  // subscription never needs tearing down.
  const pushHudHeart = () => shell.setRingHeartRate(ringHealthStore.snapshot().currentHr);
  ringHealthStore.onChange(() => {
    pushHudHeart();
    created.requestRender();
  });
  pushHudHeart();
  return created.window;
}
