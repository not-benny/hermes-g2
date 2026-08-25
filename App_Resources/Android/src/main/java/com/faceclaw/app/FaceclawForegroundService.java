package com.faceclaw.app;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;

import androidx.core.content.ContextCompat;

import com.tns.NativeScriptActivity;

public class FaceclawForegroundService extends Service {
    public static final String ACTION_START = "com.faceclaw.app.action.START";
    public static final String ACTION_UPDATE = "com.faceclaw.app.action.UPDATE";
    public static final String ACTION_STOP = "com.faceclaw.app.action.STOP";
    public static final String EXTRA_TEXT = "text";
    public static final String EXTRA_CONNECTED_DEVICE_ACTIVE = "connectedDeviceActive";
    public static final String EXTRA_PHONE_MIC_ACTIVE = "phoneMicActive";
    public static final String EXTRA_LOCATION_ACTIVE = "locationActive";
    public static final String EXTRA_CLOCK_ALERT_ACTIVE = "clockAlertActive";

    private static final String CHANNEL_ID = "faceclaw-dashboard";
    private static final int NOTIFICATION_ID = 4201;
    private boolean connectedDeviceActive;
    private boolean phoneMicActive;
    private boolean locationActive;
    private boolean clockAlertActive;
    private PowerManager.WakeLock clockRecoveryWakeLock;
    private static final long CLOCK_RECOVERY_WAKE_MS = 65_000L;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final Runnable clockRecoveryTimeout = () -> {
        if (!clockAlertActive) return;
        clockAlertActive = false;
        setClockRecoveryWakeLock(false);
        if (!connectedDeviceActive && !phoneMicActive && !locationActive) {
            stopForeground(STOP_FOREGROUND_REMOVE);
            stopSelf();
        } else {
            NotificationManager manager = getSystemService(NotificationManager.class);
            if (manager != null) manager.notify(NOTIFICATION_ID,
                    buildNotification("Keeping the dashboard connected"));
        }
    };

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null) {
            stopForeground(STOP_FOREGROUND_REMOVE);
            stopSelf();
            return START_NOT_STICKY;
        }
        String action = intent.getAction();
        String text = intent.getStringExtra(EXTRA_TEXT);

        if (ACTION_STOP.equals(action)) {
            stopIfLatest(startId);
            return START_NOT_STICKY;
        }

        if (intent.hasExtra(EXTRA_CONNECTED_DEVICE_ACTIVE)) {
            connectedDeviceActive = intent.getBooleanExtra(EXTRA_CONNECTED_DEVICE_ACTIVE, false);
        }
        if (intent.hasExtra(EXTRA_PHONE_MIC_ACTIVE)) {
            phoneMicActive = intent.getBooleanExtra(EXTRA_PHONE_MIC_ACTIVE, false);
        }
        if (intent.hasExtra(EXTRA_LOCATION_ACTIVE)) {
            locationActive = intent.getBooleanExtra(EXTRA_LOCATION_ACTIVE, false);
        }
        if (intent.hasExtra(EXTRA_CLOCK_ALERT_ACTIVE)) {
            clockAlertActive = intent.getBooleanExtra(EXTRA_CLOCK_ALERT_ACTIVE, false);
            setClockRecoveryWakeLock(clockAlertActive);
        }
        if (!connectedDeviceActive && !phoneMicActive && !locationActive && !clockAlertActive) {
            // Inactive/release intents are dispatched with Context.startService,
            // never startForegroundService: there is no valid active operation
            // (and therefore no truthful foreground-service type) to promote.
            // startId-aware teardown also prevents an older queued release from
            // stopping a newer positive foreground request.
            stopIfLatest(startId);
            return START_NOT_STICKY;
        }

        ensureNotificationChannel();
        Notification notification = buildNotification(text != null && !text.trim().isEmpty()
                ? text
                : clockAlertActive ? "Recovering a Clock alert" : "Keeping the dashboard connected");

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, notification,
                    foregroundServiceType(
                            connectedDeviceActive || clockAlertActive,
                            phoneMicActive,
                            locationActive));
        } else {
            startForeground(NOTIFICATION_ID, notification);
        }

        if (ACTION_UPDATE.equals(action)) {
            NotificationManager manager = getSystemService(NotificationManager.class);
            if (manager != null) {
                manager.notify(NOTIFICATION_ID, notification);
            }
        }

        return START_NOT_STICKY;
    }

    private void stopIfLatest(int startId) {
        if (stopSelfResult(startId)) {
            stopForeground(STOP_FOREGROUND_REMOVE);
        }
    }

    @Override
    public void onDestroy() {
        setClockRecoveryWakeLock(false);
        super.onDestroy();
    }

    private void setClockRecoveryWakeLock(boolean active) {
        mainHandler.removeCallbacks(clockRecoveryTimeout);
        if (!active) {
            if (clockRecoveryWakeLock != null && clockRecoveryWakeLock.isHeld()) {
                clockRecoveryWakeLock.release();
            }
            clockRecoveryWakeLock = null;
            return;
        }
        if (clockRecoveryWakeLock == null) {
            PowerManager manager = (PowerManager) getSystemService(POWER_SERVICE);
            if (manager == null) return;
            clockRecoveryWakeLock = manager.newWakeLock(
                    PowerManager.PARTIAL_WAKE_LOCK, "Faceclaw:ClockRecovery");
            clockRecoveryWakeLock.setReferenceCounted(false);
        }
        if (!clockRecoveryWakeLock.isHeld()) {
            clockRecoveryWakeLock.acquire(CLOCK_RECOVERY_WAKE_MS);
        }
        // The exact-alarm recovery lease is deliberately bounded even if the
        // JS runtime never boots or BLE recovery never reports completion.
        mainHandler.postDelayed(clockRecoveryTimeout, CLOCK_RECOVERY_WAKE_MS);
    }

    private void ensureNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return;
        }

        NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                "Hermes G2 dashboard",
                NotificationManager.IMPORTANCE_LOW
        );
        channel.setDescription("Keeps the Hermes G2 dashboard connected to the glasses.");

        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null) {
            manager.createNotificationChannel(channel);
        }
    }

    private Notification buildNotification(String text) {
        Intent launchIntent = new Intent(this, NativeScriptActivity.class);
        launchIntent.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);

        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            flags |= PendingIntent.FLAG_IMMUTABLE;
        }

        PendingIntent contentIntent = PendingIntent.getActivity(this, 0, launchIntent, flags);

        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(this, CHANNEL_ID)
                : new Notification.Builder(this);

        return builder
                .setContentTitle("Hermes G2 dashboard")
                .setContentText(text)
                .setSmallIcon(getApplicationInfo().icon)
                .setContentIntent(contentIntent)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .build();
    }

    private int foregroundServiceType(
            boolean connectedDeviceActive,
            boolean phoneMicActive,
            boolean locationActive) {
        int type = 0;
        if (connectedDeviceActive) {
            type |= ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE;
        }
        if (phoneMicActive && hasRecordAudioPermission()) {
            type |= ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE;
        }
        if (locationActive && hasFineLocationPermission()) {
            type |= ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION;
        }
        return type;
    }

    private boolean hasRecordAudioPermission() {
        return ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO)
                == PackageManager.PERMISSION_GRANTED;
    }

    private boolean hasFineLocationPermission() {
        return ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION)
                == PackageManager.PERMISSION_GRANTED;
    }
}
