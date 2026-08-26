import { getDefaultMediumFont, getDefaultSmallFont } from "../../graphics/bdffont";
import { GrayImage } from "../../graphics/image";
import { truncateText, wrapText } from "../../graphics/textwrap";
import { attentionHubStore, type AttentionItem } from "../../attention/hub";
import { LongReaderLayer } from "../../ui/reader/long-reader";
import { type DashboardInputEvent, type Layer, type LayerContext } from "../../ui/layers";
import { drawSelectionHighlight } from "../../ui/menu";
import { shell } from "../../ui/shell/shell";
import { createInProcessWindow, YieldAtRootLayer, type InProcessAppOptions, type InProcessWindow } from "../../ui/shell/in-process-window";

export const ATTENTION_WINDOW_ID = "attention";
export const ATTENTION_SURFACE_ID = "window:attention";

class AttentionHubLayer implements Layer {
  private selected = 0;
  private lastRefreshMs = 0;
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly requestRender: () => void) {
    this.unsubscribe = attentionHubStore.onChange((snapshot) => {
      this.selected = Math.min(this.selected, Math.max(0, snapshot.items.length - 1));
      this.requestRender();
    });
  }

  onRemoved(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  refresh(): void {
    attentionHubStore.refresh();
    this.lastRefreshMs = Date.now();
  }

  menuItems() {
    return [{ label: "Refresh attention", onSelect: (ctx: LayerContext) => { ctx.stack.pop(); this.refresh(); } }];
  }

  paint(ctx: LayerContext): GrayImage {
    if (Date.now() - this.lastRefreshMs > 2_000) this.refresh();
    const snapshot = attentionHubStore.snapshot();
    const { width, height } = ctx.stack.getBaseSize();
    const image = new GrayImage(width, height, 0);
    const small = getDefaultSmallFont();
    const medium = getDefaultMediumFont();
    image.drawText(medium, 18, 8, "ATTENTION", 245);
    const unread = snapshot.items.filter((item) => item.unread).length;
    const count = `${unread} new · ${snapshot.items.length}`;
    image.drawText(small, width - 18 - small.measureText(count), 13, count, unread ? 230 : 110);
    image.drawLine(18, 35, width - 18, 35, 70);
    if (!snapshot.items.length) {
      image.drawText(small, 18, 67, "Nothing needs your attention.", 180);
      image.drawText(small, 18, height - 18, "Double-click: back", 110);
      return image;
    }
    this.selected = Math.max(0, Math.min(this.selected, snapshot.items.length - 1));
    const visible = Math.max(1, Math.floor((height - 72) / 42));
    const start = Math.max(0, Math.min(this.selected - Math.floor(visible / 2), snapshot.items.length - visible));
    for (let index = start; index < Math.min(snapshot.items.length, start + visible); index++) {
      const item = snapshot.items[index]!;
      const y = 48 + (index - start) * 42;
      if (index === this.selected) drawSelectionHighlight(image, 12, y - 4, width - 24, 36, ctx.stack.isFocused(), 5);
      const marker = item.unread ? "●" : item.stale ? "~" : "·";
      const heading = `${marker} ${item.kind.toUpperCase()}  ${item.title}`;
      image.drawText(small, 20, y, truncateText(small, heading, width - 40), index === this.selected ? 240 : 185);
      image.drawText(small, 28, y + 16, truncateText(small, item.summary || item.source, width - 48), item.stale ? 105 : 145);
    }
    image.drawText(small, 18, height - 18, "Scroll: select   Click: read   Double-click: back", 105);
    return image;
  }

  handleInput(event: DashboardInputEvent, ctx: LayerContext): void {
    const items = attentionHubStore.snapshot().items;
    if (event.type === "double-click") { shell.yieldFocusToSidebar(); return; }
    if (event.type === "scroll-up" || event.type === "scroll-down") {
      if (!items.length) return;
      const direction = event.type === "scroll-down" ? 1 : -1;
      this.selected = (this.selected + direction + items.length) % items.length;
      return;
    }
    if (event.type !== "click") return;
    const item = items[this.selected];
    if (!item) return;
    attentionHubStore.markRead(item.id);
    const revision = attentionHubStore.snapshot().revision;
    ctx.stack.push(new LongReaderLayer({
      owner: "context-dashboard",
      documentId: item.id,
      revision: String(revision),
      title: item.title,
      text: item.text || [item.title, item.summary].filter(Boolean).join("\n"),
      isCurrent: () => attentionHubStore.snapshot().items.some((candidate) => candidate.id === item.id),
    }));
  }
}

export function createAttentionAppWindow(options: InProcessAppOptions): InProcessWindow {
  let app: InProcessWindow;
  let layer: AttentionHubLayer;
  layer = new AttentionHubLayer(() => app.requestRender());
  app = createInProcessWindow({
    appId: "attention",
    windowId: ATTENTION_WINDOW_ID,
    title: "Attention",
    iconLetter: "A",
    icon: "list-checks",
    closeable: true,
    menuItems: () => layer.menuItems(),
    actions: options.actions,
    baseLayer: new YieldAtRootLayer(layer),
    submitFrame: options.submitFrame,
    setSurfaceVisible: options.setSurfaceVisible,
    removeSurface: options.removeSurface,
    onClosed: () => { layer.onRemoved(); options.onClosed(); },
  });
  layer.refresh();
  return app;
}
