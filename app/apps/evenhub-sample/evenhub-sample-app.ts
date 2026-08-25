import { EvenHubCounterController } from "../../compat/evenhub/sample-controller";
import { getStringSetting, removeStringSetting, setStringSetting } from "../../native/settings-store";
import { ShellDynamicAppLayer } from "../../ui/shell/dynamic-app-layer";
import type { DashboardInputEvent, Layer, LayerContext, PaintBelow } from "../../ui/layers";
import { createInProcessWindow, YieldAtRootLayer, type InProcessAppOptions, type InProcessWindow } from "../../ui/shell/in-process-window";
import { shell } from "../../ui/shell/shell";

export const EVENHUB_SAMPLE_WINDOW_ID = "evenhub-local-counter";
export const EVENHUB_SAMPLE_SURFACE_ID = "window:evenhub-local-counter";

class EvenHubSampleLayer implements Layer {
  constructor(private readonly controller: EvenHubCounterController) {}

  paint(ctx: LayerContext, paintBelow: PaintBelow) {
    return new ShellDynamicAppLayer(this.controller.dashboardState(), () => false, () => undefined).paint(ctx, paintBelow);
  }

  handleInput(event: DashboardInputEvent, ctx: LayerContext): void {
    if (event.type !== "click" && event.type !== "scroll-up" && event.type !== "scroll-down") return;
    if (this.controller.handleInput(event.type)) ctx.actions.requestRender();
  }
}

export function createEvenHubSampleAppWindow(options: InProcessAppOptions): InProcessWindow {
  let app: InProcessWindow | null = null;
  const controller = new EvenHubCounterController({
    read: (key) => getStringSetting(key, "") || null,
    write: setStringSetting,
    remove: removeStringSetting,
  }, () => app?.requestRender(), shell.isScreenOn());

  app = createInProcessWindow({
    appId: "evenhub-local-counter",
    windowId: EVENHUB_SAMPLE_WINDOW_ID,
    title: "Local Counter",
    iconLetter: "EH",
    icon: "plus-one",
    closeable: true,
    actions: options.actions,
    baseLayer: new YieldAtRootLayer(new EvenHubSampleLayer(controller)),
    menuItems: () => [{
      label: "Clear local data",
      onSelect: (ctx) => {
        controller.clearStorage();
        ctx.stack.pop();
        ctx.actions.requestRender();
      },
    }],
    submitFrame: options.submitFrame,
    setSurfaceVisible: options.setSurfaceVisible,
    removeSurface: options.removeSurface,
    onForegroundChanged: (foreground) => controller.setForeground(foreground),
    onScreenChanged: (on) => controller.setScreenOn(on),
    onClosed: () => {
      controller.close();
      options.onClosed();
    },
  });
  return app;
}
