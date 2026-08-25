import {
  clockStore,
  type ClockNativeFire,
  type ClockOccurrence,
  type ClockSnapshot,
  type ClockStore,
} from "./store";
import {
  ClockAlertTimeline,
  type ClockAlertEntry,
  type ClockAlertWearState,
} from "./alert-state";
import { buildClockAlertPayload, CLOCK_ALERT_PHRASE_MS } from "./alert-sound";
import {
  clockSchedulerBridge,
  type ClockCampaignAckInput,
  type ClockCampaignState,
} from "../native/clock-scheduler";
import type { ClockAlertVisualState } from "../ui/shell/clock-alert-layer";

const MAX_TIMEOUT_MS = 0x7fffffff;
const AUDIO_RETRY_MS = 5_000;
/** Do not turn an arbitrarily old catch-up into a fresh multi-minute campaign. */
const AUDIO_START_GRACE_MS = 60_000;

export type ClockAlertHardware = {
  isConnected: () => boolean;
  requestWearState: () => void;
  /** Resume/create EvenHub while preserving blank output unless visual=true. */
  prepareSession: (visual: boolean) => Promise<boolean>;
  releaseSession: () => Promise<void> | void;
  /** True means the exact phrase was accepted into the live firmware queue. */
  play: (
    payload: Uint8Array,
    campaign: ClockCampaignAckInput,
    isAllowed: () => boolean,
  ) => Promise<boolean>;
  /** Headless exact-alarm recovery; must never prompt for permissions. */
  ensureConnected: () => Promise<boolean>;
  stop: () => Promise<void>;
  showVisual: (state: ClockAlertVisualState) => Promise<boolean>;
  closeVisual: () => void;
  log?: (line: string) => void;
};

type SummaryVisual = {
  kind: "timer" | "alarm";
  label: string;
  count: number;
};

/**
 * Phone-owned Clock runtime. App windows are views over ClockStore; closing a
 * Clock window never affects this scheduler, native alarm mirror, or campaign.
 */
export class ClockAlertCoordinator {
  private readonly timeline = new ClockAlertTimeline();
  private hardware: ClockAlertHardware | null = null;
  private wearState: ClockAlertWearState = "unknown";
  private started = false;
  private offStore: (() => void) | null = null;
  private dueTimer: ReturnType<typeof setTimeout> | null = null;
  private phaseTimer: ReturnType<typeof setTimeout> | null = null;
  private work: Promise<void> = Promise.resolve();
  private audioSessionActive = false;
  private playedPhase: "low" | "high" | null = null;
  private playedPhraseEndsAtMs = 0;
  private summary: SummaryVisual | null = null;
  private readonly dismissWhenSilent = new Set<string>();
  private readonly visualSuppressedIds = new Set<string>();
  private visualSignature: string | null = null;
  /** Invalidates preparation/play continuations synchronously on ring dismissal. */
  private cancellationEpoch = 0;
  private restoredCampaigns = new Map<string, ClockCampaignState>();
  /** Avoid a hot 0 ms loop if all durable occurrence slots are pending. */
  private dueRetryNotBeforeMs = 0;

  constructor(
    private readonly store: ClockStore = clockStore,
    private readonly now: () => number = () => Date.now(),
  ) {}

  configure(hardware: ClockAlertHardware): void {
    this.hardware = hardware;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.offStore = this.store.onChange(() => this.queueReconcile("store change"));
    clockSchedulerBridge.onDue((event) => this.queueNativeFire(event));
    clockSchedulerBridge.onTimeChanged(() => this.queueTimeChange());
    this.queueLifecycleReconcile("startup");
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.offStore?.();
    this.offStore = null;
    clockSchedulerBridge.onDue(null);
    clockSchedulerBridge.onTimeChanged(null);
    this.clearDueTimer();
    this.clearPhaseTimer();
    this.cancellationEpoch++;
    this.timeline.clear();
    this.summary = null;
    this.visualSignature = null;
    this.visualSuppressedIds.clear();
    void this.stopAudioAndRelease();
    this.hardware?.closeVisual();
  }

  setConnected(connected: boolean): void {
    if (!connected) {
      this.cancellationEpoch++;
      this.playedPhase = null;
      this.playedPhraseEndsAtMs = 0;
      this.audioSessionActive = false;
      void this.hardware?.stop().catch(() => {});
      return;
    }
    this.queueProjection("connected");
  }

  setWearState(next: ClockAlertWearState): void {
    const previous = this.wearState;
    this.wearState = next;
    if (next === "not-worn") {
      this.timeline.setWearState(next);
      this.persistTimelineRouting();
      this.hardware?.closeVisual();
      this.visualSignature = null;
      this.queue(async () => {
        for (const occurrence of this.store.snapshot().occurrences) {
          if (occurrence.status === "silent" && occurrence.wasOffHead !== true) {
            try { this.store.markOccurrenceSilent(occurrence.id, true); }
            catch (error) { this.logError("record off-head state", error); }
          }
        }
        await this.refreshProjection();
      });
      return;
    }

    const activeConfirmedOffHead = this.timeline.entriesSnapshot()
      .some((entry) => entry.confirmedOffHead);
    if (next === "worn" && (previous === "not-worn" || activeConfirmedOffHead)) {
      this.cancellationEpoch++;
      this.clearPhaseTimer();
      void this.hardware?.stop().catch((error) => this.logError("urgent put-on Clock stop", error));
      this.queue(() => this.acknowledgeAfterPutOn());
      return;
    }

    this.timeline.setWearState(next);
    // Initial UNKNOWN→ON_HEAD is classification rather than dismissal, but
    // its shorter two-minute route must still survive a process restart.
    this.persistTimelineRouting();
    if (next !== "worn") {
      this.hardware?.closeVisual();
      this.visualSignature = null;
    }
    this.queueProjection("wear state");
  }

  /** Ring single/double tap owns stop globally, including while display/lock is off. */
  handleRingStop(): boolean {
    let occurrences: ClockOccurrence[] = [];
    try { occurrences = this.store.snapshot().occurrences; }
    catch { /* unavailable store has no durable work to dismiss */ }
    if (!occurrences.length && this.timeline.size() === 0 && !this.summary) return false;
    // Terminal state changes are deliberately synchronous. An older queued
    // refresh may still be awaiting layout/visual delivery; its epoch check
    // must fail before it can enqueue a new phrase after this tap.
    this.cancellationEpoch++;
    this.clearPhaseTimer();
    for (const occurrence of occurrences) this.dismissOccurrence(occurrence);
    this.timeline.clear();
    this.dismissWhenSilent.clear();
    this.visualSuppressedIds.clear();
    this.summary = null;
    this.visualSignature = null;
    this.hardware?.closeVisual();
    const release = this.audioSessionActive;
    this.audioSessionActive = false;
    this.playedPhase = null;
    this.playedPhraseEndsAtMs = 0;
    void this.hardware?.stop().catch((error) => this.logError("urgent ring Clock stop", error));
    if (release) {
      void Promise.resolve(this.hardware?.releaseSession())
        .catch((error) => this.logError("ring Clock audio lease release", error));
    }
    return true;
  }

  /** Screen timeout hides Clock but does not truncate the promised beep period. */
  onScreenChanged(on: boolean): void {
    if (!on) {
      this.summary = null;
      this.visualSignature = null;
      this.hardware?.closeVisual();
      if (this.wearState === "worn") {
        for (const entry of this.timeline.entriesSnapshot()) {
          this.dismissWhenSilent.add(entry.id);
          this.visualSuppressedIds.add(entry.id);
        }
        for (const occurrence of this.safeSnapshot().occurrences) {
          if (occurrence.status === "silent") this.dismissOccurrence(occurrence);
        }
      }
      return;
    }
    this.dismissWhenSilent.clear();
    this.visualSuppressedIds.clear();
    this.visualSignature = null;
    this.queueProjection("display wake");
  }

  /** Generic notification/game cues must not replace a Clock-owned phrase. */
  ownsBuzzer(): boolean {
    return this.timeline.size() > 0 || this.audioSessionActive;
  }

  private queueReconcile(reason: string): void {
    this.queue(async () => {
      if (!this.started) return;
      this.reconcileElapsedTimers(reason);
      try {
        this.store.reconcileDue(this.now());
        this.dueRetryNotBeforeMs = 0;
      } catch (error) {
        this.dueRetryNotBeforeMs = this.now() + AUDIO_RETRY_MS;
        this.logError(`${reason} reconcile`, error);
      }
      await this.processSnapshot();
    });
  }

  private queueTimeChange(): void {
    this.queueLifecycleReconcile("wall-clock change");
  }

  private queueLifecycleReconcile(reason: string): void {
    this.queue(async () => {
      const now = this.now();
      this.reconcileElapsedTimers(reason, now);
      this.drainNativeFires(reason, now);
      // Materialize crossed deadlines before recalculating future local-wall
      // alarms. This keeps time jumps and startup catch-up lossless.
      try {
        this.store.reconcileDue(now);
        this.dueRetryNotBeforeMs = 0;
      } catch (error) {
        this.dueRetryNotBeforeMs = now + AUDIO_RETRY_MS;
        this.logError(`${reason} due reconcile`, error);
      }
      try { this.store.reconcileWallClockSchedules(now); }
      catch (error) { this.logError(`${reason} alarm reschedule`, error); }
      await this.processSnapshot();
    });
  }

  private queueNativeFire(event: ClockNativeFire): void {
    this.queue(async () => {
      try {
        if (clockSchedulerBridge.isFireCurrent(event)) {
          this.store.reconcileNativeFire(event, this.now());
        }
        if (!clockSchedulerBridge.acknowledgeFire(event)) {
          throw new Error("native Clock due acknowledgement was not persisted");
        }
      } catch (error) {
        this.logError("native Clock due reconcile", error);
        setTimeout(() => this.queueLifecycleReconcile("native due retry"), AUDIO_RETRY_MS);
      }
      await this.processSnapshot();
    });
  }

  private reconcileElapsedTimers(reason: string, atMs = this.now()): void {
    try {
      const deadlines = clockSchedulerBridge.timerDeadlines();
      if (deadlines) this.store.reconcileElapsedTimerSchedules(deadlines, atMs);
    } catch (error) {
      this.logError(`${reason} elapsed timer reconcile`, error);
    }
  }

  private drainNativeFires(reason: string, atMs: number): void {
    let fires: ClockNativeFire[];
    try { fires = clockSchedulerBridge.pendingFires(); }
    catch (error) {
      this.logError(`${reason} native fire inbox`, error);
      return;
    }
    for (const fire of fires) {
      try {
        if (clockSchedulerBridge.isFireCurrent(fire)) {
          this.store.reconcileNativeFire(fire, atMs);
        }
        if (!clockSchedulerBridge.acknowledgeFire(fire)) {
          throw new Error("native Clock due acknowledgement was not persisted");
        }
      } catch (error) {
        this.logError(`${reason} native fire`, error);
      }
    }
  }

  private queueProjection(reason: string): void {
    this.queue(async () => {
      this.log(`Clock alert refresh: ${reason}`);
      await this.processSnapshot();
    });
  }

  private queue(operation: () => Promise<void> | void): void {
    this.work = this.work.then(async () => {
      try { await operation(); }
      catch (error) { this.logError("coordinator", error); }
    });
  }

  private async processSnapshot(): Promise<void> {
    const snapshot = this.safeSnapshot();
    if (!snapshot.available) return;
    try {
      clockSchedulerBridge.sync(this.store.scheduledItems());
    } catch (error) {
      this.logError("native schedule sync", error);
    }
    this.scheduleNextDue();

    if (snapshot.occurrences.some((occurrence) => occurrence.status === "pending") &&
        !this.hardware?.isConnected()) {
      try { await this.hardware?.ensureConnected(); }
      catch (error) { this.logError("Clock recovery connection", error); }
    }

    const pendingIds = new Set(snapshot.occurrences
      .filter((occurrence) => occurrence.status === "pending")
      .map((occurrence) => occurrence.id));
    const removed = this.timeline.entriesSnapshot()
      .filter((entry) => !pendingIds.has(entry.id))
      .map((entry) => entry.id);
    this.timeline.remove(removed);
    if (removed.length) {
      try { clockSchedulerBridge.clearCampaigns(removed); }
      catch (error) { this.logError("clear retired Clock campaigns", error); }
    }

    let restoredTimingLoaded = false;
    try {
      this.restoredCampaigns = new Map(
        clockSchedulerBridge.campaigns().map((campaign) => [campaign.occurrenceId, campaign]),
      );
      restoredTimingLoaded = true;
    } catch (error) {
      this.logError("restore Clock campaigns", error);
      this.restoredCampaigns.clear();
    }

    let restoredPlayedPhase: "low" | "high" | null = null;
    let restoredPhraseEndsAtMs = 0;
    for (const occurrence of snapshot.occurrences) {
      if (occurrence.status !== "pending") continue;
      const restored = this.restoredCampaigns.get(occurrence.id);
      this.timeline.add({
        id: occurrence.id,
        itemId: occurrence.itemId,
        kind: occurrence.kind,
        label: this.labelFor(snapshot, occurrence),
        dueAtMs: occurrence.dueAtMs,
      }, this.wearState, restored?.startedAtMs ?? null);
      if (restored) {
        this.timeline.restoreTiming(occurrence.id, restored.startedAtMs);
        this.timeline.restoreRouting(
          occurrence.id,
          restored.extendedForOffHead,
          restored.confirmedOffHead,
        );
        if (restored.phraseEndsAtMs > this.now() &&
            restored.phraseEndsAtMs >= restoredPhraseEndsAtMs) {
          restoredPlayedPhase = restored.phase;
          restoredPhraseEndsAtMs = restored.phraseEndsAtMs;
        }
      }
    }
    if (restoredTimingLoaded) {
      // Replace, rather than max with, the prior wall projection. A backward
      // TIME_SET otherwise leaves a stale far-future phrase boundary.
      this.playedPhase = restoredPlayedPhase;
      this.playedPhraseEndsAtMs = restoredPhraseEndsAtMs;
    }

    if (this.wearState === "worn") {
      const offHeadSilent = snapshot.occurrences.filter(
        (occurrence) => occurrence.status === "silent" && occurrence.wasOffHead === true,
      );
      if (offHeadSilent.length) {
        await this.acknowledgeAfterPutOn(offHeadSilent);
        return;
      }
    }
    await this.refreshProjection();
    const remaining = this.safeSnapshot().occurrences;
    if (!remaining.some((occurrence) => occurrence.status === "pending") &&
        this.timeline.size() === 0 && !this.audioSessionActive) {
      try { clockSchedulerBridge.setRecoveryLease(false); }
      catch (error) { this.logError("Clock recovery lease release", error); }
    }
  }

  private async refreshProjection(): Promise<void> {
    this.clearPhaseTimer();
    const operationEpoch = this.cancellationEpoch;
    let unstartedDeadline = this.expireUnstarted(this.now());
    let projection = this.timeline.project(this.now());
    if (projection.expired.length) {
      this.timeline.remove(projection.expired.map((entry) => entry.id));
      try { clockSchedulerBridge.clearCampaigns(projection.expired.map((entry) => entry.id)); }
      catch (error) { this.logError("clear completed Clock campaigns", error); }
      for (const entry of projection.expired) {
        const occurrence = this.safeSnapshot().occurrences.find((candidate) => candidate.id === entry.id);
        if (!occurrence) continue;
        if (this.dismissWhenSilent.delete(entry.id)) {
          this.dismissOccurrence(occurrence);
        } else {
          try { this.store.markOccurrenceSilent(entry.id, entry.confirmedOffHead); }
          catch (error) { this.logError("mark Clock occurrence silent", error); }
        }
      }
      projection = this.timeline.project(this.now());
    }

    if (projection.phase === "idle" || !projection.active.length) {
      await this.stopAudioAndRelease();
      const presented = await this.presentSilentOrClose();
      if (!presented && (this.summary || this.safeSnapshot().occurrences.some((item) => item.status === "silent"))) {
        this.schedulePhaseAt(this.now() + AUDIO_RETRY_MS);
      }
      return;
    }

    let visualRetryAt: number | null = null;
    let visualDelivery: Promise<boolean> | null = null;
    if (this.wearState === "worn") {
      this.summary = null;
      const mayPresent = projection.active.some((entry) => !this.visualSuppressedIds.has(entry.id));
      if (mayPresent) {
        // showVisual installs the opaque layer synchronously before its first
        // await. Prove that frame in parallel with audio-session readiness so
        // strict transport delivery never consumes the audible minute.
        visualDelivery = this.ensureVisual(
          this.visualForEntries(projection.active, projection.phase, "active"),
          projection.active.map((entry) => entry.id),
        );
      }
    } else {
      this.hardware?.closeVisual();
      this.visualSignature = null;
    }

    const hardware = this.hardware;
    let audioRetryAt: number | null = null;
    if (hardware?.isConnected()) {
      if (!this.audioSessionActive) {
        hardware.requestWearState();
        const prepared = await hardware.prepareSession(this.wearState === "worn");
        if (operationEpoch !== this.cancellationEpoch) {
          if (prepared) {
            try { await hardware.stop(); } catch { /* ring/disconnect already owns stop */ }
            try { await hardware.releaseSession(); } catch { /* best-effort stale lease cleanup */ }
          }
          return;
        }
        if (prepared && hardware === this.hardware && hardware.isConnected()) {
          this.audioSessionActive = true;
          if (this.playedPhraseEndsAtMs <= this.now()) {
            this.playedPhase = null;
            this.playedPhraseEndsAtMs = 0;
          }
        }
      }
      unstartedDeadline = this.expireUnstarted(this.now());
      projection = this.timeline.project(this.now());
      if (projection.phase === "idle" || !projection.active.length) {
        if (visualDelivery) await visualDelivery;
        await this.stopAudioAndRelease();
        const presented = await this.presentSilentOrClose();
        if (!presented) this.schedulePhaseAt(this.now() + AUDIO_RETRY_MS);
        return;
      }
      if (
        this.audioSessionActive &&
        projection.active.length > 0 &&
        (this.playedPhase !== projection.phase || this.now() >= this.playedPhraseEndsAtMs)
      ) {
        const priorPhraseEnd = this.playedPhraseEndsAtMs;
        const accepted = await hardware.play(
          buildClockAlertPayload(projection.phase),
          {
            phase: projection.phase,
            occurrences: projection.active.map((entry) => ({
              occurrenceId: entry.id,
              itemId: entry.itemId,
              dueAtMs: entry.dueAtMs,
              extendedForOffHead: entry.extendedForOffHead,
              confirmedOffHead: entry.confirmedOffHead,
            })),
          },
          () => operationEpoch === this.cancellationEpoch,
        );
        if (operationEpoch !== this.cancellationEpoch) {
          try { await hardware.stop(); } catch { /* terminal path already owns stop */ }
          return;
        }
        if (accepted) {
          const acceptedAt = this.now();
          const started = this.timeline.startPending(acceptedAt);
          if (!started.length && priorPhraseEnd > 0 && acceptedAt > priorPhraseEnd) {
            this.timeline.shiftStarted(
              projection.active.map((entry) => entry.id),
              acceptedAt - priorPhraseEnd,
            );
          }
          this.playedPhase = projection.phase;
          this.playedPhraseEndsAtMs = acceptedAt + CLOCK_ALERT_PHRASE_MS;
          // OFF_HEAD may have arrived while the native ACK was in flight. The
          // ACK persisted its earlier payload, so patch routing from the live
          // timeline immediately after the positive receipt.
          this.persistTimelineRouting();
          // Native has now committed both the accepted campaign and its exact
          // phrase-boundary AlarmManager wake, so the cold-recovery FGS/wake
          // lease can safely transfer to firmware plus that durable edge.
          try { clockSchedulerBridge.setRecoveryLease(false); }
          catch (error) { this.logError("Clock recovery wake transfer", error); }
          projection = this.timeline.project(acceptedAt);
        } else {
          audioRetryAt = this.now() + AUDIO_RETRY_MS;
        }
      }
    }

    if (visualDelivery) {
      const shown = await visualDelivery;
      if (operationEpoch !== this.cancellationEpoch) return;
      if (!shown) visualRetryAt = this.now() + AUDIO_RETRY_MS;
    }

    const sessionRetryAt = !this.audioSessionActive && hardware?.isConnected()
      ? this.now() + AUDIO_RETRY_MS
      : null;
    this.schedulePhaseAt(minTimestamp(
      projection.nextTransitionAtMs,
      minTimestamp(
        minTimestamp(sessionRetryAt, audioRetryAt),
        minTimestamp(
          minTimestamp(visualRetryAt, unstartedDeadline),
          this.audioSessionActive && this.playedPhase !== null ? this.playedPhraseEndsAtMs : null,
        ),
      ),
    ));
  }

  private async presentSilentOrClose(): Promise<boolean> {
    if (this.summary) {
      return this.ensureVisual(
        { ...this.summary, mode: "acknowledged", phase: "idle" },
        ["acknowledged"],
      );
    }
    if (this.wearState !== "worn") {
      this.hardware?.closeVisual();
      this.visualSignature = null;
      return true;
    }
    const snapshot = this.safeSnapshot();
    const silent = snapshot.occurrences.filter((occurrence) => occurrence.status === "silent");
    if (!silent.length) {
      this.hardware?.closeVisual();
      this.visualSignature = null;
      return true;
    }
    const entries = silent.map((occurrence) => ({
      id: occurrence.id,
      itemId: occurrence.itemId,
      kind: occurrence.kind,
      label: this.labelFor(snapshot, occurrence),
      dueAtMs: occurrence.dueAtMs,
      extendedForOffHead: occurrence.wasOffHead === true,
      confirmedOffHead: occurrence.wasOffHead === true,
      startedAtMs: occurrence.dueAtMs,
    }));
    return this.ensureVisual(
      this.visualForEntries(entries, "idle", "silent"),
      silent.map((occurrence) => occurrence.id),
    );
  }

  private async acknowledgeAfterPutOn(explicit?: readonly ClockOccurrence[]): Promise<void> {
    this.cancellationEpoch++;
    this.clearPhaseTimer();
    const snapshot = this.safeSnapshot();
    const activeIds = new Set(this.timeline.entriesSnapshot().map((entry) => entry.id));
    const targets = explicit ? [...explicit] : snapshot.occurrences.filter(
      (occurrence) => activeIds.has(occurrence.id) || occurrence.wasOffHead === true,
    );
    if (!targets.length) {
      this.timeline.setWearState("worn");
      await this.refreshProjection();
      return;
    }
    const labels = targets.map((occurrence) => this.labelFor(snapshot, occurrence));
    const kind = targets.some((occurrence) => occurrence.kind === "alarm") ? "alarm" : "timer";
    // First durably convert active work into an off-head silent receipt. Keep
    // that receipt until the strict summary frame is physically accepted, so
    // process death or a transient transport failure cannot lose feedback.
    for (const occurrence of targets) {
      try { clockSchedulerBridge.clearCampaigns([occurrence.id]); }
      catch (error) { this.logError("clear put-on Clock campaign", error); }
      try { this.store.markOccurrenceSilent(occurrence.id, true); }
      catch (error) { this.logError("retain put-on Clock summary", error); }
      try { clockSchedulerBridge.dismissNotification(occurrence.itemId, occurrence.dueAtMs); }
      catch (error) { this.logError("dismiss put-on Clock fallback notification", error); }
    }
    this.timeline.remove(targets.map((occurrence) => occurrence.id));
    this.dismissWhenSilent.clear();
    this.visualSuppressedIds.clear();
    this.visualSignature = null;
    this.summary = {
      kind,
      label: targets.length === 1 ? labels[0]! : `${targets.length} Clock alerts`,
      count: targets.length,
    };
    // Silence first, install/prove the opaque summary while the off-head
    // compositor is still blank, then release the audio-only lifecycle lease.
    if (this.playedPhase !== null || this.audioSessionActive) {
      try { await this.hardware?.stop(); }
      catch (error) { this.logError("urgent Clock buzzer stop", error); }
    }
    this.playedPhase = null;
    this.playedPhraseEndsAtMs = 0;
    const presented = await this.presentSilentOrClose();
    if (presented) {
      for (const occurrence of targets) this.dismissOccurrence(occurrence);
    } else {
      this.schedulePhaseAt(this.now() + AUDIO_RETRY_MS);
    }
    if (this.audioSessionActive) {
      this.audioSessionActive = false;
      try { await this.hardware?.releaseSession(); }
      catch (error) { this.logError("Clock audio lease release", error); }
    }
  }

  private async ensureVisual(state: ClockAlertVisualState, ownerIds: readonly string[]): Promise<boolean> {
    const hardware = this.hardware;
    if (!hardware || !hardware.isConnected()) return false;
    const signature = JSON.stringify([
      state.mode, state.kind, state.label, state.count, state.phase, [...ownerIds].sort(),
    ]);
    if (this.visualSignature === signature) return true;
    try {
      const shown = await hardware.showVisual(state);
      if (shown) this.visualSignature = signature;
      return shown;
    } catch (error) {
      this.logError("Clock visual delivery", error);
      return false;
    }
  }

  /**
   * Give normal resume/reconnect one bounded minute, then retain a silent
   * missed occurrence instead of replaying a fresh campaign hours later.
   */
  private expireUnstarted(nowMs: number): number | null {
    let nextDeadline: number | null = null;
    for (const entry of this.timeline.entriesSnapshot()) {
      if (entry.startedAtMs !== null) continue;
      const deadline = entry.dueAtMs + AUDIO_START_GRACE_MS;
      if (nowMs < deadline) {
        nextDeadline = minTimestamp(nextDeadline, deadline);
        continue;
      }
      this.timeline.remove([entry.id]);
      try { clockSchedulerBridge.clearCampaigns([entry.id]); }
      catch (error) { this.logError("clear unplayed Clock campaign", error); }
      const occurrence = this.safeSnapshot().occurrences.find((candidate) => candidate.id === entry.id);
      if (!occurrence) continue;
      if (this.dismissWhenSilent.delete(entry.id)) {
        this.dismissOccurrence(occurrence);
      } else {
        try { this.store.markOccurrenceSilent(entry.id, entry.confirmedOffHead); }
        catch (error) { this.logError("mark unplayed Clock occurrence silent", error); }
      }
    }
    return nextDeadline;
  }

  private dismissOccurrence(occurrence: ClockOccurrence): void {
    try { clockSchedulerBridge.clearCampaigns([occurrence.id]); }
    catch (error) { this.logError("clear Clock campaign", error); }
    try { this.store.dismissOccurrence(occurrence.id); }
    catch (error) { this.logError("dismiss Clock occurrence", error); }
    try { clockSchedulerBridge.dismissNotification(occurrence.itemId, occurrence.dueAtMs); }
    catch (error) { this.logError("dismiss Clock fallback notification", error); }
  }

  private async stopAudioAndRelease(): Promise<void> {
    this.clearPhaseTimer();
    if (this.playedPhase !== null || this.audioSessionActive) {
      try { await this.hardware?.stop(); }
      catch (error) { this.logError("urgent Clock buzzer stop", error); }
    }
    this.playedPhase = null;
    this.playedPhraseEndsAtMs = 0;
    if (this.audioSessionActive) {
      this.audioSessionActive = false;
      try { await this.hardware?.releaseSession(); }
      catch (error) { this.logError("Clock audio lease release", error); }
    }
  }

  private scheduleNextDue(): void {
    this.clearDueTimer();
    let next;
    try { next = this.store.nextDue(); }
    catch { return; }
    if (!next) return;
    const now = this.now();
    const delay = Math.max(0, next.nextFireAtMs - now, this.dueRetryNotBeforeMs - now);
    this.dueTimer = setTimeout(() => {
      this.dueTimer = null;
      this.queueReconcile("JS deadline");
    }, Math.min(MAX_TIMEOUT_MS, delay));
  }

  private schedulePhaseAt(atMs: number | null): void {
    this.clearPhaseTimer();
    if (atMs === null) return;
    const delay = Math.max(0, atMs - this.now());
    this.phaseTimer = setTimeout(() => {
      this.phaseTimer = null;
      this.queueProjection("phase deadline");
    }, Math.min(MAX_TIMEOUT_MS, delay));
  }

  private clearDueTimer(): void {
    if (this.dueTimer === null) return;
    clearTimeout(this.dueTimer);
    this.dueTimer = null;
  }

  private clearPhaseTimer(): void {
    if (this.phaseTimer === null) return;
    clearTimeout(this.phaseTimer);
    this.phaseTimer = null;
  }

  private visualForEntries(
    entries: readonly ClockAlertEntry[],
    phase: "idle" | "low" | "high",
    mode: "active" | "silent",
  ): ClockAlertVisualState {
    const sorted = [...entries].sort((left, right) => left.dueAtMs - right.dueAtMs);
    const primary = sorted[0]!;
    return {
      mode,
      kind: sorted.some((entry) => entry.kind === "alarm") ? "alarm" : primary.kind,
      label: sorted.length === 1 ? primary.label : `${sorted.length} Clock alerts`,
      count: sorted.length,
      phase,
    };
  }

  private labelFor(snapshot: ClockSnapshot, occurrence: ClockOccurrence): string {
    if (occurrence.kind === "timer") {
      return snapshot.timers.find((timer) => timer.id === occurrence.itemId)?.label ?? "Timer";
    }
    return snapshot.alarms.find((alarm) => alarm.id === occurrence.itemId)?.label ?? "Alarm";
  }

  private safeSnapshot(): ClockSnapshot {
    try { return this.store.snapshot(); }
    catch {
      return { available: false, revision: 0, timers: [], alarms: [], worldClocks: [], occurrences: [] };
    }
  }

  private log(message: string): void {
    this.hardware?.log?.(message);
  }

  private persistTimelineRouting(): void {
    const entries = this.timeline.entriesSnapshot();
    if (!entries.length) return;
    try {
      if (!clockSchedulerBridge.updateCampaignRouting(entries)) {
        throw new Error("native routing commit was rejected");
      }
    } catch (error) {
      this.logError("persist Clock wear routing", error);
    }
  }

  private logError(operation: string, error: unknown): void {
    const detail = error instanceof Error ? error.message : String(error);
    this.log(`${operation} failed: ${detail}`);
  }
}

function minTimestamp(left: number | null, right: number | null): number | null {
  if (left === null) return right;
  if (right === null) return left;
  return Math.min(left, right);
}

export const clockAlertCoordinator = new ClockAlertCoordinator();
