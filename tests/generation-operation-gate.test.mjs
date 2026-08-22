import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const source = new URL("../App_Resources/Android/src/main/java/com/faceclaw/app/GenerationBoundOperationGate.java", import.meta.url);

const harness = String.raw`
package com.faceclaw.app;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

public final class GenerationBoundOperationGateHarness {
    public static void main(String[] args) throws Exception {
        GenerationBoundOperationGate gate = new GenerationBoundOperationGate();
        long generation = gate.publishReady();
        GenerationBoundOperationGate.Token token = gate.begin(generation);
        require(token != null, "current operation starts");

        CountDownLatch operationEntered = new CountDownLatch(1);
        CountDownLatch releaseOperation = new CountDownLatch(1);
        Thread blockingBle = new Thread(() -> {
            operationEntered.countDown();
            await(releaseOperation);
            require(!gate.finish(token), "retired operation cannot publish completion");
        });
        blockingBle.start();
        require(operationEntered.await(1, TimeUnit.SECONDS), "blocking operation entered");

        long start = System.nanoTime();
        require(gate.snapshot().ready, "state read sees ready before retirement");
        long readMs = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - start);
        require(readMs < 100, "state read stays below 100ms while BLE work blocks: " + readMs);

        long retiredGeneration = gate.retire();
        require(retiredGeneration > generation, "retirement advances generation");
        require(!gate.snapshot().ready, "retirement is immediately visible");
        require(gate.begin(generation) == null, "stale generation cannot begin");

        releaseOperation.countDown();
        blockingBle.join(1_000);
        require(!blockingBle.isAlive(), "operation joined");
        long replacement = gate.publishReady();
        require(replacement == retiredGeneration, "only retirement advances generation");
        require(gate.begin(replacement) != null, "replacement operation starts");
    }

    private static void await(CountDownLatch latch) {
        try { latch.await(); } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new AssertionError(e);
        }
    }

    private static void require(boolean value, String message) {
        if (!value) throw new AssertionError(message);
    }
}
`;

test("blocking BLE work never holds the lifecycle state monitor", () => {
  const directory = mkdtempSync(join(tmpdir(), "generation-operation-gate-"));
  try {
    const packageDir = join(directory, "com", "faceclaw", "app");
    const mkdir = spawnSync("mkdir", ["-p", packageDir], { encoding: "utf8" });
    assert.equal(mkdir.status, 0, mkdir.stderr);
    writeFileSync(join(packageDir, "GenerationBoundOperationGateHarness.java"), harness);
    const compile = spawnSync("javac", ["-d", directory, source.pathname, join(packageDir, "GenerationBoundOperationGateHarness.java")], { encoding: "utf8" });
    assert.equal(compile.status, 0, compile.stderr || compile.stdout);
    const run = spawnSync("java", ["-cp", directory, "com.faceclaw.app.GenerationBoundOperationGateHarness"], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr || run.stdout);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the display worker never performs optional R1 connect work", () => {
  const communicator = readFileSync(
    new URL("../App_Resources/Android/src/main/java/com/faceclaw/app/FaceclawBleCommunicator.java", import.meta.url),
    "utf8",
  );
  const start = communicator.indexOf("private void connectLoopOnce()");
  const end = communicator.indexOf("private boolean sleepDuringConnectSettling", start);
  const displayConnect = communicator.slice(start, end);
  assert.doesNotMatch(displayConnect, /tryConnectRing\(/);
  assert.match(displayConnect, /ringInterruptibleSleep\.interrupt\(\)/);
});

test("G2 arm loss retires the exact R1 session before allowing a reconnect", () => {
  const communicator = readFileSync(
    new URL("../App_Resources/Android/src/main/java/com/faceclaw/app/FaceclawBleCommunicator.java", import.meta.url),
    "utf8",
  );
  const start = communicator.indexOf("public void onConnectionStateChange(String address, boolean connected)");
  const end = communicator.indexOf("private int updateDirectRingConnectionStateLocked", start);
  const stateChange = communicator.slice(start, end);
  assert.match(stateChange, /ringConnected = false/);
  assert.match(stateChange, /ringNotificationsReady = false/);
  assert.ok(stateChange.indexOf("ringNotificationsReady = false") < stateChange.indexOf("invalidateRingPacketAckStateLocked()"));
  assert.match(stateChange, /bleManager\.disconnect\(ringAddress\)/);
});

test("R1 readiness publication rejects a disconnect racing connect callbacks", () => {
  const communicator = readFileSync(
    new URL("../App_Resources/Android/src/main/java/com/faceclaw/app/FaceclawBleCommunicator.java", import.meta.url),
    "utf8",
  );
  const connectStart = communicator.indexOf("private int connectRing(long glassesAttemptGeneration)");
  const connectEnd = communicator.indexOf("private <T> T withRingManagerOperation", connectStart);
  const connect = communicator.slice(connectStart, connectEnd);
  assert.match(connect, /ringAttemptGeneration = ringConnectionGeneration/);
  assert.match(connect, /ringAttemptGeneration != ringConnectionGeneration/);
  assert.ok(connect.indexOf("ringAttemptGeneration != ringConnectionGeneration") < connect.indexOf("ringNotificationsReady = true"));

  const updateStart = communicator.indexOf("private int updateDirectRingConnectionStateLocked(boolean connected)");
  const updateEnd = communicator.indexOf("private void finishDirectRingConnectionStateChange", updateStart);
  const update = communicator.slice(updateStart, updateEnd);
  assert.match(update, /if \(connected && ringNotificationsReady\)/);
});
