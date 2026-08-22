import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("the status bar keeps a configured R1 visible and shares every valid battery source with Health", () => {
  const manager = read("App_Resources/Android/src/main/java/com/faceclaw/app/FaceclawBleManager.java");
  const communicator = read("App_Resources/Android/src/main/java/com/faceclaw/app/FaceclawBleCommunicator.java");
  const listener = read("App_Resources/Android/src/main/java/com/faceclaw/app/FaceclawBleCommunicatorListener.java");
  const bridge = read("app/native/faceclaw-communicator.ts");
  const controller = read("app/g2/dashboard-controller.ts");
  const store = read("app/health/ring-health-store.ts");
  const chrome = read("app/ui/shell/chrome-layer.ts");
  const shell = read("app/ui/shell/shell.ts");

  assert.match(manager, /readCharacteristic\(/);
  assert.match(manager, /onCharacteristicRead/);
  assert.match(communicator, /RING_BATTERY_LEVEL_UUID/);
  assert.match(communicator, /refreshRingBattery/);
  const poll = communicator.slice(communicator.indexOf("private void probeRingHealth"), communicator.indexOf("private boolean ringProbeGap"));
  assert.ok(poll.indexOf('"deviceStatus GET (battery)"') < poll.indexOf('"heartRate/daily GET"'), "battery request must precede rich history traffic");
  assert.match(listener, /onBatteryState\(int headsetBattery, int headsetCharging, int ringBattery\)/);
  assert.match(bridge, /ringBattery:/);
  assert.match(controller, /ringHealthStore\.updateBatteryPercent\(state\.ringBattery\)/);
  assert.match(store, /updateBatteryPercent\(percent: number\): void/);
  assert.match(shell, /setRingConfigured/);
  assert.match(chrome, /state\.ringConfigured/);
  assert.match(chrome, /percent === null \? "--"/);
});
