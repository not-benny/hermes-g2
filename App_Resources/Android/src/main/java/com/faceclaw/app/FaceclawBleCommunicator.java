package com.faceclaw.app;

import android.annotation.SuppressLint;
import android.bluetooth.BluetoothGatt;
import android.bluetooth.BluetoothGattCharacteristic;
import android.app.KeyguardManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.os.SystemClock;
import android.util.Log;

import java.io.ByteArrayOutputStream;
import java.io.PrintWriter;
import java.io.StringWriter;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.Map;

@SuppressLint("MissingPermission")
public class FaceclawBleCommunicator implements FaceclawBleListener, Runnable {
    private static final String TAG = "FaceclawComm";

    // The EvenHub image container is a memory carrier only. Its 576x288 geometry
    // gives the firmware separate 165888-byte display and reconstruction
    // allocations: CFW reuses the former for its 640x480 packed-4bpp shadow and
    // leaves the latter wholly available for compressed incoming messages.
    private static final BleProtocol.ImageTileOptions DASHBOARD_TILE =
        new BleProtocol.ImageTileOptions("img00", 10, 0, 0, 576, 288);

    private static final String G2_SCREEN_WAKE_LOCK_TAG = "Faceclaw:G2Screen";
    private static final long FACECLAW_WAKE_LEASE_RENEW_MS = 45_000;
    private static final long FACECLAW_WAKE_CONTROL_WAIT_MS = 1_500;
    // Bluetooth SIG Battery Service / Battery Level characteristic. Optional:
    // an R1 without it remains usable but reports no battery percentage.
    private static final String RING_BATTERY_LEVEL_UUID = "00002a19-0000-1000-8000-00805f9b34fb";
    private static final int RING_BATTERY_READ_TIMEOUT_MS = 2_500;
    private static final int RING_CONNECT_OPERATION = -1;
    // Health-sampling experiment gate. The prior "auth/host-binding wall" verdict
    // was WRONG: root-cause analysis of com.even.sg's BleRing1Model.toBytes showed
    // frame[1..4] is a CRC-32 (poly 0x1EDC6F41) over the inner frame, and the old
    // buildRingFrame filled it with RANDOM bytes — so the ring's transport layer
    // silently discarded 100% of Hermes' writes before the command dispatcher,
    // with no auth involved. buildRingFrame is now rebuilt to the verified layout.
    // probeRingHealth fires a read-only GET canary (verbatim-replayed captured
    // frames + a random-CRC control) to prove the channel; watch bae80013.
    private static final boolean RING_HEALTH_PROBE_ENABLED = true;

    private final Context appContext;
    private final PowerManager powerManager;
    private final KeyguardManager keyguardManager;
    private final FaceclawBleManager bleManager;
    private final InterruptibleSleep interruptibleSleep = new InterruptibleSleep();
    private final InterruptibleSleep ringInterruptibleSleep = new InterruptibleSleep();
    private final Object lifecycleLock = new Object();
    private final Object lock = new Object();
    private final Object ringLock = new Object();
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final String rightAddress;
    private final String leftAddress;
    private final String ringAddress;

    private volatile FaceclawBleCommunicatorListener listener;
    private final java.util.List<FaceclawImuListener> imuListeners =
        new java.util.concurrent.CopyOnWriteArrayList<>();
    private final java.util.List<FaceclawCompassListener> compassListeners =
        new java.util.concurrent.CopyOnWriteArrayList<>();
    private volatile Thread workerThread;
    private volatile Thread ringWorkerThread;
    private volatile boolean running;
    private volatile boolean stopping;
    private volatile boolean userDisconnectRequested;
    private boolean closeRequested;
    private boolean cleanupComplete;
    private boolean cleanupStarted;
    private boolean managerCleanupComplete;
    private boolean wakeLockCleanupComplete;
    private boolean receiverCleanupComplete;
    private boolean stateCleanupComplete;
    private volatile Thread cleanupThread;

    private String phase = "disconnected";
    private String status = "Disconnected.";

    private boolean rightConnected;
    private boolean leftConnected;
    private boolean ringConnected;
    private boolean ringNotificationsReady;
    private int ringBattery = -1;
    // Ring health-sampling spike: per-session write sequence + one-shot guard.
    // The R1 streams health pushes on its notify channel only after it is put
    // into HRV sampling mode; probeRingHealth sends that enable command once
    // per connection. Reset on ring disconnect so a reconnect re-arms it.
    private int ringWriteSeq = 0;
    private boolean ringHealthProbeSent = false;
    // packetAck cursors are captured on the BLE callback and drained only by
    // the communicator worker, so notify handling never performs a nested write.
    private static final class RingPacketAckCursor {
        final byte[] payload;
        final int generation;
        RingPacketAckCursor(byte[] payload, int generation) {
            this.payload = payload;
            this.generation = generation;
        }
    }
    private interface RingManagerOperation<T> {
        T run();
    }
    private final ArrayDeque<RingPacketAckCursor> ringPacketAckQueue = new ArrayDeque<>();
    // Written under ringLock. Volatile lets post-lock callback dispatch reject a
    // retired ring session without acquiring ringLock while it takes display state.
    private volatile int ringConnectionGeneration = 0;

    /** Retire queued work captured by the previous direct-ring lifecycle. ringLock required. */
    private void invalidateRingPacketAckStateLocked() {
        ringConnectionGeneration++;
        ringPacketAckQueue.clear();
    }
    // Identity of the current two-arm connection attempt. Arm callbacks and
    // teardown invalidate an in-flight attempt before it can resurrect a ready
    // session or start the ring side effect.
    private long glassesConnectionGeneration = 0;
    // Re-poll the ring health GETs periodically: the ring auto-connects while
    // off-head (empty window), so a one-shot poll never sees worn data. Re-firing
    // every RING_HEALTH_POLL_INTERVAL_MS means data arrives on the next poll once
    // the ring is actually worn.
    private long lastRingHealthPollMs = 0;
    private static final long RING_HEALTH_POLL_INTERVAL_MS = 60_000L;
    // Match the Even app's observed live-HR cadence without re-requesting every
    // heavier daily metric on each tick.
    private long lastRingCurrentHrPollMs = 0;
    private static final long RING_CURRENT_HR_POLL_INTERVAL_MS = 15_000L;
    private final SecureRandom ringRandom = new SecureRandom();
    private volatile boolean sessionReady;
    private boolean fixedLayoutCreated;
    private boolean warmedUp;
    private boolean shutdownRequested;
    // CFW firmware-debug-flags overlay (mode 7). Desired value pushed from TS; the
    // sub-op last sent this session (-1 = not yet), reset on (re)connect so the
    // overlay state is re-asserted on every reconnect and whenever the value changes.
    private volatile boolean firmwareDebugFlagsEnabled;
    private int firmwareDebugFlagsLastSent = -1;
    // Desired CFW mode-10 compass state. It survives reconnects; lastSent is
    // reset with each session so an open Compass window is re-asserted.
    private boolean compassEnabled;
    private int compassControlLastSent = -1;
    // Whether the glasses-side compass may still be running: set when an enable
    // is enqueued, cleared only when a disable is acked. Drives the forced
    // disable sent ahead of an EvenHub shutdown/suspend, since a pending
    // disable can be wiped by the shutdown's queue flush and the retry loop
    // does not run while shutdownRequested (magnetometer left on = battery drain).
    private boolean compassMaybeOn;
    private boolean startupProbePending;
    // Desired ownership of CFW's fail-open stock-wake lease (dashboard launch
    // and Even AI foreground takeover). This survives a transport reconnect;
    // the lease itself is volatile firmware state and is re-acquired once both
    // arms are ready.
    private boolean faceclawWakeLeaseEnabled;
    private long lastFaceclawWakeLeaseQueuedAtMs;
    private int faceclawWakeControlGeneration;
    private int faceclawWakeControlSentCount;
    private long lastFaceclawFramebufferLeaseQueuedAtMs;
    private int faceclawFramebufferControlGeneration;
    private int faceclawFramebufferControlSentCount;
    private int faceclawWakePendingNonce = -1;

    private long reconnectAfterMs;
    private long ringReconnectAfterMs;
    private int ringConsecutiveFailures;
    private long lastAckAtMs;
    private long lastIncomingAtMs;
    private long lastHeartbeatSentAtMs;
    private long lastHeartbeatAckedAtMs;
    private long lastConnectionOrInputAtMs;
    private long lastBatteryRefreshAtMs;
    private long imageRetryAfterMs;
    private long lastSessionReadyAtMs;
    private long lastEvenAppConflictAtMs;
    private int consecutiveAckTimeouts;
    private long softResyncStartedAtMs;
    private int setupAckTimeouts;
    private long lastConnPriorityAssertAtMs;
    private int lastAudioControlAckMagic = 0;

    private ConnectionOptions connectionOptions = new ConnectionOptions();
    private final BleMagicPool magicPool = new BleMagicPool();
    private MessageBuilder messageBuilder = new MessageBuilder(magicPool);
    private int nextTransportSeq = 0x40;
    private int nextMapSessionId = 0;
    private int nextImageUpdateId = 1;
    // Wire frame id for mode-3 deltas (CFW reorder/skip/dup diagnostic). uint16,
    // advanced by 1 per emitted delta; kept in [1, 0xfffe] to avoid the CFW's
    // 0xffff "empty" sentinel.
    private int nextImageFrameId = 1;
    private int lastShutdownAckMagic = 0;
    private long lastShutdownExitAtMs = 0;
    private int headsetBattery = -1;
    private int headsetCharging = -1;
    // Silent mode: 1 = on, 0 = off, -1 = not yet known. See updateSilentModeLocked.
    private int silentMode = -1;
    private int wearState = -1;
    private int phoneLockState = -1;
    private long lastPhoneLockCheckAtMs;
    private boolean phoneLockReceiverRegistered;
    private boolean audioCaptureActive;
    private boolean firmwareInfoQueried;
    // Glasses are in the charging case: nobody is wearing them, so display
    // communication pauses and only battery polls flow (see driveSession).
    private boolean chargingMode;
    private volatile FaceclawAudioPacketListener audioPacketListener;
    private PowerManager.WakeLock g2ScreenWakeLock;

    private final BroadcastReceiver phoneLockReceiver = new BroadcastReceiver() {
        @Override public void onReceive(Context context, Intent intent) {
            emitPhoneLockStateIfChanged(true);
            interruptibleSleep.interrupt();
        }
    };

    private String displayedFingerprint = "";
    // The frame the firmware shadow will hold once the current image pipeline
    // drains: the most recently ENQUEUED image (headerless packed 4bpp, see
    // BmpUtil.pack4bppFromGray8), which is the correct base for the next delta
    // when frames are pipelined. Set at enqueue; cleared whenever the image
    // pipeline is cleared (clearAllMessagesLocked / clearMessagesOfKindLocked
    // "image"), so it is only ever read while it holds a valid current-session base.
    private byte[] lastEnqueuedPacked = new byte[0];
    private int lastEnqueuedWidth;
    private int lastEnqueuedHeight;
    private String lastEnqueuedFingerprint = "";
    private final Map<Integer, BleImageOptimizer.ImageUpdateStats> imageUpdateStats = new HashMap<>();

    private final Object desiredTilesLock = new Object();
    private String desiredFingerprint = "";
    // Headerless packed 4bpp frame (see BmpUtil.pack4bppFromGray8) plus its
    // pixel dimensions.
    private byte[] desiredPacked = new byte[0];
    private int desiredWidth;
    private int desiredHeight;
    private int desiredPaintMs;
    private int desiredFrameId;
    // Highest compositor sequence stored as the desired frame; composites that
    // lost a store race to a newer one are discarded (their content is already
    // included in the newer composite).
    private long lastStoredCompositeSeq;

    private final SurfaceCompositor compositor = new SurfaceCompositor();

    private final ArrayDeque<OutboundMessage> pendingMessages = new ArrayDeque<>();
    private final ArrayDeque<OutboundMessage> inFlightMessages = new ArrayDeque<>();
    private OutboundMessage prewrittenMessage;
    private List<byte[]> prewrittenFrames = Collections.emptyList();

    public FaceclawBleCommunicator(Context context, String rightAddress, String leftAddress, String ringAddress) {
        this.appContext = context.getApplicationContext();
        FrameTimings.getInstance().init(appContext);
        this.powerManager = (PowerManager) appContext.getSystemService(Context.POWER_SERVICE);
        this.keyguardManager = (KeyguardManager) appContext.getSystemService(Context.KEYGUARD_SERVICE);
        this.bleManager = new FaceclawBleManager(appContext);
        this.bleManager.setListener(this);
        this.rightAddress = requireAddress("rightAddress", rightAddress);
        this.leftAddress = requireAddress("leftAddress", leftAddress);
        this.ringAddress = ringAddress == null ? "" : ringAddress.trim();
        IntentFilter phoneLockFilter = new IntentFilter();
        phoneLockFilter.addAction(Intent.ACTION_SCREEN_ON);
        phoneLockFilter.addAction(Intent.ACTION_SCREEN_OFF);
        phoneLockFilter.addAction(Intent.ACTION_USER_PRESENT);
        appContext.registerReceiver(phoneLockReceiver, phoneLockFilter);
        phoneLockReceiverRegistered = true;
    }


    public void setListener(FaceclawBleCommunicatorListener listener) {
        this.listener = listener;
        emitState();
        emitPhoneLockStateIfChanged(true);
    }

    public void start() {
        synchronized (lifecycleLock) {
            synchronized (lock) {
                if (running || stopping) {
                    return;
                }
                running = true;
                userDisconnectRequested = false;
                shutdownRequested = false;
                activeInstance = this;
                workerThread = new Thread(this, "FaceclawBleCommunicator");
                ringWorkerThread = new Thread(this::runRingLoop, "FaceclawRingLink");
                workerThread.start();
                ringWorkerThread.start();
            }
        }
    }

    public boolean disconnect() {
        synchronized (lifecycleLock) {
            synchronized (lock) {
                if (!stopping) stopping = true;
                userDisconnectRequested = true;
                running = false;
                glassesConnectionGeneration++;
                audioCaptureActive = false;
                audioPacketListener = null;
            }
            releaseFaceclawFramebufferLease();
            interruptibleSleep.interrupt();
            ringInterruptibleSleep.interrupt();
            Thread display = workerThread;
            Thread ring = ringWorkerThread;
            if (display != null) display.interrupt();
            if (ring != null) ring.interrupt();
            setStateDisplay("disconnecting", "Disconnecting...");
        }
        scheduleDeferredCleanup();
        return awaitCleanup(5_000);
    }

    private boolean awaitCleanup(long timeoutMs) {
        long deadline = SystemClock.elapsedRealtime() + timeoutMs;
        while (SystemClock.elapsedRealtime() < deadline) {
            synchronized (lock) { if (cleanupComplete) return true; }
            try { Thread.sleep(25); } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return false;
            }
        }
        logLine("disconnect incomplete; deferred cleanup owns BLE resources");
        return false;
    }

    private void scheduleDeferredCleanup() {
        synchronized (lock) {
            if (cleanupThread != null && cleanupThread.isAlive()) return;
            cleanupThread = new Thread(() -> {
                while (true) {
                    Thread display;
                    Thread ring;
                    synchronized (lock) {
                        if (cleanupComplete) return;
                        display = workerThread;
                        ring = ringWorkerThread;
                    }
                    if ((display == null || !display.isAlive()) && (ring == null || !ring.isAlive())) {
                        if (completeCleanup()) return;
                    } else {
                        if (display != null) display.interrupt();
                        if (ring != null) ring.interrupt();
                    }
                    try { Thread.sleep(100); } catch (InterruptedException e) {
                        Thread.currentThread().interrupt();
                        return;
                    }
                }
            }, "FaceclawBleCleanup");
            cleanupThread.setDaemon(true);
            cleanupThread.start();
        }
    }

    private boolean completeCleanup() {
        synchronized (lock) {
            if (cleanupComplete || cleanupStarted) return cleanupComplete;
            if ((workerThread != null && workerThread.isAlive()) || (ringWorkerThread != null && ringWorkerThread.isAlive())) return false;
            cleanupStarted = true;
        }
        boolean success = true;
        try {
            synchronized (lock) {
                if (!stateCleanupComplete) {
                    workerThread = null;
                    resetSessionStateLocked();
                    clearAllMessagesLocked("disconnect");
                    silentMode = -1;
                    stateCleanupComplete = true;
                }
            }
            synchronized (ringLock) {
                ringWorkerThread = null;
                resetRingStateLocked();
            }
            if (!managerCleanupComplete) {
                try {
                    bleManager.disconnect(rightAddress);
                    bleManager.disconnect(leftAddress);
                    if (hasRingAddress()) bleManager.disconnect(ringAddress);
                    bleManager.close();
                    managerCleanupComplete = true;
                } catch (Throwable t) {
                    success = false;
                    logLine("BLE manager cleanup failed: " + safeMessage(t));
                }
            }
            if (success && !wakeLockCleanupComplete) {
                try { releaseG2ScreenWakeLock(); wakeLockCleanupComplete = true; }
                catch (Throwable t) { success = false; logLine("wake-lock cleanup failed: " + safeMessage(t)); }
            }
            if (success && !receiverCleanupComplete) {
                try {
                    if (closeRequested && phoneLockReceiverRegistered) {
                        appContext.unregisterReceiver(phoneLockReceiver);
                        phoneLockReceiverRegistered = false;
                    }
                    receiverCleanupComplete = true;
                } catch (Throwable t) { success = false; logLine("receiver cleanup failed: " + safeMessage(t)); }
            }
            if (success && managerCleanupComplete && wakeLockCleanupComplete && receiverCleanupComplete) {
                synchronized (lock) { cleanupComplete = true; cleanupStarted = false; }
                if (activeInstance == this) activeInstance = null;
                setStateDisplay("disconnected", "Disconnected.");
                return true;
            }
        } catch (Throwable t) {
            logLine("deferred cleanup failed: " + safeMessage(t));
        }
        synchronized (lock) { cleanupStarted = false; }
        return false;
    }

    public boolean close() {
        synchronized (lock) { closeRequested = true; }
        return disconnect();
    }

    public void setG2ScreenOn(boolean screenOn) {
        mainHandler.post(() -> updateG2ScreenWakeLock(screenOn));
    }

    /** Direct R1 status; glasses-forwarded ring events still work without it. */
    public String getRingConnectionState() {
        if (!hasRingAddress()) {
            return "not-configured";
        }
        synchronized (ringLock) {
            if (ringNotificationsReady) {
                return "ready";
            }
            if (ringConnected) {
                return "subscribing";
            }
            return running && sessionReady ? "retrying" : "idle";
        }
    }

    /** Request the dedicated R1 worker to retry the optional direct link. */
    public boolean requestRingReconnect() {
        if (!hasRingAddress() || stopping || !running || !sessionReady) {
            return false;
        }
        synchronized (ringLock) {
            if (stopping) {
                return false;
            }
            if (ringNotificationsReady) {
                return true;
            }
            // Manual reconnect clears the backoff so it retries immediately.
            ringConsecutiveFailures = 0;
            ringReconnectAfterMs = 0;
        }
        ringInterruptibleSleep.interrupt();
        return true;
    }

    public void setFirmwareDebugFlags(boolean enabled) {
        // Just record it; the drive loop emits the mode-7 control message when the
        // session is warmed up and idle, and re-emits when this value changes.
        firmwareDebugFlagsEnabled = enabled;
    }

    public boolean startG2AudioCapture(FaceclawAudioPacketListener listener) {
        if (listener == null) {
            throw new IllegalArgumentException("listener is required");
        }
        int magic;
        synchronized (lock) {
            if (!running || !sessionReady || shutdownRequested || !fixedLayoutCreated || !warmedUp) {
                logLine("skip G2 mic enable; EvenHub display path not ready");
                return false;
            }
            audioPacketListener = listener;
            OutboundMessage message = createAudioControlMessageLocked(true);
            magic = message.magic;
            pendingMessages.addFirst(message);
            logLine("queue G2 mic enable");
        }
        interruptibleSleep.interrupt();
        return waitForAudioControlAck(magic, "enable");
    }

    public void stopG2AudioCapture() {
        int magic = 0;
        synchronized (lock) {
            audioPacketListener = null;
            audioCaptureActive = false;
            clearMessagesOfKindLocked("audio-control");
            if (running && sessionReady) {
                OutboundMessage message = createAudioControlMessageLocked(false);
                magic = message.magic;
                pendingMessages.addFirst(message);
                logLine("queue G2 mic disable");
            }
        }
        interruptibleSleep.interrupt();
        if (magic != 0) {
            waitForAudioControlAck(magic, "disable");
        }
    }

    public boolean isSessionReady() {
        synchronized (lock) {
            return running && sessionReady;
        }
    }

    /**
     * Acquire/renew or release CFW's volatile wake-takeover lease on both
     * arms. Delivery (not a protocol ACK) is awaited so a caller can ensure
     * the fail-open firmware policy is installed before relying on wakeword
     * interception or suspending EvenHub.
     */
    public boolean setFaceclawWakeLeaseEnabled(boolean enabled) {
        int generation;
        synchronized (lock) {
            faceclawWakeLeaseEnabled = enabled;
            if (!running || !sessionReady) {
                return !enabled;
            }
            generation = enqueueFaceclawWakeControlLocked(
                enabled ? BleProtocol.FACECLAW_WAKE_OP_ACQUIRE : BleProtocol.FACECLAW_WAKE_OP_RELEASE,
                0,
                true
            );
            if (!enabled) {
                faceclawWakePendingNonce = -1;
            }
        }
        interruptibleSleep.interrupt();
        return waitForFaceclawWakeControlDelivery(generation, FACECLAW_WAKE_CONTROL_WAIT_MS);
    }

    /**
     * Wait until the recreated layout, warmup, and retained compositor frame
     * have all landed. If this wake came from CFW's deferred double tap, READY
     * is then sent to both arms to cancel their stock-dashboard fallback.
     */
    public boolean awaitEvenHubSessionReady(int timeoutMs) {
        long deadline = SystemClock.elapsedRealtime() + Math.max(0, timeoutMs);
        int readyGeneration = 0;
        synchronized (lock) {
            while (running && sessionReady) {
                boolean frameReady = false;
                synchronized (desiredTilesLock) {
                    frameReady = !desiredFingerprint.isEmpty()
                        && desiredFingerprint.equals(displayedFingerprint);
                }
                if (!shutdownRequested && fixedLayoutCreated && warmedUp && frameReady) {
                    if (faceclawWakePendingNonce >= 0) {
                        readyGeneration = enqueueFaceclawWakeControlLocked(
                            BleProtocol.FACECLAW_WAKE_OP_READY,
                            faceclawWakePendingNonce,
                            true
                        );
                        faceclawWakePendingNonce = -1;
                    }
                    break;
                }
                long remaining = deadline - SystemClock.elapsedRealtime();
                if (remaining <= 0) {
                    return false;
                }
                try {
                    lock.wait(Math.min(remaining, 100));
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    return false;
                }
            }
            if (!running || !sessionReady) {
                return false;
            }
        }
        if (readyGeneration != 0) {
            interruptibleSleep.interrupt();
            if (!waitForFaceclawWakeControlDelivery(readyGeneration, FACECLAW_WAKE_CONTROL_WAIT_MS)) {
                logLine("wake READY delivery not confirmed before fallback deadline");
            }
        }
        return true;
    }

    /**
     * Enable or disable the IMU (accelerometer) report stream. Fire-and-forget:
     * the control message is queued ahead of other traffic; readings arrive via
     * registered FaceclawImuListeners. reportFrq is the requested sample rate
     * (ignored on disable).
     */
    public void setImuReportEnabled(boolean enable, int reportFrq) {
        synchronized (lock) {
            if (!running || !sessionReady) {
                logLine("skip IMU " + (enable ? "enable" : "disable") + "; session not ready");
                return;
            }
            clearMessagesOfKindLocked("imu-control");
            OutboundMessage message = messageBuilder.enableOrDisableImu(enable, reportFrq);
            message.onTimeout = () -> logLine("IMU control ack timeout");
            pendingMessages.addFirst(message);
            logLine("queue IMU " + (enable ? "enable freq=" + reportFrq : "disable"));
        }
        interruptibleSleep.interrupt();
    }

    /**
     * Enable/disable the stock compass through CFW image-handler mode 10. The
     * desired state is retained across reconnects; headings arrive through
     * stock sid-0x08 navigation notifications and FaceclawCompassListeners.
     */
    public void setCompassEnabled(boolean enable) {
        synchronized (lock) {
            compassEnabled = enable;
            compassControlLastSent = -1;
            clearMessagesOfKindLocked("compass-control");
            if (running && sessionReady && !shutdownRequested && fixedLayoutCreated && warmedUp) {
                enqueueCompassControlLocked(true, compassEnabled);
            } else {
                logLine("defer compass " + (enable ? "enable" : "disable") + "; display path not ready");
            }
        }
        interruptibleSleep.interrupt();
    }

    /**
     * Set the lens brightness. Fire-and-forget, like the IMU control: the
     * message is queued ahead of other traffic and any not-yet-sent brightness
     * message is superseded. When autoAdjust is true the ambient-light sensor
     * drives brightness and brightnessLevel is ignored; otherwise
     * brightnessLevel (0-100) is applied directly.
     */
    public void setBrightness(boolean autoAdjust, int brightnessLevel) {
        synchronized (lock) {
            if (!running || !sessionReady) {
                logLine("skip brightness set; session not ready");
                return;
            }
            clearMessagesOfKindLocked("brightness-control");
            OutboundMessage message = messageBuilder.setBrightness(autoAdjust, brightnessLevel);
            message.onTimeout = () -> logLine("brightness control ack timeout");
            pendingMessages.addFirst(message);
            logLine("queue brightness " + (autoAdjust ? "auto" : "level=" + brightnessLevel));
        }
        interruptibleSleep.interrupt();
    }

    /**
     * Enable the stock wear detector, then ask CFW to emit its current cached
     * state. The queue order matters: the query must run after the setting is
     * applied, including on a fresh install where wear detection was disabled.
     */
    public void enableWearDetectionAndRequestState() {
        synchronized (lock) {
            if (!running || !sessionReady) {
                logLine("skip wear detector setup; session not ready");
                return;
            }
            clearMessagesOfKindLocked("wear-detection-control");
            clearMessagesOfKindLocked("wear-query-control");
            OutboundMessage queryLeft = messageBuilder.faceclawWearQuery(true);
            OutboundMessage queryRight = messageBuilder.faceclawWearQuery(false);
            OutboundMessage enable = messageBuilder.setWearDetection(true);
            enable.onTimeout = () -> logLine("wear detection enable ack timeout");
            pendingMessages.addFirst(queryLeft);
            pendingMessages.addFirst(queryRight);
            pendingMessages.addFirst(enable);
            logLine("queue wear detection enable + current-state query");
        }
        interruptibleSleep.interrupt();
    }

    public void addImuListener(FaceclawImuListener listener) {
        if (listener != null) {
            imuListeners.add(listener);
        }
    }

    public void removeImuListener(FaceclawImuListener listener) {
        if (listener != null) {
            imuListeners.remove(listener);
        }
    }

    public void addCompassListener(FaceclawCompassListener listener) {
        if (listener != null) {
            compassListeners.add(listener);
        }
    }

    public void removeCompassListener(FaceclawCompassListener listener) {
        if (listener != null) {
            compassListeners.remove(listener);
        }
    }


    // The most recently started communicator; lets app worker threads submit
    // surface frames without holding a cross-isolate reference to the bridge
    // object (JS wrappers do not cross isolates, but the Java instance does).
    private static volatile FaceclawBleCommunicator activeInstance;

    public static FaceclawBleCommunicator getActive() {
        return activeInstance;
    }

    /** Set the compositor's output frame size. Call before configuring surfaces. */
    public void configureCompositorScreen(int width, int height) {
        compositor.configureScreen(width, height);
    }

    /**
     * The current composited screen as a phone-UI preview bitmap, or null
     * before any surface has been configured. Built from the compositor so
     * the preview reflects every surface (chrome + whichever app is
     * foreground), including worker-app frames the TS side never sees.
     */
    public android.graphics.Bitmap getCompositePreviewBitmap(double brightenGamma) {
        SurfaceCompositor.Composite composite = compositor.previewComposite();
        if (composite == null) {
            return null;
        }
        return PreviewBitmapUtil.fromGray(
                java.nio.ByteBuffer.wrap(composite.gray), composite.width, composite.height, brightenGamma);
    }

    /** Save the current composite as a 4-bit grayscale PNG; returns the path or "". */
    public String saveCompositePngScreenshot() throws java.io.IOException {
        SurfaceCompositor.Composite composite = compositor.previewComposite();
        if (composite == null) {
            return "";
        }
        return ScreenshotUtil.savePngScreenshot(appContext, composite.gray, composite.width, composite.height);
    }

    /**
     * Save the current composite cropped to the given screen rect (the region
     * the shell says is actually occupied). The rect is clamped to the screen;
     * a degenerate rect falls back to the full screen.
     */
    public String saveCompositePngScreenshot(int cropX, int cropY, int cropWidth, int cropHeight)
            throws java.io.IOException {
        SurfaceCompositor.Composite composite = compositor.previewComposite();
        if (composite == null) {
            return "";
        }
        int x = Math.max(0, cropX);
        int y = Math.max(0, cropY);
        int width = Math.min(composite.width - x, cropWidth - (x - cropX));
        int height = Math.min(composite.height - y, cropHeight - (y - cropY));
        if (width <= 0 || height <= 0 || (x == 0 && y == 0 && width == composite.width && height == composite.height)) {
            return ScreenshotUtil.savePngScreenshot(appContext, composite.gray, composite.width, composite.height);
        }
        byte[] cropped = new byte[width * height];
        for (int row = 0; row < height; row++) {
            System.arraycopy(composite.gray, (y + row) * composite.width + x, cropped, row * width, width);
        }
        return ScreenshotUtil.savePngScreenshot(appContext, cropped, width, height);
    }

    // Active animated-GIF screen recording, or null when idle. Frames are
    // pushed by recordScreenFrame(), which the TS side calls at each
    // phone-preview flush.
    private volatile GifScreenRecorder screenRecorder;

    /** Begin collecting composite frames for an animated-GIF screen recording. */
    public void startScreenRecording() {
        screenRecorder = new GifScreenRecorder();
    }

    /** Capture the current composite into the active recording; no-op when idle. */
    public void recordScreenFrame() {
        GifScreenRecorder recorder = screenRecorder;
        if (recorder == null) {
            return;
        }
        SurfaceCompositor.Composite composite = compositor.previewComposite();
        if (composite == null) {
            return;
        }
        recorder.addFrame(composite.gray, composite.width, composite.height, System.currentTimeMillis());
    }

    /** Finish the recording and save it as an animated GIF; returns the path or "". */
    public String stopScreenRecording() throws java.io.IOException {
        GifScreenRecorder recorder = screenRecorder;
        screenRecorder = null;
        if (recorder == null) {
            return "";
        }
        if (recorder.isOverflowed()) {
            logLine("screen recording hit its frame cap; the tail was dropped");
        }
        return recorder.save(appContext);
    }

    /**
     * Show or hide a compositor surface, immediately submitting the resulting
     * frame. Recompositing here (rather than waiting for the next surface
     * update) is what makes a just-foregrounded window's retained frame
     * actually appear — otherwise a static window (e.g. the terminal hub) whose
     * frame landed while briefly hidden would stay blank until its next repaint.
     */
    public void setSurfaceVisible(String id, boolean visible) {
        compositor.setSurfaceVisible(id, visible);
        SurfaceCompositor.Composite composite = compositor.composite();
        byte[] packed = BmpUtil.pack4bppFromGray8(composite.gray, composite.width, composite.height);
        storeDesiredComposite(composite, packed, 0, 0);
    }

    /**
     * Blank (screen off) or unblank the composited output, immediately
     * submitting the resulting frame. Retained surface state is untouched, so
     * unblanking restores the previous screen content without repaints.
     */
    public void setScreenBlanked(boolean blanked) {
        compositor.setBlanked(blanked);
        SurfaceCompositor.Composite composite = compositor.composite();
        byte[] packed = BmpUtil.pack4bppFromGray8(composite.gray, composite.width, composite.height);
        storeDesiredComposite(composite, packed, 0, 0);
    }

    /**
     * Create or reconfigure a compositor surface. transparency is one of the
     * SurfaceCompositor.TRANSPARENCY_* constants. Geometry changes take effect
     * when the next frame is submitted.
     */
    public void configureSurface(String id, int x, int y, int width, int height, int zOrder, int transparency) {
        compositor.configureSurface(id, x, y, width, height, zOrder, transparency);
    }

    public void removeSurface(String id) {
        compositor.removeSurface(id);
    }

    /**
     * Apply an update to one compositor surface and submit the recomposited
     * screen as the desired frame. The update covers the rect (rectX, rectY,
     * rectWidth, rectHeight) in surface-local coordinates; contentFingerprint
     * identifies the surface's full content after the update.
     *
     * pixels8bpp arrives as a ByteBuffer because NativeScript marshals a JS
     * ArrayBuffer to one without the per-element bridge copy that a byte[]
     * parameter would need (~150ms for a full frame).
     */
    public void submitSurfaceFrame(
            java.nio.ByteBuffer pixels8bpp,
            String surfaceId,
            int rectX,
            int rectY,
            int rectWidth,
            int rectHeight,
            String contentFingerprint,
            int paintMs,
            int frameId
    ) {
        Log.i(TAG, "Received an updated frame for surface " + surfaceId);
        FrameTimings.getInstance().spanStart(frameId, "composite");
        SurfaceCompositor.Composite composite = compositor.applyAndComposite(
                surfaceId, pixels8bpp, rectX, rectY, rectWidth, rectHeight, contentFingerprint);
        FrameTimings.getInstance().spanEnd(frameId, "composite");
        // Pack the composited 8bpp buffer down to the headerless 4bpp frame
        // format the wire planners consume; BMP framing is added later only on
        // the rare paths that still need it (warmup, uncompressed fallback).
        FrameTimings.getInstance().spanStart(frameId, "pack-4bpp");
        byte[] packed = BmpUtil.pack4bppFromGray8(composite.gray, composite.width, composite.height);
        FrameTimings.getInstance().spanEnd(frameId, "pack-4bpp");
        storeDesiredComposite(composite, packed, paintMs, frameId);
    }

    /** Store a composite as the desired frame unless a newer one won the race. */
    private void storeDesiredComposite(SurfaceCompositor.Composite composite, byte[] packed, int paintMs, int frameId) {
        int supersededFrameId = 0;
        boolean stale = false;
        synchronized (desiredTilesLock) {
            if (composite.seq <= lastStoredCompositeSeq) {
                // A concurrent submission composited after us and stored first;
                // its composite already includes this surface update.
                stale = true;
            } else {
                lastStoredCompositeSeq = composite.seq;
                supersededFrameId = desiredFrameId;
                desiredPacked = packed;
                desiredWidth = composite.width;
                desiredHeight = composite.height;
                desiredFingerprint = composite.fingerprint;
                desiredPaintMs = paintMs;
                desiredFrameId = frameId;
            }
        }
        if (stale) {
            finishFrame(frameId, "discarded: composite superseded before store");
            return;
        }
        if (supersededFrameId != 0 && supersededFrameId != frameId) {
            finishFrame(supersededFrameId, "discarded: superseded by frame#" + frameId + " before send");
        }
        FrameTimings.getInstance().log(frameId, "image submitted as desired frame");
        interruptibleSleep.interrupt();
    }

    /**
     * Play a tone sequence via CFW load_image_z mode 5 kind 4. The payload is
     * the complete wire buffer ([5][4][nSteps][freqLo,freqHi,duty,msLo,msHi]*n,
     * up to 48 steps), built on the TS side; it rides the arbitrary-payload
     * image path like the other mode-5 controls.
     */
    public void playBuzzerSequence(java.nio.ByteBuffer payload) {
        synchronized (lock) {
            if (!running || !sessionReady || !fixedLayoutCreated) {
                logLine("skip buzzer sequence; session not ready");
                return;
            }
            byte[] bytes = new byte[payload == null ? 0 : payload.remaining()];
            if (payload != null) {
                payload.get(bytes);
            }
            if (bytes.length < 3) {
                logLine("skip buzzer sequence; empty payload");
                return;
            }
            OutboundMessage message = messageBuilder.imagePayload(
                DASHBOARD_TILE,
                nextMapSessionId(),
                bytes,
                "buzzer sequence " + bytes.length + "B",
                connectionOptions.sendImagesToLeft
            );
            message.onTimeout = () -> {
                logLine("buzzer sequence ack timeout; dropped");
            };
            pendingMessages.addLast(message);
            logLine("queue " + message.label);
        }
        interruptibleSleep.interrupt();
    }

    public boolean sendShutdown(int exitMode) {
        return sendShutdownInternal(exitMode, true);
    }

    /**
     * End the EvenHub page while retaining both arm GATT connections and all
     * notification subscriptions. A missed ACK is intentionally non-fatal:
     * reconnecting Bluetooth here would defeat the power-saving mode.
     */
    public boolean suspendEvenHubSession() {
        if (sendShutdownInternal(0, false)) {
            return true;
        }
        synchronized (lock) {
            // A shutdown ACK can be lost even though the command took effect.
            // If the transport remains intentionally quiesced, callers still
            // need to remember to run the resume path on the next wake.
            return running && sessionReady && shutdownRequested;
        }
    }

    /**
     * Start a fresh EvenHub plugin task on the existing BLE transport, then let
     * the session driver create the layout, warm up the image path, and send
     * the desired frame.
     */
    public boolean resumeEvenHubSession() {
        int claimGeneration = 0;
        synchronized (lock) {
            if (!running || !sessionReady || chargingMode) {
                logLine("skip EvenHub resume; transport not ready");
                return false;
            }
            if (!shutdownRequested) {
                return true;
            }
            if (faceclawWakePendingNonce >= 0
                    && hasPendingOrInflightKindLocked("wake-lease-control")) {
                claimGeneration = faceclawWakeControlGeneration;
            }
            logLine("replaying session prelude for EvenHub resume");
        }

        // A custom double-tap wake has only a short unclaimed fail-open
        // deadline. Let the worker put CLAIM on both arms before the direct
        // prelude write begins.
        if (claimGeneration != 0) {
            waitForFaceclawWakeControlDelivery(claimGeneration, 500);
        }

        try {
            // Empty-name Cmd=9 tears down the whole plugin task, not just its
            // image container. Re-run the launch prelude before Cmd=0 CREATE.
            sendPrelude(true);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            hardTransportFailure("EvenHub resume prelude interrupted");
            return false;
        } catch (Throwable t) {
            logLine("EvenHub resume prelude failed: " + safeMessage(t));
            hardTransportFailure("EvenHub resume prelude failed");
            return false;
        }

        synchronized (lock) {
            if (!running || !sessionReady || chargingMode) {
                return false;
            }
            shutdownRequested = false;
            fixedLayoutCreated = false;
            warmedUp = false;
            startupProbePending = false;
            audioCaptureActive = false;
            clearAllMessagesPreservingWakeLeaseLocked("EvenHub resume");
            displayedFingerprint = "";
            imageRetryAfterMs = 0;
            lastHeartbeatSentAtMs = 0;
            lastHeartbeatAckedAtMs = 0;
            logLine("EvenHub session resume requested");
        }
        interruptibleSleep.interrupt();
        return true;
    }

    private boolean sendShutdownInternal(int exitMode, boolean reconnectOnTimeout) {
        int magic;
        long startedAtMs = SystemClock.elapsedRealtime();
        synchronized (lock) {
            if (!running || !sessionReady) {
                logLine("skip shutdown; session not ready");
                return false;
            }
            if (shutdownRequested) {
                return true;
            }
            shutdownRequested = true;
            // Magic values wrap, so an ACK from a much older suspend must not
            // satisfy this request after enough sleep/wake cycles.
            lastShutdownAckMagic = 0;
            clearPendingMessagesLocked("shutdown requested");
            OutboundMessage message = messageBuilder.shutdown(exitMode);
            magic = message.magic;
            message.onAck = () -> {
                lastShutdownAckMagic = message.magic;
                fixedLayoutCreated = false;
                warmedUp = false;
                displayedFingerprint = "";
            };
            message.onTimeout = () -> {
                if (reconnectOnTimeout) {
                    hardTransportFailure("shutdown ack timeout");
                } else {
                    logLine("EvenHub shutdown ack timeout; keeping BLE connected");
                }
            };
            pendingMessages.addFirst(message);
            logLine("queue shutdown");
            // The stock compass keeps the magnetometer sampling independently of
            // the plugin task, so ending the page does not stop it. Force a
            // disable ahead of the shutdown command whenever it may be running:
            // this also covers a disable that was wiped by the queue flush above
            // or whose ack was lost, and the charging-mode/exit paths where the
            // Compass window never got a chance to release it.
            if (compassMaybeOn && fixedLayoutCreated && warmedUp) {
                enqueueCompassControlLocked(true, false);
            }
        }
        interruptibleSleep.interrupt();

        long ackDeadline = SystemClock.elapsedRealtime() + ConnectionOptions.ACK_TIMEOUT_MS + 500;
        synchronized (lock) {
            while (running
                    && sessionReady
                    && lastShutdownAckMagic != magic
                    && lastShutdownExitAtMs < startedAtMs
                    && hasPendingOrInflightMagicLocked(magic)) {
                long remaining = ackDeadline - SystemClock.elapsedRealtime();
                if (remaining <= 0) {
                    break;
                }
                try {
                    lock.wait(Math.min(remaining, 100));
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    break;
                }
            }
            boolean acked = lastShutdownAckMagic == magic;
            if (acked) {
                long exitDeadline = SystemClock.elapsedRealtime() + ConnectionOptions.ACK_TIMEOUT_MS + 500;
                while (running && sessionReady && lastShutdownExitAtMs < startedAtMs) {
                    long remaining = exitDeadline - SystemClock.elapsedRealtime();
                    if (remaining <= 0) {
                        break;
                    }
                    try {
                        lock.wait(Math.min(remaining, 100));
                    } catch (InterruptedException e) {
                        Thread.currentThread().interrupt();
                        break;
                    }
                }
            }
            return acked || lastShutdownExitAtMs >= startedAtMs;
        }
    }

    private boolean waitForAudioControlAck(int magic, String operation) {
        long deadline = SystemClock.elapsedRealtime() + ConnectionOptions.ACK_TIMEOUT_MS + ConnectionOptions.WRITE_TIMEOUT_MS + 500;
        synchronized (lock) {
            while (running && sessionReady && lastAudioControlAckMagic != magic && hasPendingOrInflightMagicLocked(magic)) {
                long remaining = deadline - SystemClock.elapsedRealtime();
                if (remaining <= 0) {
                    break;
                }
                try {
                    lock.wait(Math.min(remaining, 100));
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    break;
                }
            }
            boolean acked = lastAudioControlAckMagic == magic;
            if (!acked) {
                if ("enable".equals(operation)) {
                    audioPacketListener = null;
                    audioCaptureActive = false;
                }
                logLine("G2 mic " + operation + " ack timeout");
            }
            return acked;
        }
    }


    @Override public void run() {
        logLine(String.format(Locale.US, "communicator start R=%s L=%s ring=%s", rightAddress, leftAddress, ringAddress));
        while (true) {
            try {
                if (!running) {
                    Log.w(TAG, "Exiting event looop");
                    break;
                }
                emitPhoneLockStateIfChanged(false);
                if (!sessionReady) {
                    long now = SystemClock.elapsedRealtime();
                    if (now < reconnectAfterMs) {
                        interruptibleSleep.sleep(Math.min(ConnectionOptions.IDLE_SLEEP_MS, reconnectAfterMs - now));
                        continue;
                    }
                    Log.w(TAG, "Attempting to connect");
                    connectLoopOnce();
                    continue;
                }

                long sleepMs = driveSession();
                if (sleepMs > 0) {
                    interruptibleSleep.sleep(sleepMs);
                }
            } catch (Throwable t) {
                logLine("communicator loop error: " + safeMessage(t));
                handleTransportFailure("loop error");
            }
        }
        logLine("communicator stop");
        // The worker owns the deferred cleanup after a bounded close() could
        // not join it. This path is idempotent and is the only path that can
        // release BLE resources after a non-cooperative worker eventually exits.
        scheduleDeferredCleanup();
    }

    private void runRingLoop() {
        logLine("direct ring worker start");
        while (running && !stopping) {
            try {
                if (!hasRingAddress() || !sessionReady) {
                    ringInterruptibleSleep.sleep(ConnectionOptions.IDLE_SLEEP_MS);
                    continue;
                }
                if (shouldAttemptRingConnect()) {
                    tryConnectRing("retry");
                    // The connection callback wakes this worker while connectGatt
                    // is still completing. Consume that now-stale wake before the
                    // first 200ms probe gap, where an interrupt means cancel.
                    ringInterruptibleSleep.sleep(1);
                    continue;
                }
                drainRingPacketAcks();
                maybeReRingHealthPoll();
                maybeReRingCurrentHrPoll();
                ringInterruptibleSleep.sleep(nextRingLoopSleepMs());
            } catch (Throwable t) {
                if (!running || stopping) {
                    break;
                }
                logLine("direct ring worker error: " + safeMessage(t));
                handleRingFailure("worker error", t);
            }
        }
        logLine("direct ring worker stop");
    }

    private long nextRingLoopSleepMs() {
        long now = SystemClock.elapsedRealtime();
        synchronized (ringLock) {
            if (!ringNotificationsReady) {
                return Math.max(1, Math.min(ConnectionOptions.IDLE_SLEEP_MS, ringReconnectAfterMs - now));
            }
            long fullRemaining = RING_HEALTH_POLL_INTERVAL_MS - (now - lastRingHealthPollMs);
            long currentHrRemaining = RING_CURRENT_HR_POLL_INTERVAL_MS - (now - lastRingCurrentHrPollMs);
            return Math.max(1, Math.min(ConnectionOptions.IDLE_SLEEP_MS, Math.min(fullRemaining, currentHrRemaining)));
        }
    }

    @Override public void onNotification(BluetoothGatt gatt, String address, String characteristicUuid, byte[] data,
                                         GattCallbackRegistry.DispatchLease<BluetoothGatt> lease) {
        lease.dispatchIfCurrent(ignored -> {
            if (isConfiguredRingAddress(address)) {
                int generation;
                byte[] copy;
                synchronized (ringLock) {
                    if (stopping || !running) return;
                    generation = ringConnectionGeneration;
                    copy = data == null ? null : Arrays.copyOf(data, data.length);
                }
                handleDirectRingNotification(characteristicUuid, copy, generation);
            } else {
                synchronized (lock) {
                    onNotification(address, characteristicUuid, data);
                }
            }
        });
    }

    @Override public void onNotification(String address, String characteristicUuid, byte[] data) {
        if (address == null || characteristicUuid == null || data == null) {
            return;
        }
        String uuid = characteristicUuid.toLowerCase(Locale.US);
        if (isDirectRingNotification(address, uuid)) {
            handleDirectRingNotification(uuid, data, ringConnectionGeneration);
            return;
        }
        if (BleProtocol.RENDER_NOTIFY_UUID.equals(uuid)) {
            handleRenderNotification(address, data);
            return;
        }
        if (!BleProtocol.NOTIFY_CHAR_UUID.equals(uuid)) {
            return;
        }
        Log.d(TAG, "onNotification: address=" + address + " characteristicUuid=" + characteristicUuid + " data.length=" + data.length);
        BleProtocol.ParsedFrame frame = BleProtocol.parseFrame(data);
        logRelayCandidateFrame(address, frame);
        int decodedWearState = BleProtocol.parseWearState(frame);
        BleProtocol.CompassEvent compassEvent = address.equalsIgnoreCase(rightAddress)
            ? BleProtocol.parseCompassEvent(frame)
            : null;
        boolean emitWearState = false;
        G2Event event = null;
        synchronized (lock) {
            lastIncomingAtMs = SystemClock.elapsedRealtime();
            if (decodedWearState >= 0 && decodedWearState != wearState) {
                wearState = decodedWearState;
                emitWearState = true;
            }
            boolean faceclawWakeNotification = false;
            if (shutdownRequested
                    && frame.ok
                    && frame.sid == BleProtocol.SID_UI_SETTING
                    && address.equalsIgnoreCase(rightAddress)) {
                int wakeNonce = BleProtocol.parseFaceclawWakeEvent(frame.pb);
                if (wakeNonce >= 0) {
                    faceclawWakePendingNonce = wakeNonce;
                    enqueueFaceclawWakeControlLocked(
                        BleProtocol.FACECLAW_WAKE_OP_CLAIM,
                        wakeNonce,
                        true
                    );
                    faceclawWakeNotification = true;
                    lastConnectionOrInputAtMs = lastIncomingAtMs;
                    event = new G2Event(
                        "display-wake",
                        "",
                        BleProtocol.EVENT_DOUBLE_CLICK,
                        0,
                        0
                    );
                    logLine("claimed deferred dashboard wake nonce=" + wakeNonce);
                }
            }
            if (!faceclawWakeNotification
                    && shutdownRequested
                    && address.equalsIgnoreCase(rightAddress)
                    && BleProtocol.isDisplayWakeStateChange(frame)) {
                // With no EvenHub page, ring/arm double-taps are handled by the
                // stock display lifecycle and surface only as this state ping.
                // Translate it back into an input event so TS can wake the shell
                // and recreate the page.
                event = new G2Event(
                    "display-wake",
                    "",
                    BleProtocol.EVENT_DOUBLE_CLICK,
                    0,
                    0
                );
            }
            if (!faceclawWakeNotification
                    && decodedWearState < 0
                    && frame.ok
                    && frame.sid == BleProtocol.SID_UI_SETTING) {
                // Device-initiated settings push. It carries a magic the glasses
                // chose, so it would otherwise fall through to resolveAckLocked,
                // match nothing, and be logged as an unexpected ack.
                int pushedSilentMode = BleProtocol.parseSilentModePush(frame.pb);
                if (pushedSilentMode >= 0) {
                    updateSilentModeLocked(pushedSilentMode > 0);
                    return;
                }
            }
            if (!faceclawWakeNotification
                    && decodedWearState < 0
                    && frame.ok
                    && frame.msgSeq >= 0
                    && frame.flag != BleProtocol.FLAG_NOTIFY
                    && frame.flag != BleProtocol.FLAG_NOTIFY_ALT) {
                lastAckAtMs = lastIncomingAtMs;
                resolveAckLocked(frame.sid, frame.msgSeq, frame.pb);
            }
            if (!faceclawWakeNotification
                    && event == null
                    && frame.ok
                    && address.equalsIgnoreCase(rightAddress)
                    && (frame.flag == BleProtocol.FLAG_NOTIFY || frame.flag == BleProtocol.FLAG_NOTIFY_ALT)) {
                event = G2Event.decode(frame);
                if (event != null) {
                    // Pure IMU samples arrive continuously; don't let them count
                    // as user input (which would starve battery polling).
                    boolean pureImuSample = "sys-event".equals(event.kind)
                        && event.eventType == BleProtocol.EVENT_IMU_DATA_REPORT;
                    if (!pureImuSample) {
                        lastConnectionOrInputAtMs = lastIncomingAtMs;
                    }
                    if ("list-click".equals(event.kind) || "text-click".equals(event.kind)) {
                        // Container-routed touchpad input reached us, so the
                        // firmware is dispatching input: silent mode is off,
                        // whether or not its end-of-silent push arrived.
                        updateSilentModeLocked(false);
                    }
                    if ("sys-event".equals(event.kind)) {
                        if (event.eventType == BleProtocol.EVENT_FOREGROUND_EXIT || event.eventType == BleProtocol.EVENT_ABNORMAL_EXIT || event.eventType == BleProtocol.EVENT_SYSTEM_EXIT) {
                            if (shutdownRequested) {
                                lastShutdownExitAtMs = SystemClock.elapsedRealtime();
                            }
                            fixedLayoutCreated = false;
                            warmedUp = false;
                            displayedFingerprint = "";
                            clearAllMessagesLocked("firmware exit event");
                        }
                    }
                }
            }
        }
        interruptibleSleep.interrupt();
        if (emitWearState) {
            logLine(decodedWearState > 0 ? "wear state ON_HEAD" : "wear state OFF_HEAD");
            emitWearState(decodedWearState > 0);
        }
        if (compassEvent != null) {
            emitCompassEvent(compassEvent.command, compassEvent.headingDegrees);
        }
        if (event != null) {
            if (event.hasImu) {
                emitImuData(event.imuX, event.imuY, event.imuZ, event.eventSource);
            }
            // A standalone IMU_DATA_REPORT is a sensor sample, not a gesture:
            // deliver it only to IMU listeners, skipping the input pipeline (and
            // its per-frame latency bookkeeping) to avoid flooding it.
            boolean pureImuSample = "sys-event".equals(event.kind)
                && event.eventType == BleProtocol.EVENT_IMU_DATA_REPORT;
            if (!pureImuSample) {
                int frameId = FrameTimings.getInstance().startFrame(
                    "input:" + event.kind + " type=" + event.eventType + " src=" + event.eventSource);
                FrameTimings.getInstance().log(frameId, "input event decoded from BLE notification");
                emitRingEvent(event.kind, event.containerName, event.eventType, event.eventSource, event.systemExitReasonCode, frameId);
            }
        }
    }

    /**
     * Route A health spike (discovery): log glasses frames on the ring-relay /
     * health service IDs, and any other unhandled SID, with their protobuf
     * bytes. Read-only — this is how we learn whether the glasses forward ring
     * RingRawData (health) over the phone's existing link without any phone↔ring
     * auth. A frame on SID_RING_ROW_DATA/SID_RING_DATA_RELAY/SID_HEALTH is the
     * signal that the relay path works; total silence means the relay needs a
     * request kick (next spike step) or the ring isn't sampling.
     */
    private void logRelayCandidateFrame(String address, BleProtocol.ParsedFrame frame) {
        if (frame == null || !frame.ok) {
            return;
        }
        int sid = frame.sid;
        boolean relaySid = sid == BleProtocol.SID_RING_ROW_DATA
            || sid == BleProtocol.SID_RING_DATA_RELAY
            || sid == BleProtocol.SID_HEALTH;
        if (relaySid) {
            logLine(String.format(Locale.US,
                "RING-RELAY frame arm=%s sid=0x%02x flag=0x%02x pb=%s",
                armLabel(address), sid, frame.flag, hex(frame.pb)));
            return;
        }
        // Widen the net: an unhandled SID could be an unforeseen relay channel.
        switch (sid) {
            case BleProtocol.SID_APP_LAUNCH:
            case BleProtocol.SID_EVENHUB:
            case BleProtocol.SID_UI_SETTING:
            case BleProtocol.SID_STATE_CHANGE:
            case BleProtocol.SID_ONBOARDING:
            case BleProtocol.SID_EVEN_AI:
            case BleProtocol.SID_NAVIGATION:
                return;
            default:
                logLine(String.format(Locale.US,
                    "unhandled frame arm=%s sid=0x%02x flag=0x%02x pb=%s",
                    armLabel(address), sid, frame.flag, hex(frame.pb)));
        }
    }

    private String armLabel(String address) {
        if (address == null) {
            return "?";
        }
        if (address.equalsIgnoreCase(rightAddress)) {
            return "R";
        }
        if (address.equalsIgnoreCase(leftAddress)) {
            return "L";
        }
        return address;
    }

    private void handleDirectRingNotification(String characteristicUuid, byte[] data, int generation) {
        if (characteristicUuid == null || data == null
                || !isRingNotificationDispatchAllowed(generation)) {
            return;
        }
        String uuid = characteristicUuid.toLowerCase(Locale.US);
        if (!BleProtocol.R1_PHONE_NOTIFY_CHAR_UUID.equals(uuid)
                && !BleProtocol.R1_NOTIFY_CHAR_UUID.equals(uuid)) {
            return;
        }
        FaceclawRingEventDecoder.DirectRingEvent decoded = FaceclawRingEventDecoder.decode(data);
        if (decoded == null) {
            // Not a gesture event. Could be a health/command RESPONSE (bae80013) or
            // a phone-notify status frame (bae80011). Surface it in the in-app log
            // with the frame envelope decoded, so a ring reply is finally visible.
            synchronized (lock) {
                if (!isRingNotificationDispatchAllowed(generation)) {
                    return;
                }
                lastIncomingAtMs = SystemClock.elapsedRealtime();
            }
            if (!isRingNotificationDispatchAllowed(generation)) {
                return;
            }
            logDirectRingLine("direct ring notify " + shortCharUuid(uuid) + " "
                + describeRingFrame(data) + " raw=" + hex(data), generation);
            if (BleProtocol.R1_NOTIFY_CHAR_UUID.equals(uuid)) {
                // Health/command channel: hand the raw frame to the JS decode
                // path (app/health) for reassembly and state.health population.
                queueRingPacketAck(data, generation);
                emitRingHealthFrame(shortCharUuid(uuid), hex(data), generation);
            }
            return;
        }

        G2Event event = decoded.event;
        long arrivalMs = SystemClock.elapsedRealtime();
        synchronized (lock) {
            if (!isRingNotificationDispatchAllowed(generation)) {
                return;
            }
            lastIncomingAtMs = arrivalMs;
            lastConnectionOrInputAtMs = arrivalMs;
        }
        if (!isRingNotificationDispatchAllowed(generation)) {
            return;
        }
        logDirectRingLine("direct ring " + decoded.label + " " + decoded.detail
            + " raw=" + hex(data), generation);
        int frameId = FrameTimings.getInstance().startFrame("input:ring:" + decoded.label);
        FrameTimings.getInstance().log(frameId, "input event decoded from direct ring notification");
        emitDirectRingEvent(event.kind, event.containerName, event.eventType,
            event.eventSource, event.systemExitReasonCode, frameId, generation);
        interruptibleSleep.interrupt();
    }

    private boolean isRingNotificationDispatchAllowed(int generation) {
        return !stopping && running && generation == ringConnectionGeneration;
    }

    private void handleRenderNotification(String address, byte[] data) {
        FaceclawAudioPacketListener listenerToCall;
        long arrivalMs = SystemClock.elapsedRealtime();
        synchronized (lock) {
            lastIncomingAtMs = arrivalMs;
            listenerToCall = audioCaptureActive ? audioPacketListener : null;
        }
        if (listenerToCall == null) {
            return;
        }
        String arm = address.equalsIgnoreCase(leftAddress) ? "L" : address.equalsIgnoreCase(rightAddress) ? "R" : "?";
        try {
            listenerToCall.onAudioPacket(Arrays.copyOf(data, data.length), arm, arrivalMs);
        } catch (Throwable t) {
            logLine("G2 mic packet listener failed: " + safeMessage(t));
        }
    }

    @Override public void onConnectionStateChange(BluetoothGatt gatt, String address, boolean connected,
                                                   GattCallbackRegistry.DispatchLease<BluetoothGatt> lease) {
        lease.dispatchIfCurrent(ignored -> {
            if (isConfiguredRingAddress(address)) {
                int generation;
                synchronized (ringLock) {
                    if (stopping || (connected && !running)) return;
                    generation = updateDirectRingConnectionStateLocked(connected);
                }
                finishDirectRingConnectionStateChange(connected, generation);
            } else {
                onConnectionStateChange(address, connected);
            }
        });
    }

    @Override public void onConnectionStateChange(String address, boolean connected) {
        if (address == null) {
            return;
        }
        if (stopping) {
            return;
        }
        if (isConfiguredRingAddress(address)) {
            int acceptedRingGeneration;
            synchronized (ringLock) {
                if (stopping || (connected && !running)) {
                    return;
                }
                acceptedRingGeneration = updateDirectRingConnectionStateLocked(connected);
            }
            finishDirectRingConnectionStateChange(connected, acceptedRingGeneration);
            return;
        }
        boolean armDisconnected = !connected;
        synchronized (lock) {
            if (address.equalsIgnoreCase(rightAddress)) {
                rightConnected = connected;
            } else if (address.equalsIgnoreCase(leftAddress)) {
                leftConnected = connected;
            } else {
                return;
            }
            if (!connected) {
                glassesConnectionGeneration++;
                sessionReady = false;
                fixedLayoutCreated = false;
                warmedUp = false;
                startupProbePending = false;
                chargingMode = false;
                audioCaptureActive = false;
                audioPacketListener = null;
                clearAllMessagesLocked("connection lost");
                displayedFingerprint = "";
                reconnectAfterMs = SystemClock.elapsedRealtime() + ConnectionOptions.RECONNECT_DELAY_MS;
            }
        }
        if (armDisconnected) {
            synchronized (ringLock) {
                invalidateRingPacketAckStateLocked();
            }
        }
        interruptibleSleep.interrupt();
        ringInterruptibleSleep.interrupt();
        if (!connected) {
            interruptRingOperation();
        }
        if (connected) {
            setStateDisplay("connected", "Connected.");
        } else {
            setStateDisplay("connecting", "Connecting to the glasses...");
        }
    }

    private int updateDirectRingConnectionStateLocked(boolean connected) {
        ringConnected = connected;
        ringNotificationsReady = false;
        if (!connected) {
            ringBattery = -1;
            ringHealthProbeSent = false;
            lastRingHealthPollMs = 0;
            lastRingCurrentHrPollMs = 0;
            invalidateRingPacketAckStateLocked();
            ringReconnectAfterMs = Math.max(ringReconnectAfterMs,
                SystemClock.elapsedRealtime() + ConnectionOptions.RING_RECONNECT_DELAY_MS);
        }
        return ringConnectionGeneration;
    }

    private void finishDirectRingConnectionStateChange(boolean connected, int generation) {
        if (!isRingNotificationDispatchAllowed(generation)) {
            return;
        }
        if (!connected) {
            emitDirectRingBatteryStateSnapshot(generation);
        }
        logDirectRingLine(connected ? "direct ring BLE connected" : "direct ring BLE disconnected", generation);
        if (isRingNotificationDispatchAllowed(generation)) {
            ringInterruptibleSleep.interrupt();
        }
    }

    private void connectLoopOnce() throws InterruptedException {
        setStateDisplay("connecting", "Connecting to the glasses...");
        final long attemptGeneration;
        synchronized (lock) {
            attemptGeneration = ++glassesConnectionGeneration;
            sessionReady = false;
        }
        try {
            connectArm(rightAddress, true);
            connectArm(leftAddress, true);
            if (!sleepDuringConnectSettling(800)) {
                return;
            }
            sendPrelude();

            boolean readyForPublication;
            synchronized (lock) {
                readyForPublication = attemptGeneration == glassesConnectionGeneration
                    && running
                    && !userDisconnectRequested
                    && rightConnected
                    && leftConnected;
                if (!readyForPublication) {
                    sessionReady = false;
                } else {
                    sessionReady = true;
                }
            }
            if (!readyForPublication) {
                handleTransportFailure("connection attempt invalidated");
                return;
            }
            synchronized (lock) {
                // A fresh transport prelude always starts an active EvenHub
                // lifecycle, even if the previous connection dropped while
                // its page was intentionally suspended.
                shutdownRequested = false;
                fixedLayoutCreated = false;
                warmedUp = false;
                clearAllMessagesLocked("session ready");
                displayedFingerprint = "";
                lastAckAtMs = SystemClock.elapsedRealtime();
                lastIncomingAtMs = lastAckAtMs;
                lastConnectionOrInputAtMs = lastAckAtMs;
                lastSessionReadyAtMs = lastAckAtMs;
                lastBatteryRefreshAtMs = 0;
                imageRetryAfterMs = 0;
                lastHeartbeatSentAtMs = 0;
                lastHeartbeatAckedAtMs = 0;
                consecutiveAckTimeouts = 0;
                softResyncStartedAtMs = 0;
                setupAckTimeouts = 0;
                lastConnPriorityAssertAtMs = lastAckAtMs;
                lastAudioControlAckMagic = 0;
                audioCaptureActive = false;
                faceclawWakePendingNonce = -1;
                lastFaceclawWakeLeaseQueuedAtMs = 0;
                lastFaceclawFramebufferLeaseQueuedAtMs = 0;
                enqueueFaceclawFramebufferControlLocked(
                    BleProtocol.FACECLAW_FB_OP_ACQUIRE,
                    true
                );
                if (faceclawWakeLeaseEnabled) {
                    enqueueFaceclawWakeControlLocked(
                        BleProtocol.FACECLAW_WAKE_OP_ACQUIRE,
                        0,
                        true
                    );
                }
            }
            setStateDisplay("connected", "Connected.");
            logLine("session ready");
            ringInterruptibleSleep.interrupt();
            synchronized (lock) {
                // Query settings promptly on the first session so firmware
                // version/capabilities (and battery) arrive without waiting for
                // the input-quiet battery poll. The settings response doubles as
                // the firmware-compatibility check surfaced during onboarding.
                if (!firmwareInfoQueried) {
                    firmwareInfoQueried = true;
                    lastBatteryRefreshAtMs = SystemClock.elapsedRealtime();
                    pendingMessages.addLast(createBatteryQueryMessageLocked());
                    logLine("queue settings query for firmware info");
                }
            }
            tryConnectRing("initial", attemptGeneration);
        } catch (Throwable t) {
            logLine("connect failed: " + safeMessage(t));
            handleTransportFailure("connect failed");
        }
    }

    private boolean sleepDuringConnectSettling(long delayMs) throws InterruptedException {
        long deadline = SystemClock.elapsedRealtime() + delayMs;
        synchronized (lock) {
            while (running && !userDisconnectRequested) {
                long remaining = deadline - SystemClock.elapsedRealtime();
                if (remaining <= 0) {
                    return true;
                }
                lock.wait(Math.min(remaining, 100));
            }
            return false;
        }
    }

    private void connectArm(String address, boolean enableRenderNotify) {
        if (!bleManager.connect(address, ConnectionOptions.CONNECT_TIMEOUT_MS)) {
            throw new IllegalStateException("connect failed: " + address);
        }
        // requestConnectionPriority has no callback in this Android compile target, so there is
        // no reliable completion point to keep it in the global GATT operation pipeline. But it's
        // important enough for performance that we call it anyways.
        bleManager.requestConnectionPriority(address, BluetoothGatt.CONNECTION_PRIORITY_HIGH);

        bleManager.requestMtu(address, ConnectionOptions.DESIRED_MTU, ConnectionOptions.CONNECT_TIMEOUT_MS);

        if (!bleManager.discoverServices(address, ConnectionOptions.SERVICES_TIMEOUT_MS)) {
            throw new IllegalStateException("discoverServices failed: " + address);
        }
        if (!bleManager.enableNotifications(address, BleProtocol.NOTIFY_CHAR_UUID, true, ConnectionOptions.DESCRIPTOR_TIMEOUT_MS)) {
            throw new IllegalStateException("enableNotifications failed: " + address + " " + BleProtocol.NOTIFY_CHAR_UUID);
        }
        if (enableRenderNotify) {
            bleManager.enableNotifications(address, BleProtocol.RENDER_NOTIFY_UUID, true, ConnectionOptions.DESCRIPTOR_TIMEOUT_MS);
        }
        synchronized (lock) {
            if (address.equalsIgnoreCase(rightAddress)) {
                rightConnected = true;
            } else if (address.equalsIgnoreCase(leftAddress)) {
                leftConnected = true;
            }
        }
    }

    private boolean shouldAttemptRingConnect() {
        if (!hasRingAddress() || stopping || !running || !sessionReady) {
            return false;
        }
        long now = SystemClock.elapsedRealtime();
        synchronized (ringLock) {
            if (stopping || ringNotificationsReady || now < ringReconnectAfterMs) {
                return false;
            }
        }
        synchronized (lock) {
            return pendingMessages.isEmpty() && inFlightMessages.isEmpty();
        }
    }

    private void tryConnectRing(String reason) {
        tryConnectRing(reason, -1);
    }

    private void tryConnectRing(String reason, long attemptGeneration) {
        if (!hasRingAddress()) {
            return;
        }
        synchronized (lock) {
            if (!running || userDisconnectRequested || !sessionReady
                    || !rightConnected || !leftConnected
                    || (attemptGeneration >= 0 && attemptGeneration != glassesConnectionGeneration)) {
                return;
            }
        }
        try {
            int generation = connectRing();
            refreshRingBattery(generation);
            // The health poll is driven periodically from the ring loop
            // (maybeReRingHealthPoll) so it re-fires once the ring is worn.
        } catch (Throwable t) {
            handleRingFailure(reason, t);
        }
    }

    private void handleRingFailure(String reason, Throwable failure) {
        if (stopping || !running) {
            return;
        }
        // Close the wedged GATT so the next attempt gets a fresh connectGatt;
        // a cached half-open handle re-fails discoverServices forever.
        try {
            withRingManagerOperation(RING_CONNECT_OPERATION, () -> {
                bleManager.disconnect(ringAddress);
                return null;
            });
        } catch (Throwable ignored) {
        }
        if (stopping || !running) {
            return;
        }
        long backoffMs;
        int attempt;
        synchronized (ringLock) {
            if (stopping || !running) {
                return;
            }
            ringConnected = false;
            ringNotificationsReady = false;
            ringBattery = -1;
            ringHealthProbeSent = false;
            lastRingHealthPollMs = 0;
            lastRingCurrentHrPollMs = 0;
            invalidateRingPacketAckStateLocked();
            ringConsecutiveFailures++;
            attempt = ringConsecutiveFailures;
            backoffMs = attempt >= ConnectionOptions.RING_FAILURE_BREAKER_THRESHOLD
                ? ConnectionOptions.RING_RECONNECT_MAX_DELAY_MS
                : Math.min(
                    (long) ConnectionOptions.RING_RECONNECT_DELAY_MS << Math.min(attempt - 1, 8),
                    ConnectionOptions.RING_RECONNECT_MAX_DELAY_MS);
            ringReconnectAfterMs = SystemClock.elapsedRealtime() + backoffMs;
        }
        synchronized (lock) {
            maybeEmitEvenAppConflictLocked("ring connect failed");
        }
        emitBatteryStateSnapshot();
        logLine("direct ring connect failed (" + reason + ", attempt " + attempt
            + ", next in " + (backoffMs / 1000) + "s): " + safeMessage(failure));
    }

    private int connectRing() {
        if (stopping) {
            throw new IllegalStateException("ring connect cancelled");
        }
        logLine("connecting direct ring " + ringAddress);
        // Ring-specific SHORT timeouts limit retry latency on the optional worker.
        if (!withRingManagerOperation(RING_CONNECT_OPERATION,
                () -> bleManager.connect(ringAddress, ConnectionOptions.RING_CONNECT_TIMEOUT_MS))) {
            throw new IllegalStateException("connect failed: " + ringAddress);
        }

        // Discover services FIRST (the step that fails for an absent ring). Only
        // renegotiate MTU/priority once the ring is confirmed present, so a failed
        // attempt does not churn the arm connection interval on every retry.
        if (!withRingManagerOperation(RING_CONNECT_OPERATION,
                () -> bleManager.discoverServices(ringAddress, ConnectionOptions.RING_SERVICES_TIMEOUT_MS))) {
            throw new IllegalStateException("discoverServices failed: " + ringAddress);
        }

        withRingManagerOperation(RING_CONNECT_OPERATION,
            () -> bleManager.requestConnectionPriority(ringAddress, BluetoothGatt.CONNECTION_PRIORITY_HIGH));
        boolean mtu247Requested = withRingManagerOperation(RING_CONNECT_OPERATION,
            () -> bleManager.requestMtu(
                ringAddress,
                ConnectionOptions.RING_DESIRED_MTU,
                ConnectionOptions.RING_CONNECT_TIMEOUT_MS
            ));

        boolean phoneNotify = enableRingNotification(BleProtocol.R1_PHONE_NOTIFY_CHAR_UUID);
        boolean dataNotify = enableRingNotification(BleProtocol.R1_NOTIFY_CHAR_UUID);
        if (!phoneNotify && !dataNotify) {
            throw new IllegalStateException("no R1 notify characteristic subscribed");
        }

        int generation;
        synchronized (ringLock) {
            if (stopping || !running || !sessionReady) {
                throw new IllegalStateException("ring connect cancelled");
            }
            invalidateRingPacketAckStateLocked();
            generation = ringConnectionGeneration;
            ringConnected = true;
            ringNotificationsReady = true;
            ringReconnectAfterMs = 0;
            ringConsecutiveFailures = 0;
        }
        logLine("direct ring ready mtu247Request=" + (mtu247Requested ? "ok" : "fallback")
            + " phoneNotify=" + phoneNotify + " dataNotify=" + dataNotify
            + " services=" + ringServiceSummary(generation));
        return generation;
    }

    /** Hold the teardown/generation barrier through every direct-R1 manager operation. */
    private <T> T withRingManagerOperation(int generation, RingManagerOperation<T> operation) {
        synchronized (ringLock) {
            if (stopping || !running || !sessionReady
                    || (generation != RING_CONNECT_OPERATION && !isRingOperationAllowedLocked(generation))) {
                throw new IllegalStateException("ring operation cancelled");
            }
            return operation.run();
        }
    }

    /** Best-effort standard BLE battery read; absence is not a ring failure. */
    private void refreshRingBattery(int generation) {
        byte[] value;
        try {
            value = withRingManagerOperation(generation,
                () -> bleManager.readCharacteristic(
                    ringAddress,
                    RING_BATTERY_LEVEL_UUID,
                    RING_BATTERY_READ_TIMEOUT_MS));
        } catch (Throwable t) {
            logLine("direct ring battery unavailable: " + safeMessage(t) + " services=" + ringServiceSummary(generation));
            return;
        }
        if (value == null || value.length < 1) {
            logLine("direct ring battery unavailable services=" + ringServiceSummary(generation));
            return;
        }
        int level = value[0] & 0xff;
        if (level > 100) {
            logLine("direct ring battery value out of range: " + level);
            return;
        }
        synchronized (ringLock) {
            if (!isRingOperationAllowedLocked(generation)) {
                return;
            }
            ringBattery = level;
        }
        emitBatteryStateSnapshot();
        logLine("direct ring battery=" + level + "%");
    }

    private String ringServiceSummary(int generation) {
        try {
            String summary = withRingManagerOperation(generation,
                () -> bleManager.describeServices(ringAddress));
            return summary.isEmpty() ? "<none>" : summary;
        } catch (Throwable t) {
            return "<unavailable:" + safeMessage(t) + ">";
        }
    }

    /**
     * Real ring health-sync session. A 2026-08-19 capture of com.even.sg's own
     * Ring1 protocol (the Even app logs it in plaintext to logcat) proved the ring
     * is NOT auth-walled: the multi-session "the ring ignores Hermes" mystery was
     * BLE CONTENTION — when Hermes and the Even app both hold the ring, every Ring1
     * command times out for both. Isolate the ring to one central and it answers.
     * Full protocol: notes/ring-health-protocol-2026-08-19.md.
     *
     * Sequence (all on bae80012 write / bae80013 notify, MTU 247):
     *   1. pairAuth, payload 0x01  -> ring replies statusAck.ok, session opens
     *      (a plain request->ack; NOT a challenge-response).
     *   2. bare status=req health GETs (module=health, subCmd daily=0x01) -> the
     *      ring streams hourly HR/SpO2/HRV/temp/steps/sleep on bae80013, which
     *      handleDirectRingNotification logs as "direct ring notify bae80013 ...
     *      raw=<hex>".
     *
     * NEEDS EXCLUSIVE ring access: force-stop com.even.sg during a Hermes sync or
     * both contend and time out. Large history uses the implemented packetAck(0x7e)
     * pull loop; a separate HR-only GET refreshes the current-hour value every 15s.
     */
    /**
     * Re-fire the ring health poll every RING_HEALTH_POLL_INTERVAL_MS while the
     * ring is connected, so worn hourly HR/SpO2/HRV/activity/sleep arrive on the
     * next poll (a one-shot poll misses everything because the ring auto-connects
     * off-head). Runs only on FaceclawRingLink.
     */
    private void maybeReRingHealthPoll() {
        if (!RING_HEALTH_PROBE_ENABLED) {
            return;
        }
        long now = SystemClock.elapsedRealtime();
        int generation;
        synchronized (ringLock) {
            generation = ringConnectionGeneration;
            if (!isRingOperationAllowedLocked(generation)
                    || now - lastRingHealthPollMs < RING_HEALTH_POLL_INTERVAL_MS) {
                return;
            }
            lastRingHealthPollMs = now;
            lastRingCurrentHrPollMs = now;
        }
        probeRingHealth(generation);
    }

    /** Lightweight current-hour HR refresh; full metrics remain on the 60s poll. */
    private void maybeReRingCurrentHrPoll() {
        if (!RING_HEALTH_PROBE_ENABLED) {
            return;
        }
        long now = SystemClock.elapsedRealtime();
        int generation;
        synchronized (ringLock) {
            generation = ringConnectionGeneration;
            if (!isRingOperationAllowedLocked(generation)
                    || !ringHealthProbeSent
                    || now - lastRingCurrentHrPollMs < RING_CURRENT_HR_POLL_INTERVAL_MS) {
                return;
            }
            lastRingCurrentHrPollMs = now;
        }
        sendRingCommandForGeneration(generation,
            "heartRate/current-hour GET", 0x02, 0x01, 0x01, 0x00, null);
    }

    private void probeRingHealth(int generation) {
        if (!RING_HEALTH_PROBE_ENABLED) {
            return;
        }
        boolean openSession;
        synchronized (ringLock) {
            if (!isRingOperationAllowedLocked(generation)) {
                return;
            }
            openSession = !ringHealthProbeSent;
            ringHealthProbeSent = true;
            if (openSession) {
                ringWriteSeq = 1; // fresh serialId per connection, like the app
            }
        }
        if (openSession) {
            logLine("ring health session open — pairAuth + enable; NEEDS exclusive ring (stop com.even.sg). watch bae80013");
            // pairAuth: verbatim golden frame (CRC-32 verified) opens the command session.
            if (!sendRawRingFrameForGeneration(generation, "pairAuth (session open)",
                    hexToBytes("00971953f964016401000000080d003f0101"))) return;
            if (!ringProbeGap(generation) || !ringProbeGap(generation)) return;
            // Safe read-only metadata request. The deviceInfo ack's first
            // NUL-padded 16-byte ASCII field is the ring firmware version.
            if (!sendRingCommandForGeneration(generation,
                    "deviceInfo GET (firmware version)", 0x01, 0x00, 0x02, 0x00, null)) return;
            if (!ringProbeGap(generation)) return;
            // Enable health tracking + the live "point" push stream so the ring
            // records hourly data and streams current HR when worn. subCmd 0x0e
            // (healthSettings) is not blocklisted; payload = epoch secs u32 LE at
            // [0..3], enable=0x01 at [4], zeros after.
            long epoch = System.currentTimeMillis() / 1000L;
            byte[] enable = new byte[24];
            enable[0] = (byte) (epoch & 0xff);
            enable[1] = (byte) ((epoch >> 8) & 0xff);
            enable[2] = (byte) ((epoch >> 16) & 0xff);
            enable[3] = (byte) ((epoch >> 24) & 0xff);
            enable[4] = 0x01;
            if (!sendRingCommandForGeneration(generation,
                    "healthEnable SET", 0x01, 0x00, 0x0e, 0x01, enable)) return;
            if (!ringProbeGap(generation)) return;
        }
        // Health data GETs (re-fired every poll): module=health(2), subCmd=daily(1),
        // status=req, no payload. cmd: heartRate=1 spo2=2 hrv=4 activity=5 sleep=6.
        // Temperature (cmd 3) is RESERVED - the ring skips it - so it is not requested.
        if (!sendRingCommandForGeneration(generation,
                "heartRate/daily GET", 0x02, 0x01, 0x01, 0x00, null)) return;
        if (!ringProbeGap(generation)) return;
        if (!sendRingCommandForGeneration(generation,
                "spo2/daily GET", 0x02, 0x02, 0x01, 0x00, null)) return;
        if (!ringProbeGap(generation)) return;
        if (!sendRingCommandForGeneration(generation,
                "hrv/daily GET", 0x02, 0x04, 0x01, 0x00, null)) return;
        if (!ringProbeGap(generation)) return;
        if (!sendRingCommandForGeneration(generation,
                "activity/daily GET", 0x02, 0x05, 0x01, 0x00, null)) return;
        if (!ringProbeGap(generation)) return;
        if (!sendRingCommandForGeneration(generation,
                "sleep/daily GET", 0x02, 0x06, 0x01, 0x00, null)) return;
        if (!ringProbeGap(generation)) return;
        // deviceStatus GET: module=system(1), cmd=system(0), subCmd=deviceStatus(1).
        // The status=3 response carries the ring battery percent in data[0].
        if (!sendRingCommandForGeneration(generation,
                "deviceStatus GET (battery)", 0x01, 0x00, 0x01, 0x00, null)) return;
        logLine("ring health poll SENT — watch bae80013 for decoded FRAME replies (raw= hex)");
    }

    /** ~200ms spacing between probe frames so the ring can answer each in turn. */
    private boolean ringProbeGap(int generation) {
        if (!ringInterruptibleSleep.sleep(200)) {
            return false;
        }
        synchronized (ringLock) {
            return isRingOperationAllowedLocked(generation);
        }
    }

    /**
     * Queue the cursor acknowledgement required to pull the ring's next rich
     * health batch. Captured payload layout is
     * [module][cmd][subCmd][0][incoming serial u16 LE][0,0,0,0].
     */
    private void queueRingPacketAck(byte[] frame, int generation) {
        if (frame == null || frame.length < 17 || (frame[0] & 0xff) != 0x00) return;
        int innerLen = (frame[13] & 0xff) | ((frame[14] & 0xff) << 8);
        if (innerLen < 12 || frame.length != 5 + innerLen) return;
        int storedCrc = (frame[1] & 0xff) | ((frame[2] & 0xff) << 8)
            | ((frame[3] & 0xff) << 16) | ((frame[4] & 0xff) << 24);
        if (storedCrc != ringCrc32(frame, 5, innerLen)) return;
        if ((frame[6] & 0xff) != 0x02 || (frame[10] & 0xff) != 0x02) return;

        byte[] payload = new byte[10];
        payload[0] = frame[6];
        payload[1] = frame[11];
        payload[2] = frame[12];
        payload[4] = frame[8];
        payload[5] = frame[9];
        synchronized (ringLock) {
            if (!isRingOperationAllowedLocked(generation)) return;
            if (ringPacketAckQueue.size() >= 16) ringPacketAckQueue.removeFirst();
            ringPacketAckQueue.addLast(new RingPacketAckCursor(payload, generation));
        }
        ringInterruptibleSleep.interrupt();
    }

    /** Ring-worker drain for queued read-only packet cursors. */
    private void drainRingPacketAcks() {
        while (true) {
            RingPacketAckCursor cursor;
            synchronized (ringLock) {
                if (!running || !sessionReady || !ringConnected || !ringNotificationsReady) {
                    ringPacketAckQueue.clear();
                    return;
                }
                cursor = ringPacketAckQueue.pollFirst();
            }
            if (cursor == null) return;
            sendRingPacketAck(cursor);
        }
    }

    /** Final lifecycle gate is held through the packetAck BLE side effect. */
    private void sendRingPacketAck(RingPacketAckCursor cursor) {
        synchronized (ringLock) {
            if (!isRingOperationAllowedLocked(cursor.generation)) return;
            sendRingCommand("packetAck", 0x01, 0x00, 0x7e, 0x01, cursor.payload);
        }
    }

    private boolean isRingOperationAllowedLocked(int generation) {
        return !stopping
            && running
            && sessionReady
            && ringConnected
            && ringNotificationsReady
            && generation == ringConnectionGeneration;
    }

    private boolean sendRingCommandForGeneration(
            int generation,
            String label,
            int module,
            int cmd,
            int subCmd,
            int status,
            byte[] payload
    ) {
        synchronized (ringLock) {
            if (!isRingOperationAllowedLocked(generation)) {
                return false;
            }
            sendRingCommand(label, module, cmd, subCmd, status, payload);
            return true;
        }
    }

    private boolean sendRawRingFrameForGeneration(int generation, String label, byte[] frame) {
        synchronized (ringLock) {
            if (!isRingOperationAllowedLocked(generation)) {
                return false;
            }
            sendRawRingFrame(label, frame);
            return true;
        }
    }

    /** Build and write one R1 binary command frame to the ring's write channel. */
    /** Send a ring command frame built to the verified BleRing1Model layout. */
    private void sendRingCommand(String label, int module, int cmd, int subCmd, int status, byte[] payload) {
        byte[] frame = buildRingFrame(module, cmd, subCmd, status, payload);
        if (frame == null) {
            logLine("direct ring " + label + " REFUSED (blocklisted subCmd; would risk pairing/host state)");
            return;
        }
        sendRawRingFrame(label, frame);
    }

    /**
     * Write an exact, pre-built ring frame verbatim (used to replay captured frames).
     * Raw replays are still subject to the same command blocklist as built frames;
     * otherwise a captured pairing/firmware command could bypass buildRingFrame().
     */
    private void sendRawRingFrame(String label, byte[] frame) {
        synchronized (ringLock) {
            if (stopping || !running || !sessionReady || !ringConnected || !ringNotificationsReady) {
                return;
            }
            String refusalReason = rawRingFrameRefusalReason(frame);
            if (refusalReason != null) {
                logLine("direct ring " + label + " REFUSED (" + refusalReason + ")");
                return;
            }
            try {
                boolean ok = withRingManagerOperation(ringConnectionGeneration,
                    () -> bleManager.writeFrames(
                        ringAddress,
                        BleProtocol.R1_WRITE_CHAR_UUID,
                        Collections.singletonList(frame),
                        ConnectionOptions.WRITE_TYPE,
                        ConnectionOptions.WRITE_TIMEOUT_MS
                    ));
                logLine("direct ring " + label + " write " + (ok ? "ok" : "failed") + " raw=" + hex(frame));
            } catch (Throwable t) {
                logLine("direct ring " + label + " write error: " + safeMessage(t));
            }
        }
    }

    // subCmds (under module=system, cmd=system) that mutate pairing/host/firmware
    // state and must NEVER be emitted by the health path: otaStart(0x09),
    // advStart(0x0a, carries the host MAC — the one real ring<->glasses rebind
    // risk), setAlgoKey(0x0c), nvRecover(0x11), powerControl(0x12), pairDelete(0x13).
    private static boolean isBlocklistedRingSubCmd(int module, int cmd, int subCmd) {
        if (module == 0x01 && cmd == 0x00) {
            switch (subCmd) {
                case 0x09: case 0x0a: case 0x0c: case 0x11: case 0x12: case 0x13:
                    return true;
                default:
                    return false;
            }
        }
        return false;
    }

    /**
     * Fail closed at the raw-write boundary. Only a complete, canonical,
     * CRC-valid single-fragment FRAME may reach bae80012, and state-mutating
     * system commands remain blocklisted even when supplied as captured bytes.
     */
    private static String rawRingFrameRefusalReason(byte[] frame) {
        if (frame == null || frame.length < 17) {
            return "malformed frame";
        }
        if ((frame[0] & 0xff) != 0x00 || (frame[5] & 0xff) != 0x64
            || (frame[7] & 0xff) != 0x64) {
            return "non-canonical frame envelope";
        }
        int innerLen = (frame[13] & 0xff) | ((frame[14] & 0xff) << 8);
        if (innerLen < 12 || frame.length != 5 + innerLen) {
            return "invalid inner length";
        }
        int storedCrc = (frame[1] & 0xff) | ((frame[2] & 0xff) << 8)
            | ((frame[3] & 0xff) << 16) | ((frame[4] & 0xff) << 24);
        if (storedCrc != ringCrc32(frame, 5, innerLen)) {
            return "invalid transport CRC";
        }
        int module = frame[6] & 0xff;
        int cmd = frame[11] & 0xff;
        int subCmd = frame[12] & 0xff;
        if (isBlocklistedRingSubCmd(module, cmd, subCmd)) {
            return "blocklisted module/cmd/subCmd";
        }
        return null;
    }

    /**
     * Build one R1 command frame to the layout recovered from com.even.sg's
     * BleRing1Model.toBytes (verified: rebuilding captured frames reproduces them
     * byte-for-byte): [0]=0x00, [1..4]=CRC-32 (poly 0x1EDC6F41, MSB-first, init 0,
     * no xorout) stored little-endian over the inner frame, then the 12-byte inner
     * header — version 0x64, module (1=system 2=health 3=sport), moduleVersion
     * 0x64, serialId u16 LE, status (0=req 1=set 2=push 3=ack), cmd, subCmd,
     * length u16 LE (=12+len(data)), crc16 u16 LE (CRC-16/CCITT-FALSE) — then data.
     * Returns null if (module,cmd,subCmd) is blocklisted.
     */
    private byte[] buildRingFrame(int module, int cmd, int subCmd, int status, byte[] payload) {
        if (isBlocklistedRingSubCmd(module, cmd, subCmd)) {
            return null;
        }
        byte[] data = payload != null ? payload : new byte[0];
        int innerLen = 12 + data.length;
        int serial;
        synchronized (ringLock) {
            serial = ringWriteSeq & 0xffff;
            ringWriteSeq = (ringWriteSeq + 1) & 0xffff;
        }
        byte[] inner = new byte[innerLen];
        inner[0] = 0x64;                          // version
        inner[1] = (byte) (module & 0xff);        // 1=system 2=health 3=sport
        inner[2] = 0x64;                          // moduleVersion
        inner[3] = (byte) (serial & 0xff);        // serialId u16 LE
        inner[4] = (byte) ((serial >>> 8) & 0xff);
        inner[5] = (byte) (status & 0xff);        // 0=req 1=set 2=push 3=ack
        inner[6] = (byte) (cmd & 0xff);
        inner[7] = (byte) (subCmd & 0xff);
        inner[8] = (byte) (innerLen & 0xff);      // length u16 LE = 12 + data
        inner[9] = (byte) ((innerLen >>> 8) & 0xff);
        inner[10] = 0;                            // crc16 zeroed for its own computation
        inner[11] = 0;
        System.arraycopy(data, 0, inner, 12, data.length);
        int crc16 = ringCrc16(inner, 0, innerLen);
        inner[10] = (byte) (crc16 & 0xff);
        inner[11] = (byte) ((crc16 >>> 8) & 0xff);
        int crc32 = ringCrc32(inner, 0, innerLen);
        byte[] frame = new byte[5 + innerLen];
        frame[0] = 0x00;
        frame[1] = (byte) (crc32 & 0xff);         // CRC-32 stored little-endian
        frame[2] = (byte) ((crc32 >>> 8) & 0xff);
        frame[3] = (byte) ((crc32 >>> 16) & 0xff);
        frame[4] = (byte) ((crc32 >>> 24) & 0xff);
        System.arraycopy(inner, 0, frame, 5, innerLen);
        return frame;
    }

    // CRC-32, poly 0x1EDC6F41 (Castagnoli), MSB-first, init 0, no xorout — the
    // transport checksum at frame[1..4]. The old builder filled this with random
    // bytes, so the ring silently dropped every Hermes write. Table built once.
    private static final int[] RING_CRC32_TABLE = buildRingCrc32Table();
    private static int[] buildRingCrc32Table() {
        int[] t = new int[256];
        for (int i = 0; i < 256; i++) {
            int c = i << 24;
            for (int k = 0; k < 8; k++) {
                c = ((c & 0x80000000) != 0) ? ((c << 1) ^ 0x1EDC6F41) : (c << 1);
            }
            t[i] = c;
        }
        return t;
    }
    private static int ringCrc32(byte[] data, int off, int len) {
        int c = 0;
        for (int i = off; i < off + len; i++) {
            c = (c << 8) ^ RING_CRC32_TABLE[((c >>> 24) ^ (data[i] & 0xff)) & 0xff];
        }
        return c;
    }

    // CRC-16/CCITT-FALSE variant (Nordic crc16_compute) transcribed from the app,
    // for the crc16 field at inner[10..11]. The ring appears not to validate it
    // (captured values don't match this algorithm), but we compute it faithfully.
    private static int ringCrc16(byte[] data, int off, int len) {
        int c = 0xFFFF;
        for (int i = off; i < off + len; i++) {
            c = ((c >>> 8) & 0xff) | ((c << 8) & 0xff00);
            c ^= (data[i] & 0xff);
            c ^= (c & 0xff) >>> 4;
            c ^= (c << 12) & 0xffff;
            c ^= ((c & 0xff) << 5) & 0xffff;
        }
        return c & 0xffff;
    }

    private static byte[] hexToBytes(String hex) {
        int n = hex.length() / 2;
        byte[] out = new byte[n];
        for (int i = 0; i < n; i++) {
            out[i] = (byte) Integer.parseInt(hex.substring(i * 2, i * 2 + 2), 16);
        }
        return out;
    }

    /** Just the discriminating nibble of a bae8001x characteristic UUID, for logs. */
    private static String shortCharUuid(String uuid) {
        if (uuid == null) {
            return "?";
        }
        if (uuid.startsWith("bae8001")) {
            return "bae8001" + uuid.charAt(7);
        }
        return uuid;
    }

    /** Decode a ring frame envelope (module/cmd/subCmd/status/serial/len + CRC-32 check). */
    private static String describeRingFrame(byte[] f) {
        if (f == null || f.length < 17 || (f[0] & 0xff) != 0x00
            || (f[5] & 0xff) != 0x64 || (f[7] & 0xff) != 0x64) {
            return "short/opaque(" + (f == null ? 0 : f.length) + "B)";
        }
        int module = f[6] & 0xff;
        int serial = (f[8] & 0xff) | ((f[9] & 0xff) << 8);
        int status = f[10] & 0xff;
        int cmd = f[11] & 0xff;
        int subCmd = f[12] & 0xff;
        int len = (f[13] & 0xff) | ((f[14] & 0xff) << 8);
        int innerLen = f.length - 5;
        int stored = (f[1] & 0xff) | ((f[2] & 0xff) << 8) | ((f[3] & 0xff) << 16) | ((f[4] & 0xff) << 24);
        boolean crcOk = stored == ringCrc32(f, 5, innerLen);
        return "FRAME module=" + module + " cmd=0x" + Integer.toHexString(cmd)
            + " sub=0x" + Integer.toHexString(subCmd) + " status=" + status
            + " serial=" + serial + " len=" + len + " crc32=" + (crcOk ? "OK" : "BAD");
    }

    private boolean enableRingNotification(String characteristicUuid) {
        try {
            return withRingManagerOperation(RING_CONNECT_OPERATION,
                () -> bleManager.enableNotifications(
                    ringAddress,
                    characteristicUuid,
                    true,
                    ConnectionOptions.DESCRIPTOR_TIMEOUT_MS
                ));
        } catch (Throwable t) {
            Log.d(TAG, "direct ring notify subscribe skipped: " + characteristicUuid + " " + safeMessage(t));
            return false;
        }
    }

    private void sendPrelude() throws InterruptedException {
        sendPrelude(false);
    }

    private void sendPrelude(boolean preserveWakeLeaseControls) throws InterruptedException {
        synchronized (lock) {
            if (preserveWakeLeaseControls) {
                clearAllMessagesPreservingWakeLeaseLocked("prelude");
            } else {
                clearAllMessagesLocked("prelude");
            }
        }
        long now = SystemClock.elapsedRealtime();
        OutboundMessage prelude = messageBuilder.prelude();
        prelude.onAck = () -> {
        };
        prelude.onTimeout = () -> {
            logLine("prelude ack timeout");
        };
        prelude.sentAtMs = now;
        writeMessage(prelude);

        long deadline = SystemClock.elapsedRealtime() + ConnectionOptions.PRELUDE_TIMEOUT_MS;
        while (running && !userDisconnectRequested && !inFlightMessages.isEmpty()) {
            synchronized (lock) {
                if (!running || userDisconnectRequested || inFlightMessages.isEmpty()) {
                    break;
                }
            }
            long remaining = deadline - SystemClock.elapsedRealtime();
            if (remaining <= 0) {
                break;
            }
            interruptibleSleep.sleep(Math.min(remaining, 100));
        }
        synchronized (lock) {
            if (!inFlightMessages.isEmpty()) {
                clearInFlightMessagesLocked("prelude timeout");
                throw new IllegalStateException("prelude ack timeout");
            }
        }
    }

    private long driveSession() {
        //Log.d(TAG, "driveSession called (pendingMessages.size=" + pendingMessages.size() + " inFlightMessages.size=" + inFlightMessages.size() + ")");
        while (true) {
            OutboundMessage messageToWrite = null;
            OutboundMessage messageToPrewrite = null;
            long now = SystemClock.elapsedRealtime();

            maybeFinishNoChangeDesiredFrame();

            synchronized (lock) {
                if (sessionReady
                        && now - lastFaceclawFramebufferLeaseQueuedAtMs >= FACECLAW_WAKE_LEASE_RENEW_MS
                        && !hasPendingOrInflightKindLocked("framebuffer-lease-control")) {
                    enqueueFaceclawFramebufferControlLocked(
                        BleProtocol.FACECLAW_FB_OP_ACQUIRE,
                        false
                    );
                }
                if (faceclawWakeLeaseEnabled
                        && sessionReady
                        && now - lastFaceclawWakeLeaseQueuedAtMs >= FACECLAW_WAKE_LEASE_RENEW_MS
                        && !hasPendingOrInflightKindLocked("wake-lease-control")) {
                    enqueueFaceclawWakeControlLocked(
                        BleProtocol.FACECLAW_WAKE_OP_ACQUIRE,
                        0,
                        false
                    );
                }
                if (!inFlightMessages.isEmpty()) {
                    OutboundMessage oldest = inFlightMessages.peekFirst();
                    if (oldest != null && oldest.ackDeadlineAtMs <= now) {
                        Log.i(TAG, "message timed out: " + oldest.label);
                        inFlightMessages.removeFirst();
                        logLine("message timed out: " + oldest.label);
                        magicPool.release(oldest.sid, oldest.magic, oldest.label, "timeout");
                        handleAckTimeoutLocked(oldest);
                        return 0;
                    }
                    if (connectionOptions.WINDOW_SIZE <= 1
                            && sessionReady
                            && prewrittenMessage == null
                            && !pendingMessages.isEmpty()
                            && canPrewriteCandidate(pendingMessages.peekFirst())
                            && !shouldBlockPrewriteForHeartbeatLocked(now)) {
                        // Only the serial (window==1) path pre-sends the all-but-last
                        // packet; with a real window we just send the next message fully.
                        messageToPrewrite = pendingMessages.peekFirst();
                    }
                }

                if (chargingMode) {
                    // Glasses are in the case: no display traffic, only battery
                    // polls (which also detect the end of charging).
                    finishDesiredFrameLocked("discarded: glasses charging");
                    if (sessionReady && inFlightMessages.isEmpty() && !pendingMessages.isEmpty()) {
                        messageToWrite = pendingMessages.removeFirst();
                        Log.i(TAG, "sending pending message (charging): " + messageToWrite.label);
                    } else if (sessionReady && pendingMessages.isEmpty() && inFlightMessages.isEmpty()
                            && now - lastBatteryRefreshAtMs >= ConnectionOptions.CHARGING_BATTERY_POLL_MS) {
                        Log.i(TAG, "Writing charging-mode battery poll");
                        messageToWrite = createBatteryQueryMessageLocked();
                        lastBatteryRefreshAtMs = now;
                    } else {
                        return 1_000;
                    }
                } else {
                    if (messageToPrewrite == null
                            && !shutdownRequested
                            && !fixedLayoutCreated
                            && pendingMessages.isEmpty()
                            && inFlightMessages.isEmpty()) {
                        Log.i(TAG, "enqueueing create layout");
                        enqueueCreateLayoutLocked();
                    } else if (messageToPrewrite != null) {
                        // Prewrite outside the lock; the logical message remains pending until
                        // its final BLE frame is sent after the current protocol ACK.
                    }
                    if (messageToPrewrite == null && !shutdownRequested && fixedLayoutCreated && !warmedUp && pendingMessages.isEmpty() && inFlightMessages.isEmpty()) {
                        Log.i(TAG, "enqueueing warmup");
                        enqueueWarmupLocked();
                    }

                    if (messageToPrewrite == null && !shutdownRequested && fixedLayoutCreated && warmedUp
                            && (firmwareDebugFlagsEnabled ? 2 : 1) != firmwareDebugFlagsLastSent
                            && pendingMessages.isEmpty() && inFlightMessages.isEmpty()) {
                        Log.i(TAG, "enqueueing firmware debug flags " + (firmwareDebugFlagsEnabled ? "show" : "hide"));
                        enqueueFirmwareDebugFlagsLocked();
                    }

                    if (messageToPrewrite == null && !shutdownRequested && fixedLayoutCreated && warmedUp
                            && (compassEnabled ? 1 : 0) != compassControlLastSent
                            && pendingMessages.isEmpty() && inFlightMessages.isEmpty()) {
                        Log.i(TAG, "enqueueing compass " + (compassEnabled ? "enable" : "disable"));
                        enqueueCompassControlLocked(false, compassEnabled);
                    }

                    // Up to WINDOW_SIZE messages may be in flight at once (full
                    // pipelining); a slot frees when an ack arrives.
                    boolean windowHasRoom = inFlightMessages.size()
                            < (softResyncStartedAtMs != 0 ? 1 : Math.max(1, connectionOptions.WINDOW_SIZE));
                    // A frame ready to send right now: don't inject a fresh
                    // heartbeat in front of it (the image's own ack resets the
                    // firmware heartbeat timer, so the heartbeat is redundant).
                    boolean imageWaiting = !shutdownRequested && fixedLayoutCreated && warmedUp
                            && !hasPendingOrInflightKindLocked("heartbeat")
                            && now >= imageRetryAfterMs
                            && !getDesiredFingerprint().equals(lastEnqueuedFingerprint);
                    if (messageToPrewrite == null && handleHeartbeat(imageWaiting)) {
                        return ConnectionOptions.IDLE_SLEEP_MS;
                    }

                    if (messageToPrewrite == null && sessionReady && windowHasRoom && !pendingMessages.isEmpty()) {
                        messageToWrite = pendingMessages.removeFirst();
                        Log.i(TAG, "sending pending message: " + messageToWrite.label);
                    } else if (messageToPrewrite == null && !shutdownRequested && fixedLayoutCreated && warmedUp
                            && windowHasRoom && !hasPendingImageLocked()
                            && now >= imageRetryAfterMs
                            && !getDesiredFingerprint().equals(lastEnqueuedFingerprint)) {
                        // Enqueue the next frame's delta against lastEnqueuedPacked
                        // (what the shadow will be), so it can pipeline behind an
                        // image still awaiting its ack.
                        Log.i(TAG, "Enqueued image update");
                        if (now - lastConnPriorityAssertAtMs >= ConnectionOptions.CONNECTION_PRIORITY_REASSERT_MS) {
                            lastConnPriorityAssertAtMs = now;
                            try {
                                bleManager.requestConnectionPriority(rightAddress, BluetoothGatt.CONNECTION_PRIORITY_HIGH);
                                bleManager.requestConnectionPriority(leftAddress, BluetoothGatt.CONNECTION_PRIORITY_HIGH);
                            } catch (Throwable t) {
                                logLine("connection priority re-assert failed: " + safeMessage(t));
                            }
                        }
                        enqueueDesiredImageLocked();
                        return 0;
                    } else if (messageToPrewrite == null && shouldPollBatteryLocked(now)) {
                        Log.i(TAG, "Writing battery query");
                        messageToWrite = createBatteryQueryMessageLocked();
                        lastBatteryRefreshAtMs = now;
                    } else if (messageToPrewrite == null && (!pendingMessages.isEmpty() || !inFlightMessages.isEmpty())) {
                        return ConnectionOptions.IDLE_SLEEP_MS;
                    } else if (messageToPrewrite == null) {
                        return 250;
                    }
                }
            }

            if (messageToPrewrite != null) {
                if (prewriteMessage(messageToPrewrite)) {
                    return 0;
                }
                return ConnectionOptions.IDLE_SLEEP_MS;
            }

            if (!writeMessage(messageToWrite)) {
                synchronized (lock) {
                    if (removePreparedMessageLocked(messageToWrite) || messageToWrite.magic == 0) {
                        handleTransportFailure("write failed");
                    }
                }
                return 0;
            }
        }
    }

    /**
     * If the desired image already matches what the glasses display, nothing will
     * ever be enqueued for it, so finish its frame now (otherwise the TS side
     * would block on it until its backpressure timeout).
     */
    private void maybeFinishNoChangeDesiredFrame() {
        int frameIdToFinish = 0;
        synchronized (lock) {
            synchronized (desiredTilesLock) {
                if (desiredFrameId != 0 && !lastEnqueuedFingerprint.isEmpty() && desiredFingerprint.equals(lastEnqueuedFingerprint)) {
                    frameIdToFinish = desiredFrameId;
                    desiredFrameId = 0;
                }
            }
        }
        if (frameIdToFinish != 0) {
            finishFrame(frameIdToFinish, "discarded: no change from displayed image");
        }
    }

    private boolean shouldBlockPrewriteForHeartbeatLocked(long now) {
        if (shutdownRequested || !warmedUp || !fixedLayoutCreated) {
            return false;
        }
        return hasPendingOrInflightKindLocked("heartbeat")
                || now - lastHeartbeatAckedAtMs >= ConnectionOptions.HEARTBEAT_READY_MS;
    }

    private boolean canPrewriteCandidate(OutboundMessage message) {
        if (message == null || !message.isLeftArmMessage) {
            return false;
        }
        if (!"image".equals(message.kind) && !"warmup".equals(message.kind)) {
            return false;
        }
        return message.message.length + 2 > 232;
    }

    private boolean handleHeartbeat(boolean imageWaiting) {
        long now = SystemClock.elapsedRealtime();
        boolean heartbeatEligible = !shutdownRequested && warmedUp && fixedLayoutCreated;
        boolean heartbeatPending = heartbeatEligible && hasPendingOrInflightKindLocked("heartbeat");
        long heartbeatElapsedMs = now - lastHeartbeatAckedAtMs;
        boolean heartbeatReady = heartbeatEligible && heartbeatElapsedMs >= ConnectionOptions.HEARTBEAT_READY_MS;
        boolean heartbeatUrgent = heartbeatEligible && heartbeatElapsedMs >= ConnectionOptions.HEARTBEAT_URGENT_MS;
        boolean heartbeatBlocksLeftWrites = heartbeatReady || heartbeatPending;

        if (heartbeatReady && !heartbeatPending && inFlightMessages.isEmpty()) {
            if (imageWaiting && !heartbeatUrgent) {
                // Defer to the waiting frame: sending it now satisfies the
                // firmware heartbeat deadline (its ack resets the timer), and
                // the heartbeat still fires once we reach the URGENT threshold
                // if rendering goes quiet again. Preserves the pending-heartbeat
                // inter-lens-sync invariant below (that path is untouched).
                return false;
            }
            Log.i(TAG, "Writing heartbeat");
            OutboundMessage heartbeatMessage = createHeartbeatMessage();
            lastHeartbeatSentAtMs = now;
            writeMessage(heartbeatMessage);
            return true;
        } else if (heartbeatUrgent) {
            return true;
        } else if (heartbeatPending) {
            // Don't send other message types while a heartbeat is pending because that
            // can lead to inter-lens sync issues
            return true;
        }

        return false;
    }

    private OutboundMessage createHeartbeatMessage() {
        OutboundMessage message = messageBuilder.heartbeat();
        message.onAck = () -> {
            synchronized (lock) {
                lastHeartbeatAckedAtMs = SystemClock.elapsedRealtime();
                softResyncStartedAtMs = 0;
            }
        };
        message.onTimeout = () -> {
            // If a heartbeat fails to ack and we're over the heartbeat deadline, assume the connection is failed and reconnect.
            // Otherwise ignore it, which will cause a retransmission attempt.
            boolean isPastDeadline;
            synchronized (lock) {
                isPastDeadline = SystemClock.elapsedRealtime() - lastHeartbeatSentAtMs >= ConnectionOptions.HEARTBEAT_FAILURE_DEADLINE_MS;
            }
            if (isPastDeadline) {
                handleTransportFailure("heartbeat ack timeout");
            }
        };
        return message;
    }


    private boolean writeMessage(OutboundMessage message) {
        long now = SystemClock.elapsedRealtime();
        message.writeStartedAtMs = now;
        message.sentAtMs = now;
        message.ackDeadlineAtMs = now + message.ackTimeoutMs + ConnectionOptions.WRITE_TIMEOUT_MS;
        if (message.magic != 0) {
            synchronized (lock) {
                inFlightMessages.addLast(message);
            }
        }
        if (message.imageUpdateId > 0 && message.imageMessageNumber == 1) {
            synchronized(lock) {
                BleImageOptimizer.ImageUpdateStats stats = imageUpdateStats.get(message.imageUpdateId);
                if (stats != null && stats.firstWriteStartedAtMs <= 0) {
                    stats.firstWriteStartedAtMs = now;
                }
            }
        }

        String writeAddress = message.isLeftArmMessage ? leftAddress : rightAddress;
        List<byte[]> frames;
        if (prewrittenMessage != null && prewrittenMessage != message) {
            if (!spoilPrewrittenMessage("before " + message.label)) {
                return false;
            }
        }
        if (prewrittenMessage == message) {
            frames = Collections.singletonList(prewrittenFrames.get(prewrittenFrames.size() - 1));
            prewrittenMessage = null;
            prewrittenFrames = Collections.emptyList();
        } else {
            frames = BleProtocol.framePb(
                message.message,
                message.sid,
                message.flag,
                nextTransportSeq++
            );
        }
        boolean result = bleManager.writeFrames(
            writeAddress,
            BleProtocol.WRITE_CHAR_UUID,
            frames,
            ConnectionOptions.WRITE_TYPE,
            ConnectionOptions.WRITE_TIMEOUT_MS
        );

        synchronized (lock) {
            long sentAtMs = SystemClock.elapsedRealtime();
            message.sentAtMs = sentAtMs;
            message.ackDeadlineAtMs = sentAtMs + message.ackTimeoutMs;
            logImageUpdateSendLandmarkLocked(message);
            if (result && message.onSent != null) {
                message.onSent.run();
                lock.notifyAll();
            }
        }

        return result;
    }

    private boolean prewriteMessage(OutboundMessage message) {
        if (prewrittenMessage == message) {
            return true;
        }
        if (prewrittenMessage != null && !spoilPrewrittenMessage("before prewrite " + message.label)) {
            return false;
        }
        if (!canPrewriteCandidate(message)) {
            return false;
        }

        List<byte[]> frames = BleProtocol.framePb(
            message.message,
            message.sid,
            message.flag,
            nextTransportSeq++
        );
        if (frames.size() <= 1) {
            return false;
        }

        String writeAddress = message.isLeftArmMessage ? leftAddress : rightAddress;
        List<byte[]> prefixFrames = frames.subList(0, frames.size() - 1);
        boolean result = bleManager.writeFrames(
            writeAddress,
            BleProtocol.WRITE_CHAR_UUID,
            prefixFrames,
            ConnectionOptions.WRITE_TYPE,
            ConnectionOptions.WRITE_TIMEOUT_MS
        );
        if (!result) {
            return false;
        }

        prewrittenMessage = message;
        prewrittenFrames = new ArrayList<>(frames);
        logLine("prewrote " + message.label + " frames=" + prefixFrames.size() + "/" + frames.size());
        return true;
    }

    private boolean spoilPrewrittenMessage(String reason) {
        if (prewrittenMessage == null || prewrittenFrames.isEmpty()) {
            prewrittenMessage = null;
            prewrittenFrames = Collections.emptyList();
            return true;
        }
        OutboundMessage message = prewrittenMessage;
        byte[] finalFrame = Arrays.copyOf(
            prewrittenFrames.get(prewrittenFrames.size() - 1),
            prewrittenFrames.get(prewrittenFrames.size() - 1).length
        );
        if (finalFrame.length > 8) {
            finalFrame[finalFrame.length - 1] ^= (byte) 0xff;
        }
        prewrittenMessage = null;
        prewrittenFrames = Collections.emptyList();

        String writeAddress = message.isLeftArmMessage ? leftAddress : rightAddress;
        logLine("spoiling prewritten " + message.label + ": " + reason);
        return bleManager.writeFrames(
            writeAddress,
            BleProtocol.WRITE_CHAR_UUID,
            Collections.singletonList(finalFrame),
            ConnectionOptions.WRITE_TYPE,
            ConnectionOptions.WRITE_TIMEOUT_MS
        );
    }

    private boolean removePreparedMessageLocked(OutboundMessage message) {
        if (message == null || message.magic == 0) {
            return false;
        }
        Iterator<OutboundMessage> iterator = inFlightMessages.iterator();
        while (iterator.hasNext()) {
            if (iterator.next() == message) {
                iterator.remove();
                magicPool.release(message.sid, message.magic, message.label, "write failed");
                return true;
            }
        }
        return false;
    }


    private void resolveAckLocked(int sid, int magic, byte[] pb) {
        Iterator<OutboundMessage> iterator = inFlightMessages.iterator();
        while (iterator.hasNext()) {
            OutboundMessage message = iterator.next();
            if (message.sid == sid && message.magic == magic) {
                resolveAckLocked(message, pb);
                return;
            }
        }
        recordUnexpectedAckLocked(sid, magic);
    }

    private void resolveAckLocked(OutboundMessage message, byte[] pb) {
        Log.i(TAG, "Got ACK for " + message.label + "(sid=" + message.sid + ", id=" + message.magic + ")");
        inFlightMessages.remove(message);
        message.ackPayload = pb == null ? new byte[0] : Arrays.copyOf(pb, pb.length);
        magicPool.release(message.sid, message.magic, message.label, "ack");
        if (message.onAck != null) {
            message.onAck.run();
        }
        consecutiveAckTimeouts = 0;
    }

    private void logImageUpdateSendLandmarkLocked(OutboundMessage message) {
        if (message.imageUpdateId <= 0) {
            return;
        }
        BleImageOptimizer.ImageUpdateStats stats = imageUpdateStats.get(message.imageUpdateId);
        int frameId = stats == null ? 0 : stats.frameId;
        if (message.imageMessageNumber == 1) {
            if (stats != null && stats.firstWriteStartedAtMs <= 0) {
                stats.firstWriteStartedAtMs = message.writeStartedAtMs > 0 ? message.writeStartedAtMs : message.sentAtMs;
            }
            FrameTimings.getInstance().log(frameId, "first bluetooth packet sent");
            logImageUpdateLandmarkLocked("first bluetooth message sent", message, message.sentAtMs);
        }
        if (message.imageMessageNumber == message.imageMessageCount) {
            FrameTimings.getInstance().log(frameId,
                "last bluetooth packet sent (message " + message.imageMessageNumber + "/" + message.imageMessageCount + ")");
            logImageUpdateLandmarkLocked("last bluetooth message sent", message, message.sentAtMs);
        }
    }

    private void logImageUpdateAckLandmarkLocked(OutboundMessage message) {
        if (message.imageUpdateId <= 0 || message.imageMessageNumber != message.imageMessageCount) {
            return;
        }
        long ackedAtMs = SystemClock.elapsedRealtime();
        BleImageOptimizer.ImageUpdateStats stats = imageUpdateStats.remove(message.imageUpdateId);
        if (stats != null && stats.firstWriteStartedAtMs > 0) {
            emitFrameMetrics(stats.paintMs, (int) Math.max(0, ackedAtMs - stats.firstWriteStartedAtMs), stats.tileCount);
        }
        if (stats != null) {
            finishFrame(stats.frameId, "sent");
        }
        logImageUpdateLandmarkLocked("last bluetooth message acked", message, ackedAtMs);
    }

    /** Remove the stats entry for an image update that will not complete, finishing its frame. */
    private void discardImageUpdateStatsLocked(int imageUpdateId, String reason) {
        if (imageUpdateId <= 0) {
            return;
        }
        BleImageOptimizer.ImageUpdateStats stats = imageUpdateStats.remove(imageUpdateId);
        if (stats != null) {
            finishFrame(stats.frameId, "discarded: " + reason);
        }
    }

    private void logImageUpdateLandmarkLocked(String event, OutboundMessage message, long elapsedMs) {
        logLine("image update#" + message.imageUpdateId + " " + event
                + " at " + timestamp(elapsedMs)
                + " message=" + message.imageMessageNumber + "/" + message.imageMessageCount
                + " label=" + message.label);
    }

    private void enqueueCreateLayoutLocked() {
        // New session/container: re-assert the firmware-debug-flags overlay once it's
        // warmed up again (the mode-7 send is gated on this having reset).
        firmwareDebugFlagsLastSent = -1;
        OutboundMessage message = messageBuilder.createLayout(DASHBOARD_TILE);
        message.onAck = () -> {
            startupProbePending = false;
            clearMessagesOfKindLocked("startup-text-probe");
            fixedLayoutCreated = true;
            setupAckTimeouts = 0;
            displayedFingerprint = "";
        };
        message.onTimeout = () -> {
            if (startupProbePending) {
                logLine("create layout timed out while startup text probe is pending");
                if (hasPendingOrInflightKindLocked("startup-text-probe")) {
                    return;
                }
                startupProbePending = false;
            }
            if (++setupAckTimeouts <= ConnectionOptions.SETUP_ACK_RETRY_LIMIT) {
                logLine("create layout ack timeout (retry " + setupAckTimeouts + ")");
                return;
            }
            handleTransportFailure("ack timeout");
        };
        pendingMessages.addLast(message);
        logLine("queue create layout");
    }

    private void enqueueStartupProbeLocked() {
        enqueueCreateLayoutLocked();

        OutboundMessage message = messageBuilder.startupTextProbe();
        message.onAck = () -> {
            startupProbePending = false;
            clearMessagesOfKindLocked("create-layout");
            fixedLayoutCreated = true;
            warmedUp = false;
            setupAckTimeouts = 0;
            displayedFingerprint = "";
            logLine("existing dashboard layout accepted text probe; image warmup still required");
        };
        message.onTimeout = () -> {
            startupProbePending = false;
            if (hasPendingOrInflightKindLocked("create-layout")) {
                return;
            }
            if (++setupAckTimeouts <= ConnectionOptions.SETUP_ACK_RETRY_LIMIT) {
                logLine("startup text probe ack timeout (retry " + setupAckTimeouts + ")");
                return;
            }
            handleTransportFailure("ack timeout");
        };
        pendingMessages.addLast(message);
        startupProbePending = true;
        logLine("queue startup text probe");
    }

    private void enqueueWarmupLocked() {
        BleProtocol.ImageTileOptions tile = DASHBOARD_TILE;
        // Warm up the legacy container with a carrier-sized blank BMP. Real
        // 640x480 frames use mode 6 and are intentionally independent of this
        // geometry; a mismatched raw BMP would be rejected by the stock loader.
        byte[] bmp = BmpUtil.build4bppBmpFromPacked(
            new byte[((tile.width + 1) >> 1) * tile.height], tile.width, tile.height);
        int sessionId = nextMapSessionId();
        List<BleProtocol.ImageFragment> fragments = BleImageOptimizer.planImageFragments(bmp, ConnectionOptions.IMAGE_FRAGMENT_SIZE);
        for (BleProtocol.ImageFragment fragment : fragments) {
            OutboundMessage message = messageBuilder.imageWarmupFragment(tile, sessionId, fragment, bmp, connectionOptions.sendImagesToLeft);
            pendingMessages.addLast(message);
            message.onAck = () -> {
                // The first tile warmup primes the image path but does not reliably
                // guarantee that the tile is now visible on-screen, so it must not
                // update the displayed-tile cache used by image dedupe.
                warmedUp = true;
                // Warmup fragments are image messages on the wire, so they reset
                // the firmware's heartbeat timer just like real image updates.
                lastHeartbeatAckedAtMs = SystemClock.elapsedRealtime();
            };
            message.onTimeout = () -> {
                warmedUp = false;
                clearMessagesOfKindLocked("warmup");
                displayedFingerprint = "";
            };
        }
        logLine("queue blank warmup");
    }

    /**
     * Send the CFW mode-7 diagnostic-flag control op to the dashboard container:
     * [7][2] to show the on-glasses debug-flag overlay, [7][1] to hide it. Uses the
     * arbitrary-payload image path (no bmp/dedup/frame-timing interaction) and does
     * nothing on stock firmware (which ignores unknown image modes).
     */
    private void enqueueFirmwareDebugFlagsLocked() {
        boolean show = firmwareDebugFlagsEnabled;
        int sub = show ? 2 : 1;
        byte[] payload = new byte[] { (byte) 7, (byte) sub };
        OutboundMessage message = messageBuilder.imagePayload(
            DASHBOARD_TILE, nextMapSessionId(), payload,
            "fw-debug-flags " + (show ? "show" : "hide"),
            connectionOptions.sendImagesToLeft);
        pendingMessages.addLast(message);
        firmwareDebugFlagsLastSent = sub;
        logLine("queue firmware debug flags " + (show ? "show" : "hide"));
    }

    /** Send CFW image-handler mode 10: [10][1] start, [10][0] stop. */
    private void enqueueCompassControlLocked(boolean priority, boolean enable) {
        int sentState = enable ? 1 : 0;
        byte[] payload = new byte[] { (byte) 10, (byte) sentState };
        OutboundMessage message = messageBuilder.imagePayload(
            "compass-control",
            DASHBOARD_TILE,
            nextMapSessionId(),
            payload,
            "compass " + (enable ? "enable" : "disable"),
            connectionOptions.sendImagesToLeft);
        message.onTimeout = () -> {
            compassControlLastSent = -1;
            logLine("compass control ack timeout");
        };
        if (enable) {
            compassMaybeOn = true;
        } else {
            message.onAck = () -> compassMaybeOn = false;
        }
        if (priority) pendingMessages.addFirst(message);
        else pendingMessages.addLast(message);
        compassControlLastSent = sentState;
        logLine("queue " + message.label);
    }

    private void enqueueDesiredImageLocked() {
        String fingerprint = getDesiredFingerprint();
        byte[] packed;
        int width;
        int height;
        int paintMs;
        int frameId;
        synchronized (desiredTilesLock) {
            packed = desiredPacked;
            width = desiredWidth;
            height = desiredHeight;
            paintMs = desiredPaintMs;
            frameId = desiredFrameId;
            desiredFrameId = 0;
        }
        if (packed == null) {
            packed = new byte[0];
        }
        if (lastEnqueuedWidth == width && lastEnqueuedHeight == height
                && Arrays.equals(packed, lastEnqueuedPacked)) {
            lastEnqueuedFingerprint = fingerprint;
            finishFrame(frameId, "discarded: image content identical to displayed");
            return;
        }

        FrameTimings.getInstance().spanStart(frameId, "compress-and-plan");
        // Incremental (mode 3 bounding box) update against the last ENQUEUED frame
        // (the base the firmware shadow will hold when this update is applied).
        // lastEnqueuedPacked is cleared whenever the image pipeline is cleared, so
        // a non-empty value means the display base is trusted.
        byte[] incrementalPayload = null;
        String incrementalLog = null;
        if (connectionOptions.INCREMENTAL_FRAMES && lastEnqueuedPacked.length > 0
                && lastEnqueuedWidth == width && lastEnqueuedHeight == height) {
            int baseFid = nextImageFrameId;
            BleImageOptimizer.IncrementalPlan single =
                BleImageOptimizer.buildIncrementalImagePayload(lastEnqueuedPacked, packed, width, height, baseFid);
            if (single != null) {
                incrementalPayload = single.payload;
                // advance only when a delta is actually emitted, so consecutive
                // deltas carry consecutive ids (CFW skip/reorder detection)
                nextImageFrameId = nextImageFrameId >= 0xfffe ? 1 : nextImageFrameId + 1;
                incrementalLog = "incremental update bbox="
                    + ((single.payload[3] & 0xff) * 4) + "x" + ((single.payload[4] & 0xff) * 2)
                    + "+" + ((single.payload[1] & 0xff) * 4) + "+" + ((single.payload[2] & 0xff) * 2)
                    + " changed=" + single.changedBytes + "/" + single.boxBytes + "B"
                    + " clusters=" + single.clusterCount;

                // When the bounding box spans multiple clusters or is sizeable, try
                // splitting into tight rects (CFW mode-8). Only replace the single
                // box if the multi-rect message is actually smaller on the wire.
                if (connectionOptions.MULTI_RECT_FRAMES
                        && (single.clusterCount > 1 || single.payload.length > ConnectionOptions.MULTI_RECT_MIN_PAYLOAD)) {
                    BleImageOptimizer.MultiRectPlan multi = BleImageOptimizer.buildMultiRectImagePayload(
                        lastEnqueuedPacked, packed, width, height, baseFid, ConnectionOptions.MULTI_RECT_MAX_RECTS);
                    if (multi != null && multi.payload.length < single.payload.length) {
                        incrementalPayload = multi.payload;
                        nextImageFrameId = multi.nextFid;   // rectCount fids consumed
                        incrementalLog = "multi-rect update n=" + multi.rectCount
                            + " covered=" + multi.coveredBytes + "B"
                            + " payload=" + multi.payload.length + "B (vs bbox " + single.payload.length + "B)";
                    }
                }
            }
        }
        BleImageOptimizer.TileImagePlan plan = incrementalPayload != null
            ? new BleImageOptimizer.TileImagePlan(0, DASHBOARD_TILE, packed, width, height, nextMapSessionId(), incrementalPayload)
            : new BleImageOptimizer.TileImagePlan(0, DASHBOARD_TILE, packed, width, height, nextMapSessionId());
        plan.fragments = BleImageOptimizer.planImageFragments(plan.payload, ConnectionOptions.IMAGE_FRAGMENT_SIZE);
        FrameTimings.getInstance().spanEnd(frameId, "compress-and-plan");
        if (incrementalLog != null) {
            FrameTimings.getInstance().log(frameId, incrementalLog);
        }

        int updateId = nextImageUpdateId++;
        int messageCount = plan.fragments.size();
        imageUpdateStats.put(updateId, new BleImageOptimizer.ImageUpdateStats(paintMs, 1, frameId));
        for (int i = 0; i < plan.fragments.size(); i++) {
            BleProtocol.ImageFragment fragment = plan.fragments.get(i);
            enqueueImageFragmentLocked(plan, fragment, fingerprint, updateId, i + 1, messageCount, true);
        }
        // This frame is now the base for the next delta (it will be the firmware
        // shadow once applied), even though it hasn't been acked yet — that is what
        // lets the next frame pipeline behind it. plan.packed is the full frame;
        // frames are immutable by convention, so referencing it is safe.
        lastEnqueuedPacked = plan.packed;
        lastEnqueuedWidth = plan.width;
        lastEnqueuedHeight = plan.height;
        lastEnqueuedFingerprint = fingerprint;

        FrameTimings.getInstance().log(frameId, "queued image update#" + updateId
                + " messages=" + messageCount + " payload=" + plan.payload.length + "B");
        logLine("queue image update#" + updateId + " fingerprint=" + fingerprint
                + " messages=" + messageCount);
    }

    private void enqueueImageFragmentLocked(
        BleImageOptimizer.TileImagePlan plan,
        BleProtocol.ImageFragment fragment,
        String fingerprint,
        int updateId,
        int messageNumber,
        int messageCount,
        boolean requestAck
    ) {
        OutboundMessage message = messageBuilder.imageFragment(fragment, plan, requestAck, connectionOptions.sendImagesToLeft);
        message.setImageUpdatePosition(updateId, messageNumber, messageCount);
        message.onAck = () -> {
            imageRetryAfterMs = 0;
            // Firmware >= 2.2.4.34 resets its heartbeat timer when it receives
            // image messages (not just heartbeats), so an acked image fragment
            // satisfies the heartbeat deadline and heartbeats stop contending
            // with active rendering.
            lastHeartbeatAckedAtMs = SystemClock.elapsedRealtime();
            logImageUpdateAckLandmarkLocked(message);
            boolean imageStillInFlight = false;
            for (OutboundMessage inFlight : inFlightMessages) {
                if ("image".equals(inFlight.kind)) {
                    imageStillInFlight = true;
                    break;
                }
            }
            if (!imageStillInFlight) {
                boolean imageStillQueued = false;
                for (OutboundMessage queued : pendingMessages) {
                    if ("image".equals(queued.kind)) {
                        imageStillQueued = true;
                        break;
                    }
                }
                if (!imageStillQueued) {
                    displayedFingerprint = fingerprint;
                }
            }
        };
        message.onTimeout = () -> {
            discardImageUpdateStatsLocked(message.imageUpdateId, "image ack timeout (will retry)");
            clearMessagesOfKindLocked("image");
            displayedFingerprint = "";
            imageRetryAfterMs = SystemClock.elapsedRealtime() + ConnectionOptions.IMAGE_RETRY_DELAY_MS;
        };
        pendingMessages.addLast(message);
    }

    private OutboundMessage createAudioControlMessageLocked(boolean enable) {
        OutboundMessage message = messageBuilder.enableOrDisableMic(enable);
        message.onAck = () -> {
            lastAudioControlAckMagic = message.magic;
            audioCaptureActive = message.label != null && message.label.contains("enable");
            logLine(audioCaptureActive ? "G2 mic enabled" : "G2 mic disabled");
        };
        message.onTimeout = () -> {
            logLine("audio control ack timeout");
        };
        return message;
    }

    private boolean shouldPollBatteryLocked(long now) {
        return !shutdownRequested
                && sessionReady
                && pendingMessages.isEmpty()
                && inFlightMessages.isEmpty()
                && now - lastConnectionOrInputAtMs >= ConnectionOptions.BATTERY_INPUT_QUIET_MS
                && (lastBatteryRefreshAtMs == 0 || now - lastBatteryRefreshAtMs >= ConnectionOptions.BATTERY_REFRESH_INTERVAL_MS);
    }

    private OutboundMessage createBatteryQueryMessageLocked() {
        OutboundMessage message = messageBuilder.batteryQuery();
        message.onAck = () -> {
            BleProtocol.BatterySnapshot snapshot = BleProtocol.parseSettingsBattery(message.ackPayload);
            if (snapshot != null) {
                headsetBattery = snapshot.battery;
                headsetCharging = snapshot.charging;
                mainHandler.post(this::emitBatteryStateSnapshot);
                if (snapshot.silentMode >= 0) {
                    // Backstop for the push in onNotification: the firmware is
                    // confirmed to push silent-mode-on, but the off transition is
                    // not, so re-read the authoritative value on every poll.
                    updateSilentModeLocked(snapshot.silentMode > 0);
                }
                updateChargingModeLocked(snapshot.charging > 0, snapshot.battery);
            }
            BleProtocol.FirmwareInfo firmwareInfo = BleProtocol.parseSettingsFirmwareInfo(message.ackPayload);
            if (firmwareInfo != null) {
                emitFirmwareInfo(firmwareInfo);
            }
        };
        message.onTimeout = () -> {
            logLine("Battery query timed out");
        };
        return message;
    }

    /**
     * Track silent mode, which the wearer toggles by long-pressing both
     * touchpads at once. While it is on the firmware refuses input events and
     * app launches and powers the display down, so the glasses look dead even
     * though the BLE session is healthy; the phone UI says so explicitly.
     */
    private void updateSilentModeLocked(boolean silent) {
        int next = silent ? 1 : 0;
        if (silentMode == next) {
            return;
        }
        silentMode = next;
        logLine(silent ? "glasses entered silent mode" : "glasses left silent mode");
        emitSilentMode(silent);
    }

    /**
     * Track whether the glasses are in the charging case. Charging means nobody
     * is wearing them: display communication pauses (no heartbeats, so the
     * firmware tears down its EvenHub context on its own) and only battery polls
     * continue. When charging stops, tear the transport down and let the normal
     * reconnect loop rebuild the session, layout, and first frame.
     */
    private void updateChargingModeLocked(boolean charging, int battery) {
        if (charging == chargingMode) {
            if (chargingMode) {
                setStateDisplay("charging", chargingStatusText(battery));
            }
            return;
        }
        if (charging) {
            chargingMode = true;
            clearAllMessagesLocked("glasses charging");
            fixedLayoutCreated = false;
            warmedUp = false;
            startupProbePending = false;
            displayedFingerprint = "";
            finishDesiredFrameLocked("discarded: glasses charging");
            logLine("glasses are charging; pausing display communication");
            setStateDisplay("charging", chargingStatusText(battery));
        } else {
            chargingMode = false;
            logLine("glasses removed from charger; reconnecting");
            hardTransportFailure("charging ended");
        }
    }

    private static String chargingStatusText(int battery) {
        return battery >= 0
            ? "Glasses charging. Battery " + battery + "%."
            : "Glasses charging.";
    }

    private void finishDesiredFrameLocked(String outcome) {
        int frameIdToFinish;
        synchronized (desiredTilesLock) {
            frameIdToFinish = desiredFrameId;
            desiredFrameId = 0;
        }
        finishFrame(frameIdToFinish, outcome);
    }

    private boolean hasPendingOrInflightKindLocked(String kind) {
        for (OutboundMessage queued : pendingMessages) {
            if (kind.equals(queued.kind)) {
                return true;
            }
        }
        for (OutboundMessage inFlight : inFlightMessages) {
            if (kind.equals(inFlight.kind)) {
                return true;
            }
        }
        return false;
    }

    private boolean hasPendingOrInflightMagicLocked(int magic) {
        for (OutboundMessage queued : pendingMessages) {
            if (queued.magic == magic) {
                return true;
            }
        }
        for (OutboundMessage inFlight : inFlightMessages) {
            if (inFlight.magic == magic) {
                return true;
            }
        }
        return false;
    }

    private boolean hasPendingMagicLocked(int sid, int magic) {
        for (OutboundMessage queued : pendingMessages) {
            if (queued.sid == sid && queued.magic == magic) {
                return true;
            }
        }
        return false;
    }

    private void handleAckTimeoutLocked(OutboundMessage message) {
        consecutiveAckTimeouts += 1;

        if (message.onTimeout != null) {
            message.onTimeout.run();
        }

        if (consecutiveAckTimeouts > ConnectionOptions.MAX_CONSECUTIVE_ACK_TIMEOUTS) {
            handleTransportFailure("too many ack timeouts");
        }
    }

    /**
     * Replace any stale lease control with one right-arm and one left-arm
     * fire-and-forget write. With priority=true the right arm is sent first so
     * CLAIM reaches the lens that originated the deferred wake immediately.
     */
    private int enqueueFaceclawWakeControlLocked(int operation, int nonce, boolean priority) {
        clearMessagesOfKindLocked("wake-lease-control");
        final int generation = ++faceclawWakeControlGeneration;
        faceclawWakeControlSentCount = 0;
        if (operation == BleProtocol.FACECLAW_WAKE_OP_ACQUIRE) {
            lastFaceclawWakeLeaseQueuedAtMs = SystemClock.elapsedRealtime();
        }
        Runnable onSent = () -> {
            if (faceclawWakeControlGeneration == generation) {
                faceclawWakeControlSentCount += 1;
            }
        };
        OutboundMessage right = messageBuilder.faceclawWakeControl(operation, nonce, false);
        OutboundMessage left = messageBuilder.faceclawWakeControl(operation, nonce, true);
        right.onSent = onSent;
        left.onSent = onSent;
        if (priority) {
            pendingMessages.addFirst(left);
            pendingMessages.addFirst(right);
        } else {
            pendingMessages.addLast(right);
            pendingMessages.addLast(left);
        }
        logLine("queue " + right.label + " + L");
        return generation;
    }

    private boolean waitForFaceclawWakeControlDelivery(int generation, long timeoutMs) {
        long deadline = SystemClock.elapsedRealtime() + Math.max(0, timeoutMs);
        synchronized (lock) {
            while (running
                    && sessionReady
                    && faceclawWakeControlGeneration == generation
                    && faceclawWakeControlSentCount < 2) {
                long remaining = deadline - SystemClock.elapsedRealtime();
                if (remaining <= 0) {
                    break;
                }
                try {
                    lock.wait(Math.min(remaining, 100));
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    break;
                }
            }
            return faceclawWakeControlGeneration == generation
                && faceclawWakeControlSentCount >= 2;
        }
    }

    /**
     * Acquire/renew or release CFW's independent direct-framebuffer repaint
     * guard on both arms. It is separate from the optional idle-wake lease:
     * every Faceclaw display session needs this guard while its EvenHub layout
     * contains swipe-capturing stock widgets.
     */
    private int enqueueFaceclawFramebufferControlLocked(int operation, boolean priority) {
        clearMessagesOfKindLocked("framebuffer-lease-control");
        final int generation = ++faceclawFramebufferControlGeneration;
        faceclawFramebufferControlSentCount = 0;
        if (operation == BleProtocol.FACECLAW_FB_OP_ACQUIRE) {
            lastFaceclawFramebufferLeaseQueuedAtMs = SystemClock.elapsedRealtime();
        }
        Runnable onSent = () -> {
            if (faceclawFramebufferControlGeneration == generation) {
                faceclawFramebufferControlSentCount += 1;
            }
        };
        OutboundMessage right = messageBuilder.faceclawFramebufferControl(operation, false);
        OutboundMessage left = messageBuilder.faceclawFramebufferControl(operation, true);
        right.onSent = onSent;
        left.onSent = onSent;
        if (priority) {
            pendingMessages.addFirst(left);
            pendingMessages.addFirst(right);
        } else {
            pendingMessages.addLast(right);
            pendingMessages.addLast(left);
        }
        logLine("queue " + right.label + " + L");
        return generation;
    }

    private boolean waitForFaceclawFramebufferControlDelivery(int generation, long timeoutMs) {
        long deadline = SystemClock.elapsedRealtime() + Math.max(0, timeoutMs);
        synchronized (lock) {
            while (running
                    && sessionReady
                    && faceclawFramebufferControlGeneration == generation
                    && faceclawFramebufferControlSentCount < 2) {
                long remaining = deadline - SystemClock.elapsedRealtime();
                if (remaining <= 0) {
                    break;
                }
                try {
                    lock.wait(Math.min(remaining, 100));
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    break;
                }
            }
            return faceclawFramebufferControlGeneration == generation
                && faceclawFramebufferControlSentCount >= 2;
        }
    }

    private boolean releaseFaceclawFramebufferLease() {
        int generation;
        synchronized (lock) {
            if (!running || !sessionReady) {
                return true;
            }
            generation = enqueueFaceclawFramebufferControlLocked(
                BleProtocol.FACECLAW_FB_OP_RELEASE,
                true
            );
        }
        interruptibleSleep.interrupt();
        return waitForFaceclawFramebufferControlDelivery(
            generation,
            FACECLAW_WAKE_CONTROL_WAIT_MS
        );
    }

    private void clearMessagesOfKindLocked(String kind) {
        Iterator<OutboundMessage> pendingIterator = pendingMessages.iterator();
        while (pendingIterator.hasNext()) {
            OutboundMessage message = pendingIterator.next();
            if (kind.equals(message.kind)) {
                pendingIterator.remove();
                discardPrewriteIfMatchesLocked(message);
                if ("image".equals(kind)) {
                    discardImageUpdateStatsLocked(message.imageUpdateId, "pending messages cleared (" + kind + ")");
                }
                magicPool.release(message.sid, message.magic, message.label, "cleared pending " + kind);
            }
        }
        Iterator<OutboundMessage> inFlightIterator = inFlightMessages.iterator();
        while (inFlightIterator.hasNext()) {
            OutboundMessage message = inFlightIterator.next();
            if (kind.equals(message.kind)) {
                inFlightIterator.remove();
                if ("image".equals(kind)) {
                    discardImageUpdateStatsLocked(message.imageUpdateId, "inflight messages cleared (" + kind + ")");
                }
                magicPool.release(message.sid, message.magic, message.label, "cleared inflight " + kind);
            }
        }
        if ("image".equals(kind)) {
            // The image pipeline was flushed (e.g. ack timeout -> keyframe resync):
            // drop the pipelined delta base so the next image is a full keyframe.
            lastEnqueuedPacked = new byte[0];
            lastEnqueuedFingerprint = "";
        }
    }

    private void clearAllMessagesLocked(String reason) {
        clearPendingMessagesLocked(reason);
        clearInFlightMessagesLocked(reason);
        // The image pipeline is gone: drop the pipelined delta base so the next
        // image is a full keyframe rather than a delta onto a stale base.
        lastEnqueuedPacked = new byte[0];
        lastEnqueuedFingerprint = "";
    }

    /**
     * A custom wake queues CLAIM before NativeScript asks for a resume. Keep
     * that private control while flushing stale EvenHub traffic around the
     * direct prelude write.
     */
    private void clearAllMessagesPreservingWakeLeaseLocked(String reason) {
        Iterator<OutboundMessage> pendingIterator = pendingMessages.iterator();
        while (pendingIterator.hasNext()) {
            OutboundMessage message = pendingIterator.next();
            if ("wake-lease-control".equals(message.kind)) {
                continue;
            }
            pendingIterator.remove();
            discardPrewriteIfMatchesLocked(message);
            discardImageUpdateStatsLocked(
                message.imageUpdateId,
                "pending messages cleared: " + reason
            );
            magicPool.release(
                message.sid,
                message.magic,
                message.label,
                "cleared pending: " + reason
            );
        }
        clearInFlightMessagesLocked(reason);
        lastEnqueuedPacked = new byte[0];
        lastEnqueuedFingerprint = "";
    }

    /** Any image update whose fragments are still queued (not yet sent). */
    private boolean hasPendingImageLocked() {
        for (OutboundMessage message : pendingMessages) {
            if ("image".equals(message.kind)) {
                return true;
            }
        }
        return false;
    }

    private void clearPendingMessagesLocked(String reason) {
        while (!pendingMessages.isEmpty()) {
            var message = pendingMessages.removeFirst();
            discardPrewriteIfMatchesLocked(message);
            discardImageUpdateStatsLocked(message.imageUpdateId, "pending messages cleared: " + reason);
            magicPool.release(message.sid, message.magic, message.label, "cleared pending: " + reason);
        }
    }

    private void clearInFlightMessagesLocked(String reason) {
        while (!inFlightMessages.isEmpty()) {
            var message = inFlightMessages.removeFirst();
            discardImageUpdateStatsLocked(message.imageUpdateId, "inflight messages cleared: " + reason);
            magicPool.release(message.sid, message.magic, message.label, "cleared inflight: " + reason);
        }
    }

    private void discardPrewriteIfMatchesLocked(OutboundMessage message) {
        if (message != null && message == prewrittenMessage) {
            prewrittenMessage = null;
            prewrittenFrames = Collections.emptyList();
        }
    }

    private void recordUnexpectedAckLocked(int sid, int magic) {
        if (magic < BleMagicPool.MIN_MAGIC || magic > BleMagicPool.MAX_MAGIC) {
            return;
        }
        BleMagicPool.ReleaseRecord previous = magicPool.getReleaseRecord(sid, magic);
        if (previous == null) {
            String pendingNote = hasPendingMagicLocked(sid, magic) ? " while that magic is only pending locally" : "";
            logLine("unexpected ACK sid=" + sid + " magic=" + magic + pendingNote
                    + "; possible Even app BLE contention");
            return;
        }
        if ("timeout".equals(previous.reason)) {
            logLine("late ACK after timeout sid=" + sid + " magic=" + magic
                    + " label=" + previous.label
                    + "; ACK timeout may be too short");
            return;
        }
        if ("ack".equals(previous.reason)) {
            logLine("duplicate ACK for already-acked message sid=" + sid + " magic=" + magic
                    + " label=" + previous.label
                    + "; possible Even app BLE contention");
            return;
        }
        logLine("late ACK for released message sid=" + sid + " magic=" + magic
                + " label=" + previous.label
                + " release=" + previous.reason);
    }

    private boolean trySoftResync(String reason) {
        synchronized (lock) {
            long now = SystemClock.elapsedRealtime();
            if (!running || userDisconnectRequested || !sessionReady
                    || !fixedLayoutCreated || !warmedUp
                    || !rightConnected || !leftConnected
                    || now - lastIncomingAtMs >= ConnectionOptions.SOFT_RESYNC_RECENT_MS) {
                return false;
            }
            if (softResyncStartedAtMs != 0
                    && now - softResyncStartedAtMs >= ConnectionOptions.HEARTBEAT_FAILURE_DEADLINE_MS) {
                return false;
            }
            if (softResyncStartedAtMs == 0) {
                softResyncStartedAtMs = now;
            }
            logLine("soft resync instead of reconnect: " + reason);
            clearMessagesOfKindLocked("image");
            displayedFingerprint = "";
            imageRetryAfterMs = now + ConnectionOptions.IMAGE_RETRY_DELAY_MS;
            lastConnPriorityAssertAtMs = now;
            try {
                bleManager.requestConnectionPriority(rightAddress, BluetoothGatt.CONNECTION_PRIORITY_HIGH);
                bleManager.requestConnectionPriority(leftAddress, BluetoothGatt.CONNECTION_PRIORITY_HIGH);
            } catch (Throwable t) {
                return false;
            }
            // Make the pump treat a heartbeat as urgent: it blocks other sends and
            // writes one probe as soon as in-flight drains (handleHeartbeat).
            lastHeartbeatAckedAtMs = Math.min(lastHeartbeatAckedAtMs,
                now - ConnectionOptions.HEARTBEAT_URGENT_MS);
        }
        interruptibleSleep.interrupt();
        return true;
    }

    private void handleTransportFailure(String reason) {
        if (trySoftResync(reason)) {
            return;
        }
        hardTransportFailure(reason);
    }

    // A full teardown and reconnect. Deliberate teardowns (charging ended, resume
    // prelude failure, shutdown-ack timeout) call this directly so the soft-resync
    // gate cannot swallow a reconnect the session actually needs.
    private void hardTransportFailure(String reason) {
        Log.e(TAG, "Transport failure: "+reason);
        synchronized (lock) {
            maybeEmitEvenAppConflictLocked(reason);
            sessionReady = false;
            glassesConnectionGeneration++;
            fixedLayoutCreated = false;
            warmedUp = false;
            startupProbePending = false;
            shutdownRequested = false;
            chargingMode = false;
            imageRetryAfterMs = 0;
            softResyncStartedAtMs = 0;
            setupAckTimeouts = 0;
            displayedFingerprint = "";
            faceclawWakePendingNonce = -1;
            lastFaceclawWakeLeaseQueuedAtMs = 0;
            faceclawWakeControlSentCount = 0;
            clearAllMessagesLocked("transport failure: " + reason);
            reconnectAfterMs = SystemClock.elapsedRealtime() + ConnectionOptions.RECONNECT_DELAY_MS;
        }
        synchronized (ringLock) {
            ringNotificationsReady = false;
            invalidateRingPacketAckStateLocked();
        }
        // Avoid communicator-lock -> manager-lock inversion during callback dispatch.
        bleManager.disconnect(rightAddress);
        bleManager.disconnect(leftAddress);
        if (!userDisconnectRequested) {
            setStateDisplay("retrying", reason == null || reason.isEmpty() ? "Reconnecting..." : "Reconnecting after " + reason);
        }
        interruptibleSleep.interrupt();
        interruptRingOperation();
    }

    private void interruptRingOperation() {
        ringInterruptibleSleep.interrupt();
        Thread thread = ringWorkerThread;
        if (thread != null && thread != Thread.currentThread()) {
            thread.interrupt();
        }
    }

    private void resetSessionStateLocked() {
        glassesConnectionGeneration++;
        sessionReady = false;
        shutdownRequested = false;
        fixedLayoutCreated = false;
        warmedUp = false;
        chargingMode = false;
        rightConnected = false;
        leftConnected = false;
        reconnectAfterMs = 0;
        lastAckAtMs = 0;
        lastIncomingAtMs = 0;
        lastHeartbeatSentAtMs = 0;
        lastSessionReadyAtMs = 0;
        consecutiveAckTimeouts = 0;
        softResyncStartedAtMs = 0;
        setupAckTimeouts = 0;
        lastAudioControlAckMagic = 0;
        audioCaptureActive = false;
        audioPacketListener = null;
        compassControlLastSent = -1;
        // A dead transport orphans any glasses-side compass state; the fresh
        // session re-asserts the desired state after warmup (lastSent = -1).
        compassMaybeOn = false;
        faceclawWakePendingNonce = -1;
        lastFaceclawWakeLeaseQueuedAtMs = 0;
        faceclawWakeControlSentCount = 0;
        wearState = -1;
        displayedFingerprint = "";
        // Deliberately not clearing silentMode: it is a property of the glasses,
        // not of our session, and silent mode blocks app launches, so it can be
        // the very cause of the session teardown that got us here.
    }

    private void resetRingStateLocked() {
        ringConnected = false;
        ringNotificationsReady = false;
        ringBattery = -1;
        ringWriteSeq = 0;
        ringHealthProbeSent = false;
        lastRingHealthPollMs = 0;
        lastRingCurrentHrPollMs = 0;
        invalidateRingPacketAckStateLocked();
        ringReconnectAfterMs = 0;
        ringConsecutiveFailures = 0;
    }

    private void emitRingEvent(String kind, String containerName, int eventType, int eventSource, int systemExitReasonCode, int frameId) {
        final FaceclawBleCommunicatorListener current = listener;
        if (current == null) {
            FrameTimings.getInstance().finishFrame(frameId, "discarded: no listener attached");
            return;
        }
        final String containerNameSnapshot = containerName == null ? "" : containerName;
        mainHandler.post(() -> {
            FrameTimings.getInstance().log(frameId, "dispatching input event on main thread");
            try {
                current.onRingEvent(kind, containerNameSnapshot, eventType, eventSource, systemExitReasonCode, frameId);
            } catch (Throwable t) {
                Log.w(TAG, "listener onRingEvent failed", t);
                FrameTimings.getInstance().finishFrame(frameId, "discarded: listener onRingEvent failed");
            }
        });
    }

    private void emitDirectRingEvent(
            String kind,
            String containerName,
            int eventType,
            int eventSource,
            int systemExitReasonCode,
            int frameId,
            int generation
    ) {
        final FaceclawBleCommunicatorListener current = listener;
        if (current == null) {
            FrameTimings.getInstance().finishFrame(frameId, "discarded: no listener attached");
            return;
        }
        final String containerNameSnapshot = containerName == null ? "" : containerName;
        mainHandler.post(() -> {
            if (!isRingNotificationDispatchAllowed(generation)) {
                FrameTimings.getInstance().finishFrame(frameId, "discarded: stale direct ring notification");
                return;
            }
            FrameTimings.getInstance().log(frameId, "dispatching input event on main thread");
            try {
                current.onRingEvent(kind, containerNameSnapshot, eventType, eventSource, systemExitReasonCode, frameId);
            } catch (Throwable t) {
                Log.w(TAG, "listener onRingEvent failed", t);
                FrameTimings.getInstance().finishFrame(frameId, "discarded: listener onRingEvent failed");
            }
        });
    }

    /** Finish a frame owned by the communicator and tell the TS side, which may be awaiting it. */
    private void finishFrame(int frameId, String outcome) {
        if (frameId <= 0) {
            return;
        }
        FrameTimings.getInstance().finishFrame(frameId, outcome);
        final FaceclawBleCommunicatorListener current = listener;
        if (current == null) {
            return;
        }
        mainHandler.post(() -> {
            try {
                current.onFrameFinished(frameId, outcome);
            } catch (Throwable t) {
                Log.w(TAG, "listener onFrameFinished failed", t);
            }
        });
    }

    private void emitImuData(double x, double y, double z, int eventSource) {
        if (imuListeners.isEmpty()) {
            return;
        }
        mainHandler.post(() -> {
            for (FaceclawImuListener imuListener : imuListeners) {
                try {
                    imuListener.onImuData(x, y, z, eventSource);
                } catch (Throwable t) {
                    Log.w(TAG, "listener onImuData failed", t);
                }
            }
        });
    }

    private void emitCompassEvent(int command, int headingDegrees) {
        if (compassListeners.isEmpty()) {
            return;
        }
        mainHandler.post(() -> {
            for (FaceclawCompassListener compassListener : compassListeners) {
                try {
                    compassListener.onCompassEvent(command, headingDegrees);
                } catch (Throwable t) {
                    Log.w(TAG, "listener onCompassEvent failed", t);
                }
            }
        });
    }

    private void emitSilentMode(boolean silent) {
        final FaceclawBleCommunicatorListener current = listener;
        if (current == null) {
            return;
        }
        mainHandler.post(() -> {
            try {
                current.onSilentMode(silent);
            } catch (Throwable t) {
                Log.w(TAG, "listener onSilentMode failed", t);
            }
        });
    }

    private void emitWearState(boolean wearing) {
        final FaceclawBleCommunicatorListener current = listener;
        if (current == null) return;
        mainHandler.post(() -> {
            try {
                current.onWearState(wearing);
            } catch (Throwable t) {
                Log.w(TAG, "listener onWearState failed", t);
            }
        });
    }

    private void emitPhoneLockStateIfChanged(boolean force) {
        final boolean locked;
        synchronized (lock) {
            long now = SystemClock.elapsedRealtime();
            if (!force && now - lastPhoneLockCheckAtMs < 1_000) return;
            lastPhoneLockCheckAtMs = now;
            locked = keyguardManager != null && keyguardManager.isDeviceLocked();
            int value = locked ? 1 : 0;
            if (!force && value == phoneLockState) return;
            phoneLockState = value;
        }
        final FaceclawBleCommunicatorListener current = listener;
        if (current == null) return;
        mainHandler.post(() -> {
            try {
                current.onPhoneLockState(locked);
            } catch (Throwable t) {
                Log.w(TAG, "listener onPhoneLockState failed", t);
            }
        });
    }

    private void emitRingHealthFrame(String charUuid, String hexData, int generation) {
        final FaceclawBleCommunicatorListener current = listener;
        if (current == null) {
            return;
        }
        mainHandler.post(() -> {
            if (!isRingNotificationDispatchAllowed(generation)) {
                return;
            }
            try {
                current.onRingHealthFrame(charUuid, hexData);
            } catch (Throwable t) {
                Log.w(TAG, "listener onRingHealthFrame failed", t);
            }
        });
    }

    private void emitBatteryState(int headsetBattery, int headsetCharging, int ringBattery) {
        final FaceclawBleCommunicatorListener current = listener;
        if (current == null) {
            return;
        }
        mainHandler.post(() -> {
            try {
                current.onBatteryState(headsetBattery, headsetCharging, ringBattery);
            } catch (Throwable t) {
                Log.w(TAG, "listener onBatteryState failed", t);
            }
        });
    }

    private void emitBatteryStateSnapshot() {
        int headsetBatterySnapshot;
        int headsetChargingSnapshot;
        synchronized (lock) {
            headsetBatterySnapshot = headsetBattery;
            headsetChargingSnapshot = headsetCharging;
        }
        int ringBatterySnapshot;
        synchronized (ringLock) {
            ringBatterySnapshot = ringBattery;
        }
        emitBatteryState(headsetBatterySnapshot, headsetChargingSnapshot, ringBatterySnapshot);
    }

    private void emitDirectRingBatteryStateSnapshot(int generation) {
        int headsetBatterySnapshot;
        int headsetChargingSnapshot;
        synchronized (lock) {
            headsetBatterySnapshot = headsetBattery;
            headsetChargingSnapshot = headsetCharging;
        }
        int ringBatterySnapshot;
        synchronized (ringLock) {
            if (!isRingNotificationDispatchAllowed(generation)) {
                return;
            }
            ringBatterySnapshot = ringBattery;
        }
        final FaceclawBleCommunicatorListener current = listener;
        if (current == null) {
            return;
        }
        mainHandler.post(() -> {
            if (!isRingNotificationDispatchAllowed(generation)) {
                return;
            }
            try {
                current.onBatteryState(headsetBatterySnapshot, headsetChargingSnapshot, ringBatterySnapshot);
            } catch (Throwable t) {
                Log.w(TAG, "listener onBatteryState failed", t);
            }
        });
    }

    private void emitFirmwareInfo(BleProtocol.FirmwareInfo info) {
        final FaceclawBleCommunicatorListener current = listener;
        if (current == null) {
            return;
        }
        mainHandler.post(() -> {
            try {
                current.onFirmwareInfo(info.leftVersion, info.rightVersion, info.capabilities);
            } catch (Throwable t) {
                Log.w(TAG, "listener onFirmwareInfo failed", t);
            }
        });
    }

    private void emitFrameMetrics(int paintMs, int transmitMs, int tileCount) {
        final FaceclawBleCommunicatorListener current = listener;
        if (current == null) {
            return;
        }
        mainHandler.post(() -> {
            try {
                current.onFrameMetrics(paintMs, transmitMs, tileCount);
            } catch (Throwable t) {
                Log.w(TAG, "listener onFrameMetrics failed", t);
            }
        });
    }

    private void maybeEmitEvenAppConflictLocked(String reason) {
        if (!"write failed".equals(reason) && !"ring connect failed".equals(reason)) {
            return;
        }
        long now = SystemClock.elapsedRealtime();
        if (lastSessionReadyAtMs <= 0 || now - lastSessionReadyAtMs > ConnectionOptions.EVEN_APP_WRITE_FAILURE_WINDOW_MS) {
            return;
        }
        if (lastEvenAppConflictAtMs > 0 && now - lastEvenAppConflictAtMs < 60_000) {
            return;
        }
        if (!FaceclawEvenAppDetector.isEvenNotificationActive(appContext)) {
            return;
        }
        lastEvenAppConflictAtMs = now;
        emitEvenAppConflict("The Even Realities app still appears to be running. It can hold the R1 ring or glasses BLE link, cause Hermes G2 write failures, or prevent R1 connecting. Open its app settings and force stop it, then retry R1.");
    }

    private void emitEvenAppConflict(String message) {
        final FaceclawBleCommunicatorListener current = listener;
        if (current == null) {
            return;
        }
        final String messageSnapshot = message == null ? "" : message;
        mainHandler.post(() -> {
            try {
                current.onEvenAppConflict(messageSnapshot);
            } catch (Throwable t) {
                Log.w(TAG, "listener onEvenAppConflict failed", t);
            }
        });
    }

    private void setStateDisplay(String nextPhase, String nextStatus) {
        synchronized (lock) {
            phase = nextPhase;
            status = nextStatus;
        }
        emitState();
    }

    private void emitState() {
        final FaceclawBleCommunicatorListener current = listener;
        if (current == null) {
            return;
        }
        final String phaseSnapshot;
        final String statusSnapshot;
        synchronized (lock) {
            phaseSnapshot = phase;
            statusSnapshot = status;
        }
        mainHandler.post(() -> {
            try {
                current.onStateChange(phaseSnapshot, statusSnapshot);
            } catch (Throwable t) {
                Log.w(TAG, "listener onStateChange failed", t);
            }
        });
    }

    private void updateG2ScreenWakeLock(boolean screenOn) {
        if (screenOn) {
            if (g2ScreenWakeLock == null) {
                g2ScreenWakeLock = powerManager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, G2_SCREEN_WAKE_LOCK_TAG);
                g2ScreenWakeLock.setReferenceCounted(false);
            }
            if (!g2ScreenWakeLock.isHeld()) {
                g2ScreenWakeLock.acquire();
                logLine("G2 screen wake lock acquired");
            }
            return;
        }
        releaseG2ScreenWakeLock();
    }

    private void releaseG2ScreenWakeLock() {
        if (g2ScreenWakeLock != null && g2ScreenWakeLock.isHeld()) {
            g2ScreenWakeLock.release();
            logLine("G2 screen wake lock released");
        }
    }

    private void logLine(String line) {
        Log.i(TAG, line);
        final FaceclawBleCommunicatorListener current = listener;
        if (current == null) {
            return;
        }
        mainHandler.post(() -> {
            try {
                current.onLog(line);
            } catch (Throwable t) {
                Log.w(TAG, "listener onLog failed", t);
            }
        });
    }

    private void logDirectRingLine(String line, int generation) {
        if (!isRingNotificationDispatchAllowed(generation)) {
            return;
        }
        Log.i(TAG, line);
        final FaceclawBleCommunicatorListener current = listener;
        if (current == null) {
            return;
        }
        mainHandler.post(() -> {
            if (!isRingNotificationDispatchAllowed(generation)) {
                return;
            }
            try {
                current.onLog(line);
            } catch (Throwable t) {
                Log.w(TAG, "listener onLog failed", t);
            }
        });
    }

    private static String timestamp(long elapsedMs) {
        long wallMs = System.currentTimeMillis();
        return String.format(Locale.US, "%tF %tT.%tL elapsed=%dms", wallMs, wallMs, wallMs, elapsedMs);
    }

    private int nextMapSessionId() {
        int id = nextMapSessionId;
        int increment = connectionOptions.skipSessionIds ? 2 : 1;
        nextMapSessionId = (nextMapSessionId + increment) & 0xff;
        return id;
    }

    private static String requireAddress(String name, String address) {
        if (address == null || address.trim().isEmpty()) {
            throw new IllegalArgumentException(name + " is required");
        }
        return address.trim();
    }

    private boolean hasRingAddress() {
        return ringAddress != null && !ringAddress.trim().isEmpty();
    }

    private boolean isConfiguredRingAddress(String address) {
        return hasRingAddress() && address != null && address.equalsIgnoreCase(ringAddress);
    }

    private boolean isDirectRingNotification(String address, String characteristicUuid) {
        if (!isConfiguredRingAddress(address) || characteristicUuid == null) {
            return false;
        }
        return BleProtocol.R1_PHONE_NOTIFY_CHAR_UUID.equals(characteristicUuid)
            || BleProtocol.R1_NOTIFY_CHAR_UUID.equals(characteristicUuid);
    }

    private static String hex(byte[] data) {
        if (data == null || data.length == 0) {
            return "";
        }
        char[] out = new char[data.length * 2];
        char[] digits = "0123456789abcdef".toCharArray();
        for (int i = 0; i < data.length; i++) {
            int value = data[i] & 0xff;
            out[i * 2] = digits[value >>> 4];
            out[i * 2 + 1] = digits[value & 0x0f];
        }
        return new String(out);
    }

    private static String safeMessage(Throwable t) {
        if (t == null) {
            return "unknown";
        }
        StringWriter writer = new StringWriter();
        t.printStackTrace(new PrintWriter(writer));
        String trace = writer.toString();
        if (!trace.trim().isEmpty()) {
            return trace;
        }
        String message = t.getMessage();
        return message == null || message.trim().isEmpty() ? String.valueOf(t) : message;
    }
    
    private String getDesiredFingerprint() {
        synchronized (desiredTilesLock) {
            return desiredFingerprint;
        }
    }
}
