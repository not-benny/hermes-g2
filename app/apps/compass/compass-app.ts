import { getDefaultLargeFont, getDefaultMediumFont, getDefaultSmallFont } from "../../graphics/bdffont";
import { GrayImage } from "../../graphics/image";
import { glassesMotionService } from "../../native/glasses-motion-service";
import type { MotionLease, MotionSnapshot } from "../../motion/motion-service";
import { type DashboardInputEvent, type Layer, type LayerContext } from "../../ui/layers";
import {
  createInProcessWindow,
  YieldAtRootLayer,
  type InProcessAppOptions,
  type InProcessWindow,
} from "../../ui/shell/in-process-window";
import { shell } from "../../ui/shell/shell";

export const COMPASS_WINDOW_ID = "compass";
export const COMPASS_SURFACE_ID = "window:compass";
const RECONCILE_INTERVAL_MS = 400;

export class CompassLayer implements Layer {
  private heading: number | null = null;
  private status = "Waiting for compass data…";
  private quality = "Calibration: uncalibrated";
  private enabled = false;
  private removed = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lease: MotionLease | null = null;
  private lastSnapshotKey = "";
  private localCalibration: MotionSnapshot["localCalibration"] = {
    status: "idle", headingSamples: 0, neutralSamples: 0, headingSectors: 0, reason: null,
  };

  constructor(
    private readonly requestRender: () => void,
    private readonly motionService: Pick<
      typeof glassesMotionService,
      "acquire" | "snapshot" | "startLocalCalibration" | "cancelLocalCalibration"
    > = glassesMotionService,
  ) {}

  start(): void {
    this.lease = this.motionService.acquire(
      { compass: true, imuRate: "low" },
      (snapshot) => this.onMotion(snapshot),
    );
    this.lease.setActive(false);
    this.timer = setInterval(() => this.reconcile(), RECONCILE_INTERVAL_MS);
    this.reconcile();
  }

  stop(): void {
    if (this.removed) return;
    this.removed = true;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.lease?.release();
    this.lease = null;
    this.enabled = false;
  }

  onRemoved(): void {
    this.stop();
  }

  private reconcile(): void {
    if (this.removed) return;
    this.onMotion(this.motionService.snapshot());
    const visible = shell.isWindowVisible(COMPASS_WINDOW_ID);
    if (visible === this.enabled) return;
    this.enabled = visible;
    this.lease?.setActive(visible);
    this.status = visible ? "Waiting for compass data…" : "Compass paused";
    this.requestRender();
  }

  private onMotion(snapshot: MotionSnapshot): void {
    if (this.removed) return;
    const key = JSON.stringify([
      snapshot.state,
      snapshot.headingDegrees,
      snapshot.compassQuality,
      snapshot.calibrationQuality,
      snapshot.acceptedSamples,
      snapshot.rejectedSamples,
      snapshot.localCalibration,
    ]);
    if (key === this.lastSnapshotKey) return;
    this.lastSnapshotKey = key;
    this.heading = snapshot.headingDegrees;
    this.localCalibration = { ...snapshot.localCalibration };
    this.quality = `Cal: ${snapshot.calibrationQuality}  samples: ${snapshot.acceptedSamples}`;
    this.status = snapshot.localCalibration.status === "collecting"
      ? "Keep level; slowly turn full circle"
      : snapshot.localCalibration.status === "succeeded"
        ? "Local calibration saved (low confidence)"
        : snapshot.localCalibration.status === "failed"
          ? localCalibrationFailure(snapshot.localCalibration.reason)
          : snapshot.compassQuality === "interference"
      ? "Heading unreliable: possible interference"
      : snapshot.compassQuality === "calibrating"
        ? "Calibrating — move the glasses"
        : snapshot.headingDegrees === null
          ? snapshot.state === "stale" ? "Heading stale" : "Waiting for compass data…"
          : "Approximate magnetic heading";
    this.requestRender();
  }

  paint(ctx: LayerContext): GrayImage {
    const { width, height } = ctx.stack.getBaseSize();
    const image = new GrayImage(width, height, 0);
    const small = getDefaultSmallFont();
    const medium = getDefaultMediumFont();
    const large = getDefaultLargeFont();
    const cx = Math.round(width * 0.28);
    const cy = Math.round(height * 0.51);
    const radius = Math.min(94, Math.round(height * 0.34));

    drawCompassRose(image, cx, cy, radius, this.heading);

    if (this.heading !== null) {
      const headingText = `${Math.round(this.heading)}°`;
      const direction = cardinalDirection(this.heading);
      const textX = Math.round(width * 0.57);
      image.drawText(large, textX, 72, headingText, 255);
      image.drawText(large, textX, 108, direction, 210);
    } else {
      image.drawText(medium, Math.round(width * 0.56), 84, "--°", 150);
      image.drawText(small, Math.round(width * 0.56), 116, "No heading yet", 130);
    }
    image.drawText(small, Math.round(width * 0.56), 158, this.status, 125);
    image.drawText(small, Math.round(width * 0.56), 176, this.quality, 110);
    if (this.localCalibration.status === "collecting") {
      image.drawText(
        small,
        Math.round(width * 0.56),
        194,
        `${this.localCalibration.headingSamples}/24 headings  ${this.localCalibration.neutralSamples}/8 level  ${this.localCalibration.headingSectors}/6 sectors`,
        125,
      );
    }
    const action = this.localCalibration.status === "collecting"
      ? "click: cancel local calibration"
      : "click: start local calibration";
    image.drawText(small, Math.round(width * 0.56), height - 20, action, 145);
    return image;
  }

  handleInput(event: DashboardInputEvent, _ctx: LayerContext): void {
    if (event.type !== "click") return;
    if (this.localCalibration.status === "collecting") this.motionService.cancelLocalCalibration();
    else this.motionService.startLocalCalibration();
    this.onMotion(this.motionService.snapshot());
  }
}

function localCalibrationFailure(reason: MotionSnapshot["localCalibration"]["reason"]): string {
  if (reason === "cancelled") return "Local calibration cancelled";
  if (reason === "firmware-started") return "Firmware calibration took over";
  if (reason === "unavailable") return "Calibration unavailable: wait for sensors";
  return "Local calibration failed: insufficient quality";
}

export function createCompassAppWindow(options: InProcessAppOptions): InProcessWindow {
  let app: InProcessWindow;
  let requestRender = () => {};
  const layer = new CompassLayer(() => requestRender());
  app = createInProcessWindow({
    appId: "compass",
    windowId: COMPASS_WINDOW_ID,
    title: "Compass",
    iconLetter: "C",
    icon: "compass",
    closeable: true,
    actions: options.actions,
    baseLayer: new YieldAtRootLayer(layer),
    submitFrame: options.submitFrame,
    setSurfaceVisible: options.setSurfaceVisible,
    removeSurface: options.removeSurface,
    onClosed: () => {
      layer.stop();
      options.onClosed();
    },
  });
  requestRender = app.requestRender;
  layer.start();
  return app;
}

function normalizeHeading(value: number): number {
  return ((value % 360) + 360) % 360;
}

function cardinalDirection(heading: number): string {
  const names = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  return names[Math.round(normalizeHeading(heading) / 45) % names.length]!;
}

/** Draw a compass rose whose bright needle points toward magnetic north. */
function drawCompassRose(image: GrayImage, cx: number, cy: number, radius: number, heading: number | null): void {
  drawCircle(image, cx, cy, radius, 105);
  const small = getDefaultSmallFont();
  const medium = getDefaultMediumFont();
  const cardinals: Array<[string, number]> = [["N", -90], ["E", 0], ["S", 90], ["W", 180]];
  for (const [label, degrees] of cardinals) {
    const angle = (degrees - (heading ?? 0)) * Math.PI / 180;
    const x = cx + Math.cos(angle) * (radius - 14) - medium.measureText(label) / 2;
    const y = cy + Math.sin(angle) * (radius - 14) - medium.lineHeight / 2;
    image.drawText(medium, Math.round(x), Math.round(y), label, label === "N" ? 230 : 105);
  }
  const intercardinals: Array<[string, number]> = [["NE", -45], ["SE", 45], ["SW", 135], ["NW", -135]];
  for (const [label, degrees] of intercardinals) {
    const angle = (degrees - (heading ?? 0)) * Math.PI / 180;
    const x = cx + Math.cos(angle) * (radius - 14) - small.measureText(label) / 2;
    const y = cy + Math.sin(angle) * (radius - 14) - small.lineHeight / 2;
    image.drawText(small, Math.round(x), Math.round(y), label, 85);
  }
  image.fillRect(cx - 2, cy - 2, 5, 5, 180);
  if (heading === null) return;
  const northAngle = (-90 - heading) * Math.PI / 180;
  const nx = cx + Math.cos(northAngle) * (radius - 30);
  const ny = cy + Math.sin(northAngle) * (radius - 30);
  const sx = cx - Math.cos(northAngle) * (radius - 38);
  const sy = cy - Math.sin(northAngle) * (radius - 38);
  drawThickLine(image, cx, cy, nx, ny, 255);
  image.drawLine(cx, cy, sx, sy, 75);
}

function drawCircle(image: GrayImage, cx: number, cy: number, radius: number, value: number): void {
  let x = radius;
  let y = 0;
  let error = 1 - x;
  while (x >= y) {
    const points = [[x, y], [y, x], [-y, x], [-x, y], [-x, -y], [-y, -x], [y, -x], [x, -y]];
    for (const [dx, dy] of points) image.setPixel(cx + dx!, cy + dy!, value);
    y++;
    if (error < 0) error += 2 * y + 1;
    else { x--; error += 2 * (y - x) + 1; }
  }
}

function drawThickLine(image: GrayImage, x0: number, y0: number, x1: number, y1: number, value: number): void {
  image.drawLine(x0, y0, x1, y1, value);
  image.drawLine(x0 - 1, y0, x1 - 1, y1, value);
  image.drawLine(x0 + 1, y0, x1 + 1, y1, value);
}
