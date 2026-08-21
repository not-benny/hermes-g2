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
 * Current-GATT checks, operation result publication, and waiter completion happen
 * under this object's monitor. External listeners receive a one-shot generation
 * token and must claim it under their own state lock before mutating state. No
 * listener or Android Bluetooth API runs while this monitor is held.
 */
final class GattCallbackRegistry<G> {
    static final String CONNECT = "connect";

    static final class Operation<G> {
        private final CountDownLatch latch = new CountDownLatch(1);
        private G gatt;
        private Integer status;
        private byte[] value;
        private final long generation;

        private Operation(G gatt, long generation) {
            this.gatt = gatt;
            this.generation = generation;
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
    private final Map<String, Long> generations = new HashMap<>();
    private final List<WeakReference<G>> retiredGatts = new LinkedList<>();
    private long nextGeneration;

    private final class Dispatch implements FaceclawBleListener.DispatchToken {
        private final String address;
        private final G gatt;
        private final long generation;
        private final boolean requireCurrent;
        private boolean claimed;

        private Dispatch(String address, G gatt, long generation, boolean requireCurrent) {
            this.address = address;
            this.gatt = gatt;
            this.generation = generation;
            this.requireCurrent = requireCurrent;
        }

        @Override public boolean claim() {
            synchronized (GattCallbackRegistry.this) {
                if (claimed || !Long.valueOf(generation).equals(generations.get(address))) {
                    return false;
                }
                if (requireCurrent && (currentGatts.get(address) != gatt || isRetired(gatt))) {
                    return false;
                }
                claimed = true;
                return true;
            }
        }
    }

    synchronized G current(String address) {
        return currentGatts.get(address);
    }

    synchronized boolean isCurrent(String address, G gatt) {
        return gatt != null && currentGatts.get(address) == gatt && !isRetired(gatt);
    }

    synchronized Operation<G> beginConnect(String address) {
        long generation = ++nextGeneration;
        generations.put(address, generation);
        Operation<G> operation = new Operation<>(null, generation);
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
        Operation<G> operation = new Operation<>(gatt, generationFor(address));
        operationsFor(address).put(kind, operation);
        return operation;
    }

    synchronized FaceclawBleListener.DispatchToken completeConnect(
            String address,
            G gatt,
            boolean connected
    ) {
        Operation<G> operation = operationFor(address, CONNECT);
        if (operation == null || gatt == null || isRetired(gatt)) {
            return null;
        }
        if (operation.gatt == null) {
            if (currentGatts.get(address) != null) {
                return null;
            }
            operation.gatt = gatt;
            currentGatts.put(address, gatt);
        }
        if (operation.gatt != gatt || currentGatts.get(address) != gatt) {
            return null;
        }

        operation.status = connected ? 1 : 0;
        removeOperation(address, CONNECT, operation);
        if (!connected) {
            retireLocked(address, gatt);
        }
        operation.latch.countDown();
        return new Dispatch(address, gatt, operation.generation, connected);
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

    synchronized FaceclawBleListener.DispatchToken dispatchIfCurrent(String address, G gatt) {
        if (!isCurrent(address, gatt)) {
            return null;
        }
        return new Dispatch(address, gatt, generationFor(address), true);
    }

    synchronized FaceclawBleListener.DispatchToken disconnectIfCurrent(String address, G gatt) {
        if (!isCurrent(address, gatt)) {
            return null;
        }
        long generation = generationFor(address);
        retireLocked(address, gatt);
        return new Dispatch(address, gatt, generation, false);
    }

    synchronized boolean cancel(String address, String kind, Operation<G> operation) {
        if (operationFor(address, kind) != operation) {
            return false;
        }
        removeOperation(address, kind, operation);
        operation.latch.countDown();
        return true;
    }

    synchronized boolean retire(String address, G gatt) {
        if (gatt == null || currentGatts.get(address) != gatt) {
            return false;
        }
        retireLocked(address, gatt);
        return true;
    }

    private long generationFor(String address) {
        Long generation = generations.get(address);
        return generation != null ? generation : 0;
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
