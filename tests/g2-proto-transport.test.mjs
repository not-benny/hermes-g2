import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  const androidStub = join(temp, "android/os/SystemClock.java");
  mkdirSync(join(temp, "android/os"), { recursive: true });
  writeFileSync(androidStub, `package android.os; public final class SystemClock { public static long elapsedRealtime() { return 0L; } }`);
  const logStub = join(temp, "android/util/Log.java");
  mkdirSync(join(temp, "android/util"), { recursive: true });
  writeFileSync(logStub, `package android.util; public final class Log { public static int d(String t, String m) { return 0; } public static int i(String t, String m) { return 0; } public static int w(String t, String m) { return 0; } }`);
  const harness = join(temp, "VectorHarness.java");
  writeFileSync(harness, `
package com.faceclaw.app;
import java.lang.reflect.Modifier;
import java.util.HexFormat;
public final class VectorHarness {
  private static void check(String name, byte[] actual, String expected) {
    String got = HexFormat.of().formatHex(actual);
    if (!got.equals(expected.replace(" ", "").toLowerCase())) throw new AssertionError(name + ": " + got);
  }
  private static void checkMessage(OutboundMessage message, String kind, String label, int magic, String expected) {
    if (!message.kind.equals(kind) || !message.label.equals(label)) throw new AssertionError("message identity");
    if (message.sid != BleProtocol.SID_G2_SETTING || message.flag != BleProtocol.FLAG_REQUEST) throw new AssertionError("message routing");
    if (message.magic != magic || message.ackTimeoutMs != 3500) throw new AssertionError("message ACK contract");
    check(kind + " payload", message.message, expected);
    String magicHex = Integer.toHexString(magic);
    if (!HexFormat.of().formatHex(message.message).contains(magicHex)) throw new AssertionError("payload magic");
  }
  public static void main(String[] args) throws Exception {
    check("distance-zero", BleProtocol.buildSetGlassGridDistance(0x2a, 0), "08 01 10 2a 1a 04 1a 02 08 00");
    check("distance-varint", BleProtocol.buildSetGlassGridDistance(0x2a, 300), "08 01 10 2a 1a 05 1a 03 08 ac 02");
    check("height-zero", BleProtocol.buildSetGlassGridHeight(0x2a, 0), "08 01 10 2a 1a 04 12 02 08 00");
    check("height-varint", BleProtocol.buildSetGlassGridHeight(0x2a, 128), "08 01 10 2a 1a 05 12 03 08 80 01");
    check("quick-restart", BleProtocol.buildQuickRestart(0x2a), "08 0f 10 2a 72 00");
    MessageBuilder builder = new MessageBuilder(new BleMagicPool());
    checkMessage(builder.setGlassGridDistance(300), "glass-grid-distance-control", "glass grid distance=300", 100, "08 01 10 64 1a 05 1a 03 08 ac 02");
    checkMessage(builder.setGlassGridHeight(128), "glass-grid-height-control", "glass grid height=128", 101, "08 01 10 65 1a 05 12 03 08 80 01");
    if (Modifier.isPublic(MessageBuilder.class.getDeclaredMethod("setGlassGridDistance", int.class).getModifiers())
        || Modifier.isPublic(MessageBuilder.class.getDeclaredMethod("setGlassGridHeight", int.class).getModifiers())) {
      throw new AssertionError("coordinate wrappers must remain package-internal");
    }
    boolean rejected = false;
    try { BleProtocol.buildSetGlassGridDistance(-1, 0); } catch (IllegalArgumentException expected) { rejected = true; }
    if (!rejected) throw new AssertionError("negative distance magic accepted");
    rejected = false;
    try { BleProtocol.buildSetGlassGridDistance(0, -1); } catch (IllegalArgumentException expected) { rejected = true; }
    if (!rejected) throw new AssertionError("negative distance accepted");
    rejected = false;
    try { BleProtocol.buildSetGlassGridHeight(0, -1); } catch (IllegalArgumentException expected) { rejected = true; }
    if (!rejected) throw new AssertionError("negative height accepted");
    rejected = false;
    try { BleProtocol.buildQuickRestart(-1); } catch (IllegalArgumentException expected) { rejected = true; }
    if (!rejected) throw new AssertionError("negative quick-restart magic accepted");
    System.out.println("g2 protobuf vectors and queue contracts: PASS");
  }
}
`);
  execFileSync("javac", ["-d", temp, androidStub, logStub, join(javaRoot, "com/faceclaw/app/util/CollectionUtils.java"), join(protocol, "BleProtocol.java"), join(protocol, "BleMagicPool.java"), join(protocol, "BleImageOptimizer.java"), join(protocol, "OutboundMessage.java"), join(protocol, "MessageBuilder.java"), harness], { stdio: "pipe" });
  const output = execFileSync("java", ["-cp", temp, "com.faceclaw.app.VectorHarness"], { encoding: "utf8" });
  assert.match(output, /g2 protobuf vectors and queue contracts: PASS/);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
