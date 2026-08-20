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
import { readinessScore, type ReadinessInsights } from "../../health/health-insights";
import { computeBaselines, dateKeyOf } from "../../health/health-history";
import { hourlyForDay } from "../../health/health-hourly";
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
 * Readiness computed exactly as the phone Health tab does (accumulated hourly +
 * baselines + live HR), so the glasses card matches the phone. Cheap enough for
 * the paint path; recomputed only when the card repaints (on data change/focus).
 */
function liveReadiness(): ReadinessInsights {
  const nowMs = Date.now();
  const hourly = hourlyForDay(loadHourly(), dateKeyOf(nowMs));
  const s = ringHealthStore.snapshot();
  return readinessScore({
    heartRate: hourly.filter((p) => p.hr).map((p) => ({ hourIdx: p.hourIdx, ...p.hr! })),
    hrv: hourly.filter((p) => p.hrv).map((p) => ({ hourIdx: p.hourIdx, ...p.hrv! })),
    sleep: null,
    liveHr: s.currentHr,
    bodyTempC: s.bodyTempC,
    baselines: computeBaselines(loadHealthHistory(), nowMs),
    nowMs,
  });
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
 * Display-only layer. Built for the standard 288px band but filled with big,
 * blocky numbers + a readiness bar rather than small text and dead space: a
 * readiness hero up top, a large HR readout, and a row of big metric tiles.
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
    const r = liveReadiness();
    const M = 16;

    // --- readiness hero: label, big score, verdict, and a filled bar ---------
    img.drawText(small, M, 4, "READINESS", 150);
    const scoreStr = r.score === null ? "--" : String(r.score);
    img.drawText(big, M, 18, scoreStr, 250);
    const afterScore = M + big.measureText(scoreStr) + 14;
    const verdict = r.score === null ? "Not enough data yet" : VERDICT[r.band];
    img.drawText(med, afterScore, 22, verdict, 220);
    if (r.score !== null) img.drawText(small, afterScore, 46, "out of 100", 130);

    const barY = 58;
    const barH = 18;
    img.fillRoundedRect(M, barY, W - 2 * M, barH, 45, barH / 2);
    if (r.score !== null) {
      const fillW = Math.max(barH, Math.round((W - 2 * M) * (r.score / 100)));
      img.fillRoundedRect(M, barY, fillW, barH, 205, barH / 2);
    }

    // --- big HR readout ------------------------------------------------------
    const hr = s.currentHr ?? s.heartRate?.avg ?? null;
    const hrY = barY + barH + 12;
    img.drawText(big, M, hrY, hr === null ? "--" : String(hr), 245);
    const hrNumW = big.measureText(hr === null ? "--" : String(hr));
    img.drawText(small, M + hrNumW + 8, hrY + 4, "bpm", 150);
    img.drawText(small, M + hrNumW + 8, hrY + 20, "heart rate", 120);

    // --- metric tiles: big value + small label, spread across the width ------
    const tiles: Array<[string, string]> = [
      [s.batteryPercent === null ? "--" : `${s.batteryPercent}`, "ring %"],
      [s.spo2 ? `${s.spo2.avg}` : "--", "SpO2 %"],
      [s.hrv ? `${s.hrv.avg}` : "--", "HRV ms"],
      [s.activity ? String(s.activity.totalSteps) : "--", "steps"],
    ];
    const tileTop = hrY + big.lineHeight + 8;
    const tileW = W / tiles.length;
    tiles.forEach(([value, label], i) => {
      const cx = i * tileW + tileW / 2;
      drawCentered(img, med, cx, tileTop, value, 235);
      drawCentered(img, small, cx, tileTop + 24, label, 140);
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
