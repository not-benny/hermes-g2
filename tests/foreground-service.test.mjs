import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("foreground service claims only explicitly active and permitted operation types", () => {
  const service = read("App_Resources/Android/src/main/java/com/faceclaw/app/FaceclawForegroundService.java");
  const bridge = read("app/native/foreground-service.ts");
  const navigation = read("app/apps/navigate/navigate-app.worker.ts");
  for (const extra of ["EXTRA_CONNECTED_DEVICE_ACTIVE", "EXTRA_PHONE_MIC_ACTIVE", "EXTRA_LOCATION_ACTIVE"]) {
    assert.match(service, new RegExp(extra));
    assert.match(bridge, new RegExp(extra));
  }
  assert.match(service, /phoneMicActive && hasRecordAudioPermission\(\)/);
  assert.match(service, /locationActive && hasFineLocationPermission\(\)/);
  assert.match(service, /connectedDeviceActive[\s\S]*FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE/);
  assert.match(service, /return START_NOT_STICKY/);
  assert.doesNotMatch(service, /return START_STICKY/);
  assert.match(bridge, /setForegroundActivities/);
  assert.match(bridge, /setForegroundActivity/);
  assert.match(navigation, /setForegroundActivity\("location", shouldRun/);
});
