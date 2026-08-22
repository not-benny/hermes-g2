import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("a worn ring requests deviceStatus before rich health pushes can interrupt the poll", () => {
  const communicator = read("App_Resources/Android/src/main/java/com/faceclaw/app/FaceclawBleCommunicator.java");
  const start = communicator.indexOf("private void probeRingHealth(int generation)");
  const end = communicator.indexOf("/** ~200ms spacing", start);
  const poll = communicator.slice(start, end);
  const battery = poll.indexOf("deviceStatus GET (battery)");
  const firstRichHealthRequest = poll.indexOf("heartRate/daily GET");

  assert.ok(start >= 0 && end > start, "ring health poll must exist");
  assert.ok(battery >= 0, "verified proprietary battery request must remain in the poll");
  assert.ok(firstRichHealthRequest >= 0, "rich health polling must remain enabled");
  assert.ok(
    battery < firstRichHealthRequest,
    "battery must be requested before a worn ring's rich response wakes the packetAck worker",
  );
});

test("protocol battery is restored, persisted, and propagated to both battery UIs", () => {
  const store = read("app/health/ring-health-store.ts");
  const controller = read("app/g2/dashboard-controller.ts");
  const config = read("app/phone-ui/config-view-model.ts");
  const phone = read("app/phone-ui/even-health-view-model.ts");
  const chrome = read("app/ui/shell/chrome-layer.ts");

  assert.match(store, /batteryPercent: percent/);
  assert.match(controller, /loadBattery/);
  assert.match(controller, /loadBattery\(ringIdentity\)/);
  assert.match(controller, /isRingIdentityCurrent/);
  assert.match(controller, /onRingHealthFrame\([\s\S]*if \(!isRingIdentityCurrent\(\)\) return;[\s\S]*ingestFrame/);
  assert.match(controller, /onBatteryState\([\s\S]*ring: isRingIdentityCurrent\(\)/);
  assert.match(controller, /ringHealthStore\.clearBattery\(\)/);
  assert.match(controller, /ringHealthStore\.restoreBattery\(persistedBattery\.percent/);
  assert.match(controller, /recordBattery\(ringIdentity, snapshot\.batteryPercent, snapshot\.batteryUpdatedAtMs\)/);
  assert.match(phone, /this\.health\.batteryPercent === null \? "--" : String\(this\.health\.batteryPercent\)/);
  assert.match(chrome, /kind: "ring", percent: state\.battery\.ring/);
  assert.match(config, /previous\.ring !== ring/);
  assert.match(config, /ringHealthStore\.clearBattery\(\)/);
});

test("packetAck wakeups drain and resume a generation-valid health poll", () => {
  const communicator = read("App_Resources/Android/src/main/java/com/faceclaw/app/FaceclawBleCommunicator.java");
  const start = communicator.indexOf("private boolean ringProbeGap(int generation)");
  const end = communicator.indexOf("/**", start + 10);
  const gap = communicator.slice(start, end);
  assert.match(gap, /while \(true\)/);
  assert.match(gap, /isRingOperationAllowedLocked\(generation\)/);
  assert.match(gap, /drainRingPacketAcks\(\)/);
  assert.doesNotMatch(gap, /if \(!ringInterruptibleSleep\.sleep\([^)]*\)\) \{\s*return false;/s);
});
