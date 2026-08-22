import { GrayImage } from "../../graphics/image";
import { getDefaultSmallFont } from "../../graphics/bdffont";
import { truncateText, wrapText } from "../../graphics/textwrap";
import type { RenderViewState } from "../../assistant/render-view";
import { drawSelectionHighlight } from "../menu";
import type { DashboardInputEvent, Layer, LayerContext } from "../layers";
import { GESTURE_DOUBLE_CLICK } from "../gestures";
import { visibleAppViewportRect } from "./geometry";

const MARGIN = 8;
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
    const viewport = visibleAppViewportRect("min");
    const x = viewport.x + MARGIN;
    const top = viewport.y + MARGIN;
    const width = viewport.width - MARGIN * 2;
    const height = viewport.height - MARGIN * 2;
    image.fillRoundedRect(x, top, width, height, 1, 10);
    image.drawRoundedRect(x, top, width, height, 90, 10);
    image.drawText(font, x + PAD, top + 10, truncateText(font, this.state.title, width - PAD * 2), 235);

    const actionRows = this.state.actions.length ? Math.min(this.state.actions.length, 3) : 0;
    const contentBottom = top + height - (actionRows ? actionRows * ACTION_ROW_HEIGHT + 22 : 18);
    let y = top + 34;
    for (const block of this.state.blocks) {
      if (y + font.lineHeight > contentBottom) break;
      if (block.type === "divider") {
        image.drawLine(x + PAD, y + 5, x + width - PAD, y + 5, 80);
        y += 12;
        continue;
      }
      if (block.type === "text") {
        const lines = wrapText(font, block.text, width - PAD * 2);
        for (const line of lines) {
          if (y + font.lineHeight > contentBottom) break;
          image.drawText(font, x + PAD, y, line, block.emphasis === "strong" ? 245 : 190);
          y += font.lineHeight;
        }
        y += 2;
        continue;
      }
      const label = block.label;
      if (block.type === "key_value") {
        const value = truncateText(font, block.value, Math.floor((width - PAD * 2) * 0.62));
        const valueWidth = font.measureText(value);
        image.drawText(font, x + PAD, y, truncateText(font, label, width - PAD * 2 - valueWidth - 12), 150);
        image.drawText(font, x + width - PAD - valueWidth, y, value, 225);
        y += font.lineHeight + 3;
        continue;
      }
      image.drawText(font, x + PAD, y, truncateText(font, label, width - PAD * 2), 160);
      const barX = x + PAD;
      const barY = y + font.lineHeight + 1;
      const barWidth = width - PAD * 2;
      image.drawRect(barX, barY, barWidth, 7, 100);
      image.fillRect(barX + 1, barY + 1, Math.round((barWidth - 2) * block.value), 5, 210);
      y += font.lineHeight + 12;
    }

    if (actionRows) {
      const visibleStart = Math.max(0, Math.min(this.state.selectedAction - 1, this.state.actions.length - actionRows));
      const actionTop = top + height - actionRows * ACTION_ROW_HEIGHT - 18;
      for (let row = 0; row < actionRows; row++) {
        const index = visibleStart + row;
        const action = this.state.actions[index];
        if (!action) continue;
        const rowY = actionTop + row * ACTION_ROW_HEIGHT;
        if (index === this.state.selectedAction) {
          drawSelectionHighlight(image, x + PAD - 4, rowY - 2, width - PAD * 2 + 8, ACTION_ROW_HEIGHT - 2, true, 6);
        }
        image.drawText(font, x + PAD, rowY + 2, truncateText(font, action.label, width - PAD * 2), index === this.state.selectedAction ? 255 : 190);
      }
    }
    const footer = actionRows
      ? `${this.state.selectedAction + 1}/${this.state.actions.length} · scroll · ${GESTURE_DOUBLE_CLICK} close`
      : `${GESTURE_DOUBLE_CLICK} close`;
    image.drawText(font, x + PAD, top + height - 14, truncateText(font, footer, width - PAD * 2), 100);
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
