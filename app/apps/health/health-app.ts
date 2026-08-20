/**
 * The Health side card: a pinned, uncloseable in-process shell window that
 * shows a compact ring-health summary on the glasses. Modelled on the launcher
 * (a pinned window, not the transient music-card overlay). It reads
 * ringHealthStore directly each paint and repaints on any change. Long-press
 * offers "Hide health tab"; the shell then removes it (its surface + object
 * survive) until unhidden from the Apps card's menu.
 */

import { getDefaultMediumFont, getDefaultSmallFont } from "../../graphics/bdffont";
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

export const HEALTH_WINDOW_ID = "health";
export const HEALTH_SURFACE_ID = "window:health";

export type HealthOptions = {
  actions: LayerActions;
  submitFrame: (image: GrayImage, paintMs: number, frameId: number) => Promise<void>;
  setSurfaceVisible: (visible: boolean) => void;
};

/** Display-only layer: a labelled list of the latest ring vitals. */
class HealthCardLayer implements Layer {
  paint(ctx: LayerContext, _paintBelow: PaintBelow): GrayImage {
    const { width, height } = ctx.stack.getBaseSize();
    const img = new GrayImage(width, height, 0);
    const medium = getDefaultMediumFont();
    const small = getDefaultSmallFont();
    const s = ringHealthStore.snapshot();

    img.drawText(medium, 16, 8, "Health", 235);
    img.fillRect(16, 34, width - 32, 1, 55);

    const hr = s.currentHr ?? s.heartRate?.avg ?? null;
    const rows: Array<[string, string]> = [
      ["Heart rate", hr === null ? "--" : `${hr} bpm`],
      ["Ring battery", s.batteryPercent === null ? "--" : `${s.batteryPercent}%`],
      ["SpO2", s.spo2 ? `${s.spo2.avg}%` : "--"],
      ["HRV", s.hrv ? `${s.hrv.avg} ms` : "--"],
      ["Steps", s.activity ? String(s.activity.totalSteps) : "--"],
    ];

    const top = 48;
    const rowH = Math.max(24, Math.floor((height - top - 8) / rows.length));
    rows.forEach(([label, value], i) => {
      const y = top + i * rowH;
      img.drawText(small, 16, y + 4, label, 150);
      img.drawText(medium, width - 16 - medium.measureText(value), y, value, 230);
    });

    if (s.updatedAtMs === null) {
      img.drawText(small, 16, height - 18, "Wear the ring to see live values.", 110);
    }
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
