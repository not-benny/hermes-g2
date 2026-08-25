/** Opaque ownership for one assistant-result screen wake. */
export type AssistantResultWakeLease = Readonly<{
  id: number;
  ownsWake: boolean;
}>;

export type AtomicAssistantResultPreparation = Readonly<{
  ready: boolean;
  rollback: () => void;
}>;

export type OpaqueAssistantResultWakeDependencies<Lease> = Readonly<{
  /** The exact sleep-origin result still owns the pending presentation. */
  isPendingAsleep: () => boolean;
  /** Assert compositor black, resume the display, and hide retained app surfaces. */
  prepareOpaqueDisplay: () => Promise<boolean>;
  /** Prove a blank shell frame while the display is still logically asleep. */
  primeBlankFrame: () => Promise<boolean>;
  /** Wake the logical shell only after black and retained-surface isolation are proven. */
  acquireWake: () => Lease;
  ownsPriorSleep: (lease: Lease) => boolean;
  /** The exact result, wake, and presentation gate are all still current. */
  isWakeCurrent: () => boolean;
  /** Reveal only the already-primed isolated compositor. */
  revealOpaqueDisplay: () => Promise<boolean>;
  commitWake: (lease: Lease) => void;
  rollbackWake: (lease: Lease) => void;
  /** Release the owner-neutral compositor lease after commit or rollback. */
  releaseOpaqueDisplay: () => void;
  onWakeError?: (error: unknown) => void;
}>;

export type OpaqueAssistantResultWakeTransaction = Readonly<{
  ready: boolean;
  commit: () => void;
  rollback: () => void;
}>;

/** Identity for the newest owner of the shared assistant-only surface. */
export class AssistantOnlyPresentationOwnership {
  private sequence = 0;

  claim(): number {
    return ++this.sequence;
  }

  invalidate(): void {
    this.sequence++;
  }

  isCurrent(claim: number): boolean {
    return claim === this.sequence;
  }
}

function opaqueCurrent(check: () => boolean): boolean {
  try { return check(); } catch { return false; }
}

function failedOpaqueWake(): OpaqueAssistantResultWakeTransaction {
  return { ready: false, commit: () => {}, rollback: () => {} };
}

/**
 * Hold an isolated wake blank through the ordinary-render drain, then install
 * the one unique final layer. Any failure before installation rolls the wake
 * back and cannot expose the retained HUD/app stack.
 */
export async function prepareAtomicAssistantResultLayer<T extends AtomicAssistantResultPreparation>(deps: Readonly<{
  enterIsolation: () => void;
  prepare: () => Promise<T | null>;
  isReadyCurrent: () => boolean;
  drainBlankRender: () => Promise<void>;
  installFinalLayer: () => void;
  releaseIsolationIfAsleep: () => void;
}>): Promise<T> {
  deps.enterIsolation();
  let preparation: T | null = null;
  try {
    preparation = await deps.prepare();
    if (preparation?.ready !== true || !deps.isReadyCurrent()) {
      throw new Error("The sleeping assistant result could not acquire the glasses display.");
    }
    await deps.drainBlankRender();
    if (!deps.isReadyCurrent()) {
      throw new Error("The sleeping assistant result wake was superseded.");
    }
    deps.installFinalLayer();
    return preparation;
  } catch (error) {
    preparation?.rollback();
    deps.releaseIsolationIfAsleep();
    throw error;
  }
}

/**
 * Begin one sleep-origin assistant reply behind the same blank-first
 * compositor transaction used by opaque notification cards. The physical
 * isolation lease remains held until the reply's own strict frame commits;
 * every earlier failure restores the exact prior sleep state.
 */
export async function beginOpaqueAssistantResultWake<Lease>(
  deps: OpaqueAssistantResultWakeDependencies<Lease>,
): Promise<OpaqueAssistantResultWakeTransaction> {
  if (!opaqueCurrent(deps.isPendingAsleep)) return failedOpaqueWake();

  let isolationAttempted = false;
  let lease: Lease | null = null;
  let settled = false;
  let isolationReleased = false;
  const releaseIsolation = () => {
    if (!isolationAttempted || isolationReleased) return;
    isolationReleased = true;
    deps.releaseOpaqueDisplay();
  };
  const rollback = () => {
    if (settled) return;
    settled = true;
    try {
      if (lease !== null) deps.rollbackWake(lease);
    } finally {
      releaseIsolation();
    }
  };

  try {
    // Preparation can acquire its physical lease before returning false, so
    // every attempted preparation must run the matching release path.
    isolationAttempted = true;
    if (!(await deps.prepareOpaqueDisplay()) || !opaqueCurrent(deps.isPendingAsleep)) {
      throw new Error("The isolated assistant display could not be prepared.");
    }
    if (!(await deps.primeBlankFrame()) || !opaqueCurrent(deps.isPendingAsleep)) {
      throw new Error("The isolated assistant blank frame was not acknowledged.");
    }
    lease = deps.acquireWake();
    if (!deps.ownsPriorSleep(lease) || !opaqueCurrent(deps.isWakeCurrent)) {
      throw new Error("The isolated assistant wake was superseded.");
    }
    if (!(await deps.revealOpaqueDisplay()) || !opaqueCurrent(deps.isWakeCurrent)) {
      throw new Error("The isolated assistant display could not be revealed.");
    }
    return {
      ready: true,
      commit: () => {
        if (settled || lease === null) return;
        settled = true;
        try {
          deps.commitWake(lease);
        } finally {
          releaseIsolation();
        }
      },
      rollback,
    };
  } catch (error) {
    deps.onWakeError?.(error);
    rollback();
    return failedOpaqueWake();
  }
}

/**
 * Tracks only uncommitted assistant-result wakes. User/other UI activity
 * invalidates ownership; overlapping assistant waiters transfer it so the last
 * rejected waiter can roll back a shared otherwise-blank wake.
 */
export class AssistantResultWakeOwnership {
  private sequence = 0;
  private ownerId: number | null = null;

  acquire(
    screenOn: boolean,
    wake: () => boolean,
    rebaselineAlreadyOn: () => void,
  ): AssistantResultWakeLease {
    if (screenOn) rebaselineAlreadyOn();
    const inheritsPendingWake = screenOn && this.ownerId !== null;
    const wokeScreen = !screenOn && wake();
    const lease = { id: ++this.sequence, ownsWake: inheritsPendingWake || wokeScreen };
    if (lease.ownsWake) this.ownerId = lease.id;
    return lease;
  }

  /** Any user or unrelated UI owner claims the screen and prevents rollback. */
  invalidate(): void {
    this.ownerId = null;
  }

  /** Any authorized waiter sharing the wake makes the on state intentional. */
  commit(_lease: AssistantResultWakeLease): void {
    this.ownerId = null;
  }

  /** Sleep only when this exact lease still owns the uncommitted wake. */
  rollback(
    lease: AssistantResultWakeLease,
    isScreenOn: () => boolean,
    sleep: () => void,
  ): boolean {
    if (!lease.ownsWake || this.ownerId !== lease.id || !isScreenOn()) return false;
    this.ownerId = null;
    sleep();
    return true;
  }
}
