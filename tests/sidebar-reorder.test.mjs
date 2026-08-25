import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const dataUrl = (js) => "data:text/javascript;base64," + Buffer.from(js).toString("base64");

test("window management is a unified menu entry, not a direct grab", () => {
  const shell = read("app/ui/shell/shell.ts");
  const inProcess = read("app/ui/shell/in-process-window.ts");
  const windowMenu = read("app/ui/window-menu.ts");

  // The menu enters the same bounded Window Management mode used by the
  // sidebar; a second long-press picks a movable tab up.
  assert.match(shell, /beginWindowManagementFromMenu\(windowId: string\)/);
  assert.match(shell, /canReorder\(windowId: string\)/);
  assert.match(inProcess, /label: "Window management"/);
  assert.match(windowMenu, /label: "Window management"/);
  assert.match(windowMenu, /post\(\{ type: "window-management-request", windowId \}\)/);

  // While reordering, further long-presses are swallowed so the menu can't
  // reopen over the grab.
  assert.match(shell, /if \(this\.reorderingWindowId !== null\) \{\s*return \{ shell: true, window: false \};\s*\}/);
});

test("while moving in Window Management, scroll moves the tab and a tap drops it", () => {
  const shell = read("app/ui/shell/shell.ts");
  const management = shell.slice(shell.indexOf("private handleSidebarInput"), shell.indexOf("private moveSelection"));
  // Move is a substate of the one manager: tap drops back to selection, while
  // double-tap exits Window Management entirely.
  assert.match(management, /this\.reorderingWindowId !== null/);
  assert.match(management, /case "scroll-up":\s*this\.moveReorder\(-1\)/);
  assert.match(management, /case "scroll-down":\s*this\.moveReorder\(1\)/);
  assert.match(management, /case "click":\s*this\.endReorder\(\)/);
  assert.match(management, /case "double-click":\s*this\.exitWindowManagement\(\)/);
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

test("management marker remains visible over the focused white card", () => {
  const chrome = read("app/ui/shell/chrome-layer.ts");
  assert.match(chrome, /fillRoundedRect\(cx - 12, cy - 12, 24, 24, SHELL_OPAQUE_BLACK, 4\)/);
  assert.match(chrome, /state\.closingAction === "hide"/);
  assert.match(chrome, /state\.closingAction === "close"/);
  assert.match(chrome, /drawChevron\(image, cx, cy - 4, -1, 255\)/);
  assert.match(chrome, /drawChevron\(image, cx, cy \+ 4, 1, 255\)/);
  assert.match(chrome, /WINDOW MANAGEMENT/);
  assert.match(chrome, /truncateText\(\s*hintFont/);
  assert.match(chrome, /HUD_CONTENT_RIGHT - \(SIDEBAR_WIDTH \+ 10\)/);
});

test("all sidebar tabs scroll within the single optically visible column", () => {
  const geometry = read("app/ui/shell/geometry.ts");
  const chrome = read("app/ui/shell/chrome-layer.ts");
  assert.match(geometry, /SIDEBAR_COLUMNS = 2/,
    "the 72px shell/app geometry stays stable");
  assert.match(geometry, /SIDEBAR_VISIBLE_COLUMNS = 1/);
  assert.match(chrome, /visibleCount = rowsPerColumn \* SIDEBAR_VISIBLE_COLUMNS/);
  assert.match(chrome, /column: FIRST_COLUMN,\s*y: listTop \+ position \* itemStride/);
  assert.doesNotMatch(chrome, /columnsFromRight|drawSelectionBox/,
    "no tab or selection can enter x=0..35");
  assert.match(chrome, /sidebarLeftColumnUsed\(_windowCount: number\): boolean \{\s*return false;/);
  assert.match(chrome, /SIDEBAR_WIDTH - SIDEBAR_COLUMN_WIDTH \/ 2/,
    "overflow chevrons remain centered at x=54 in the visible column");
});

test("Window Management selection is bounded and preserves the closed card slot", async () => {
  const source = ts.transpileModule(read("app/ui/shell/window-management-selection.ts"), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const { nextWindowManagementIndex, selectionIndexAfterManagementRemoval } = await import(dataUrl(source));
  assert.equal(nextWindowManagementIndex(0, -1, 4), 0);
  assert.equal(nextWindowManagementIndex(3, 1, 4), 3);
  assert.equal(nextWindowManagementIndex(1, 1, 4), 2);
  // Notifications/Music are the repro: closing Music at slot 2 keeps the
  // adjacent Notifications slot instead of restoring the MRU/top entry.
  assert.equal(selectionIndexAfterManagementRemoval(2, 2), 1);
  assert.equal(selectionIndexAfterManagementRemoval(1, 2), 1);
  assert.equal(selectionIndexAfterManagementRemoval(3, 3), 2);
  assert.equal(selectionIndexAfterManagementRemoval(0, 0), 0);
});

test("Window Management remains available for a visible Health-only card and advertises only valid moves", () => {
  const shell = read("app/ui/shell/shell.ts");
  const chrome = read("app/ui/shell/chrome-layer.ts");
  assert.match(shell, /private hasManageableWindow\(\): boolean/);
  assert.match(shell, /window\.closeable !== false \|\| window === this\.healthWindow/);
  assert.doesNotMatch(shell, /hasCloseableWindow/);
  assert.match(shell, /managementCanMove: this\.canReorder/);
  assert.match(chrome, /state\.managementCanMove[\s\S]*HOLD move/);
  assert.match(chrome, /HIDE   UP\/DN choose   TAP hide/);
  assert.doesNotMatch(chrome, /HIDE   UP\/DN choose   TAP hide   HOLD move/);
});
