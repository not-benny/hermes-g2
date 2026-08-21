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

    private static final String CHANNEL_ID = "faceclaw-dashboard";
    private static final int NOTIFICATION_ID = 4201;

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
            stopForeground(STOP_FOREGROUND_REMOVE);
            stopSelf();
            return START_NOT_STICKY;
        }

        boolean connectedDeviceActive = intent.getBooleanExtra(EXTRA_CONNECTED_DEVICE_ACTIVE, false);
        boolean phoneMicActive = intent.getBooleanExtra(EXTRA_PHONE_MIC_ACTIVE, false);
        boolean locationActive = intent.getBooleanExtra(EXTRA_LOCATION_ACTIVE, false);
        if (!connectedDeviceActive && !phoneMicActive && !locationActive) {
            stopForeground(STOP_FOREGROUND_REMOVE);
            stopSelf();
            return START_NOT_STICKY;
        }

        ensureNotificationChannel();
        Notification notification = buildNotification(
                text != null && !text.trim().isEmpty() ? text : "Keeping the dashboard connected"
        );

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, notification,
                    foregroundServiceType(connectedDeviceActive, phoneMicActive, locationActive));
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
