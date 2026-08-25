import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("Notifications long-press menu clears visible notifications and detail actions wrap to Dismiss", () => {
  const app = read("app/apps/notifications/notifications-app.ts");
  const ui = read("app/ui/notifications.ts");
  const bridge = read("app/native/notification-icons.ts");
  const service = read("App_Resources/Android/src/main/java/com/faceclaw/app/FaceclawMediaNotificationListenerService.java");

  assert.match(app, /dismissAllNotifications/);
  assert.match(app, /label: "Dismiss all"/);
  assert.match(bridge, /dismissAllNotifications/);
  assert.match(service, /dismissAllNotifications/);
  assert.match(service, /isClearable\(\)/);
  // The detail menu wraps INSTANTLY (no edge-detent) so a swipe-up jumps
  // straight to Dismiss — deliberately unlike the scrollable list above.
  assert.match(ui, /\(this\.selectedMenuIndex - 1 \+ menu\.length\) % menu\.length/);
  assert.match(ui, /\(this\.selectedMenuIndex \+ 1\) % menu\.length/);
  assert.match(ui, /\{ kind: "back", label: "Back" \}/);
  assert.match(ui, /\{ kind: "dismiss", label: "Dismiss" \}/);
  const detail = ui.slice(ui.indexOf("export class SingleNotificationLayer"), ui.indexOf("function buildNotificationCardLayout"));
  assert.match(detail, /if \(event\.type === "double-click"\) \{\s*this\.dismissAndClose\(ctx\)/,
    "double-tap dismisses directly regardless of the selected menu row");
  assert.match(detail, /item\.kind === "back"[\s\S]*this\.close\(ctx\)/,
    "the initially selected Back row retains one-tap Back");
  assert.match(detail, /item\.kind === "dismiss"[\s\S]*this\.dismissAndClose\(ctx\)/,
    "the explicit Dismiss row shares the same native dismissal path");
  assert.match(ui, /Notification · \$\{GESTURE_DOUBLE_CLICK\} dismiss/,
    "the direct gesture is visible without removing Back\/Reply\/Dismiss");
});
