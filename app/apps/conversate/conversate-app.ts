import { imageFromAsciiArt } from "../../graphics/image";
import { type VoiceProvider } from "../../ui/dashboard-settings";
import { type DashboardInputEvent, type Layer, type LayerContext } from "../../ui/layers";
import {
  createInProcessWindow,
  type InProcessAppOptions,
  type InProcessWindow,
} from "../../ui/shell/in-process-window";
import { shell } from "../../ui/shell/shell";
import { ConversateLayer } from "./conversate";

export const CONVERSATE_WINDOW_ID = "conversate";
export const CONVERSATE_SURFACE_ID = "window:conversate";

const TRAY_ICON_ID = "conversate";
const LISTENING_ICON = imageFromAsciiArt(
  [
    "     ####     ",
    "    ######    ",
    "    #    #    ",
    "    #    #    ",
    "    #    #    ",
    "    #    #    ",
    "    #    #    ",
    "  # #    # #  ",
    "  # #    # #  ",
    "  #  ####  #  ",
    "   #      #   ",
    "    ######    ",
    "       #      ",
    "       #      ",
    "     ######   ",
  ],
  220,
);

export type ConversateAppOptions = InProcessAppOptions & {
  startContinuousVoiceCapture: (provider?: VoiceProvider) => number;
  finishContinuousVoiceCapture: (generation: number) => Promise<void>;
  stopContinuousVoiceCapture: (generation: number) => void;
};

/** Double-click ends an open session; otherwise it retains the shell's back gesture. */
class ConversateRootLayer implements Layer {
  constructor(private readonly inner: ConversateLayer) {}

  paint(ctx: LayerContext) { return this.inner.paint(ctx); }

  handleInput(event: DashboardInputEvent, ctx: LayerContext): Promise<void> | void {
    if (event.type === "double-click") {
      if (!this.inner.handleDoubleClick()) shell.yieldFocusToSidebar();
      return;
    }
    return this.inner.handleInput(event);
  }

  onRemoved(): void { this.inner.onRemoved(); }
  onForegroundChanged(foreground: boolean): void { this.inner.onForegroundChanged(foreground); }
  onScreenChanged(on: boolean): void { this.inner.onScreenChanged(on); }
}

export function createConversateAppWindow(options: ConversateAppOptions): InProcessWindow {
  const startCapture = (provider: VoiceProvider) => {
    const generation = options.startContinuousVoiceCapture(provider);
    if (generation > 0) shell.setTrayIcon(TRAY_ICON_ID, LISTENING_ICON);
    return generation;
  };
  const stopCapture = (generation: number) => {
    options.stopContinuousVoiceCapture(generation);
    shell.setTrayIcon(TRAY_ICON_ID, null);
  };
  const finishCapture = (generation: number) => {
    shell.setTrayIcon(TRAY_ICON_ID, null);
    return options.finishContinuousVoiceCapture(generation);
  };
  const layer = new ConversateLayer({ startCapture, finishCapture, stopCapture });
  const app = createInProcessWindow({
    appId: "conversate",
    windowId: CONVERSATE_WINDOW_ID,
    title: "Conversate",
    iconLetter: "Cv",
    icon: "message-square",
    closeable: true,
    actions: options.actions,
    baseLayer: new ConversateRootLayer(layer),
    menuItems: () => {
      const phase = layer.phase();
      const items = [];
      if (phase === "active" || phase === "paused") {
        items.push({
          label: phase === "paused" ? "Resume session" : "Pause session",
          onSelect: (ctx: LayerContext) => {
            ctx.stack.pop();
            layer.togglePaused();
          },
        });
        items.push({
          label: "End conversation",
          onSelect: (ctx: LayerContext) => {
            ctx.stack.pop();
            layer.endConversation();
          },
        });
      } else {
        items.push({
          label: `Provider: ${layer.providerLabel()}`,
          description: "Cycles only through on-device and cloud providers whose key is configured. Applies to the next session.",
          onSelect: (ctx: LayerContext) => {
            ctx.stack.pop();
            layer.cycleProvider(1);
          },
        });
        items.push({
          label: phase === "ended" ? "New conversation" : "Start conversation",
          onSelect: (ctx: LayerContext) => {
            ctx.stack.pop();
            if (phase === "ended") layer.newConversation();
            else layer.startConversation();
          },
        });
      }
      return items;
    },
    submitFrame: options.submitFrame,
    setSurfaceVisible: options.setSurfaceVisible,
    removeSurface: options.removeSurface,
    onForegroundChanged: (foreground) => layer.onForegroundChanged(foreground),
    onScreenChanged: (on) => layer.onScreenChanged(on),
    onVoiceInputChanged: (active) => layer.onVoiceInputChanged(active),
    onClosed: options.onClosed,
  });
  layer.start(app.requestRender);
  layer.onScreenChanged(shell.isScreenOn());
  return app;
}
