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
const shell = read("app/ui/shell/shell.ts");

assert.match(listener, /onNotificationRemoved\(String key\)/);
assert.match(java, /emitNotificationRemoved\(statusBarNotification\.getKey\(\)\)/);

assert.match(java, /getNotificationJsonForKey/);
assert.match(java, /isCodexChannel/);
assert.match(java, /isCodexFinalResult/);
assert.match(java, /CODEX_FINAL_CHANNEL/);
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
assert.match(dashboard, /openNotificationCard/);
assert.match(dashboard, /isCurrent\(/);
assert.match(dashboard, /acknowledgeDigest/);
assert.match(dashboard, /isNotificationPresentationAllowed: \(\) => this\.isAssistantResultPresentationAllowed\(\)/,
  "notification strict acknowledgement is invalid while the opaque lock surface owns the lens");
assert.match(dashboard, /if \(!visible\)[\s\S]*notificationTriageController\.tick\(\)/,
  "unlock immediately retries retained notification presentations");
assert.match(dashboard, /notificationPresentationChain = this\.notificationPresentationChain\.then/);
assert.match(phone, /onTierTap/);
assert.match(phone, /onResetPrioritiesTap/);
assert.match(phoneXml, /Precedence:/);
assert.match(phoneXml, /Reset app priorities/);
assert.match(glasses, /NotificationDigestLayer/);
assert.match(glasses, /`Notifications \$\{this\.selectedIndex \+ 1\}/,
  "the wearer-facing grouped view uses plain language rather than the internal digest term");
assert.match(glasses, /Why:/);
assert.match(glasses, /retainAndroidNotification/);
assert.match(glasses, /this\.retainedNotification \?\?/,
  "a presented modal must not disappear when Android replaces or removes its live notification");
assert.ok((glasses.match(/this\.selectedIndex = clamp\(this\.selectedIndex, 0, retained\.length - 1\)/g) ?? []).length >= 2);
assert.doesNotMatch(
  glasses.slice(glasses.indexOf("export class NotificationDigestLayer"), glasses.indexOf("type SingleNotificationLayerOptions")),
  /notificationTriageController\.isCurrent/,
  "a displayed digest is retained until wearer dismissal or global sleep",
);

const notificationCard = shell.slice(shell.indexOf("async openNotificationCard"), shell.indexOf("async openNotificationModal"));
assert.match(notificationCard, /this\.assistantOnlyPresentation/);
assert.match(notificationCard, /this\.activeVoiceLayer/);
assert.match(notificationCard, /this\.stack\.push\(card\)/,
  "the opaque card is installed before a screen-off wake");
assert.match(notificationCard, /prepareNotificationCardDisplay[\s\S]*requestShellDelivery\(isInstalledOwner, false\)[\s\S]*this\.wake\("sidebar"\)[\s\S]*revealNotificationCardDisplay[\s\S]*requestShellDelivery\(isOwner\)/,
  "screen-off notification delivery primes behind black and requires its own strict receipt");
assert.match(notificationCard, /openNotificationCardDetail/,
  "clicking the card transfers into the full notification dialogue");
assert.match(notificationCard, /notificationCardWokeScreen/,
  "the card retains whether it must return to sleep");
assert.match(notificationCard, /isNotificationPresentationAllowed/,
  "lock authority is checked before and throughout strict card delivery");

assert.doesNotMatch(
  dashboard.slice(dashboard.indexOf("private async handleNotificationTriageEffects"), dashboard.indexOf("private async playBuzzerSequence")),
  /shell\.wake\(/,
  "notification triage delegates blank-first wake ownership to the card transaction",
);
assert.match(dashboard, /openNotificationCard\([\s\S]*immediateNotification![\s\S]*effect\.reason/);
assert.match(dashboard, /openNotificationCard\([\s\S]*new notifications[\s\S]*digestNotifications/,
  "bursts are represented by one summary card whose click opens the digest dialogue");

test("notification triage is wired across Android, policy, phone, and glasses", () => {});
