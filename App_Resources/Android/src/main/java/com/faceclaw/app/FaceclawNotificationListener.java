package com.faceclaw.app;

public interface FaceclawNotificationListener {
    void onNotificationPosted(String key);
    void onNotificationRemoved(String key);
}
