import { getDefaultMediumFont, getDefaultSmallFont } from "../../graphics/bdffont";
import { GrayImage } from "../../graphics/image";
import { truncateText, wrapText } from "../../graphics/textwrap";
import { captureStore, type CaptureRecord } from "../../captures/store";
import { workTasksStore } from "../../work-tasks/store";
import { VoiceInputLayer } from "../../ui/shell/voice-input";
import { type DashboardInputEvent, type Layer, type LayerContext } from "../../ui/layers";
import { drawSelectionHighlight, openModalMenu } from "../../ui/menu";
import { shell } from "../../ui/shell/shell";
import { createInProcessWindow, type InProcessAppOptions, type InProcessWindow } from "../../ui/shell/in-process-window";

export const CAPTURES_WINDOW_ID = "captures";
export const CAPTURES_SURFACE_ID = "window:captures";

class CaptureDetailLayer implements Layer {
  private lineOffset = 0;
  constructor(private readonly recordId: string, private readonly requestRender: () => void) {}

  paint(ctx: LayerContext): GrayImage {
    const { width, height } = ctx.stack.getBaseSize();
    const image = new GrayImage(width, height, 0);
    const small = getDefaultSmallFont();
    const medium = getDefaultMediumFont();
    const record = captureStore.snapshot().captures.find((item) => item.id === this.recordId);
    image.drawText(medium, 18, 8, "CAPTURE", 245);
    image.drawLine(18, 35, width - 18, 35, 70);
    if (!record) {
      image.drawText(small, 18, 58, "Capture was deleted.", 220);
      image.drawText(small, 18, height - 18, "Double-click: back", 110);
      return image;
    }
    const lines = wrapText(small, record.text, width - 36, { breakLongWords: true });
    const visible = Math.max(1, Math.floor((height - 90) / (small.lineHeight + 3)));
    this.lineOffset = Math.max(0, Math.min(this.lineOffset, Math.max(0, lines.length - visible)));
    for (const [index, line] of lines.slice(this.lineOffset, this.lineOffset + visible).entries()) {
      image.drawText(small, 18, 51 + index * (small.lineHeight + 3), line, 230);
    }
    image.drawText(small, 18, height - 36, "Click: actions", 170);
    image.drawText(small, 18, height - 18, `Scroll: text   ${this.lineOffset + 1}-${Math.min(lines.length, this.lineOffset + visible)}/${lines.length}`, 105);
    return image;
  }

  handleInput(event: DashboardInputEvent, ctx: LayerContext): void {
    if (event.type === "double-click") { ctx.stack.pop(); return; }
    if (event.type === "scroll-up" || event.type === "scroll-down") {
      const record = captureStore.snapshot().captures.find((item) => item.id === this.recordId);
      if (!record) return;
      const lines = wrapText(getDefaultSmallFont(), record.text, ctx.stack.getBaseSize().width - 36, { breakLongWords: true });
      const visible = Math.max(1, Math.floor((ctx.stack.getBaseSize().height - 90) / (getDefaultSmallFont().lineHeight + 3)));
      this.lineOffset = Math.max(0, Math.min(this.lineOffset + (event.type === "scroll-down" ? 1 : -1), Math.max(0, lines.length - visible)));
      this.requestRender();
      return;
    }
    if (event.type !== "click") return;
    const record = captureStore.snapshot().captures.find((item) => item.id === this.recordId);
    if (!record) return;
    openModalMenu(ctx, "CAPTURE ACTIONS", [
      { label: "Convert to Work Task", onSelect: (menuCtx) => {
        try {
          workTasksStore.addTask({ operationId: `capture.${record.id}`, title: Array.from(record.text).slice(0, 120).join(""), lane: "inbox" });
          captureStore.remove(record.id);
          menuCtx.stack.pop();
          ctx.stack.pop();
        } catch {
          menuCtx.stack.pop();
          this.requestRender();
        }
      } },
      { label: "Delete capture", onSelect: (menuCtx) => { menuCtx.stack.pop(); captureStore.remove(record.id); ctx.stack.pop(); } },
      { label: "Back", onSelect: (menuCtx) => menuCtx.stack.pop() },
    ]);
  }
}

class CapturesLayer implements Layer {
  private selected = 0;
  private status = "";
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly requestRender: () => void) {
    this.unsubscribe = captureStore.onChange(() => {
      this.selected = Math.min(this.selected, Math.max(0, captureStore.snapshot().captures.length - 1));
      this.requestRender();
    });
  }

  onRemoved(): void { this.unsubscribe?.(); this.unsubscribe = null; }

  menuItems() {
    return [{
      label: "New capture by voice",
      onSelect: (ctx: LayerContext) => {
        ctx.stack.pop();
        const layer = new VoiceInputLayer({
          actions: ctx.actions,
          dismiss: () => ctx.stack.pop(),
          onClosed: () => ctx.actions.requestRender(),
          sendTargets: [{
            id: "capture",
            label: "Save capture",
            onSend: (text) => {
              try { captureStore.create(text); this.status = "Capture saved"; }
              catch { this.status = "Capture could not be saved"; }
            },
          }],
          defaultTargetIndex: 0,
        });
        ctx.stack.push(layer);
      },
    }];
  }

  paint(ctx: LayerContext): GrayImage {
    const { width, height } = ctx.stack.getBaseSize();
    const image = new GrayImage(width, height, 0);
    const small = getDefaultSmallFont();
    const medium = getDefaultMediumFont();
    const captures = captureStore.snapshot().captures;
    image.drawText(medium, 18, 8, "CAPTURE INBOX", 245);
    image.drawText(small, width - 18 - small.measureText(`${captures.length}/128`), 13, `${captures.length}/128`, 110);
    image.drawLine(18, 35, width - 18, 35, 70);
    if (!captureStore.snapshot().available) {
      image.drawText(small, 18, 62, "Encrypted capture store unavailable", 220);
      image.drawText(small, 18, height - 18, "Double-click: back", 110);
      return image;
    }
    const visible = Math.max(1, Math.floor((height - 74) / 37));
    if (!captures.length) image.drawText(small, 18, 65, "No captures yet. Open the menu to record one.", 150);
    for (let index = 0; index < Math.min(visible, captures.length); index++) {
      const record = captures[index]!;
      const y = 48 + index * 37;
      if (index === this.selected) drawSelectionHighlight(image, 12, y - 4, width - 24, 32, ctx.stack.isFocused(), 5);
      image.drawText(small, 22, y, truncateText(small, `${index === this.selected ? "›" : " "} ${record.text}`, width - 44), index === this.selected ? 245 : 185);
      image.drawText(small, 24, y + 16, new Date(record.updatedAtMs).toLocaleString(), 90);
    }
    image.drawText(small, 18, height - 18, this.status || "Scroll: select   Click: read   Double-click: apps", 110);
    return image;
  }

  handleInput(event: DashboardInputEvent, ctx: LayerContext): void {
    const count = captureStore.snapshot().captures.length;
    if (event.type === "scroll-down") this.selected = count ? Math.min(count - 1, this.selected + 1) : 0;
    else if (event.type === "scroll-up") this.selected = Math.max(0, this.selected - 1);
    else if (event.type === "click" && count) ctx.stack.push(new CaptureDetailLayer(captureStore.snapshot().captures[this.selected]!.id, this.requestRender));
    else if (event.type === "double-click") shell.yieldFocusToSidebar();
    this.requestRender();
  }
}

export function createCapturesWindow(options: InProcessAppOptions): InProcessWindow {
  let requestRender = () => {};
  const layer = new CapturesLayer(() => requestRender());
  const app = createInProcessWindow({
    appId: "captures",
    windowId: CAPTURES_WINDOW_ID,
    title: "Captures",
    iconLetter: "C",
    icon: "file-text",
    closeable: true,
    menuItems: () => layer.menuItems(),
    actions: options.actions,
    baseLayer: layer,
    submitFrame: options.submitFrame,
    setSurfaceVisible: options.setSurfaceVisible,
    removeSurface: options.removeSurface,
    onClosed: () => { layer.onRemoved(); options.onClosed(); },
  });
  requestRender = app.requestRender;
  return app;
}
