import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const dataUrl = (js) => "data:text/javascript;base64," + Buffer.from(js).toString("base64");
const transpile = (source) => ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
}).outputText;

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

test("in-process adapter registers, gates, invokes, notifies, and tears down tools", async () => {
  const window = read("app/ui/shell/in-process-window.ts");

  assert.match(window, /registerInProcessTools\(/);
  const registryUrl = dataUrl(transpile(read("app/assistant/tool-registry.ts")));
  const adapterJs = transpile(read("app/assistant/in-process-tool-adapter.ts"))
    .replace('"./tool-registry"', JSON.stringify(registryUrl));
  const { ToolRegistry } = await import(registryUrl);
  const { registerInProcessTools } = await import(dataUrl(adapterJs));
  const registry = new ToolRegistry();
  const openSpec = { name: "open", description: "open", inputSchema: { type: "object", properties: { value: { type: "number" } }, additionalProperties: false }, availability: "open" };
  const foregroundSpec = { name: "focus", description: "focus", inputSchema: { type: "object", properties: {}, additionalProperties: false }, availability: "foreground" };
  let foreground = true;
  let invoked = null;
  let changes = 0;
  registry.onToolsChanged(() => { changes++; });
  const remove = registerInProcessTools(registry, "main", "demo", {
    specs: [openSpec, foregroundSpec],
    invoke: (name, args) => { invoked = { name, args }; return { ok: true, content: "handled" }; },
  }, () => foreground);

  assert.deepEqual(registry.listTools().map((spec) => spec.name), ["app.demo.open", "app.demo.focus"]);
  assert.equal((await registry.callTool("app.demo.open", { value: 1 })).content, "handled");
  assert.deepEqual(invoked, { name: "open", args: { value: 1 } });
  foreground = false;
  assert.deepEqual(registry.listTools().map((spec) => spec.name), ["app.demo.open"]);
  assert.match((await registry.callTool("app.demo.focus", {})).error, /not currently available/);
  registry.fireToolsChanged();
  assert.equal(changes, 2);
  foreground = true;
  assert.equal((await registry.callTool("app.demo.focus", {})).ok, true);
  registry.fireToolsChanged();
  assert.equal(changes, 3);
  remove();
  assert.deepEqual(registry.listTools(), []);
  assert.match((await registry.callTool("app.demo.open", {})).error, /Unknown tool/);
  remove();
  assert.equal(changes, 4);

  // The registry's existing same-name fallback remains intact for two live windows.
  registerInProcessTools(registry, "old", "same", { specs: [openSpec], invoke: () => ({ ok: true, content: "old" }) }, () => true);
  const removeNew = registerInProcessTools(registry, "new", "same", { specs: [openSpec], invoke: () => ({ ok: true, content: "new" }) }, () => true);
  removeNew();
  assert.equal((await registry.callTool("app.same.open", {})).content, "old");

  assert.match(window, /\(\) => shell\.foregroundWindow\(\)\?\.windowId === options\.windowId/);
  assert.match(window, /if \(closed\) return;\s*closed = true;\s*removeTools\(\);/);
  assert.match(window, /setForeground: \(foreground\) => \{[\s\S]*toolRegistry\.fireToolsChanged\(\);/);
});

test("worker host closes a same-ID replacement before it declares tools", async () => {
  const registryUrl = dataUrl(transpile(read("app/assistant/tool-registry.ts")));
  const workerSource = transpile(read("app/ui/shell/worker-window.ts"))
    .replace('"../../graphics/image"', JSON.stringify(dataUrl("export class GrayImage {}")))
    .replace('"./chrome-layer"', JSON.stringify(dataUrl("export const windowIcon = () => undefined;")))
    .replace('"../../graphics/icons"', JSON.stringify(dataUrl("export {};")))
    .replace('"../../assistant/tool-registry"', JSON.stringify(registryUrl))
    .replace('"./geometry"', JSON.stringify(dataUrl("export const appViewportSize = () => ({ width: 1, height: 1 }); export const windowDefaultHeightMode = () => \"min\";")))
    .replace('"./shell"', JSON.stringify(dataUrl("export const shell = { foregroundWindow: () => undefined, isScreenOn: () => true, focusWindow: () => {}, wake: () => {}, yieldFocusToSidebar: () => {}, setWindowAttention: () => {}, closeWindow: () => {}, beginReorderFromMenu: () => {}, startVoiceInput: () => {}, setTrayIcon: () => {}, isWindowFocused: () => false, registerWindow: () => {} };")));
  const [{ WorkerAppHost }, { toolRegistry }] = await Promise.all([
    import(dataUrl(workerSource)),
    import(registryUrl),
  ]);
  const openSpec = { name: "open", description: "open", inputSchema: { type: "object" }, availability: "open" };
  const worker = { postMessage: () => {}, onmessage: null, onerror: null };
  let changes = 0;
  toolRegistry.onToolsChanged(() => { changes++; });
  const host = new WorkerAppHost({
    appId: "demo",
    worker,
    configureSurface: async () => {},
    setSurfaceVisible: () => {},
    removeSurface: () => {},
    requestShellRender: () => {},
    openSettings: () => {},
    startTextSettingEdit: () => {},
    endTextSettingEdit: () => {},
  });
  host.openWindow({ windowId: "reused", title: "old", iconLetter: "O" });
  worker.onmessage({ data: { type: "set-tools", windowId: "reused", tools: [openSpec] } });
  assert.deepEqual(toolRegistry.listTools().map((spec) => spec.name), ["app.demo.open"]);

  const replacement = host.openWindow({ windowId: "reused", title: "new", iconLetter: "N" });
  assert.deepEqual(toolRegistry.listTools(), []);
  replacement.close();
  assert.deepEqual(toolRegistry.listTools(), []);
  assert.equal(changes, 2);
});
