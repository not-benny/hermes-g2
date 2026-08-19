import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("reorder is a long-press menu entry, not a direct grab", () => {
  const shell = read("app/ui/shell/shell.ts");
  const inProcess = read("app/ui/shell/in-process-window.ts");
  const windowMenu = read("app/ui/window-menu.ts");

  // The menu entry drives reorder; the long-press still opens the normal menu
  // (Voice input / Close window / app items) which now includes "Reorder".
  assert.match(shell, /beginReorderFromMenu\(windowId: string\)/);
  assert.match(shell, /canReorder\(windowId: string\)/);
  assert.match(inProcess, /if \(shell\.canReorder\(options\.windowId\)\) \{\s*items\.push\(\{\s*label: "Reorder"/);
  assert.match(windowMenu, /label: "Reorder"/);
  assert.match(windowMenu, /post\(\{ type: "reorder-window-request", windowId \}\)/);

  // While reordering, further long-presses are swallowed so the menu can't
  // reopen over the grab.
  assert.match(shell, /if \(this\.reorderingWindowId !== null\) \{\s*return \{ shell: true, window: false \};\s*\}/);
});

test("while reordering, scroll moves the tab and a tap drops it", () => {
  const shell = read("app/ui/shell/shell.ts");
  // The reorder sub-mode routes scroll to moveReorder and click/double-click
  // to endReorder, ahead of the normal sidebar navigation.
  assert.match(shell, /this\.reorderingWindowId !== null/);
  assert.match(shell, /case "scroll-up":\s*this\.moveReorder\(-1\)/);
  assert.match(shell, /case "scroll-down":\s*this\.moveReorder\(1\)/);
  assert.match(shell, /case "click":\s*case "double-click":\s*this\.endReorder\(\)/);
});

test("the pinned launcher cannot be reordered and stays first", () => {
  const shell = read("app/ui/shell/shell.ts");
  // Reorderability is gated on closeable (the launcher is closeable:false),
  // both to pick a tab up and to move past one.
  assert.match(shell, /private isReorderable\(window: ShellWindow\): boolean \{\s*return window\.closeable !== false;/);
  assert.match(shell, /if \(!this\.isReorderable\(this\.windows\[to\]!\)\) return;/);
});

test("reordering persists the new order through onWindowsChanged", () => {
  const shell = read("app/ui/shell/shell.ts");
  // moveReorder and endReorder both notify the persistence hook.
  const moveReorder = shell.slice(shell.indexOf("private moveReorder"), shell.indexOf("private endReorder"));
  assert.match(moveReorder, /this\.config\.onWindowsChanged\?\.\(\)/);
});

test("the chrome shows a grab affordance with truthful move bounds", () => {
  const shell = read("app/ui/shell/shell.ts");
  const chrome = read("app/ui/shell/chrome-layer.ts");
  // The shell exposes reordering + move-bound flags; the chrome only draws a
  // direction's chevron when the tab can actually move that way.
  assert.match(shell, /reorderCanMoveUp/);
  assert.match(shell, /reorderCanMoveDown/);
  assert.match(chrome, /if \(state\.reorderCanMoveUp\) \{\s*drawChevron/);
  assert.match(chrome, /if \(state\.reorderCanMoveDown\) \{\s*drawChevron/);
});
