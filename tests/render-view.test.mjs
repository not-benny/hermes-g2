import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../app/assistant/render-view.ts", import.meta.url), "utf8")
  .replace('import type { ToolExecutionContext, ToolHandler, ToolResult } from "./tool-registry";', "");
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
}).outputText;
const { RenderViewManager, validateRenderViewSpec } = await import(
  "data:text/javascript;base64," + Buffer.from(js).toString("base64")
);

async function loadRenderLayer() {
  const layerSource = readFileSync(new URL("../app/ui/shell/render-view-layer.ts", import.meta.url), "utf8")
    .replace(/^import .*;\n/gm, "");
  const harness = `
    const G2_LENS_WIDTH = 640;
    const MIN_WINDOW_HEIGHT = 288;
    const GESTURE_DOUBLE_CLICK = "double-click";
    const minWindowTop = () => 0;
    const visibleAppViewportRect = () => ({ x: 72, y: 28, width: 536, height: 260 });
    const font = { lineHeight: 12, measureText: (text) => text.length * 6 };
    const getDefaultSmallFont = () => font;
    const truncateText = (_font, text) => text;
    const wrapText = (_font, text) => [text];
    const drawSelectionHighlight = (image, x, y, width, height) => image.commands.push({ type: "selection", x, y, width, height });
    class GrayImage {}
  `;
  const layerJs = ts.transpileModule(`${harness}\n${layerSource}`, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  return import("data:text/javascript;base64," + Buffer.from(layerJs).toString("base64"));
}

function paintRenderLayer(ShellRemoteViewLayer, selectedAction, actions) {
  const commands = [];
  const image = {
    commands,
    fillRoundedRect: (x, y, width, height) => commands.push({ type: "panel", x, y, width, height }),
    drawRoundedRect: (x, y, width, height) => commands.push({ type: "border", x, y, width, height }),
    drawText: (_font, x, y, text) => commands.push({ type: "text", x, y, text }),
    drawLine: (x, y, x2, y2) => commands.push({ type: "line", x, y, width: x2 - x + 1, height: y2 - y + 1 }),
    drawRect: (x, y, width, height) => commands.push({ type: "rect", x, y, width, height }),
    fillRect: (x, y, width, height) => commands.push({ type: "fill", x, y, width, height }),
  };
  const layer = new ShellRemoteViewLayer({
    viewId: "layout-test", revision: 1, ownerKey: "test", title: "Local Counter",
    blocks: [
      { type: "text", text: "Bundled compatibility sample", emphasis: "normal" },
      { type: "key_value", label: "Count", value: "9999" },
      { type: "key_value", label: "Status", value: "Timer cancelled while screen was off" },
    ],
    actions,
    selectedAction,
    expiresAtMs: Number.MAX_SAFE_INTEGER,
  }, () => true, () => {});
  layer.paint({}, () => image);
  return commands;
}

const owner = { caller: "mcp", connectionGeneration: "connection-1", turnGeneration: "turn-1" };
const baseSpec = {
  version: 1,
  title: "Living room",
  blocks: [
    { type: "text", text: "Two lights are on", emphasis: "normal" },
    { type: "key_value", label: "Temperature", value: "21.5 C" },
    { type: "progress", label: "Heating", value: 0.65 },
    { type: "divider" },
  ],
  actions: [{ id: "lights_off", label: "Turn lights off" }],
  ttl_seconds: 60,
};

function setup() {
  let now = 1_000;
  const renders = [];
  const clears = [];
  const timers = new Map();
  let nextTimer = 1;
  const manager = new RenderViewManager({
    isDisplayAvailable: () => true,
    render: async (state) => { renders.push(structuredClone(state)); },
    clear: (identity) => { clears.push(identity); },
    now: () => now,
    setTimer: (callback) => { const id = nextTimer++; timers.set(id, callback); return id; },
    clearTimer: (id) => { timers.delete(id); },
    createId: () => "opaque-view-id-0001",
  });
  return { manager, renders, clears, timers, setNow: (value) => { now = value; } };
}

test("render_view validator accepts only bounded inert V1 primitives", () => {
  assert.equal(validateRenderViewSpec(baseSpec), null);
  for (const spec of [
    { ...baseSpec, version: 2 },
    { ...baseSpec, title: "x".repeat(81) },
    { ...baseSpec, blocks: Array.from({ length: 33 }, () => ({ type: "divider" })) },
    { ...baseSpec, actions: Array.from({ length: 9 }, (_, i) => ({ id: `a${i}`, label: "A" })) },
    { ...baseSpec, blocks: [{ type: "text", text: "https://example.test" }] },
    { ...baseSpec, blocks: [{ type: "html", text: "<b>x</b>" }] },
    { ...baseSpec, blocks: [{ type: "progress", label: "x", value: 1.1 }] },
    { ...baseSpec, actions: [{ id: "bad id", label: "A" }] },
    { ...baseSpec, ttl_seconds: 29 },
    { ...baseSpec, wake: true },
  ]) assert.ok(validateRenderViewSpec(spec), JSON.stringify(spec));
});

test("render_view creates once, CAS-replaces, and rejects stale or foreign owners", async () => {
  const { manager, renders } = setup();
  const created = await manager.render({ operation_id: "op-create", spec: baseSpec }, undefined, () => true, owner);
  assert.equal(created.ok, true);
  const createResult = JSON.parse(created.content);
  assert.deepEqual(createResult, { status: "rendered", view_id: "opaque-view-id-0001", revision: 1, ttl_seconds: 60 });
  assert.equal(renders.length, 1);

  const updateSpec = { ...baseSpec, view_id: createResult.view_id, expected_revision: 1, title: "Updated" };
  const updated = await manager.render({ operation_id: "op-update", spec: updateSpec }, undefined, () => true, owner);
  assert.equal(JSON.parse(updated.content).revision, 2);
  assert.equal(renders.length, 2);

  const stale = await manager.render({ operation_id: "op-stale", spec: updateSpec }, undefined, () => true, owner);
  assert.equal(stale.ok, false);
  const foreign = await manager.render({ operation_id: "op-foreign", spec: { ...updateSpec, expected_revision: 2 } }, undefined, () => true,
    { ...owner, connectionGeneration: "connection-2" });
  assert.equal(foreign.ok, false);
  assert.equal(renders.length, 2);
});

test("render_view is idempotent and never publishes cancelled or failed delivery", async () => {
  const { manager, renders } = setup();
  const first = await manager.render({ operation_id: "same-op", spec: baseSpec }, undefined, () => true, owner);
  const retry = await manager.render({ operation_id: "same-op", spec: baseSpec }, undefined, () => true, owner);
  assert.deepEqual(retry, first);
  assert.equal(renders.length, 1);
  const conflict = await manager.render({ operation_id: "same-op", spec: { ...baseSpec, title: "different" } }, undefined, () => true, owner);
  assert.equal(conflict.ok, false);

  const cancelled = new AbortController(); cancelled.abort();
  const result = await manager.render({ operation_id: "cancelled", spec: { ...baseSpec, view_id: "opaque-view-id-0001", expected_revision: 1 } },
    cancelled.signal, () => true, owner);
  assert.equal(result.ok, false);
  assert.equal(renders.length, 1);
});

test("TTL and owner close tombstone exact generations without deleting replacements", async () => {
  const { manager, clears, timers } = setup();
  await manager.render({ operation_id: "create", spec: baseSpec }, undefined, () => true, owner);
  const oldTimer = [...timers.values()][0];
  await manager.render({ operation_id: "update", spec: { ...baseSpec, view_id: "opaque-view-id-0001", expected_revision: 1 } }, undefined, () => true, owner);
  oldTimer();
  assert.equal(clears.length, 0, "stale TTL cannot clear a replacement revision");
  manager.closeOwner({ caller: "mcp", connectionGeneration: "connection-1", turnGeneration: null });
  assert.equal(clears.length, 1);
  manager.closeOwner(owner);
  assert.equal(clears.length, 1);
});

test("gesture routing is foreground-only, revision-bound, and shell gestures never escape", async () => {
  const { manager } = setup();
  await manager.render({ operation_id: "create", spec: baseSpec }, undefined, () => true, owner);
  assert.equal(manager.handleGesture("scroll-down", true), true);
  assert.equal(manager.handleGesture("click", false), false);
  assert.equal(manager.handleGesture("double-click", true), false);
  assert.equal(manager.handleGesture("long-press", true), false);
  assert.equal(manager.handleGesture("click", true), true);
  const events = manager.readEvents(owner, "opaque-view-id-0001", 1);
  assert.equal(events.ok, true);
  const parsed = JSON.parse(events.content);
  assert.equal(parsed.events.length, 1);
  assert.equal(parsed.events[0].action_id, "lights_off");
  assert.equal(parsed.events[0].revision, 1);
  assert.deepEqual(JSON.parse(manager.readEvents(owner, "opaque-view-id-0001", 1).content).events, []);
});

test("shell integration keeps remote views transient and reserves escape gestures", () => {
  const shellSource = readFileSync(new URL("../app/ui/shell/shell.ts", import.meta.url), "utf8");
  const toolsSource = readFileSync(new URL("../app/assistant/system-tools.ts", import.meta.url), "utf8");
  assert.match(shellSource, /sleep\(\): void \{[\s\S]*this\.remoteViewLayer\?\.close\(\)/);
  assert.match(shellSource, /if \(this\.remoteViewLayer\) \{[\s\S]*layer\.close\(\);[\s\S]*this\.startEscapeMenuTimer\(\)/);
  assert.match(toolsSource, /name: "glasses\.render_view"/);
  assert.match(toolsSource, /name: "glasses\.read_view_events"/);
});

test("shell geometry clips the min app viewport to the centered 576x288 G2 raster", async () => {
  const geometrySource = readFileSync(new URL("../app/ui/shell/geometry.ts", import.meta.url), "utf8")
    .replace(/^import .*;\n/gm, "");
  const harness = `
    const G2_LENS_WIDTH = 640;
    const G2_LENS_HEIGHT = 480;
    const dashboardSizeSetting = { get: () => "standard" };
    const verticalPositionSetting = { get: () => "top" };
  `;
  const geometryJs = ts.transpileModule(`${harness}\n${geometrySource}`, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const geometry = await import("data:text/javascript;base64," + Buffer.from(geometryJs).toString("base64"));
  assert.equal(geometry.G2_VISIBLE_WIDTH, 576);
  assert.deepEqual(geometry.visibleAppViewportRect("min"), { x: 72, y: 28, width: 536, height: 260 });
});

test("render-view layout stays inside the real 576x288 optical and shell viewport", async () => {
  const { ShellRemoteViewLayer } = await loadRenderLayer();
  const actions = ["Increment", "Reset", "Start timer"].map((label, index) => ({ id: `a${index}`, label }));
  const commands = paintRenderLayer(ShellRemoteViewLayer, 0, actions);
  const safeViewport = { left: 72, top: 28, right: 608, bottom: 288 };
  for (const command of commands) {
    assert.ok(command.x >= safeViewport.left, `${command.type} starts before shell/optical viewport: ${JSON.stringify(command)}`);
    assert.ok(command.y >= safeViewport.top, `${command.type} starts above shell viewport: ${JSON.stringify(command)}`);
    if (command.width !== undefined) assert.ok(command.x + command.width <= safeViewport.right, `${command.type} exceeds optical viewport: ${JSON.stringify(command)}`);
    if (command.height !== undefined) assert.ok(command.y + command.height <= safeViewport.bottom, `${command.type} exceeds 288px band: ${JSON.stringify(command)}`);
  }
  const text = commands.filter((command) => command.type === "text").map((command) => command.text);
  for (const required of ["Local Counter", "Count", "9999", "Status", "Increment", "Reset", "Start timer"])
    assert.ok(text.includes(required), `missing ${required}: ${JSON.stringify(text)}`);
});

test("render-view actions paginate around selection and expose position and scroll cues", async () => {
  const { ShellRemoteViewLayer } = await loadRenderLayer();
  const actions = Array.from({ length: 8 }, (_, index) => ({ id: `a${index}`, label: `Action ${index + 1}` }));
  for (const [selected, expected] of [[0, [1, 2, 3]], [3, [3, 4, 5]], [7, [6, 7, 8]]]) {
    const commands = paintRenderLayer(ShellRemoteViewLayer, selected, actions);
    const text = commands.filter((command) => command.type === "text").map((command) => command.text);
    const visible = text.filter((label) => /^Action /.test(label)).map((label) => Number(label.slice(7)));
    assert.deepEqual(visible, expected);
    assert.ok(text.some((label) => label.includes(`${selected + 1}/8`) && /scroll/i.test(label)), `missing navigation cue for ${selected + 1}/8`);
    assert.equal(commands.filter((command) => command.type === "selection").length, 1);
  }
});

test("local close racing initial delivery tombstones the pending identity", async () => {
  let manager;
  const clears = [];
  manager = new RenderViewManager({
    isDisplayAvailable: () => true,
    createId: () => "opaque-view-id-0001",
    render: async (state) => manager.closeView(state.viewId, state.revision),
    clear: (identity) => clears.push(identity),
  });
  const result = await manager.render({ operation_id: "race-close", spec: baseSpec }, undefined, () => true, owner);
  assert.equal(result.ok, false);
  assert.equal(manager.snapshot(), null);
  assert.deepEqual(clears, [{ viewId: "opaque-view-id-0001", revision: 1 }]);
});

test("many updates cannot evict the create idempotency tombstone", async () => {
  let now = 1_000;
  const manager = new RenderViewManager({
    isDisplayAvailable: () => true,
    createId: () => "opaque-view-id-0001",
    render: async () => {}, clear: () => {}, now: () => now,
    setTimer: () => 1, clearTimer: () => {},
  });
  const args = { operation_id: "original-create", spec: baseSpec };
  const created = await manager.render(args, undefined, () => true, owner);
  for (let i = 0; i < 65; i++) {
    now += 1_000;
    const revision = manager.snapshot().revision;
    const updated = await manager.render({ operation_id: `update-${i}`, spec: {
      ...baseSpec, view_id: "opaque-view-id-0001", expected_revision: revision,
    } }, undefined, () => true, owner);
    assert.equal(updated.ok, true);
  }
  manager.closeView("opaque-view-id-0001", 66);
  assert.deepEqual(await manager.render(args, undefined, () => true, owner), created);
  assert.equal(manager.snapshot(), null);
});

test("owner disconnect during update clears committed and pending revisions", async () => {
  let manager;
  const clears = [];
  let renders = 0;
  manager = new RenderViewManager({
    isDisplayAvailable: () => true,
    createId: () => "opaque-view-id-0001",
    clear: (identity) => clears.push(identity),
    render: async () => {
      renders++;
      if (renders === 2) manager.closeOwner({ caller: "mcp", connectionGeneration: "connection-1", turnGeneration: null });
    },
    setTimer: () => 1, clearTimer: () => {},
  });
  await manager.render({ operation_id: "create", spec: baseSpec }, undefined, () => true, owner);
  const result = await manager.render({ operation_id: "update", spec: {
    ...baseSpec, view_id: "opaque-view-id-0001", expected_revision: 1,
  } }, undefined, () => true, owner);
  assert.equal(result.ok, false);
  assert.equal(manager.snapshot(), null);
  assert.deepEqual(clears, [
    { viewId: "opaque-view-id-0001", revision: 1 },
    { viewId: "opaque-view-id-0001", revision: 2 },
  ]);
});
