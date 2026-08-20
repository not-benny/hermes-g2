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

/** Draw the day's HR as a min-max range chart with average markers + resting line. */
function drawHrChart(img: GrayImage, x: number, y: number, w: number, h: number, hours: HourHr[], restingHr: number | null): void {
  const { bars, baselineFrac } = buildHrDayBars(hours, restingHr);
  if (baselineFrac !== null) {
    const by = y + Math.round((1 - baselineFrac) * h);
    for (let px = x; px < x + w; px += 6) img.fillRect(px, by, 3, 1, 70);
  }
  for (const b of bars) {
    const cx = x + Math.round(b.xFrac * w);
    const top = y + Math.round((1 - b.highFrac) * h);
    const bot = y + Math.round((1 - b.lowFrac) * h);
    img.fillRect(cx, top, 3, Math.max(2, bot - top), 150);
    if (b.midFrac != null) {
      const my = y + Math.round((1 - b.midFrac) * h);
      img.fillRect(cx - 1, my - 1, 5, 3, 240);
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

    // --- readiness hero: label, big score, verdict, filled bar ---------------
    img.drawText(small, M, 3, "READINESS", 150);
    const scoreStr = r.score === null ? "--" : String(r.score);
    img.drawText(big, M, 15, scoreStr, 250);
    const afterScore = M + big.measureText(scoreStr) + 14;
    img.drawText(med, afterScore, 18, r.score === null ? "Not enough data" : VERDICT[r.band], 225);
    if (r.score !== null) img.drawText(small, afterScore, 42, `out of 100 - ${r.confidence} confidence`, 125);

    const barY = 52;
    const barH = 16;
    img.fillRoundedRect(M, barY, W - 2 * M, barH, 45, barH / 2);
    if (r.score !== null) {
      img.fillRoundedRect(M, barY, Math.max(barH, Math.round((W - 2 * M) * (r.score / 100))), barH, 210, barH / 2);
    }

    // --- big HR readout with a pulse icon + resting/range context -----------
    const hrY = barY + barH + 10;
    const icon = renderIcon("activity", 24);
    if (icon) img.bitBlt(icon, M, hrY + 4);
    const hrStr = hrI.current === null ? "--" : String(hrI.current);
    const hrX = M + (icon ? icon.width + 10 : 0);
    img.drawText(big, hrX, hrY, hrStr, 245);
    const afterHr = hrX + big.measureText(hrStr) + 8;
    img.drawText(small, afterHr, hrY + 4, "bpm", 150);
    img.drawText(small, afterHr, hrY + 20, "heart rate", 120);
    const ctxParts: string[] = [];
    if (hrI.restingHr !== null) ctxParts.push(`rest ${hrI.restingHr}`);
    if (hrI.min !== null && hrI.max !== null) ctxParts.push(`${hrI.min}-${hrI.max}`);
    if (ctxParts.length) {
      const ctxStr = ctxParts.join("   ");
      img.drawText(small, W - M - small.measureText(ctxStr), hrY + 12, ctxStr, 150);
    }

    // --- 24h HR range chart (the rich graphic) ------------------------------
    const chartY = hrY + big.lineHeight + 8;
    const stripH = 30;
    const chartH = Math.max(28, H - chartY - stripH - 6);
    if (hours.length) {
      img.drawText(small, M, chartY - 12, "LAST 24H", 110);
      drawHrChart(img, M, chartY, W - 2 * M, chartH, hours, hrI.restingHr);
    }

    // --- metric strip: big value + small label across the width -------------
    const tiles: Array<[string, string]> = [
      [s.batteryPercent === null ? "--" : `${s.batteryPercent}`, "ring %"],
      [s.spo2 ? `${s.spo2.avg}` : "--", "SpO2 %"],
      [s.hrv ? `${s.hrv.avg}` : "--", "HRV ms"],
      [s.activity ? String(s.activity.totalSteps) : "--", "steps"],
    ];
    const stripTop = H - stripH + 2;
    img.fillRect(M, stripTop - 6, W - 2 * M, 1, 45);
    const tileW = W / tiles.length;
    tiles.forEach(([value, label], i) => {
      const cx = i * tileW + tileW / 2;
      drawCentered(img, med, cx, stripTop, value, 235);
      drawCentered(img, small, cx, stripTop + 22, label, 140);
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
  // Repaint on any ring-health change. The card is pinned for the app's
  // lifetime, so this subscription never needs tearing down.
  ringHealthStore.onChange(() => created.requestRender());
  return created.window;
}
