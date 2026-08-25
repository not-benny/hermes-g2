import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("Terminal and G2Mirror have no reachable product surface", () => {
  const terminal = read("app/apps/terminal/index.ts");
  const settings = read("app/ui/dashboard/settings-menus.ts");
  const worker = read("app/apps/terminal/terminal-app.worker.ts");
  const debug = read("debug-control/control-protocol.ts");
  const searchCore = read("app/search/core.ts");
  const searchProviders = read("app/search/providers.ts");
  const searchApp = read("app/apps/universal-search/universal-search-app.ts");
  const persistence = read("app/ui/shell/open-apps-persistence.ts");

  assert.match(terminal, /showInLauncher: false/);
  assert.doesNotMatch(settings, /label: "Terminal"|terminalLaunchPresetsSetting|terminalAutoReconnectSetting|terminalWakeOnBellSetting/);
  assert.doesNotMatch(worker, /open-settings", section: "Terminal"/);
  assert.doesNotMatch(debug, /"terminal"/);
  assert.doesNotMatch(searchCore, /"terminal"|terminal_content/);
  assert.doesNotMatch(searchProviders, /unavailableProvider\("terminal"|"Terminal"/);
  assert.doesNotMatch(searchApp, /Terminal \(unavailable\)/);
  assert.match(persistence, /if \(appId === "terminal"\) continue/);
  assert.match(persistence, /parsed\.foreground === "terminal"[\s\S]*\? null/);
});

test("legacy encrypted Terminal credentials remain cleanup-only and are not silently deleted", () => {
  const page = read("app/phone-ui/api-keys-page.xml");
  const model = read("app/phone-ui/api-keys-view-model.ts");
  assert.match(page, /Clear terminal connection credentials/);
  assert.match(model, /onClearTerminalTap\(\)/);
  assert.match(model, /removeSecretSetting\("terminal\.connections"\)/);
});
