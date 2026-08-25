import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const voiceInputSource = readFileSync(
  new URL("../app/ui/shell/voice-input.ts", import.meta.url),
  "utf8",
);
const source = voiceInputSource.replace(/import[\s\S]*?from\s+"[^"]+";\n/g, "");
const shellSource = readFileSync(new URL("../app/ui/shell/shell.ts", import.meta.url), "utf8");

const harnessSource = `
  const transcriptListeners = new Set();
  const statusListeners = new Set();
  const speechEndListeners = new Set();
  const voiceHarness = {
    claims: [],
    claimed: false,
    allowClaim: true,
    emitTranscript(event) {
      for (const listener of Array.from(transcriptListeners)) listener(event);
    },
    emitStatus(event) {
      for (const listener of Array.from(statusListeners)) listener(event);
    },
    emitSpeechEnd(generation) {
      for (const listener of Array.from(speechEndListeners)) listener(generation);
    },
  };
  globalThis.__voiceAutoSendHarness = voiceHarness;
  const voiceControlBridge = {
    onTranscript(listener) { transcriptListeners.add(listener); return () => transcriptListeners.delete(listener); },
    onStatus(listener) { statusListeners.add(listener); return () => statusListeners.delete(listener); },
    onSpeechEnd(listener) { speechEndListeners.add(listener); return () => speechEndListeners.delete(listener); },
    claimSubmit(generation) {
      voiceHarness.claims.push(generation);
      if (!voiceHarness.allowClaim || voiceHarness.claimed) return false;
      voiceHarness.claimed = true;
      return true;
    },
  };
  const applyTranscriptText = (state, event) => event.isFinal
    ? { finalizedText: event.text, liveText: "" }
    : { finalizedText: state.finalizedText, liveText: event.text };
  const anthropicApiKeySetting = { get: () => "" };
  const refineDictation = () => ({ cancel() {} });
  class EdgeWrapScroller { step(index) { return { index, atEdge: false }; } reset() {} }
  class EdgeBounce { offsetPx() { return 0; } trigger() {} }
  const getDefaultSmallFont = () => ({ measureText: () => 0 });
  const getDefaultMediumFont = getDefaultSmallFont;
  const wrapText = (_font, text) => [String(text)];
  const truncateText = (_font, text) => String(text);
  const drawSelectionHighlight = () => {};
  const gestureHints = () => "";
  const GESTURE_CLICK = "click";
  const GESTURE_DOUBLE_CLICK = "back";
  const GESTURE_SCROLL = "scroll";
  const ASSISTANT_CAPTURE_CARD_HEIGHT = 112;
  const ASSISTANT_REVIEW_CARD_HEIGHT = 144;
  const ASSISTANT_STATUS_CARD_HEIGHT = 64;
  const ASSISTANT_STATUS_CARD_WIDTH = 320;
  const assistantCardRect = () => ({ x: 0, y: 0, width: 448, height: 112 });
`;

const js = ts.transpileModule(`${harnessSource}\n${source}`, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
}).outputText;
const { VoiceInputLayer } = await import(
  `data:text/javascript;base64,${Buffer.from(js).toString("base64")}`
);

const voiceHarness = globalThis.__voiceAutoSendHarness;

function resetHarness() {
  voiceHarness.claims.length = 0;
  voiceHarness.claimed = false;
  voiceHarness.allowClaim = true;
}

function createSubject({ generation, autoSend, stopHook } = {}) {
  resetHarness();
  const stops = [];
  const sends = [];
  let dismisses = 0;
  let closes = 0;
  const actions = {
    requestRender() {},
    startVoiceCapture: () => generation,
    stopVoiceCapture: (exactGeneration, commit) => {
      stops.push([exactGeneration, commit]);
      stopHook?.(exactGeneration, commit);
    },
  };
  const layer = new VoiceInputLayer({
    actions,
    onClosed: () => { closes++; },
    dismiss: () => { dismisses++; },
    sendTargets: [
      { id: "app", label: "Type Into App", onSend: (text) => sends.push(["app", text]) },
      { id: "assistant", label: "Send to Assistant", onSend: (text) => sends.push(["assistant", text]) },
    ],
    defaultTargetIndex: 1,
    autoSend,
  });
  return {
    layer,
    stops,
    sends,
    dismisses: () => dismisses,
    closes: () => closes,
  };
}

test("the setting follows every assistant destination while app dictation still reviews", () => {
  const dialogStart = shellSource.indexOf("private openVoiceDialog(options:");
  const dialogEnd = shellSource.indexOf("private buildVoiceSendTargets", dialogStart);
  const dialog = shellSource.slice(dialogStart, dialogEnd);
  assert.match(dialog, /options\.defaultTarget === "assistant"/);
  assert.match(dialog, /targets\[defaultIndex\]\?\.id === "assistant"/);
  assert.match(dialog, /assistantSkipConfirmationSetting\.get\(\)/);
  assert.doesNotMatch(dialog, /Boolean\(options\.(?:handsFree|autoSend)/);

  const sleepingLongPress = shellSource.slice(
    shellSource.indexOf("A sleeping long-press is push-to-talk"),
    shellSource.indexOf("if (!this.screenOn)", shellSource.indexOf("A sleeping long-press is push-to-talk")),
  );
  assert.match(sleepingLongPress,
    /openVoiceDialog\(\{ defaultTarget: "assistant", returnToSleepOnClose: true \}\)/);
  assert.match(shellSource, /autoSend: assistantSkipConfirmationSetting\.get\(\)/,
    "assistant follow-ups must honor the same opt-in even when manually opened");
  assert.match(shellSource, /openVoiceDialog\(\{ finishOnClick: true, defaultTarget: "app" \}\)/,
    "window dictation must retain its reviewed app target");
});

test("assistant auto-send arms before exact-generation stop and accepts a synchronous final once", () => {
  let subject;
  subject = createSubject({
    generation: 41,
    autoSend: true,
    stopHook: (generation, commit) => {
      if (commit) voiceHarness.emitTranscript({
        generation,
        text: "email Simon about the merger permissions",
        isFinal: true,
      });
    },
  });

  subject.layer.startCapture();
  subject.layer.endCapture();

  assert.deepEqual(subject.stops, [[41, true]]);
  assert.deepEqual(voiceHarness.claims, [41]);
  assert.deepEqual(subject.sends, [["assistant", "email Simon about the merger permissions"]]);
  assert.equal(subject.dismisses(), 1);

  // Duplicate and stale callbacks cannot submit the turn again.
  voiceHarness.emitTranscript({ generation: 41, text: "duplicate", isFinal: true });
  voiceHarness.emitTranscript({ generation: 40, text: "stale", isFinal: true });
  assert.deepEqual(voiceHarness.claims, [41]);
  assert.equal(subject.sends.length, 1);
  subject.layer.onRemoved();
  assert.deepEqual(subject.stops, [[41, true], [41, false]]);
  assert.equal(subject.closes(), 1);
});

test("assistant auto-send waits for the trailing final and cancellation revokes it", () => {
  const subject = createSubject({ generation: 73, autoSend: true });
  subject.layer.startCapture();
  voiceHarness.emitTranscript({ generation: 73, text: "partial words", isFinal: false });
  subject.layer.endCapture();

  assert.deepEqual(subject.sends, []);
  assert.deepEqual(voiceHarness.claims, []);
  subject.layer.handleInput({ type: "double-click", source: "ring" }, {});
  assert.equal(subject.dismisses(), 1);
  subject.layer.onRemoved();
  voiceHarness.emitTranscript({ generation: 73, text: "late final", isFinal: true });

  assert.deepEqual(subject.stops, [[73, true], [73, false]]);
  assert.deepEqual(voiceHarness.claims, []);
  assert.deepEqual(subject.sends, []);
});

test("confirmation disabled preserves review and submits only after explicit selection", () => {
  const subject = createSubject({ generation: 99, autoSend: false });
  subject.layer.startCapture();
  subject.layer.endCapture();
  voiceHarness.emitTranscript({
    generation: 99,
    text: "review this before sending",
    isFinal: true,
  });

  assert.equal(subject.layer.phase, "menu");
  assert.equal(subject.layer.pendingAutoSend, false);
  assert.deepEqual(subject.sends, []);
  assert.deepEqual(voiceHarness.claims, []);

  // The default row is the assistant target and still requires a click.
  subject.layer.handleInput({ type: "click", source: "ring" }, {});
  assert.deepEqual(voiceHarness.claims, [99]);
  assert.deepEqual(subject.sends, [["assistant", "review this before sending"]]);
  assert.equal(subject.dismisses(), 1);
  subject.layer.onRemoved();
});

test("a rejected generation claim never sends and safely returns to review", () => {
  const subject = createSubject({ generation: 121, autoSend: true });
  voiceHarness.allowClaim = false;
  subject.layer.startCapture();
  subject.layer.endCapture();
  voiceHarness.emitTranscript({ generation: 121, text: "must not send", isFinal: true });

  assert.deepEqual(voiceHarness.claims, [121]);
  assert.deepEqual(subject.sends, []);
  assert.equal(subject.dismisses(), 0);
  assert.equal(subject.layer.pendingAutoSend, false);
  assert.equal(subject.layer.status, "Send, continue, or discard?");
  subject.layer.onRemoved();
});
