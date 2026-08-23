import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

async function loadTs(path) {
  const source = readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));
}

const captions = await loadTs("app/captions/caption-session.ts");
const settings = await loadTs("app/captions/caption-settings.ts");
const accumulator = await loadTs("app/captions/transcript-accumulator.ts");
const { CaptionSession, wrapCaptionText, bottomAnchoredLines } = captions;

async function loadSonioxClient() {
  const source = readFileSync(new URL("../app/native/soniox-stt.ts", import.meta.url), "utf8");
  const stub = "data:text/javascript;base64," + Buffer.from(
    "export const CLOUD_STT_SAMPLE_RATE=16000; export const toJavaBytes=(bytes)=>bytes;",
  ).toString("base64");
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText.replace('"./cloud-stt"', JSON.stringify(stub));
  return import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));
}

test("caption session replaces partials, finalizes once, and rejects stale generations", () => {
  const session = new CaptionSession({ maxSegments: 4, maxCodePoints: 100 });
  session.begin(7, 1_000);
  assert.equal(session.apply({ generation: 7, type: "transcript", text: "hello", isFinal: false, receivedAtMs: 1_100 }), true);
  assert.equal(session.apply({ generation: 7, type: "transcript", text: "hello world", isFinal: false, receivedAtMs: 1_200 }), true);
  assert.equal(session.snapshot().displaySource, "hello world");

  assert.equal(session.apply({ generation: 7, type: "transcript", text: "hello world", isFinal: true, receivedAtMs: 1_400 }), true);
  assert.equal(session.snapshot().displaySource, "hello world");
  assert.equal(session.snapshot().segments.length, 1);

  session.begin(8, 2_000);
  assert.equal(session.apply({ generation: 7, type: "transcript", text: "late secret", isFinal: true, receivedAtMs: 2_100 }), false);
  assert.equal(session.snapshot().displaySource, "hello world");
});

test("translation remains optional, lag is truthful, and speaker labels require provider evidence", () => {
  const session = new CaptionSession();
  session.begin(3, 1_000);
  session.apply({
    generation: 3,
    type: "transcript",
    text: "hola",
    isFinal: false,
    language: "es",
    confidence: 0.91,
    speaker: "speaker-1",
    speakerEvidence: false,
    translationText: "hello",
    translationIsFinal: false,
    targetLanguage: "en",
    receivedAtMs: 1_250,
  });
  let snapshot = session.snapshot(1_250);
  assert.equal(snapshot.displaySource, "hola");
  assert.equal(snapshot.displayTranslation, "hello");
  assert.equal(snapshot.translationLagMs, 0);
  assert.equal(snapshot.speakerLabel, null);

  session.apply({
    generation: 3,
    type: "transcript",
    text: "hola",
    isFinal: true,
    speaker: "speaker-1",
    speakerEvidence: true,
    translationText: "hello",
    translationIsFinal: true,
    targetLanguage: "en",
    receivedAtMs: 1_600,
  });
  snapshot = session.snapshot(1_600);
  assert.equal(snapshot.speakerLabel, "Speaker 1");
  assert.equal(snapshot.translationLagMs, 0);
  assert.equal(snapshot.translationPending, false);
});

test("pause, clear, bounds, and stale tokens cannot resurrect captions", () => {
  const session = new CaptionSession({ maxSegments: 2, maxCodePoints: 12 });
  session.begin(1, 0);
  session.apply({ generation: 1, type: "transcript", text: "one", isFinal: true, receivedAtMs: 1 });
  session.apply({ generation: 1, type: "transcript", text: "two", isFinal: true, receivedAtMs: 2 });
  session.apply({ generation: 1, type: "transcript", text: "three", isFinal: true, receivedAtMs: 3 });
  assert.deepEqual(session.snapshot().segments.map((entry) => entry.source), ["two", "three"]);

  session.pause(1);
  assert.equal(session.apply({ generation: 1, type: "transcript", text: "late", isFinal: true, receivedAtMs: 4 }), false);
  session.clear();
  assert.equal(session.snapshot().displaySource, "");
  assert.equal(session.snapshot().segments.length, 0);
});

test("translation lag is measured from the matching source revision and stale translation never hides source", () => {
  const session = new CaptionSession();
  session.begin(4, 0);
  session.apply({ generation: 4, type: "transcript", text: "bonjour", isFinal: false, receivedAtMs: 100 });
  assert.equal(session.snapshot(300).translationPending, true);
  assert.equal(session.snapshot(300).translationCurrent, false);
  assert.equal(session.snapshot(300).translationLagMs, 200);
  session.apply({
    generation: 4,
    type: "transcript",
    text: "",
    sourceRevisionPresent: false,
    translationText: "hello",
    translationRevisionPresent: true,
    translationIsFinal: false,
    isFinal: false,
    receivedAtMs: 450,
  });
  assert.equal(session.snapshot(450).translationLagMs, 350);
  assert.equal(session.snapshot(450).translationCurrent, true);
  session.apply({ generation: 4, type: "transcript", text: "bonjour monde", isFinal: false, receivedAtMs: 500 });
  assert.equal(session.snapshot(600).translationCurrent, false);
  assert.equal(session.snapshot(600).translationPending, true);
});

test("incremental final deltas keep long continuous streams moving and bounded", () => {
  const session = new CaptionSession({ maxSegments: 16, maxCodePoints: 256 });
  session.begin(5, 0);
  for (let index = 0; index < 300; index++) {
    session.apply({
      generation: 5,
      type: "transcript",
      text: "",
      sourceFinalDelta: `word${index}`,
      sourceRevisionPresent: true,
      isFinal: false,
      receivedAtMs: index + 1,
    });
  }
  const snapshot = session.snapshot();
  assert.match(snapshot.displaySource, /word299/);
  assert.ok(snapshot.segments.length <= 16);
  assert.ok(Array.from(snapshot.displaySource).length <= 256);
});

test("Soniox token fixtures preserve repeated speaker labels, split translation deltas, and bound queued PCM", async () => {
  class FakeListener {
    constructor(callbacks) { Object.assign(this, callbacks); }
  }
  class FakeSocket {
    static instances = [];
    binary = [];
    text = [];
    failText = false;
    constructor(_url, listener) { this.listener = listener; FakeSocket.instances.push(this); }
    sendText(value) { if (this.failText) throw new Error("synthetic"); this.text.push(value); }
    sendBinary(value) { this.binary.push(value); }
    close() {}
  }
  const previousCom = globalThis.com;
  globalThis.com = { faceclaw: { app: { FaceclawWebSocketListener: FakeListener, FaceclawWebSocket: FakeSocket } } };
  try {
    const { SonioxSttClient } = await loadSonioxClient();
    const events = [];
    const errors = [];
    const client = new SonioxSttClient({
      apiKey: "synthetic-not-a-secret",
      targetLanguage: "es",
      speakerLabels: true,
      onTranscript: (event) => events.push(event),
      onStatus: () => {},
      onError: (error) => errors.push(error),
    });
    client.start();
    for (let index = 0; index < 55; index++) client.acceptPcm(new Uint8Array([index]));
    const socket = FakeSocket.instances.at(-1);
    socket.listener.onOpen();
    assert.equal(socket.binary.length, 50);

    const partial = JSON.stringify({ tokens: [
      { text: "hel", is_final: false, speaker: "a", language: "en", translation_status: "original" },
      { text: "hol", is_final: false, speaker: "a", source_language: "en", translation_status: "translation" },
    ] });
    socket.listener.onTextMessage(partial);
    socket.listener.onTextMessage(partial);
    assert.equal(events[0].text, "Speaker 1: hel");
    assert.equal(events[1].text, "Speaker 1: hel");
    assert.equal(events[1].translationText, "Speaker 1: hol");
    assert.equal(events[1].droppedAudioFrames, 5);

    socket.listener.onTextMessage(JSON.stringify({ tokens: [
      { text: "hello ", is_final: true, speaker: "a", language: "en", translation_status: "original" },
      { text: "hola ", is_final: true, speaker: "a", source_language: "en", translation_status: "translation" },
    ] }));
    assert.equal(events.at(-1).sourceFinalDelta, "Speaker 1: hello ");
    assert.equal(events.at(-1).translationFinalDelta, "Speaker 1: hola ");
    assert.equal(events.at(-1).text, "");
    client.stop();

    const finishRetry = new SonioxSttClient({
      apiKey: "synthetic-not-a-secret",
      onTranscript: () => {},
      onStatus: () => {},
      onError: () => {},
    });
    finishRetry.start();
    const finishSocket = FakeSocket.instances.at(-1);
    finishSocket.listener.onOpen();
    finishSocket.failText = true;
    finishRetry.finish();
    await new Promise((resolve) => setTimeout(resolve, 550));
    const retrySocket = FakeSocket.instances.at(-1);
    retrySocket.listener.onOpen();
    assert.equal(retrySocket.text.at(-1), "");
    finishRetry.stop();

    const failedStatuses = [];
    const failedErrors = [];
    const failed = new SonioxSttClient({
      apiKey: "synthetic-not-a-secret",
      onTranscript: () => {},
      onStatus: (status) => failedStatuses.push(status),
      onError: (error) => failedErrors.push(error),
    });
    failed.start();
    const failedSocket = FakeSocket.instances.at(-1);
    failedSocket.failText = true;
    failedSocket.listener.onOpen();
    assert.equal(failedStatuses.some((status) => status.includes("Listening")), false);
    assert.equal(failedErrors.some((error) => error.includes("configuration send failed")), true);
    failed.stop();
    assert.equal(errors.length, 0);
  } finally {
    globalThis.com = previousCom;
  }
});

test("voice transcript accumulation preserves Soniox final deltas through stream finish", () => {
  let state = { finalizedText: "", liveText: "hel" };
  state = accumulator.applyTranscriptText(state, {
    text: "",
    isFinal: false,
    sourceFinalDelta: "hello ",
    sourceRevisionPresent: true,
  });
  assert.deepEqual(state, { finalizedText: "hello", liveText: "" });
  state = accumulator.applyTranscriptText(state, {
    text: "",
    isFinal: true,
    sourceRevisionPresent: false,
  });
  assert.deepEqual(state, { finalizedText: "hello", liveText: "" });
});

test("caption wrapping bounds long words without splitting grapheme clusters", () => {
  const measure = (value) => Array.from(value).length;
  assert.deepEqual(wrapCaptionText("abcdefgh", 3, measure), ["abc", "def", "gh"]);
  assert.deepEqual(wrapCaptionText("Cafe\u0301 noir", 5, measure), ["Cafe\u0301", "noir"]);
  assert.deepEqual(wrapCaptionText("a\n\nb", 3, measure), ["a", "", "b"]);
});

test("bottom anchoring and history offset keep the newest line stable", () => {
  assert.deepEqual(bottomAnchoredLines(["one"], 3, 0), ["", "", "one"]);
  assert.deepEqual(bottomAnchoredLines(["1", "2", "3", "4"], 3, 0), ["2", "3", "4"]);
  assert.deepEqual(bottomAnchoredLines(["1", "2", "3", "4"], 3, 1), ["1", "2", "3"]);
});

test("caption settings are bounded and disclose local versus cloud processing", () => {
  assert.equal(settings.normalizeCaptionLanguage("xx-private"), "auto");
  assert.equal(settings.normalizeCaptionTargetLanguage("xx-private"), "off");
  assert.equal(settings.normalizeCaptionVocabulary(" alpha, beta, alpha, \u0000gamma "), "alpha, beta, gamma");
  assert.equal(settings.normalizeCaptionVocabulary("x".repeat(200)).length, 64);
  assert.match(settings.captionProcessingDisclosure("onboard", "off"), /on phone/i);
  assert.match(settings.captionProcessingDisclosure("soniox", "en"), /audio.*Soniox.*translation/i);
  assert.equal(settings.captionProviderCapabilities("onboard").translation, false);
  assert.equal(settings.captionProviderCapabilities("soniox").speakerLabels, true);
  assert.equal(settings.effectiveCaptionProvider("soniox", { soniox: false }), "onboard");
  assert.equal(settings.effectiveCaptionProvider("soniox", { soniox: true }), "soniox");
});

test("caption integration exposes foreground and screen lifecycle hooks and removes implicit export", () => {
  const transcribe = readFileSync(new URL("../app/apps/transcribe/transcribe.ts", import.meta.url), "utf8");
  const app = readFileSync(new URL("../app/apps/transcribe/transcribe-app.ts", import.meta.url), "utf8");
  const windowHost = readFileSync(new URL("../app/ui/shell/in-process-window.ts", import.meta.url), "utf8");
  assert.doesNotMatch(transcribe, /writeTextToDownloads/);
  assert.match(app, /onForegroundChanged/);
  assert.match(app, /onScreenChanged/);
  assert.match(app, /onVoiceInputChanged/);
  assert.match(windowHost, /onForegroundChanged/);
  assert.match(windowHost, /onScreenChanged/);
  assert.match(windowHost, /onVoiceInputChanged/);
  assert.match(transcribe, /event\.generation !== this\.captureGeneration/);
});

test("phone settings are bounded, disclose cloud use, and keep vocabulary phone-only when unsupported", () => {
  const page = readFileSync(new URL("../app/phone-ui/caption-settings-page.xml", import.meta.url), "utf8");
  const model = readFileSync(new URL("../app/phone-ui/caption-settings-view-model.ts", import.meta.url), "utf8");
  const dashboard = readFileSync(new URL("../app/ui/dashboard-settings.ts", import.meta.url), "utf8");
  assert.match(page, /Privacy &amp; processing/);
  assert.match(page, /Speaker labels/);
  assert.match(model, /captionProviderCapabilities/);
  assert.match(model, /stays local and is not sent/);
  assert.match(dashboard, /captions\.sourceLanguage/);
  assert.match(dashboard, /captions\.targetLanguage/);
});

test("capture permission requests and provider callbacks are generation bound", () => {
  const controller = readFileSync(new URL("../app/g2/dashboard-controller.ts", import.meta.url), "utf8");
  const bridge = readFileSync(new URL("../app/native/voice-control.ts", import.meta.url), "utf8");
  const soniox = readFileSync(new URL("../app/native/soniox-stt.ts", import.meta.url), "utf8");
  const shell = readFileSync(new URL("../app/ui/shell/shell.ts", import.meta.url), "utf8");
  assert.match(controller, /voiceCaptureRequestEpoch/);
  assert.match(controller, /requestEpoch !== this\.voiceCaptureRequestEpoch\[kind\]/);
  assert.doesNotMatch(controller, /restartContinuousCaptureAfterSettingsChange\(\): void \{[\s\S]*this\.stopContinuousVoiceCapture\(\);[\s\S]*this\.startContinuousVoiceCapture\(\);/);
  assert.match(controller, /Caption settings will apply to the next capture session/);
  assert.match(bridge, /generation !== this\.activeGeneration/);
  const transcribe = readFileSync(new URL("../app/apps/transcribe/transcribe.ts", import.meta.url), "utf8");
  assert.match(transcribe, /private captureGeneration: number \| null = null/);
  assert.match(transcribe, /event\.generation !== this\.captureGeneration/);
  assert.match(transcribe, /state\.generation !== this\.captureGeneration/);
  assert.doesNotMatch(transcribe, /event\.generation > currentGeneration/);
  assert.match(bridge, /startContinuousCapture\(options: PushToTalkOptions\): number \| null/);
  assert.match(bridge, /this\.cloudClient !== exactClient/);
  assert.match(bridge, /Voice capture busy; stop the active capture first/);
  assert.doesNotMatch(bridge, /still finish a dangling cloud commit/);
  assert.match(soniox, /translation_status === "translation"/);
  assert.match(soniox, /enable_speaker_diarization/);
  assert.ok((shell.match(/setVoiceInputActive\?\.\(true\)/g) ?? []).length >= 2);
  for (const provider of ["deepgram-stt.ts", "elevenlabs-stt.ts", "openai-stt.ts", "soniox-stt.ts"]) {
    const source = readFileSync(new URL(`../app/native/${provider}`, import.meta.url), "utf8");
    assert.match(source, /MAX_PENDING_PCM_CHUNKS/);
    assert.match(source, /pending(?:Pcm|Chunks)\.length = 0/);
  }
});
