import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

async function loadLayer() {
  const layoutSource = readFileSync(new URL("../app/assistant/dynamic-app-layout.ts", import.meta.url), "utf8")
    .replace(/^import type .*;\n/gm, "");
  const source = readFileSync(new URL("../app/ui/shell/dynamic-app-layer.ts", import.meta.url), "utf8")
    .replace(/^import .*;\n/gm, "");
  const harness = `
    const GESTURE_CLICK = "·";
    const GESTURE_DOUBLE_CLICK = "··";
    const GESTURE_LONG_PRESS = "-";
    const GESTURE_SCROLL = "▲▼";
    const gestureHints = (pairs) => pairs.map(([gesture, label]) => gesture + " " + label).join("   ");
    const shellContentOverlayViewport = (baseSize) => baseSize.width === 640 && baseSize.height === 480
      ? { x: 72, y: 56, width: 536, height: 232 }
      : { x: 0, y: 0, width: Math.min(baseSize.width, 536), height: baseSize.height };
    const font = { lineHeight: 12, measureText: (text) => Array.from(text).length * 6 };
    const getDefaultSmallFont = () => font;
    const truncateText = (_font, text) => text;
    const wrapText = (_font, text) => [text];
    const drawSelectionHighlight = (image, x, y, width, height) => image.commands.push({ type: "selection", x, y, width, height });
    class GrayImage {}
  `;
  const js = ts.transpileModule(`${harness}\n${layoutSource}\n${source}`, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  return import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));
}

function state({ pinState = "available", scrollOffset = 0, components } = {}) {
  return {
    viewId: "context-view-00000001", revision: 2, ownerKey: "socket", title: "Current context",
    state: "ready", privacy: "private", selectedAction: 0, scrollOffset, expiresAtMs: 999_999,
    dashboardId: "context-view-00000001", presentationGeneration: 1, refreshGeneration: 1,
    dashboardState: "ready", contextIntent: "Show current context", presentationLifetime: "temporary",
    pinned: pinState === "saved" || pinState === "unpin_failed", pinState,
    components: components ?? [
      { id: "phone:summary", type: "heading", text: "Current answer" },
      { id: "section:data:row:one", type: "status", label: "Result", value: "Ready" },
      { id: "phone:pin", type: "button", label: pinState === "saved" ? "Unpin" : "Pin",
        action_handle: pinState === "saved" ? "localaction_unpin_pin" : "localaction_pin_pin" },
    ],
  };
}

function deckState({ pageIndex = 0, pageCount = 3, pinState = "available", action = true } = {}) {
  return {
    ...state({ pinState, components: action ? [
      { id: "phone:summary", type: "heading", text: "Current answer" },
      { id: "phone:provenance", type: "text", text: "Hermes reasoning: unknown" },
      { id: "phone:pin", type: "button", label: pinState === "saved" ? "Unpin" : "Pin",
        action_handle: pinState === "saved" ? "localaction_unpin_pin" : "localaction_pin_pin" },
    ] : [
      { id: "section:steps:item:0", type: "text", text: "First step" },
      { id: "section:steps:provenance:0", type: "text", text: "Hermes reasoning: unknown" },
    ] }),
    title: pageIndex === 0 ? "Tomorrow plan" : "Plan",
    presentationMode: "deck",
    pageIndex,
    pageCount,
    pageId: pageIndex === 0 ? "cover" : "section:steps:page:0",
    ...(action ? {
      deckActionHandle: pinState === "saved" ? "localaction_unpin_pin" : "localaction_pin_pin",
      deckActionLabel: pinState === "saved" ? "Unpin" : "Pin",
    } : {}),
  };
}

function paint(ShellDynamicAppLayer, renderState, contextLongPressLabel, baseSize = { width: 640, height: 480 }) {
  const commands = [];
  const image = {
    commands,
    fillRoundedRect: (x, y, width, height) => commands.push({ type: "panel", x, y, width, height }),
    drawRoundedRect: (x, y, width, height) => commands.push({ type: "border", x, y, width, height }),
    drawText: (_font, x, y, text) => commands.push({ type: "text", x, y, text }),
    drawLine: (x, y, x2, y2) => commands.push({ type: "line", x, y, width: x2 - x, height: y2 - y }),
    drawRect: (x, y, width, height) => commands.push({ type: "rect", x, y, width, height }),
    fillRect: (x, y, width, height) => commands.push({ type: "fill", x, y, width, height }),
  };
  const layer = new ShellDynamicAppLayer(renderState, () => false, () => {}, contextLongPressLabel);
  layer.paint({ stack: { getBaseSize: () => baseSize } }, () => image);
  return commands;
}

function footer(commands) {
  return commands.filter((command) => command.type === "text").at(-1).text;
}

test("contextual layer paints within bounds and advertises click only for the focused action", async () => {
  const { ShellDynamicAppLayer } = await loadLayer();
  const inert = paint(ShellDynamicAppLayer, state({ scrollOffset: 0 }));
  assert.match(footer(inert), /^temporary · ▲▼ focus/);
  assert.match(footer(inert), /- ask/);
  assert.match(footer(inert), /·· close/);
  assert.doesNotMatch(footer(inert), /· (?:select|pin|unpin)/);
  assert.equal(inert.filter((command) => command.type === "selection").length, 0);

  const actionable = paint(ShellDynamicAppLayer, state({ scrollOffset: 2 }));
  assert.match(footer(actionable), /· pin/);
  assert.equal(actionable.filter((command) => command.type === "selection").length, 1);
  for (const command of actionable) {
    assert.ok(command.x >= 72 && command.y >= 56, JSON.stringify(command));
    if (command.width !== undefined) assert.ok(command.x + command.width <= 608, JSON.stringify(command));
    if (command.height !== undefined) assert.ok(command.y + command.height <= 288, JSON.stringify(command));
  }
});

test("dynamic apps use global app geometry on shell hosts and local coordinates on app hosts", async () => {
  const { ShellDynamicAppLayer } = await loadLayer();
  const full = paint(ShellDynamicAppLayer, state());
  const local = paint(ShellDynamicAppLayer, state(), undefined, { width: 568, height: 232 });
  assert.deepEqual(full.find((command) => command.type === "panel"),
    { type: "panel", x: 80, y: 60, width: 520, height: 224 });
  assert.deepEqual(local.find((command) => command.type === "panel"),
    { type: "panel", x: 8, y: 4, width: 520, height: 224 });
  for (const command of local) {
    assert.ok(command.x >= 0 && command.y >= 0, JSON.stringify(command));
    if (command.width !== undefined) assert.ok(command.x + command.width <= 536, JSON.stringify(command));
    if (command.height !== undefined) assert.ok(command.y + command.height <= 232, JSON.stringify(command));
  }
});

test("contextual footer reflects sidebar close-mode precedence", async () => {
  const { ShellDynamicAppLayer } = await loadLayer();
  const sidebar = paint(ShellDynamicAppLayer, state(), () => "window management");
  assert.match(footer(sidebar), /- window management/);
  assert.doesNotMatch(footer(sidebar), /- ask/);

  const window = paint(ShellDynamicAppLayer, state(), () => "ask");
  assert.match(footer(window), /- ask/);
});

test("saved and failed pin states remain separate from the temporary presentation lifetime", async () => {
  const { ShellDynamicAppLayer } = await loadLayer();
  const saved = paint(ShellDynamicAppLayer, state({ pinState: "saved", scrollOffset: 2 }));
  assert.match(footer(saved), /^temporary · saved/);
  assert.match(footer(saved), /· unpin/);

  const failed = paint(ShellDynamicAppLayer, state({ pinState: "save_failed", scrollOffset: 1, components: [
    { id: "phone:summary", type: "heading", text: "Current answer" },
    { id: "phone:pin:status", type: "status", label: "Pin", value: "Save failed", tone: "warning" },
    { id: "phone:pin", type: "button", label: "Pin", action_handle: "localaction_pin_pin" },
  ] }));
  assert.match(footer(failed), /^temporary · save failed/);
  assert.doesNotMatch(footer(failed), /· pin/);
  assert.ok(failed.some((command) => command.type === "text" && command.text === "Save failed"));
});

test("layer reserves double-click for close and never forwards long-press", async () => {
  const { ShellDynamicAppLayer } = await loadLayer();
  const inputs = [];
  let closes = 0;
  let renders = 0;
  const layer = new ShellDynamicAppLayer(state({ scrollOffset: 2 }), (type, foreground) => {
    inputs.push({ type, foreground });
    return true;
  }, () => { closes++; });
  const context = { stack: { isFocused: () => true }, actions: { requestRender: () => { renders++; } } };
  layer.handleInput({ type: "long-press" }, context);
  assert.deepEqual(inputs, []);
  assert.equal(closes, 0);
  layer.handleInput({ type: "double-click" }, context);
  assert.deepEqual(inputs, []);
  assert.equal(closes, 1);
  assert.equal(renders, 0);
});

test("deck rendering shows page position and click only on the phone-owned cover action", async () => {
  const { ShellDynamicAppLayer } = await loadLayer();
  const cover = paint(ShellDynamicAppLayer, deckState());
  assert.ok(cover.some((command) => command.type === "text" && command.text === "1/3"));
  assert.match(footer(cover), /^temporary · ready · 1\/3/);
  assert.match(footer(cover), /▲▼ page/);
  assert.match(footer(cover), /· pin/);
  assert.equal(cover.filter((command) => command.type === "selection").length, 1);
  assert.equal(cover.filter((command) => command.type === "rect").length, 3, "every deck page has one visual rail segment");
  assert.equal(cover.filter((command) => command.type === "fill").length, 1, "only the active page rail segment is filled");

  const content = paint(ShellDynamicAppLayer, deckState({ pageIndex: 1, action: false }));
  assert.ok(content.some((command) => command.type === "text" && command.text === "2/3"));
  assert.match(footer(content), /^temporary · ready · 2\/3/);
  assert.match(footer(content), /▲▼ page/);
  assert.doesNotMatch(footer(content), /· (?:pin|unpin|select)/);
  assert.equal(content.filter((command) => command.type === "selection").length, 0);
  assert.equal(content.filter((command) => command.type === "rect").length, 3);
  assert.equal(content.filter((command) => command.type === "fill").length, 1);
  assert.doesNotMatch(content.map((command) => command.text ?? "").join("\n"), /more — scroll/);
});

test("a maximum seven-row departure deck page fits without hidden rows or nested scrolling", async () => {
  const { ShellDynamicAppLayer } = await loadLayer();
  const components = [
    { id: "section:departures:note", type: "text", text: "Showing the next seven services" },
    ...Array.from({ length: 7 }, (_, index) => ({
      id: `section:departures:row:${index}`, type: "status", label: `Destination ${index}`, value: `0${index}:30 P${index}`,
    })),
    { id: "section:departures:provenance:0", type: "text", text: "Public timetable: current · 8s ago" },
  ];
  const commands = paint(ShellDynamicAppLayer, { ...deckState({ pageIndex: 1, action: false }), components });
  const paintedText = commands.filter((command) => command.type === "text").map((command) => command.text);
  for (let index = 0; index < 7; index++) assert.ok(paintedText.includes(`Destination ${index}`), `row ${index}`);
  assert.ok(paintedText.includes("Public timetable: current · 8s ago"));
  assert.doesNotMatch(paintedText.join("\n"), /more — scroll/);
});

test("a five-bar visual comparison fits with labels, values, and provenance", async () => {
  const { ShellDynamicAppLayer } = await loadLayer();
  const components = [
    ...Array.from({ length: 5 }, (_, index) => ({
      id: `section:focus:bar:${index}`, type: "progress", label: `Day ${index + 1} · ${index + 1} h`, value: (index + 1) / 5,
    })),
    { id: "section:focus:provenance:0", type: "text", text: "Current answer: unknown" },
  ];
  const commands = paint(ShellDynamicAppLayer, { ...deckState({ pageIndex: 1, action: false }), title: "Focus by day", components });
  const paintedText = commands.filter((command) => command.type === "text").map((command) => command.text);
  for (let index = 0; index < 5; index++) assert.ok(paintedText.includes(`Day ${index + 1} · ${index + 1} h`));
  assert.ok(paintedText.includes("Current answer: unknown"));
  assert.doesNotMatch(paintedText.join("\n"), /more — scroll/);
});
