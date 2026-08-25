package com.faceclaw.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Alarm, boot, and wall-clock lifecycle receiver for the durable Clock mirror. */
public final class FaceclawClockReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null) return;
        if (FaceclawClockScheduler.ACTION_FIRE.equals(intent.getAction())) {
            FaceclawClockScheduler.handleFire(context, intent);
            return;
        }
        if (FaceclawClockScheduler.ACTION_CAMPAIGN_WAKE.equals(intent.getAction())) {
            FaceclawClockScheduler.handleCampaignWake(context, intent);
            return;
        }
        String action = intent.getAction();
        if (Intent.ACTION_BOOT_COMPLETED.equals(action)
                || Intent.ACTION_TIME_CHANGED.equals(action)
                || Intent.ACTION_TIMEZONE_CHANGED.equals(action)) {
            FaceclawClockScheduler.rescheduleAll(context, action);
            if (Intent.ACTION_TIME_CHANGED.equals(action)
                    || Intent.ACTION_TIMEZONE_CHANGED.equals(action)) {
                FaceclawClockScheduler.notifyTimeChanged(action);
            }
        }
    }
}
