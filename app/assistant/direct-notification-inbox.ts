import {
  shell,
  type DirectAssistantResultCloseReason,
} from "../ui/shell/shell";
import {
  directNotificationStore,
  type DirectNotificationAcceptance,
  type DirectNotificationIdentity,
  type DirectNotificationStore,
  type PendingDirectNotification,
} from "./direct-notification-store";

export type DirectNotificationWearState = "unknown" | "not-worn" | "worn";

export type DirectNotificationPresenter = {
  canStart: () => boolean;
  present: (
    notification: PendingDirectNotification,
    position: number,
    total: number,
    signal: AbortSignal,
    isAllowed: () => boolean,
    onStrictFrameAcknowledged: () => void,
    onClosed: (reason: DirectAssistantResultCloseReason) => void,
  ) => Promise<{ acknowledged: true; successAllowed: boolean }>;
};

export type DirectNotificationInboxDependencies = {
  store: DirectNotificationStore;
  presenter: DirectNotificationPresenter;
  defer?: (callback: () => void) => void;
  /** Maximum time one pre-ACK presenter may retain the durable FIFO head. */
  presentationDeadlineMs?: number;
  /** Injectable timer boundary for deterministic liveness tests. */
  setPresentationDeadline?: (callback: () => void, delayMs: number) => unknown;
  clearPresentationDeadline?: (handle: unknown) => void;
};

const DEFAULT_PRESENTATION_DEADLINE_MS = 15_000;

/** Content-free internal state exposed only to the ADB debug control runtime. */
export type DirectNotificationInboxDiagnostics = Readonly<{
  active: boolean;
  scheduled: boolean;
  paused: boolean;
  presentationEnabled: boolean;
  retryRetained: boolean;
}>;

/**
 * Phone-owned bridge between durable notification acceptance and wearer-visible
 * delivery. At most one card is active. Its queue record is tombstoned at the
 * exact strict frame ACK, while the acknowledged layer stays until dismiss or
 * global screen sleep.
 */
export class DirectNotificationInbox {
  private wearState: DirectNotificationWearState = "unknown";
  private scheduled = false;
  private scheduleGeneration = 0;
  private activeToken: number | null = null;
  private activeIdentity: DirectNotificationIdentity | null = null;
  private activeAbort: AbortController | null = null;
  private activeAcknowledgementCommitted = false;
  private activeAcknowledgementCommitInProgress = false;
  private nextToken = 0;
  private pausedAfterCommitFailure = false;
  private presentationEnabled = true;
  private retryAfterActiveRelease = false;
  private slotRecheckUsed = false;
  private readonly defer: (callback: () => void) => void;
  private readonly presentationDeadlineMs: number;
  private readonly setPresentationDeadline: (callback: () => void, delayMs: number) => unknown;
  private readonly clearPresentationDeadline: (handle: unknown) => void;
  private readonly unsubscribeStore: () => void;

  constructor(private readonly dependencies: DirectNotificationInboxDependencies) {
    this.defer = dependencies.defer ?? ((callback) => setTimeout(callback, 0));
    this.presentationDeadlineMs = dependencies.presentationDeadlineMs ?? DEFAULT_PRESENTATION_DEADLINE_MS;
    if (!Number.isSafeInteger(this.presentationDeadlineMs) || this.presentationDeadlineMs < 1) {
      throw new Error("Direct notification presentation deadline must be a positive integer.");
    }
    this.setPresentationDeadline = dependencies.setPresentationDeadline ??
      ((callback, delayMs) => setTimeout(callback, delayMs));
    this.clearPresentationDeadline = dependencies.clearPresentationDeadline ??
      ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.unsubscribeStore = dependencies.store.onChange((snapshot) => {
      this.handleStoreChange(snapshot.available, snapshot.pending[0] ?? null);
    });
  }

  dispose(): void {
    this.invalidateScheduledPresentation();
    this.abortPreAcknowledgementPresentation();
    this.unsubscribeStore();
  }

  acceptResult(
    operationId: string,
    text: string,
    guard?: () => boolean,
  ): DirectNotificationAcceptance {
    const receipt = this.dependencies.store.accept({ operationId, text }, guard);
    if (receipt.status === "queued") this.schedulePresentation();
    return receipt;
  }

  setWearState(state: DirectNotificationWearState): void {
    const prior = this.wearState;
    this.wearState = state;
    if (state !== "worn") {
      this.invalidateScheduledPresentation();
      this.retryAfterActiveRelease = false;
      this.abortPreAcknowledgementPresentation();
      return;
    }
    if (state === "worn") {
      // A fresh, confirmed session/on-head transition is a safe retry edge for
      // a transient encrypted tombstone-write failure. Merely remaining worn
      // does not create an immediate flash loop.
      if (prior !== "worn") this.pausedAfterCommitFailure = false;
      if (prior !== "worn") this.slotRecheckUsed = false;
      if (
        this.activeToken !== null &&
        !this.pausedAfterCommitFailure &&
        this.presentationEnabled
      ) {
        // A fresh ON_HEAD can race the rejection of an older pre-ACK attempt.
        // Retain that real lifecycle edge until the attempt releases instead
        // of requiring another wear transition to drain the durable head.
        this.retryAfterActiveRelease = true;
        return;
      }
      this.schedulePresentation();
    }
  }

  /** Live privacy control: queued records remain encrypted but cannot present. */
  setPresentationEnabled(enabled: boolean): void {
    if (enabled === this.presentationEnabled) return;
    this.presentationEnabled = enabled;
    if (!enabled) {
      this.invalidateScheduledPresentation();
      this.retryAfterActiveRelease = false;
      this.abortPreAcknowledgementPresentation();
      return;
    }
    this.retryPresentation();
  }

  getWearState(): DirectNotificationWearState {
    return this.wearState;
  }

  getDiagnostics(): DirectNotificationInboxDiagnostics {
    return {
      active: this.activeToken !== null,
      scheduled: this.scheduled,
      paused: this.pausedAfterCommitFailure,
      presentationEnabled: this.presentationEnabled,
      retryRetained: this.retryAfterActiveRelease,
    };
  }

  /** Called on external lifecycle recovery: ON_HEAD, screen wake, unlock, or a later compositor frame. */
  retryPresentation(): void {
    this.slotRecheckUsed = false;
    if (this.activeToken !== null) {
      if (
        !this.pausedAfterCommitFailure &&
        this.presentationEnabled &&
        this.wearState === "worn"
      ) this.retryAfterActiveRelease = true;
      return;
    }
    // Explicit lifecycle opportunities may recover a transient secure-store
    // failure without requiring an application restart.
    this.pausedAfterCommitFailure = false;
    this.schedulePresentation();
  }

  /**
   * A shell layer's own teardown is not an external recovery edge. In
   * particular, removing a failed pre-ACK direct card synchronously emits this
   * callback before its rejected presentation has released its active token;
   * retaining that callback would immediately flash-loop the same card.
   */
  retryPresentationAfterLayerTeardown(): void {
    this.slotRecheckUsed = false;
    if (this.activeToken !== null) {
      // Preserve the old post-ACK behavior so removing an acknowledged card
      // can drain a retained next FIFO record, but never retain the failed
      // pre-ACK card's self-generated teardown.
      if (
        this.activeAcknowledgementCommitted &&
        !this.pausedAfterCommitFailure &&
        this.presentationEnabled &&
        this.wearState === "worn"
      ) this.retryAfterActiveRelease = true;
      return;
    }
    this.pausedAfterCommitFailure = false;
    this.schedulePresentation();
  }

  /** Global display sleep is not permission to wake for another FIFO card. */
  pauseUntilNextOpportunity(): void {
    this.invalidateScheduledPresentation();
    this.retryAfterActiveRelease = false;
    this.abortPreAcknowledgementPresentation();
  }

  private schedulePresentation(): void {
    if (
      this.scheduled ||
      this.activeToken !== null ||
      this.pausedAfterCommitFailure ||
      !this.presentationEnabled ||
      this.wearState !== "worn"
    ) return;
    this.scheduled = true;
    const scheduleGeneration = ++this.scheduleGeneration;
    this.defer(() => {
      if (scheduleGeneration !== this.scheduleGeneration) return;
      this.scheduled = false;
      void this.presentHead();
    });
  }

  private async presentHead(): Promise<void> {
    if (
      this.activeToken !== null ||
      this.pausedAfterCommitFailure ||
      !this.presentationEnabled ||
      this.wearState !== "worn"
    ) return;
    if (!this.dependencies.presenter.canStart()) {
      // Layer ownership can change in the same event-loop turn as ON_HEAD.
      // Recheck once, then rely on the shell's blocker-removal/lifecycle edge;
      // never poll or timer-spin while a real blocker remains.
      if (!this.slotRecheckUsed) {
        this.slotRecheckUsed = true;
        this.schedulePresentation();
      }
      return;
    }
    this.slotRecheckUsed = false;

    let notification: PendingDirectNotification | null;
    let total: number;
    try {
      const snapshot = this.dependencies.store.snapshot();
      if (!snapshot.available || !snapshot.pending.length) return;
      notification = snapshot.pending[0] ?? null;
      total = snapshot.pending.length;
    } catch {
      return;
    }
    if (!notification) return;

    const identity: DirectNotificationIdentity = {
      operationHash: notification.operationHash,
      digest: notification.digest,
      insertionRevision: notification.insertionRevision,
    };
    const token = ++this.nextToken;
    this.activeToken = token;
    this.activeIdentity = identity;
    this.activeAbort = new AbortController();
    this.activeAcknowledgementCommitted = false;
    this.activeAcknowledgementCommitInProgress = false;
    let settled = false;
    let closed = false;
    let closeReason: DirectAssistantResultCloseReason = "preempted";
    let acknowledgementCommitted = false;
    let released = false;
    let deadlineHandle: unknown = null;
    const wasDismissed = () => closeReason === "dismissed";

    const release = (pumpNext: boolean): void => {
      if (released) return;
      released = true;
      if (this.activeToken === token) {
        this.activeToken = null;
        this.activeIdentity = null;
        this.activeAbort = null;
        this.activeAcknowledgementCommitted = false;
        this.activeAcknowledgementCommitInProgress = false;
      }
      const retryRetained = this.retryAfterActiveRelease;
      this.retryAfterActiveRelease = false;
      if (pumpNext || retryRetained) this.schedulePresentation();
    };
    const onClosed = (reason: DirectAssistantResultCloseReason): void => {
      closed = true;
      closeReason = reason;
      if (settled) release(
        reason === "dismissed" && acknowledgementCommitted && !this.pausedAfterCommitFailure,
      );
    };
    const isAllowed = () =>
      this.activeToken === token &&
      this.presentationEnabled &&
      this.wearState === "worn" &&
      !this.pausedAfterCommitFailure;
    const onStrictFrameAcknowledged = (): void => {
      if (!isAllowed()) throw new Error("The direct notification presentation was superseded.");
      this.activeAcknowledgementCommitInProgress = true;
      try {
        // This encrypted commit is deliberately synchronous inside the shell's
        // strict ACK callback. Only after it succeeds may the wake lease commit.
        this.dependencies.store.acknowledge(identity, isAllowed);
        acknowledgementCommitted = true;
        this.activeAcknowledgementCommitted = true;
      } catch (error) {
        this.pausedAfterCommitFailure = true;
        throw error;
      } finally {
        this.activeAcknowledgementCommitInProgress = false;
      }
    };

    try {
      const presentation = Promise.resolve().then(() => this.dependencies.presenter.present(
          notification!,
          1,
          total,
          this.activeAbort!.signal,
          isAllowed,
          onStrictFrameAcknowledged,
          onClosed,
        ));
      const deadline = new Promise<never>((_resolve, reject) => {
        deadlineHandle = this.setPresentationDeadline(() => {
          // ACK ownership deliberately has no reading-time deadline: after the
          // secure tombstone commits, the visible card lives until dismiss or
          // global sleep. This deadline exists only to free a stuck pre-ACK clone.
          if (acknowledgementCommitted || this.activeToken !== token) return;
          const controller = this.activeAbort;
          // Revoke first so an abort handler or late presenter callback cannot
          // pass isAllowed() and tombstone plaintext that was never displayed.
          release(false);
          controller?.abort();
          reject(new Error("The direct notification presentation deadline elapsed."));
        }, this.presentationDeadlineMs);
      });
      // Promise.race installs observers on both inputs. A presenter that ignores
      // abort may settle much later, but can neither become unhandled nor regain
      // the already-revoked active token.
      const receipt = await Promise.race([presentation, deadline]);
      if (receipt.acknowledged !== true) return;
    } catch {
      // Pre-ACK failures retain the encrypted record. A failed post-ACK secure
      // tombstone commit pauses draining to avoid flashing the same card twice
      // in this process; restart recovery is deliberately at-least-once.
    } finally {
      if (deadlineHandle !== null) {
        this.clearPresentationDeadline(deadlineHandle);
        deadlineHandle = null;
      }
      settled = true;
      if (!acknowledgementCommitted || closed) {
        release(
          closed && wasDismissed() &&
          acknowledgementCommitted && !this.pausedAfterCommitFailure,
        );
      }
      notification = null;
    }
  }

  private handleStoreChange(
    available: boolean,
    head: PendingDirectNotification | null,
  ): void {
    this.invalidateScheduledPresentation();
    const identity = this.activeIdentity;
    if (
      this.activeToken !== null &&
      !this.activeAcknowledgementCommitted &&
      !this.activeAcknowledgementCommitInProgress &&
      (!available || !identity || !head || !sameIdentity(identity, head))
    ) {
      // Revoke the exact pre-ACK shell transaction so its private clone cannot
      // outlive an unreadable/replaced encrypted document.
      this.retryAfterActiveRelease = available && this.presentationEnabled && this.wearState === "worn";
      this.activeAbort?.abort();
      return;
    }
    if (available && this.activeToken === null) this.schedulePresentation();
  }

  private invalidateScheduledPresentation(): void {
    this.scheduleGeneration++;
    this.scheduled = false;
  }

  private abortPreAcknowledgementPresentation(): void {
    if (
      this.activeToken !== null &&
      !this.activeAcknowledgementCommitted &&
      !this.activeAcknowledgementCommitInProgress
    ) this.activeAbort?.abort();
  }
}

function sameIdentity(
  identity: DirectNotificationIdentity,
  notification: PendingDirectNotification,
): boolean {
  return identity.operationHash === notification.operationHash &&
    identity.digest === notification.digest &&
    identity.insertionRevision === notification.insertionRevision;
}

export const directNotificationInbox = new DirectNotificationInbox({
  store: directNotificationStore,
  presenter: {
    canStart: () => shell.canStartDirectAssistantResultPresentation(),
    present: (notification, position, total, signal, isAllowed, onStrictFrameAcknowledged, onClosed) =>
      shell.notifyAssistantResult(
        notification.text,
        signal,
        isAllowed,
        {
          receivedAtMs: notification.receivedAtMs,
          position,
          total,
          onStrictFrameAcknowledged,
          onClosed,
        },
      ),
  },
});
