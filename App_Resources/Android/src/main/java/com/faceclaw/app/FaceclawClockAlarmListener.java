package com.faceclaw.app;

/** Active NativeScript runtime hook for a durable Android Clock alarm. */
public interface FaceclawClockAlarmListener {
    void onClockAlarm(String itemId, String kind, long dueAtMs, long scheduleGeneration);
    void onClockTimeChanged(String action);
}
