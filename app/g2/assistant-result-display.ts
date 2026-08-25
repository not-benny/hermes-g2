export type AssistantResultDisplayDependencies<Lease> = {
  isAllowed: () => boolean;
  canPrepare: () => boolean;
  acquireWake: () => Lease;
  awaitReady: () => Promise<boolean>;
  /**
   * Optional event-driven fail-safe for a false-negative lifecycle barrier.
   * The owner must settle it true only for tracked shell-frame evidence on the
   * exact, still-current display lifecycle. Its cancel callback must remove a
   * losing waiter; the result card still requires its own strict frame ACK.
   */
  awaitTrackedFrameEvidence?: () => {
    promise: Promise<boolean>;
    cancel: () => void;
  };
  isReadyCurrent: () => boolean;
  commitWake: (lease: Lease) => void;
  rollbackWake: (lease: Lease) => void;
  onWakeError?: (error: unknown) => void;
};

export type AssistantResultDisplayWakeTransaction = {
  ready: boolean;
  commit: () => void;
  rollback: () => void;
};

function current(check: () => boolean): boolean {
  try { return check(); } catch { return false; }
}

function failedTransaction(): AssistantResultDisplayWakeTransaction {
  return { ready: false, commit: () => {}, rollback: () => {} };
}

/** Begin a completed-result wake, retaining provisional ownership for its ACK. */
export async function beginAssistantResultDisplayWake<Lease>(
  deps: AssistantResultDisplayDependencies<Lease>,
): Promise<AssistantResultDisplayWakeTransaction> {
  if (!current(deps.isAllowed) || !current(deps.canPrepare)) return failedTransaction();
  const lease = deps.acquireWake();
  let settled = false;
  const transaction: AssistantResultDisplayWakeTransaction = {
    ready: true,
    commit: () => {
      if (settled) return;
      settled = true;
      deps.commitWake(lease);
    },
    rollback: () => {
      if (settled) return;
      settled = true;
      deps.rollbackWake(lease);
    },
  };
  if (!current(deps.isAllowed) || !current(deps.canPrepare)) {
    transaction.rollback();
    return failedTransaction();
  }

  let ready = false;
  let cancelTrackedFrameWait: (() => void) | null = null;
  try {
    const readiness = deps.awaitReady();
    const trackedFrameWait = deps.awaitTrackedFrameEvidence?.();
    if (trackedFrameWait) {
      cancelTrackedFrameWait = trackedFrameWait.cancel;
      ready = await Promise.race([readiness, trackedFrameWait.promise]);
    } else {
      ready = await readiness;
    }
  } catch (error) {
    deps.onWakeError?.(error);
  } finally {
    cancelTrackedFrameWait?.();
  }
  const accepted =
    ready &&
    current(deps.isAllowed) &&
    current(deps.canPrepare) &&
    current(deps.isReadyCurrent);
  if (!accepted) {
    transaction.rollback();
    return failedTransaction();
  }
  return transaction;
}

/** Existing completed-turn callers commit as soon as readiness is accepted. */
export async function runAssistantResultDisplayWake<Lease>(
  deps: AssistantResultDisplayDependencies<Lease>,
): Promise<boolean> {
  const transaction = await beginAssistantResultDisplayWake(deps);
  if (transaction.ready) transaction.commit();
  return transaction.ready;
}
