import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../app/native/voice-turn-gate.ts", import.meta.url), "utf8");
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
}).outputText;
const { VoiceTurnGate } = await import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("manual finish racing auto-finish commits and submits exactly once", () => {
  const gate = new VoiceTurnGate();
  const generation = gate.reserve();
  assert.equal(gate.activate(generation), true);
  assert.equal(gate.acceptsAudio(generation), true);
  assert.equal(gate.finish(generation), true);
  assert.equal(gate.acceptsAudio(generation), false);
  assert.equal(gate.finish(generation), false);
  assert.equal(gate.accepts(generation), true);
  assert.equal(gate.claimSubmit(generation), true);
  assert.equal(gate.claimSubmit(generation), false);
});

test("cancel and provider errors reject late events and never submit", () => {
  const cancelled = new VoiceTurnGate();
  const cancelledGeneration = cancelled.reserve();
  cancelled.activate(cancelledGeneration);
  assert.equal(cancelled.cancel(cancelledGeneration), true);
  assert.equal(cancelled.finish(cancelledGeneration), false);
  assert.equal(cancelled.accepts(cancelledGeneration), false);
  assert.equal(cancelled.claimSubmit(cancelledGeneration), false);

  const failed = new VoiceTurnGate();
  const failedGeneration = failed.reserve();
  failed.activate(failedGeneration);
  assert.equal(failed.fail(failedGeneration), true);
  assert.equal(failed.accepts(failedGeneration), false);
  assert.equal(failed.claimSubmit(failedGeneration), false);
});

test("new-turn reuse rejects stale permission completion, audio, final, and submit", () => {
  const gate = new VoiceTurnGate();
  const oldGeneration = gate.reserve();
  const currentGeneration = gate.reserve();

  assert.notEqual(oldGeneration, currentGeneration);
  assert.equal(gate.activate(oldGeneration), false);
  assert.equal(gate.accepts(oldGeneration), false);
  assert.equal(gate.finish(oldGeneration), false);
  assert.equal(gate.claimSubmit(oldGeneration), false);

  assert.equal(gate.activate(currentGeneration), true);
  assert.equal(gate.accepts(currentGeneration), true);
  assert.equal(gate.finish(currentGeneration), true);
  assert.equal(gate.claimSubmit(currentGeneration), true);
});

test("a pending turn can be cancelled before permission resolves", () => {
  const gate = new VoiceTurnGate();
  const generation = gate.reserve();
  assert.equal(gate.cancel(generation), true);
  assert.equal(gate.activate(generation), false);
  assert.equal(gate.accepts(generation), false);
});

test("manual finish before permission resolves prevents a late start", () => {
  const gate = new VoiceTurnGate();
  const generation = gate.reserve();
  assert.equal(gate.finish(generation), true);
  assert.equal(gate.activate(generation), false);
  assert.equal(gate.acceptsAudio(generation), false);
});

test("voice capture integration carries the exact generation through permission, events, finish, cancel, and submit", () => {
  const layers = read("app/ui/layers.ts");
  const dashboard = read("app/g2/dashboard-controller.ts");
  const voice = read("app/native/voice-control.ts");
  const dialog = read("app/ui/shell/voice-input.ts");

  assert.match(layers, /startVoiceCapture: \(endpointing\?: boolean\) => number/);
  assert.match(layers, /stopVoiceCapture: \(generation: number, commit: boolean\)/);
  assert.match(dashboard, /startVoiceCapture: \(endpointing\?: boolean\) => this\.startVoiceCapture\(endpointing\)/);
  assert.match(dashboard, /voiceControlBridge\.startPushToTalk\(generation, options\)/);
  assert.match(voice, /onTranscript: \(generation: number, text: string, isFinal: boolean\)/);
  assert.match(voice, /onPcm: \(generation: number, pcm: any\)/);
  assert.match(voice, /onSpeechEnd: \(generation: number\)/);
  assert.match(voice, /const nativeStarted = Boolean\(this\.controller\?\.start/);
  assert.match(voice, /if \(!nativeStarted\) this\.failCapture/);
  assert.match(dialog, /event\.generation !== this\.captureGeneration/);
  assert.match(dialog, /voiceControlBridge\.claimSubmit\(this\.captureGeneration\)/);
  assert.match(dialog, /stopVoiceCapture\(this\.captureGeneration, false\)/);
});
