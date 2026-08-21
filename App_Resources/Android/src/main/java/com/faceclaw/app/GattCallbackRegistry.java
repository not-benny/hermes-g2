package com.faceclaw.app;

import java.lang.ref.WeakReference;
import java.util.HashMap;
import java.util.Iterator;
import java.util.LinkedList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.locks.ReentrantLock;
import java.util.function.Consumer;

/** Identity- and generation-bound BLE callback state. */
final class GattCallbackRegistry<G> {
    static final String CONNECT = "connect";

    static final class Operation<G> {
        private final CountDownLatch latch = new CountDownLatch(1);
        private final long generation;
        private G gatt;
        private Integer status;
        private byte[] value;
        private boolean failed;

        private Operation(G gatt, long generation) {
            this.gatt = gatt;
            this.generation = generation;
        }
        boolean await(int timeoutMs) throws InterruptedException { return latch.await(timeoutMs, TimeUnit.MILLISECONDS); }
        long remaining() { return latch.getCount(); }
        Integer status() { return status; }
        boolean failed() { return failed; }
        byte[] value() { return value != null ? value.clone() : null; }
        G gatt() { return gatt; }
        long generation() { return generation; }
    }

    static final class DispatchLease<G> {
        private final GattCallbackRegistry<G> registry;
        private final String address;
        private final G gatt;
        private final long generation;
        private final boolean retiredDelivery;

        private DispatchLease(GattCallbackRegistry<G> registry, String address, G gatt, long generation,
                              boolean retiredDelivery) {
            this.registry = registry;
            this.address = address;
            this.gatt = gatt;
            this.generation = generation;
            this.retiredDelivery = retiredDelivery;
        }

        boolean isCurrent() {
            synchronized (registry) {
                boolean current = registry.currentGatts.get(address) == gatt
                    && registry.currentGeneration(address) == generation
                    && !registry.isRetired(gatt);
                boolean terminal = retiredDelivery
                    && registry.currentGatts.get(address) == null
                    && registry.currentGeneration(address) == -1L
                    && registry.nextGenerations.getOrDefault(address, 0L) == generation;
                return current || terminal;
            }
        }

        boolean dispatchIfCurrent(Consumer<DispatchLease<G>> dispatch) {
            ReentrantLock gate = registry.dispatchGates.computeIfAbsent(address, ignored -> new ReentrantLock());
            gate.lock();
            try {
                synchronized (registry) {
                    boolean current = registry.currentGatts.get(address) == gatt
                        && registry.currentGeneration(address) == generation
                        && !registry.isRetired(gatt);
                    boolean terminal = retiredDelivery
                        && registry.currentGatts.get(address) == null
                        && registry.currentGeneration(address) == -1L
                        && registry.nextGenerations.getOrDefault(address, 0L) == generation;
                    if (!current && !terminal) return false;
                }
                if (dispatch != null) dispatch.accept(this);
                return true;
            } finally {
                gate.unlock();
            }
        }
    }

    private final Map<String, G> currentGatts = new HashMap<>();
    private final Map<String, Long> currentGenerations = new HashMap<>();
    private final Map<String, Long> nextGenerations = new HashMap<>();
    private final Map<String, Map<String, Operation<G>>> operations = new HashMap<>();
    private final List<WeakReference<G>> retiredGatts = new LinkedList<>();
    private final Map<String, ReentrantLock> dispatchGates = new ConcurrentHashMap<>();

    synchronized G current(String address) { return currentGatts.get(address); }
    synchronized boolean isCurrent(String address, G gatt) {
        return gatt != null && currentGatts.get(address) == gatt && !isRetired(gatt);
    }
    synchronized Operation<G> beginConnect(String address) {
        long generation = nextGenerations.getOrDefault(address, 0L) + 1L;
        nextGenerations.put(address, generation);
        Operation<G> operation = new Operation<>(null, generation);
        operationsFor(address).put(CONNECT, operation);
        return operation;
    }
    synchronized boolean bindConnectReturn(String address, Operation<G> operation, G gatt) {
        if (gatt == null || isRetired(gatt)) return false;
        if (operationFor(address, CONNECT) != operation) {
            return operation.gatt == gatt && operation.status == 1
                && operation.generation == currentGeneration(address) && currentGatts.get(address) == gatt;
        }
        G current = currentGatts.get(address);
        if (current != null && current != gatt) return false;
        if (operation.gatt != null && operation.gatt != gatt) return false;
        operation.gatt = gatt;
        currentGatts.put(address, gatt);
        currentGenerations.put(address, operation.generation);
        return true;
    }
    synchronized Operation<G> beginOperation(String address, String kind, G gatt) {
        if (!isCurrent(address, gatt)) throw new IllegalStateException("Not connected: " + address);
        Operation<G> operation = new Operation<>(gatt, currentGeneration(address));
        operationsFor(address).put(kind, operation);
        return operation;
    }

    boolean completeConnect(String address, G gatt, boolean connected, Consumer<DispatchLease<G>> dispatch) {
        DispatchLease<G> lease;
        synchronized (this) {
            Operation<G> operation = operationFor(address, CONNECT);
            if (operation == null || gatt == null || isRetired(gatt)) return false;
            if (operation.gatt == null) {
                if (currentGatts.get(address) != null) return false;
                operation.gatt = gatt;
                currentGatts.put(address, gatt);
                currentGenerations.put(address, operation.generation);
            }
            if (operation.gatt != gatt || currentGatts.get(address) != gatt
                    || operation.generation != currentGeneration(address)) return false;
            operation.status = connected ? 1 : 0;
            lease = new DispatchLease<>(this, address, gatt, operation.generation, !connected);
            removeOperation(address, CONNECT, operation);
            if (!connected) retireLocked(address, gatt);
            operation.latch.countDown();
        }
        return lease.dispatchIfCurrent(dispatch);
    }

    boolean completeOperation(String address, String kind, G gatt, int status, byte[] value) {
        synchronized (this) {
            Operation<G> operation = operationFor(address, kind);
            if (!isCurrent(address, gatt) || operation == null || operation.gatt != gatt
                    || operation.generation != currentGeneration(address)) return false;
            operation.status = status;
            operation.value = value != null ? value.clone() : null;
            removeOperation(address, kind, operation);
            operation.latch.countDown();
            return true;
        }
    }
    boolean dispatchIfCurrent(String address, G gatt, Consumer<DispatchLease<G>> dispatch) {
        DispatchLease<G> lease;
        synchronized (this) {
            if (!isCurrent(address, gatt)) return false;
            lease = new DispatchLease<>(this, address, gatt, currentGeneration(address), false);
        }
        return lease.dispatchIfCurrent(dispatch);
    }
    boolean disconnectIfCurrent(String address, G gatt, Consumer<DispatchLease<G>> dispatch) {
        DispatchLease<G> lease;
        ReentrantLock gate = dispatchGates.computeIfAbsent(address, ignored -> new ReentrantLock());
        gate.lock();
        synchronized (this) {
            if (!isCurrent(address, gatt)) { gate.unlock(); return false; }
            lease = new DispatchLease<>(this, address, gatt, currentGeneration(address), true);
            retireLocked(address, gatt);
        }
        try {
            if (dispatch != null) dispatch.accept(lease);
            return true;
        } finally {
            gate.unlock();
        }
    }
    synchronized boolean cancel(String address, String kind, Operation<G> operation) {
        if (operationFor(address, kind) != operation) return false;
        removeOperation(address, kind, operation);
        operation.latch.countDown();
        return true;
    }
    boolean retire(String address, G gatt, Consumer<DispatchLease<G>> dispatch) {
        DispatchLease<G> lease;
        ReentrantLock gate = dispatchGates.computeIfAbsent(address, ignored -> new ReentrantLock());
        gate.lock();
        synchronized (this) {
            if (gatt == null || currentGatts.get(address) != gatt) { gate.unlock(); return false; }
            lease = new DispatchLease<>(this, address, gatt, currentGeneration(address), false);
            retireLocked(address, gatt);
        }
        try {
            if (dispatch != null) dispatch.accept(lease);
            return true;
        } finally {
            gate.unlock();
        }
    }
    private Map<String, Operation<G>> operationsFor(String address) { return operations.computeIfAbsent(address, ignored -> new HashMap<>()); }
    private Operation<G> operationFor(String address, String kind) {
        Map<String, Operation<G>> addressOperations = operations.get(address);
        return addressOperations != null ? addressOperations.get(kind) : null;
    }
    private void removeOperation(String address, String kind, Operation<G> operation) {
        Map<String, Operation<G>> addressOperations = operations.get(address);
        if (addressOperations == null || addressOperations.get(kind) != operation) return;
        addressOperations.remove(kind);
        if (addressOperations.isEmpty()) operations.remove(address);
    }
    private void retireLocked(String address, G gatt) {
        if (currentGatts.get(address) == gatt) {
            currentGatts.remove(address);
            currentGenerations.remove(address);
        }
        retiredGatts.add(new WeakReference<>(gatt));
        Map<String, Operation<G>> addressOperations = operations.get(address);
        if (addressOperations == null) return;
        Iterator<Map.Entry<String, Operation<G>>> iterator = addressOperations.entrySet().iterator();
        while (iterator.hasNext()) {
            Operation<G> operation = iterator.next().getValue();
            if (operation.gatt == gatt) { operation.failed = true; operation.latch.countDown(); iterator.remove(); }
        }
        if (addressOperations.isEmpty()) operations.remove(address);
    }
    private long currentGeneration(String address) { return currentGenerations.getOrDefault(address, -1L); }
    private boolean isRetired(G gatt) {
        Iterator<WeakReference<G>> iterator = retiredGatts.iterator();
        while (iterator.hasNext()) {
            G retired = iterator.next().get();
            if (retired == null) iterator.remove();
            else if (retired == gatt) return true;
        }
        return false;
    }
}