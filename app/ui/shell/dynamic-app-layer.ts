import { GrayImage } from "../../graphics/image";
import { getDefaultSmallFont } from "../../graphics/bdffont";
import { truncateText, wrapText } from "../../graphics/textwrap";
import type { DynamicAppComponent, DynamicAppState } from "../../assistant/dynamic-app";
import { dynamicAppComponentHeight } from "../../assistant/dynamic-app-layout";
import { drawSelectionHighlight } from "../menu";
import type { DashboardInputEvent, Layer, LayerContext } from "../layers";
import { GESTURE_CLICK, GESTURE_DOUBLE_CLICK, GESTURE_LONG_PRESS, GESTURE_SCROLL, gestureHints } from "../gestures";
import { shellContentOverlayViewport } from "./geometry";

const MARGIN_X = 8;
const MARGIN_Y = 4;
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
    private readonly contextLongPressLabel: () => "ask" | "window management" = () => "ask",
  ) {}

  close(): void {
    this.onClose();
  }

  paint(ctx: LayerContext, paintBelow: () => GrayImage): GrayImage {
    const image = paintBelow();
    const font = getDefaultSmallFont();
    const host = shellContentOverlayViewport(ctx.stack.getBaseSize());
    const x = host.x + MARGIN_X;
    const top = host.y + MARGIN_Y;
    const width = Math.max(1, host.width - MARGIN_X * 2);
    const height = Math.max(1, host.height - MARGIN_Y * 2);
    image.fillRoundedRect(x, top, width, height, 1, 10);
    image.drawRoundedRect(x, top, width, height, 100, 10);
    image.drawText(font, x + PAD, top + 9, truncateText(font, this.state.title, width - PAD * 2 - 70), 245);
    const contextState = this.state as DynamicAppState & {
      dashboardId?: string;
      dashboardState?: string;
      presentationLifetime?: string;
      presentationMode?: "single" | "deck";
      pageIndex?: number;
      pageCount?: number;
      pageId?: string;
      deckActionHandle?: string;
      deckActionLabel?: string;
      pinState?: "available" | "saved" | "not_pinnable" | "limit" | "save_failed" | "unpin_failed";
    };
    const isContextDashboard = Boolean(contextState.dashboardId);
    const isDeck = isContextDashboard && contextState.presentationMode === "deck";
    const displayedState = isDeck
      ? `${(contextState.pageIndex ?? 0) + 1}/${contextState.pageCount ?? 1}`
      : contextState.dashboardState ?? this.state.state;
    image.drawText(font, x + width - PAD - font.measureText(displayedState), top + 9, displayedState, displayedState === "ready" ? 160 : 210);
    if (isDeck && (contextState.pageCount ?? 1) > 1) {
      const pageCount = Math.max(1, Math.min(7, contextState.pageCount ?? 1));
      const activePage = Math.max(0, Math.min(pageCount - 1, contextState.pageIndex ?? 0));
      const segmentWidth = 12;
      const gap = 4;
      const railWidth = pageCount * segmentWidth + (pageCount - 1) * gap;
      const railX = x + Math.floor((width - railWidth) / 2);
      for (let index = 0; index < pageCount; index++) {
        const x = railX + index * (segmentWidth + gap);
        image.drawRect(x, top + 26, segmentWidth, 3, 70);
        if (index === activePage) image.fillRect(x + 1, top + 27, segmentWidth - 2, 1, 225);
      }
    }

    const actionHandles = this.state.components.flatMap(componentHandles);
    const focusedComponent = this.state.components[this.state.scrollOffset];
    const selectedHandle = isContextDashboard
      ? isDeck
        ? contextState.deckActionHandle ?? null
        : (focusedComponent ? componentHandles(focusedComponent)[0] ?? null : null)
      : actionHandles[this.state.selectedAction] ?? null;
    const start = isDeck ? 0 : Math.max(0, Math.min(this.state.scrollOffset, Math.max(0, this.state.components.length - 1)));
    let y = top + BODY_TOP;
    let omitted = 0;
    for (let index = start; index < this.state.components.length; index++) {
      const component = this.state.components[index]!;
      const estimate = dynamicAppComponentHeight(component, font.lineHeight);
      if (y + estimate > top + height - FOOTER_HEIGHT) {
        omitted = this.state.components.length - index;
        break;
      }
      const handles = componentHandles(component);
      const selected = selectedHandle !== null && handles.includes(selectedHandle);
      if (selected) drawSelectionHighlight(image, x + PAD - 5, y - 3, width - PAD * 2 + 10, estimate, true, 5);
      y = paintComponent(image, component, x + PAD, y, width - PAD * 2, font, selected ? selectedHandle : null);
    }
    // A deck has one navigation dimension: ring scrolling changes pages. Its
    // normalized pages are sized to fit, so never advertise an unreachable
    // nested component scroll if malformed/stale state somehow exceeds it.
    if (omitted > 0 && !isDeck) {
      const label = `… ${omitted} more — scroll`;
      image.drawText(font, x + PAD, top + height - FOOTER_HEIGHT - font.lineHeight, truncateText(font, label, width - PAD * 2), 125);
    }
    const selectedActionIndex = selectedHandle ? actionHandles.indexOf(selectedHandle) : -1;
    const genericNavigation = actionHandles.length
      ? `${selectedActionIndex >= 0 ? selectedActionIndex + 1 : "–"}/${actionHandles.length} · click select · ${GESTURE_DOUBLE_CLICK} close`
      : `scroll · ${GESTURE_DOUBLE_CLICK} close`;
    const pinLabels: string[] = [];
    if (contextState.pinState === "saved" || contextState.pinState === "unpin_failed") pinLabels.push("saved");
    if (contextState.pinState === "limit") pinLabels.push("pin limit");
    if (contextState.pinState === "not_pinnable") pinLabels.push("not pinnable");
    if (contextState.pinState === "save_failed") pinLabels.push("save failed");
    if (contextState.pinState === "unpin_failed") pinLabels.push("remove failed");
    const contextHints: Array<[string, string]> = [[GESTURE_SCROLL, isDeck ? "page" : "focus"]];
    if (selectedHandle) {
      contextHints.push([GESTURE_CLICK, isDeck
        ? (contextState.deckActionLabel ?? "select").toLowerCase()
        : focusedComponent?.type === "button" && focusedComponent.id === "phone:pin"
          ? focusedComponent.label.toLowerCase()
          : "select"]);
    }
    contextHints.push([GESTURE_LONG_PRESS, this.contextLongPressLabel()], [GESTURE_DOUBLE_CLICK, "close"]);
    const deckLabels = isDeck ? [contextState.dashboardState ?? this.state.state, `${(contextState.pageIndex ?? 0) + 1}/${contextState.pageCount ?? 1}`] : [];
    const footer = isContextDashboard
      ? `temporary${deckLabels.map((label) => ` · ${label}`).join("")}${pinLabels.map((label) => ` · ${label}`).join("")} · ${gestureHints(contextHints)}`
      : genericNavigation;
    image.drawText(font, x + PAD, top + height - 13, truncateText(font, footer, width - PAD * 2), 100);
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

function paintComponent(image: GrayImage, component: DynamicAppComponent, x: number, y: number, width: number,
    font: ReturnType<typeof getDefaultSmallFont>, selectedHandle: string | null): number {
  const selected = selectedHandle !== null;
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
  if (component.type !== "confirmation") return y;
  image.drawText(font, x, y, truncateText(font, component.text, width), 210);
  const choice = selectedHandle === component.confirm_handle ? "CONFIRM" : selectedHandle === component.cancel_handle ? "CANCEL" : "Confirm / cancel";
  image.drawText(font, x, y + font.lineHeight, selected ? `${choice} — click` : choice, selected ? 240 : 150);
  return y + font.lineHeight * 3 + 8;
}
