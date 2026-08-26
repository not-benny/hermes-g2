import { assistantBridge } from "../../assistant/bridge-client";
import { getDefaultMediumFont, getDefaultSmallFont } from "../../graphics/bdffont";
import { GrayImage } from "../../graphics/image";
import { truncateText, wrapText } from "../../graphics/textwrap";
import { CockpitViewModel } from "../../agent-cockpit/view-model";
import { type DashboardInputEvent, type Layer, type LayerContext } from "../../ui/layers";
import { drawSelectionHighlight } from "../../ui/menu";
import {
  createInProcessWindow,
  type InProcessAppOptions,
  type InProcessWindow,
} from "../../ui/shell/in-process-window";
import { shell } from "../../ui/shell/shell";

export const AGENT_COCKPIT_WINDOW_ID = "agent-cockpit";
export const AGENT_COCKPIT_SURFACE_ID = "window:agent-cockpit";

class AgentCockpitLayer implements Layer {
  private readonly model = new CockpitViewModel({
    refresh: () => assistantBridge.refreshCockpit(),
    answer: (...args) => assistantBridge.cockpit.answer(...args),
    answerText: (...args) => assistantBridge.cockpit.answerText(...args),
    decidePermission: (...args) => assistantBridge.cockpit.decidePermission(...args),
    steer: (...args) => assistantBridge.cockpit.steer(...args),
    interrupt: (...args) => assistantBridge.cockpit.interrupt(...args),
  });
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly requestRender: () => void) {
    this.model.update(assistantBridge.cockpit.snapshot());
    this.unsubscribe = assistantBridge.cockpit.onChange((snapshot) => {
      this.model.update(snapshot);
      this.requestRender();
    });
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  onRemoved(): void {
    this.stop();
  }

  receiveText(text: string): void {
    if (this.model.beginTextAnswer()) {
      if (this.model.reviewTextAnswer(text)) this.requestRender();
      return;
    }
    if (!this.model.beginSteer()) return;
    // The shell voice layer already reviewed transcription once. The cockpit
    // deliberately adds a second exact-run review before sending it.
    if (this.model.reviewSteer(text)) this.requestRender();
  }

  paint(ctx: LayerContext): GrayImage {
    const { width, height } = ctx.stack.getBaseSize();
    const image = new GrayImage(width, height, 0);
    const small = getDefaultSmallFont();
    const medium = getDefaultMediumFont();
    const screen = this.model.screen();
    const left = 30;
    const right = width - 30;
    image.drawText(medium, left, 14, truncateText(medium, screen.title, right - left), 245);
    image.drawLine(left, 38, right, 38, 80);

    let y = 50;
    const bodyWidth = right - left;
    for (const paragraph of screen.body) {
      for (const line of wrapText(small, paragraph, bodyWidth).slice(0, 2)) {
        if (y > height - 58) break;
        image.drawText(small, left, y, line, 170);
        y += small.lineHeight + 3;
      }
    }
    if (screen.body.length) y += 4;
    const rowStart = screen.scrollOffset ?? 0;
    const rowEnd = Math.min(screen.rows.length, rowStart + (screen.visibleRows ?? screen.rows.length));
    for (let index = rowStart; index < rowEnd && y < height - 43; index++) {
      const row = screen.rows[index]!;
      if (index === screen.selected) drawSelectionHighlight(image, left - 5, y - 3, bodyWidth + 10, small.lineHeight + 7, true, 4);
      const ink = row.tone === "attention" ? 245 : row.tone === "muted" ? 110 : 195;
      image.drawText(small, left, y, truncateText(small, `${index === screen.selected ? "›" : " "} ${row.label}`, bodyWidth), ink);
      y += small.lineHeight + 8;
    }
    image.drawLine(left, height - 31, right, height - 31, 65);
    image.drawText(small, left, height - 23, truncateText(small, screen.footer, bodyWidth), 105);
    return image;
  }

  handleInput(event: DashboardInputEvent): void {
    if (event.type === "scroll-up") this.model.scroll(-1);
    else if (event.type === "scroll-down") this.model.scroll(1);
    else if (event.type === "click") this.model.click();
    else if (event.type === "double-click") {
      const mode = this.model.screen().mode;
      // Offline is a root screen just like the active session list. Calling
      // model.back() there is deliberately inert, so it must yield to the
      // sidebar or a failed sync traps the wearer inside Cockpit.
      if (mode === "active" || mode === "offline") {
        shell.yieldFocusToSidebar();
      } else {
        this.model.back();
      }
    }
  }
}

export function createAgentCockpitWindow(options: InProcessAppOptions): InProcessWindow {
  let requestRender = () => {};
  const layer = new AgentCockpitLayer(() => requestRender());
  const app = createInProcessWindow({
    appId: "agent-cockpit",
    windowId: AGENT_COCKPIT_WINDOW_ID,
    title: "Hermes Cockpit",
    iconLetter: "H",
    icon: "hermes-h",
    closeable: true,
    actions: options.actions,
    baseLayer: layer,
    receiveTextInput: (text) => layer.receiveText(text),
    submitFrame: options.submitFrame,
    setSurfaceVisible: options.setSurfaceVisible,
    removeSurface: options.removeSurface,
    onClosed: () => {
      layer.stop();
      options.onClosed();
    },
  });
  requestRender = app.requestRender;
  return app;
}
