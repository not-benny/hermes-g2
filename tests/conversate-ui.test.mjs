import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

/**
 * Load the layer against a deliberately tiny UI/native harness.  This keeps
 * these tests at the layer boundary: the production reducer, capture
 * lifecycle, input routing, and renderer execute unchanged, while hardware
 * and the rest of the dashboard remain deterministic.
 */
async function loadConversateLayer() {
  const session = read("app/apps/conversate/conversation-session.ts")
    .replace("export default ConversationSession;", "")
    .replace("export class ConversationSession", "class ConversationSession");
  const layer = read("app/apps/conversate/conversate.ts")
    .replace(/^import[\s\S]*?from "[^"]+";\s*/gm, "");
  const harness = `
const transcriptListeners = new Set();
const statusListeners = new Set();
const testBridge = {
  onTranscript(listener) { transcriptListeners.add(listener); return () => transcriptListeners.delete(listener); },
  onStatus(listener) { statusListeners.add(listener); return () => statusListeners.delete(listener); },
  emitTranscript(event) { for (const listener of transcriptListeners) listener(event); },
  emitStatus(event) { for (const listener of statusListeners) listener(event); },
};
const voiceControlBridge = testBridge;
const GESTURE_CLICK = "CLICK";
const GESTURE_DOUBLE_CLICK = "DOUBLE";
const captionFontSizeSetting = { get: () => "small" };
const captionLayoutSetting = { get: () => "source" };
const captionSourceLanguageSetting = { get: () => "auto" };
const captionTargetLanguageSetting = { get: () => "off" };
class CaptionSession {
  constructor() { this.finalized = []; this.live = ""; this.translation = ""; }
  begin() { this.live = ""; this.translation = ""; }
  pause() {}
  stop() {}
  clear() { this.finalized = []; this.live = ""; this.translation = ""; }
  apply(event) {
    if (event.type !== "transcript") return;
    if (event.sourceRevisionPresent !== false && !event.isFinal) this.live = event.text || "";
    if (event.isFinal) {
      const text = event.text || this.live;
      if (text) this.finalized.push(text);
      this.live = "";
    }
  }
  snapshot() { return { displaySource: [...this.finalized, this.live].filter(Boolean).join(" "), displayTranslation: this.translation, translationCurrent: false }; }
}
const provider = { selected: "onboard", effective: "onboard", label: "On-device", locality: "local", configured: true };
const currentConversateProvider = () => provider;
const cycleConversateProvider = () => provider;
const conversatePrivacyStatus = () => "LOCAL · NO AUDIO UPLOAD";
const captionProviderCapabilities = () => ({ translation: false });
const getDefaultSmallFont = () => ({ lineHeight: 12, measureText: (text) => [...String(text)].length * 6 });
const getDefaultMediumFont = () => ({ lineHeight: 18, measureText: (text) => [...String(text)].length * 9 });
const truncateText = (_font, text, maxWidth) => String(text).slice(0, Math.max(0, Math.floor(maxWidth / 6)));
const wrapCaptionText = (text, maxWidth, measure) => {
  const words = String(text).split(/\\s+/u);
  const lines = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? line + " " + word : word;
    if (line && measure(candidate) > maxWidth) { lines.push(line); line = word; }
    else line = candidate;
  }
  if (line || !lines.length) lines.push(line);
  return lines;
};
const bottomAnchoredLines = (lines, maxLines) => lines.slice(-maxLines);
class GrayImage {
  constructor(width, height) { this.width = width; this.height = height; this.operations = []; }
  drawText(font, x, y, text, color) { this.operations.push({ type: "text", font, x, y, text: String(text), color }); }
  drawLine(x1, y1, x2, y2, color) { this.operations.push({ type: "line", x1, y1, x2, y2, color }); }
  drawRoundedRect(x, y, width, height, radius, color) { this.operations.push({ type: "rect", x, y, width, height, radius, color }); }
}
${session}
${layer}
export { ConversateLayer, testBridge };
`;
  const js = ts.transpileModule(harness, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));
}

const { ConversateLayer, testBridge } = await loadConversateLayer();
const activeLayers = new Set();

test.afterEach(() => {
  for (const layer of activeLayers) layer.onRemoved();
  activeLayers.clear();
});

function makeLayer({ generations = [1], deferFinish = false } = {}) {
  const starts = [];
  const stops = [];
  const finishResolvers = [];
  let index = 0;
  let renders = 0;
  const layer = new ConversateLayer({
    startCapture: (provider) => {
      const generation = generations[Math.min(index++, generations.length - 1)];
      starts.push({ generation, provider });
      return generation;
    },
    finishCapture: (generation) => {
      stops.push(generation);
      if (!deferFinish) return Promise.resolve();
      return new Promise((resolve) => finishResolvers.push(resolve));
    },
    stopCapture: (generation) => stops.push(generation),
  });
  layer.start(() => { renders++; });
  layer.onForegroundChanged(true);
  layer.onScreenChanged(true);
  activeLayers.add(layer);
  return {
    layer,
    starts,
    stops,
    resolveFinish: () => finishResolvers.shift()?.(),
    get renders() { return renders; },
  };
}

function render(layer) {
  return layer.paint({ stack: { getBaseSize: () => ({ width: 536, height: 232 }) } });
}

function textOperations(image) {
  return image.operations.filter((operation) => operation.type === "text").map((operation) => operation.text);
}

function assertInBounds(image) {
  for (const operation of image.operations) {
    if (operation.type === "text") {
      assert.ok(operation.x >= 0 && operation.x < image.width, `text x out of bounds: ${operation.x}`);
      assert.ok(operation.y >= 0 && operation.y < image.height, `text y out of bounds: ${operation.y}`);
    } else if (operation.type === "line") {
      assert.ok(operation.x1 >= 0 && operation.x2 <= image.width, "line x out of bounds");
      assert.ok(operation.y1 >= 0 && operation.y2 <= image.height, "line y out of bounds");
    } else if (operation.type === "rect") {
      assert.ok(operation.x >= 0 && operation.x + operation.width <= image.width, "rect x out of bounds");
      assert.ok(operation.y >= 0 && operation.y + operation.height <= image.height, "rect y out of bounds");
    }
  }
}

test("Conversate does not auto-capture, then starts with its independent on-device provider", () => {
  const harness = makeLayer({ generations: [11] });
  assert.deepEqual(harness.starts, [], "opening the layer must not open the microphone");
  harness.layer.handleInput({ type: "click" });
  assert.deepEqual(harness.starts, [{ generation: 11, provider: "onboard" }]);
  assert.equal(harness.layer.phase(), "active");
});

test("partial transcript creates a local cue, click opens detail, and the compact HUD stays bounded", () => {
  const harness = makeLayer({ generations: [12] });
  harness.layer.handleInput({ type: "click" });
  testBridge.emitTranscript({ generation: 12, text: "Need to email Simon", isFinal: false, receivedAtMs: 10 });

  const live = render(harness.layer);
  assert.ok(textOperations(live).some((text) => text.includes("Need to email Simon")));
  assertInBounds(live);

  harness.layer.handleInput({ type: "click" });
  const cue = render(harness.layer);
  assert.ok(textOperations(cue).some((text) => text.includes("LOCAL CUE")));
  assert.ok(textOperations(cue).some((text) => text.includes("Need to email Simon")));
  assertInBounds(cue);

  harness.layer.handleInput({ type: "click" });
  assert.ok(textOperations(render(harness.layer)).some((text) => text.includes("TRANSCRIPT")));
});

test("double-click ends the exact capture and stale events cannot resurrect the session", async () => {
  const harness = makeLayer({ generations: [20] });
  harness.layer.handleInput({ type: "click" });
  testBridge.emitTranscript({ generation: 20, text: "first turn", isFinal: true, receivedAtMs: 20 });
  assert.equal(harness.layer.handleDoubleClick(), true);
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(harness.stops, [20]);
  assert.equal(harness.layer.phase(), "ended");
  testBridge.emitTranscript({ generation: 20, text: "stale after end", isFinal: true, receivedAtMs: 21 });
  assert.equal(textOperations(render(harness.layer)).some((text) => text.includes("stale after end")), false);
});

test("end remains generation-owned while the provider flushes its final transcript", async () => {
  const harness = makeLayer({ generations: [21], deferFinish: true });
  harness.layer.handleInput({ type: "click" });
  testBridge.emitTranscript({ generation: 21, text: "closing", isFinal: false, receivedAtMs: 20 });
  assert.equal(harness.layer.handleDoubleClick(), true);
  assert.equal(harness.layer.phase(), "active", "review must wait for the provider's final callback");

  testBridge.emitTranscript({
    generation: 21,
    text: "closing phrase confirmed",
    isFinal: true,
    receivedAtMs: 21,
  });
  harness.resolveFinish();
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(harness.layer.phase(), "ended");
  assert.match(textOperations(render(harness.layer)).join(" "), /closing phrase confirmed/);
});

test("pause and resume use a new capture generation while preserving the conversation", async () => {
  const harness = makeLayer({ generations: [30, 31] });
  harness.layer.handleInput({ type: "click" });
  testBridge.emitTranscript({ generation: 30, text: "first turn", isFinal: true, receivedAtMs: 30 });
  harness.layer.togglePaused();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(harness.layer.phase(), "paused");
  assert.deepEqual(harness.stops, [30]);
  testBridge.emitTranscript({ generation: 30, text: "old generation", isFinal: true, receivedAtMs: 31 });

  harness.layer.togglePaused();
  assert.deepEqual(harness.starts, [
    { generation: 30, provider: "onboard" },
    { generation: 31, provider: "onboard" },
  ]);
  testBridge.emitTranscript({ generation: 31, text: "second turn", isFinal: true, receivedAtMs: 32 });
  const image = render(harness.layer);
  const rendered = textOperations(image).join(" ");
  assert.match(rendered, /first turn/);
  assert.match(rendered, /second turn/);
  assert.doesNotMatch(rendered, /old generation/);
});

test("screen-off, foreground loss, and removal stop the active capture and detach listeners", () => {
  const harness = makeLayer({ generations: [40] });
  harness.layer.handleInput({ type: "click" });
  harness.layer.onScreenChanged(false);
  assert.deepEqual(harness.stops, [40]);
  assert.equal(harness.layer.phase(), "ended");

  const removed = makeLayer({ generations: [41] });
  removed.layer.handleInput({ type: "click" });
  removed.layer.onRemoved();
  assert.deepEqual(removed.stops, [41]);
  const afterRemovalRenders = removed.renders;
  testBridge.emitTranscript({ generation: 41, text: "must not render", isFinal: true, receivedAtMs: 42 });
  assert.equal(removed.renders, afterRemovalRenders);

  const foreground = makeLayer({ generations: [43] });
  foreground.layer.handleInput({ type: "click" });
  foreground.layer.onForegroundChanged(false);
  assert.deepEqual(foreground.stops, [43]);
  assert.equal(foreground.layer.phase(), "ended");
});

test("terminal provider failure releases the exact capture and ends in an honest review", () => {
  const harness = makeLayer({ generations: [44] });
  harness.layer.handleInput({ type: "click" });
  testBridge.emitTranscript({ generation: 44, text: "known words", isFinal: false, receivedAtMs: 44 });
  testBridge.emitStatus({ generation: 44, status: "Provider unavailable", terminalError: true });

  assert.deepEqual(harness.stops, [44]);
  assert.equal(harness.layer.phase(), "ended");
  const rendered = textOperations(render(harness.layer)).join(" ");
  assert.match(rendered, /SESSION COMPLETE/);
  assert.match(rendered, /ERROR · Provider unavailable/);
});
