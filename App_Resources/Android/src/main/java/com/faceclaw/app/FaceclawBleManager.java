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
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Log;

import java.util.List;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

@SuppressLint("MissingPermission")
public class FaceclawBleManager {
    private static final String TAG = "FaceclawBle";
    private static final int[] WRITE_RETRY_DELAYS_MS = new int[] {1, 1, 1, 2, 4, 8, 12, 20, 35, 100, 200};

    private final Context context;
    private final BluetoothAdapter bluetoothAdapter;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    private final ConcurrentHashMap<String, BluetoothGatt> gattClients = new ConcurrentHashMap<>();
    private final Object bluetoothApiLock = new Object();

    private final ConcurrentHashMap<String, CountDownLatch> connectLatches = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, Boolean> connectResults = new ConcurrentHashMap<>();

    private final ConcurrentHashMap<String, CountDownLatch> servicesLatches = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, Integer> servicesStatuses = new ConcurrentHashMap<>();

    private final ConcurrentHashMap<String, CountDownLatch> mtuLatches = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, Integer> mtuStatuses = new ConcurrentHashMap<>();

    private final ConcurrentHashMap<String, CountDownLatch> descriptorLatches = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, Integer> descriptorStatuses = new ConcurrentHashMap<>();

    private final ConcurrentHashMap<String, CountDownLatch> writeLatches = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, Integer> writeStatuses = new ConcurrentHashMap<>();

    private final ConcurrentHashMap<String, CountDownLatch> readLatches = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, Integer> readStatuses = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, byte[]> readValues = new ConcurrentHashMap<>();

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
        CountDownLatch latch = new CountDownLatch(1);
        Object gattLock = gattLock(address);
        BluetoothGatt gatt;
        synchronized (gattLock) {
            BluetoothGatt existing = gattClients.get(address);
            if (existing != null) {
                return true;
            } else {
                connectLatches.put(address, latch);
                connectResults.remove(address);

                final BluetoothDevice device = bluetoothAdapter.getRemoteDevice(address);
                if (device == null) {
                    connectLatches.remove(address, latch);
                    throw new IllegalArgumentException("remote device not found: " + address);
                }

                gatt = device.connectGatt(
                    context,
                    false,
                    gattCallback,
                    BluetoothDevice.TRANSPORT_LE,
                    BluetoothDevice.PHY_LE_2M|BluetoothDevice.PHY_LE_1M
                );
                if (gatt != null) {
                    gattClients.put(address, gatt);
                }

                if (gatt == null) {
                    connectLatches.remove(address, latch);
                    return false;
                }
            }
        }

        // Do not hold the identity/API lock while waiting: Android delivers the
        // state callback on another thread, which must be able to acquire it.
        if (!awaitLatch(latch, timeoutMs)) {
            synchronized (gattLock) {
                connectLatches.remove(address, latch);
                connectResults.remove(address);
                gattClients.remove(address, gatt);
            }
            synchronized (bluetoothApiLock) {
                gatt.disconnect();
                gatt.close();
            }
            return false;
        }

        synchronized (gattLock) {
            Boolean connected = connectResults.remove(address);
            connectLatches.remove(address, latch);
            return Boolean.TRUE.equals(connected) && gattClients.get(address) == gatt;
        }
    }

    public boolean requestConnectionPriority(String address, int priority) {
        synchronized (gattLock(address)) {
            BluetoothGatt gatt = requireGatt(address);
            return gatt.requestConnectionPriority(priority);
        }
    }

    public boolean requestMtu(String address, int mtu, int timeoutMs) {
        synchronized (gattLock(address)) {
            CountDownLatch latch = new CountDownLatch(1);
            mtuLatches.put(address, latch);
            mtuStatuses.remove(address);

            BluetoothGatt gatt = requireGatt(address);
            boolean started = gatt.requestMtu(mtu);
            if (!started) {
                mtuLatches.remove(address);
                return false;
            }
            if (!awaitLatch(latch, timeoutMs)) {
                mtuLatches.remove(address);
                mtuStatuses.remove(address);
                return false;
            }
            Integer status = mtuStatuses.remove(address);
            mtuLatches.remove(address);
            return status != null && status == BluetoothGatt.GATT_SUCCESS;
        }
    }

    public boolean discoverServices(String address, int timeoutMs) {
        synchronized (gattLock(address)) {
            CountDownLatch latch = new CountDownLatch(1);
            servicesLatches.put(address, latch);
            servicesStatuses.remove(address);

            BluetoothGatt gatt = requireGatt(address);
            boolean started = gatt.discoverServices();
            if (!started) {
                servicesLatches.remove(address);
                return false;
            }
            if (!awaitLatch(latch, timeoutMs)) {
                servicesLatches.remove(address);
                servicesStatuses.remove(address);
                return false;
            }
            Integer status = servicesStatuses.remove(address);
            servicesLatches.remove(address);
            return status != null && status == BluetoothGatt.GATT_SUCCESS;
        }
    }

    /** Read a characteristic after service discovery; null on timeout or failure. */
    public byte[] readCharacteristic(String address, String characteristicUuid, int timeoutMs) {
        synchronized (gattLock(address)) {
            CountDownLatch latch = new CountDownLatch(1);
            readLatches.put(address, latch);
            readStatuses.remove(address);
            readValues.remove(address);

            BluetoothGatt gatt = requireGatt(address);
            BluetoothGattCharacteristic characteristic = requireCharacteristic(gatt, characteristicUuid);
            if (!gatt.readCharacteristic(characteristic)) {
                readLatches.remove(address);
                return null;
            }
            if (!awaitLatch(latch, timeoutMs)) {
                readLatches.remove(address);
                readStatuses.remove(address);
                readValues.remove(address);
                return null;
            }
            Integer status = readStatuses.remove(address);
            byte[] value = readValues.remove(address);
            readLatches.remove(address);
            return status != null && status == BluetoothGatt.GATT_SUCCESS && value != null ? value.clone() : null;
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
            CountDownLatch latch = new CountDownLatch(1);
            descriptorLatches.put(address, latch);
            descriptorStatuses.remove(address);

            BluetoothGatt gatt = requireGatt(address);
            BluetoothGattCharacteristic characteristic = requireCharacteristic(gatt, characteristicUuid);

            boolean notificationSet = gatt.setCharacteristicNotification(characteristic, enable);
            if (!notificationSet) {
                descriptorLatches.remove(address);
                return false;
            }

            BluetoothGattDescriptor descriptor = characteristic.getDescriptor(BleProtocol.CCCD_UUID);
            if (descriptor == null) {
                descriptorLatches.remove(address);
                return true;
            }

            descriptor.setValue(enable
                    ? BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
                    : BluetoothGattDescriptor.DISABLE_NOTIFICATION_VALUE);
            boolean started = gatt.writeDescriptor(descriptor);
            if (!started) {
                descriptorLatches.remove(address);
                descriptorStatuses.remove(address);
                return false;
            }
            if (!awaitLatch(latch, timeoutMs)) {
                descriptorLatches.remove(address);
                descriptorStatuses.remove(address);
                return false;
            }
            Integer status = descriptorStatuses.remove(address);
            descriptorLatches.remove(address);
            return status != null && status == BluetoothGatt.GATT_SUCCESS;
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
            CountDownLatch latch = new CountDownLatch(1);
            writeLatches.put(address, latch);
            writeStatuses.remove(address);

            long currentTime = System.currentTimeMillis();
            int result = gatt.writeCharacteristic(characteristic, data, writeType);
            long timeAsleep = System.currentTimeMillis() - currentTime;
            //Log.i(TAG, "writeCharacteristic: spent " + timeAsleep + "ms");

            if (result == android.bluetooth.BluetoothStatusCodes.ERROR_GATT_WRITE_REQUEST_BUSY) {
                writeLatches.remove(address, latch);
                writeStatuses.remove(address);
                if (!sleepBeforeWriteRetry(address, "busy", retryCount++)) {
                    return false;
                }
                continue;
            } else {
                //Log.i(TAG, "writeCharacteristic with writeType=" + writeType + " result=" + result + " retryCount=" + retryCount);
                if (result != android.bluetooth.BluetoothStatusCodes.SUCCESS) {
                    writeLatches.remove(address, latch);
                    writeStatuses.remove(address);
                    if (!sleepBeforeWriteRetry(address, "start result=" + result, retryCount++)) {
                        return false;
                    }
                    continue;
                }
                if (!awaitLatch(latch, timeoutMs)) {
                    writeLatches.remove(address, latch);
                    writeStatuses.remove(address);
                    return false;
                }
                Integer status = writeStatuses.remove(address);
                writeLatches.remove(address);
                if (status != null && status == BluetoothGatt.GATT_SUCCESS) {
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
        Object gattLock = gattLock(address);
        synchronized (gattLock) {
            BluetoothGatt gatt = gattClients.remove(address);
            if (gatt == null) {
                return;
            }
            gatt.disconnect();
            gatt.close();
        }
    }

    public void close() {
        for (String address : gattClients.keySet()) {
            disconnect(address);
        }
    }

    private BluetoothGatt requireGatt(String address) {
        BluetoothGatt gatt = gattClients.get(address);
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

    private boolean awaitLatch(CountDownLatch latch, int timeoutMs) {
        try {
            return latch.await(timeoutMs, TimeUnit.MILLISECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return false;
        }
    }

    private Object gattLock(String address) {
        // Android's Bluetooth stack has process-wide command-pipeline constraints on some devices.
        // Keep every BluetoothGatt API call serialized globally, even for different MAC addresses.
        return bluetoothApiLock;
    }

    private final BluetoothGattCallback gattCallback = new BluetoothGattCallback() {
        @Override
        public void onConnectionStateChange(BluetoothGatt gatt, int status, int newState) {
            Log.i(TAG, "onConnectionStateChange: status=" + status + " newState=" + newState);
            String address = gatt.getDevice().getAddress();
            Object gattLock = gattLock(address);

            synchronized (gattLock) {
                if (gattClients.get(address) != gatt) {
                    // A delayed callback from a retired transport must not complete or
                    // publish the replacement attempt. It may only close itself.
                    if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                        gatt.close();
                    }
                    return;
                }

                if (newState == BluetoothProfile.STATE_CONNECTED && status == BluetoothGatt.GATT_SUCCESS) {
                    connectResults.put(address, true);
                    CountDownLatch latch = connectLatches.remove(address);
                    if (latch != null) {
                        latch.countDown();
                    }
                    dispatchConnectionState(address, true);
                    return;
                }

                if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                    connectResults.put(address, false);
                    CountDownLatch latch = connectLatches.remove(address);
                    if (latch != null) {
                        latch.countDown();
                    }
                    gattClients.remove(address, gatt);
                    gatt.close();
                    dispatchConnectionState(address, false);
                }
            }
        }

        @Override
        public void onServicesDiscovered(BluetoothGatt gatt, int status) {
            String address = gatt.getDevice().getAddress();
            servicesStatuses.put(address, status);
            CountDownLatch latch = servicesLatches.remove(address);
            if (latch != null) {
                latch.countDown();
            }
        }

        @Override
        public void onMtuChanged(BluetoothGatt gatt, int mtu, int status) {
            String address = gatt.getDevice().getAddress();
            mtuStatuses.put(address, status);
            CountDownLatch latch = mtuLatches.remove(address);
            if (latch != null) {
                latch.countDown();
            }
        }

        @Override
        public void onPhyRead(BluetoothGatt gatt, int txPhy, int rxPhy, int status) {
            Log.i(TAG, "onPhyRead: txPhy=" + txPhy + " rxPhy=" + rxPhy + " status=" + status);
        }

        @Override
        public void onDescriptorWrite(BluetoothGatt gatt, BluetoothGattDescriptor descriptor, int status) {
            String address = gatt.getDevice().getAddress();
            descriptorStatuses.put(address, status);
            CountDownLatch latch = descriptorLatches.remove(address);
            if (latch != null) {
                latch.countDown();
            }
        }

        @Override
        public void onCharacteristicWrite(BluetoothGatt gatt, BluetoothGattCharacteristic characteristic, int status) {
            String address = gatt.getDevice().getAddress();
            writeStatuses.put(address, status);
            CountDownLatch latch = writeLatches.remove(address);
            if (latch != null) {
                latch.countDown();
            }
        }

        @Override
        public void onCharacteristicRead(BluetoothGatt gatt, BluetoothGattCharacteristic characteristic, byte[] value, int status) {
            finishCharacteristicRead(gatt.getDevice().getAddress(), value, status);
        }

        @Deprecated
        @Override
        public void onCharacteristicRead(BluetoothGatt gatt, BluetoothGattCharacteristic characteristic, int status) {
            finishCharacteristicRead(gatt.getDevice().getAddress(), characteristic.getValue(), status);
        }

        @Override
        public void onCharacteristicChanged(BluetoothGatt gatt, BluetoothGattCharacteristic characteristic, byte[] value) {
            dispatchNotification(gatt, characteristic.getUuid().toString(), value);
        }

        @Deprecated
        @Override
        public void onCharacteristicChanged(BluetoothGatt gatt, BluetoothGattCharacteristic characteristic) {
            dispatchNotification(gatt, characteristic.getUuid().toString(), characteristic.getValue());
        }
    };

    private void finishCharacteristicRead(String address, byte[] value, int status) {
        readStatuses.put(address, status);
        if (value != null) {
            readValues.put(address, value.clone());
        }
        CountDownLatch latch = readLatches.remove(address);
        if (latch != null) {
            latch.countDown();
        }
    }

    private void dispatchConnectionState(String address, boolean connected) {
        FaceclawBleListener current = listener;
        if (current == null) return;
        current.onConnectionStateChange(address, connected);
    }

    private void dispatchNotification(BluetoothGatt gatt, String characteristicUuid, byte[] data) {
        String address = gatt.getDevice().getAddress();
        synchronized (gattLock(address)) {
            if (gattClients.get(address) != gatt) {
                return;
            }
            FaceclawBleListener current = listener;
            if (current == null) return;
            byte[] copy = data != null ? data.clone() : new byte[0];
            current.onNotification(address, characteristicUuid, copy);
        }
    }
}
