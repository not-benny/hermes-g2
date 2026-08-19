import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("the status bar shows an R1 battery when the direct ring exposes the standard service", () => {
  const manager = read("App_Resources/Android/src/main/java/com/faceclaw/app/FaceclawBleManager.java");
  const communicator = read("App_Resources/Android/src/main/java/com/faceclaw/app/FaceclawBleCommunicator.java");
  const listener = read("App_Resources/Android/src/main/java/com/faceclaw/app/FaceclawBleCommunicatorListener.java");
  const bridge = read("app/native/faceclaw-communicator.ts");
  const controller = read("app/g2/dashboard-controller.ts");
  const chrome = read("app/ui/shell/chrome-layer.ts");
  const shell = read("app/ui/shell/shell.ts");

  assert.match(manager, /readCharacteristic\(/);
  assert.match(manager, /onCharacteristicRead/);
  assert.match(communicator, /RING_BATTERY_LEVEL_UUID/);
  assert.match(communicator, /refreshRingBattery/);
  assert.match(listener, /onBatteryState\(int headsetBattery, int headsetCharging, int ringBattery\)/);
  assert.match(bridge, /ringBattery:/);
  assert.match(controller, /ringBattery/);
  assert.match(chrome, /kind: "ring"/);
  assert.match(shell, /ring: null/);
});
