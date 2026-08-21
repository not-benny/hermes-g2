import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const clockSource = fileURLToPath(new URL(
  "../App_Resources/Android/src/main/java/com/faceclaw/app/FaceclawRingClock.java",
  import.meta.url,
));
const communicator = readFileSync(new URL(
  "../App_Resources/Android/src/main/java/com/faceclaw/app/FaceclawBleCommunicator.java",
  import.meta.url,
), "utf8");

test("FaceclawRingClock encodes signed timezone and unsigned epoch little-endian", () => {
  const directory = mkdtempSync(join(tmpdir(), "faceclaw-ring-clock-"));
  try {
    const packageDir = join(directory, "com", "faceclaw", "app");
    mkdirSync(packageDir, { recursive: true });
    const harnessPath = join(packageDir, "FaceclawRingClockHarness.java");
    writeFileSync(harnessPath, `package com.faceclaw.app;
import java.util.Arrays;
public final class FaceclawRingClockHarness {
  private static void expect(long epoch, int offset, int... expected) {
    byte[] actual = FaceclawRingClock.encode(epoch, offset);
    for (int i = 0; i < expected.length; i++) {
      if ((actual[i] & 0xff) != expected[i]) throw new AssertionError(Arrays.toString(actual));
    }
  }
  private static void rejects(long epoch, int offset) {
    try { FaceclawRingClock.encode(epoch, offset); }
    catch (IllegalArgumentException expected) { return; }
    throw new AssertionError("expected rejection");
  }
  public static void main(String[] args) {
    expect(0x12345678L, 345, 0x59, 0x01, 0x78, 0x56, 0x34, 0x12);
    expect(0xffffffffL, -210, 0x2e, 0xff, 0xff, 0xff, 0xff, 0xff);
    expect(0L, -840, 0xb8, 0xfc, 0, 0, 0, 0);
    rejects(-1L, 0); rejects(0x1_0000_0000L, 0); rejects(0L, -841); rejects(0L, 841);
  }
}`);
    const compile = spawnSync("javac", ["-d", directory, clockSource, harnessPath], { encoding: "utf8" });
    assert.equal(compile.status, 0, compile.stderr || compile.stdout);
    const run = spawnSync("java", ["-cp", directory, "com.faceclaw.app.FaceclawRingClockHarness"], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr || run.stdout);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("systemTime SET is best-effort and confined to initial health-session setup", () => {
  const start = communicator.indexOf("private void probeRingHealth(int generation)");
  const end = communicator.indexOf("private boolean ringProbeGap", start);
  assert.ok(start >= 0 && end > start);
  const body = communicator.slice(start, end);
  assert.match(body, /FaceclawRingClock\.encode\(epochSec, timezoneOffsetMinutes\)/);
  assert.match(body, /"systemTime SET", 0x01, 0x00, 0x05, 0x02, clockPayload/);
  assert.equal((body.match(/"systemTime SET"/g) ?? []).length, 1);
  const openStart = body.indexOf("if (openSession)");
  const enable = body.indexOf("\"healthEnable SET\"", openStart);
  const clock = body.indexOf("\"systemTime SET\"", openStart);
  const daily = body.indexOf("\"heartRate/daily GET\"", openStart);
  assert.ok(openStart >= 0 && enable > openStart && clock > enable && daily > clock);
  assert.match(body.slice(enable, daily), /systemTime SET[\s\S]*write failures are logged; continuing health poll/);
});
