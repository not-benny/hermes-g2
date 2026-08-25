import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) =>
  readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("the status bar keeps a configured R1 visible and shares every valid battery source with Health", () => {
  const manager = read(
    "App_Resources/Android/src/main/java/com/faceclaw/app/FaceclawBleManager.java",
  );
  const communicator = read(
    "App_Resources/Android/src/main/java/com/faceclaw/app/FaceclawBleCommunicator.java",
  );
  const listener = read(
    "App_Resources/Android/src/main/java/com/faceclaw/app/FaceclawBleCommunicatorListener.java",
  );
  const bridge = read("app/native/faceclaw-communicator.ts");
  const controller = read("app/g2/dashboard-controller.ts");
  const store = read("app/health/ring-health-store.ts");
  const healthExport = read("app/native/health-export.ts");
  const chrome = read("app/ui/shell/chrome-layer.ts");
  const shell = read("app/ui/shell/shell.ts");

  assert.match(manager, /readCharacteristic\(/);
  assert.match(manager, /onCharacteristicRead/);
  assert.match(communicator, /RING_BATTERY_LEVEL_UUID/);
  assert.match(communicator, /refreshRingBattery/);
  const poll = communicator.slice(
    communicator.indexOf("private void probeRingHealth"),
    communicator.indexOf("private boolean ringProbeGap"),
  );
  assert.ok(
    poll.indexOf('"deviceStatus GET (battery)"') <
      poll.indexOf('"heartRate/daily GET"'),
    "battery request must precede rich history traffic",
  );
  assert.match(
    listener,
    /onBatteryState\(int headsetBattery, int headsetCharging, int ringBattery\)/,
  );
  assert.match(bridge, /ringBattery:/);
  assert.match(controller, /loadBattery\(ringIdentity\)/);
  assert.match(controller, /isRingIdentityCurrent/);
  assert.match(
    controller,
    /const isRingIdentityCurrent = \(\) =>[\s\S]*communicator !== null && this\.communicator === communicator[\s\S]*loadDeviceAddresses\(\)\.ring === ringIdentity/,
  );
  assert.match(
    controller,
    /await ensureBlePermissions\(\);[\s\S]*loadDeviceAddresses\(\)\.ring !== ringIdentity[\s\S]*throw new Error/,
  );
  assert.match(
    controller,
    /onRingHealthFrame\([\s\S]*if \(!isRingIdentityCurrent\(\)\) return;[\s\S]*ingestFrame/,
  );
  assert.match(
    controller,
    /onBatteryState\([\s\S]*this\.communicator !== communicator[\s\S]*isRingIdentityCurrent\(\)[\s\S]*ringHealthStore\.updateBatteryPercent\(state\.ringBattery\)[\s\S]*ring: isRingIdentityCurrent\(\)/,
  );
  assert.match(controller, /ringHealthStore\.clearBattery\(\)/);
  assert.match(
    controller,
    /ringHealthStore\.restoreBattery\(persistedBattery\.percent/,
  );
  assert.match(
    controller,
    /recordBattery\(ringIdentity, snapshot\.batteryPercent, snapshot\.batteryUpdatedAtMs\)/,
  );
  assert.match(
    store,
    /restoreBattery\(percent: number \| null, updatedAtMs: number \| null\): void/,
  );
  assert.match(store, /updateBatteryPercent\(percent: number\): void/);
  assert.match(
    healthExport,
    /const \{ battery, \.\.\.document \} = loadHealthDocument\(\)/,
  );
  assert.match(
    healthExport,
    /\{ percent: battery\.percent, updatedAtMs: battery\.updatedAtMs \}/,
  );
  assert.doesNotMatch(
    healthExport,
    /JSON\.stringify\(\{ \.\.\.loadHealthDocument\(\)/,
  );
  assert.match(shell, /setRingConfigured/);
  assert.match(chrome, /state\.ringConfigured/);
  assert.match(chrome, /percent === null\s*\?\s*"--"/);
});

test("packetAck wakeups drain and resume a generation-valid health poll", () => {
  const communicator = read(
    "App_Resources/Android/src/main/java/com/faceclaw/app/FaceclawBleCommunicator.java",
  );
  const start = communicator.indexOf(
    "private boolean ringProbeGap(int generation)",
  );
  const end = communicator.indexOf("/**", start + 10);
  const gap = communicator.slice(start, end);
  assert.match(gap, /while \(true\)/);
  assert.match(gap, /isRingOperationAllowedLocked\(generation\)/);
  assert.match(gap, /drainRingPacketAcks\(\)/);
  assert.doesNotMatch(
    gap,
    /if \(!ringInterruptibleSleep\.sleep\([^)]*\)\) \{\s*return false;/s,
  );
});
