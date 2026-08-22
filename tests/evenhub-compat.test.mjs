import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const protocolSource = readFileSync(new URL("../app/compat/evenhub/protocol.ts", import.meta.url), "utf8");
const runtimeSource = readFileSync(new URL("../app/compat/evenhub/runtime.ts", import.meta.url), "utf8")
  .replace(/import[\s\S]*?from "\.\/protocol";\n/, "");
const js = ts.transpileModule(`${protocolSource}\n${runtimeSource}`, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
}).outputText;
const {
  BUNDLED_COUNTER_PACKAGE,
  EvenHubCompatRuntime,
  validateEvenHubRequest,
  validatePackageManifest,
} = await import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));

const controllerSource = readFileSync(new URL("../app/compat/evenhub/sample-controller.ts", import.meta.url), "utf8")
  .replace(/^import[\s\S]*?from "[^"]+";\n/gm, "");
const controllerJs = ts.transpileModule(`${protocolSource}\n${runtimeSource}\n${controllerSource}`, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
}).outputText;
const { EvenHubCounterController } = await import(
  "data:text/javascript;base64," + Buffer.from(controllerJs).toString("base64")
);

function setup() {
  const rendered = [];
  const persisted = new Map();
  const timers = new Map();
  let nextTimer = 1;
  const runtime = new EvenHubCompatRuntime({
    render: (view) => rendered.push(structuredClone(view)),
    readStorage: (key) => persisted.get(key) ?? null,
    writeStorage: (key, value) => persisted.set(key, value),
    removeStorage: (key) => persisted.delete(key),
    setTimer: (callback) => { const id = nextTimer++; timers.set(id, callback); return id; },
    clearTimer: (id) => timers.delete(id),
  });
  return { runtime, rendered, persisted, timers };
}

function request(generation, requestId, method, params = {}, sequence = 1) {
  return { version: 1, generation, sequence, requestId, method, params };
}

test("bundled package has a canonical hash, provenance, and only local capabilities", () => {
  assert.equal(validatePackageManifest(BUNDLED_COUNTER_PACKAGE.manifest), null);
  assert.deepEqual(BUNDLED_COUNTER_PACKAGE.manifest.permissions, ["display", "input", "storage", "timers"]);
  assert.equal(BUNDLED_COUNTER_PACKAGE.manifest.provenance.source, "bundled");
  assert.equal(BUNDLED_COUNTER_PACKAGE.manifest.provenance.license, "GPL-3.0-only");
  assert.equal(
    createHash("sha256").update(BUNDLED_COUNTER_PACKAGE.canonicalContent, "utf8").digest("hex"),
    BUNDLED_COUNTER_PACKAGE.manifest.contentSha256,
  );
  const canonical = JSON.parse(BUNDLED_COUNTER_PACKAGE.canonicalContent);
  assert.deepEqual(canonical.initialView, BUNDLED_COUNTER_PACKAGE.initialView);
  assert.deepEqual(canonical.permissions, BUNDLED_COUNTER_PACKAGE.manifest.permissions);
  assert.deepEqual(canonical.actions, {
    increment: "counter.increment",
    reset: "counter.reset",
    timer: { delayMs: 1000, operation: "timer.once" },
  });
  assert.doesNotMatch(BUNDLED_COUNTER_PACKAGE.canonicalContent, /https?:|WebView|eval\(|Function\(|microphone|location|accelerometer/i);
});

test("bridge schema rejects malformed, unknown, oversized, and sensor requests", () => {
  const valid = request(1, "req-1", "display.set", { view: BUNDLED_COUNTER_PACKAGE.initialView });
  assert.equal(validateEvenHubRequest(valid), null);
  for (const value of [
    { ...valid, extra: true },
    { ...valid, version: 2 },
    { ...valid, generation: 1.5 },
    { ...valid, requestId: "bad id" },
    { ...valid, method: "network.fetch" },
    request(1, "req-2", "microphone.start"),
    request(1, "req-3", "location.watch"),
    request(1, "req-4", "accelerometer.start"),
    request(1, "req-5", "storage.set", { key: "x", value: "x".repeat(2049) }),
    request(1, "req-6", "timer.set", { timerId: "t", delayMs: 249 }),
  ]) assert.ok(validateEvenHubRequest(value), JSON.stringify(value).slice(0, 200));
});

test("hostile object traps are contained as malformed bridge calls", () => {
  const { runtime } = setup();
  runtime.open(BUNDLED_COUNTER_PACKAGE, new Set(["display", "input", "storage", "timers"]), { foreground: true, screenOn: true });
  const hostile = new Proxy({}, { ownKeys: () => { throw new Error("proxy trap"); } });
  assert.doesNotThrow(() => assert.equal(runtime.dispatch(hostile).ok, false));
});

test("host dependency failures return errors instead of escaping the bridge", () => {
  const make = (overrides) => new EvenHubCompatRuntime({
    render: () => {}, readStorage: () => null, writeStorage: () => {}, removeStorage: () => {}, ...overrides,
  });
  for (const [method, params, overrides] of [
    ["display.set", { view: BUNDLED_COUNTER_PACKAGE.initialView }, { render: () => { throw new Error("render"); } }],
    ["storage.set", { key: "x", value: "1" }, { writeStorage: () => { throw new Error("write"); } }],
    ["storage.remove", { key: "x" }, { readStorage: () => '{"x":"1"}', removeStorage: () => { throw new Error("remove"); } }],
    ["timer.set", { timerId: "x", delayMs: 250 }, { setTimer: () => { throw new Error("timer"); } }],
  ]) {
    const runtime = make(overrides);
    const generation = runtime.open(BUNDLED_COUNTER_PACKAGE, new Set(["display", "input", "storage", "timers"]), { foreground: true, screenOn: true });
    assert.doesNotThrow(() => {
      const result = runtime.dispatch(request(generation, `failure-${method}`, method, params));
      assert.equal(result.ok, false);
    });
  }
});

test("replayed and stale calls fail closed across exact session generations", () => {
  const { runtime, rendered } = setup();
  const first = runtime.open(BUNDLED_COUNTER_PACKAGE, new Set(["display", "input", "storage", "timers"]), { foreground: true, screenOn: true });
  assert.equal(runtime.dispatch(request(first, "show-1", "display.set", { view: BUNDLED_COUNTER_PACKAGE.initialView })).ok, true);
  assert.equal(runtime.dispatch(request(first, "show-1", "display.set", { view: BUNDLED_COUNTER_PACKAGE.initialView })).ok, false);
  runtime.close(first);
  const second = runtime.open(BUNDLED_COUNTER_PACKAGE, new Set(["display", "input", "storage", "timers"]), { foreground: true, screenOn: true });
  assert.notEqual(second, first);
  assert.equal(runtime.dispatch(request(first, "late-1", "display.set", { view: BUNDLED_COUNTER_PACKAGE.initialView })).ok, false);
  assert.equal(runtime.close(first), false, "stale close cannot close replacement");
  assert.equal(runtime.isLive(second), true);
  assert.equal(rendered.length, 1);
});

test("session generations remain unique across runtime replacement", () => {
  const first = setup().runtime.open(BUNDLED_COUNTER_PACKAGE, new Set(["display", "input", "storage", "timers"]), { foreground: true, screenOn: true });
  const second = setup().runtime.open(BUNDLED_COUNTER_PACKAGE, new Set(["display", "input", "storage", "timers"]), { foreground: true, screenOn: true });
  assert.notEqual(second, first);
});

test("timers and input are foreground, screen, permission, and generation bound", () => {
  const { runtime, timers } = setup();
  const generation = runtime.open(BUNDLED_COUNTER_PACKAGE, new Set(["display", "input", "storage", "timers"]), { foreground: true, screenOn: true });
  assert.equal(runtime.dispatch(request(generation, "timer-1", "timer.set", { timerId: "tick", delayMs: 250 })).ok, true);
  const staleCallback = [...timers.values()][0];
  runtime.setForeground(generation, false);
  assert.equal(timers.size, 0);
  staleCallback();
  assert.deepEqual(runtime.drainEvents(generation), []);
  runtime.setForeground(generation, true);
  runtime.setScreenOn(generation, false);
  assert.equal(runtime.handleInput(generation, "click"), false);
  runtime.setScreenOn(generation, true);
  assert.equal(runtime.handleInput(generation, "click"), true);
  assert.equal(runtime.drainEvents(generation)[0].type, "input");
  runtime.close(generation);
  assert.equal(runtime.handleInput(generation, "click"), false);
});

test("new sessions fail closed until exact initial lifecycle state is supplied", () => {
  const { runtime, rendered, timers } = setup();
  const generation = runtime.open(BUNDLED_COUNTER_PACKAGE, new Set(["display", "input", "storage", "timers"]), { foreground: true, screenOn: false });
  assert.equal(runtime.dispatch(request(generation, "display-off", "display.set", { view: BUNDLED_COUNTER_PACKAGE.initialView })).ok, false);
  assert.equal(runtime.dispatch(request(generation, "timer-off", "timer.set", { timerId: "x", delayMs: 250 }, 2)).ok, false);
  assert.equal(rendered.length, 0);
  assert.equal(timers.size, 0);
});

test("teardown contains timer cleanup failures after tombstoning", () => {
  const runtime = new EvenHubCompatRuntime({
    render: () => {}, readStorage: () => null, writeStorage: () => {}, removeStorage: () => {},
    setTimer: () => 1, clearTimer: () => { throw new Error("clear failed"); },
  });
  const generation = runtime.open(BUNDLED_COUNTER_PACKAGE, new Set(["display", "input", "storage", "timers"]), { foreground: true, screenOn: true });
  runtime.dispatch(request(generation, "timer", "timer.set", { timerId: "x", delayMs: 250 }));
  assert.doesNotThrow(() => runtime.setForeground(generation, false));
  assert.equal(runtime.isLive(generation), true);
  assert.doesNotThrow(() => runtime.close(generation));
  assert.equal(runtime.isLive(generation), false);
});

test("storage is namespaced, bounded, clearable, and denied without an exact grant", () => {
  const { runtime, persisted } = setup();
  const denied = runtime.open(BUNDLED_COUNTER_PACKAGE, new Set(["display", "input", "timers"]), { foreground: true, screenOn: true });
  assert.equal(runtime.dispatch(request(denied, "set-0", "storage.set", { key: "count", value: "1" })).ok, false);
  runtime.close(denied);

  const generation = runtime.open(BUNDLED_COUNTER_PACKAGE, new Set(["display", "input", "storage", "timers"]), { foreground: true, screenOn: true });
  assert.equal(runtime.dispatch(request(generation, "set-1", "storage.set", { key: "count", value: "1" })).ok, true);
  assert.equal(runtime.dispatch(request(generation, "get-1", "storage.get", { key: "count" }, 2)).value, "1");
  assert.ok([...persisted.keys()][0].startsWith("evenhub.compat.storage.v1.local-counter."));
  assert.equal(runtime.clearStorage(generation), true);
  assert.equal(persisted.size, 0);
  assert.equal(runtime.dispatch(request(generation, "get-2", "storage.get", { key: "count" }, 3)).value, null);
});

test("close tombstones before cleanup and stale timer callbacks cannot reach replacements", () => {
  const { runtime, timers } = setup();
  const first = runtime.open(BUNDLED_COUNTER_PACKAGE, new Set(["display", "input", "storage", "timers"]), { foreground: true, screenOn: true });
  runtime.dispatch(request(first, "timer-1", "timer.set", { timerId: "tick", delayMs: 250 }));
  const staleCallback = [...timers.values()][0];
  runtime.close(first);
  const second = runtime.open(BUNDLED_COUNTER_PACKAGE, new Set(["display", "input", "storage", "timers"]), { foreground: true, screenOn: true });
  staleCallback();
  assert.deepEqual(runtime.drainEvents(second), []);
  assert.equal(runtime.isLive(second), true);
});

test("wearer input drives the bundled sample through the compatibility boundary", () => {
  const persisted = new Map();
  let changes = 0;
  const controller = new EvenHubCounterController({
    read: (key) => persisted.get(key) ?? null,
    write: (key, value) => persisted.set(key, value),
    remove: (key) => persisted.delete(key),
  }, () => { changes++; });
  assert.equal(controller.state().blocks.find((block) => block.type === "key_value" && block.label === "Count").value, "0");
  assert.equal(controller.handleInput("click"), true);
  assert.equal(controller.state().blocks.find((block) => block.type === "key_value" && block.label === "Count").value, "1");
  assert.equal(persisted.size, 1);
  controller.handleInput("scroll-down");
  controller.handleInput("click");
  assert.equal(controller.state().blocks.find((block) => block.type === "key_value" && block.label === "Count").value, "0");
  controller.setForeground(false);
  assert.equal(controller.handleInput("click"), false);
  controller.close();
  assert.equal(controller.handleInput("click"), false);
  assert.ok(changes >= 3);
});

test("counter remains responsive beyond the former request tombstone budget", () => {
  const persisted = new Map();
  const controller = new EvenHubCounterController({
    read: (key) => persisted.get(key) ?? null,
    write: (key, value) => persisted.set(key, value),
    remove: (key) => persisted.delete(key),
  }, () => {}, true);
  for (let index = 0; index < 130; index++) assert.equal(controller.handleInput("click"), true);
  assert.equal(controller.state().blocks.find((block) => block.type === "key_value" && block.label === "Count").value, "130");
});

test("counter reports persistence failure without claiming or displaying an unsaved value", () => {
  const controller = new EvenHubCounterController({
    read: () => null,
    write: () => { throw new Error("write failed"); },
    remove: () => {},
  }, () => {}, true);
  controller.handleInput("click");
  const fields = controller.state().blocks.filter((block) => block.type === "key_value");
  assert.equal(fields.find((block) => block.label === "Count").value, "0");
  assert.equal(fields.find((block) => block.label === "Status").value, "Save failed");
});

test("backgrounding cancels the sample timer and reports truthful resumed state", () => {
  const controller = new EvenHubCounterController({ read: () => null, write: () => {}, remove: () => {} }, () => {}, true);
  controller.handleInput("scroll-down");
  controller.handleInput("scroll-down");
  controller.handleInput("click");
  controller.setForeground(false);
  controller.setForeground(true);
  const status = controller.state().blocks.find((block) => block.type === "key_value" && block.label === "Status").value;
  assert.equal(status, "Timer cancelled in background");
  controller.close();
});

test("sample is registered as an in-process app with lifecycle and clear-data wiring", () => {
  const registry = readFileSync(new URL("../app/apps/all-apps.ts", import.meta.url), "utf8");
  const app = readFileSync(new URL("../app/apps/evenhub-sample/evenhub-sample-app.ts", import.meta.url), "utf8");
  const windowHost = readFileSync(new URL("../app/ui/shell/in-process-window.ts", import.meta.url), "utf8");
  assert.match(registry, /import evenHubSampleApp from "\.\/evenhub-sample"/);
  assert.equal((registry.match(/evenHubSampleApp,/g) ?? []).length, 1);
  assert.match(app, /onForegroundChanged: \(foreground\) => controller\.setForeground\(foreground\)/);
  assert.match(app, /onScreenChanged: \(on\) => controller\.setScreenOn\(on\)/);
  assert.match(app, /label: "Clear local data"/);
  assert.match(windowHost, /setScreenOn: \(on\) => \{/);
  assert.match(windowHost, /options\.onScreenChanged\?\.\(on\)/);
  assert.doesNotMatch(app, /WebView|Http|fetch\(|WebSocket|java\.|android\.|microphone|location|accelerometer|eval\(|Function\(/i);
});

test("clear-data uses a non-secret settings removal boundary", () => {
  const native = readFileSync(new URL("../app/native/settings-store.ts", import.meta.url), "utf8");
  const java = readFileSync(new URL("../App_Resources/Android/src/main/java/com/faceclaw/app/FaceclawSettings.java", import.meta.url), "utf8");
  assert.match(native, /export function removeStringSetting\(key: string\): void/);
  assert.match(native, /if \(SECRET_SETTING_KEYS\.has\(key\)\) throw new Error/);
  assert.match(java, /public boolean removeString\(String key\)/);
  assert.match(java, /public boolean setString\(String key, String value\)/);
  assert.match(native, /if \(!getJava\(\)\.setString\(key, value\)\) throw new Error/);
});

test("privacy, provenance, license, and deferred-install gates are documented", () => {
  const docs = readFileSync(new URL("../docs/evenhub-local-compat.md", import.meta.url), "utf8");
  const privacy = readFileSync(new URL("../PRIVACY", import.meta.url), "utf8");
  const acknowledgements = readFileSync(new URL("../ACKNOWLEDGEMENTS.md", import.meta.url), "utf8");
  const sampleLicense = readFileSync(new URL("../app/compat/evenhub/samples/local-counter/LICENSE", import.meta.url), "utf8");
  assert.match(docs, /Store-backed installation.*NO-GO/is);
  assert.match(docs, /EHPK parsing and extraction.*not included/is);
  assert.match(docs, /16 KiB storage quota/i);
  assert.match(docs, /microphone, location, and accelerometer.*unavailable/is);
  assert.match(privacy, /Local Counter compatibility sample/);
  assert.match(acknowledgements, /Faceclaw EvenHub compatibility research/);
  assert.match(sampleLicense, /GNU GENERAL PUBLIC LICENSE/);
});
