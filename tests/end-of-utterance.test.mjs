import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const detectorSource = fileURLToPath(new URL(
  "../App_Resources/Android/src/main/java/com/faceclaw/app/EndOfUtteranceDetector.java",
  import.meta.url,
));
const controllerSource = readFileSync(new URL(
  "../App_Resources/Android/src/main/java/com/faceclaw/app/FaceclawVoiceController.java",
  import.meta.url,
), "utf8");
const listenerSource = readFileSync(new URL(
  "../App_Resources/Android/src/main/java/com/faceclaw/app/FaceclawVoiceControllerListener.java",
  import.meta.url,
), "utf8");

test("end-of-utterance detector handles speech, noise, pauses, timeouts, and reuse on the audio clock", () => {
  const directory = mkdtempSync(join(tmpdir(), "faceclaw-endpoint-"));
  try {
    const packageDir = join(directory, "com", "faceclaw", "app");
    mkdirSync(packageDir, { recursive: true });
    const harnessPath = join(packageDir, "EndOfUtteranceDetectorHarness.java");
    writeFileSync(harnessPath, `package com.faceclaw.app;
import java.util.ArrayList;
import java.util.List;

public final class EndOfUtteranceDetectorHarness {
  private static final int RATE = 16000;
  private static final int FRAME_SAMPLES = RATE / 50;

  private static short[] frame(int amplitude) {
    short[] pcm = new short[FRAME_SAMPLES];
    for (int i = 0; i < pcm.length; i++) pcm[i] = (short) ((i & 1) == 0 ? amplitude : -amplitude);
    return pcm;
  }

  private static EndOfUtteranceDetector.Result feed(
      EndOfUtteranceDetector detector, List<int[]> segments, boolean insertEmptyChunks) {
    EndOfUtteranceDetector.Result result = EndOfUtteranceDetector.Result.NONE;
    for (int[] segment : segments) {
      int frames = segment[1] / 20;
      for (int i = 0; i < frames; i++) {
        if (insertEmptyChunks) {
          EndOfUtteranceDetector.Result empty = detector.accept(new short[0], 0, 0);
          if (empty != EndOfUtteranceDetector.Result.NONE) throw new AssertionError("empty chunk advanced detector");
        }
        EndOfUtteranceDetector.Result next = detector.accept(frame(segment[0]), 0, FRAME_SAMPLES);
        if (next != EndOfUtteranceDetector.Result.NONE) {
          if (result != EndOfUtteranceDetector.Result.NONE) throw new AssertionError("duplicate endpoint");
          result = next;
        }
      }
    }
    return result;
  }

  private static List<int[]> segments(int... values) {
    List<int[]> result = new ArrayList<>();
    for (int i = 0; i < values.length; i += 2) result.add(new int[] { values[i], values[i + 1] });
    return result;
  }

  private static short[] samples(List<int[]> segments) {
    int count = 0;
    for (int[] segment : segments) count += segment[1] * RATE / 1000;
    short[] result = new short[count];
    int offset = 0;
    for (int[] segment : segments) {
      int segmentSamples = segment[1] * RATE / 1000;
      for (int i = 0; i < segmentSamples; i++) {
        result[offset++] = (short) ((i & 1) == 0 ? segment[0] : -segment[0]);
      }
    }
    return result;
  }

  private static void expect(String name, EndOfUtteranceDetector.Result expected, List<int[]> audio) {
    EndOfUtteranceDetector detector = new EndOfUtteranceDetector(EndOfUtteranceDetector.Config.defaults());
    EndOfUtteranceDetector.Result actual = EndOfUtteranceDetector.Result.NONE;
    for (int segmentIndex = 0; segmentIndex < audio.size(); segmentIndex++) {
      int[] segment = audio.get(segmentIndex);
      int frames = segment[1] / 20;
      for (int frameIndex = 0; frameIndex < frames; frameIndex++) {
        EndOfUtteranceDetector.Result next = detector.accept(frame(segment[0]), 0, FRAME_SAMPLES);
        if (next != EndOfUtteranceDetector.Result.NONE) {
          boolean exactEnd = segmentIndex == audio.size() - 1 && frameIndex == frames - 1;
          if (!exactEnd) throw new AssertionError(name + ": endpoint fired early");
          actual = next;
        }
      }
    }
    if (actual != expected) throw new AssertionError(name + ": " + actual + " != " + expected);
    EndOfUtteranceDetector.Result duplicate = detector.accept(frame(2000), 0, FRAME_SAMPLES);
    if (duplicate != EndOfUtteranceDetector.Result.NONE) throw new AssertionError(name + ": endpoint repeated");
  }

  public static void main(String[] args) {
    expect("speech starts immediately", EndOfUtteranceDetector.Result.TRAILING_SILENCE,
        segments(1200, 400, 100, 900));
    expect("ordinary speech", EndOfUtteranceDetector.Result.TRAILING_SILENCE,
        segments(100, 300, 1200, 400, 100, 900));
    expect("quiet speech", EndOfUtteranceDetector.Result.TRAILING_SILENCE,
        segments(60, 300, 220, 300, 60, 900));
    expect("stationary background", EndOfUtteranceDetector.Result.NO_SPEECH,
        segments(500, 6000));
    expect("speech over background", EndOfUtteranceDetector.Result.TRAILING_SILENCE,
        segments(500, 300, 1800, 400, 500, 900));
    expect("natural pause", EndOfUtteranceDetector.Result.TRAILING_SILENCE,
        segments(100, 300, 1200, 300, 100, 500, 1200, 300, 100, 900));
    expect("short transient is not speech", EndOfUtteranceDetector.Result.NO_SPEECH,
        segments(100, 300, 2000, 100, 100, 5600));
    expect("speech below the minimum is not accepted", EndOfUtteranceDetector.Result.NO_SPEECH,
        segments(100, 300, 1200, 220, 100, 5480));
    expect("onset spike is ignored", EndOfUtteranceDetector.Result.NO_SPEECH,
        segments(100, 300, 2000, 40, 100, 5660));
    expect("maximum utterance", EndOfUtteranceDetector.Result.MAX_UTTERANCE,
        segments(100, 300, 1200, 30000));

    List<int[]> adaptive = new ArrayList<>();
    adaptive.add(new int[] { 100, 300 });
    for (int amplitude = 110; amplitude <= 400; amplitude += 10) adaptive.add(new int[] { amplitude, 40 });
    adaptive.add(new int[] { 1200, 400 });
    adaptive.add(new int[] { 400, 900 });
    expect("adaptive background", EndOfUtteranceDetector.Result.TRAILING_SILENCE, adaptive);

    EndOfUtteranceDetector gapDetector = new EndOfUtteranceDetector(EndOfUtteranceDetector.Config.defaults());
    EndOfUtteranceDetector.Result gapResult = feed(
        gapDetector, segments(100, 300, 1200, 400, 100, 900), true);
    if (gapResult != EndOfUtteranceDetector.Result.TRAILING_SILENCE) {
      throw new AssertionError("packet gaps changed sample-clock result: " + gapResult);
    }

    EndOfUtteranceDetector irregular = new EndOfUtteranceDetector(EndOfUtteranceDetector.Config.defaults());
    short[] ordinary = samples(segments(100, 300, 1200, 400, 100, 900));
    int[] chunkSizes = { 1, 17, 319, 640, 7, 503, 29 };
    EndOfUtteranceDetector.Result irregularResult = EndOfUtteranceDetector.Result.NONE;
    for (int offset = 0, chunkIndex = 0; offset < ordinary.length; chunkIndex++) {
      int count = Math.min(chunkSizes[chunkIndex % chunkSizes.length], ordinary.length - offset);
      EndOfUtteranceDetector.Result next = irregular.accept(ordinary, offset, count);
      offset += count;
      if (next != EndOfUtteranceDetector.Result.NONE) {
        if (offset != ordinary.length) throw new AssertionError("irregular chunks fired early");
        irregularResult = next;
      }
    }
    if (irregularResult != EndOfUtteranceDetector.Result.TRAILING_SILENCE) {
      throw new AssertionError("irregular chunks changed endpoint: " + irregularResult);
    }

    gapDetector.reset();
    EndOfUtteranceDetector.Result replay = feed(
        gapDetector, segments(100, 300, 1200, 400, 100, 900), false);
    if (replay != EndOfUtteranceDetector.Result.TRAILING_SILENCE) {
      throw new AssertionError("reset did not make detector reusable: " + replay);
    }

    try {
      new EndOfUtteranceDetector.Config(16000, 20, 100, 60, 240, 900, 6000, 30000,
          Double.NaN, 180, 120, 2.5, 1.5, 200, 500);
      throw new AssertionError("NaN config accepted");
    } catch (IllegalArgumentException expected) {}
    try {
      new EndOfUtteranceDetector.Config(Integer.MAX_VALUE, 1000, 1000, 60, 240, 900,
          6000, 30000, 60, 180, 120, 2.5, 1.5, 200, 500);
      throw new AssertionError("overflowing frame config accepted");
    } catch (IllegalArgumentException expected) {}
    try {
      gapDetector.accept(new short[1], 0, -1);
      throw new AssertionError("negative PCM count accepted");
    } catch (IllegalArgumentException expected) {}
  }
}`);
    const compile = spawnSync("javac", ["-d", directory, detectorSource, harnessPath], { encoding: "utf8" });
    assert.equal(compile.status, 0, compile.stderr || compile.stdout);
    const run = spawnSync("java", ["-cp", directory, "com.faceclaw.app.EndOfUtteranceDetectorHarness"], {
      encoding: "utf8",
    });
    assert.equal(run.status, 0, run.stderr || run.stdout);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("voice controller uses the pure detector and forwards final PCM before endpoint notification", () => {
  assert.match(controllerSource, /new EndOfUtteranceDetector\(EndOfUtteranceDetector\.Config\.defaults\(\)\)/);
  assert.doesNotMatch(controllerSource, /class EndpointDetector/);
  const decodeStart = controllerSource.indexOf("private void processG2Audio(");
  const decodeEnd = controllerSource.indexOf("private void processKeywordSpotter", decodeStart);
  assert.ok(decodeStart >= 0 && decodeEnd > decodeStart);
  const decodeBody = controllerSource.slice(decodeStart, decodeEnd);
  const pcmForward = decodeBody.indexOf("emitPcm(pcm, count)");
  const endpoint = decodeBody.indexOf("endpointDetector.accept(pcm, 0, count)");
  const notify = decodeBody.indexOf("emitSpeechEnd()", endpoint);
  assert.ok(pcmForward >= 0 && endpoint > pcmForward && notify > endpoint);
});

test("native capture callbacks and teardown are fenced by the exact generation", () => {
  assert.match(listenerSource, /onStatus\(long generation, String status\)/);
  assert.match(listenerSource, /onTranscript\(long generation, String text, boolean isFinal\)/);
  assert.match(listenerSource, /onPcm\(long generation, byte\[\] pcm16le\)/);
  assert.match(listenerSource, /onSpeechEnd\(long generation\)/);
  assert.match(controllerSource, /public boolean start\(String requestedMode, long generation\)/);
  assert.match(controllerSource, /stop\(long generation\)/);
  assert.match(controllerSource, /if \(workerThread != null\)/);
  assert.match(controllerSource, /isGenerationRunning\(generation\)/);
  assert.match(controllerSource, /currentListener\.onPcm\(generation, le\)/);
  assert.match(controllerSource, /currentListener\.onTranscript\(generation, text, isFinal\)/);
});
