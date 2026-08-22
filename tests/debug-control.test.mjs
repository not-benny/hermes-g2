import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../app/debug/control-protocol.ts", import.meta.url), "utf8");
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
}).outputText;
const { DebugControlHarness } = await import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));

function setup({ online = true } = {}) {
  const calls = [];
  let state = {
    online,
    screenOn: true,
    windowId: "launcher:main",
    processGeneration: "p-test",
    sessionGeneration: 7,
    windowGeneration: 3,
    captureGeneration: 0,
    voiceTest: false,
  };
  const deps = {
    state: () => ({ ...state }),
    wake: async () => { calls.push(["wake"]); },
    blank: async () => { calls.push(["blank"]); },
    open: async (appId) => { calls.push(["open", appId]); state.windowId = `${appId}:main`; state.windowGeneration++; },
    input: async (event) => { calls.push(["input", event]); },
    voiceStart: async (endpointing) => { calls.push(["voiceStart", endpointing]); state.voiceTest = true; state.captureGeneration++; },
    voiceStop: async () => { calls.push(["voiceStop"]); state.voiceTest = false; state.captureGeneration++; },
    fixture: async (fixture) => { calls.push(["fixture", fixture]); return { endpoint: fixture === "speech-envelope-then-silence", transcript: "empty" }; },
  };
  return { harness: new DebugControlHarness(deps), calls, getState: () => state };
}

const binding = {
  processGeneration: "p-test",
  sessionGeneration: 7,
  windowGeneration: 3,
  captureGeneration: 0,
};
const request = (id, command, args = {}, bind = binding) => JSON.stringify({ v: 1, id, command, ...bind, args });

test("state query is redacted, bounded, and bootstraps generation bindings", async () => {
  const { harness } = setup();
  const receipt = await harness.dispatch(JSON.stringify({ v: 1, id: "q-1", command: "state", args: {} }));
  assert.equal(receipt.ok, true);
  assert.deepEqual(receipt.state, {
    online: true, screenOn: true, windowId: "launcher:main", processGeneration: "p-test",
    sessionGeneration: 7, windowGeneration: 3, captureGeneration: 0, voiceTest: false,
  });
  assert.equal(JSON.stringify(receipt).length < 1024, true);
  assert.doesNotMatch(JSON.stringify(receipt), /transcript|audio|token|credential|address/i);
});

test("only exact versioned commands and arguments execute", async () => {
  const { harness, calls } = setup();
  assert.equal((await harness.dispatch(request("a-1", "display.wake"))).ok, true);
  assert.equal((await harness.dispatch(request("a-2", "display.blank"))).ok, true);
  assert.equal((await harness.dispatch(request("a-3", "window.open", { appId: "transcribe" }))).ok, true);
  const next = { ...binding, windowGeneration: 4 };
  assert.equal((await harness.dispatch(request("a-4", "input.inject", { event: "click" }, next))).ok, true);
  assert.deepEqual(calls, [["wake"], ["blank"], ["open", "transcribe"], ["input", "click"]]);
  for (const raw of [
    "not-json",
    JSON.stringify({ v: 2, id: "bad-v", command: "state", args: {} }),
    JSON.stringify({ v: 1, id: "bad-extra", command: "state", args: {}, extra: true }),
    request("bad-command", "intent.send", { url: "https://example.invalid" }),
    request("bad-app", "window.open", { appId: "../../settings" }),
    request("bad-event", "input.inject", { event: "raw-keycode" }),
    request("bad-arg", "display.wake", { shell: "id" }),
  ]) assert.equal((await harness.dispatch(raw)).ok, false);
  assert.equal(calls.length, 4);
});

test("stale, offline, and replayed requests fail closed", async () => {
  const { harness, calls } = setup();
  assert.equal((await harness.dispatch(request("once", "display.wake"))).ok, true);
  assert.equal((await harness.dispatch(request("once", "display.wake"))).code, "replay");
  assert.equal((await harness.dispatch(request("stale-p", "display.wake", {}, { ...binding, processGeneration: "old" }))).code, "stale");
  assert.equal((await harness.dispatch(request("stale-s", "display.wake", {}, { ...binding, sessionGeneration: 6 }))).code, "stale");
  assert.equal((await harness.dispatch(request("stale-w", "display.wake", {}, { ...binding, windowGeneration: 2 }))).code, "stale");
  assert.equal((await harness.dispatch(request("stale-c", "display.wake", {}, { ...binding, captureGeneration: 9 }))).code, "stale");
  const offline = setup({ online: false });
  assert.equal((await offline.harness.dispatch(request("off", "display.wake"))).code, "offline");
  assert.deepEqual(calls, [["wake"]]);
  assert.deepEqual(offline.calls, []);
});

test("voice fixtures require a live owned capture and return content-free classifications", async () => {
  const { harness, calls } = setup();
  assert.equal((await harness.dispatch(request("fixture-before", "voice.fixture", { fixture: "silence-1s" }))).code, "capture-offline");
  const started = await harness.dispatch(request("start", "voice.start", { endpointing: true }));
  assert.equal(started.ok, true);
  const capture1 = { ...binding, captureGeneration: 1 };
  const silence = await harness.dispatch(request("silence", "voice.fixture", { fixture: "silence-1s" }, capture1));
  assert.deepEqual(silence.result, { endpoint: false, transcript: "empty" });
  const speech = await harness.dispatch(request("speech", "voice.fixture", { fixture: "speech-envelope-then-silence" }, capture1));
  assert.deepEqual(speech.result, { endpoint: true, transcript: "empty" });
  assert.doesNotMatch(JSON.stringify(speech), /text|pcm|samples|audio/i);
  assert.equal((await harness.dispatch(request("unknown-fixture", "voice.fixture", { fixture: "file:/sdcard/a.wav" }, capture1))).ok, false);
  assert.equal((await harness.dispatch(request("stop", "voice.stop", {}, capture1))).ok, true);
  assert.deepEqual(calls.map((x) => x[0]), ["voiceStart", "fixture", "fixture", "voiceStop"]);
});

test("teardown clears replay and owned capture state through the dependency cleanup", async () => {
  const { harness, calls } = setup();
  await harness.dispatch(request("start-clean", "voice.start", { endpointing: false }));
  await harness.cleanup();
  assert.deepEqual(calls.at(-1), ["voiceStop"]);
  assert.equal(harness.replaySize(), 0);
});

test("concurrent commands are serialized so generation changes make queued work stale", async () => {
  const calls = [];
  let state = { online: true, screenOn: true, windowId: "launcher:main", processGeneration: "p-test", sessionGeneration: 7, windowGeneration: 3, captureGeneration: 0, voiceTest: false };
  let releaseOpen;
  const openGate = new Promise((resolve) => { releaseOpen = resolve; });
  const harness = new DebugControlHarness({
    state: () => ({ ...state }),
    wake: async () => {}, blank: async () => {},
    open: async () => { calls.push("open"); await openGate; state = { ...state, windowId: "health:main", windowGeneration: 4 }; },
    input: async () => { calls.push("input"); },
    voiceStart: async () => {}, voiceStop: async () => {}, fixture: async () => ({ endpoint: false, transcript: "empty" }),
  });
  const opening = harness.dispatch(request("open-race", "window.open", { appId: "health" }));
  const input = harness.dispatch(request("input-race", "input.inject", { event: "click" }));
  await new Promise((resolve) => setImmediate(resolve));
  releaseOpen();
  assert.equal((await opening).ok, true);
  assert.equal((await input).code, "stale");
  assert.deepEqual(calls, ["open"]);
});
