import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { HomeAssistantAdapter, createHomeAssistantTransport } from "../hermes-host/home-assistant-adapter.mjs";
import { DynamicGlassesRuntime } from "../hermes-host/dynamic-glasses-runtime.mjs";

function fakeHa() {
  const calls = [];
  let areaEntities = ["light.floor_lamp", "sensor.secret", "switch.missing"];
  let lamp = { entity_id: "light.floor_lamp", state: "off", attributes: { friendly_name: "Floor lamp" }, last_updated: "2026-08-22T10:00:00Z", context: { id: "ctx-1" } };
  let outside = { entity_id: "switch.garden", state: "on", attributes: { friendly_name: "Garden" }, last_updated: "2026-08-22T10:00:00Z", context: { id: "ctx-2" } };
  const transport = {
    async request(request) {
      calls.push(structuredClone(request));
      if (request.path === "/api/template") return [...areaEntities];
      if (request.path === "/api/states") return [lamp, outside,
        { entity_id: "sensor.secret", state: "42", attributes: { friendly_name: "Secret" }, last_updated: "x", context: { id: "x" } }];
      if (request.path === "/api/states/light.floor_lamp") return structuredClone(lamp);
      if (request.path === "/api/services/light/turn_on") {
        lamp = { ...lamp, state: "on", last_updated: "2026-08-22T10:00:01Z", context: { id: "ctx-3" } };
        return [structuredClone(lamp)];
      }
      if (request.path === "/api/services/light/turn_off") {
        lamp = { ...lamp, state: "off", last_updated: "2026-08-22T10:00:02Z", context: { id: "ctx-4" } };
        return [structuredClone(lamp)];
      }
      throw new Error("unexpected request");
    },
  };
  transport.mutateBinaryCapability = async (request, signal) => {
    const before = structuredClone(lamp);
    const revision = createHash("sha256").update(JSON.stringify({ attributes: before.attributes, context: before.context.id,
      last_updated: before.last_updated, state: before.state })).digest("base64url");
    if (!areaEntities.includes(request.entity_id)) return { applied: false, code: "stale_scope" };
    if (request.expected_revision !== revision) return { applied: false, code: "stale_revision" };
    const service = request.target === "on" ? "turn_on" : "turn_off";
    const [after] = await transport.request({ method: "POST", path: `/api/services/light/${service}`,
      body: { entity_id: request.entity_id }, signal });
    return { applied: true, area: "Living Room", before, after };
  };
  return { transport, calls, setLamp: (value) => { lamp = value; }, setAreaEntities: (value) => { areaEntities = value; } };
}

test("Home Assistant discovers the actual area at runtime and exposes only fresh opaque safe binary capabilities", async () => {
  const { transport, calls } = fakeHa();
  let handleN = 0;
  const adapter = new HomeAssistantAdapter({ transport, createHandle: () => `opaque_entity_handle_${String(++handleN).padStart(4, "0")}`, now: () => 1_000 });
  const devices = await adapter.discover({ kind: "area", label: "Living Room" });
  assert.deepEqual(devices.map(({ label, kind, value }) => ({ label, kind, value })), [
    { label: "Floor lamp", kind: "light", value: "off" },
  ]);
  assert.equal(devices[0].handle, "opaque_entity_handle_0001");
  assert.ok(!JSON.stringify(devices).includes("light.floor_lamp"));
  assert.deepEqual(calls.slice(0, 2).map((call) => call.path), ["/api/template", "/api/states"]);
  assert.equal(calls[0].body.variables.area, "Living Room");

  await adapter.discover({ kind: "area", label: "Living Room" });
  await assert.rejects(() => adapter.read("opaque_entity_handle_0001"), /stale capability/i);
});

test("Home Assistant explicit set is revision checked, idempotent, reauthorized immediately before side effect, and verified", async () => {
  const { transport, calls } = fakeHa();
  const adapter = new HomeAssistantAdapter({ transport, createHandle: () => "opaque_entity_handle_0001", now: () => 1_000 });
  const [device] = await adapter.discover({ kind: "area", label: "Living Room" });
  await assert.rejects(() => adapter.setPower({ operationId: "op-stale", handle: device.handle, value: "on", expectedRevision: "wrong" },
    { isAuthorized: () => true }), /revision/i);
  assert.equal(calls.filter((call) => call.path.includes("/api/services/")).length, 0);

  let authorized = true;
  const receipt = await adapter.setPower({ operationId: "op-1", handle: device.handle, value: "on", expectedRevision: device.revision },
    { isAuthorized: () => authorized });
  assert.equal(receipt.after.value, "on");
  assert.equal(calls.filter((call) => call.path === "/api/services/light/turn_on").length, 1);
  assert.equal(calls.some((call) => call.path.includes("toggle")), false);
  assert.deepEqual(await adapter.setPower({ operationId: "op-1", handle: device.handle, value: "on", expectedRevision: device.revision },
    { isAuthorized: () => authorized }), receipt);
  assert.equal(calls.filter((call) => call.path === "/api/services/light/turn_on").length, 1);
  await assert.rejects(() => adapter.setPower({ operationId: "op-1", handle: device.handle, value: "off", expectedRevision: receipt.after.revision },
    { isAuthorized: () => true }), /different mutation/i);

  const current = await adapter.read(device.handle);
  authorized = false;
  await assert.rejects(() => adapter.setPower({ operationId: "op-denied", handle: device.handle, value: "off", expectedRevision: current.revision },
    { isAuthorized: () => authorized }), /no longer authorized/i);
  assert.equal(calls.filter((call) => call.path === "/api/services/light/turn_off").length, 0);
});

test("Home Assistant reserves concurrent operation IDs and revalidates area membership at dispatch", async () => {
  const base = fakeHa();
  let releaseService;
  const serviceGate = new Promise((resolve) => { releaseService = resolve; });
  let serviceAttempts = 0;
  const transport = {
    request: (request) => base.transport.request(request),
    mutateBinaryCapability: async (request, signal) => {
      serviceAttempts++;
      await serviceGate;
      return base.transport.mutateBinaryCapability(request, signal);
    },
  };
  const adapter = new HomeAssistantAdapter({ transport, createHandle: () => "opaque_entity_handle_0001", now: () => 1_000 });
  const [device] = await adapter.discover({ kind: "area", label: "Living Room" });
  const request = { operationId: "same-op", handle: device.handle, value: "on", expectedRevision: device.revision };
  const first = adapter.setPower(request, { isAuthorized: () => true });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const second = adapter.setPower(request, { isAuthorized: () => true });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(serviceAttempts, 1);
  releaseService();
  assert.deepEqual(await second, await first);

  const moved = fakeHa();
  const movedAdapter = new HomeAssistantAdapter({ transport: moved.transport, createHandle: () => "opaque_entity_handle_0002", now: () => 1_000 });
  const [movedDevice] = await movedAdapter.discover({ kind: "area", label: "Living Room" });
  moved.setAreaEntities([]);
  await assert.rejects(() => movedAdapter.setPower({ operationId: "moved", handle: movedDevice.handle, value: "on", expectedRevision: movedDevice.revision },
    { isAuthorized: () => true }), /scope|area|stale/i);
  assert.equal(moved.calls.filter((call) => call.path.startsWith("/api/services/")).length, 0);
});

test("a post-dispatch failure is outcome-unknown and retry never redispatches", async () => {
  const base = fakeHa();
  let serviceCalls = 0;
  const transport = {
    request: (request) => base.transport.request(request),
    mutateBinaryCapability: async (request, signal) => {
      serviceCalls++;
      await base.transport.mutateBinaryCapability(request, signal);
      throw new Error("private provider response lost");
    },
  };
  const adapter = new HomeAssistantAdapter({ transport, createHandle: () => "opaque_entity_handle_0001", now: () => 1_000 });
  const [device] = await adapter.discover({ kind: "area", label: "Living Room" });
  const request = { operationId: "unknown-op", handle: device.handle, value: "on", expectedRevision: device.revision };
  await assert.rejects(() => adapter.setPower(request, { isAuthorized: () => true }), /outcome unknown/i);
  await assert.rejects(() => adapter.setPower(request, { isAuthorized: () => true }), /outcome unknown/i);
  assert.equal(serviceCalls, 1);
});

test("restore is conservative and refuses to overwrite a later human or automation change", async () => {
  const { transport, setLamp } = fakeHa();
  const adapter = new HomeAssistantAdapter({ transport, createHandle: () => "opaque_entity_handle_0001", now: () => 1_000 });
  const [device] = await adapter.discover({ kind: "area", label: "Living Room" });
  const receipt = await adapter.setPower({ operationId: "op-1", handle: device.handle, value: "on", expectedRevision: device.revision },
    { isAuthorized: () => true });
  setLamp({ entity_id: "light.floor_lamp", state: "on", attributes: { friendly_name: "Floor lamp", brightness: 1 },
    last_updated: "2026-08-22T10:00:03Z", context: { id: "human-change" } });
  assert.deepEqual(await adapter.restore(receipt, { operationId: "restore-1", isAuthorized: () => true }),
    { restored: false, reason: "state-changed" });
});

test("fetch transport keeps credentials server-side, requires HTTPS, blocks redirects, and redacts failures", async () => {
  assert.throws(() => createHomeAssistantTransport({ baseUrl: "http://ha.local", getToken: () => "sentinel-token" }), /https/i);
  const seen = [];
  const transport = createHomeAssistantTransport({
    baseUrl: "https://private-ha.invalid",
    getToken: () => "sentinel-token",
    fetchImpl: async (url, options) => {
      seen.push({ url, options });
      return { ok: false, status: 500, json: async () => ({ secret: "sentinel-body" }), text: async () => "sentinel-body" };
    },
  });
  await assert.rejects(() => transport.request({ method: "GET", path: "/api/states" }), (error) => {
    assert.equal(JSON.stringify(error).includes("sentinel"), false);
    assert.equal(String(error).includes("private-ha"), false);
    return true;
  });
  assert.equal(seen[0].options.redirect, "error");
  assert.equal(seen[0].options.headers.Authorization, "Bearer sentinel-token");
});

test("runtime renders a provider-neutral living-room app and executes only exact current opaque actions once", async () => {
  const { transport, calls } = fakeHa();
  let handleN = 0;
  const adapter = new HomeAssistantAdapter({ transport, createHandle: () => `opaque_entity_handle_${String(++handleN).padStart(4, "0")}`, now: () => 1_000 });
  const phoneCalls = [];
  const phone = {
    async callTool(name, args) {
      phoneCalls.push({ name, args: structuredClone(args) });
      if (name.endsWith(".create")) return { status: "acknowledged", view_id: "opaque_dynamic_view_0001", revision: 1, frame_id: 7 };
      if (name.endsWith(".patch")) return { status: "acknowledged", view_id: args.view_id, revision: args.expected_revision + 1, frame_id: 8 };
      if (name.endsWith(".ack_events")) return { status: "acknowledged" };
      throw new Error(`unexpected tool ${name}`);
    },
  };
  let actionN = 0;
  const runtime = new DynamicGlassesRuntime({ adapter, phone,
    createHandle: () => `opaque_action_handle_${String(++actionN).padStart(4, "0")}`, now: () => 1_000 });
  const identity = { tenant: "owner", device: "g2", connectionGeneration: "socket-1", turnGeneration: "turn-1" };
  const opened = await runtime.openLivingRoom(identity, { operationId: "open-1" });
  assert.equal(opened.revision, 1);
  const create = phoneCalls[0];
  assert.equal(create.name, "glasses.dynamic_apps.create");
  assert.equal(create.args.spec.components.some((item) => item.type === "toggle"), true);
  assert.equal(JSON.stringify(create.args).includes("light.floor_lamp"), false);

  const event = { event_id: "event-1", view_id: opened.viewId, revision: 1, action_handle: "opaque_action_handle_0001", kind: "activate" };
  const acted = await runtime.deliverInput(identity, event, { operationId: "event-op-1" });
  assert.equal(acted.state, "on");
  assert.equal(phoneCalls.some((call) => call.name.endsWith(".patch")), true);
  assert.equal(phoneCalls.at(-1).name, "glasses.dynamic_apps.ack_events");
  assert.deepEqual(await runtime.deliverInput(identity, event, { operationId: "event-op-1" }), acted);
  assert.equal(calls.filter((call) => call.path === "/api/services/light/turn_on").length, 1);
  await assert.rejects(() => runtime.deliverInput({ ...identity, turnGeneration: "turn-2" }, event, { operationId: "event-op-2" }), /stale/i);
  await assert.rejects(() => runtime.deliverInput({ ...identity, tenant: "other" }, event, { operationId: "event-op-1" }), /stale|owner|identity/i);
});

test("runtime keeps untouched multi-device actions current and bounds a 64-device provider to the phone limit", async () => {
  const snapshots = new Map([
    ["entity-handle-0001", { handle: "entity-handle-0001", label: "Lamp A", value: "off", revision: "a1" }],
    ["entity-handle-0002", { handle: "entity-handle-0002", label: "Lamp B", value: "off", revision: "b1" }],
  ]);
  const adapter = {
    async discover() { return [...snapshots.values()]; },
    async read(handle) { return structuredClone(snapshots.get(handle)); },
    async setPower(request) {
      const before = structuredClone(snapshots.get(request.handle));
      const after = { ...before, value: request.value, revision: `${before.revision}-next` };
      snapshots.set(request.handle, after);
      return { operationId: request.operationId, changed: true, before, after };
    },
  };
  let revision = 0;
  const phone = { async callTool(name, args) {
    if (name.endsWith(".create")) return { status: "acknowledged", view_id: "opaque_dynamic_view_0001", revision: ++revision, frame_id: revision };
    if (name.endsWith(".patch")) return { status: "acknowledged", view_id: args.view_id, revision: ++revision, frame_id: revision };
    return { status: "acknowledged" };
  } };
  let actionN = 0;
  const runtime = new DynamicGlassesRuntime({ adapter, phone, createHandle: () => `opaque_action_handle_${String(++actionN).padStart(4, "0")}`, now: () => 1_000 });
  const identity = { tenant: "owner", device: "g2", connectionGeneration: "socket-1", turnGeneration: "turn-1" };
  await runtime.openLivingRoom(identity, { operationId: "open" });
  await runtime.deliverInput(identity, { event_id: "e1", view_id: "opaque_dynamic_view_0001", revision: 1,
    action_handle: "opaque_action_handle_0001", kind: "activate" }, { operationId: "op1" });
  await runtime.deliverInput(identity, { event_id: "e2", view_id: "opaque_dynamic_view_0001", revision: 2,
    action_handle: "opaque_action_handle_0002", kind: "activate" }, { operationId: "op2" });
  assert.equal(snapshots.get("entity-handle-0002").value, "on");

  const manyAdapter = { ...adapter, async discover() { return Array.from({ length: 64 }, (_, i) => ({
    handle: `entity-handle-${String(i).padStart(4, "0")}`, label: `Device ${i}`, value: "off", revision: `r${i}`,
  })); } };
  const manyCalls = [];
  const manyPhone = { async callTool(name, args) { manyCalls.push({ name, args }); return { status: "acknowledged", view_id: "opaque_dynamic_view_0002", revision: 1, frame_id: 1 }; } };
  let manyN = 0;
  const manyRuntime = new DynamicGlassesRuntime({ adapter: manyAdapter, phone: manyPhone,
    createHandle: () => `opaque_many_action_${String(++manyN).padStart(4, "0")}`, now: () => 1_000 });
  await manyRuntime.openLivingRoom(identity, { operationId: "many" });
  assert.equal(manyCalls[0].args.spec.components.length, 64);
});

test("runtime rejects concurrent opens and close tombstones an in-flight discovery", async () => {
  let release;
  const adapter = { discover: () => new Promise((resolve) => { release = resolve; }) };
  const phoneCalls = [];
  const phone = { async callTool(name, args) { phoneCalls.push({ name, args }); return { status: "acknowledged" }; } };
  const runtime = new DynamicGlassesRuntime({ adapter, phone, now: () => 1_000 });
  const identity = { tenant: "owner", device: "g2", connectionGeneration: "socket-1", turnGeneration: "turn-1" };
  const first = runtime.openLivingRoom(identity, { operationId: "open-1" });
  await assert.rejects(() => runtime.openLivingRoom(identity, { operationId: "open-2" }), /pending/i);
  runtime.close(identity);
  release([]);
  await assert.rejects(() => first, /stale/i);
  assert.equal(phoneCalls.length, 0);
});

test("runtime compensates a close racing phone create and permits a clean replacement only afterward", async () => {
  let releaseCreate;
  const adapter = { async discover() { return []; } };
  const calls = [];
  const phone = { async callTool(name, args) {
    calls.push({ name, args });
    if (name.endsWith(".create")) {
      await new Promise((resolve) => { releaseCreate = resolve; });
      return { status: "acknowledged", view_id: "opaque_dynamic_view_0001", revision: 1, frame_id: 1 };
    }
    return { status: "closed", view_id: "opaque_dynamic_view_0001", revision: 1 };
  } };
  const runtime = new DynamicGlassesRuntime({ adapter, phone, now: () => 1_000 });
  const ownerA = { tenant: "a", device: "g2", connectionGeneration: "socket-a", turnGeneration: "turn-a" };
  const ownerB = { tenant: "b", device: "g2", connectionGeneration: "socket-b", turnGeneration: "turn-b" };
  const first = runtime.openLivingRoom(ownerA, { operationId: "open-a" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  runtime.close(ownerA);
  await assert.rejects(() => runtime.openLivingRoom(ownerB, { operationId: "open-b-early" }), /pending/i);
  releaseCreate();
  await assert.rejects(() => first, /stale/i);
  assert.equal(calls.some((call) => call.name.endsWith(".close")), true);
  assert.ok(calls.find((call) => call.name.endsWith(".close")).args.operation_id.length <= 64);

  let releaseFailedCreate;
  const failedPhone = { async callTool(name) {
    if (name.endsWith(".create")) {
      await new Promise((resolve) => { releaseFailedCreate = resolve; });
      return { status: "acknowledged", view_id: "opaque_dynamic_view_0002", revision: 1, frame_id: 1 };
    }
    return { status: "closed", view_id: "different_live_view", revision: 999 };
  } };
  const failedRuntime = new DynamicGlassesRuntime({ adapter, phone: failedPhone, now: () => 1_000 });
  const failed = failedRuntime.openLivingRoom(ownerA, { operationId: "x".repeat(64) });
  await new Promise((resolve) => setTimeout(resolve, 0));
  failedRuntime.close(ownerA);
  releaseFailedCreate();
  await assert.rejects(() => failed, /cleanup is unconfirmed/i);
  await assert.rejects(() => failedRuntime.openLivingRoom(ownerB, { operationId: "blocked" }), /pending/i);
});

test("runtime retires expired sessions and serializes different action side effects", async () => {
  let now = 1_000;
  let setCalls = 0;
  let releaseSet;
  const devices = [
    { handle: "entity-handle-0001", label: "A", value: "off", revision: "a1" },
    { handle: "entity-handle-0002", label: "B", value: "off", revision: "b1" },
  ];
  const adapter = {
    async discover() { return devices; },
    async read(handle) { return structuredClone(devices.find((device) => device.handle === handle)); },
    async setPower(request) {
      setCalls++;
      await new Promise((resolve) => { releaseSet = resolve; });
      const before = structuredClone(devices.find((device) => device.handle === request.handle));
      const after = { ...before, value: request.value, revision: `${before.revision}-next` };
      return { changed: true, before, after };
    },
  };
  let revision = 0;
  const phone = { async callTool(name, args) {
    if (name.endsWith(".create")) return { status: "acknowledged", view_id: `opaque_dynamic_view_000${revision + 1}`, revision: 1, frame_id: ++revision };
    if (name.endsWith(".patch")) return { status: "acknowledged", view_id: args.view_id, revision: args.expected_revision + 1, frame_id: ++revision };
    return { status: "acknowledged" };
  } };
  let actionN = 0;
  const runtime = new DynamicGlassesRuntime({ adapter, phone, createHandle: () => `opaque_action_handle_${String(++actionN).padStart(4, "0")}`, now: () => now });
  const identity = { tenant: "owner", device: "g2", connectionGeneration: "socket", turnGeneration: "turn" };
  const opened = await runtime.openLivingRoom(identity, { operationId: "open" });
  const first = runtime.deliverInput(identity, { event_id: "e1", view_id: opened.viewId, revision: 1,
    action_handle: "opaque_action_handle_0001", kind: "activate" }, { operationId: "op1" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  await assert.rejects(() => runtime.deliverInput(identity, { event_id: "e2", view_id: opened.viewId, revision: 1,
    action_handle: "opaque_action_handle_0002", kind: "activate" }, { operationId: "op2" }), /in progress/i);
  assert.equal(setCalls, 1);
  releaseSet();
  await first;
  now += 301_000;
  await runtime.openLivingRoom(identity, { operationId: "reopen" });
});
