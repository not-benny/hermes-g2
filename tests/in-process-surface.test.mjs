import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("in-process apps defer their first render until the compositor surface is configured", () => {
  const window = read("app/ui/shell/in-process-window.ts");
  const controller = read("app/g2/dashboard-controller.ts");

  assert.match(window, /markSurfaceReady/);
  assert.match(window, /surfaceReady/);
  assert.match(controller, /await this\.configureWindowSurface\(surfaceId, false, app\.window\.heightMode\);\s*app\.markSurfaceReady\(\)/);
});

test("boot-registered windows get their surface-ready signal from the connect-time pass", () => {
  const window = read("app/ui/shell/in-process-window.ts");
  const controller = read("app/g2/dashboard-controller.ts");

  // The launcher is registered at boot, not through launchInProcessApp, so
  // the ready hook must ride on the ShellWindow itself and the connect-time
  // surface loop must fire it — otherwise the launcher's deferred first
  // render never flushes and the dashboard wakes blank until an input event.
  assert.match(window, /markSurfaceReady,\s*setForeground/);
  assert.match(
    controller,
    /window\.heightMode,\s*\);\s*(\/\/[^\n]*\n\s*)*window\.markSurfaceReady\?\.\(\);/,
  );
});

test("in-process windows register declared tools and withdraw them exactly once on close", () => {
  const window = read("app/ui/shell/in-process-window.ts");

  assert.match(window, /tools\?: \{[\s\S]*specs: ToolSpec\[\];[\s\S]*invoke:/);
  assert.match(window, /toolRegistry\.setAppTools\(\{[\s\S]*windowId: options\.windowId,[\s\S]*appId: options\.appId/);
  assert.match(window, /isForeground: \(\) => shell\.foregroundWindow\(\)\?\.windowId === options\.windowId/);
  assert.match(window, /if \(closed\) return;\s*closed = true;\s*toolRegistry\.removeAppTools\(options\.windowId\);/);
});
