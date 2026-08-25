import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("native Clock mirror persists no label plaintext and uses generic fallback copy", () => {
  const java = read("App_Resources/Android/src/main/java/com/faceclaw/app/FaceclawClockScheduler.java");
  assert.doesNotMatch(java, /object\.put\("label"/);
  assert.doesNotMatch(java, /final String label/);
  assert.doesNotMatch(java, /record\.label/);
  assert.match(java, /"Alarm ringing"/);
  assert.match(java, /"Timer finished"/);

  const bridge = read("app/native/clock-scheduler.ts");
  const records = bridge.slice(bridge.indexOf("const records ="), bridge.indexOf("replaceAll", bridge.indexOf("const records =")));
  assert.doesNotMatch(records, /label:/, "encrypted Clock labels never cross into native preferences");
});

test("AlarmManager identity uses the full validated item id and replacement fails closed", () => {
  const java = read("App_Resources/Android/src/main/java/com/faceclaw/app/FaceclawClockScheduler.java");
  const pending = java.slice(java.indexOf("private static PendingIntent pendingIntent"), java.indexOf("private static long nextRepeatingFire"));
  assert.match(pending, /intent\.setData\(new Uri\.Builder\(\)/);
  assert.match(pending, /\.authority\(context\.getPackageName\(\)\)/);
  assert.match(pending, /\.appendPath\(itemId\)/);
  assert.match(pending, /getBroadcast\(context, 0, intent, flags\)/);
  assert.doesNotMatch(pending, /hashCode\(\)/);

  const replace = java.slice(java.indexOf("public static synchronized void replaceAll"), java.indexOf("public static synchronized void rescheduleAll"));
  assert.ok(replace.indexOf("if (!editor.commit())") < replace.indexOf("cancelAlarm(appContext"),
    "durable replacement commits before old alarms can be cancelled");
  assert.match(replace, /next == null[\s\S]*throw new IllegalArgumentException/);
  assert.match(java, /if \(record == null \|\| records\.put\(record\.itemId, record\) != null\) return null/);
});

test("boot/time lifecycle reschedules and live timezone changes converge into encrypted store", () => {
  const manifest = read("App_Resources/Android/src/main/AndroidManifest.xml");
  assert.match(manifest, /android\.permission\.RECEIVE_BOOT_COMPLETED/);
  for (const action of ["BOOT_COMPLETED", "TIME_SET", "TIMEZONE_CHANGED"]) {
    assert.match(manifest, new RegExp(`android\\.intent\\.action\\.${action}`));
  }
  assert.doesNotMatch(manifest, /LOCKED_BOOT_COMPLETED/,
    "credential-protected Clock state is recovered only after ordinary boot unlock");
  const receiver = read("App_Resources/Android/src/main/java/com/faceclaw/app/FaceclawClockReceiver.java");
  assert.match(receiver, /FaceclawClockScheduler\.rescheduleAll/);
  assert.match(receiver, /FaceclawClockScheduler\.notifyTimeChanged/);
  const coordinator = read("app/clock/alert-coordinator.ts");
  assert.match(coordinator, /reconcileDue\(now\)[\s\S]*reconcileWallClockSchedules\(now\)/);
});

test("Clock notification is excluded before app-owned timer mirror exception", () => {
  const service = read("App_Resources/Android/src/main/java/com/faceclaw/app/FaceclawMediaNotificationListenerService.java");
  const candidate = service.slice(service.indexOf("private static boolean isNotificationMirrorCandidate"), service.indexOf("private static boolean hasDisplayableContent"));
  assert.ok(candidate.indexOf("FaceclawClockScheduler.isClockNotification") < candidate.indexOf("FaceclawTimerNotifications.isTimerNotification"));
});

test("Clock buzzer stop preempts queued sounds and controller intercepts ring before lock routing", () => {
  const java = read("App_Resources/Android/src/main/java/com/faceclaw/app/FaceclawBleCommunicator.java");
  const stop = java.slice(java.indexOf("public void stopBuzzerUrgent"), java.indexOf("public boolean sendShutdown", java.indexOf("public void stopBuzzerUrgent")));
  assert.match(stop, /clearMessagesOfKindLocked\("sound"\)/);
  assert.match(stop, /clearMessagesOfKindLocked\("clock-sound"\)/);
  assert.match(stop, /new byte\[\] \{ 0x05, 0x02, 0x00 \}/);
  assert.match(stop, /pendingMessages\.addFirst\(message\)/);

  const controller = read("app/g2/dashboard-controller.ts");
  const input = controller.slice(controller.indexOf("private async handleInputEvent"), controller.indexOf("/** Launch or focus", controller.indexOf("private async handleInputEvent")));
  assert.ok(input.indexOf("clockAlertCoordinator.handleRingStop()") < input.indexOf("if (this.glassesLocked)"));
  assert.match(input, /TOUCH_EVENT_FROM_RING[\s\S]*inputEvent\.type === "click"[\s\S]*inputEvent\.type === "double-click"/);
});

test("off-head preparation is blank-first and Clock visuals require an exact strict receipt", () => {
  const controller = read("app/g2/dashboard-controller.ts");
  const prepare = controller.slice(controller.indexOf("private async prepareClockAlertSession"), controller.indexOf("private async showClockAlertVisual"));
  assert.ok(prepare.indexOf("setScreenBlanked(true)") < prepare.indexOf("resumeEvenHubSession()"));
  assert.match(prepare, /clockAlertSessionLeaseActive = true/);
  const suspend = controller.slice(controller.indexOf("private scheduleEvenHubSuspend"), controller.indexOf("private cancelEvenHubSuspendTimer"));
  assert.match(suspend, /clockAlertSessionLeaseActive/);

  const shell = read("app/ui/shell/shell.ts");
  const visual = shell.slice(shell.indexOf("async showClockAlert"), shell.indexOf("closeClockAlert", shell.indexOf("async showClockAlert")));
  assert.match(visual, /waitForShellRenderIdle/);
  assert.match(visual, /bumpDeliveryNonce\(\)/);
  assert.match(visual, /requestShellDelivery\(isOwner\)/);
  const layer = read("app/ui/shell/clock-alert-layer.ts");
  assert.match(layer, /new GrayImage\(width, height, 1\)/,
    "nonzero full-frame background masks retained HUD surfaces");
});

test("off-head second high minute is replayed at the bounded phrase deadline", () => {
  const coordinator = read("app/clock/alert-coordinator.ts");
  assert.match(coordinator, /this\.now\(\) >= this\.playedPhraseEndsAtMs/);
  assert.match(coordinator, /this\.playedPhraseEndsAtMs = acceptedAt \+ CLOCK_ALERT_PHRASE_MS/);
  assert.match(coordinator, /this\.audioSessionActive && this\.playedPhase !== null \? this\.playedPhraseEndsAtMs : null/);
});

test("confirmed off-head ownership survives an unknown reconnect before ON_HEAD", () => {
  const coordinator = read("app/clock/alert-coordinator.ts");
  const wear = coordinator.slice(coordinator.indexOf("setWearState(next"), coordinator.indexOf("/** Ring single", coordinator.indexOf("setWearState(next")));
  assert.match(wear, /activeConfirmedOffHead[\s\S]*entry\.confirmedOffHead/);
  assert.match(wear, /next === "worn" && \(previous === "not-worn" \|\| activeConfirmedOffHead\)/);
  assert.match(wear, /this\.timeline\.setWearState\(next\);[\s\S]*this\.persistTimelineRouting\(\)/,
    "OFF_HEAD routing is durable before the next buzzer phrase");
  assert.match(wear, /Initial UNKNOWN→ON_HEAD[\s\S]*this\.persistTimelineRouting\(\)/,
    "initial worn classification also patches an already-ACKed native campaign");
  const scheduler = read("App_Resources/Android/src/main/java/com/faceclaw/app/FaceclawClockScheduler.java");
  assert.match(scheduler, /updateCampaignRouting[\s\S]*prior\.withRouting/);
  assert.match(coordinator, /if \(accepted\)[\s\S]*this\.persistTimelineRouting\(\)/,
    "an OFF_HEAD event racing the first firmware ACK is patched after acceptance");
});

test("countdowns are monotonic, alarm dates are native, and cold due edges are durable", () => {
  const java = read("App_Resources/Android/src/main/java/com/faceclaw/app/FaceclawClockScheduler.java");
  assert.match(java, /AlarmManager\.ELAPSED_REALTIME_WAKEUP/);
  assert.match(java, /SystemClock\.elapsedRealtime\(\)/);
  assert.match(java, /timerGeneration/);
  assert.match(java, /savePendingFire[\s\S]*scheduleGeneration/);
  assert.match(java, /isPendingFireCurrent[\s\S]*active\.scheduleGeneration == scheduleGeneration/);
  assert.match(java, /bootCount/);
  assert.match(java, /record\.elapsedDueMs - elapsedNow/,
    "TIME_SET reprojects rather than shortening/extending a countdown");
  assert.match(java, /oneShotFire\(record\)/);
  assert.match(java, /object\.put\("date", date\)/);
  assert.match(java, /savePendingFire\(appContext, current\)/);
  assert.ok(java.indexOf("savePendingFire(appContext, current)") < java.indexOf("active.onClockAlarm"));
  assert.match(java, /acquireRecoveryLease\(appContext\)/);

  const service = read("App_Resources/Android/src/main/java/com/faceclaw/app/FaceclawForegroundService.java");
  assert.match(service, /CLOCK_RECOVERY_WAKE_MS = 65_000L/);
  assert.match(service, /PowerManager\.PARTIAL_WAKE_LOCK/);
  assert.match(service, /setClockRecoveryWakeLock\(clockAlertActive\)/);
  assert.match(service, /setClockRecoveryWakeLock\(false\)/);
  assert.match(service, /postDelayed\(clockRecoveryTimeout, CLOCK_RECOVERY_WAKE_MS\)/,
    "a missing runtime or failed BLE recovery cannot pin the FGS indefinitely");
  assert.match(service, /clockAlertActive = false[\s\S]*stopForeground/);

  const manifest = read("App_Resources/Android/src/main/AndroidManifest.xml");
  assert.match(manifest, /android\.permission\.USE_EXACT_ALARM/);
  assert.doesNotMatch(manifest, /android\.permission\.SCHEDULE_EXACT_ALARM/);
  const entry = read("app/app.ts");
  assert.ok(entry.indexOf("./g2/dashboard-controller") < entry.indexOf("Application.run"));
});

test("native fire generation crosses the inbox and rejects a replaced schedule", () => {
  const java = read("App_Resources/Android/src/main/java/com/faceclaw/app/FaceclawClockScheduler.java");
  assert.match(java, /onClockAlarm\(itemId, current\.kind, dueAtMs, current\.scheduleGeneration\)/);
  assert.match(java, /put\("scheduleGeneration", record\.scheduleGeneration\)/);
  const bridge = read("app/native/clock-scheduler.ts");
  assert.match(bridge, /scheduleGeneration: Number\(scheduleGeneration\)/);
  assert.match(bridge, /isFireCurrent\(fire: ClockNativeFire\)/);
  const coordinator = read("app/clock/alert-coordinator.ts");
  assert.match(coordinator, /clockSchedulerBridge\.isFireCurrent\(event\)/);
  assert.match(coordinator, /clockSchedulerBridge\.isFireCurrent\(fire\)/);
});

test("native fire retries timers on the elapsed clock and leases recovery only after a durable edge", () => {
  const java = read("App_Resources/Android/src/main/java/com/faceclaw/app/FaceclawClockScheduler.java");
  const fire = java.slice(
    java.indexOf("static void handleFire"),
    java.indexOf("static void handleCampaignWake"),
  );
  const staleValidation = fire.indexOf("current == null || current.dueAtMs != dueAtMs");
  const durableEdge = fire.indexOf("savePendingFire(appContext, current)");
  const recoveryLease = fire.indexOf("acquireRecoveryLease(appContext)");
  assert.ok(staleValidation >= 0 && staleValidation < durableEdge,
    "a stale PendingIntent returns before any durable recovery work");
  assert.ok(durableEdge >= 0 && durableEdge < recoveryLease,
    "the recovery FGS starts only after the due edge is durably materialized");

  const failedCommit = fire.slice(durableEdge, recoveryLease);
  assert.match(failedCommit, /"timer"\.equals\(current\.kind\)[\s\S]*SystemClock\.elapsedRealtime\(\) \+ 5_000L[\s\S]*System\.currentTimeMillis\(\) \+ 5_000L/,
    "timer retries remain on AlarmManager's elapsed-realtime timebase");
  assert.doesNotMatch(failedCommit, /setRecoveryLease/,
    "a failed pending-fire commit cannot leave a recovery-service lease behind");
});

test("firmware ACK durably anchors campaigns and terminal edges invalidate in-flight playback", () => {
  const java = read("App_Resources/Android/src/main/java/com/faceclaw/app/FaceclawBleCommunicator.java");
  const play = java.slice(java.indexOf("public boolean playClockBuzzerSequence"), java.indexOf("public void stopBuzzerUrgent"));
  assert.match(play, /message\.onAck/);
  assert.match(play, /recordCampaignAck\(appContext, campaignJson\)/);
  const ack = play.slice(play.indexOf("message.onAck"), play.indexOf("message.onTimeout"));
  assert.ok(ack.indexOf("recordCampaignAck") < ack.indexOf("deliverClockBuzzerReceipt"));
  assert.match(play, /message\.onTimeout[\s\S]*rejected\.run\(\)/);

  const coordinator = read("app/clock/alert-coordinator.ts");
  assert.match(coordinator, /restored\?\.startedAtMs \?\? null/);
  assert.match(coordinator, /timeline\.restoreTiming\(occurrence\.id, restored\.startedAtMs\)/);
  assert.match(coordinator, /this\.playedPhraseEndsAtMs = restoredPhraseEndsAtMs/,
    "wall-clock rollback replaces rather than maxes the old phrase projection");
  assert.match(coordinator, /clockSchedulerBridge\.campaigns\(\)/);
  assert.match(coordinator, /this\.cancellationEpoch\+\+[\s\S]*this\.hardware\?\.stop\(\)/);
  assert.match(coordinator, /operationEpoch !== this\.cancellationEpoch/);
  assert.match(coordinator, /if \(!presented\) this\.schedulePhaseAt\(this\.now\(\) \+ AUDIO_RETRY_MS\)/);
  const putOn = coordinator.slice(coordinator.indexOf("private async acknowledgeAfterPutOn"), coordinator.indexOf("private async ensureVisual"));
  assert.ok(putOn.indexOf("markOccurrenceSilent") < putOn.indexOf("presentSilentOrClose"));
  assert.match(putOn, /if \(presented\)[\s\S]*dismissOccurrence/,
    "put-on feedback remains durable until a strict frame receipt");
});

test("a native phrase-boundary alarm cold-recovers low/high after process death", () => {
  const scheduler = read("App_Resources/Android/src/main/java/com/faceclaw/app/FaceclawClockScheduler.java");
  const receipt = scheduler.slice(
    scheduler.indexOf("recordCampaignAck"),
    scheduler.indexOf("public static String campaignsJson"),
  );
  assert.ok(receipt.indexOf("editor.commit()") < receipt.indexOf("scheduleCampaignWake"),
    "campaign state commits before its cold recovery edge is scheduled");
  assert.match(scheduler, /ACTION_CAMPAIGN_WAKE/);
  assert.match(scheduler, /scheduleCampaignWakeAt[\s\S]*AlarmManager\.ELAPSED_REALTIME_WAKEUP/);
  assert.match(scheduler, /CAMPAIGN_RECOVERY_RETRY_MS = 15_000L/);
  assert.match(scheduler, /handleCampaignWake[\s\S]*acquireRecoveryLease[\s\S]*notifyTimeChanged/);
  const clear = scheduler.slice(
    scheduler.indexOf("public static boolean clearCampaigns"),
    scheduler.indexOf("updateCampaignRouting"),
  );
  assert.ok(clear.indexOf("editor.commit()") < clear.indexOf("cancelCampaignWake"));

  const receiver = read("App_Resources/Android/src/main/java/com/faceclaw/app/FaceclawClockReceiver.java");
  assert.match(receiver, /ACTION_CAMPAIGN_WAKE[\s\S]*handleCampaignWake/);
});

test("full occurrence capacity backs off instead of spinning an overdue 0 ms timer", () => {
  const coordinator = read("app/clock/alert-coordinator.ts");
  assert.match(coordinator, /dueRetryNotBeforeMs = this\.now\(\) \+ AUDIO_RETRY_MS/);
  assert.match(coordinator, /Math\.max\(0, next\.nextFireAtMs - now, this\.dueRetryNotBeforeMs - now\)/);
});

test("headless recovery checks BLE authority without requiring an Activity", () => {
  const permissions = read("app/g2/android-permissions.ts");
  const ensure = permissions.slice(permissions.indexOf("async function ensurePermissions"), permissions.indexOf("export async function ensureBlePermissions"));
  assert.ok(ensure.indexOf("missing.length === 0") < ensure.indexOf("getActivity()"));
  const ble = permissions.slice(permissions.indexOf("function getRequiredBlePermissions"), permissions.indexOf("function isPermissionGranted"));
  assert.doesNotMatch(ble, /POST_NOTIFICATIONS/);
  const controller = read("app/g2/dashboard-controller.ts");
  assert.match(controller, /ensureClockRecoveryConnection/);
  assert.match(controller, /clockRecoveryConnectActive[\s\S]*setScreenBlanked\(true\)/);
});
