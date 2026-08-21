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
        String address = "test-address";
        Object gattA = new Object();
        Object gattB = new Object();
        GattCallbackRegistry<Object> registry = new GattCallbackRegistry<>();
        AtomicInteger notifications = new AtomicInteger();

        GattCallbackRegistry.Operation<Object> connectA = registry.beginConnect(address);
        require(registry.completeConnect(address, gattA, true, lease -> notifications.incrementAndGet()), "early A connect callback");
        require(registry.bindConnectReturn(address, connectA, gattA), "connectGatt return preserves early A callback");
        require(connectA.await(1), "A connect latch");

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

        require(registry.retire(address, gattA, null), "retire A");
        GattCallbackRegistry.Operation<Object> connectB = registry.beginConnect(address);
        require(!registry.completeConnect(address, gattA, true, lease -> notifications.incrementAndGet()), "old connected callback cannot claim B pending connect");
        require(registry.bindConnectReturn(address, connectB, gattB), "bind B");
        require(registry.completeConnect(address, gattB, true, lease -> notifications.incrementAndGet()), "complete B connect");
        GattCallbackRegistry.Operation<Object> readB = registry.beginOperation(address, "read", gattB);

        releaseOldCallback.countDown();
        oldCallback.join(1_000);
        require(!oldCallback.isAlive(), "old callback joined");
        require(oldCompletion.get() == 0, "old value callback rejected");
        require(readB.remaining() == 1, "old value callback did not satisfy B");
        require(readA.remaining() == 0, "retirement wakes obsolete waiter");

        require(!registry.dispatchIfCurrent(address, gattA, lease -> notifications.incrementAndGet()), "old notification rejected");
        require(!registry.disconnectIfCurrent(address, gattA, lease -> notifications.incrementAndGet()), "old disconnect rejected");
        require(registry.isCurrent(address, gattB), "B remains current");
        require(notifications.get() == 2, "only A and B connected notifications dispatched");

        require(registry.completeOperation(address, "read", gattB, 0, new byte[] {2}), "B value callback accepted");
        require(readB.await(1), "B read latch");
        require(readB.status() == 0 && readB.value()[0] == 2, "B receives only B result");

        GattCallbackRegistry.Operation<Object> writeB = registry.beginOperation(address, "write", gattB);
        CountDownLatch listenerEntered = new CountDownLatch(1);
        CountDownLatch releaseListener = new CountDownLatch(1);
        Thread listener = new Thread(() -> {
            require(registry.dispatchIfCurrent(address, gattB, lease -> {
                listenerEntered.countDown();
                await(releaseListener);
            }), "current listener dispatch");
        });
        listener.start();
        require(listenerEntered.await(1, java.util.concurrent.TimeUnit.SECONDS), "listener entered");
        require(registry.completeOperation(address, "write", gattB, 0, null),
            "operation completion is not blocked by listener code");
        require(writeB.await(1), "write completion latch");
        releaseListener.countDown();
        listener.join(1_000);
        require(!listener.isAlive(), "listener joined");

        require(registry.retire(address, gattB, null), "retire B for generation advance");
        GattCallbackRegistry.Operation<Object> connectC = registry.beginConnect(address);
        require(connectC.generation() > connectB.generation(), "generation monotonically advances");
        require(!registry.completeConnect(address, gattB, true, null), "B generation cannot claim C");
        require(registry.bindConnectReturn(address, connectC, new Object()), "bind C");
        Object gattC = registry.current(address);
        require(registry.completeConnect(address, gattC, true, lease -> {}), "complete C connect");

        CountDownLatch leaseEntered = new CountDownLatch(1);
        CountDownLatch releaseLease = new CountDownLatch(1);
        AtomicInteger staleEffects = new AtomicInteger();
        final GattCallbackRegistry.DispatchLease<Object>[] queuedLease = new GattCallbackRegistry.DispatchLease[1];
        require(registry.dispatchIfCurrent(address, gattC, lease -> queuedLease[0] = lease), "queue C listener");
        Thread staleListener = new Thread(() -> queuedLease[0].dispatchIfCurrent(lease -> {
            leaseEntered.countDown();
            await(releaseLease);
            if (lease.isCurrent()) staleEffects.incrementAndGet();
        }));
        staleListener.start();
        require(leaseEntered.await(1, java.util.concurrent.TimeUnit.SECONDS), "lease listener entered");
        AtomicInteger retired = new AtomicInteger();
        Thread retirement = new Thread(() -> {
            if (registry.retire(address, gattC, null)) retired.set(1);
        });
        retirement.start();
        Thread.sleep(50);
        require(retirement.isAlive(), "retirement waits for the in-flight consumer mutation");
        releaseLease.countDown();
        retirement.join(1_000);
        require(!retirement.isAlive() && retired.get() == 1, "retirement completes after consumer mutation");
        staleListener.join(1_000);
        require(staleEffects.get() == 1, "consumer mutation completes before retirement");

        GattCallbackRegistry.Operation<Object> connectD = registry.beginConnect(address);
        Object gattD = new Object();
        require(registry.bindConnectReturn(address, connectD, gattD), "bind D after gated retirement");
        require(registry.completeConnect(address, gattD, true, null), "complete D after gated retirement");
        require(connectD.generation() > connectC.generation(), "replacement receives a newer generation");
        require(!registry.dispatchIfCurrent(address, gattC, lease -> staleEffects.incrementAndGet()),
            "old C callback rejected after D replacement");
        GattCallbackRegistry.Operation<Object> writeD = registry.beginOperation(address, "write", gattD);
        require(registry.retire(address, gattD, null), "retire D while write is pending");
        require(writeD.await(1) && writeD.failed(), "retirement fails the owned write waiter closed");
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
      ["-d", directory, registrySource.pathname, join(packageDir, "GattCallbackRegistryHarness.java")],
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
});
