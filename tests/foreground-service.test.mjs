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

test("inactive activity updates never create an unmet foreground-service start contract", () => {
  const service = read("App_Resources/Android/src/main/java/com/faceclaw/app/FaceclawForegroundService.java");
  const bridge = read("app/native/foreground-service.ts");
  const update = bridge.slice(
    bridge.indexOf("export function setForegroundActivity"),
    bridge.indexOf("export function startForegroundNotification"),
  );

  assert.match(update, /if \(active\)[\s\S]*ContextCompat\.startForegroundService\(context, intent\)/);
  assert.match(update, /else[\s\S]*startReleaseUpdate\(context, intent\)/);
  assert.ok(
    update.indexOf("if (active)") < update.indexOf("ContextCompat.startForegroundService(context, intent)"),
    "only a positive operation may establish Android's foreground-start deadline",
  );
  assert.match(service, /if \(!connectedDeviceActive[\s\S]*stopIfLatest\(startId\)/);
  assert.match(service, /stopSelfResult\(startId\)/,
    "an older release must not stop a newer queued foreground claim");
});

test("redundant background releases are safe when the shared service is absent", () => {
  const bridge = read("app/native/foreground-service.ts");
  const scheduler = read("App_Resources/Android/src/main/java/com/faceclaw/app/FaceclawClockScheduler.java");
  const release = bridge.slice(
    bridge.indexOf("function startReleaseUpdate"),
    bridge.indexOf("export function setForegroundActivities"),
  );
  const clockRelease = scheduler.slice(
    scheduler.indexOf("public static void setRecoveryLease"),
    scheduler.indexOf("public static void dismissNotification"),
  );

  assert.match(release, /try[\s\S]*context\.startService\(intent\)/);
  assert.match(release, /nativeError instanceof java\.lang\.IllegalStateException[\s\S]*return/);
  assert.match(release, /throw error/,
    "non-background-start failures must remain visible");
  assert.match(bridge, /startReleaseUpdate\([\s\S]*ACTION_STOP/,
    "full inactive teardown shares the safe release path");

  assert.match(clockRelease, /if \(active\)[\s\S]*ContextCompat\.startForegroundService/);
  assert.match(clockRelease, /else[\s\S]*try[\s\S]*context\.startService\(service\)/);
  assert.match(clockRelease, /catch \(IllegalStateException ignored\)/);
});
