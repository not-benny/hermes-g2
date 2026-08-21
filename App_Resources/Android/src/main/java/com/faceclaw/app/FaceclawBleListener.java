package com.faceclaw.app;

import android.bluetooth.BluetoothGatt;

public interface FaceclawBleListener {
    void onNotification(String address, String characteristicUuid, byte[] data);
    void onConnectionStateChange(String address, boolean connected);

    default void onNotification(BluetoothGatt gatt, String address, String characteristicUuid, byte[] data) {
        onNotification(address, characteristicUuid, data);
    }

    default void onConnectionStateChange(BluetoothGatt gatt, String address, boolean connected) {
        onConnectionStateChange(address, connected);
    }

    default void onNotification(BluetoothGatt gatt, String address, String characteristicUuid, byte[] data,
                                GattCallbackRegistry.DispatchLease<BluetoothGatt> lease) {
        if (lease.isCurrent()) onNotification(gatt, address, characteristicUuid, data);
    }

    default void onConnectionStateChange(BluetoothGatt gatt, String address, boolean connected,
                                         GattCallbackRegistry.DispatchLease<BluetoothGatt> lease) {
        if (lease.isCurrent()) onConnectionStateChange(gatt, address, connected);
    }
}
