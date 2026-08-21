import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const registrySource = new URL(
  "../App_Resources/Android/src/main/java/com/faceclaw/app/GattCallbackRegistry.java",
  import.meta.url,
);

const harness = String.raw`
package com.faceclaw.app;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.atomic.AtomicInteger;

public final class GattCallbackRegistryHarness {
    public static void main(String[] args) throws Exception {
        rejectsObsoleteCallbacks();
        dispatchDoesNotInvertExternalLock();
    }

    private static void rejectsObsoleteCallbacks() throws Exception {
        String address = "test-address";
        Object gattA = new Object();
        Object gattB = new Object();
        GattCallbackRegistry<Object> registry = new GattCallbackRegistry<>();
        AtomicInteger notifications = new AtomicInteger();

        GattCallbackRegistry.Operation<Object> connectA = registry.beginConnect(address);
        FaceclawBleListener.DispatchToken connectedA = registry.completeConnect(address, gattA, true);
        require(connectedA != null, "early A connect callback");
        require(registry.bindConnectReturn(address, connectA, gattA), "connectGatt return preserves early A callback");
        require(connectA.await(1), "A connect latch");
        require(connectedA.claim(), "A connected dispatch claim");
        notifications.incrementAndGet();

        GattCallbackRegistry.Operation<Object> readA = registry.beginOperation(address, "read", gattA);
        CountDownLatch oldCallbackObserved = new CountDownLatch(1);
        CountDownLatch releaseOldCallback = new CountDownLatch(1);
        AtomicInteger oldCompletion = new AtomicInteger(-1);
        Thread oldCallback = new Thread(() -> {
            oldCallbackObserved.countDown();
            await(releaseOldCallback);
            oldCompletion.set(registry.completeOperation(address, "read", gattA, 0, new byte[] {1}) ? 1 : 0);
        });
        oldCallback.start();
        require(oldCallbackObserved.await(1, java.util.concurrent.TimeUnit.SECONDS), "old callback observed");

        FaceclawBleListener.DispatchToken staleNotification = registry.dispatchIfCurrent(address, gattA);
        require(staleNotification != null, "prepare A notification");
        require(registry.retire(address, gattA), "retire A");
        GattCallbackRegistry.Operation<Object> connectB = registry.beginConnect(address);
        require(registry.completeConnect(address, gattA, true) == null, "old connected callback cannot claim B pending connect");
        require(registry.bindConnectReturn(address, connectB, gattB), "bind B");
        FaceclawBleListener.DispatchToken connectedB = registry.completeConnect(address, gattB, true);
        require(connectedB != null && connectedB.claim(), "complete B connect");
        notifications.incrementAndGet();
        GattCallbackRegistry.Operation<Object> readB = registry.beginOperation(address, "read", gattB);

        releaseOldCallback.countDown();
        oldCallback.join(1_000);
        require(!oldCallback.isAlive(), "old callback joined");
        require(oldCompletion.get() == 0, "old value callback rejected");
        require(readB.remaining() == 1, "old value callback did not satisfy B");
        require(readA.remaining() == 0, "retirement wakes obsolete waiter");

        require(!staleNotification.claim(), "prepared old notification rejected after replacement");
        require(registry.dispatchIfCurrent(address, gattA) == null, "old notification rejected");
        require(registry.disconnectIfCurrent(address, gattA) == null, "old disconnect rejected");
        require(registry.isCurrent(address, gattB), "B remains current");
        require(notifications.get() == 2, "only A and B connected notifications dispatched");

        require(registry.completeOperation(address, "read", gattB, 0, new byte[] {2}), "B value callback accepted");
        require(readB.await(1), "B read latch");
        require(readB.status() == 0 && readB.value()[0] == 2, "B receives only B result");
    }

    private static void dispatchDoesNotInvertExternalLock() throws Exception {
        String address = "deadlock-address";
        Object gatt = new Object();
        Object ringLock = new Object();
        GattCallbackRegistry<Object> registry = new GattCallbackRegistry<>();
        GattCallbackRegistry.Operation<Object> connect = registry.beginConnect(address);
        require(registry.bindConnectReturn(address, connect, gatt), "bind deadlock GATT");
        FaceclawBleListener.DispatchToken connected = registry.completeConnect(address, gatt, true);
        require(connected != null && connected.claim(), "complete deadlock GATT connect");

        CountDownLatch callbackPrepared = new CountDownLatch(1);
        CountDownLatch workerFinishedRegistryCall = new CountDownLatch(1);
        AtomicInteger dispatched = new AtomicInteger();
        Thread callback = new Thread(() -> {
            FaceclawBleListener.DispatchToken notification = registry.dispatchIfCurrent(address, gatt);
            require(notification != null, "prepare current notification");
            callbackPrepared.countDown();
            synchronized (ringLock) {
                if (notification.claim()) {
                    dispatched.incrementAndGet();
                }
            }
        });
        callback.setDaemon(true);

        Thread worker = new Thread(() -> {
            synchronized (ringLock) {
                callback.start();
                await(callbackPrepared);
                registry.beginOperation(address, "write", gatt);
                workerFinishedRegistryCall.countDown();
            }
        });
        worker.setDaemon(true);
        worker.start();

        require(workerFinishedRegistryCall.await(1, java.util.concurrent.TimeUnit.SECONDS),
            "worker can enter registry while callback waits for ringLock");
        worker.join(1_000);
        callback.join(1_000);
        require(!worker.isAlive() && !callback.isAlive(), "cross-lock threads joined");
        require(dispatched.get() == 1, "notification dispatched after lock handoff");

        FaceclawBleListener.DispatchToken disconnected = registry.disconnectIfCurrent(address, gatt);
        require(disconnected != null, "prepare current disconnect");
        Object replacement = new Object();
        GattCallbackRegistry.Operation<Object> replacementConnect = registry.beginConnect(address);
        require(registry.bindConnectReturn(address, replacementConnect, replacement), "bind replacement");
        synchronized (ringLock) {
            require(!disconnected.claim(), "replacement invalidates a blocked old disconnect dispatch");
        }

        String currentDisconnectAddress = "current-disconnect-address";
        Object currentDisconnectGatt = new Object();
        GattCallbackRegistry.Operation<Object> currentDisconnectConnect =
            registry.beginConnect(currentDisconnectAddress);
        require(registry.bindConnectReturn(
            currentDisconnectAddress,
            currentDisconnectConnect,
            currentDisconnectGatt
        ), "bind current disconnect GATT");
        FaceclawBleListener.DispatchToken currentConnected =
            registry.completeConnect(currentDisconnectAddress, currentDisconnectGatt, true);
        require(currentConnected != null && currentConnected.claim(), "complete current disconnect GATT");
        FaceclawBleListener.DispatchToken currentDisconnected =
            registry.disconnectIfCurrent(currentDisconnectAddress, currentDisconnectGatt);
        synchronized (ringLock) {
            require(currentDisconnected != null && currentDisconnected.claim(),
                "current disconnect dispatches when no replacement started");
        }
    }

    private static void await(CountDownLatch latch) {
        try {
            latch.await();
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new AssertionError(e);
        }
    }

    private static void require(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }
}
`;

test("obsolete callbacks cannot complete or notify a replacement GATT generation", () => {
  const directory = mkdtempSync(join(tmpdir(), "gatt-callback-registry-"));
  try {
    const packageDir = join(directory, "com", "faceclaw", "app");
    const mkdir = spawnSync("mkdir", ["-p", packageDir], { encoding: "utf8" });
    assert.equal(mkdir.status, 0, mkdir.stderr);
    writeFileSync(join(packageDir, "GattCallbackRegistryHarness.java"), harness);

    const compile = spawnSync(
      "javac",
      [
        "-d",
        directory,
        registrySource.pathname,
        new URL("../App_Resources/Android/src/main/java/com/faceclaw/app/FaceclawBleListener.java", import.meta.url).pathname,
        join(packageDir, "GattCallbackRegistryHarness.java"),
      ],
      { encoding: "utf8" },
    );
    assert.equal(compile.status, 0, compile.stderr || compile.stdout);

    const run = spawnSync("java", ["-cp", directory, "com.faceclaw.app.GattCallbackRegistryHarness"], {
      encoding: "utf8",
    });
    assert.equal(run.status, 0, run.stderr || run.stdout);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// Keep the registry implementation reviewable as an Android-free concurrency primitive.
test("callback registry has no Android dependency", () => {
  const source = readFileSync(registrySource, "utf8");
  assert.doesNotMatch(source, /android\./);
  assert.doesNotMatch(source, /Runnable|dispatch\.run\(/);
});
