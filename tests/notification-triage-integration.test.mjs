import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const java = read("App_Resources/Android/src/main/java/com/faceclaw/app/FaceclawMediaNotificationListenerService.java");
const listener = read("App_Resources/Android/src/main/java/com/faceclaw/app/FaceclawNotificationListener.java");
const bridge = read("app/native/notification-icons.ts");
const controller = read("app/notifications/triage-controller.ts");
const dashboard = read("app/g2/dashboard-controller.ts");
const phone = read("app/phone-ui/notification-apps-view-model.ts");
const phoneXml = read("app/phone-ui/notification-apps-page.xml");
const glasses = read("app/ui/notifications.ts");

assert.match(listener, /onNotificationRemoved\(String key\)/);
assert.match(java, /emitNotificationRemoved\(statusBarNotification\.getKey\(\)\)/);

assert.match(java, /getNotificationJsonForKey/);
assert.match(java, /SDK_INT >= 26 \? notification\.getChannelId\(\) : ""/);
for (const field of ["channelId", "sender", "groupKey", "importance", "clearable"]) {
  assert.match(java, new RegExp(`\\\"${field}\\\"`), field);
  assert.match(bridge, new RegExp(`${field}:`), field);
}
assert.match(bridge, /onAndroidNotificationEvent/);
assert.match(controller, /reduceNotificationTriage/);
assert.match(controller, /serializeNotificationTriageMetadata/);
assert.doesNotMatch(controller, /console\.(?:log|warn|error).*notification/i);
assert.match(dashboard, /digest-ready/);
assert.match(dashboard, /openNotificationDigest/);
assert.match(dashboard, /isCurrent\(/);
assert.match(dashboard, /acknowledgeDigest/);
assert.match(dashboard, /notificationPresentationChain = this\.notificationPresentationChain\.then/);
assert.match(phone, /onTierTap/);
assert.match(phone, /onResetPrioritiesTap/);
assert.match(phoneXml, /Precedence:/);
assert.match(phoneXml, /Reset app priorities/);
assert.match(glasses, /NotificationDigestLayer/);
assert.match(glasses, /Why:/);
assert.ok((glasses.match(/this\.selectedIndex = clamp\(this\.selectedIndex, 0, live\.length - 1\)/g) ?? []).length >= 2);

test("notification triage is wired across Android, policy, phone, and glasses", () => {});
