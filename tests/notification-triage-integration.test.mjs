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
assert.match(glasses, /retainAndroidNotification/);
assert.match(glasses, /this\.retainedNotification \?\?/,
  "a presented modal must not disappear when Android replaces or removes its live notification");
assert.ok((glasses.match(/this\.selectedIndex = clamp\(this\.selectedIndex, 0, retained\.length - 1\)/g) ?? []).length >= 2);
assert.doesNotMatch(
  glasses.slice(glasses.indexOf("export class NotificationDigestLayer"), glasses.indexOf("type SingleNotificationLayerOptions")),
  /notificationTriageController\.isCurrent/,
  "a displayed digest is retained until wearer dismissal or global sleep",
);

const notificationModal = shell.slice(shell.indexOf("async openNotificationModal"), shell.indexOf("async openNotificationDigest"));
const notificationDigest = shell.slice(shell.indexOf("async openNotificationDigest"), shell.indexOf("isMusicCardActive"));
for (const presentation of [notificationModal, notificationDigest]) {
  const waitIndex = presentation.indexOf("await this.config.waitForShellRenderIdle");
  const pushIndex = presentation.indexOf("this.stack.push(modal)");
  const initialGuard = presentation.slice(0, waitIndex);
  assert.match(initialGuard, /!this\.screenOn/);
  assert.match(initialGuard, /this\.activeVoiceLayer/,
    "Android notification presentation fails closed while wearer voice input owns the shell");
  assert.match(initialGuard, /this\.assistantOnlyPresentation/,
    "Android notifications cannot displace the isolated assistant surface");
  assert.ok(waitIndex >= 0 && pushIndex > waitIndex,
    "ordinary wake renders must drain before a strict notification becomes stack-top");
  const postDrainGuard = presentation.slice(waitIndex, pushIndex);
  assert.match(postDrainGuard, /!this\.screenOn/);
  assert.match(postDrainGuard, /this\.activeVoiceLayer/);
  assert.match(postDrainGuard, /this\.assistantOnlyPresentation/,
    "notification authority is rechecked after the ordinary render drain");
  assert.match(presentation, /this\.stack\.push\(modal\);[\s\S]*this\.restartScreenTimeout\(\);[\s\S]*await this\.config\.requestShellDelivery\(isOwner\)/,
    "notification installation cannot inherit an already-expired idle baseline");
  assert.match(presentation, /await this\.config\.requestShellDelivery\(isOwner\)/);
  assert.match(presentation, /if \(!isOwner\(\)\) throw new Error/);
  assert.match(presentation, /if \(!isOwner\(\)\) throw new Error[\s\S]*this\.restartScreenTimeout\(\)/,
    "notification reading time starts only after an owned frame is accepted");
}

assert.match(dashboard, /readNotificationByKey\(effect\.key\)[\s\S]*ensureEvenHubSessionActive/,
  "the Android notification is retained before the asynchronous G2 wake barrier");
assert.match(dashboard, /openNotificationModal\([\s\S]*immediateNotification![\s\S]*effect\.reason/);

test("notification triage is wired across Android, policy, phone, and glasses", () => {});
