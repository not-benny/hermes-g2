export type ClockAlertWearState = "unknown" | "worn" | "not-worn";
export type ClockAlertKind = "timer" | "alarm";
export type ClockAlertPhase = "idle" | "low" | "high";

export const CLOCK_ALERT_LOW_MS = 60_000;
export const CLOCK_ALERT_WORN_HIGH_MS = 60_000;
export const CLOCK_ALERT_OFF_HEAD_HIGH_MS = 120_000;
export const CLOCK_ALERT_WORN_TOTAL_MS = CLOCK_ALERT_LOW_MS + CLOCK_ALERT_WORN_HIGH_MS;
export const CLOCK_ALERT_OFF_HEAD_TOTAL_MS = CLOCK_ALERT_LOW_MS + CLOCK_ALERT_OFF_HEAD_HIGH_MS;

export type ClockAlertOccurrenceInput = {
  id: string;
  itemId: string;
  kind: ClockAlertKind;
  label: string;
  dueAtMs: number;
};

export type ClockAlertEntry = ClockAlertOccurrenceInput & {
  /** Unknown is extended fail-safe, but only a confirmed OFF_HEAD enables put-on dismissal. */
  extendedForOffHead: boolean;
  confirmedOffHead: boolean;
  /**
   * The campaign clock starts only after firmware accepts the first phrase.
   * `null` keeps a due occurrence pending while the audio session is prepared.
   */
  startedAtMs: number | null;
};

export type ClockAlertProjection = {
  phase: ClockAlertPhase;
  active: ClockAlertEntry[];
  expired: ClockAlertEntry[];
  nextTransitionAtMs: number | null;
};

function isSafeTimestamp(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

/**
 * Pure, absolute-deadline model for the monophonic G2 alert campaign.
 *
 * Each occurrence owns its own 60 s low phase and 60/120 s high phase. The
 * aggregate buzzer takes the loudest current phase; adding a second alarm
 * never restarts or extends an older occurrence. Absolute deadlines also mean
 * reconnect/catch-up can recompute the correct remaining phase without
 * replaying a full campaign.
 */
export class ClockAlertTimeline {
  private readonly entries = new Map<string, ClockAlertEntry>();

  add(
    input: ClockAlertOccurrenceInput,
    wear: ClockAlertWearState,
    startedAtMs: number | null = input.dueAtMs,
  ): boolean {
    if (!input.id || !input.itemId || !isSafeTimestamp(input.dueAtMs) || this.entries.has(input.id)) {
      return false;
    }
    if (startedAtMs !== null && !isSafeTimestamp(startedAtMs)) return false;
    this.entries.set(input.id, {
      ...input,
      extendedForOffHead: wear !== "worn",
      confirmedOffHead: wear === "not-worn",
      startedAtMs,
    });
    return true;
  }

  /** Anchor every newly-due entry to the firmware's accepted enqueue time. */
  startPending(atMs: number): string[] {
    if (!isSafeTimestamp(atMs)) return [];
    const started: string[] = [];
    for (const entry of this.entries.values()) {
      if (entry.startedAtMs !== null) continue;
      entry.startedAtMs = atMs;
      started.push(entry.id);
    }
    return started;
  }

  /**
   * Preserve a complete phrase when the next firmware enqueue is briefly late.
   * This shifts only live campaigns and is called after a positive enqueue.
   */
  shiftStarted(ids: readonly string[], delayMs: number): void {
    if (!Number.isSafeInteger(delayMs) || delayMs <= 0) return;
    for (const id of ids) {
      const entry = this.entries.get(id);
      if (!entry || entry.startedAtMs === null) continue;
      entry.startedAtMs += delayMs;
    }
  }

  restoreRouting(id: string, extendedForOffHead: boolean, confirmedOffHead: boolean): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.extendedForOffHead = extendedForOffHead;
    entry.confirmedOffHead = confirmedOffHead;
  }

  /** Rebase an active campaign from Android's elapsed-realtime projection. */
  restoreTiming(id: string, startedAtMs: number): void {
    if (!isSafeTimestamp(startedAtMs)) return;
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.startedAtMs = startedAtMs;
  }

  remove(ids: readonly string[]): void {
    for (const id of ids) this.entries.delete(id);
  }

  clear(): void {
    this.entries.clear();
  }

  size(): number {
    return this.entries.size;
  }

  entriesSnapshot(): ClockAlertEntry[] {
    return Array.from(this.entries.values(), (entry) => ({ ...entry }));
  }

  /** Apply a confirmed/current wear classification to every sounding item. */
  setWearState(wear: ClockAlertWearState): void {
    for (const entry of this.entries.values()) {
      if (wear === "not-worn") {
        entry.extendedForOffHead = true;
        entry.confirmedOffHead = true;
      } else if (wear === "worn" && !entry.confirmedOffHead) {
        // A first ON_HEAD after unknown is classification, not a put-on edge.
        // It therefore shortens fail-safe unknown routing to the worn deadline.
        entry.extendedForOffHead = false;
      }
    }
  }

  project(nowMs: number): ClockAlertProjection {
    if (!isSafeTimestamp(nowMs)) {
      return { phase: "idle", active: [], expired: this.entriesSnapshot(), nextTransitionAtMs: null };
    }
    const active: ClockAlertEntry[] = [];
    const expired: ClockAlertEntry[] = [];
    let phase: ClockAlertPhase = "idle";
    let nextTransitionAtMs: number | null = null;

    for (const entry of this.entries.values()) {
      const campaignStart = entry.startedAtMs;
      if (campaignStart === null) {
        if (nowMs < entry.dueAtMs) {
          nextTransitionAtMs = nextTransitionAtMs === null
            ? entry.dueAtMs
            : Math.min(nextTransitionAtMs, entry.dueAtMs);
          continue;
        }
        // Preparing/reattaching is still an active low alert, but no duration
        // is consumed until the first exact 60-second phrase is accepted.
        active.push({ ...entry });
        if (phase === "idle") phase = "low";
        continue;
      }
      const lowEndsAt = campaignStart + CLOCK_ALERT_LOW_MS;
      const endsAt = campaignStart + (
        entry.extendedForOffHead ? CLOCK_ALERT_OFF_HEAD_TOTAL_MS : CLOCK_ALERT_WORN_TOTAL_MS
      );
      if (nowMs >= endsAt) {
        expired.push({ ...entry });
        continue;
      }
      // Once firmware has accepted the campaign, its persisted dueAtMs is an
      // immutable occurrence identity, not a wall-clock gate. A manual clock
      // rollback may put `nowMs` before it while elapsed audio must continue.
      active.push({ ...entry });
      const entryPhase: ClockAlertPhase = nowMs < lowEndsAt ? "low" : "high";
      if (entryPhase === "high" || phase === "idle") phase = entryPhase;
      const boundary = entryPhase === "low" ? lowEndsAt : endsAt;
      nextTransitionAtMs = nextTransitionAtMs === null
        ? boundary
        : Math.min(nextTransitionAtMs, boundary);
    }
    return { phase, active, expired, nextTransitionAtMs };
  }
}
