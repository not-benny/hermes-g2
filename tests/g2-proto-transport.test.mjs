import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const javaRoot = join(root, "App_Resources/Android/src/main/java");
const protocol = join(javaRoot, "com/faceclaw/app/g2protocol");
const communicator = readFileSync(join(javaRoot, "com/faceclaw/app/FaceclawBleCommunicator.java"), "utf8");
const nativeCommunicator = readFileSync(join(root, "app/native/faceclaw-communicator.ts"), "utf8");
assert.doesNotMatch(communicator, /quickRestart|SID_DEVICE_SETTINGS|buildQuickRestart/);
assert.doesNotMatch(nativeCommunicator, /quickRestart|glassGridDistance|glassGridHeight/);
const temp = mkdtempSync(join(tmpdir(), "g2-proto-"));
try {
  const harness = join(temp, "VectorHarness.java");
  writeFileSync(harness, `
package com.faceclaw.app;
import java.util.HexFormat;
public final class VectorHarness {
  private static void check(String name, byte[] actual, String expected) {
    String got = HexFormat.of().formatHex(actual);
    if (!got.equals(expected.replace(" ", "").toLowerCase())) throw new AssertionError(name + ": " + got);
  }
  public static void main(String[] args) {
    check("distance-zero", BleProtocol.buildSetGlassGridDistance(0x2a, 0), "08 01 10 2a 1a 04 1a 02 08 00");
    check("distance-varint", BleProtocol.buildSetGlassGridDistance(0x2a, 300), "08 01 10 2a 1a 05 1a 03 08 ac 02");
    check("height-zero", BleProtocol.buildSetGlassGridHeight(0x2a, 0), "08 01 10 2a 1a 04 12 02 08 00");
    check("height-varint", BleProtocol.buildSetGlassGridHeight(0x2a, 128), "08 01 10 2a 1a 05 12 03 08 80 01");
    check("quick-restart", BleProtocol.buildQuickRestart(0x2a), "08 0f 10 2a 72 00");
    boolean rejected = false;
    try { BleProtocol.buildSetGlassGridDistance(-1, 0); } catch (IllegalArgumentException expected) { rejected = true; }
    if (!rejected) throw new AssertionError("negative magic accepted");
    rejected = false;
    try { BleProtocol.buildSetGlassGridHeight(0, -1); } catch (IllegalArgumentException expected) { rejected = true; }
    if (!rejected) throw new AssertionError("negative coordinate accepted");
    System.out.println("g2 protobuf vectors: PASS");
  }
}
`);
  execFileSync("javac", ["-d", temp, join(javaRoot, "com/faceclaw/app/util/CollectionUtils.java"), join(protocol, "BleProtocol.java"), harness], { stdio: "pipe" });
  const output = execFileSync("java", ["-cp", temp, "com.faceclaw.app.VectorHarness"], { encoding: "utf8" });
  assert.match(output, /g2 protobuf vectors: PASS/);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
