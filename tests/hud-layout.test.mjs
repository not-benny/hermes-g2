import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../app/ui/shell/hud-layout.ts", import.meta.url), "utf8");
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
}).outputText;
const dataUrl = "data:text/javascript;base64," + Buffer.from(js).toString("base64");
const { fitHudRowItemWidths, hudNotificationIconPosition, layoutHudNotifications } = await import(dataUrl);

const common = {
  clockRight: 232,
  preferredNotificationLeft: 242,
  visibleRight: 608,
  iconSize: 24,
  iconGap: 4,
};

test("the double-row phone region is separated from persistent HUD data and stays optically visible", () => {
  const layout = layoutHudNotifications({ ...common, persistentLeft: 420 });
  assert.equal(layout.rows, 2);
  assert.equal(layout.separatorX, 412);
  assert.ok(layout.notificationRight < layout.separatorX, "phone icons end before the divider");
  assert.ok(layout.separatorX < 420, "divider ends before persistent data begins");
  assert.ok(layout.separatorX < common.visibleRight, "divider is inside x=32..607 optical raster");
  assert.equal(layout.maxIcons, layout.columns * 2);

  for (let index = 0; index < layout.maxIcons; index++) {
    const position = hudNotificationIconPosition(layout, index, {
      barTop: 0,
      rowHeight: 28,
      iconSize: 24,
      iconGap: 4,
    });
    assert.ok(position);
    assert.ok(position.x >= layout.notificationLeft);
    assert.ok(position.x + common.iconSize <= layout.notificationRight);
    assert.ok(position.y === 2 || position.y === 30, "icons occupy exactly two rows");
    assert.ok(position.y + common.iconSize <= 56, "icon remains within the 56px HUD");
  }
});

test("a saturated persistent region removes phone slots instead of allowing overlap", () => {
  const layout = layoutHudNotifications({ ...common, persistentLeft: 250 });
  assert.equal(layout.columns, 0);
  assert.equal(layout.maxIcons, 0);
  assert.equal(hudNotificationIconPosition(layout, 0, {
    barTop: 0,
    rowHeight: 28,
    iconSize: 24,
    iconGap: 4,
  }), null);
});

test("the chrome's persistent-data floor retains one complete icon column", () => {
  const layout = layoutHudNotifications({ ...common, persistentLeft: 282 });
  assert.equal(layout.columns, 1);
  assert.equal(layout.maxIcons, 2, "one icon in each HUD row");
});

test("all layout geometry clamps to the wearer-visible right edge", () => {
  const layout = layoutHudNotifications({ ...common, persistentLeft: 900 });
  assert.equal(layout.separatorX, 606);
  const final = hudNotificationIconPosition(layout, layout.maxIcons - 1, {
    barTop: 12,
    rowHeight: 28,
    iconSize: 24,
    iconGap: 4,
  });
  assert.ok(final);
  assert.ok(final.x + common.iconSize <= layout.notificationRight);
  assert.ok(layout.notificationRight < common.visibleRight);
});

test("persistent packing preserves the essential prefix and drops only overflow tray icons", () => {
  // Hermes, signal and brightness are the first three top-row items; tray
  // icons follow. The realistic essentials fit, while an abusive tray suffix
  // is safely truncated instead of moving left across phone icons.
  const fitted = fitHudRowItemWidths([170, 22, 30, ...Array(20).fill(24)], 600, 282, 10);
  assert.deepEqual(fitted.slice(0, 3).map(({ index }) => index), [0, 1, 2]);
  assert.ok(fitted.length < 23);
  assert.ok(fitted.every(({ x }) => x >= 282));

  // Heart rate, G2, ring and phone batteries all fit in the bottom row.
  const bodyAndBattery = fitHudRowItemWidths([30, 42, 40, 40], 600, 282, 10);
  assert.deepEqual(bodyAndBattery.map(({ index }) => index), [0, 1, 2, 3]);
});
