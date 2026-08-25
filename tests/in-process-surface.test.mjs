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
  assert.match(controller, /const focusClaim = shell\.reserveWindowFocusClaim\(windowId\);[\s\S]*shell\.focusWindow\(windowId, focusClaim\)/);
});

test("deferred worker focus is a revocable claim, so management/user selection wins", () => {
  const shell = read("app/ui/shell/shell.ts");
  const worker = read("app/ui/shell/worker-window.ts");
  assert.match(shell, /reserveWindowFocusClaim\(windowId: string\): WindowFocusClaim/);
  assert.match(shell, /claim\.epoch !== this\.focusClaimEpoch/);
  assert.match(shell, /claim\.selectionRevision !== this\.selectionRevision/);
  assert.match(shell, /if \(this\.closingActive\) return false/);
  assert.match(worker, /const focusClaim = spec\.focus \? shell\.reserveWindowFocusClaim\(spec\.windowId\) : undefined/);
  assert.match(worker, /if \(focusClaim\) shell\.focusWindow\(spec\.windowId, focusClaim\)/);
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
  assert.match(window, /if \(closed\) return;\s*closed = true;\s*try \{ removeTools\(\); \} catch/);
  assert.match(window, /try \{ options\.onClosed\?\.\(\); \} catch[\s\S]*try \{ options\.removeSurface\?\.\(\); \} catch/);
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
    .replace('"./shell"', JSON.stringify(dataUrl("export const shell = { foregroundWindow: () => undefined, isScreenOn: () => true, focusWindow: () => {}, reserveWindowFocusClaim: (windowId) => ({ windowId, epoch: 1, selectionRevision: 0 }), wake: () => {}, yieldFocusToSidebar: () => {}, setWindowAttention: () => {}, closeWindow: () => {}, beginWindowManagementFromMenu: () => {}, startVoiceInput: () => {}, setTrayIcon: () => {}, isWindowFocused: () => false, registerWindow: () => {} };")));
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
  const oldWindow = host.openWindow({ windowId: "reused", title: "old", iconLetter: "O" });
  worker.onmessage({ data: { type: "set-tools", windowId: "reused", tools: [openSpec] } });
  assert.deepEqual(toolRegistry.listTools().map((spec) => spec.name), ["app.demo.open"]);

  const replacement = host.openWindow({ windowId: "reused", title: "new", iconLetter: "N" });
  assert.deepEqual(toolRegistry.listTools(), []);
  replacement.close();
  assert.deepEqual(toolRegistry.listTools(), []);
  assert.equal(changes, 2);

  // Once the replacement owns a lease, the old ShellWindow's close must be a
  // stale no-op and leave the replacement callable until it closes.
  const currentWindow = host.openWindow({ windowId: "reused", title: "current", iconLetter: "C" });
  worker.onmessage({ data: { type: "set-tools", windowId: "reused", tools: [openSpec] } });
  assert.deepEqual(toolRegistry.listTools().map((spec) => spec.name), ["app.demo.open"]);
  let call;
  worker.postMessage = (message) => { if (message.type === "tool-call") call = message; };
  const resultPromise = toolRegistry.callTool("app.demo.open", {});
  assert.equal(call?.name, "open");
  worker.onmessage({ data: { type: "tool-result", callId: call.callId, result: { ok: true, content: "current" } } });
  assert.deepEqual(await resultPromise, { ok: true, content: "current" });
  oldWindow.close();
  assert.deepEqual(toolRegistry.listTools().map((spec) => spec.name), ["app.demo.open"]);
  assert.equal(changes, 3);
  currentWindow.close();
  assert.deepEqual(toolRegistry.listTools(), []);
  assert.equal(changes, 4);
});

test("closing a generation aborts its deferred call without authorizing a late side effect", async () => {
  const registryUrl = dataUrl(transpile(read("app/assistant/tool-registry.ts")));
  const adapterJs = transpile(read("app/assistant/in-process-tool-adapter.ts"))
    .replace('"./tool-registry"', JSON.stringify(registryUrl));
  const { ToolRegistry } = await import(registryUrl);
  const { registerInProcessTools } = await import(dataUrl(adapterJs));
  const registry = new ToolRegistry();
  const spec = { name: "deferred", description: "deferred", inputSchema: { type: "object", properties: {}, additionalProperties: false }, availability: "open" };
  let release;
  let aborted = false;
  let committedSideEffects = 0;
  const deferred = new Promise((resolve) => { release = resolve; });
  const remove = registerInProcessTools(registry, "window", "demo", {
    specs: [spec],
    invoke: async (_name, _args, signal, isSideEffectAllowed) => {
      signal.addEventListener("abort", () => { aborted = true; }, { once: true });
      await deferred;
      if (isSideEffectAllowed()) committedSideEffects++;
      return { ok: true, content: "late-success" };
    },
  }, () => true);

  const call = registry.callTool("app.demo.deferred", {});
  remove();
  release();
  const result = await call;
  assert.equal(aborted, true);
  assert.equal(result.ok, false);
  assert.match(result.error, /available|cancel/i);
  assert.equal(committedSideEffects, 0);
});

test("stale cleanup cannot abort an in-flight replacement generation", async () => {
  const registryUrl = dataUrl(transpile(read("app/assistant/tool-registry.ts")));
  const adapterJs = transpile(read("app/assistant/in-process-tool-adapter.ts"))
    .replace('"./tool-registry"', JSON.stringify(registryUrl));
  const { ToolRegistry } = await import(registryUrl);
  const { registerInProcessTools } = await import(dataUrl(adapterJs));
  const registry = new ToolRegistry();
  const spec = { name: "deferred", description: "deferred", inputSchema: { type: "object", properties: {}, additionalProperties: false }, availability: "open" };
  let release;
  let replacementAborted = false;
  const deferred = new Promise((resolve) => { release = resolve; });
  const removeOld = registerInProcessTools(registry, "reused", "demo", { specs: [spec], invoke: () => ({ ok: true, content: "old" }) }, () => true);
  const removeNew = registerInProcessTools(registry, "reused", "demo", {
    specs: [spec],
    invoke: async (_name, _args, signal) => {
      signal.addEventListener("abort", () => { replacementAborted = true; }, { once: true });
      await deferred;
      return { ok: true, content: "new" };
    },
  }, () => true);
  const call = registry.callTool("app.demo.deferred", {});
  removeOld();
  assert.deepEqual(registry.listTools().map((tool) => tool.name), ["app.demo.deferred"]);
  release();
  assert.equal((await call).content, "new");
  assert.equal(replacementAborted, false);
  removeNew();
});

test("synchronous close cancels before timeout and completed calls release merged listeners", async () => {
  const registryUrl = dataUrl(transpile(read("app/assistant/tool-registry.ts")));
  const adapterJs = transpile(read("app/assistant/in-process-tool-adapter.ts"))
    .replace('"./tool-registry"', JSON.stringify(registryUrl));
  const { ToolRegistry } = await import(registryUrl);
  const { registerInProcessTools } = await import(dataUrl(adapterJs));
  const registry = new ToolRegistry();
  const spec = { name: "setup", description: "setup", inputSchema: { type: "object", properties: {}, additionalProperties: false }, availability: "open" };
  let remove;
  let signal;
  remove = registerInProcessTools(registry, "setup-window", "demo", {
    specs: [spec],
    invoke: (_name, _args, received) => {
      signal = received;
      remove();
      return new Promise(() => {});
    },
  }, () => true);
  const started = Date.now();
  const result = await registry.callTool("app.demo.setup", {});
  assert.ok(Date.now() - started < 1000);
  assert.equal(signal.aborted, true);
  assert.equal(result.ok, false);
  assert.match(result.error, /cancel|available/i);

  let adds = 0;
  let removes = 0;
  const originalAdd = AbortSignal.prototype.addEventListener;
  const originalRemove = AbortSignal.prototype.removeEventListener;
  AbortSignal.prototype.addEventListener = function (...args) {
    adds++;
    return originalAdd.apply(this, args);
  };
  AbortSignal.prototype.removeEventListener = function (...args) {
    removes++;
    return originalRemove.apply(this, args);
  };
  try {
    const secondRemove = registerInProcessTools(registry, "listener-window", "demo", {
      specs: [spec], invoke: () => ({ ok: true, content: "done" }),
    }, () => true);
    for (let i = 0; i < 25; i++) assert.equal((await registry.callTool("app.demo.setup", {})).ok, true);
    secondRemove();
  } finally {
    AbortSignal.prototype.addEventListener = originalAdd;
    AbortSignal.prototype.removeEventListener = originalRemove;
  }
  assert.equal(adds, removes);
});
