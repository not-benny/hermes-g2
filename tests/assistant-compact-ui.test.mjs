import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const moduleUrl = (source) => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const transpile = (source) => ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
}).outputText;
const withoutImports = (source) => source.replace(/import[\s\S]*?from\s+"[^"]+";\n/g, "");

const fontHarness = `
  const smallFont = { lineHeight: 12, measureText: (text) => Array.from(String(text)).length * 6 };
  const mediumFont = { lineHeight: 16, measureText: (text) => Array.from(String(text)).length * 8 };
  const getDefaultSmallFont = () => smallFont;
  const getDefaultMediumFont = () => mediumFont;
  const wrapText = (font, value, width) => {
    const columns = Math.max(1, Math.floor(width / 6));
    return String(value).replace(/\\r/g, "").split("\\n").flatMap((paragraph) => {
      if (!paragraph) return [""];
      const lines = [];
      for (let offset = 0; offset < paragraph.length; offset += columns) lines.push(paragraph.slice(offset, offset + columns));
      return lines;
    });
  };
  const truncateText = (font, value, width) => {
    const columns = Math.max(1, Math.floor(width / 6));
    const text = String(value);
    return text.length <= columns ? text : text.slice(0, Math.max(1, columns - 3)) + "...";
  };
`;

const cardHarness = `
  const ASSISTANT_CARD_WIDTH = 448;
  const ASSISTANT_STATUS_CARD_WIDTH = 320;
  const ASSISTANT_CAPTURE_CARD_HEIGHT = 112;
  const ASSISTANT_REVIEW_CARD_HEIGHT = 144;
  const ASSISTANT_STATUS_CARD_HEIGHT = 64;
  const ASSISTANT_ERROR_CARD_HEIGHT = 96;
  const assistantCardRect = (baseSize, preferredHeight, preferredWidth = ASSISTANT_CARD_WIDTH) => {
    const viewport = baseSize.width === 640 && baseSize.height === 480
      ? { x: 32, y: 56, width: 576, height: 232 }
      : { x: 0, y: 0, width: baseSize.width, height: baseSize.height };
    const width = Math.max(1, Math.min(preferredWidth, viewport.width - Math.min(32, viewport.width - 1)));
    const height = Math.max(1, Math.min(preferredHeight, viewport.height - Math.min(16, viewport.height - 1)));
    return { x: viewport.x + Math.floor((viewport.width - width) / 2),
      y: viewport.y + Math.floor((viewport.height - height) / 2), width, height };
  };
`;

function imageRecorder(width = 640, height = 480) {
  const commands = [];
  return {
    width, height, commands,
    fillRoundedRect: (x, y, width, height) => commands.push({ type: "panel", x, y, width, height }),
    drawRoundedRect: (x, y, width, height) => commands.push({ type: "border", x, y, width, height }),
    drawText: (_font, x, y, text) => commands.push({ type: "text", x, y, text }),
  };
}

function context(width = 640, height = 480) {
  return { stack: { getBaseSize: () => ({ width, height }) }, actions: {} };
}

async function loadGeometry() {
  const source = withoutImports(read("app/ui/shell/geometry.ts"));
  const harness = `
    const G2_LENS_WIDTH = 640;
    const G2_LENS_HEIGHT = 480;
    const dashboardSizeSetting = { get: () => "standard" };
    const verticalPositionSetting = { get: () => globalThis.__assistantVerticalPosition ?? "top" };
  `;
  return import(moduleUrl(transpile(`${harness}\n${source}`)));
}

async function loadAssistantLayer() {
  const source = withoutImports(read("app/ui/shell/assistant.ts"));
  const harness = `
    ${fontHarness}
    ${cardHarness}
    const GESTURE_CLICK = "·";
    const GESTURE_DOUBLE_CLICK = "··";
    const GESTURE_SCROLL = "▲▼";
    const gestureHints = (pairs) => pairs.map(([glyph, label]) => glyph + " " + label).join("   ");
    class GrayImage {}
  `;
  return import(moduleUrl(transpile(`${harness}\n${source}`)));
}

async function loadVoiceLayer() {
  const source = withoutImports(read("app/ui/shell/voice-input.ts"));
  const harness = `
    ${fontHarness}
    ${cardHarness}
    const GESTURE_CLICK = "·";
    const GESTURE_DOUBLE_CLICK = "··";
    const GESTURE_SCROLL = "▲▼";
    const gestureHints = (pairs) => pairs.map(([glyph, label]) => glyph + " " + label).join("   ");
    const anthropicApiKeySetting = { get: () => globalThis.__assistantTestAnthropicKey ?? "" };
    const refineDictation = (options) => { globalThis.__assistantRefineCalls = (globalThis.__assistantRefineCalls ?? 0) + 1;
      return { cancel() {} }; };
    const voiceControlBridge = {
      onTranscript: () => () => {}, onStatus: () => () => {}, onSpeechEnd: () => () => {},
      claimSubmit: () => true,
    };
    const applyTranscriptText = (state, event) => event.isFinal
      ? { finalizedText: event.text, liveText: "" }
      : { finalizedText: state.finalizedText, liveText: event.text };
    class EdgeWrapScroller {
      step(index, count, direction) { return { index: Math.max(0, Math.min(count - 1, index + direction)), atEdge: false }; }
      reset() {}
    }
    class EdgeBounce { offsetPx() { return 0; } trigger() {} }
    const drawSelectionHighlight = (image, x, y, width, height) => image.commands.push({ type: "selection", x, y, width, height });
    class GrayImage {}
  `;
  return import(moduleUrl(transpile(`${harness}\n${source}`)));
}

async function loadAlertLayer() {
  const shell = read("app/ui/shell/shell.ts");
  const start = shell.indexOf("const ALERT_DISMISS_MS");
  const end = shell.indexOf("class Shell {", start);
  const source = shell.slice(start, end).replace("class ShellAlertLayer", "export class ShellAlertLayer");
  const harness = `
    ${fontHarness}
    ${cardHarness}
    const GESTURE_CLICK = "·";
    const GESTURE_DOUBLE_CLICK = "··";
  `;
  return import(moduleUrl(transpile(`${harness}\n${source}`)));
}

test("compact card geometry stays inside every optical band and nested modal", async () => {
  const geometry = await loadGeometry();
  const expectedTops = { top: 0, upper: 48, center: 96, lower: 144, bottom: 192 };
  for (const [position, bandTop] of Object.entries(expectedTops)) {
    globalThis.__assistantVerticalPosition = position;
    assert.deepEqual(geometry.assistantCardViewport({ width: 640, height: 480 }), {
      x: 32, y: bandTop + 56, width: 576, height: 232,
    });
    assert.deepEqual(geometry.assistantCardRect({ width: 640, height: 480 }, 112), {
      x: 96, y: bandTop + 116, width: 448, height: 112,
    });
    const review = geometry.assistantCardRect({ width: 640, height: 480 }, 144);
    assert.deepEqual(review, { x: 96, y: bandTop + 100, width: 448, height: 144 });
    assert.ok(review.x >= 72 && review.y >= bandTop + 56);
    assert.ok(review.x + review.width <= 608 && review.y + review.height <= bandTop + 288);
  }
  globalThis.__assistantVerticalPosition = "bottom";
  assert.deepEqual(geometry.assistantCardViewport({ width: 532, height: 196 }), {
    x: 0, y: 0, width: 532, height: 196,
  });
  assert.deepEqual(geometry.assistantCardRect({ width: 532, height: 196 }, 112), {
    x: 42, y: 42, width: 448, height: 112,
  });
  assert.deepEqual(geometry.assistantCardRect({ width: 532, height: 196 }, 144), {
    x: 42, y: 26, width: 448, height: 144,
  });
});

test("assistant paints no partial or tool detail, then paginates only the completed result", async () => {
  const { AssistantLayer } = await loadAssistantLayer();
  let renders = 0;
  let followUps = 0;
  let closes = 0;
  const layer = new AssistantLayer({ requestRender: () => { renders++; } }, {
    onFollowUp: () => { followUps++; }, onCancel: () => {}, onClose: () => { closes++; },
  });
  layer.startTurn();
  layer.onTextDelta("private", "private reasoning draft");
  layer.onToolActivity("calendar.secret_tool");
  const workingImage = imageRecorder();
  layer.paint(context(), () => workingImage);
  assert.deepEqual(workingImage.commands, [],
    "even a stale paint of a running turn must be completely transparent");

  layer.onTurnDone("Result one\nResult two\nResult three\nResult four\nResult five\nResult six");
  const firstPage = imageRecorder();
  layer.paint(context(), () => firstPage);
  assert.deepEqual(firstPage.commands.find((command) => command.type === "panel"), {
    type: "panel", x: 96, y: 100, width: 448, height: 144,
  });
  const firstText = firstPage.commands.filter((command) => command.type === "text").map((command) => command.text);
  assert.ok(firstText.includes("1/2"));
  assert.ok(firstText.includes("Result one"));
  assert.ok(!firstText.includes("Result six"));
  assert.doesNotMatch(firstText.join("\n"), /private|calendar|secret|reason/i);

  layer.handleInput({ type: "scroll-down" }, context());
  const secondPage = imageRecorder();
  layer.paint(context(), () => secondPage);
  const secondText = secondPage.commands.filter((command) => command.type === "text").map((command) => command.text);
  assert.ok(secondText.includes("2/2"));
  assert.ok(secondText.includes("Result six"));
  assert.ok(secondText.some((text) => text.includes("· follow-up") && text.includes("·· dismiss")));
  layer.handleInput({ type: "click", source: "ring" }, context());
  layer.handleInput({ type: "double-click", source: "ring" }, context());
  assert.equal(followUps, 1);
  assert.equal(closes, 1);
  assert.ok(renders >= 3);
});

test("voice capture and review use compact shell and nested coordinates", async () => {
  const { VoiceInputLayer } = await loadVoiceLayer();
  const actions = {
    requestRender() {}, startVoiceCapture: () => 7, stopVoiceCapture() {},
  };
  const layer = new VoiceInputLayer({ actions, onClosed() {}, dismiss() {},
    sendTargets: [{ id: "assistant", label: "Send to Hermes", onSend() {} }], finishOnClick: true });
  layer.finalizedText = "one\ntwo\nthree\nfour";

  const shellCapture = imageRecorder();
  layer.paint(context(), () => shellCapture);
  assert.deepEqual(shellCapture.commands.find((command) => command.type === "panel"), {
    type: "panel", x: 96, y: 116, width: 448, height: 112,
  });
  const captureText = shellCapture.commands.filter((command) => command.type === "text").map((command) => command.text);
  assert.ok(captureText.some((value) => value.startsWith("... two")));
  assert.ok(!captureText.includes("one"));

  layer.phase = "menu";
  const shellReview = imageRecorder();
  layer.paint(context(), () => shellReview);
  assert.deepEqual(shellReview.commands.find((command) => command.type === "panel"), {
    type: "panel", x: 96, y: 100, width: 448, height: 144,
  });
  assert.equal(shellReview.commands.filter((command) => command.type === "selection").length, 1);
  const reviewText = shellReview.commands.filter((command) => command.type === "text").map((command) => command.text);
  assert.ok(reviewText.includes("Send to Hermes"));
  assert.ok(reviewText.includes("1/3"));
  assert.ok(!reviewText.includes("Continue"), "only the selected action is painted");

  layer.phase = "capturing";
  const nestedCapture = imageRecorder(532, 196);
  layer.paint(context(532, 196), () => nestedCapture);
  assert.deepEqual(nestedCapture.commands.find((command) => command.type === "panel"), {
    type: "panel", x: 42, y: 42, width: 448, height: 112,
  });
  layer.phase = "menu";
  const nestedReview = imageRecorder(532, 196);
  layer.paint(context(532, 196), () => nestedReview);
  assert.deepEqual(nestedReview.commands.find((command) => command.type === "panel"), {
    type: "panel", x: 42, y: 26, width: 448, height: 144,
  });
});

test("Continue appends a follow-up without an Anthropic key", async () => {
  globalThis.__assistantTestAnthropicKey = "";
  globalThis.__assistantRefineCalls = 0;
  const { VoiceInputLayer } = await loadVoiceLayer();
  const layer = new VoiceInputLayer({
    actions: { requestRender() {}, startVoiceCapture: () => 9, stopVoiceCapture() {} },
    onClosed() {}, dismiss() {},
    sendTargets: [{ id: "assistant", label: "Send", onSend() {} }],
  });
  layer.phase = "menu";
  layer.finalizedText = "Book Tuesday";
  layer.menuIndex = 1; // one send target, then Continue
  layer.handleInput({ type: "click", source: "ring" }, context());
  assert.equal(layer.phase, "continuing");
  layer.finalizedText = "and Wednesday";
  layer.liveText = "";
  layer.beginRefine();
  assert.equal(layer.phase, "menu");
  assert.equal(layer.finalizedText, "Book Tuesday and Wednesday");
  assert.equal(layer.status, "Added follow-up");
  assert.equal(globalThis.__assistantRefineCalls, 0);
});

test("short assistant alert uses the same compact optical card", async () => {
  const { ShellAlertLayer } = await loadAlertLayer();
  let dismisses = 0;
  const layer = new ShellAlertLayer("Timer set for ten minutes.", () => { dismisses++; });
  const image = imageRecorder();
  layer.paint(context(), () => image);
  assert.deepEqual(image.commands.find((command) => command.type === "panel"), {
    type: "panel", x: 96, y: 132, width: 448, height: 80,
  });
  const text = image.commands.filter((command) => command.type === "text").map((command) => command.text);
  assert.ok(text.includes("Hermes"));
  assert.ok(text.includes("Timer set for ten minutes."));
  layer.handleInput({ type: "click", source: "ring" }, context());
  assert.equal(dismisses, 1);
  layer.onRemoved();
});

test("completed assistant alerts offer one-click voice reply and double-click dismiss", async () => {
  const { ShellAlertLayer } = await loadAlertLayer();
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  let scheduled = 0;
  let cleared = 0;
  globalThis.setTimeout = (_callback, delay) => {
    scheduled++;
    assert.equal(delay, 6000);
    return { fakeTimer: scheduled };
  };
  globalThis.clearTimeout = () => { cleared++; };
  try {
    let dismissed = 0;
    let replies = 0;
    const replyCard = new ShellAlertLayer(
      "A completed result that must stay readable.",
      () => { dismissed++; },
      "until-dismiss-or-sleep",
      { onReply: () => { replies++; } },
    );
    assert.equal(scheduled, 0, "persistent results must rely only on the global screen timeout");
    const image = imageRecorder();
    replyCard.paint(context(), () => image);
    const footer = image.commands.filter((command) => command.type === "text").at(-1)?.text;
    assert.equal(footer, "· reply   ·· dismiss");
    replyCard.handleInput({ type: "click", source: "ring" }, context());
    assert.equal(replies, 1, "one click enters the reviewed voice reply path");
    assert.equal(dismissed, 0, "reply owns dismissal so unavailable voice can leave the card readable");
    replyCard.handleInput({ type: "double-click", source: "ring" }, context());
    assert.equal(dismissed, 1, "double-click dismisses the completed result");
    replyCard.onRemoved();
    assert.equal(scheduled, 0);
    assert.equal(cleared, 0, "persistent cards have no private timer to clear");

    let ordinaryDismissed = 0;
    let timerCallback = null;
    globalThis.setTimeout = (callback, delay) => {
      scheduled++;
      assert.equal(delay, 6000);
      timerCallback = callback;
      return { fakeTimer: scheduled };
    };
    const ordinaryAlert = new ShellAlertLayer("Transient notice.", () => { ordinaryDismissed++; });
    assert.equal(scheduled, 0, "a transient candidate must not expire before frame acknowledgement");
    ordinaryAlert.armTransientDismissTimer();
    ordinaryAlert.armTransientDismissTimer();
    assert.equal(scheduled, 1, "acknowledgement arms exactly one six-second expiry");
    timerCallback();
    assert.equal(ordinaryDismissed, 1);
    ordinaryAlert.onRemoved();
    assert.equal(cleared, 0, "an already-fired timer needs no teardown clear");

    const ordinaryDoubleClick = new ShellAlertLayer("Generic alert.", () => { ordinaryDismissed++; });
    ordinaryDoubleClick.handleInput({ type: "double-click", source: "ring" }, context());
    assert.equal(ordinaryDismissed, 2, "generic alert gesture semantics stay unchanged");
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});

test("short and direct completed replies enter the existing reviewed assistant voice path", () => {
  const shell = read("app/ui/shell/shell.ts");
  const helper = shell.slice(
    shell.indexOf("private startAssistantResultReply"),
    shell.indexOf("private setAssistantOnlyPresentation"),
  );
  assert.match(helper, /voiceControlEnabledSetting\.get\(\)/);
  assert.match(helper, /this\.isAssistantAvailable\(\)/);
  assert.match(helper,
    /dismissResult\(\)[\s\S]*this\.openVoiceDialog\(\{[\s\S]*finishOnClick: true,[\s\S]*defaultTarget: "assistant"/);
  assert.doesNotMatch(helper, /sendUtterance|onTextDelta|onToolActivity/,
    "the result gesture must reuse reviewed voice capture instead of bypassing it");

  const pending = shell.slice(
    shell.indexOf("private flushPendingAssistantResult"),
    shell.indexOf("private startAssistantFollowUp"),
  );
  assert.match(pending, /this\.showAlert\([\s\S]*"until-dismiss-or-sleep",[\s\S]*"assistant-reply"/);

  const direct = shell.slice(
    shell.indexOf("async notifyAssistantResult("),
    shell.indexOf("async showAlert("),
  );
  assert.match(direct, /onReply:\s*\(\)\s*=>\s*this\.startAssistantResultReply/);
});
