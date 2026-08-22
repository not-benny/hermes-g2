import { G2_LENS_WIDTH, GrayImage } from "../../graphics/image";
import { getDefaultSmallFont } from "../../graphics/bdffont";
import { truncateText, wrapText } from "../../graphics/textwrap";
import type { DynamicAppComponent, DynamicAppState } from "../../assistant/dynamic-app";
import { drawSelectionHighlight } from "../menu";
import type { DashboardInputEvent, Layer, LayerContext } from "../layers";
import { GESTURE_DOUBLE_CLICK } from "../gestures";
import { MIN_WINDOW_HEIGHT, minWindowTop } from "./geometry";

const X = 28;
const WIDTH = G2_LENS_WIDTH - 56;
const MARGIN_Y = 10;
const HEIGHT = MIN_WINDOW_HEIGHT - MARGIN_Y * 2;
const PAD = 14;
const BODY_TOP = 38;
const FOOTER_HEIGHT = 17;

function componentHandles(component: DynamicAppComponent): string[] {
  if (component.type === "toggle" || component.type === "button") return [component.action_handle];
  if (component.type === "confirmation") return [component.confirm_handle, component.cancel_handle];
  return [];
}

/** Deterministic bounded renderer for provider-neutral dynamic app models. */
export class ShellDynamicAppLayer implements Layer {
  constructor(
    readonly state: DynamicAppState,
    private readonly onInput: (type: "scroll-up" | "scroll-down" | "click", foreground: boolean) => boolean,
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
    image.drawRoundedRect(X, top, WIDTH, HEIGHT, 100, 10);
    image.drawText(font, X + PAD, top + 9, truncateText(font, this.state.title, WIDTH - PAD * 2 - 70), 245);
    image.drawText(font, X + WIDTH - PAD - font.measureText(this.state.state), top + 9, this.state.state, this.state.state === "ready" ? 160 : 210);

    const actionHandles = this.state.components.flatMap(componentHandles);
    let actionIndex = 0;
    const selectedHandle = actionHandles[this.state.selectedAction] ?? null;
    const start = Math.max(0, Math.min(this.state.scrollOffset, Math.max(0, this.state.components.length - 1)));
    let y = top + BODY_TOP;
    let omitted = 0;
    for (let index = start; index < this.state.components.length; index++) {
      const component = this.state.components[index]!;
      const estimate = componentHeight(component, font.lineHeight);
      if (y + estimate > top + HEIGHT - FOOTER_HEIGHT) {
        omitted = this.state.components.length - index;
        break;
      }
      const handles = componentHandles(component);
      const selected = selectedHandle !== null && handles.includes(selectedHandle);
      if (selected) drawSelectionHighlight(image, X + PAD - 5, y - 3, WIDTH - PAD * 2 + 10, estimate, true, 5);
      y = paintComponent(image, component, X + PAD, y, WIDTH - PAD * 2, font, selected);
      actionIndex += handles.length;
    }
    if (omitted > 0) {
      const label = `… ${omitted} more — scroll`;
      image.drawText(font, X + PAD, top + HEIGHT - FOOTER_HEIGHT - font.lineHeight, truncateText(font, label, WIDTH - PAD * 2), 125);
    }
    const footer = actionHandles.length
      ? `${this.state.selectedAction + 1}/${actionHandles.length} · click select · ${GESTURE_DOUBLE_CLICK} close`
      : `scroll · ${GESTURE_DOUBLE_CLICK} close`;
    image.drawText(font, X + PAD, top + HEIGHT - 13, truncateText(font, footer, WIDTH - PAD * 2), 100);
    return image;
  }

  handleInput(event: DashboardInputEvent, ctx: LayerContext): void {
    if (event.type === "double-click") {
      this.close();
      return;
    }
    if (event.type !== "scroll-up" && event.type !== "scroll-down" && event.type !== "click") return;
    if (this.onInput(event.type, ctx.stack.isFocused())) ctx.actions.requestRender();
  }
}

function componentHeight(component: DynamicAppComponent, lineHeight: number): number {
  switch (component.type) {
    case "divider": return 10;
    case "progress": return lineHeight + 13;
    case "card": return lineHeight * 3 + 7;
    case "list": return Math.min(component.items.length, 4) * lineHeight + 5;
    case "confirmation": return lineHeight * 3 + 8;
    default: return lineHeight + 6;
  }
}

function paintComponent(image: GrayImage, component: DynamicAppComponent, x: number, y: number, width: number,
    font: ReturnType<typeof getDefaultSmallFont>, selected: boolean): number {
  if (component.type === "divider") {
    image.drawLine(x, y + 3, x + width, y + 3, 75);
    return y + 10;
  }
  if (component.type === "heading" || component.type === "text") {
    image.drawText(font, x, y, truncateText(font, component.text, width), component.type === "heading" ? 245 : 185);
    return y + font.lineHeight + 6;
  }
  if (component.type === "status") {
    const value = truncateText(font, component.value, Math.floor(width * 0.45));
    const valueWidth = font.measureText(value);
    image.drawText(font, x, y, truncateText(font, component.label, width - valueWidth - 12), 155);
    image.drawText(font, x + width - valueWidth, y, value, component.tone === "critical" ? 255 : 220);
    return y + font.lineHeight + 6;
  }
  if (component.type === "progress") {
    image.drawText(font, x, y, truncateText(font, component.label, width), 170);
    image.drawRect(x, y + font.lineHeight + 1, width, 7, 90);
    image.fillRect(x + 1, y + font.lineHeight + 2, Math.round((width - 2) * component.value), 5, 215);
    return y + font.lineHeight + 13;
  }
  if (component.type === "card") {
    image.drawText(font, x, y, truncateText(font, component.title, width), 230);
    const lines = wrapText(font, component.body, width).slice(0, 2);
    for (const line of lines) {
      y += font.lineHeight;
      image.drawText(font, x, y, line, 165);
    }
    return y + font.lineHeight + 7;
  }
  if (component.type === "list") {
    for (const item of component.items.slice(0, 4)) {
      image.drawText(font, x, y, truncateText(font, `• ${item}`, width), 180);
      y += font.lineHeight;
    }
    return y + 5;
  }
  if (component.type === "icon") {
    image.drawText(font, x, y, truncateText(font, `${component.name.toUpperCase()}  ${component.label}`, width), 190);
    return y + font.lineHeight + 6;
  }
  if (component.type === "toggle") {
    const marker = component.value ? "[ON]" : "[OFF]";
    image.drawText(font, x, y, truncateText(font, component.label, width - font.measureText(marker) - 12), selected ? 255 : 190);
    image.drawText(font, x + width - font.measureText(marker), y, marker, component.value ? 230 : 130);
    return y + font.lineHeight + 6;
  }
  if (component.type === "button") {
    image.drawText(font, x, y, truncateText(font, `› ${component.label}`, width), selected ? 255 : 190);
    return y + font.lineHeight + 6;
  }
  image.drawText(font, x, y, truncateText(font, component.text, width), 210);
  image.drawText(font, x, y + font.lineHeight, selected ? "Click to confirm" : "Confirm / cancel", 150);
  return y + font.lineHeight * 3 + 8;
}
