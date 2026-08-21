package com.faceclaw.app;

import android.annotation.SuppressLint;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothGatt;
import android.bluetooth.BluetoothGattCallback;
import android.bluetooth.BluetoothGattCharacteristic;
import android.bluetooth.BluetoothGattDescriptor;
import android.bluetooth.BluetoothGattService;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothProfile;
import android.content.Context;
import android.util.Log;

import java.util.List;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;


@SuppressLint("MissingPermission")
public class FaceclawBleManager {
    private static final String TAG = "FaceclawBle";
    private static final int[] WRITE_RETRY_DELAYS_MS = new int[] {1, 1, 1, 2, 4, 8, 12, 20, 35, 100, 200};
    private static final String OP_SERVICES = "services";
    private static final String OP_MTU = "mtu";
    private static final String OP_DESCRIPTOR = "descriptor";
    private static final String OP_WRITE = "write";
    private static final String OP_READ = "read";

    private final Context context;
    private final BluetoothAdapter bluetoothAdapter;

    private static final Object BLUETOOTH_API_LOCK = new Object();
    private final ConcurrentHashMap<String, Object> operationLocks = new ConcurrentHashMap<>();
    private final GattCallbackRegistry<BluetoothGatt> callbackRegistry = new GattCallbackRegistry<>();

    private volatile FaceclawBleListener listener;

    public FaceclawBleManager(Context context) {
        this.context = context.getApplicationContext();
        BluetoothManager bluetoothManager = (BluetoothManager) this.context.getSystemService(Context.BLUETOOTH_SERVICE);
        if (bluetoothManager == null || bluetoothManager.getAdapter() == null) {
            throw new IllegalStateException("Bluetooth adapter unavailable");
        }
        this.bluetoothAdapter = bluetoothManager.getAdapter();
    }

    public void setListener(FaceclawBleListener listener) {
        this.listener = listener;
    }

    public boolean connect(String address, int timeoutMs) {
        if (address == null || address.trim().isEmpty()) {
            throw new IllegalArgumentException("address is required");
        }
        Object operationLock = gattLock(address);
        BluetoothGatt gatt;
        synchronized (operationLock) {
            BluetoothGatt existing = callbackRegistry.current(address);
            if (existing != null) {
                return true;
            }

            GattCallbackRegistry.Operation<BluetoothGatt> operation = callbackRegistry.beginConnect(address);

            final BluetoothDevice device = bluetoothAdapter.getRemoteDevice(address);
            if (device == null) {
                callbackRegistry.cancel(address, GattCallbackRegistry.CONNECT, operation);
                throw new IllegalArgumentException("remote device not found: " + address);
            }

            synchronized (BLUETOOTH_API_LOCK) {
                gatt = device.connectGatt(
                    context,
                    false,
                    gattCallback,
                    BluetoothDevice.TRANSPORT_LE,
                    BluetoothDevice.PHY_LE_2M|BluetoothDevice.PHY_LE_1M
                );
            }
            if (gatt == null) {
                callbackRegistry.cancel(address, GattCallbackRegistry.CONNECT, operation);
                return false;
            }

            if (!callbackRegistry.bindConnectReturn(address, operation, gatt)) {
                closeGatt(gatt);
                return false;
            }

            if (!awaitOperation(operation, timeoutMs)) {
                callbackRegistry.cancel(address, GattCallbackRegistry.CONNECT, operation);
                invalidateGatt(address, gatt);
                return false;
            }
            return Integer.valueOf(1).equals(operation.status());
        }
    }

    public boolean requestConnectionPriority(String address, int priority) {
        synchronized (gattLock(address)) {
            BluetoothGatt gatt = requireGatt(address);
            synchronized (BLUETOOTH_API_LOCK) {
                return gatt.requestConnectionPriority(priority);
            }
        }
    }

    public boolean requestMtu(String address, int mtu, int timeoutMs) {
        synchronized (gattLock(address)) {
            BluetoothGatt gatt = requireGatt(address);
            GattCallbackRegistry.Operation<BluetoothGatt> operation =
                callbackRegistry.beginOperation(address, OP_MTU, gatt);
            boolean started;
            synchronized (BLUETOOTH_API_LOCK) {
                started = gatt.requestMtu(mtu);
            }
            if (!started) {
                callbackRegistry.cancel(address, OP_MTU, operation);
                return false;
            }
            if (!awaitOperation(operation, timeoutMs)) {
                callbackRegistry.cancel(address, OP_MTU, operation);
                invalidateGatt(address, gatt);
                return false;
            }
            return isGattSuccess(operation);
        }
    }

    public boolean discoverServices(String address, int timeoutMs) {
        synchronized (gattLock(address)) {
            BluetoothGatt gatt = requireGatt(address);
            GattCallbackRegistry.Operation<BluetoothGatt> operation =
                callbackRegistry.beginOperation(address, OP_SERVICES, gatt);
            boolean started;
            synchronized (BLUETOOTH_API_LOCK) {
                started = gatt.discoverServices();
            }
            if (!started) {
                callbackRegistry.cancel(address, OP_SERVICES, operation);
                return false;
            }
            if (!awaitOperation(operation, timeoutMs)) {
                callbackRegistry.cancel(address, OP_SERVICES, operation);
                invalidateGatt(address, gatt);
                return false;
            }
            return isGattSuccess(operation);
        }
    }

    /** Read a characteristic after service discovery; null on timeout or failure. */
    public byte[] readCharacteristic(String address, String characteristicUuid, int timeoutMs) {
        synchronized (gattLock(address)) {
            BluetoothGatt gatt = requireGatt(address);
            BluetoothGattCharacteristic characteristic = requireCharacteristic(gatt, characteristicUuid);
            GattCallbackRegistry.Operation<BluetoothGatt> operation =
                callbackRegistry.beginOperation(address, OP_READ, gatt);
            boolean started;
            synchronized (BLUETOOTH_API_LOCK) {
                started = gatt.readCharacteristic(characteristic);
            }
            if (!started) {
                callbackRegistry.cancel(address, OP_READ, operation);
                return null;
            }
            if (!awaitOperation(operation, timeoutMs)) {
                callbackRegistry.cancel(address, OP_READ, operation);
                invalidateGatt(address, gatt);
                return null;
            }
            byte[] value = operation.value();
            return isGattSuccess(operation) && value != null ? value : null;
        }
    }

    /** Compact UUID inventory for a connected device; intended for diagnostics. */
    public String describeServices(String address) {
        synchronized (gattLock(address)) {
            BluetoothGatt gatt = requireGatt(address);
            StringBuilder out = new StringBuilder();
            for (BluetoothGattService service : gatt.getServices()) {
                if (out.length() > 0) out.append(";");
                out.append(service.getUuid()).append("[");
                for (BluetoothGattCharacteristic characteristic : service.getCharacteristics()) {
                    if (out.charAt(out.length() - 1) != '[') out.append(",");
                    out.append(characteristic.getUuid())
                        .append("{properties=")
                        .append(characteristic.getProperties())
                        .append("}");
                }
                out.append("]");
            }
            return out.toString();
        }
    }

    public boolean enableNotifications(String address, String characteristicUuid, boolean enable, int timeoutMs) {
        synchronized (gattLock(address)) {
            BluetoothGatt gatt = requireGatt(address);
            BluetoothGattCharacteristic characteristic = requireCharacteristic(gatt, characteristicUuid);
            GattCallbackRegistry.Operation<BluetoothGatt> operation =
                callbackRegistry.beginOperation(address, OP_DESCRIPTOR, gatt);

            boolean notificationSet;
            synchronized (BLUETOOTH_API_LOCK) {
                notificationSet = gatt.setCharacteristicNotification(characteristic, enable);
            }
            if (!notificationSet) {
                callbackRegistry.cancel(address, OP_DESCRIPTOR, operation);
                return false;
            }

            BluetoothGattDescriptor descriptor = characteristic.getDescriptor(BleProtocol.CCCD_UUID);
            if (descriptor == null) {
                callbackRegistry.cancel(address, OP_DESCRIPTOR, operation);
                return true;
            }

            descriptor.setValue(enable
                    ? BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
                    : BluetoothGattDescriptor.DISABLE_NOTIFICATION_VALUE);
            boolean started;
            synchronized (BLUETOOTH_API_LOCK) {
                started = gatt.writeDescriptor(descriptor);
            }
            if (!started) {
                callbackRegistry.cancel(address, OP_DESCRIPTOR, operation);
                return false;
            }
            if (!awaitOperation(operation, timeoutMs)) {
                callbackRegistry.cancel(address, OP_DESCRIPTOR, operation);
                invalidateGatt(address, gatt);
                return false;
            }
            return isGattSuccess(operation);
        }
    }

    public boolean writeFrames(
        String address,
        String characteristicUuid,
        List<byte[]> frames,
        int writeType,
        int timeoutMs
    ) {
        if (frames == null || frames.isEmpty()) {
            return true;
        }

        long startMs = System.currentTimeMillis();
        synchronized (gattLock(address)) {
            BluetoothGatt gatt = requireGatt(address);
            BluetoothGattCharacteristic characteristic = requireCharacteristic(gatt, characteristicUuid);

            for (int i = 0; i < frames.size(); i++) {
                byte[] frame = frames.get(i);
                if (!startWrite(gatt, characteristic, address, frame, writeType, timeoutMs)) {
                    return false;
                }
            }
        }
        int totalSize = frames.stream().mapToInt(frame -> frame != null ? frame.length : 0).sum();
        Log.i(TAG, "writeFrames wrote " + frames.size() + " frames totaling " + totalSize + " bytes in " + (System.currentTimeMillis() - startMs) + "ms");
        return true;
    }

    private boolean startWrite(
            BluetoothGatt gatt,
            BluetoothGattCharacteristic characteristic,
            String address,
            byte[] data,
            int writeType,
            int timeoutMs
    ) {
        int retryCount = 0;
        while (true) {
            GattCallbackRegistry.Operation<BluetoothGatt> operation =
                callbackRegistry.beginOperation(address, OP_WRITE, gatt);

            long currentTime = System.currentTimeMillis();
            int result;
            synchronized (BLUETOOTH_API_LOCK) {
                result = gatt.writeCharacteristic(characteristic, data, writeType);
            }
            long timeAsleep = System.currentTimeMillis() - currentTime;
            //Log.i(TAG, "writeCharacteristic: spent " + timeAsleep + "ms");

            if (result == android.bluetooth.BluetoothStatusCodes.ERROR_GATT_WRITE_REQUEST_BUSY) {
                callbackRegistry.cancel(address, OP_WRITE, operation);
                if (!sleepBeforeWriteRetry(address, "busy", retryCount++)) {
                    return false;
                }
                continue;
            } else {
                //Log.i(TAG, "writeCharacteristic with writeType=" + writeType + " result=" + result + " retryCount=" + retryCount);
                if (result != android.bluetooth.BluetoothStatusCodes.SUCCESS) {
                    callbackRegistry.cancel(address, OP_WRITE, operation);
                    if (!sleepBeforeWriteRetry(address, "start result=" + result, retryCount++)) {
                        return false;
                    }
                    continue;
                }
                if (!awaitOperation(operation, timeoutMs)) {
                    callbackRegistry.cancel(address, OP_WRITE, operation);
                    invalidateGatt(address, gatt);
                    return false;
                }
                Integer status = operation.status();
                if (isGattSuccess(operation)) {
                    return true;
                }
                if (!sleepBeforeWriteRetry(address, "callback status=" + status, retryCount++)) {
                    return false;
                }
            }
        }
    }

    private boolean sleepBeforeWriteRetry(String address, String reason, int retryIndex) {
        if (retryIndex >= WRITE_RETRY_DELAYS_MS.length) {
            Log.w(TAG, "writeCharacteristic retry exhausted: address=" + address + " reason=" + reason);
            return false;
        }
        int delayMs = WRITE_RETRY_DELAYS_MS[retryIndex];
        Log.w(TAG, "writeCharacteristic retry: address=" + address + " reason=" + reason + " delayMs=" + delayMs);
        try {
            Thread.sleep(delayMs);
            return true;
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return false;
        }
    }

    public void disconnect(String address) {
        Object operationLock = gattLock(address);
        synchronized (operationLock) {
            BluetoothGatt gatt = callbackRegistry.current(address);
            if (gatt == null) {
                return;
            }
            callbackRegistry.retire(address, gatt, null);
            closeGatt(gatt);
        }
    }

    public void close() {
        while (true) {
            String address = null;
            for (String candidate : operationLocks.keySet()) {
                if (callbackRegistry.current(candidate) != null) {
                    address = candidate;
                    break;
                }
            }
            if (address == null) {
                return;
            }
            disconnect(address);
        }
    }

    private BluetoothGatt requireGatt(String address) {
        BluetoothGatt gatt = callbackRegistry.current(address);
        if (gatt == null) {
            throw new IllegalStateException("Not connected: " + address);
        }
        return gatt;
    }

    private BluetoothGattCharacteristic requireCharacteristic(BluetoothGatt gatt, String characteristicUuid) {
        UUID target = UUID.fromString(characteristicUuid);
        for (BluetoothGattService service : gatt.getServices()) {
            BluetoothGattCharacteristic characteristic = service.getCharacteristic(target);
            if (characteristic != null) {
                return characteristic;
            }
        }
        throw new IllegalStateException("Characteristic not found: " + characteristicUuid);
    }

    private boolean awaitOperation(GattCallbackRegistry.Operation<BluetoothGatt> operation, int timeoutMs) {
        try {
            return operation.await(timeoutMs);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return false;
        }
    }

    private boolean isGattSuccess(GattCallbackRegistry.Operation<BluetoothGatt> operation) {
        Integer status = operation.status();
        return status != null && status == BluetoothGatt.GATT_SUCCESS;
    }

    private void invalidateGatt(String address, BluetoothGatt gatt) {
        callbackRegistry.retire(address, gatt, null);
        closeGatt(gatt);
    }

    private void closeGatt(BluetoothGatt gatt) {
        synchronized (BLUETOOTH_API_LOCK) {
            gatt.disconnect();
            gatt.close();
        }
    }

    private void closeDisconnectedGatt(BluetoothGatt gatt) {
        synchronized (BLUETOOTH_API_LOCK) {
            gatt.close();
        }
    }

    private Object gattLock(String address) {
        return operationLocks.computeIfAbsent(address, ignored -> new Object());
    }

    private final BluetoothGattCallback gattCallback = new BluetoothGattCallback() {
        @Override
        public void onConnectionStateChange(BluetoothGatt gatt, int status, int newState) {
            Log.i(TAG, "onConnectionStateChange: status=" + status + " newState=" + newState);
            String address = gatt.getDevice().getAddress();

            if (newState == BluetoothProfile.STATE_CONNECTED && status == BluetoothGatt.GATT_SUCCESS) {
                callbackRegistry.completeConnect(
                    address,
                    gatt,
                    true,
                    () -> dispatchConnectionState(address, true)
                );
                return;
            }

            if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                boolean accepted = callbackRegistry.completeConnect(
                    address,
                    gatt,
                    false,
                    () -> dispatchConnectionState(address, false)
                );
                if (!accepted) {
                    accepted = callbackRegistry.disconnectIfCurrent(
                        address,
                        gatt,
                        () -> dispatchConnectionState(address, false)
                    );
                }
                if (accepted) {
                    synchronized (gattLock(address)) {
                        closeDisconnectedGatt(gatt);
                    }
                }
            }
        }

        @Override
        public void onServicesDiscovered(BluetoothGatt gatt, int status) {
            String address = gatt.getDevice().getAddress();
            callbackRegistry.completeOperation(address, OP_SERVICES, gatt, status, null);
        }

        @Override
        public void onMtuChanged(BluetoothGatt gatt, int mtu, int status) {
            String address = gatt.getDevice().getAddress();
            callbackRegistry.completeOperation(address, OP_MTU, gatt, status, null);
        }

        @Override
        public void onPhyRead(BluetoothGatt gatt, int txPhy, int rxPhy, int status) {
            Log.i(TAG, "onPhyRead: txPhy=" + txPhy + " rxPhy=" + rxPhy + " status=" + status);
        }

        @Override
        public void onDescriptorWrite(BluetoothGatt gatt, BluetoothGattDescriptor descriptor, int status) {
            String address = gatt.getDevice().getAddress();
            callbackRegistry.completeOperation(address, OP_DESCRIPTOR, gatt, status, null);
        }

        @Override
        public void onCharacteristicWrite(BluetoothGatt gatt, BluetoothGattCharacteristic characteristic, int status) {
            String address = gatt.getDevice().getAddress();
            callbackRegistry.completeOperation(address, OP_WRITE, gatt, status, null);
        }

        @Override
        public void onCharacteristicRead(BluetoothGatt gatt, BluetoothGattCharacteristic characteristic, byte[] value, int status) {
            String address = gatt.getDevice().getAddress();
            callbackRegistry.completeOperation(address, OP_READ, gatt, status, value);
        }

        @Deprecated
        @Override
        public void onCharacteristicRead(BluetoothGatt gatt, BluetoothGattCharacteristic characteristic, int status) {
            String address = gatt.getDevice().getAddress();
            callbackRegistry.completeOperation(address, OP_READ, gatt, status, characteristic.getValue());
        }

        @Override
        public void onCharacteristicChanged(BluetoothGatt gatt, BluetoothGattCharacteristic characteristic, byte[] value) {
            String address = gatt.getDevice().getAddress();
            callbackRegistry.dispatchIfCurrent(
                address,
                gatt,
                () -> dispatchNotification(address, characteristic.getUuid().toString(), value)
            );
        }

        @Deprecated
        @Override
        public void onCharacteristicChanged(BluetoothGatt gatt, BluetoothGattCharacteristic characteristic) {
            String address = gatt.getDevice().getAddress();
            callbackRegistry.dispatchIfCurrent(
                address,
                gatt,
                () -> dispatchNotification(address, characteristic.getUuid().toString(), characteristic.getValue())
            );
        }
    };

    private void dispatchConnectionState(String address, boolean connected) {
        FaceclawBleListener current = listener;
        if (current == null) return;
        current.onConnectionStateChange(address, connected);
    }

    private void dispatchNotification(String address, String characteristicUuid, byte[] data) {
        FaceclawBleListener current = listener;
        if (current == null) return;
        byte[] copy = data != null ? data.clone() : new byte[0];
        current.onNotification(address, characteristicUuid, copy);
    }
}