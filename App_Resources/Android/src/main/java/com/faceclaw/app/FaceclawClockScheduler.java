package com.faceclaw.app;

import android.app.AlarmManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.os.SystemClock;
import android.provider.Settings;
import android.service.notification.StatusBarNotification;
import android.util.Log;

import com.tns.NativeScriptActivity;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Calendar;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;

import androidx.core.content.ContextCompat;

/**
 * Durable Android AlarmManager mirror for the phone-owned Clock store.
 *
 * The TypeScript store remains authoritative. This mirror provides exact
 * wake-up, survives process death/reboot, and dispatches a tiny due edge to an
 * active NativeScript runtime. A phone notification is always posted as the
 * fallback; the notification mirror explicitly excludes this channel so the
 * direct glasses alert is never duplicated as a generic phone notification.
 */
public final class FaceclawClockScheduler {
    public static final String CHANNEL_ID = "faceclaw-clock-alerts";
    public static final String ACTION_FIRE = "com.faceclaw.app.action.CLOCK_FIRE";
    public static final String ACTION_CAMPAIGN_WAKE = "com.faceclaw.app.action.CLOCK_CAMPAIGN_WAKE";
    public static final String EXTRA_ITEM_ID = "itemId";
    public static final String EXTRA_DUE_AT_MS = "dueAtMs";
    private static final String EXTRA_OCCURRENCE_ID = "occurrenceId";
    private static final String EXTRA_PHRASE_ENDS_ELAPSED_MS = "phraseEndsElapsedMs";

    private static final String TAG = "FaceclawClock";
    private static final String PREFS_NAME = "faceclaw-clock-schedules";
    private static final String RECORD_PREFIX = "record:";
    private static final String FIRE_PREFIX = "fire:";
    private static final String CAMPAIGN_PREFIX = "campaign:";
    private static final String NOTIFICATION_TAG_PREFIX = "faceclaw-clock:";
    private static final long WAKE_LOCK_TIMEOUT_MS = 10_000L;
    private static final long TIMER_PROJECTION_TOLERANCE_MS = 1_500L;
    private static final long CAMPAIGN_RECOVERY_RETRY_MS = 15_000L;
    private static volatile FaceclawClockAlarmListener listener;

    private FaceclawClockScheduler() {}

    public static void setListener(FaceclawClockAlarmListener next) {
        listener = next;
    }

    public static boolean canScheduleExactAlarms(Context context) {
        if (context == null) return false;
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return true;
        AlarmManager manager = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        return manager != null && manager.canScheduleExactAlarms();
    }

    /** Replace the complete native mirror in one bounded, validated operation. */
    public static synchronized void replaceAll(Context context, String encoded) {
        if (context == null) return;
        Context appContext = context.getApplicationContext();
        Map<String, Record> next = decodeRecords(encoded);
        if (next == null) {
            throw new IllegalArgumentException("invalid Clock schedule mirror");
        }
        Map<String, Record> prior = loadRecords(appContext);
        long wallNow = System.currentTimeMillis();
        long elapsedNow = SystemClock.elapsedRealtime();
        int bootCount = bootCount(appContext);
        Map<String, Record> effectiveNext = new HashMap<>();
        for (Record candidate : next.values()) {
            Record priorRecord = prior.get(candidate.itemId);
            effectiveNext.put(candidate.itemId, candidate.kind.equals("timer")
                    ? prepareTimerRecord(candidate, priorRecord, wallNow, elapsedNow, bootCount)
                    : candidate);
        }
        SharedPreferences.Editor editor = preferences(appContext).edit();
        for (String key : preferences(appContext).getAll().keySet()) {
            if (key.startsWith(RECORD_PREFIX)) editor.remove(key);
        }
        for (Record record : effectiveNext.values()) {
            String recordEncoded = record.encode();
            if (recordEncoded.isEmpty()) throw new IllegalArgumentException("invalid Clock record");
            editor.putString(recordKey(record.itemId), recordEncoded);
        }
        // Persist first. If disk commit fails, the prior AlarmManager mirror is
        // still intact; never cancel durable alarms on a failed replacement.
        if (!editor.commit()) throw new IllegalStateException("Clock schedule persistence failed");
        for (Record record : prior.values()) {
            if (!effectiveNext.containsKey(record.itemId)) cancelAlarm(appContext, record.itemId);
        }
        for (Record record : effectiveNext.values()) scheduleAlarm(appContext, record);
    }

    /** Rebuild AlarmManager registrations after boot or wall-clock changes. */
    public static synchronized void rescheduleAll(Context context, String reason) {
        if (context == null) return;
        Context appContext = context.getApplicationContext();
        long now = System.currentTimeMillis();
        long elapsedNow = SystemClock.elapsedRealtime();
        int currentBoot = bootCount(appContext);
        Map<String, Record> records = loadRecords(appContext);
        for (Record record : new ArrayList<>(records.values())) {
            Record effective = record;
            if (record.kind.equals("timer")) {
                long remaining;
                if (Intent.ACTION_BOOT_COMPLETED.equals(reason) || record.bootCount != currentBoot) {
                    // ELAPSED_REALTIME resets at reboot. Recover from the last
                    // wall projection, bounded to the timer's original length.
                    remaining = clamp(record.dueAtMs - now, 0L, record.durationMs);
                } else {
                    // Wall/timezone changes never alter a running countdown.
                    remaining = Math.max(0L, record.elapsedDueMs - elapsedNow);
                }
                effective = record.withTimerRuntime(
                        now + remaining,
                        elapsedNow + remaining,
                        currentBoot,
                        record.scheduleGeneration);
                if (!saveRecord(appContext, effective)) {
                    Log.w(TAG, "skip Clock timer reschedule; persistence failed for " + record.itemId);
                    continue;
                }
            } else if (record.isRepeating() && record.dueAtMs > now && (
                    Intent.ACTION_BOOT_COMPLETED.equals(reason)
                            || Intent.ACTION_TIME_CHANGED.equals(reason)
                            || Intent.ACTION_TIMEZONE_CHANGED.equals(reason))) {
                long next = nextRepeatingFire(record, now);
                if (next > 0) {
                    effective = record.withDueAt(next);
                    if (!saveRecord(appContext, effective)) {
                        Log.w(TAG, "skip Clock reschedule; persistence failed for " + record.itemId);
                        continue;
                    }
                }
            } else if (record.isOneShotAlarm() && (
                    Intent.ACTION_BOOT_COMPLETED.equals(reason)
                            || Intent.ACTION_TIME_CHANGED.equals(reason)
                            || Intent.ACTION_TIMEZONE_CHANGED.equals(reason))) {
                long candidate = oneShotFire(record);
                if (candidate > 0L && candidate != record.dueAtMs) {
                    effective = record.withDueAt(candidate);
                    if (!saveRecord(appContext, effective)) {
                        Log.w(TAG, "skip one-shot Clock reschedule; persistence failed for " + record.itemId);
                        continue;
                    }
                }
            }
            // Overdue repeating/one-shot alarms retain their old due edge and
            // fire immediately; handleFire rearms only after persisting it.
            scheduleAlarm(appContext, effective);
        }
        rescheduleCampaignWakes(appContext);
    }

    /** Notify the live encrypted store after native time/timezone recovery. */
    public static void notifyTimeChanged(String action) {
        FaceclawClockAlarmListener active = listener;
        if (active == null) return;
        try {
            active.onClockTimeChanged(action == null ? "" : action);
        } catch (Throwable error) {
            Log.w(TAG, "active Clock time-change dispatch failed", error);
        }
    }

    static void handleFire(Context context, Intent intent) {
        if (context == null || intent == null || !ACTION_FIRE.equals(intent.getAction())) return;
        Context appContext = context.getApplicationContext();
        String itemId = safeItemId(intent.getStringExtra(EXTRA_ITEM_ID));
        long dueAtMs = intent.getLongExtra(EXTRA_DUE_AT_MS, -1L);
        if (itemId == null || dueAtMs < 0L) return;

        PowerManager.WakeLock wakeLock = null;
        try {
            PowerManager powerManager = (PowerManager) appContext.getSystemService(Context.POWER_SERVICE);
            if (powerManager != null) {
                wakeLock = powerManager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Faceclaw:ClockReceiver");
                wakeLock.setReferenceCounted(false);
                wakeLock.acquire(WAKE_LOCK_TIMEOUT_MS);
            }
            Record current = loadRecord(appContext, itemId);
            if (current == null || current.dueAtMs != dueAtMs) {
                return; // stale PendingIntent from a replaced/cancelled schedule
            }

            if (!savePendingFire(appContext, current)) {
                Log.w(TAG, "Clock due edge persistence failed; retrying receiver");
                scheduleAlarmAt(appContext, current, "timer".equals(current.kind)
                        ? SystemClock.elapsedRealtime() + 5_000L
                        : System.currentTimeMillis() + 5_000L);
                return;
            }
            acquireRecoveryLease(appContext);

            if (current.isRepeating()) {
                long next = nextRepeatingFire(current, Math.max(System.currentTimeMillis(), dueAtMs));
                if (next > 0L) {
                    Record rearmed = current.withDueAt(next);
                    if (saveRecord(appContext, rearmed)) {
                        scheduleAlarm(appContext, rearmed);
                    } else {
                        Log.w(TAG, "repeating Clock alarm was not rearmed; persistence failed");
                    }
                } else {
                    if (!removeRecord(appContext, itemId)) {
                        Log.w(TAG, "Clock record removal failed for " + itemId);
                    }
                }
            } else {
                if (!removeRecord(appContext, itemId)) {
                    Log.w(TAG, "Clock record removal failed for " + itemId);
                }
            }

            showNotification(appContext, current);
            FaceclawClockAlarmListener active = listener;
            if (active != null) {
                try {
                    active.onClockAlarm(itemId, current.kind, dueAtMs, current.scheduleGeneration);
                } catch (Throwable error) {
                    Log.w(TAG, "active Clock dispatch failed", error);
                }
            }
        } finally {
            if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        }
    }

    /**
     * Exact phrase-boundary wake. Firmware autonomously plays one minute, but
     * this AlarmManager edge cold-starts the runtime for low→high and the
     * off-head second-high minute even if Android killed the prior process.
     */
    static void handleCampaignWake(Context context, Intent intent) {
        if (context == null || intent == null || !ACTION_CAMPAIGN_WAKE.equals(intent.getAction())) return;
        Context appContext = context.getApplicationContext();
        String occurrenceId = safeOccurrenceId(intent.getStringExtra(EXTRA_OCCURRENCE_ID));
        long phraseToken = intent.getLongExtra(EXTRA_PHRASE_ENDS_ELAPSED_MS, -1L);
        if (occurrenceId == null || phraseToken < 0L) return;
        Campaign campaign = loadCampaign(appContext, occurrenceId);
        if (campaign == null || campaign.phraseEndsElapsedMs != phraseToken) return;

        acquireRecoveryLease(appContext);
        // Keep a bounded follow-up edge until the next phrase ACK replaces it
        // or the total 2/3-minute campaign is terminal. This covers a cold BLE
        // reconnect that outlives the first boundary callback.
        scheduleCampaignRecoveryRetry(appContext, campaign);
        notifyTimeChanged(ACTION_CAMPAIGN_WAKE);
    }

    /** Durable due edges are acknowledged only after the encrypted store commits. */
    public static String pendingFiresJson(Context context) {
        JSONArray result = new JSONArray();
        if (context == null) return result.toString();
        for (Map.Entry<String, ?> entry : preferences(context).getAll().entrySet()) {
            if (!entry.getKey().startsWith(FIRE_PREFIX) || !(entry.getValue() instanceof String)) continue;
            try {
                JSONObject object = new JSONObject((String) entry.getValue());
                String itemId = safeItemId(object.optString("itemId", null));
                String kind = object.optString("kind", "");
                long dueAtMs = object.optLong("dueAtMs", -1L);
                long generation = object.optLong("scheduleGeneration", -1L);
                if (itemId != null && ("timer".equals(kind) || "alarm".equals(kind)) &&
                        dueAtMs >= 0L && generation >= 1L) {
                    result.put(object);
                }
            } catch (Throwable ignored) {}
        }
        return result.toString();
    }

    public static boolean acknowledgePendingFire(Context context, String itemId, long dueAtMs) {
        if (context == null || safeItemId(itemId) == null || dueAtMs < 0L) return false;
        return preferences(context).edit().remove(fireKey(itemId, dueAtMs)).commit();
    }

    /** Reject a persisted due edge if a newer logical schedule now owns the item. */
    public static boolean isPendingFireCurrent(
            Context context, String itemId, String kind, long dueAtMs, long scheduleGeneration) {
        if (context == null || safeItemId(itemId) == null ||
                !("timer".equals(kind) || "alarm".equals(kind)) ||
                dueAtMs < 0L || scheduleGeneration < 1L) return false;
        String encoded = preferences(context).getString(fireKey(itemId, dueAtMs), "");
        if (encoded == null || encoded.isEmpty()) return false;
        try {
            JSONObject fire = new JSONObject(encoded);
            if (!itemId.equals(fire.optString("itemId", "")) ||
                    !kind.equals(fire.optString("kind", "")) ||
                    dueAtMs != fire.optLong("dueAtMs", -1L) ||
                    scheduleGeneration != fire.optLong("scheduleGeneration", -1L)) return false;
        } catch (Throwable ignored) { return false; }
        Record active = loadRecord(context, itemId);
        return active == null || (active.kind.equals(kind) &&
                active.scheduleGeneration == scheduleGeneration);
    }

    /** Current wall projections of elapsed-realtime timer deadlines. */
    public static String timerDeadlinesJson(Context context) {
        JSONArray result = new JSONArray();
        if (context == null) return result.toString();
        long wallNow = System.currentTimeMillis();
        long elapsedNow = SystemClock.elapsedRealtime();
        int currentBoot = bootCount(context);
        for (Record record : loadRecords(context).values()) {
            if (!"timer".equals(record.kind)) continue;
            long remaining = record.bootCount == currentBoot
                    ? Math.max(0L, record.elapsedDueMs - elapsedNow)
                    : clamp(record.dueAtMs - wallNow, 0L, record.durationMs);
            try {
                result.put(new JSONObject()
                        .put("itemId", record.itemId)
                        .put("nextFireAtMs", wallNow + remaining)
                        .put("scheduleGeneration", record.scheduleGeneration));
            } catch (Throwable ignored) {}
        }
        return result.toString();
    }

    /** Persist the accepted phrase before its positive receipt reaches JS. */
    public static synchronized boolean recordCampaignAck(Context context, String encoded) {
        if (context == null || encoded == null || encoded.length() > 64 * 1024) return false;
        try {
            JSONObject input = new JSONObject(encoded);
            String phase = input.optString("phase", "");
            JSONArray occurrences = input.optJSONArray("occurrences");
            if (!("low".equals(phase) || "high".equals(phase)) ||
                    occurrences == null || occurrences.length() < 1 || occurrences.length() > 128) return false;
            long wallNow = System.currentTimeMillis();
            long elapsedNow = SystemClock.elapsedRealtime();
            int currentBoot = bootCount(context);
            SharedPreferences.Editor editor = preferences(context).edit();
            Set<String> seen = new HashSet<>();
            ArrayList<Campaign> acceptedCampaigns = new ArrayList<>();
            for (int index = 0; index < occurrences.length(); index++) {
                JSONObject item = occurrences.optJSONObject(index);
                if (item == null) return false;
                String occurrenceId = item.optString("occurrenceId", "");
                String itemId = safeItemId(item.optString("itemId", null));
                long dueAtMs = item.optLong("dueAtMs", -1L);
                if (!occurrenceId.matches("occ_[a-f0-9]{32}") || itemId == null || dueAtMs < 0L ||
                        !seen.add(occurrenceId)) return false;
                Object extendedValue = item.opt("extendedForOffHead");
                Object confirmedValue = item.opt("confirmedOffHead");
                if (!(extendedValue instanceof Boolean) || !(confirmedValue instanceof Boolean)) return false;
                boolean extended = (Boolean) extendedValue;
                boolean confirmed = (Boolean) confirmedValue;
                Campaign prior = loadCampaign(context, occurrenceId);
                long startedWall = wallNow;
                long startedElapsed = elapsedNow;
                if (prior != null && prior.itemId.equals(itemId) && prior.dueAtMs == dueAtMs) {
                    startedWall = prior.startedWallMs;
                    startedElapsed = prior.startedElapsedMs;
                    if (prior.bootCount == currentBoot && prior.phraseEndsElapsedMs > 0L &&
                            elapsedNow > prior.phraseEndsElapsedMs) {
                        long delay = elapsedNow - prior.phraseEndsElapsedMs;
                        startedWall += delay;
                        startedElapsed += delay;
                    }
                }
                Campaign campaign = new Campaign(
                        occurrenceId, itemId, dueAtMs, startedWall, startedElapsed,
                        wallNow + 60_000L, elapsedNow + 60_000L,
                        currentBoot, phase, extended, confirmed);
                editor.putString(campaignKey(occurrenceId), campaign.encode());
                acceptedCampaigns.add(campaign);
            }
            if (!editor.commit()) return false;
            for (Campaign campaign : acceptedCampaigns) scheduleCampaignWake(context, campaign);
            return true;
        } catch (Throwable error) {
            Log.w(TAG, "reject invalid Clock campaign receipt", error);
            return false;
        }
    }

    public static String campaignsJson(Context context) {
        JSONArray result = new JSONArray();
        if (context == null) return result.toString();
        long wallNow = System.currentTimeMillis();
        long elapsedNow = SystemClock.elapsedRealtime();
        int currentBoot = bootCount(context);
        for (Map.Entry<String, ?> entry : preferences(context).getAll().entrySet()) {
            if (!entry.getKey().startsWith(CAMPAIGN_PREFIX) || !(entry.getValue() instanceof String)) continue;
            try {
                Campaign campaign = Campaign.decode(new JSONObject((String) entry.getValue()));
                if (campaign == null) continue;
                boolean sameBoot = campaign.bootCount == currentBoot && elapsedNow >= campaign.startedElapsedMs;
                long startedAt = sameBoot
                        ? wallNow - Math.max(0L, elapsedNow - campaign.startedElapsedMs)
                        : campaign.startedWallMs;
                long phraseEndsAt = sameBoot
                        ? wallNow + Math.max(0L, campaign.phraseEndsElapsedMs - elapsedNow)
                        : campaign.phraseEndsWallMs;
                result.put(new JSONObject()
                        .put("occurrenceId", campaign.occurrenceId)
                        .put("itemId", campaign.itemId)
                        .put("dueAtMs", campaign.dueAtMs)
                        .put("startedAtMs", startedAt)
                        .put("phraseEndsAtMs", phraseEndsAt)
                        .put("phase", campaign.phase)
                        .put("extendedForOffHead", campaign.extendedForOffHead)
                        .put("confirmedOffHead", campaign.confirmedOffHead));
            } catch (Throwable ignored) {}
        }
        return result.toString();
    }

    public static boolean clearCampaigns(Context context, String encodedIds) {
        if (context == null || encodedIds == null || encodedIds.length() > 16 * 1024) return false;
        try {
            JSONArray ids = new JSONArray(encodedIds);
            if (ids.length() > 128) return false;
            SharedPreferences.Editor editor = preferences(context).edit();
            Set<String> seen = new HashSet<>();
            ArrayList<String> cleared = new ArrayList<>();
            for (int index = 0; index < ids.length(); index++) {
                String id = ids.optString(index, "");
                if (!id.matches("occ_[a-f0-9]{32}") || !seen.add(id)) return false;
                editor.remove(campaignKey(id));
                cleared.add(id);
            }
            if (!editor.commit()) return false;
            for (String id : cleared) cancelCampaignWake(context, id);
            return true;
        } catch (Throwable ignored) {
            return false;
        }
    }

    /** Persist live OFF_HEAD routing even when no new buzzer phrase is due. */
    public static synchronized boolean updateCampaignRouting(Context context, String encoded) {
        if (context == null || encoded == null || encoded.length() > 32 * 1024) return false;
        try {
            JSONArray items = new JSONArray(encoded);
            if (items.length() < 1 || items.length() > 128) return false;
            SharedPreferences.Editor editor = preferences(context).edit();
            Set<String> seen = new HashSet<>();
            boolean changed = false;
            for (int index = 0; index < items.length(); index++) {
                JSONObject item = items.optJSONObject(index);
                if (item == null) return false;
                String occurrenceId = item.optString("occurrenceId", "");
                Object extendedValue = item.opt("extendedForOffHead");
                Object confirmedValue = item.opt("confirmedOffHead");
                if (!occurrenceId.matches("occ_[a-f0-9]{32}") || !seen.add(occurrenceId) ||
                        !(extendedValue instanceof Boolean) || !(confirmedValue instanceof Boolean)) return false;
                Campaign prior = loadCampaign(context, occurrenceId);
                if (prior == null) continue; // first firmware ACK has not landed yet
                boolean extended = (Boolean) extendedValue;
                boolean confirmed = (Boolean) confirmedValue;
                if (prior.extendedForOffHead == extended && prior.confirmedOffHead == confirmed) continue;
                editor.putString(campaignKey(occurrenceId), prior.withRouting(extended, confirmed).encode());
                changed = true;
            }
            return !changed || editor.commit();
        } catch (Throwable error) {
            Log.w(TAG, "reject invalid Clock campaign routing", error);
            return false;
        }
    }

    public static void setRecoveryLease(Context context, boolean active) {
        if (context == null) return;
        Intent service = new Intent(context, FaceclawForegroundService.class);
        service.setAction(FaceclawForegroundService.ACTION_UPDATE);
        service.putExtra(FaceclawForegroundService.EXTRA_CLOCK_ALERT_ACTIVE, active);
        if (active) {
            ContextCompat.startForegroundService(context, service);
        } else {
            try {
                context.startService(service);
            } catch (IllegalStateException ignored) {
                // Android O+ can reject an ordinary background start after the
                // service has already disappeared. Release is idempotent: an
                // absent service owns no Clock recovery lease.
                Log.i(TAG, "Clock recovery service already absent");
            }
        }
    }

    public static void dismissNotification(Context context, String itemId, long dueAtMs) {
        if (context == null) return;
        String safeId = safeItemId(itemId);
        if (safeId == null || dueAtMs < 0L) return;
        NotificationManager manager =
                (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager != null) manager.cancel(notificationTag(safeId, dueAtMs), notificationId(safeId, dueAtMs));
    }

    public static boolean isClockNotification(StatusBarNotification item) {
        if (item == null || item.getNotification() == null) return false;
        String tag = item.getTag();
        if (tag != null && tag.startsWith(NOTIFICATION_TAG_PREFIX)) return true;
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                && CHANNEL_ID.equals(item.getNotification().getChannelId());
    }

    private static Map<String, Record> decodeRecords(String encoded) {
        Map<String, Record> records = new HashMap<>();
        if (encoded == null || encoded.length() > 128 * 1024) return null;
        try {
            JSONArray array = new JSONArray(encoded);
            if (array.length() > 128) return null;
            for (int index = 0; index < array.length(); index++) {
                Record record = Record.decode(array.optJSONObject(index));
                if (record == null || records.put(record.itemId, record) != null) return null;
            }
        } catch (Throwable error) {
            Log.w(TAG, "reject invalid Clock schedule mirror", error);
            return null;
        }
        return records;
    }

    private static Map<String, Record> loadRecords(Context context) {
        Map<String, Record> records = new HashMap<>();
        for (Map.Entry<String, ?> entry : preferences(context).getAll().entrySet()) {
            if (!entry.getKey().startsWith(RECORD_PREFIX) || !(entry.getValue() instanceof String)) continue;
            try {
                Record record = Record.decode(new JSONObject((String) entry.getValue()));
                if (record != null) records.put(record.itemId, record);
            } catch (Throwable ignored) {}
        }
        return records;
    }

    private static Record loadRecord(Context context, String itemId) {
        String encoded = preferences(context).getString(recordKey(itemId), "");
        if (encoded == null || encoded.isEmpty()) return null;
        try { return Record.decode(new JSONObject(encoded)); }
        catch (Throwable ignored) { return null; }
    }

    private static boolean saveRecord(Context context, Record record) {
        String encoded = record.encode();
        return !encoded.isEmpty()
                && preferences(context).edit().putString(recordKey(record.itemId), encoded).commit();
    }

    private static boolean removeRecord(Context context, String itemId) {
        return preferences(context).edit().remove(recordKey(itemId)).commit();
    }

    private static void scheduleAlarm(Context context, Record record) {
        long triggerAt = "timer".equals(record.kind)
                ? Math.max(SystemClock.elapsedRealtime(), record.elapsedDueMs)
                : Math.max(System.currentTimeMillis(), record.dueAtMs);
        scheduleAlarmAt(context, record, triggerAt);
    }

    private static void scheduleAlarmAt(Context context, Record record, long triggerAt) {
        AlarmManager manager = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        if (manager == null) return;
        PendingIntent pendingIntent = pendingIntent(context, record.itemId, record.dueAtMs);
        int alarmType = "timer".equals(record.kind)
                ? AlarmManager.ELAPSED_REALTIME_WAKEUP
                : AlarmManager.RTC_WAKEUP;
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && !manager.canScheduleExactAlarms()) {
                manager.setAndAllowWhileIdle(alarmType, triggerAt, pendingIntent);
            } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                manager.setExactAndAllowWhileIdle(alarmType, triggerAt, pendingIntent);
            } else {
                manager.setExact(alarmType, triggerAt, pendingIntent);
            }
        } catch (SecurityException denied) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                manager.setAndAllowWhileIdle(alarmType, triggerAt, pendingIntent);
            } else {
                manager.set(alarmType, triggerAt, pendingIntent);
            }
        }
    }

    private static void scheduleCampaignWake(Context context, Campaign campaign) {
        long wallNow = System.currentTimeMillis();
        long elapsedNow = SystemClock.elapsedRealtime();
        int currentBoot = bootCount(context);
        boolean sameBoot = campaign.bootCount == currentBoot && elapsedNow >= campaign.startedElapsedMs;
        int alarmType = sameBoot ? AlarmManager.ELAPSED_REALTIME_WAKEUP : AlarmManager.RTC_WAKEUP;
        long triggerAt = sameBoot
                ? Math.max(elapsedNow, campaign.phraseEndsElapsedMs)
                : Math.max(wallNow, campaign.phraseEndsWallMs);
        scheduleCampaignWakeAt(context, campaign, alarmType, triggerAt);
    }

    private static void scheduleCampaignRecoveryRetry(Context context, Campaign campaign) {
        long wallNow = System.currentTimeMillis();
        long elapsedNow = SystemClock.elapsedRealtime();
        int currentBoot = bootCount(context);
        long totalMs = campaign.extendedForOffHead ? 180_000L : 120_000L;
        boolean sameBoot = campaign.bootCount == currentBoot && elapsedNow >= campaign.startedElapsedMs;
        if (sameBoot) {
            long terminal = campaign.startedElapsedMs + totalMs;
            if (elapsedNow >= terminal) return;
            scheduleCampaignWakeAt(context, campaign, AlarmManager.ELAPSED_REALTIME_WAKEUP,
                    Math.min(terminal, elapsedNow + CAMPAIGN_RECOVERY_RETRY_MS));
            return;
        }
        long terminal = campaign.startedWallMs + totalMs;
        if (wallNow >= terminal) return;
        scheduleCampaignWakeAt(context, campaign, AlarmManager.RTC_WAKEUP,
                Math.min(terminal, wallNow + CAMPAIGN_RECOVERY_RETRY_MS));
    }

    private static void scheduleCampaignWakeAt(
            Context context, Campaign campaign, int alarmType, long triggerAt) {
        AlarmManager manager = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        if (manager == null) {
            Log.w(TAG, "Clock campaign boundary unavailable; AlarmManager missing");
            return;
        }
        PendingIntent pendingIntent = campaignPendingIntent(
                context, campaign.occurrenceId, campaign.phraseEndsElapsedMs);
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && !manager.canScheduleExactAlarms()) {
                manager.setAndAllowWhileIdle(alarmType, triggerAt, pendingIntent);
            } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                manager.setExactAndAllowWhileIdle(alarmType, triggerAt, pendingIntent);
            } else {
                manager.setExact(alarmType, triggerAt, pendingIntent);
            }
        } catch (SecurityException denied) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                manager.setAndAllowWhileIdle(alarmType, triggerAt, pendingIntent);
            } else {
                manager.set(alarmType, triggerAt, pendingIntent);
            }
        }
    }

    private static void rescheduleCampaignWakes(Context context) {
        for (Map.Entry<String, ?> entry : preferences(context).getAll().entrySet()) {
            if (!entry.getKey().startsWith(CAMPAIGN_PREFIX) || !(entry.getValue() instanceof String)) continue;
            try {
                Campaign campaign = Campaign.decode(new JSONObject((String) entry.getValue()));
                if (campaign != null) scheduleCampaignWake(context, campaign);
            } catch (Throwable ignored) {}
        }
    }

    private static Record prepareTimerRecord(
            Record candidate,
            Record prior,
            long wallNow,
            long elapsedNow,
            int currentBoot) {
        if (prior != null && "timer".equals(prior.kind) && prior.bootCount == currentBoot &&
                prior.scheduleGeneration == candidate.scheduleGeneration) {
            long remaining = Math.max(0L, prior.elapsedDueMs - elapsedNow);
            long projected = wallNow + remaining;
            if (Math.abs(projected - candidate.dueAtMs) <= TIMER_PROJECTION_TOLERANCE_MS) {
                return candidate.withTimerRuntime(
                        projected,
                        prior.elapsedDueMs,
                        currentBoot,
                        candidate.scheduleGeneration);
            }
        }
        long remaining = clamp(candidate.dueAtMs - wallNow, 0L, candidate.durationMs);
        return candidate.withTimerRuntime(
                wallNow + remaining,
                elapsedNow + remaining,
                currentBoot,
                candidate.scheduleGeneration);
    }

    private static boolean savePendingFire(Context context, Record record) {
        try {
            String encoded = new JSONObject()
                    .put("itemId", record.itemId)
                    .put("kind", record.kind)
                    .put("dueAtMs", record.dueAtMs)
                    .put("scheduleGeneration", record.scheduleGeneration)
                    .toString();
            return preferences(context).edit()
                    .putString(fireKey(record.itemId, record.dueAtMs), encoded)
                    .commit();
        } catch (Throwable ignored) {
            return false;
        }
    }

    private static void acquireRecoveryLease(Context context) {
        try {
            setRecoveryLease(context, true);
        } catch (Throwable error) {
            Log.w(TAG, "Clock recovery foreground lease failed", error);
        }
    }

    private static int bootCount(Context context) {
        try {
            return Settings.Global.getInt(context.getContentResolver(), Settings.Global.BOOT_COUNT);
        } catch (Throwable ignored) {
            return -1;
        }
    }

    private static long clamp(long value, long minimum, long maximum) {
        return Math.max(minimum, Math.min(maximum, value));
    }

    private static void cancelAlarm(Context context, String itemId) {
        AlarmManager manager = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        if (manager != null) manager.cancel(pendingIntent(context, itemId, 0L));
    }

    private static void cancelCampaignWake(Context context, String occurrenceId) {
        AlarmManager manager = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        if (manager != null) manager.cancel(campaignPendingIntent(context, occurrenceId, 0L));
    }

    private static PendingIntent pendingIntent(Context context, String itemId, long dueAtMs) {
        Intent intent = new Intent(context, FaceclawClockReceiver.class);
        intent.setAction(ACTION_FIRE);
        // PendingIntent identity ignores extras. A validated full item id in a
        // package-scoped data URI avoids every 31-bit request-code collision.
        intent.setData(new Uri.Builder()
                .scheme("faceclaw-clock")
                .authority(context.getPackageName())
                .appendPath(itemId)
                .build());
        intent.putExtra(EXTRA_ITEM_ID, itemId);
        intent.putExtra(EXTRA_DUE_AT_MS, dueAtMs);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
        return PendingIntent.getBroadcast(context, 0, intent, flags);
    }

    private static PendingIntent campaignPendingIntent(
            Context context, String occurrenceId, long phraseEndsElapsedMs) {
        Intent intent = new Intent(context, FaceclawClockReceiver.class);
        intent.setAction(ACTION_CAMPAIGN_WAKE);
        intent.setData(new Uri.Builder()
                .scheme("faceclaw-clock")
                .authority(context.getPackageName())
                .appendPath("campaign")
                .appendPath(occurrenceId)
                .build());
        intent.putExtra(EXTRA_OCCURRENCE_ID, occurrenceId);
        intent.putExtra(EXTRA_PHRASE_ENDS_ELAPSED_MS, phraseEndsElapsedMs);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
        return PendingIntent.getBroadcast(context, 0, intent, flags);
    }

    private static long nextRepeatingFire(Record record, long afterMs) {
        if (!record.isRepeating() || record.localTime.length() != 5) return -1L;
        int hour;
        int minute;
        try {
            hour = Integer.parseInt(record.localTime.substring(0, 2));
            minute = Integer.parseInt(record.localTime.substring(3, 5));
        } catch (Throwable ignored) { return -1L; }
        for (int offset = 0; offset <= 7; offset++) {
            Calendar candidate = Calendar.getInstance();
            candidate.setTimeInMillis(afterMs);
            candidate.add(Calendar.DAY_OF_MONTH, offset);
            candidate.set(Calendar.HOUR_OF_DAY, hour);
            candidate.set(Calendar.MINUTE, minute);
            candidate.set(Calendar.SECOND, 0);
            candidate.set(Calendar.MILLISECOND, 0);
            if (candidate.getTimeInMillis() > afterMs && record.includesDay(candidate.get(Calendar.DAY_OF_WEEK))) {
                return candidate.getTimeInMillis();
            }
        }
        return -1L;
    }

    private static long oneShotFire(Record record) {
        if (!record.isOneShotAlarm() || record.date.length() != 10 || record.localTime.length() != 5) {
            return -1L;
        }
        try {
            int year = Integer.parseInt(record.date.substring(0, 4));
            int month = Integer.parseInt(record.date.substring(5, 7));
            int day = Integer.parseInt(record.date.substring(8, 10));
            int hour = Integer.parseInt(record.localTime.substring(0, 2));
            int minute = Integer.parseInt(record.localTime.substring(3, 5));
            Calendar candidate = Calendar.getInstance();
            candidate.setLenient(false);
            candidate.set(Calendar.YEAR, year);
            candidate.set(Calendar.MONTH, month - 1);
            candidate.set(Calendar.DAY_OF_MONTH, day);
            candidate.set(Calendar.HOUR_OF_DAY, hour);
            candidate.set(Calendar.MINUTE, minute);
            candidate.set(Calendar.SECOND, 0);
            candidate.set(Calendar.MILLISECOND, 0);
            return candidate.getTimeInMillis();
        } catch (Throwable ignored) {
            return -1L;
        }
    }

    private static void showNotification(Context context, Record record) {
        ensureChannel(context);
        Intent launch = new Intent(context, NativeScriptActivity.class);
        launch.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
        PendingIntent contentIntent = PendingIntent.getActivity(
                context, notificationId(record.itemId, record.dueAtMs), launch, flags);
        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(context, CHANNEL_ID)
                : new Notification.Builder(context);
        String kind = "alarm".equals(record.kind) ? "Alarm" : "Timer";
        Notification notification = builder
                .setContentTitle(kind + " finished")
                .setContentText("alarm".equals(record.kind) ? "Alarm ringing" : "Timer finished")
                .setSmallIcon(context.getApplicationInfo().icon)
                .setContentIntent(contentIntent)
                .setCategory(Notification.CATEGORY_ALARM)
                .setAutoCancel(true)
                .setWhen(record.dueAtMs)
                .setShowWhen(true)
                .build();
        NotificationManager manager =
                (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager != null) {
            manager.notify(notificationTag(record.itemId, record.dueAtMs),
                    notificationId(record.itemId, record.dueAtMs), notification);
        }
    }

    private static void ensureChannel(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID, "Clock alerts", NotificationManager.IMPORTANCE_HIGH);
        channel.setDescription("Fallback notifications for Hermes G2 timers and alarms.");
        channel.enableVibration(true);
        NotificationManager manager =
                (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager != null) manager.createNotificationChannel(channel);
    }

    private static SharedPreferences preferences(Context context) {
        return context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
    }

    private static String recordKey(String itemId) { return RECORD_PREFIX + itemId; }
    private static String fireKey(String itemId, long dueAtMs) {
        return FIRE_PREFIX + itemId + ":" + dueAtMs;
    }
    private static String campaignKey(String occurrenceId) { return CAMPAIGN_PREFIX + occurrenceId; }

    private static Campaign loadCampaign(Context context, String occurrenceId) {
        String encoded = preferences(context).getString(campaignKey(occurrenceId), "");
        if (encoded == null || encoded.isEmpty()) return null;
        try { return Campaign.decode(new JSONObject(encoded)); }
        catch (Throwable ignored) { return null; }
    }
    private static String notificationTag(String itemId, long dueAtMs) {
        return NOTIFICATION_TAG_PREFIX + itemId + ":" + dueAtMs;
    }
    private static int notificationId(String itemId, long dueAtMs) {
        long value = ((long) itemId.hashCode() << 32) ^ dueAtMs;
        return (int) (value ^ (value >>> 32)) & 0x7fffffff;
    }
    private static String safeItemId(String itemId) {
        return itemId != null && itemId.matches("clk_[a-f0-9]{32}") ? itemId : null;
    }
    private static String safeOccurrenceId(String occurrenceId) {
        return occurrenceId != null && occurrenceId.matches("occ_[a-f0-9]{32}")
                ? occurrenceId : null;
    }

    private static final class Record {
        final String itemId;
        final String kind;
        final long dueAtMs;
        final String localTime;
        final String date;
        final Set<String> repeatDays;
        final long durationMs;
        final long elapsedDueMs;
        final int bootCount;
        final long scheduleGeneration;

        Record(String itemId, String kind, long dueAtMs,
               String localTime, String date, Set<String> repeatDays,
               long durationMs, long elapsedDueMs, int bootCount, long scheduleGeneration) {
            this.itemId = itemId;
            this.kind = kind;
            this.dueAtMs = dueAtMs;
            this.localTime = localTime;
            this.date = date;
            this.repeatDays = repeatDays;
            this.durationMs = durationMs;
            this.elapsedDueMs = elapsedDueMs;
            this.bootCount = bootCount;
            this.scheduleGeneration = scheduleGeneration;
        }

        boolean isRepeating() { return "alarm".equals(kind) && !repeatDays.isEmpty(); }
        boolean isOneShotAlarm() { return "alarm".equals(kind) && repeatDays.isEmpty(); }

        boolean includesDay(int calendarDay) {
            switch (calendarDay) {
                case Calendar.MONDAY: return repeatDays.contains("mon");
                case Calendar.TUESDAY: return repeatDays.contains("tue");
                case Calendar.WEDNESDAY: return repeatDays.contains("wed");
                case Calendar.THURSDAY: return repeatDays.contains("thu");
                case Calendar.FRIDAY: return repeatDays.contains("fri");
                case Calendar.SATURDAY: return repeatDays.contains("sat");
                case Calendar.SUNDAY: return repeatDays.contains("sun");
                default: return false;
            }
        }

        Record withDueAt(long next) {
            return new Record(itemId, kind, next, localTime, date, new HashSet<>(repeatDays),
                    durationMs, elapsedDueMs, bootCount, scheduleGeneration);
        }

        Record withTimerRuntime(long wallDue, long elapsedDue, int boot, long generation) {
            return new Record(itemId, kind, wallDue, localTime, date, new HashSet<>(repeatDays),
                    durationMs, elapsedDue, boot, generation);
        }

        String encode() {
            try {
                JSONObject object = new JSONObject();
                object.put("itemId", itemId);
                object.put("kind", kind);
                object.put("nextFireAtMs", dueAtMs);
                object.put("localTime", localTime);
                object.put("date", date);
                object.put("repeatDays", new JSONArray(repeatDays));
                object.put("durationSeconds", durationMs / 1_000L);
                object.put("elapsedDueMs", elapsedDueMs);
                object.put("bootCount", bootCount);
                object.put("scheduleGeneration", scheduleGeneration);
                return object.toString();
            } catch (Throwable ignored) { return ""; }
        }

        static Record decode(JSONObject object) {
            if (object == null) return null;
            String itemId = safeItemId(object.optString("itemId", null));
            String kind = object.optString("kind", "");
            long dueAtMs = object.optLong("nextFireAtMs", -1L);
            String localTime = object.optString("localTime", "");
            String date = object.optString("date", "");
            JSONArray days = object.optJSONArray("repeatDays");
            long durationSeconds = object.optLong("durationSeconds", 0L);
            long elapsedDueMs = object.optLong("elapsedDueMs", -1L);
            int bootCount = object.optInt("bootCount", -1);
            long scheduleGeneration = object.has("scheduleGeneration")
                    ? object.optLong("scheduleGeneration", -1L)
                    : Math.max(1L, object.optLong("timerGeneration", 1L));
            if (itemId == null || (!"timer".equals(kind) && !"alarm".equals(kind))
                    || dueAtMs < 0L
                    || scheduleGeneration < 1L
                    || ("alarm".equals(kind) && !localTime.matches("([01]\\d|2[0-3]):[0-5]\\d"))
                    || ("timer".equals(kind) && (durationSeconds < 1L || durationSeconds > 604_800L))) {
                return null;
            }
            Set<String> repeatDays = new HashSet<>();
            if (days != null) {
                for (int index = 0; index < days.length(); index++) {
                    String day = days.optString(index, "");
                    if (!day.matches("mon|tue|wed|thu|fri|sat|sun")) return null;
                    repeatDays.add(day);
                }
            }
            if ("timer".equals(kind)) {
                if (!localTime.isEmpty() || !date.isEmpty() || !repeatDays.isEmpty()) return null;
            } else {
                if (durationSeconds != 0L || elapsedDueMs != -1L) return null;
                if (repeatDays.isEmpty()) {
                    if (!date.matches("\\d{4}-\\d{2}-\\d{2}")) return null;
                } else if (!date.isEmpty()) return null;
            }
            Record record = new Record(
                    itemId, kind, dueAtMs, localTime, date, repeatDays,
                    durationSeconds * 1_000L, elapsedDueMs, bootCount, scheduleGeneration);
            if (record.isOneShotAlarm() && oneShotFire(record) < 0L) return null;
            return record;
        }
    }

    private static final class Campaign {
        final String occurrenceId;
        final String itemId;
        final long dueAtMs;
        final long startedWallMs;
        final long startedElapsedMs;
        final long phraseEndsWallMs;
        final long phraseEndsElapsedMs;
        final int bootCount;
        final String phase;
        final boolean extendedForOffHead;
        final boolean confirmedOffHead;

        Campaign(String occurrenceId, String itemId, long dueAtMs,
                 long startedWallMs, long startedElapsedMs,
                 long phraseEndsWallMs, long phraseEndsElapsedMs,
                 int bootCount, String phase,
                 boolean extendedForOffHead, boolean confirmedOffHead) {
            this.occurrenceId = occurrenceId;
            this.itemId = itemId;
            this.dueAtMs = dueAtMs;
            this.startedWallMs = startedWallMs;
            this.startedElapsedMs = startedElapsedMs;
            this.phraseEndsWallMs = phraseEndsWallMs;
            this.phraseEndsElapsedMs = phraseEndsElapsedMs;
            this.bootCount = bootCount;
            this.phase = phase;
            this.extendedForOffHead = extendedForOffHead;
            this.confirmedOffHead = confirmedOffHead;
        }

        String encode() {
            try {
                return new JSONObject()
                        .put("occurrenceId", occurrenceId)
                        .put("itemId", itemId)
                        .put("dueAtMs", dueAtMs)
                        .put("startedWallMs", startedWallMs)
                        .put("startedElapsedMs", startedElapsedMs)
                        .put("phraseEndsWallMs", phraseEndsWallMs)
                        .put("phraseEndsElapsedMs", phraseEndsElapsedMs)
                        .put("bootCount", bootCount)
                        .put("phase", phase)
                        .put("extendedForOffHead", extendedForOffHead)
                        .put("confirmedOffHead", confirmedOffHead)
                        .toString();
            } catch (Throwable ignored) { return ""; }
        }

        Campaign withRouting(boolean extended, boolean confirmed) {
            return new Campaign(
                    occurrenceId, itemId, dueAtMs, startedWallMs, startedElapsedMs,
                    phraseEndsWallMs, phraseEndsElapsedMs, bootCount, phase,
                    extended, confirmed);
        }

        static Campaign decode(JSONObject object) {
            if (object == null) return null;
            String occurrenceId = object.optString("occurrenceId", "");
            String itemId = safeItemId(object.optString("itemId", null));
            String phase = object.optString("phase", "");
            long dueAtMs = object.optLong("dueAtMs", -1L);
            long startedWallMs = object.optLong("startedWallMs", -1L);
            long startedElapsedMs = object.optLong("startedElapsedMs", -1L);
            long phraseEndsWallMs = object.optLong("phraseEndsWallMs", -1L);
            long phraseEndsElapsedMs = object.optLong("phraseEndsElapsedMs", -1L);
            int bootCount = object.optInt("bootCount", -1);
            Object extendedValue = object.opt("extendedForOffHead");
            Object confirmedValue = object.opt("confirmedOffHead");
            if (!occurrenceId.matches("occ_[a-f0-9]{32}") || itemId == null ||
                    !("low".equals(phase) || "high".equals(phase)) || dueAtMs < 0L ||
                    startedWallMs < 0L || startedElapsedMs < 0L ||
                    phraseEndsWallMs < startedWallMs || phraseEndsElapsedMs < startedElapsedMs ||
                    !(extendedValue instanceof Boolean) || !(confirmedValue instanceof Boolean)) return null;
            return new Campaign(
                    occurrenceId, itemId, dueAtMs, startedWallMs, startedElapsedMs,
                    phraseEndsWallMs, phraseEndsElapsedMs, bootCount, phase,
                    (Boolean) extendedValue, (Boolean) confirmedValue);
        }
    }
}
