package com.faceclaw.app;

import java.lang.ref.WeakReference;
import java.util.HashMap;
import java.util.Iterator;
import java.util.LinkedList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/**
 * Identity-bound callback state shared by BLE caller and callback threads.
 *
 * All current-GATT checks, operation result publication, waiter completion, and
 * listener dispatch happen under this object's monitor. Callers must not invoke
 * Android Bluetooth APIs while holding this monitor.
 */
final class GattCallbackRegistry<G> {
    static final String CONNECT = "connect";

    static final class Operation<G> {
        private final CountDownLatch latch = new CountDownLatch(1);
        private G gatt;
        private Integer status;
        private byte[] value;

        private Operation(G gatt) {
            this.gatt = gatt;
        }

        boolean await(int timeoutMs) throws InterruptedException {
            return latch.await(timeoutMs, TimeUnit.MILLISECONDS);
        }

        long remaining() {
            return latch.getCount();
        }

        Integer status() {
            return status;
        }

        byte[] value() {
            return value != null ? value.clone() : null;
        }

        G gatt() {
            return gatt;
        }
    }

    private final Map<String, G> currentGatts = new HashMap<>();
    private final Map<String, Map<String, Operation<G>>> operations = new HashMap<>();
    private final List<WeakReference<G>> retiredGatts = new LinkedList<>();

    synchronized G current(String address) {
        return currentGatts.get(address);
    }

    synchronized boolean isCurrent(String address, G gatt) {
        return gatt != null && currentGatts.get(address) == gatt && !isRetired(gatt);
    }

    synchronized Operation<G> beginConnect(String address) {
        Operation<G> operation = new Operation<>(null);
        operationsFor(address).put(CONNECT, operation);
        return operation;
    }

    synchronized boolean bindConnectReturn(String address, Operation<G> operation, G gatt) {
        if (gatt == null || isRetired(gatt)) {
            return false;
        }
        if (operationFor(address, CONNECT) != operation) {
            return operation.gatt == gatt
                && Integer.valueOf(1).equals(operation.status)
                && currentGatts.get(address) == gatt;
        }
        G current = currentGatts.get(address);
        if (current != null && current != gatt) {
            return false;
        }
        if (operation.gatt != null && operation.gatt != gatt) {
            return false;
        }
        operation.gatt = gatt;
        currentGatts.put(address, gatt);
        return true;
    }

    synchronized Operation<G> beginOperation(String address, String kind, G gatt) {
        if (!isCurrent(address, gatt)) {
            throw new IllegalStateException("Not connected: " + address);
        }
        Operation<G> operation = new Operation<>(gatt);
        operationsFor(address).put(kind, operation);
        return operation;
    }

    synchronized boolean completeConnect(String address, G gatt, boolean connected, Runnable dispatch) {
        Operation<G> operation = operationFor(address, CONNECT);
        if (operation == null || gatt == null || isRetired(gatt)) {
            return false;
        }
        if (operation.gatt == null) {
            if (currentGatts.get(address) != null) {
                return false;
            }
            operation.gatt = gatt;
            currentGatts.put(address, gatt);
        }
        if (operation.gatt != gatt || currentGatts.get(address) != gatt) {
            return false;
        }

        operation.status = connected ? 1 : 0;
        removeOperation(address, CONNECT, operation);
        if (!connected) {
            retireLocked(address, gatt);
        }
        operation.latch.countDown();
        if (dispatch != null) {
            dispatch.run();
        }
        return true;
    }

    synchronized boolean completeOperation(
            String address,
            String kind,
            G gatt,
            int status,
            byte[] value
    ) {
        Operation<G> operation = operationFor(address, kind);
        if (!isCurrent(address, gatt) || operation == null || operation.gatt != gatt) {
            return false;
        }
        operation.status = status;
        operation.value = value != null ? value.clone() : null;
        removeOperation(address, kind, operation);
        operation.latch.countDown();
        return true;
    }

    synchronized boolean dispatchIfCurrent(String address, G gatt, Runnable dispatch) {
        if (!isCurrent(address, gatt)) {
            return false;
        }
        dispatch.run();
        return true;
    }

    synchronized boolean disconnectIfCurrent(String address, G gatt, Runnable dispatch) {
        if (!isCurrent(address, gatt)) {
            return false;
        }
        retireLocked(address, gatt);
        if (dispatch != null) {
            dispatch.run();
        }
        return true;
    }

    synchronized boolean cancel(String address, String kind, Operation<G> operation) {
        if (operationFor(address, kind) != operation) {
            return false;
        }
        removeOperation(address, kind, operation);
        operation.latch.countDown();
        return true;
    }

    synchronized boolean retire(String address, G gatt, Runnable dispatch) {
        if (gatt == null || currentGatts.get(address) != gatt) {
            return false;
        }
        retireLocked(address, gatt);
        if (dispatch != null) {
            dispatch.run();
        }
        return true;
    }

    private Map<String, Operation<G>> operationsFor(String address) {
        return operations.computeIfAbsent(address, ignored -> new HashMap<>());
    }

    private Operation<G> operationFor(String address, String kind) {
        Map<String, Operation<G>> addressOperations = operations.get(address);
        return addressOperations != null ? addressOperations.get(kind) : null;
    }

    private void removeOperation(String address, String kind, Operation<G> operation) {
        Map<String, Operation<G>> addressOperations = operations.get(address);
        if (addressOperations == null || addressOperations.get(kind) != operation) {
            return;
        }
        addressOperations.remove(kind);
        if (addressOperations.isEmpty()) {
            operations.remove(address);
        }
    }

    private void retireLocked(String address, G gatt) {
        if (currentGatts.get(address) == gatt) {
            currentGatts.remove(address);
        }
        retiredGatts.add(new WeakReference<>(gatt));
        Map<String, Operation<G>> addressOperations = operations.get(address);
        if (addressOperations == null) {
            return;
        }
        Iterator<Map.Entry<String, Operation<G>>> iterator = addressOperations.entrySet().iterator();
        while (iterator.hasNext()) {
            Operation<G> operation = iterator.next().getValue();
            if (operation.gatt == gatt) {
                operation.latch.countDown();
                iterator.remove();
            }
        }
        if (addressOperations.isEmpty()) {
            operations.remove(address);
        }
    }

    private boolean isRetired(G gatt) {
        Iterator<WeakReference<G>> iterator = retiredGatts.iterator();
        while (iterator.hasNext()) {
            G retired = iterator.next().get();
            if (retired == null) {
                iterator.remove();
            } else if (retired == gatt) {
                return true;
            }
        }
        return false;
    }
}
