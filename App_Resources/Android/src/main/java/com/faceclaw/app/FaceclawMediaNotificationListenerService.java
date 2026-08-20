package com.faceclaw.app;

import android.app.Notification;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.RemoteInput;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.drawable.BitmapDrawable;
import android.graphics.drawable.Drawable;
import android.graphics.drawable.Icon;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.service.notification.NotificationListenerService;
import android.service.notification.StatusBarNotification;
import android.util.Log;

import java.io.ByteArrayOutputStream;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CopyOnWriteArraySet;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

public class FaceclawMediaNotificationListenerService extends NotificationListenerService {
    private static final String TAG = "FaceclawNotify";
    private static final double NOTIFICATION_ICON_GAMMA = 1.6;
    private static final String EXTRA_SUBSTITUTE_APP_NAME = "android.substName";
    private static final String NOTIFICATION_FILTER_MODE_KEY = "notifications.filterMode";
    private static final String NOTIFICATION_ALLOWED_PACKAGES_KEY = "notifications.allowedPackages";
    private static final String NOTIFICATION_FILTER_ALL = "all";
    private static final String NOTIFICATION_FILTER_IMPORTANT = "important";
    private static final String NOTIFICATION_FILTER_SELECTED = "selected";

    private static volatile FaceclawMediaNotificationListenerService activeService;
    private static volatile boolean notificationAccessConnected;
    private static final Handler mainHandler = new Handler(Looper.getMainLooper());
    private static final Set<FaceclawNotificationListener> notificationListeners = new CopyOnWriteArraySet<>();
    private static final Set<String> activeNotificationWakeKeys = new HashSet<>();

    @Override
    public void onCreate() {
        super.onCreate();
        activeService = this;
    }

    @Override
    public void onDestroy() {
        if (activeService == this) {
            activeService = null;
            notificationAccessConnected = false;
            FaceclawMediaController.refreshAfterNotificationAccessChanged();
        }
        super.onDestroy();
    }

    @Override
    public void onListenerConnected() {
        activeService = this;
        notificationAccessConnected = true;
        super.onListenerConnected();
        refreshActiveNotificationWakeKeys(this);
        FaceclawMediaController.refreshAfterNotificationAccessChanged();
    }

    @Override
    public void onListenerDisconnected() {
        if (activeService == this) {
            activeService = null;
            notificationAccessConnected = false;
            FaceclawMediaController.refreshAfterNotificationAccessChanged();
        }
        super.onListenerDisconnected();
    }

    @Override
    public void onNotificationPosted(StatusBarNotification statusBarNotification) {
        super.onNotificationPosted(statusBarNotification);
        if (!shouldShowNotificationInList(this, statusBarNotification)) {
            forgetActiveNotificationWakeKey(statusBarNotification);
            return;
        }
        if (shouldEmitNotificationPosted(statusBarNotification)) {
            emitNotificationPosted(statusBarNotification.getKey());
        }
    }

    @Override
    public void onNotificationRemoved(StatusBarNotification statusBarNotification) {
        forgetActiveNotificationWakeKey(statusBarNotification);
        super.onNotificationRemoved(statusBarNotification);
    }

    public static void addNotificationListener(FaceclawNotificationListener listener) {
        if (listener != null) {
            notificationListeners.add(listener);
        }
    }

    public static void removeNotificationListener(FaceclawNotificationListener listener) {
        if (listener != null) {
            notificationListeners.remove(listener);
        }
    }

    /** True only after Android has connected this privileged listener service. */
    public static boolean isNotificationAccessActive() {
        return activeService != null && notificationAccessConnected;
    }

    public static boolean hasActiveNotificationTitle(String expectedTitle) {
        FaceclawMediaNotificationListenerService service = activeService;
        if (service == null || expectedTitle == null || expectedTitle.isEmpty()) {
            return false;
        }
        StatusBarNotification[] notifications;
        try {
            notifications = service.getActiveNotifications();
        } catch (SecurityException e) {
            Log.w(TAG, "notification access denied while checking active notifications", e);
            return false;
        } catch (Throwable t) {
            Log.w(TAG, "failed to check active notifications", t);
            return false;
        }
        if (notifications == null || notifications.length == 0) {
            return false;
        }
        for (StatusBarNotification notification : notifications) {
            if (notification == null || notification.getNotification() == null) {
                continue;
            }
            Bundle extras = notification.getNotification().extras;
            if (extras == null) {
                continue;
            }
            CharSequence title = extras.getCharSequence(Notification.EXTRA_TITLE);
            if (title != null && expectedTitle.contentEquals(title)) {
                return true;
            }
        }
        return false;
    }

    public static byte[] getActiveNotificationIconGrays(int iconSize, int maxIcons) {
        FaceclawMediaNotificationListenerService service = activeService;
        int size = Math.max(1, Math.min(96, iconSize));
        int limit = Math.max(0, maxIcons);
        if (service == null || limit == 0) {
            return new byte[0];
        }

        StatusBarNotification[] notifications;
        try {
            notifications = service.getActiveNotifications();
        } catch (SecurityException e) {
            Log.w(TAG, "notification access denied while reading icons", e);
            return new byte[0];
        } catch (Throwable t) {
            Log.w(TAG, "failed to read notification icons", t);
            return new byte[0];
        }
        if (notifications == null || notifications.length == 0) {
            return new byte[0];
        }

        ByteArrayOutputStream out = new ByteArrayOutputStream(size * size * Math.min(limit, notifications.length));
        Set<String> emittedGroupKeys = new HashSet<>();
        int emitted = 0;
        for (StatusBarNotification statusBarNotification : notifications) {
            if (!shouldShowNotificationIcon(service, statusBarNotification)) {
                continue;
            }
            String dedupeGroupKey = getNotificationDedupeGroupKey(statusBarNotification);
            if (dedupeGroupKey != null && emittedGroupKeys.contains(dedupeGroupKey)) {
                continue;
            }
            Drawable drawable = loadNotificationIcon(service, statusBarNotification.getNotification());
            if (drawable == null) {
                Log.i(TAG, "icon skipped (no drawable): " + statusBarNotification.getPackageName());
                continue;
            }
            Log.i(TAG, "icon[" + emitted + "] pkg=" + statusBarNotification.getPackageName()
                    + " drawable=" + drawable.getClass().getSimpleName()
                    + " intrinsic=" + drawable.getIntrinsicWidth() + "x" + drawable.getIntrinsicHeight());
            appendIconGrayBytes(drawable, size, out, service, emitted, statusBarNotification.getPackageName());
            if (dedupeGroupKey != null) {
                emittedGroupKeys.add(dedupeGroupKey);
            }
            emitted += 1;
            if (emitted >= limit) {
                break;
            }
        }
        return out.toByteArray();
    }

    /**
     * Grayscale icon (iconSize*iconSize bytes) for one active notification,
     * identified by its key; empty array when the notification or its icon is
     * unavailable. Shares the extraction/scaling pipeline with the tray icon
     * strip above.
     */
    public static byte[] getNotificationIconGrayForKey(String key, int iconSize) {
        FaceclawMediaNotificationListenerService service = activeService;
        int size = Math.max(1, Math.min(96, iconSize));
        if (service == null) {
            return new byte[0];
        }
        StatusBarNotification statusBarNotification = findActiveNotificationByKey(service, key);
        if (statusBarNotification == null || statusBarNotification.getNotification() == null) {
            return new byte[0];
        }
        Drawable drawable = loadNotificationIcon(service, statusBarNotification.getNotification());
        if (drawable == null) {
            return new byte[0];
        }
        ByteArrayOutputStream out = new ByteArrayOutputStream(size * size);
        appendIconGrayBytes(drawable, size, out, service, -1, statusBarNotification.getPackageName());
        return out.toByteArray();
    }

    public static String getActiveNotificationsJson(int maxNotifications) {
        FaceclawMediaNotificationListenerService service = activeService;
        int limit = Math.max(0, Math.min(100, maxNotifications));
        if (service == null || limit == 0) {
            return "[]";
        }

        StatusBarNotification[] notifications;
        try {
            notifications = service.getActiveNotifications();
        } catch (SecurityException e) {
            Log.w(TAG, "notification access denied while reading notifications", e);
            return "[]";
        } catch (Throwable t) {
            Log.w(TAG, "failed to read notifications", t);
            return "[]";
        }
        if (notifications == null || notifications.length == 0) {
            return "[]";
        }

        Arrays.sort(notifications, new Comparator<StatusBarNotification>() {
            @Override
            public int compare(StatusBarNotification a, StatusBarNotification b) {
                long left = a == null ? 0 : a.getPostTime();
                long right = b == null ? 0 : b.getPostTime();
                return Long.compare(right, left);
            }
        });

        JSONArray out = new JSONArray();
        for (StatusBarNotification statusBarNotification : notifications) {
            if (out.length() >= limit) {
                break;
            }
            if (!shouldShowNotificationInList(service, statusBarNotification)) {
                continue;
            }
            try {
                out.put(buildNotificationJson(service, statusBarNotification));
            } catch (Throwable t) {
                Log.w(TAG, "failed to serialize notification", t);
            }
        }
        return out.toString();
    }

    /** Re-evaluate active tray/modal keys after a phone-side filter change. */
    public static void refreshNotificationFilter() {
        FaceclawMediaNotificationListenerService service = activeService;
        if (service != null) {
            refreshActiveNotificationWakeKeys(service);
        }
    }

    /**
     * Apps with live eligible notifications before user filtering. This lets the
     * phone UI build an allowlist without making a muted app impossible to add.
     */
    public static String getActiveNotificationAppsJson(int maxApps) {
        FaceclawMediaNotificationListenerService service = activeService;
        int limit = Math.max(1, Math.min(50, maxApps));
        if (service == null) {
            return "[]";
        }
        StatusBarNotification[] notifications;
        try {
            notifications = service.getActiveNotifications();
        } catch (Throwable t) {
            Log.w(TAG, "failed to read notification apps", t);
            return "[]";
        }
        if (notifications == null || notifications.length == 0) {
            return "[]";
        }
        Map<String, String> apps = new LinkedHashMap<>();
        for (StatusBarNotification statusBarNotification : notifications) {
            if (!isNotificationMirrorCandidate(service, statusBarNotification)) {
                continue;
            }
            String packageName = statusBarNotification.getPackageName();
            if (packageName != null && !packageName.isEmpty() && !apps.containsKey(packageName)) {
                apps.put(packageName, getNotificationAppName(service, statusBarNotification));
            }
        }
        JSONArray out = new JSONArray();
        for (Map.Entry<String, String> app : apps.entrySet()) {
            if (out.length() >= limit) {
                break;
            }
            try {
                JSONObject item = new JSONObject();
                item.put("packageName", app.getKey());
                item.put("appName", app.getValue());
                out.put(item);
            } catch (JSONException ignored) {
            }
        }
        return out.toString();
    }

    public static String getInstalledNotificationAppsJson(int maxApps) {
        FaceclawMediaNotificationListenerService service = activeService;
        int limit = Math.max(1, Math.min(10_000, maxApps));
        if (service == null) {
            return "[]";
        }
        PackageManager packageManager = service.getPackageManager();
        List<ApplicationInfo> installed;
        try {
            installed = new ArrayList<>(packageManager.getInstalledApplications(0));
        } catch (Throwable t) {
            Log.w(TAG, "failed to list installed notification apps", t);
            return "[]";
        }
        installed.removeIf(app -> app == null || service.getPackageName().equals(app.packageName));
        installed.sort((left, right) -> appLabel(packageManager, left).compareToIgnoreCase(appLabel(packageManager, right)));
        JSONArray out = new JSONArray();
        for (ApplicationInfo app : installed) {
            if (out.length() >= limit) {
                break;
            }
            try {
                JSONObject item = new JSONObject();
                item.put("packageName", app.packageName);
                item.put("appName", appLabel(packageManager, app));
                out.put(item);
            } catch (JSONException ignored) {
            }
        }
        return out.toString();
    }

    public static boolean invokeNotificationAction(String key, int actionIndex) {
        return invokeNotificationAction(key, actionIndex, null);
    }

    /**
     * Fire a notification action. For a plain action (Like, Mark as read) the
     * PendingIntent is sent as-is. For a direct-reply action - one that carries
     * a RemoteInput (Reply, some Comment/Like variants) - a bare send is a
     * no-op: the receiver reads its text from a RemoteInput results bundle that
     * must be attached. `replyText` supplies that text; without it such an
     * action cannot complete, so we refuse rather than silently do nothing.
     */
    public static boolean invokeNotificationAction(String key, int actionIndex, String replyText) {
        FaceclawMediaNotificationListenerService service = activeService;
        StatusBarNotification statusBarNotification = findActiveNotificationByKey(service, key);
        if (statusBarNotification == null || statusBarNotification.getNotification() == null) {
            return false;
        }
        Notification.Action[] actions = statusBarNotification.getNotification().actions;
        if (actions == null || actionIndex < 0 || actionIndex >= actions.length) {
            return false;
        }
        Notification.Action action = actions[actionIndex];
        PendingIntent intent = action.actionIntent;
        if (intent == null) {
            return false;
        }
        RemoteInput[] remoteInputs = action.getRemoteInputs();
        boolean needsReply = remoteInputs != null && remoteInputs.length > 0;
        try {
            if (needsReply) {
                if (replyText == null || service == null) {
                    // Caller should have prompted for text (action.hasRemoteInput);
                    // firing without it would open the app or drop the reply.
                    return false;
                }
                Intent fillIn = new Intent();
                Bundle results = new Bundle();
                for (RemoteInput remoteInput : remoteInputs) {
                    results.putCharSequence(remoteInput.getResultKey(), replyText);
                }
                RemoteInput.addResultsToIntent(remoteInputs, fillIn, results);
                intent.send(service, 0, fillIn);
            } else {
                intent.send();
            }
            return true;
        } catch (PendingIntent.CanceledException e) {
            Log.w(TAG, "notification action pending intent was canceled", e);
            return false;
        } catch (Throwable t) {
            Log.w(TAG, "failed to invoke notification action", t);
            return false;
        }
    }

    public static boolean dismissNotification(String key) {
        FaceclawMediaNotificationListenerService service = activeService;
        if (service == null || key == null || key.isEmpty()) {
            return false;
        }
        try {
            service.cancelNotification(key);
            return true;
        } catch (SecurityException e) {
            Log.w(TAG, "notification access denied while dismissing notification", e);
            return false;
        } catch (Throwable t) {
            Log.w(TAG, "failed to dismiss notification", t);
            return false;
        }
    }

    public static int dismissAllNotifications() {
        FaceclawMediaNotificationListenerService service = activeService;
        if (service == null) {
            return 0;
        }
        StatusBarNotification[] notifications;
        try {
            notifications = service.getActiveNotifications();
        } catch (Throwable t) {
            Log.w(TAG, "failed to read notifications for dismiss all", t);
            return 0;
        }
        if (notifications == null) {
            return 0;
        }
        int dismissed = 0;
        for (StatusBarNotification statusBarNotification : notifications) {
            if (!shouldShowNotificationInList(service, statusBarNotification)
                    || !statusBarNotification.isClearable()) {
                continue;
            }
            String key = statusBarNotification.getKey();
            if (key == null || key.isEmpty()) {
                continue;
            }
            try {
                service.cancelNotification(key);
                forgetActiveNotificationWakeKey(statusBarNotification);
                dismissed += 1;
            } catch (Throwable t) {
                Log.w(TAG, "failed to dismiss notification during dismiss all", t);
            }
        }
        return dismissed;
    }

    private static void emitNotificationPosted(String key) {
        if (key == null || key.isEmpty() || notificationListeners.isEmpty()) {
            return;
        }
        for (FaceclawNotificationListener listener : notificationListeners) {
            mainHandler.post(() -> {
                try {
                    listener.onNotificationPosted(key);
                } catch (Throwable t) {
                    Log.w(TAG, "notification listener failed", t);
                }
            });
        }
    }

    private static void refreshActiveNotificationWakeKeys(FaceclawMediaNotificationListenerService service) {
        StatusBarNotification[] notifications;
        try {
            notifications = service.getActiveNotifications();
        } catch (Throwable t) {
            Log.w(TAG, "failed to refresh active notification wake keys", t);
            return;
        }
        synchronized (activeNotificationWakeKeys) {
            activeNotificationWakeKeys.clear();
            if (notifications == null) {
                return;
            }
            for (StatusBarNotification statusBarNotification : notifications) {
                if (shouldShowNotificationInList(service, statusBarNotification)) {
                    String key = statusBarNotification.getKey();
                    if (key != null && !key.isEmpty()) {
                        activeNotificationWakeKeys.add(key);
                    }
                }
            }
        }
    }

    private static boolean shouldEmitNotificationPosted(StatusBarNotification statusBarNotification) {
        String key = statusBarNotification.getKey();
        if (key == null || key.isEmpty()) {
            return true;
        }

        boolean alreadyActive;
        synchronized (activeNotificationWakeKeys) {
            alreadyActive = activeNotificationWakeKeys.contains(key);
            activeNotificationWakeKeys.add(key);
        }
        return !alreadyActive || !isPersistentNotification(statusBarNotification);
    }

    private static void forgetActiveNotificationWakeKey(StatusBarNotification statusBarNotification) {
        if (statusBarNotification == null) {
            return;
        }
        String key = statusBarNotification.getKey();
        if (key == null || key.isEmpty()) {
            return;
        }
        synchronized (activeNotificationWakeKeys) {
            activeNotificationWakeKeys.remove(key);
        }
    }

    private static boolean isPersistentNotification(StatusBarNotification statusBarNotification) {
        Notification notification = statusBarNotification.getNotification();
        if (notification == null) {
            return false;
        }
        int persistentFlags = Notification.FLAG_ONGOING_EVENT | Notification.FLAG_NO_CLEAR;
        return (notification.flags & persistentFlags) != 0;
    }

    private static boolean shouldShowNotificationIcon(FaceclawMediaNotificationListenerService service, StatusBarNotification statusBarNotification) {
        if (!shouldShowNotificationInList(service, statusBarNotification)) {
            return false;
        }
        Notification notification = statusBarNotification.getNotification();
        if ((notification.flags & Notification.FLAG_GROUP_SUMMARY) != 0) {
            return false;
        }
        return true;
    }

    private static boolean shouldShowNotificationInList(FaceclawMediaNotificationListenerService service, StatusBarNotification statusBarNotification) {
        if (!isNotificationMirrorCandidate(service, statusBarNotification)) {
            return false;
        }
        if (!passesUserNotificationFilter(service, statusBarNotification)) {
            return false;
        }
        int importance = notificationImportance(service, statusBarNotification);
        return importance == Integer.MIN_VALUE || importance > NotificationManager.IMPORTANCE_MIN;
    }

    /** Filters app-owned, media-session, and transport noise before user policy. */
    private static boolean isNotificationMirrorCandidate(FaceclawMediaNotificationListenerService service,
            StatusBarNotification statusBarNotification) {
        if (statusBarNotification == null || statusBarNotification.getNotification() == null) {
            return false;
        }
        if (service.getPackageName().equals(statusBarNotification.getPackageName())
                && !FaceclawTimerNotifications.isTimerNotification(statusBarNotification)) {
            return false;
        }
        Notification notification = statusBarNotification.getNotification();
        if (Notification.CATEGORY_TRANSPORT.equals(notification.category)) {
            return false;
        }
        // Group-summary notifications restate their group's children with no
        // content of their own — e.g. Teams posts an empty summary that renders
        // as "Teams — (untitled)" and buries the real message. The per-message
        // children carry the content, so mirror those and drop the summary
        // (the icon path already excludes summaries; this aligns the list).
        if ((notification.flags & Notification.FLAG_GROUP_SUMMARY) != 0) {
            return false;
        }
        // A notification with neither title nor body can't be rendered as
        // anything but "(untitled)", so it only hides real items. Skip it.
        if (!hasDisplayableContent(notification)) {
            return false;
        }
        Bundle extras = notification.extras;
        return extras == null || !extras.containsKey("android.mediaSession");
    }

    /** Whether a notification carries any title or body text worth showing. */
    private static boolean hasDisplayableContent(Notification notification) {
        Bundle extras = notification.extras;
        if (extras == null) {
            return false;
        }
        return hasText(extras.getCharSequence(Notification.EXTRA_TITLE))
            || hasText(extras.getCharSequence(Notification.EXTRA_TITLE_BIG))
            || hasText(extras.getCharSequence(Notification.EXTRA_TEXT))
            || hasText(extras.getCharSequence(Notification.EXTRA_BIG_TEXT))
            || hasText(notification.tickerText);
    }

    private static boolean hasText(CharSequence value) {
        return value != null && value.toString().trim().length() > 0;
    }

    private static boolean passesUserNotificationFilter(FaceclawMediaNotificationListenerService service,
            StatusBarNotification statusBarNotification) {
        FaceclawSettings settings = FaceclawSettings.getInstance(service);
        String mode = settings.getString(NOTIFICATION_FILTER_MODE_KEY, NOTIFICATION_FILTER_ALL);
        if (NOTIFICATION_FILTER_IMPORTANT.equals(mode)) {
            return notificationImportance(service, statusBarNotification) >= NotificationManager.IMPORTANCE_DEFAULT;
        }
        if (!NOTIFICATION_FILTER_SELECTED.equals(mode)) {
            return true;
        }
        String allowed = settings.getString(NOTIFICATION_ALLOWED_PACKAGES_KEY, "");
        String packageName = statusBarNotification.getPackageName();
        if (packageName == null || packageName.isEmpty()) {
            return false;
        }
        for (String entry : allowed.split(",")) {
            if (packageName.equals(entry.trim())) {
                return true;
            }
        }
        return false;
    }

    /** Integer.MIN_VALUE means Android did not provide a ranking for this item. */
    private static int notificationImportance(FaceclawMediaNotificationListenerService service,
            StatusBarNotification statusBarNotification) {
        NotificationListenerService.RankingMap rankingMap = service.getCurrentRanking();
        if (rankingMap == null) {
            return Integer.MIN_VALUE;
        }
        NotificationListenerService.Ranking ranking = new NotificationListenerService.Ranking();
        String key = statusBarNotification.getKey();
        if (key == null || !rankingMap.getRanking(key, ranking)) {
            return Integer.MIN_VALUE;
        }
        return ranking.getImportance();
    }

    private static String getNotificationDedupeGroupKey(StatusBarNotification statusBarNotification) {
        Notification notification = statusBarNotification.getNotification();
        if (notification.getGroup() == null && statusBarNotification.getOverrideGroupKey() == null) {
            return null;
        }
        String groupKey = statusBarNotification.getGroupKey();
        if (groupKey == null || groupKey.isEmpty()) {
            return null;
        }
        // Group children often share the same small icon. Emit only one icon for the group.
        return groupKey;
    }

    private static Drawable loadNotificationIcon(FaceclawMediaNotificationListenerService service, Notification notification) {
        try {
            Icon smallIcon = notification.getSmallIcon();
            if (smallIcon != null) {
                Drawable drawable = smallIcon.loadDrawable(service);
                if (drawable != null) {
                    // Status-bar small icons are alpha templates: the platform
                    // draws them tinted and ignores their color channels, which
                    // apps may fill with garbage (Discord ships noise there).
                    // Tint white so the shape comes from alpha alone, matching
                    // how the status bar renders them.
                    drawable.mutate();
                    drawable.setTint(Color.WHITE);
                    if (drawable instanceof BitmapDrawable) {
                        ((BitmapDrawable) drawable).setFilterBitmap(true);
                    }
                    return drawable;
                }
            }
        } catch (Throwable t) {
            Log.w(TAG, "failed to load small notification icon", t);
        }
        try {
            // Large icons are real color images (avatars, album art); keep color.
            Icon largeIcon = notification.getLargeIcon();
            if (largeIcon != null) {
                return largeIcon.loadDrawable(service);
            }
        } catch (Throwable t) {
            Log.w(TAG, "failed to load large notification icon", t);
        }
        return null;
    }

    private static void appendIconGrayBytes(Drawable drawable, int size, ByteArrayOutputStream out,
            FaceclawMediaNotificationListenerService service, int index, String packageName) {
        Bitmap bitmap = renderIconScaled(drawable, size);
        dumpIconDebugPng(service, index, packageName, bitmap);
        for (int y = 0; y < size; y++) {
            for (int x = 0; x < size; x++) {
                int color = bitmap.getPixel(x, y);
                int alpha = Color.alpha(color);
                double grayLinear = (0.2126 * Color.red(color) + 0.7152 * Color.green(color) + 0.0722 * Color.blue(color)) * alpha / (255.0 * 255.0);
                int gray = (int) Math.round(255.0 * Math.pow(Math.max(0.0, Math.min(1.0, grayLinear)), NOTIFICATION_ICON_GAMMA));
                out.write(gray & 0xff);
            }
        }
        bitmap.recycle();
    }

    /**
     * Render a drawable at the target size with proper downscaling. Detailed
     * sources (e.g. avatar bitmaps used as notification icons) are rendered at
     * native resolution and reduced by repeated halving: a single filtered pass
     * from, say, 126px to 24px samples too sparsely and turns fine detail into
     * speckle that reads as a garbled icon.
     */
    private static Bitmap renderIconScaled(Drawable drawable, int size) {
        int renderW = Math.max(size, drawable.getIntrinsicWidth());
        int renderH = Math.max(size, drawable.getIntrinsicHeight());
        Bitmap bitmap = Bitmap.createBitmap(renderW, renderH, Bitmap.Config.ARGB_8888);
        Canvas canvas = new Canvas(bitmap);
        drawable.setBounds(0, 0, renderW, renderH);
        drawable.draw(canvas);
        while (bitmap.getWidth() >= size * 2 && bitmap.getHeight() >= size * 2) {
            Bitmap halved = Bitmap.createScaledBitmap(bitmap, bitmap.getWidth() / 2, bitmap.getHeight() / 2, true);
            bitmap.recycle();
            bitmap = halved;
        }
        if (bitmap.getWidth() != size || bitmap.getHeight() != size) {
            Bitmap scaled = Bitmap.createScaledBitmap(bitmap, size, size, true);
            bitmap.recycle();
            bitmap = scaled;
        }
        return bitmap;
    }

    /**
     * Debug aid for garbled-icon reports: saves each rendered icon to
     * <externalFilesDir>/debug-icons/ (adb-pullable) so extraction problems can
     * be told apart from downstream compositing/transmission problems. Cheap:
     * runs at most once per icon-cache refresh on tiny bitmaps.
     */
    private static void dumpIconDebugPng(FaceclawMediaNotificationListenerService service, int index, String packageName, Bitmap bitmap) {
        if (index < 0) {
            return;
        }
        try {
            java.io.File dir = new java.io.File(service.getExternalFilesDir(null), "debug-icons");
            if (!dir.exists() && !dir.mkdirs()) {
                return;
            }
            String safeName = packageName == null ? "unknown" : packageName.replaceAll("[^A-Za-z0-9._-]", "_");
            java.io.File file = new java.io.File(dir, "icon-" + index + "-" + safeName + ".png");
            try (java.io.FileOutputStream stream = new java.io.FileOutputStream(file)) {
                bitmap.compress(Bitmap.CompressFormat.PNG, 100, stream);
            }
        } catch (Throwable t) {
            Log.w(TAG, "failed to dump debug icon", t);
        }
    }

    private static StatusBarNotification findActiveNotificationByKey(FaceclawMediaNotificationListenerService service, String key) {
        if (service == null || key == null || key.isEmpty()) {
            return null;
        }
        StatusBarNotification[] notifications;
        try {
            notifications = service.getActiveNotifications();
        } catch (Throwable t) {
            Log.w(TAG, "failed to find active notification", t);
            return null;
        }
        if (notifications == null) {
            return null;
        }
        for (StatusBarNotification statusBarNotification : notifications) {
            if (statusBarNotification != null && key.equals(statusBarNotification.getKey())) {
                return statusBarNotification;
            }
        }
        return null;
    }

    private static JSONObject buildNotificationJson(FaceclawMediaNotificationListenerService service, StatusBarNotification statusBarNotification)
            throws JSONException {
        Notification notification = statusBarNotification.getNotification();
        Bundle extras = notification.extras;
        JSONObject out = new JSONObject();
        out.put("key", statusBarNotification.getKey());
        out.put("packageName", statusBarNotification.getPackageName());
        out.put("appName", getNotificationAppName(service, statusBarNotification));
        out.put("postTime", statusBarNotification.getPostTime());
        out.put("when", notification.when);
        putString(out, "category", notification.category);
        if (extras != null) {
            putCharSequence(out, "title", firstNonEmpty(
                    extras.getCharSequence(Notification.EXTRA_TITLE_BIG),
                    extras.getCharSequence(Notification.EXTRA_TITLE)
            ));
            putCharSequence(out, "text", extras.getCharSequence(Notification.EXTRA_TEXT));
            putCharSequence(out, "bigText", extras.getCharSequence(Notification.EXTRA_BIG_TEXT));
            putCharSequence(out, "subText", extras.getCharSequence(Notification.EXTRA_SUB_TEXT));
            putCharSequence(out, "infoText", extras.getCharSequence(Notification.EXTRA_INFO_TEXT));
            putCharSequence(out, "summaryText", extras.getCharSequence(Notification.EXTRA_SUMMARY_TEXT));
            CharSequence[] textLines = extras.getCharSequenceArray(Notification.EXTRA_TEXT_LINES);
            JSONArray lines = new JSONArray();
            if (textLines != null) {
                for (CharSequence line : textLines) {
                    String text = charSequenceToString(line);
                    if (!text.isEmpty()) {
                        lines.put(text);
                    }
                }
            }
            out.put("lines", lines);
        } else {
            out.put("lines", new JSONArray());
        }

        JSONArray actionsJson = new JSONArray();
        Notification.Action[] actions = notification.actions;
        if (actions != null) {
            for (int index = 0; index < actions.length; index++) {
                Notification.Action action = actions[index];
                if (action == null) {
                    continue;
                }
                String title = charSequenceToString(action.title);
                if (title.isEmpty()) {
                    continue;
                }
                RemoteInput[] remoteInputs = action.getRemoteInputs();
                boolean hasRemoteInput = remoteInputs != null && remoteInputs.length > 0;
                JSONObject actionJson = new JSONObject();
                actionJson.put("index", index);
                actionJson.put("title", title);
                actionJson.put("enabled", action.actionIntent != null);
                // A reply/direct-input action (its intent needs a filled
                // RemoteInput); the glasses prompt for text before firing it.
                actionJson.put("hasRemoteInput", hasRemoteInput);
                actionsJson.put(actionJson);
            }
        }
        out.put("actions", actionsJson);
        return out;
    }

    private static String getNotificationAppName(FaceclawMediaNotificationListenerService service, StatusBarNotification statusBarNotification) {
        Notification notification = statusBarNotification.getNotification();
        Bundle extras = notification.extras;
        if (extras != null) {
            String substituteName = charSequenceToString(extras.getCharSequence(EXTRA_SUBSTITUTE_APP_NAME));
            if (!substituteName.isEmpty()) {
                return substituteName;
            }
        }
        return getAppLabel(service, statusBarNotification.getPackageName());
    }

    private static String getAppLabel(FaceclawMediaNotificationListenerService service, String packageName) {
        if (packageName == null || packageName.isEmpty()) {
            return "";
        }
        try {
            CharSequence label = service
                    .getPackageManager()
                    .getApplicationLabel(service.getPackageManager().getApplicationInfo(packageName, 0));
            String text = charSequenceToString(label);
            return text.isEmpty() ? packageName : text;
        } catch (Throwable t) {
            return packageName;
        }
    }

    private static String appLabel(PackageManager packageManager, ApplicationInfo app) {
        if (app == null || app.packageName == null) {
            return "";
        }
        try {
            CharSequence label = packageManager.getApplicationLabel(app);
            String text = charSequenceToString(label);
            return text.isEmpty() ? app.packageName : text;
        } catch (Throwable t) {
            return app.packageName;
        }
    }

    private static void putString(JSONObject out, String key, String value) throws JSONException {
        out.put(key, value == null ? "" : value);
    }

    private static void putCharSequence(JSONObject out, String key, CharSequence value) throws JSONException {
        out.put(key, charSequenceToString(value));
    }

    private static CharSequence firstNonEmpty(CharSequence first, CharSequence second) {
        return charSequenceToString(first).isEmpty() ? second : first;
    }

    private static String charSequenceToString(CharSequence value) {
        return value == null ? "" : value.toString();
    }
}
