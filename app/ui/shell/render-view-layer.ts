import { G2_LENS_WIDTH, GrayImage } from "../../graphics/image";
import { getDefaultSmallFont } from "../../graphics/bdffont";
import { truncateText, wrapText } from "../../graphics/textwrap";
import type { RenderViewState } from "../../assistant/render-view";
import { drawSelectionHighlight } from "../menu";
import type { DashboardInputEvent, Layer, LayerContext } from "../layers";
import { GESTURE_DOUBLE_CLICK } from "../gestures";
import { MIN_WINDOW_HEIGHT, minWindowTop } from "./geometry";

const X = 40;
const WIDTH = G2_LENS_WIDTH - 80;
const MARGIN_Y = 18;
const HEIGHT = MIN_WINDOW_HEIGHT - MARGIN_Y * 2;
const PAD = 14;
const ACTION_ROW_HEIGHT = 20;

/** Bounded, inert renderer for the shell-owned remote-view surface. */
export class ShellRemoteViewLayer implements Layer {
  constructor(
    readonly state: RenderViewState,
    private readonly onGesture: (type: "scroll-up" | "scroll-down" | "click", foreground: boolean) => boolean,
    private readonly onClose: () => void,
  ) {}

  close(): void {
    this.onClose();
  }

  paint(_ctx: LayerContext, paintBelow: () => GrayImage): GrayImage {
    const image = paintBelow();
    const font = getDefaultSmallFont();
    const top = minWindowTop() + MARGIN_Y;
    image.fillRoundedRect(X, top, WIDTH, HEIGHT, 1, 10);
    image.drawRoundedRect(X, top, WIDTH, HEIGHT, 90, 10);
    image.drawText(font, X + PAD, top + 10, truncateText(font, this.state.title, WIDTH - PAD * 2), 235);

    const actionRows = this.state.actions.length ? Math.min(this.state.actions.length, 3) : 0;
    const contentBottom = top + HEIGHT - (actionRows ? actionRows * ACTION_ROW_HEIGHT + 22 : 18);
    let y = top + 34;
    for (const block of this.state.blocks) {
      if (y + font.lineHeight > contentBottom) break;
      if (block.type === "divider") {
        image.drawLine(X + PAD, y + 5, X + WIDTH - PAD, y + 5, 80);
        y += 12;
        continue;
      }
      if (block.type === "text") {
        const lines = wrapText(font, block.text, WIDTH - PAD * 2);
        for (const line of lines) {
          if (y + font.lineHeight > contentBottom) break;
          image.drawText(font, X + PAD, y, line, block.emphasis === "strong" ? 245 : 190);
          y += font.lineHeight;
        }
        y += 2;
        continue;
      }
      const label = block.label;
      if (block.type === "key_value") {
        const valueWidth = font.measureText(block.value);
        image.drawText(font, X + PAD, y, truncateText(font, label, WIDTH - PAD * 2 - valueWidth - 12), 150);
        image.drawText(font, X + WIDTH - PAD - valueWidth, y, block.value, 225);
        y += font.lineHeight + 3;
        continue;
      }
      image.drawText(font, X + PAD, y, truncateText(font, label, WIDTH - PAD * 2), 160);
      const barX = X + PAD;
      const barY = y + font.lineHeight + 1;
      const barWidth = WIDTH - PAD * 2;
      image.drawRect(barX, barY, barWidth, 7, 100);
      image.fillRect(barX + 1, barY + 1, Math.round((barWidth - 2) * block.value), 5, 210);
      y += font.lineHeight + 12;
    }

    if (actionRows) {
      const visibleStart = Math.max(0, Math.min(this.state.selectedAction - 1, this.state.actions.length - actionRows));
      const actionTop = top + HEIGHT - actionRows * ACTION_ROW_HEIGHT - 18;
      for (let row = 0; row < actionRows; row++) {
        const index = visibleStart + row;
        const action = this.state.actions[index];
        if (!action) continue;
        const rowY = actionTop + row * ACTION_ROW_HEIGHT;
        if (index === this.state.selectedAction) {
          drawSelectionHighlight(image, X + PAD - 4, rowY - 2, WIDTH - PAD * 2 + 8, ACTION_ROW_HEIGHT - 2, true, 6);
        }
        image.drawText(font, X + PAD, rowY + 2, truncateText(font, action.label, WIDTH - PAD * 2), index === this.state.selectedAction ? 255 : 190);
      }
    }
    image.drawText(font, X + PAD, top + HEIGHT - 14, `${GESTURE_DOUBLE_CLICK} close`, 100);
    return image;
  }

  handleInput(event: DashboardInputEvent, ctx: LayerContext): void {
    if (event.type === "double-click") {
      this.close();
      return;
    }
    if (event.type !== "scroll-up" && event.type !== "scroll-down" && event.type !== "click") return;
    if (this.onGesture(event.type, ctx.stack.isFocused())) ctx.actions.requestRender();
  }
}
