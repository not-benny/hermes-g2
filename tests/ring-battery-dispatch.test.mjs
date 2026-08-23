import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const guardSource = new URL(
  "../App_Resources/Android/src/main/java/com/faceclaw/app/ExactGenerationListenerGuard.java",
  import.meta.url,
);
const communicatorSource = new URL(
  "../App_Resources/Android/src/main/java/com/faceclaw/app/FaceclawBleCommunicator.java",
  import.meta.url,
);

const harness = String.raw`
package com.faceclaw.app;

import java.util.ArrayDeque;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

public final class RingBatteryDispatchHarness {
    private static final class Listener {
        final String id;
        Listener(String id) { this.id = id; }
        @Override public boolean equals(Object value) {
            return value instanceof Listener && id.equals(((Listener) value).id);
        }
        @Override public int hashCode() { return id.hashCode(); }
    }

    public static void main(String[] args) {
        AtomicInteger ringGeneration = new AtomicInteger(41);
        Listener attached = new Listener("dashboard");
        AtomicReference<Listener> currentListener = new AtomicReference<>(attached);
        AtomicInteger deliveredBattery = new AtomicInteger(-1);
        ArrayDeque<Runnable> mainQueue = new ArrayDeque<>();

        ExactGenerationListenerGuard<Listener> oldRead =
            new ExactGenerationListenerGuard<>(ringGeneration.get(), attached);
        mainQueue.add(() -> {
            if (oldRead.isCurrent(ringGeneration.get(), currentListener.get())) {
                deliveredBattery.set(82);
            }
        });

        // The same physical R1 reconnects before Android drains the main queue.
        // Address equality cannot distinguish this replacement; generation must.
        ringGeneration.incrementAndGet();
        mainQueue.removeFirst().run();
        require(deliveredBattery.get() == -1,
            "queued old-generation battery cannot escape after same-R1 reconnect");

        ExactGenerationListenerGuard<Listener> currentRead =
            new ExactGenerationListenerGuard<>(ringGeneration.get(), attached);
        mainQueue.add(() -> {
            if (currentRead.isCurrent(ringGeneration.get(), currentListener.get())) {
                deliveredBattery.set(77);
            }
        });
        mainQueue.removeFirst().run();
        require(deliveredBattery.get() == 77, "current generation reaches the shared listener");

        // Equal listener values are still different owners.
        ExactGenerationListenerGuard<Listener> detachedRead =
            new ExactGenerationListenerGuard<>(ringGeneration.get(), attached);
        currentListener.set(new Listener("dashboard"));
        require(!detachedRead.isCurrent(ringGeneration.get(), currentListener.get()),
            "listener replacement is rejected by exact identity, not equals");
    }

    private static void require(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }
}
`;

function methodBody(source, signature) {
  const start = source.indexOf(signature);
  assert.notEqual(start, -1, `missing ${signature}`);
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}" && --depth === 0) return source.slice(open, index + 1);
  }
  assert.fail(`unterminated ${signature}`);
}

test("queued standard-GATT battery rejects a same-R1 replacement generation", () => {
  const directory = mkdtempSync(join(tmpdir(), "ring-battery-dispatch-"));
  try {
    const packageDir = join(directory, "com", "faceclaw", "app");
    mkdirSync(packageDir, { recursive: true });
    const harnessPath = join(packageDir, "RingBatteryDispatchHarness.java");
    writeFileSync(harnessPath, harness);

    const compile = spawnSync("javac", ["-d", directory, guardSource.pathname, harnessPath], {
      encoding: "utf8",
    });
    assert.equal(compile.status, 0, compile.stderr || compile.stdout);
    const run = spawnSync("java", ["-cp", directory, "com.faceclaw.app.RingBatteryDispatchHarness"], {
      encoding: "utf8",
    });
    assert.equal(run.status, 0, run.stderr || run.stdout);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the native battery read retains generation and listener ownership through final delivery", () => {
  const source = readFileSync(communicatorSource, "utf8");
  const refresh = methodBody(source, "private void refreshRingBattery(int generation)");
  const delivery = methodBody(source, "private void emitDirectRingBatteryStateSnapshot(int generation)");

  assert.match(refresh, /emitDirectRingBatteryStateSnapshot\(generation\)/);
  assert.doesNotMatch(refresh, /emitBatteryStateSnapshot\(\)/);
  assert.match(delivery, /new ExactGenerationListenerGuard<>\(generation, current\)/);
  assert.match(delivery, /mainHandler\.post\(\(\) ->/);
  assert.match(delivery, /delivery\.isCurrent\(ringConnectionGeneration, listener\)/);
  assert.ok(
    delivery.indexOf("delivery.isCurrent") < delivery.indexOf("current.onBatteryState"),
    "the exact ownership recheck must be the final callback boundary",
  );
});
