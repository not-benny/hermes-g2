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

const { ConversationSession } = await loadTs("app/apps/conversate/conversation-session.ts");

test("partial text replaces, stale generations fail closed, and final delta is not duplicated", () => {
  const session = new ConversationSession();
  assert.equal(session.begin(7, 1_000), true);
  assert.equal(session.apply({ generation: 6, text: "stale", isFinal: true }), false);
  assert.equal(session.apply({ generation: 7, text: "hello", isFinal: false }), true);
  assert.equal(session.apply({ generation: 7, text: "hello world", isFinal: false }), true);
  assert.equal(session.snapshot().liveText, "hello world");
  assert.equal(session.apply({ generation: 7, text: "hello world", sourceFinalDelta: "hello world", isFinal: true }), true);
  const snapshot = session.snapshot();
  assert.equal(snapshot.transcript, "hello world");
  assert.equal(snapshot.liveText, "");
  assert.equal(snapshot.utteranceCount, 1);
});

test("speaker labels require evidence and bounds retain only recent source scalars", () => {
  const session = new ConversationSession({ maxUtterances: 2, maxScalars: 10 });
  session.begin(1, 0);
  session.apply({ generation: 1, text: "one", isFinal: true, speaker: "Alice", speakerEvidence: false });
  session.apply({ generation: 1, text: "two", isFinal: true, speaker: "Alice", speakerEvidence: true });
  session.apply({ generation: 1, text: "three", isFinal: true, speaker: "Bob", speakerEvidence: true });
  const snapshot = session.snapshot();
  assert.deepEqual(snapshot.utterances.map((entry) => entry.text), ["two", "three"]);
  assert.equal(snapshot.utterances[0].speaker?.label, "Alice");
  assert.equal(snapshot.utterances[1].speaker?.label, "Bob");
  assert.equal(snapshot.utterances.some((entry) => entry.speaker?.label === "Speaker 1"), false);
  assert.ok(Array.from(snapshot.transcript).length <= 10);
});

test("cues use transparent local classification and deduplicate normalized text", () => {
  const session = new ConversationSession();
  session.begin(4, 10);
  session.apply({ generation: 4, text: "Need to send the email", isFinal: true });
  session.apply({ generation: 4, text: "need to   send the email", isFinal: true });
  session.apply({ generation: 4, text: "What time is it?", isFinal: true });
  let cues = session.snapshot().cues;
  assert.deepEqual(cues.map((cue) => cue.kind), ["question", "action"]);
  assert.equal(cues.filter((cue) => cue.kind === "action").length, 1);

  const topic = new ConversationSession();
  topic.begin(5, 0);
  topic.apply({ generation: 5, text: "The launch is next Tuesday.", isFinal: true });
  assert.deepEqual(topic.snapshot().cues, [{ kind: "topic", text: "The launch is next Tuesday." }]);
});

test("long on-device replacements keep recent sentence cues and streamed finals remain visible", () => {
  const session = new ConversationSession();
  session.begin(9, 0);
  session.apply({
    generation: 9,
    text: "The introduction is complete. We need to email Simon. What time is the review?",
    isFinal: false,
  });
  assert.deepEqual(session.snapshot().cues.map((cue) => cue.kind), ["question", "action"]);

  session.apply({ generation: 9, text: "", sourceFinalDelta: "Send the deck. ", isFinal: false });
  assert.match(session.snapshot().liveText, /Send the deck/);
  session.apply({ generation: 9, text: "then confirm receipt", isFinal: true });
  assert.match(session.snapshot().transcript, /Send the deck.*confirm receipt/);
});

test("pause, resume, end, and clear require exact generation", () => {
  const session = new ConversationSession();
  session.begin(8, 100);
  assert.equal(session.pause(7), false);
  assert.equal(session.pause(8), true);
  assert.equal(session.apply({ generation: 8, text: "late", isFinal: true }), false);
  assert.equal(session.resume(7), false);
  assert.equal(session.resume(8), true);
  assert.equal(session.end(7), false);
  assert.equal(session.end(8), true);
  assert.equal(session.apply({ generation: 8, text: "late again", isFinal: true }), false);
  assert.equal(session.end(8), false);
  session.clear();
  assert.deepEqual(session.snapshot(), {
    generation: 0,
    phase: "idle",
    elapsedMs: 0,
    transcript: "",
    fullTranscript: "",
    liveText: "",
    utterances: [],
    wordCount: 0,
    utteranceCount: 0,
    cues: [],
  });
});

test("elapsed time excludes quiet time before pause and the entire paused interval", () => {
  const session = new ConversationSession();
  session.begin(12, 1_000);
  session.pause(12, 4_000);
  assert.equal(session.snapshot(9_000).elapsedMs, 3_000);
  session.resume(12, 9_000);
  assert.equal(session.snapshot(11_000).elapsedMs, 5_000);
  session.end(12, 12_000);
  assert.equal(session.snapshot(20_000).elapsedMs, 6_000);
});
