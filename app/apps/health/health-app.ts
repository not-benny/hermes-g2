/**
 * The Health side card: a pinned, uncloseable in-process shell window that
 * shows a compact ring-health summary on the glasses. Modelled on the launcher
 * (a pinned window, not the transient music-card overlay). It reads
 * ringHealthStore directly each paint and repaints on any change. Long-press
 * offers "Hide health tab"; the shell then removes it (its surface + object
 * survive) until unhidden from the Apps card's menu.
 */

import { getDefaultMediumFont, getDefaultSmallFont, getFont } from "../../graphics/bdffont";
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

/** Display-only layer: a readiness hero plus a labelled list of ring vitals. */
class HealthCardLayer implements Layer {
  paint(ctx: LayerContext, _paintBelow: PaintBelow): GrayImage {
    const { width, height } = ctx.stack.getBaseSize();
    const img = new GrayImage(width, height, 0);
    const big = getFont("terminus32");
    const medium = getDefaultMediumFont();
    const small = getDefaultSmallFont();
    const s = ringHealthStore.snapshot();
    const r = liveReadiness();

    // --- readiness hero ---
    img.drawText(small, 16, 6, "READINESS", 150);
    const scoreStr = r.score === null ? "--" : String(r.score);
    img.drawText(big, 16, 22, scoreStr, 245);
    const numRight = 16 + big.measureText(scoreStr);
    if (r.score !== null) img.drawText(small, numRight + 8, 44, "/ 100", 130);
    const verdict = r.score === null ? "Not enough data yet" : VERDICT[r.band];
    img.drawText(medium, numRight + 8, 22, verdict, 215);

    const divY = 64;
    img.fillRect(16, divY, width - 32, 1, 55);

    // --- metrics, spread to fill the height ---
    const hr = s.currentHr ?? s.heartRate?.avg ?? null;
    const rows: Array<[string, string]> = [
      ["Heart rate", hr === null ? "--" : `${hr} bpm`],
      ["Ring battery", s.batteryPercent === null ? "--" : `${s.batteryPercent}%`],
      ["SpO2", s.spo2 ? `${s.spo2.avg}%` : "--"],
      ["HRV", s.hrv ? `${s.hrv.avg} ms` : "--"],
      ["Steps", s.activity ? String(s.activity.totalSteps) : "--"],
    ];

    const top = divY + 14;
    const rowH = Math.max(28, Math.floor((height - top - 6) / rows.length));
    rows.forEach(([label, value], i) => {
      const y = top + i * rowH;
      img.drawText(small, 16, y + 5, label, 150);
      img.drawText(medium, width - 16 - medium.measureText(value), y, value, 230);
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
    // Full-height: a data-rich dashboard card that fills the lens rather than
    // the standard 288px band.
    heightMode: "max",
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
