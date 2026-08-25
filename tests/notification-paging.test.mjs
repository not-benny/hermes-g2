import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const notifications = readFileSync(new URL("../app/ui/notifications.ts", import.meta.url), "utf8");
const pagination = readFileSync(new URL("../app/ui/notification-pagination.ts", import.meta.url), "utf8");
const digestStart = notifications.indexOf("export class NotificationDigestLayer");
const digestEnd = notifications.indexOf("\ntype SingleNotificationLayerOptions", digestStart);
const menuStart = notifications.indexOf("function drawDetailMenu");
const menuEnd = notifications.indexOf("\nfunction buildDetailMenu", menuStart);
assert.ok(digestStart >= 0 && digestEnd > digestStart && menuStart >= 0 && menuEnd > menuStart);

const harness = `
  const MAX_NOTIFICATIONS = 50;
  const DETAIL_MENU_WIDTH = 148;
  const GESTURE_DOUBLE_CLICK = "··";
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const readActiveNotifications = () => [];
  const retainAndroidNotification = (notification) => ({
    ...notification,
    lines: [...notification.lines],
    actions: notification.actions.map((action) => ({ ...action })),
  });
  const notificationTitle = (notification) => notification.title;
  const notificationFont = () => ({ lineHeight: 24 });
  const truncateText = (_font, text) => text;
  class GrayImage {
    constructor(width, height) { this.width = width; this.height = height; this.commands = []; }
    drawText(_font, x, y, text, value) { this.commands.push({ type: "text", x, y, text, value }); }
    fillRoundedRect(x, y, width, height) { this.commands.push({ type: "fill", x, y, width, height }); }
    drawRoundedRect(x, y, width, height) { this.commands.push({ type: "border", x, y, width, height }); }
  }
  ${pagination}
  ${notifications.slice(digestStart, digestEnd)}
  ${notifications.slice(menuStart, menuEnd)}
  export { drawDetailMenu };
`;
const js = ts.transpileModule(harness, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const runtime = await import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));

function notification(index) {
  return {
    key: `key-${index}`,
    packageName: `example.app.${index}`,
    appName: `App ${index}`,
    title: `Title ${index}`,
    lines: [],
    actions: [],
  };
}

test("large-font 196px digest keeps every selected entry and its reason visible", () => {
  const entries = Array.from({ length: 8 }, (_, index) => ({
    key: `key-${index}`,
    revision: `revision-${index}`,
    reason: `priority ${index}`,
    notification: notification(index),
  }));
  const layer = new runtime.NotificationDigestLayer(entries, () => {});
  const context = {
    stack: { getBaseSize: () => ({ width: 532, height: 196 }), push: () => {} },
  };
  for (let selected = 0; selected < entries.length; selected++) {
    const image = layer.paint(context);
    const selectedLine = image.commands.find((command) => command.type === "text" && command.text.startsWith("> "));
    const reasonLine = image.commands.find((command) => command.type === "text" && command.text.startsWith("Why: "));
    assert.equal(selectedLine?.text, `> App ${selected}: Title ${selected}`);
    assert.equal(reasonLine?.text, `Why: priority ${selected}`);
    assert.ok(selectedLine.y >= 42 && selectedLine.y < 162, JSON.stringify(selectedLine));
    assert.ok(reasonLine.y >= 42 && reasonLine.y < 162, JSON.stringify(reasonLine));
    const footer = image.commands.find((command) => command.text === "Click review · ·· close");
    assert.ok(footer.y + 24 <= 196, "the digest close hint remains inside the modal");
    if (selected < entries.length - 1) layer.handleInput({ type: "scroll-down" }, context);
  }
});

test("large-font 196px detail menu pages uncapped actions and reaches Dismiss", () => {
  const menu = [
    { kind: "back", label: "Back" },
    ...Array.from({ length: 20 }, (_, index) => ({ kind: "action", label: `Action ${index + 1}` })),
    { kind: "dismiss", label: "Dismiss" },
  ];
  const font = { lineHeight: 24 };
  for (let selected = 0; selected < menu.length; selected++) {
    const image = new globalThis.Object();
    image.commands = [];
    image.fillRoundedRect = (x, y, width, height) => image.commands.push({ type: "fill", x, y, width, height });
    image.drawRoundedRect = (x, y, width, height) => image.commands.push({ type: "border", x, y, width, height });
    image.drawText = (_font, x, y, text) => image.commands.push({ type: "text", x, y, text });
    runtime.drawDetailMenu(image, font, menu, selected, 532, 196);
    const highlight = image.commands.find((command) => command.type === "fill");
    assert.ok(highlight, `selection ${selected}`);
    assert.ok(highlight.y >= 0 && highlight.y + highlight.height <= 196, JSON.stringify(highlight));
    assert.ok(image.commands.some((command) => command.type === "text" && command.text.includes(menu[selected].label)),
      `selected row ${selected} must be painted`);
  }
  const dismissLayout = runtime.notificationDetailMenuLayout(196, 24, menu.length, menu.length - 1);
  assert.equal(dismissLayout.end, menu.length, "Dismiss is the final reachable row");
  assert.ok(dismissLayout.capacity >= 1 && dismissLayout.capacity < menu.length);
});
