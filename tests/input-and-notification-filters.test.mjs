import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("ring sensitivity is a five-level setting that throttles scroll in the shell", () => {
  const settings = read("app/ui/dashboard-settings.ts");
  const ringCurve = read("app/ui/ring-sensitivity.ts");
  const shell = read("app/ui/shell/shell.ts");
  const menus = read("app/ui/dashboard/settings-menus.ts");

  // Defined as a discrete slider (default 5 = every scroll counts) with a
  // per-level minimum interval, and surfaced in the settings menu.
  assert.match(settings, /ringSensitivitySetting/);
  assert.match(ringCurve, /RING_SENSITIVITY_VALUES = \["1", "2", "3", "4", "5"\]/);
  assert.match(settings, /defaultValue: "5"/);
  assert.match(ringCurve, /function ringScrollMinIntervalMs/);
  assert.match(menus, /enumSettingMenuItem\(ringSensitivitySetting\)/);

  // The shell drops scroll events that arrive within the configured interval,
  // and exempts reorder (deliberate single steps).
  assert.match(shell, /ringScrollMinIntervalMs\(ringSensitivitySetting\.get\(\)\)/);
  assert.match(shell, /now - this\.lastScrollHonoredAtMs < interval/);
  assert.match(shell, /this\.reorderingWindowId === null/);
});

test("ring sensitivity has phone-app parity in the glasses controls screen", () => {
  const vm = read("app/phone-ui/glasses-controls-view-model.ts");
  const xml = read("app/phone-ui/glasses-controls-page.xml");

  // Batch H: ring sensitivity is now a Slider (index over ringSensitivitySetting
  // values) with a value chip, plus a live-refresh notify and a bound XML row.
  assert.match(vm, /get ringSensitivitySliderValue\(\): number/);
  assert.match(vm, /set ringSensitivitySliderValue\(/);
  assert.match(vm, /"ringSensitivityValueLabel"/);
  assert.match(xml, /value="\{\{ ringSensitivitySliderValue \}\}"/);
});

test("group-summary and empty notifications are filtered from the mirrored list", () => {
  const service = read(
    "App_Resources/Android/src/main/java/com/faceclaw/app/FaceclawMediaNotificationListenerService.java",
  );

  // The shared candidate filter (used by both list and icons) now drops group
  // summaries and content-empty placeholders — the "Teams — (untitled)" case.
  const filter = service.slice(
    service.indexOf("private static boolean isNotificationMirrorCandidate"),
    service.indexOf("private static boolean passesUserNotificationFilter"),
  );
  assert.match(filter, /FLAG_GROUP_SUMMARY\) != 0/);
  assert.match(filter, /if \(!hasDisplayableContent\(notification\)\)/);

  // hasDisplayableContent inspects title and body fields; hasText trims.
  assert.match(service, /private static boolean hasDisplayableContent/);
  assert.match(service, /Notification\.EXTRA_TITLE_BIG/);
  assert.match(service, /Notification\.EXTRA_BIG_TEXT/);
  assert.match(service, /value\.toString\(\)\.trim\(\)\.length\(\) > 0/);
});

test("Codex notification mirroring admits only a metadata-authenticated final turn", () => {
  const service = read(
    "App_Resources/Android/src/main/java/com/faceclaw/app/FaceclawMediaNotificationListenerService.java",
  );
  assert.match(service, /OPENAI_PACKAGE = "com\.openai\.chatgpt"/);
  assert.match(service, /CODEX_CHANNEL_PREFIX = "codex"/);
  assert.match(service, /CODEX_FINAL_CHANNEL = "codex"/);

  const classifier = service.slice(
    service.indexOf("private static boolean isCodexChannel"),
    service.indexOf("private static boolean shouldShowNotificationIcon"),
  );
  assert.match(classifier, /channelId\.startsWith\(CODEX_CHANNEL_PREFIX\)/);
  assert.match(classifier, /isUnclassifiableOpenAiNotification/);
  assert.match(classifier, /Build\.VERSION\.SDK_INT < 26/);
  assert.match(classifier, /OPENAI_PACKAGE\.equals\(statusBarNotification\.getPackageName\(\)\)/);
  assert.match(classifier, /CODEX_FINAL_CHANNEL\.equals\(channelId\)/);
  assert.match(classifier, /statusBarNotification\.isClearable\(\)/);
  for (const flag of ["FLAG_AUTO_CANCEL", "FLAG_ONGOING_EVENT", "FLAG_NO_CLEAR", "FLAG_FOREGROUND_SERVICE", "FLAG_GROUP_SUMMARY"]) {
    assert.match(classifier, new RegExp(`Notification\\.${flag}`), flag);
  }
  assert.doesNotMatch(classifier, /EXTRA_(?:TITLE|TEXT|BIG_TEXT)/, "lifecycle must never be inferred from content");

  const mirrorCandidate = service.slice(
    service.indexOf("private static boolean isNotificationMirrorCandidate"),
    service.indexOf("private static boolean hasDisplayableContent"),
  );
  assert.match(mirrorCandidate, /isUnclassifiableOpenAiNotification\(statusBarNotification\)/);
  assert.match(mirrorCandidate, /isCodexChannel\(statusBarNotification\) && !isCodexFinalResult\(statusBarNotification\)/);
  assert.match(service, /if \(isCodexFinalResult\(statusBarNotification\)\) \{\s*return !alreadyActive;/);

  // The app/channel classifier is a privacy prefilter. The user's selected-app
  // setting remains a separate, authoritative gate after it.
  const listFilter = service.slice(
    service.indexOf("private static boolean shouldShowNotificationInList"),
    service.indexOf("private static boolean isNotificationMirrorCandidate"),
  );
  assert.ok(listFilter.indexOf("isNotificationMirrorCandidate") < listFilter.indexOf("passesUserNotificationFilter"));
});
