package com.faceclaw.app;

public interface FaceclawBleListener {
    interface DispatchToken {
        boolean claim();
    }

    void onNotification(String address, String characteristicUuid, byte[] data);
    void onConnectionStateChange(String address, boolean connected);

    void onNotification(
            String address,
            String characteristicUuid,
            byte[] data,
            DispatchToken dispatchToken
    );

    void onConnectionStateChange(
            String address,
            boolean connected,
            DispatchToken dispatchToken
    );
}
