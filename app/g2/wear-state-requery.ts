export type WearStateRequeryScheduler = {
  schedule: (callback: () => void, delayMs: number) => unknown;
  cancel: (handle: unknown) => void;
};

export type WearStateRequeryDependencies<Session> = {
  isEligible: (session: Session) => boolean;
  requestState: (session: Session) => void | Promise<void>;
  onRequestError?: (error: unknown) => void;
  scheduler?: WearStateRequeryScheduler;
};

// CFW control ACKs can remain in flight for 3.5 seconds. Waiting five avoids
// replacing a healthy first query while still recovering promptly if it drops.
export const WEAR_STATE_REQUERY_DELAY_MS = 5_000;
export const WEAR_STATE_REQUERY_MAX_ATTEMPTS = 3;

const defaultScheduler: WearStateRequeryScheduler = {
  schedule: (callback, delayMs) => setTimeout(callback, delayMs),
  cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Owns one bounded current-state query loop for one exact transport session.
 * A session stays exhausted after the final attempt so repeated lifecycle
 * reconciliation cannot accidentally turn a bounded retry into polling.
 */
export class WearStateRequery<Session> {
  private session: Session | null = null;
  private timer: unknown | null = null;
  private attempts = 0;
  private readonly scheduler: WearStateRequeryScheduler;

  constructor(
    private readonly dependencies: WearStateRequeryDependencies<Session>,
    private readonly maxAttempts = WEAR_STATE_REQUERY_MAX_ATTEMPTS,
    private readonly retryDelayMs = WEAR_STATE_REQUERY_DELAY_MS,
  ) {
    this.scheduler = dependencies.scheduler ?? defaultScheduler;
  }

  /** Begin immediately. Reconciliation for the same session is idempotent. */
  begin(session: Session): void {
    if (this.session === session) return;
    this.cancel();
    this.session = session;
    this.attempt(session);
  }

  /** A fresh callback resolves only the exact session that requested it. */
  resolve(session: Session): boolean {
    if (this.session !== session) return false;
    this.cancel(session);
    return true;
  }

  /** Retire all work, or only work owned by the supplied exact session. */
  cancel(session?: Session): boolean {
    if (session !== undefined && this.session !== session) return false;
    if (this.timer !== null) {
      this.scheduler.cancel(this.timer);
      this.timer = null;
    }
    const hadSession = this.session !== null;
    this.session = null;
    this.attempts = 0;
    return hadSession;
  }

  private eligible(session: Session): boolean {
    if (this.session !== session) return false;
    try {
      return this.dependencies.isEligible(session);
    } catch {
      return false;
    }
  }

  private attempt(session: Session): void {
    if (!this.eligible(session)) {
      this.cancel(session);
      return;
    }
    if (this.attempts >= Math.max(1, Math.floor(this.maxAttempts))) return;

    this.attempts += 1;
    try {
      const request = this.dependencies.requestState(session);
      void Promise.resolve(request).catch((error) => {
        if (this.session === session) this.dependencies.onRequestError?.(error);
      });
    } catch (error) {
      if (this.session === session) this.dependencies.onRequestError?.(error);
    }

    // requestState may synchronously deliver a state in a test/native shim.
    if (this.session !== session) return;
    if (this.attempts >= Math.max(1, Math.floor(this.maxAttempts))) return;
    this.timer = this.scheduler.schedule(() => {
      if (this.session !== session) return;
      this.timer = null;
      this.attempt(session);
    }, Math.max(0, this.retryDelayMs));
  }
}
