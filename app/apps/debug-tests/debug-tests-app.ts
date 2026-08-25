import { MenuLayer, type MenuItem } from "../../ui/menu";
import { ScreenTestLayer } from "./screen-test";
import { BuzzerDemoLayer } from "./buzzer-demo";
import { AccelerometerDemoLayer } from "./accelerometer-demo";
import { ResourceUsageLayer } from "./resource-usage";
import { appViewportSize } from "../../ui/shell/geometry";

export const DEBUG_TESTS_WINDOW_ID = "debug-tests";

/**
 * The diagnostics are kept together for the Settings Developer submenu.
 * Keeping the entries here prevents the Settings surface from silently
 * dropping a test when another one is added.
 */
export function createDebugTestsMenuItems(windowId = DEBUG_TESTS_WINDOW_ID): MenuItem[] {
  return [
    {
      label: "Dither test",
      onSelect: (ctx) => {
        ctx.stack.push(new ScreenTestLayer());
      },
    },
    {
      label: "Buzzer demo",
      onSelect: (ctx) => {
        ctx.stack.push(new BuzzerDemoLayer());
      },
    },
    {
      label: "Accelerometer demo",
      onSelect: (ctx) => {
        ctx.stack.push(new AccelerometerDemoLayer(windowId, ctx.actions.requestRender));
      },
    },
    {
      label: "Show resource usage",
      onSelect: (ctx) => {
        ctx.stack.push(new ResourceUsageLayer(windowId, ctx.actions.requestRender));
      },
    },
  ];
}

/** Build the diagnostics menu for the Settings in-process host. */
export function createDebugTestsMenu(windowId = DEBUG_TESTS_WINDOW_ID): MenuLayer {
  return new MenuLayer("Debug tests", createDebugTestsMenuItems(windowId), {
    x: 8,
    y: 8,
    width: 272,
    showBorder: false,
    minHeight: 0,
    maxHeight: appViewportSize("min").height - 16,
  });
}
