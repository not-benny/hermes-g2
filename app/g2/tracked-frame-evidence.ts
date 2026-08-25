export type TrackedFrameEvidenceWait = {
  promise: Promise<boolean>;
  cancel: () => void;
};

type Waiter<Owner> = {
  owner: Owner;
  epoch: number;
  settle: (value: boolean) => void;
};

/**
 * One-shot, event-driven waiters for evidence owned by one exact lifecycle.
 * The caller remains responsible for defining whether that lifecycle and its
 * evidence are current; this class only provides identity/epoch routing and
 * leak-free settlement.
 */
export class TrackedFrameEvidenceWaiters<Owner> {
  private readonly waiters = new Set<Waiter<Owner>>();

  wait(
    owner: Owner,
    epoch: number,
    isCurrent: () => boolean,
    hasEvidence: () => boolean,
  ): TrackedFrameEvidenceWait {
    if (!isCurrent()) return { promise: Promise.resolve(false), cancel: () => {} };
    if (hasEvidence()) return { promise: Promise.resolve(true), cancel: () => {} };

    let resolvePromise!: (value: boolean) => void;
    const promise = new Promise<boolean>((resolve) => {
      resolvePromise = resolve;
    });
    let settled = false;
    const waiter: Waiter<Owner> = {
      owner,
      epoch,
      settle: (value) => {
        if (settled) return;
        settled = true;
        this.waiters.delete(waiter);
        resolvePromise(value);
      },
    };
    this.waiters.add(waiter);

    // Close the check/register gap even if a caller's predicates synchronously
    // expose a lifecycle transition or newly recorded evidence.
    if (!isCurrent()) waiter.settle(false);
    else if (hasEvidence()) waiter.settle(true);

    return {
      promise,
      cancel: () => waiter.settle(false),
    };
  }

  signal(owner: Owner, epoch: number): void {
    for (const waiter of [...this.waiters]) {
      if (waiter.owner === owner && waiter.epoch === epoch) waiter.settle(true);
    }
  }

  invalidate(): void {
    for (const waiter of [...this.waiters]) waiter.settle(false);
  }

  pendingCount(): number {
    return this.waiters.size;
  }
}
