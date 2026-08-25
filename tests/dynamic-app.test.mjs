import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../app/assistant/dynamic-app.ts", import.meta.url), "utf8")
  .replace('import type { ToolExecutionContext, ToolResult } from "./tool-registry";', "");
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
}).outputText;
const { DynamicAppManager, validateDynamicAppSpec, DYNAMIC_APP_CAPABILITIES } = await import(
  "data:text/javascript;base64," + Buffer.from(js).toString("base64")
);

const owner = { caller: "mcp", connectionGeneration: "socket-1", turnGeneration: "turn-1" };
const spec = {
  version: 1,
  title: "Living room",
  state: "ready",
  privacy: "private",
  components: [
    { id: "heading", type: "heading", text: "Lights" },
    { id: "lamp", type: "toggle", label: "Floor lamp", value: true, action_handle: "opaque_action_handle_0001" },
    { id: "temp", type: "status", label: "Temperature", value: "21.5 C", tone: "neutral" },
    { id: "print", type: "progress", label: "Printer", value: 0.65 },
  ],
  ttl_seconds: 120,
};

function setup() {
  let now = 1_000;
  const deliveries = [];
  const clears = [];
  const timers = new Map();
  let timerId = 0;
  const manager = new DynamicAppManager({
    isDisplayAvailable: () => true,
    deliver: async (state) => { deliveries.push(structuredClone(state)); return { status: "acknowledged", frameId: deliveries.length }; },
    clear: (identity) => clears.push(identity),
    createId: () => "opaque_dynamic_view_0001",
    now: () => now,
    setTimer: (fn) => { const id = ++timerId; timers.set(id, fn); return id; },
    clearTimer: (id) => timers.delete(id),
  });
  return { manager, deliveries, clears, timers, setNow: (value) => { now = value; } };
}

test("dynamic app validator accepts bounded inert rich primitives and rejects executable or oversized payloads", () => {
  assert.equal(validateDynamicAppSpec(spec), null);
  for (const bad of [
    { ...spec, version: 2 },
    { ...spec, script: "doSomething()" },
    { ...spec, components: [{ id: "x", type: "html", text: "<b>x</b>" }] },
    { ...spec, components: [{ id: "x", type: "text", text: "https://example.com" }] },
    { ...spec, components: Array.from({ length: 65 }, (_, i) => ({ id: `x${i}`, type: "divider" })) },
    { ...spec, components: [{ id: "x", type: "button", label: "Run", action_handle: "shell:rm -rf" }] },
    { ...spec, components: [
      { id: "x", type: "button", label: "One", action_handle: "duplicate_handle_0001" },
      { id: "y", type: "button", label: "Two", action_handle: "duplicate_handle_0001" },
    ] },
    { ...spec, components: [{ id: "x", type: "list", items: Array.from({ length: 33 }, () => "x") }] },
    { ...spec, components: [{ id: "x", type: "progress", label: "x", value: Number.NaN }] },
  ]) assert.ok(validateDynamicAppSpec(bad), JSON.stringify(bad));
  assert.equal(DYNAMIC_APP_CAPABILITIES.maxComponents, 64);
  assert.ok(DYNAMIC_APP_CAPABILITIES.componentTypes.includes("toggle"));
});

test("create and update require exact socket and turn generations and actual delivery acknowledgement", async () => {
  const { manager, deliveries } = setup();
  const created = await manager.create({ operation_id: "create-1", spec }, undefined, () => true, owner);
  assert.equal(created.ok, true);
  assert.deepEqual(JSON.parse(created.content), {
    status: "acknowledged", view_id: "opaque_dynamic_view_0001", revision: 1, frame_id: 1,
  });
  assert.equal(deliveries.length, 1);

  const wrongTurn = await manager.update({ operation_id: "update-wrong", view_id: "opaque_dynamic_view_0001", expected_revision: 1, spec },
    undefined, () => true, { ...owner, turnGeneration: "turn-2" });
  assert.equal(wrongTurn.ok, false);

  const updated = await manager.update({ operation_id: "update-1", view_id: "opaque_dynamic_view_0001", expected_revision: 1,
    spec: { ...spec, title: "Living room now" } }, undefined, () => true, owner);
  assert.equal(JSON.parse(updated.content).revision, 2);
  assert.equal(deliveries.length, 2);
});

test("patch is component-id CAS, rejects duplicates, and preserves unpatched components", async () => {
  const { manager } = setup();
  await manager.create({ operation_id: "create", spec }, undefined, () => true, owner);
  const patched = await manager.patch({
    operation_id: "patch-1", view_id: "opaque_dynamic_view_0001", expected_revision: 1,
    patch: { upsert: [{ id: "lamp", type: "toggle", label: "Floor lamp", value: false, action_handle: "opaque_action_handle_0002" }], remove: ["temp"] },
  }, undefined, () => true, owner);
  assert.equal(patched.ok, true);
  const snapshot = manager.snapshot();
  assert.equal(snapshot.revision, 2);
  assert.deepEqual(snapshot.components.map((item) => item.id), ["heading", "lamp", "print"]);
  assert.equal(snapshot.components[1].value, false);

  const duplicate = await manager.patch({ operation_id: "patch-2", view_id: snapshot.viewId, expected_revision: 2,
    patch: { upsert: [{ id: "x", type: "divider" }, { id: "x", type: "divider" }], remove: [] } }, undefined, () => true, owner);
  assert.equal(duplicate.ok, false);
});

test("events remain until acknowledged and stale or duplicate actions cannot execute twice", async () => {
  const { manager } = setup();
  await manager.create({ operation_id: "create", spec }, undefined, () => true, owner);
  assert.equal(manager.handleInput("scroll-down", true), true);
  assert.equal(manager.handleInput("click", true), true);
  const first = manager.readEvents(owner, "opaque_dynamic_view_0001", 1, null);
  const event = JSON.parse(first.content).events[0];
  assert.equal(event.action_handle, "opaque_action_handle_0001");
  assert.equal(JSON.parse(manager.readEvents(owner, "opaque_dynamic_view_0001", 1, null).content).events.length, 1);
  assert.equal(manager.ackEvents(owner, "opaque_dynamic_view_0001", 1, event.event_id).ok, true);
  assert.deepEqual(JSON.parse(manager.readEvents(owner, "opaque_dynamic_view_0001", 1, event.event_id).content).events, []);
  assert.equal(manager.ackEvents(owner, "opaque_dynamic_view_0001", 1, event.event_id).ok, true);
  assert.equal(manager.ackEvents(owner, "opaque_dynamic_view_0001", 1, "unknown-event").ok, false);
});

test("an old-revision input can be acknowledged after its resulting state patch", async () => {
  const { manager } = setup();
  await manager.create({ operation_id: "create", spec }, undefined, () => true, owner);
  manager.handleInput("scroll-down", true);
  manager.handleInput("click", true);
  const event = JSON.parse(manager.readEvents(owner, "opaque_dynamic_view_0001", 1, null).content).events[0];
  manager.handleInput("click", true);
  await manager.patch({ operation_id: "patch", view_id: "opaque_dynamic_view_0001", expected_revision: 1,
    patch: { upsert: [{ id: "lamp", type: "toggle", label: "Floor lamp", value: false, action_handle: "opaque_action_handle_0002" }], remove: [] } },
  undefined, () => true, owner);
  assert.equal(manager.ackEvents(owner, "opaque_dynamic_view_0001", 2, event.event_id).ok, false);
  assert.equal(manager.ackEvents(owner, "opaque_dynamic_view_0001", 1, event.event_id).ok, true);
  assert.equal(manager.snapshot().revision, 2);
  assert.deepEqual(JSON.parse(manager.readEvents(owner, "opaque_dynamic_view_0001", 2, null).content).events, []);
});

test("cancel, close, expiry, owner replacement, and disconnected display fail closed", async () => {
  const { manager, clears, timers } = setup();
  await manager.create({ operation_id: "create", spec }, undefined, () => true, owner);
  const oldTimer = [...timers.values()][0];
  const closed = manager.close({ operation_id: "close", view_id: "opaque_dynamic_view_0001", expected_revision: 1 }, owner);
  assert.equal(closed.ok, true);
  assert.equal(manager.snapshot(), null);
  oldTimer();
  assert.equal(clears.length, 1);

  const denied = new DynamicAppManager({
    isDisplayAvailable: () => false,
    deliver: async () => { throw new Error("must not deliver"); },
    clear: () => {}, createId: () => "opaque_dynamic_view_0002",
  });
  assert.equal((await denied.create({ operation_id: "create", spec }, undefined, () => true, owner)).ok, false);
});

test("close racing an acknowledged update delivery cannot resurrect the view", async () => {
  let release;
  let manager;
  let deliveries = 0;
  const clears = [];
  manager = new DynamicAppManager({
    isDisplayAvailable: () => true,
    createId: () => "opaque_dynamic_view_0001",
    deliver: async () => {
      deliveries++;
      if (deliveries === 2) await new Promise((resolve) => { release = resolve; });
      return { status: "acknowledged", frameId: deliveries };
    },
    clear: (identity) => clears.push(identity),
    setTimer: () => 1,
    clearTimer: () => {},
  });
  await manager.create({ operation_id: "create", spec }, undefined, () => true, owner);
  const update = manager.update({ operation_id: "update", view_id: "opaque_dynamic_view_0001", expected_revision: 1, spec },
    undefined, () => true, owner);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(manager.handleInput("click", true, { viewId: "opaque_dynamic_view_0001", revision: 2 }), false);
  manager.close({ operation_id: "close", view_id: "opaque_dynamic_view_0001", expected_revision: 1 }, owner);
  release();
  assert.equal((await update).ok, false);
  assert.equal(manager.snapshot(), null);
  assert.deepEqual(clears, [{ viewId: "opaque_dynamic_view_0001", revision: 2 }, { viewId: "opaque_dynamic_view_0001", revision: 1 }]);
});

test("scroll keeps the selected action visible and confirmation choices are distinct", async () => {
  const { manager } = setup();
  const longSpec = { ...spec, components: [
    ...Array.from({ length: 8 }, (_, i) => ({ id: `row-${i}`, type: "status", label: `Row ${i}`, value: "ok" })),
    { id: "confirm", type: "confirmation", text: "Turn everything off?", confirm_handle: "opaque_confirm_handle_0001", cancel_handle: "opaque_cancel_handle_0001" },
  ] };
  await manager.create({ operation_id: "create", spec: longSpec }, undefined, () => true, owner);
  manager.handleInput("scroll-down", true);
  assert.equal(manager.snapshot().scrollOffset, 8);
  manager.handleInput("click", true);
  let event = JSON.parse(manager.readEvents(owner, "opaque_dynamic_view_0001", 1, null).content).events[0];
  assert.equal(event.action_handle, "opaque_cancel_handle_0001");
  manager.ackEvents(owner, "opaque_dynamic_view_0001", 1, event.event_id);
  manager.handleInput("scroll-up", true);
  manager.handleInput("click", true);
  event = JSON.parse(manager.readEvents(owner, "opaque_dynamic_view_0001", 1, null).content).events[0];
  assert.equal(event.action_handle, "opaque_confirm_handle_0001");
});

test("operation IDs are payload-bound tombstones and historical results never claim a closed view is current", async () => {
  const { manager } = setup();
  const args = { operation_id: "create", spec };
  const first = await manager.create(args, undefined, () => true, owner);
  assert.deepEqual(await manager.create(args, undefined, () => true, owner), first);
  assert.equal((await manager.create({ ...args, spec: { ...spec, title: "Changed" } }, undefined, () => true, owner)).ok, false);
  manager.close({ operation_id: "close", view_id: "opaque_dynamic_view_0001", expected_revision: 1 }, owner);
  const historical = await manager.create(args, undefined, () => true, owner);
  assert.equal(JSON.parse(historical.content).status, "historical_acknowledgement");
});

test("owner teardown and disconnect purge operation tombstones before a fresh delivery", async () => {
  const { manager, deliveries } = setup();
  const args = { operation_id: "create", spec };

  await manager.create(args, undefined, () => true, owner);
  manager.closeOwner(owner);
  const afterExactOwnerClose = await manager.create(args, undefined, () => true, owner);
  assert.equal(JSON.parse(afterExactOwnerClose.content).status, "acknowledged");
  assert.equal(deliveries.length, 2);

  manager.closeOwner({ ...owner, turnGeneration: null });
  const afterDisconnect = await manager.create(args, undefined, () => true, owner);
  assert.equal(JSON.parse(afterDisconnect.content).status, "acknowledged");
  assert.equal(deliveries.length, 3);
});

test("system tools expose the complete lifecycle and shell delivery rejects timeout or discarded frames", () => {
  const tools = readFileSync(new URL("../app/assistant/system-tools.ts", import.meta.url), "utf8");
  const shell = readFileSync(new URL("../app/ui/shell/shell.ts", import.meta.url), "utf8");
  const controller = readFileSync(new URL("../app/g2/dashboard-controller.ts", import.meta.url), "utf8");
  for (const name of [
    "glasses.dynamic_apps.capabilities",
    "glasses.dynamic_apps.create",
    "glasses.dynamic_apps.update",
    "glasses.dynamic_apps.patch",
    "glasses.dynamic_apps.close",
    "glasses.dynamic_apps.read_events",
    "glasses.dynamic_apps.ack_events",
  ]) assert.ok(tools.includes(`name: "${name}"`), name);
  assert.match(shell, /showDynamicApp\(/);
  assert.match(shell, /ShellDynamicAppLayer/);
  assert.match(tools, /dynamicApps\.handleInput\(input, foreground, \{ viewId: state\.viewId, revision: state\.revision \}\)/);
  assert.match(controller, /shell\.closeDynamicApp\(\)/);
  assert.match(controller, /const requireSent = Boolean\(isAllowed\)/);
  assert.match(controller, /if \(requireSent && !isSuccessfulFrameOutcome\(outcome\)\)/);
  assert.match(controller, /return \{ frameId, outcome/);
});
