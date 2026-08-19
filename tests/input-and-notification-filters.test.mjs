import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("ring sensitivity is a five-level setting that throttles scroll in the shell", () => {
  const settings = read("app/ui/dashboard-settings.ts");
  const shell = read("app/ui/shell/shell.ts");
  const menus = read("app/ui/dashboard/settings-menus.ts");

  // Defined as a discrete slider (default 5 = every scroll counts) with a
  // per-level minimum interval, and surfaced in the settings menu.
  assert.match(settings, /ringSensitivitySetting/);
  assert.match(settings, /RING_SENSITIVITY_VALUES = \["1", "2", "3", "4", "5"\]/);
  assert.match(settings, /defaultValue: "5"/);
  assert.match(settings, /function ringScrollMinIntervalMs/);
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

  // Label getter, tap-to-cycle action, live refresh, and a bound XML row.
  assert.match(vm, /get ringSensitivityLabel\(\): string/);
  assert.match(vm, /onRingSensitivityTap\(\): void \{\s*ringSensitivitySetting\.set\(ringSensitivitySetting\.next\(\)\)/);
  assert.match(vm, /"ringSensitivityLabel"/);
  assert.match(xml, /text="\{\{ ringSensitivityLabel \}\}" tap="\{\{ onRingSensitivityTap \}\}"/);
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
