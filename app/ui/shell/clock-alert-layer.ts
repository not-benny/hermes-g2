import { getDefaultLargeFont, getDefaultMediumFont, getDefaultSmallFont } from "../../graphics/bdffont";
import { GrayImage } from "../../graphics/image";
import { truncateText, wrapText } from "../../graphics/textwrap";
import type { ClockAlertKind, ClockAlertPhase } from "../../clock/alert-state";
import type { DashboardInputEvent, Layer, LayerContext } from "../layers";
import { strictDeliveryMarkerGray } from "./strict-delivery-marker";

export type ClockAlertVisualMode = "active" | "silent" | "acknowledged";

export type ClockAlertVisualState = {
  mode: ClockAlertVisualMode;
  kind: ClockAlertKind;
  label: string;
  count: number;
  phase: ClockAlertPhase;
};

/** Dedicated full-screen Clock surface: no retained HUD/sidebar can show through. */
export class ClockAlertLayer implements Layer {
  private deliveryNonce = 0;

  constructor(private state: ClockAlertVisualState) {}

  update(state: ClockAlertVisualState): void {
    this.state = state;
  }

  /** Force an imperceptible wire-frame change for an exact strict receipt. */
  bumpDeliveryNonce(): void {
    this.deliveryNonce++;
  }

  paint(ctx: LayerContext): GrayImage {
    const { width, height } = ctx.stack.getBaseSize();
    // Shell surface zero is color-key transparent. Gray 1 is visually black
    // but opaque, so it masks every persistent HUD/app surface underneath.
    const image = new GrayImage(width, height, 1);
    const large = getDefaultLargeFont();
    const medium = getDefaultMediumFont();
    const small = getDefaultSmallFont();
    const centerX = Math.floor(width / 2);
    const iconX = centerX - 48;
    const iconY = 58;

    drawClockGlyph(image, iconX, iconY, this.state.kind, this.state.mode === "active");

    const title = visualTitle(this.state);
    image.drawText(large, centerX - Math.floor(large.measureText(title) / 2), 184, title, 250);

    const labelLines = wrapText(medium, this.state.label, Math.min(440, width - 80)).slice(0, 2);
    for (let index = 0; index < labelLines.length; index++) {
      const line = truncateText(medium, labelLines[index]!, width - 80);
      image.drawText(
        medium,
        centerX - Math.floor(medium.measureText(line) / 2),
        232 + index * medium.lineHeight,
        line,
        220,
      );
    }

    if (this.state.count > 1) {
      const grouped = `+${this.state.count - 1} more`;
      image.drawText(small, centerX - Math.floor(small.measureText(grouped) / 2), 298, grouped, 150);
    }

    const footer = this.state.mode === "acknowledged"
      ? "PUT ON  •  ACKNOWLEDGED"
      : "TAP RING TO STOP";
    image.drawText(small, centerX - Math.floor(small.measureText(footer) / 2), height - 52, footer, 165);
    image.setPixel(width - 1, height - 1, strictDeliveryMarkerGray(this.deliveryNonce));
    return image;
  }

  handleInput(_event: DashboardInputEvent): void {
    // Ring click/double-click is intercepted by DashboardController even when
    // locked or screen-off, so no arm gesture can accidentally stop an alarm.
  }
}

function visualTitle(state: ClockAlertVisualState): string {
  if (state.mode === "acknowledged") return state.kind === "alarm" ? "ALARM ACK" : "TIMER ACK";
  if (state.mode === "silent") return state.kind === "alarm" ? "MISSED ALARM" : "TIMER FINISHED";
  return state.kind === "alarm" ? "ALARM" : "TIMER";
}

function drawClockGlyph(
  image: GrayImage,
  x: number,
  y: number,
  kind: ClockAlertKind,
  ringing: boolean,
): void {
  image.drawRoundedRect(x + 8, y + 8, 80, 80, 240, 30);
  image.drawRoundedRect(x + 9, y + 9, 78, 78, 140, 29);
  image.drawLine(x + 48, y + 24, x + 48, y + 49, 245);
  image.drawLine(x + 48, y + 49, x + 68, y + 61, 245);
  image.fillRect(x + 44, y + 45, 9, 9, 245);
  if (kind === "alarm") {
    image.drawLine(x + 16, y + 11, x + 29, y, 220);
    image.drawLine(x + 67, y, x + 80, y + 11, 220);
    image.drawLine(x + 25, y + 84, x + 18, y + 95, 180);
    image.drawLine(x + 71, y + 84, x + 78, y + 95, 180);
  } else {
    image.fillRect(x + 38, y, 20, 6, 220);
    image.fillRect(x + 44, y + 5, 8, 8, 220);
  }
  if (ringing) {
    image.drawLine(x - 3, y + 26, x - 10, y + 38, 140);
    image.drawLine(x - 7, y + 17, x - 18, y + 35, 90);
    image.drawLine(x + 99, y + 26, x + 106, y + 38, 140);
    image.drawLine(x + 103, y + 17, x + 114, y + 35, 90);
  }
}
