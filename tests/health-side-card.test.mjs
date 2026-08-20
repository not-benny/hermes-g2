import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("the Health side card is a pinned, uncloseable shell window with a Hide entry", () => {
  const app = read("app/apps/health/health-app.ts");
  const index = read("app/apps/health/index.ts");
  assert.match(app, /HEALTH_WINDOW_ID = "health"/);
  assert.match(app, /closeable: false/); // pinned + non-reorderable
  assert.match(app, /ringHealthStore\.snapshot\(\)/); // reads live vitals
  assert.match(app, /label: "Hide health tab"/);
  assert.match(app, /shell\.setHealthHidden\(true\)/);
  assert.match(index, /showInLauncher: false/); // not an app-grid entry
  assert.match(index, /shell\.registerHealthWindow/);
});

test("the Health card is registered right after the launcher", () => {
  const all = read("app/apps/all-apps.ts");
  assert.match(all, /import healthApp from "\.\/health"/);
  // healthApp appears immediately after launcherApp in ALL_APPS.
  assert.match(all, /launcherApp,\s*\n\s*healthApp,/);
});

test("the shell hides/shows the card by removing/re-inserting it under the launcher", () => {
  const shell = read("app/ui/shell/shell.ts");
  assert.match(shell, /registerHealthWindow\(window: ShellWindow\): void/);
  assert.match(shell, /private insertHealthAtSlot\(\): void/);
  assert.match(shell, /setHealthHidden\(hidden: boolean/);
  assert.match(shell, /isHealthHidden\(\): boolean/);
  // hide reuses removeWindow (surface survives); insert keeps selection stable.
  assert.match(shell, /this\.removeWindow\(this\.healthWindow\.windowId\)/);
  assert.match(shell, /if \(insertAt <= this\.selectedIndex\) this\.selectedIndex\+\+/);
  assert.match(shell, /onHealthHiddenChanged\?: \(hidden: boolean\) => void/);
});

test("the Apps card offers Unhide only while the Health card is hidden", () => {
  const launcher = read("app/apps/launcher/index.ts");
  assert.match(launcher, /shell\.isHealthHidden\(\)/);
  assert.match(launcher, /label: "Unhide health tab"/);
  assert.match(launcher, /shell\.setHealthHidden\(false\)/);
});

test("the hidden choice persists and is applied after the surface is ready", () => {
  const persist = read("app/ui/shell/health-tab-persistence.ts");
  assert.match(persist, /export function loadHealthTabHidden\(\): boolean/);
  assert.match(persist, /export function saveHealthTabHidden\(hidden: boolean\)/);
  const ctrl = read("app/g2/dashboard-controller.ts");
  assert.match(ctrl, /onHealthHiddenChanged: \(hidden\) => saveHealthTabHidden\(hidden\)/);
  // applied AFTER the connect surface loop (persist:false so it does not echo back)
  assert.match(ctrl, /if \(loadHealthTabHidden\(\)\) shell\.setHealthHidden\(true, \{ persist: false \}\)/);
  // health excluded from open-apps persistence
  assert.match(ctrl, /window\.appId === "launcher" \|\| window\.appId === "health"/);
});
