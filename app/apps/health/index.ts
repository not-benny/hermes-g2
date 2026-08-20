import { shell } from "../../ui/shell/shell";
import { type AppDefinition } from "../app-definition";
import { createHealthWindow, HEALTH_SURFACE_ID, HEALTH_WINDOW_ID } from "./health-app";

const healthApp: AppDefinition = {
  appId: "health",
  title: "Health",
  icon: "activity",
  // The Health card is a pinned sidebar tab, not an entry in the app grid.
  showInLauncher: false,
  // Registered at startup and pinned under the launcher; never launched fresh.
  boot: (ctx) => {
    shell.registerHealthWindow(
      createHealthWindow({
        actions: {
          ...ctx.actions,
          requestRender: () => shell.foregroundWindow()?.requestRender(),
        },
        submitFrame: (image, paintMs, frameId) => ctx.submitWindowFrame(HEALTH_SURFACE_ID, image, paintMs, frameId),
        setSurfaceVisible: (visible) => ctx.setWindowSurfaceVisible(HEALTH_SURFACE_ID, visible),
      }),
    );
  },
  // Pinned and always registered; launching means focusing.
  launch: async (ctx) => {
    shell.focusWindow(HEALTH_WINDOW_ID);
    ctx.requestShellRender();
  },
};

export default healthApp;
