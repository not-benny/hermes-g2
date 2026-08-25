import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const read = (path) =>
  readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

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
  const layer = read("app/apps/conversate/conversate.ts").replace(
    /^import[\s\S]*?from "[^"]+";\s*/gm,
    "",
  );
  const harness = `
let timerNowMs = 0;
let nextTimerId = 1;
const timers = new Map();
const scheduleTimer = (callback, delay, interval) => {
  const id = nextTimerId++;
  const boundedDelay = Math.max(1, Number(delay) || 0);
  timers.set(id, { callback, dueAtMs: timerNowMs + boundedDelay, interval: interval ? boundedDelay : null });
  return id;
};
const setTimeout = (callback, delay) => scheduleTimer(callback, delay, false);
const clearTimeout = (id) => { timers.delete(id); };
const setInterval = (callback, delay) => scheduleTimer(callback, delay, true);
const clearInterval = (id) => { timers.delete(id); };
const testClock = {
  advance(durationMs) {
    const target = timerNowMs + durationMs;
    for (;;) {
      const due = [...timers.entries()]
        .filter(([, timer]) => timer.dueAtMs <= target)
        .sort((left, right) => left[1].dueAtMs - right[1].dueAtMs || left[0] - right[0])[0];
      if (!due) break;
      const [id, timer] = due;
      timerNowMs = timer.dueAtMs;
      if (timer.interval === null) timers.delete(id);
      else timer.dueAtMs += timer.interval;
      timer.callback();
    }
    timerNowMs = target;
  },
  reset() { timerNowMs = 0; nextTimerId = 1; timers.clear(); },
};
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
const GLASS_RADIUS = { selection: 6, control: 8, card: 12 };
const GLASS_TONE = { opaqueBlack: 1, selectedFill: 16, track: 48, divider: 64,
  border: 96, hint: 112, muted: 144, secondary: 176, body: 208, primary: 224, focus: 255 };
const drawGlassPanel = (image, x, y, width, height, options = {}) => {
  image.fillRoundedRect(x, y, width, height, options.fill ?? 1, options.radius ?? 12);
  image.drawRoundedRect(x, y, width, height, options.border ?? 96, options.radius ?? 12);
};
const captionFontSizeSetting = { get: () => "small" };
let hermesCuesEnabled = false;
const conversateHermesCuesSetting = { get: () => hermesCuesEnabled };
const settingListeners = new Set();
const onAnySettingChanged = (listener) => { settingListeners.add(listener); return () => settingListeners.delete(listener); };
const hermesCueCalls = [];
const assistantBridge = {
  requestConversateCues(request) {
    let resolve;
    let reject;
    let settled = false;
    const result = new Promise((yes, no) => { resolve = yes; reject = no; });
    const call = {
      request,
      result,
      cancelled: false,
      resolve(value) { if (!settled) { settled = true; resolve(value); } },
      reject(error = new Error("failed")) { if (!settled) { settled = true; reject(error); } },
      cancel(reason) {
        this.cancelled = true;
        if (!settled) { settled = true; reject(new Error(reason)); }
      },
    };
    hermesCueCalls.push(call);
    return call;
  },
};
const testHermes = {
  calls: hermesCueCalls,
  enable(value) { hermesCuesEnabled = value; for (const listener of settingListeners) listener(); },
  reset() { hermesCuesEnabled = false; hermesCueCalls.splice(0); },
};
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
  fillRoundedRect(x, y, width, height, color, radius) { this.operations.push({ type: "rect", x, y, width, height, radius, color }); }
}
${session}
${layer}
export { ConversateLayer, testBridge, testClock, testHermes };
`;
  const js = ts.transpileModule(harness, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  return import(
    "data:text/javascript;base64," + Buffer.from(js).toString("base64")
  );
}

const { ConversateLayer, testBridge, testClock, testHermes } =
  await loadConversateLayer();
const activeLayers = new Set();

test.afterEach(() => {
  for (const layer of activeLayers) layer.onRemoved();
  activeLayers.clear();
  testHermes.reset();
  testClock.reset();
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
  layer.start(() => {
    renders++;
  });
  layer.onForegroundChanged(true);
  layer.onScreenChanged(true);
  activeLayers.add(layer);
  return {
    layer,
    starts,
    stops,
    resolveFinish: () => finishResolvers.shift()?.(),
    get renders() {
      return renders;
    },
  };
}

function render(layer) {
  return layer.paint({
    stack: { getBaseSize: () => ({ width: 536, height: 232 }) },
  });
}

function textOperations(image) {
  return image.operations
    .filter((operation) => operation.type === "text")
    .map((operation) => operation.text);
}

function assertInBounds(image) {
  for (const operation of image.operations) {
    if (operation.type === "text") {
      assert.ok(
        operation.x >= 0 && operation.x < image.width,
        `text x out of bounds: ${operation.x}`,
      );
      assert.ok(
        operation.y >= 0 && operation.y < image.height,
        `text y out of bounds: ${operation.y}`,
      );
    } else if (operation.type === "line") {
      assert.ok(
        operation.x1 >= 0 && operation.x2 <= image.width,
        "line x out of bounds",
      );
      assert.ok(
        operation.y1 >= 0 && operation.y2 <= image.height,
        "line y out of bounds",
      );
    } else if (operation.type === "rect") {
      assert.ok(
        operation.x >= 0 && operation.x + operation.width <= image.width,
        "rect x out of bounds",
      );
      assert.ok(
        operation.y >= 0 && operation.y + operation.height <= image.height,
        "rect y out of bounds",
      );
    }
  }
}

test("Conversate does not auto-capture, then starts with its independent on-device provider", () => {
  const harness = makeLayer({ generations: [11] });
  assert.deepEqual(
    harness.starts,
    [],
    "opening the layer must not open the microphone",
  );
  harness.layer.handleInput({ type: "click" });
  assert.deepEqual(harness.starts, [{ generation: 11, provider: "onboard" }]);
  assert.equal(harness.layer.phase(), "active");
});

test("partial transcript creates a local cue, click opens detail, and the compact HUD stays bounded", () => {
  const harness = makeLayer({ generations: [12] });
  harness.layer.handleInput({ type: "click" });
  testBridge.emitTranscript({
    generation: 12,
    text: "Need to email Simon",
    isFinal: false,
    receivedAtMs: 10,
  });

  const live = render(harness.layer);
  assert.ok(
    textOperations(live).some((text) => text.includes("Need to email Simon")),
  );
  assertInBounds(live);

  harness.layer.handleInput({ type: "click" });
  const cue = render(harness.layer);
  assert.ok(textOperations(cue).some((text) => text.includes("LOCAL CUE")));
  assert.ok(
    textOperations(cue).some((text) => text.includes("Need to email Simon")),
  );
  assertInBounds(cue);

  harness.layer.handleInput({ type: "click" });
  assert.ok(
    textOperations(render(harness.layer)).some((text) =>
      text.includes("TRANSCRIPT"),
    ),
  );
});

test("continuous on-device partial text reaches Hermes after the bounded debounce", () => {
  testHermes.enable(true);
  const harness = makeLayer({ generations: [13] });
  harness.layer.handleInput({ type: "click" });
  testBridge.emitTranscript({
    generation: 13,
    text: "We are planning the launch",
    isFinal: false,
    receivedAtMs: 10,
  });
  testClock.advance(499);
  assert.equal(testHermes.calls.length, 0);
  testClock.advance(1);
  assert.equal(testHermes.calls.length, 1);
  assert.equal(
    testHermes.calls[0].request.transcript,
    "We are planning the launch",
  );
});

test("partial revisions coalesce, have a bounded max wait, and cancel stale active work", async () => {
  testHermes.enable(true);
  const harness = makeLayer({ generations: [14] });
  harness.layer.handleInput({ type: "click" });
  testBridge.emitTranscript({
    generation: 14,
    text: "We should plan the launch",
    isFinal: false,
    receivedAtMs: 10,
  });
  testClock.advance(400);
  testBridge.emitTranscript({
    generation: 14,
    text: "We should plan the Friday launch",
    isFinal: false,
    receivedAtMs: 11,
  });
  testClock.advance(400);
  testBridge.emitTranscript({
    generation: 14,
    text: "We should plan the Friday launch carefully",
    isFinal: false,
    receivedAtMs: 12,
  });
  testClock.advance(199);
  assert.equal(
    testHermes.calls.length,
    0,
    "rapid decoder revisions stay coalesced",
  );
  testClock.advance(1);
  assert.equal(
    testHermes.calls.length,
    1,
    "max wait prevents continuous partials from starving the lane",
  );
  assert.equal(
    testHermes.calls[0].request.transcript,
    "We should plan the Friday launch carefully",
  );

  const stale = testHermes.calls[0];
  testBridge.emitTranscript({
    generation: 14,
    text: "We should plan the Friday launch carefully with Sam",
    isFinal: false,
    receivedAtMs: 13,
  });
  testClock.advance(499);
  assert.equal(
    stale.cancelled,
    false,
    "debounce leaves the one active call time for cooperative cleanup",
  );
  assert.equal(
    testHermes.calls.length,
    1,
    "partial requests cannot exceed the debounce rate",
  );
  testClock.advance(1);
  assert.equal(
    stale.cancelled,
    true,
    "dispatching the newest revision retires stale active work",
  );
  assert.equal(testHermes.calls.length, 2);

  const current = testHermes.calls[1];
  current.resolve({
    sessionId: current.request.sessionId,
    revision: current.request.revision,
    cues: [{ kind: "question", text: "What should Sam prepare for Friday?" }],
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.match(
    textOperations(render(harness.layer)).join(" "),
    /HERMES QUESTION/,
  );
  assert.doesNotMatch(
    textOperations(render(harness.layer)).join(" "),
    /Working/,
  );
});

test("provider finals bypass a pending partial debounce and remain latest-wins", async () => {
  testHermes.enable(true);
  const harness = makeLayer({ generations: [15] });
  harness.layer.handleInput({ type: "click" });
  testBridge.emitTranscript({
    generation: 15,
    text: "We are planning the launch",
    isFinal: false,
    receivedAtMs: 10,
  });
  testClock.advance(100);

  testBridge.emitTranscript({
    generation: 15,
    text: "We are planning the Friday launch",
    isFinal: true,
    receivedAtMs: 11,
  });
  assert.equal(testHermes.calls.length, 1);
  assert.equal(
    testHermes.calls[0].request.transcript,
    "We are planning the Friday launch",
  );
  testClock.advance(1_000);
  assert.equal(
    testHermes.calls.length,
    1,
    "the retired partial timer cannot duplicate the final flush",
  );

  testBridge.emitTranscript({
    generation: 15,
    text: "Sam will prepare the demo",
    isFinal: true,
    receivedAtMs: 12,
  });
  assert.equal(testHermes.calls[0].cancelled, true);
  assert.equal(testHermes.calls.length, 2);

  const current = testHermes.calls[1];
  current.resolve({
    sessionId: current.request.sessionId,
    revision: current.request.revision,
    cues: [
      { kind: "question", text: "What should Sam prepare before Friday?" },
    ],
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.match(
    textOperations(render(harness.layer)).join(" "),
    /HERMES QUESTION/,
  );
  harness.layer.handleInput({ type: "click" });
  const rendered = textOperations(render(harness.layer)).join(" ");
  assert.match(rendered, /HERMES CUE/);
  assert.match(rendered, /What should Sam prepare before Friday/);
  assert.doesNotMatch(rendered, /Working/);
});

test("pause and end hold partial timers, then flush the exact finalized conversation", async () => {
  testHermes.enable(true);
  const harness = makeLayer({ generations: [17, 18], deferFinish: true });
  harness.layer.handleInput({ type: "click" });
  testBridge.emitTranscript({
    generation: 17,
    text: "First capture needs a follow up",
    isFinal: false,
    receivedAtMs: 10,
  });
  testClock.advance(250);
  harness.layer.togglePaused();
  testClock.advance(2_000);
  assert.equal(
    testHermes.calls.length,
    0,
    "pause waits for the provider-owned final boundary",
  );

  harness.resolveFinish();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(harness.layer.phase(), "paused");
  assert.equal(testHermes.calls.length, 1);
  assert.equal(
    testHermes.calls[0].request.transcript,
    "First capture needs a follow up",
  );

  harness.layer.togglePaused();
  testBridge.emitTranscript({
    generation: 18,
    text: "Second capture will finish now",
    isFinal: false,
    receivedAtMs: 20,
  });
  assert.equal(
    testHermes.calls[0].cancelled,
    false,
    "resume text first coalesces behind the debounce",
  );
  testClock.advance(250);
  assert.equal(harness.layer.handleDoubleClick(), true);
  testClock.advance(2_000);
  assert.equal(
    testHermes.calls.length,
    1,
    "end also holds its pending partial timer",
  );

  harness.resolveFinish();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(harness.layer.phase(), "ended");
  assert.equal(testHermes.calls.length, 2);
  assert.equal(
    testHermes.calls[0].cancelled,
    true,
    "the end flush retires the stale paused revision",
  );
  assert.equal(
    testHermes.calls[1].request.transcript,
    "First capture needs a follow up Second capture will finish now",
  );
});

test("turning Hermes cues off cancels in-flight text and immediately restores local cues", () => {
  testHermes.enable(true);
  const harness = makeLayer({ generations: [16] });
  harness.layer.handleInput({ type: "click" });
  testBridge.emitTranscript({
    generation: 16,
    text: "Need to send the summary",
    isFinal: true,
    receivedAtMs: 14,
  });
  const call = testHermes.calls[0];
  testHermes.enable(false);
  assert.equal(call.cancelled, true);
  const live = textOperations(render(harness.layer)).join(" ");
  assert.match(live, /LOCAL ACTION/);
  assert.doesNotMatch(live, /TEXT→HERMES/);
});

test("double-click ends the exact capture and stale events cannot resurrect the session", async () => {
  const harness = makeLayer({ generations: [20] });
  harness.layer.handleInput({ type: "click" });
  testBridge.emitTranscript({
    generation: 20,
    text: "first turn",
    isFinal: true,
    receivedAtMs: 20,
  });
  assert.equal(harness.layer.handleDoubleClick(), true);
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(harness.stops, [20]);
  assert.equal(harness.layer.phase(), "ended");
  testBridge.emitTranscript({
    generation: 20,
    text: "stale after end",
    isFinal: true,
    receivedAtMs: 21,
  });
  assert.equal(
    textOperations(render(harness.layer)).some((text) =>
      text.includes("stale after end"),
    ),
    false,
  );
});

test("end remains generation-owned while the provider flushes its final transcript", async () => {
  const harness = makeLayer({ generations: [21], deferFinish: true });
  harness.layer.handleInput({ type: "click" });
  testBridge.emitTranscript({
    generation: 21,
    text: "closing",
    isFinal: false,
    receivedAtMs: 20,
  });
  assert.equal(harness.layer.handleDoubleClick(), true);
  assert.equal(
    harness.layer.phase(),
    "active",
    "review must wait for the provider's final callback",
  );

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
  assert.match(
    textOperations(render(harness.layer)).join(" "),
    /closing phrase confirmed/,
  );
});

test("pause and resume use a new capture generation while preserving the conversation", async () => {
  const harness = makeLayer({ generations: [30, 31] });
  harness.layer.handleInput({ type: "click" });
  testBridge.emitTranscript({
    generation: 30,
    text: "first turn",
    isFinal: true,
    receivedAtMs: 30,
  });
  harness.layer.togglePaused();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(harness.layer.phase(), "paused");
  assert.deepEqual(harness.stops, [30]);
  testBridge.emitTranscript({
    generation: 30,
    text: "old generation",
    isFinal: true,
    receivedAtMs: 31,
  });

  harness.layer.togglePaused();
  assert.deepEqual(harness.starts, [
    { generation: 30, provider: "onboard" },
    { generation: 31, provider: "onboard" },
  ]);
  testBridge.emitTranscript({
    generation: 31,
    text: "second turn",
    isFinal: true,
    receivedAtMs: 32,
  });
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
  testBridge.emitTranscript({
    generation: 41,
    text: "must not render",
    isFinal: true,
    receivedAtMs: 42,
  });
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
  testBridge.emitTranscript({
    generation: 44,
    text: "known words",
    isFinal: false,
    receivedAtMs: 44,
  });
  testBridge.emitStatus({
    generation: 44,
    status: "Provider unavailable",
    terminalError: true,
  });

  assert.deepEqual(harness.stops, [44]);
  assert.equal(harness.layer.phase(), "ended");
  const rendered = textOperations(render(harness.layer)).join(" ");
  assert.match(rendered, /SESSION COMPLETE/);
  assert.match(rendered, /ERROR · Provider unavailable/);
});
