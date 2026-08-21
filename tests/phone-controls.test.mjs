import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("phone UI exposes safe live glasses controls", () => {
  const mainPage = read("app/phone-ui/main-page.xml");
  const mainModel = read("app/phone-ui/main-view-model.ts");
  const controlsPage = read("app/phone-ui/glasses-controls-page.xml");
  const controlsModel = read("app/phone-ui/glasses-controls-view-model.ts");
  const controller = read("app/g2/dashboard-controller.ts");
  const communicator = read("app/native/faceclaw-communicator.ts");

  // Glasses controls is now the Controls tab of the bottom-tab shell.
  const shell = read("app/phone-ui/shell-page.xml");
  assert.match(shell, /title="Controls"/);
  assert.match(shell, /phone-ui\/glasses-controls-page/);
  assert.match(controlsPage, /Wake screen/);
  assert.match(controlsPage, /Blank screen/);
  assert.match(controlsPage, /Refresh wear status/);
  assert.match(controlsPage, /Test voice input/);
  for (const method of [
    "wakeGlassesScreen",
    "sleepGlassesScreen",
    "refreshWearState",
    "reconnectGlasses",
    "triggerVoiceTest",
  ]) {
    assert.match(controlsModel, new RegExp(method));
    assert.match(controller, new RegExp(method));
  }
  assert.match(controlsPage, /Reconnect R1/);
  assert.match(controlsModel, /onReconnectRingTap/);
  assert.match(controller, /reconnectRing/);
  assert.match(communicator, /requestRingReconnect/);

  const nativeCommunicator = read(
    "App_Resources/Android/src/main/java/com/faceclaw/app/FaceclawBleCommunicator.java",
  );
  assert.match(controlsPage, /\{\{ ringFirmwareVersion \}\}/);
  assert.match(controlsModel, /ringHealthStore\.onChange/);
  assert.match(controlsModel, /get ringFirmwareVersion\(\)/);
  assert.match(
    nativeCommunicator,
    /sendRingCommandForGeneration\(generation,\s*"deviceInfo GET \(firmware version\)", 0x01, 0x00, 0x02, 0x00, null\)/,
  );
  const sessionStart = nativeCommunicator.indexOf("if (openSession) {");
  const pairAuth = nativeCommunicator.indexOf(
    'sendRawRingFrameForGeneration(generation, "pairAuth (session open)"',
    sessionStart,
  );
  const deviceInfo = nativeCommunicator.indexOf('"deviceInfo GET (firmware version)"', pairAuth);
  const healthEnable = nativeCommunicator.indexOf('"healthEnable SET"', deviceInfo);
  assert.ok(sessionStart >= 0 && pairAuth > sessionStart && deviceInfo > pairAuth && healthEnable > deviceInfo);
});

test("notification filtering applies to the mirrored list, tray, and alerts", () => {
  const settings = read("app/ui/dashboard-settings.ts");
  const controlsPage = read("app/phone-ui/glasses-controls-page.xml");
  const controlsModel = read("app/phone-ui/glasses-controls-view-model.ts");
  const appsPage = read("app/phone-ui/notification-apps-page.xml");
  const appsModel = read("app/phone-ui/notification-apps-view-model.ts");
  const notificationBridge = read("app/native/notification-icons.ts");
  const notificationService = read(
    "App_Resources/Android/src/main/java/com/faceclaw/app/FaceclawMediaNotificationListenerService.java",
  );

  assert.match(settings, /notificationFilterModeSetting/);
  assert.match(settings, /notificationAllowedPackagesSetting/);
  assert.match(controlsModel, /onNotificationFilterModeTap/);
  assert.match(controlsModel, /onOpenNotificationAppsTap/);
  assert.match(controlsPage, /Manage notification apps/);
  assert.match(appsModel, /onNotificationAppTap/);
  assert.match(appsModel, /ObservableArray/);
  assert.match(appsPage, /<ListView/);
  assert.match(appsPage, /itemTap="\{\{ onNotificationAppTap \}\}"/);
  assert.match(notificationBridge, /readInstalledNotificationApps/);
  assert.match(notificationService, /NOTIFICATION_FILTER_MODE_KEY/);
  assert.match(notificationService, /NOTIFICATION_ALLOWED_PACKAGES_KEY/);
  assert.match(notificationService, /getInstalledNotificationAppsJson/);
  assert.doesNotMatch(notificationService, /getLaunchIntentForPackage/);
  assert.match(notificationService, /passesUserNotificationFilter/);
});

test("phone UI offers replace-only API-key and Hermes bridge credential fields", () => {
  const mainPage = read("app/phone-ui/main-page.xml");
  const mainModel = read("app/phone-ui/main-view-model.ts");
  const keysPage = read("app/phone-ui/api-keys-page.xml");
  const keysModel = read("app/phone-ui/api-keys-view-model.ts");

  // API keys is now reached from the Settings tab hub, not the main overflow.
  const settingsPage = read("app/phone-ui/settings-page.xml");
  const settingsModel = read("app/phone-ui/settings-view-model.ts");
  assert.match(settingsPage, /API keys/);
  assert.match(settingsModel, /onApiKeysTap/);
  assert.match(keysPage, /secure="true"/);
  assert.match(keysPage, /Leave blank to keep/);
  assert.match(keysModel, /set bridgeHost\(/);
  assert.match(keysModel, /set bridgePort\(/);
  for (const setting of [
    "assistantBridgeTokenSetting",
    "anthropicApiKeySetting",
    "openAiApiKeySetting",
    "elevenLabsApiKeySetting",
    "sonioxApiKeySetting",
    "mapboxApiKeySetting",
  ]) {
    assert.match(keysModel, new RegExp(setting));
  }
});
