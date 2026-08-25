/** Opaque ownership for one assistant-result screen wake. */
export type AssistantResultWakeLease = Readonly<{
  id: number;
  ownsWake: boolean;
}>;

export type AtomicAssistantResultPreparation = Readonly<{
  ready: boolean;
  rollback: () => void;
}>;

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
