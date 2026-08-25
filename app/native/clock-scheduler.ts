import { Utils } from "@nativescript/core";
import type {
  ClockElapsedTimerDeadline,
  ClockNativeFire,
  ClockScheduledItem,
} from "../clock/store";

declare const com: any;

export type ClockNativeDueEvent = ClockNativeFire;
export type ClockNativeTimeChangeEvent = { action: string };
export type ClockCampaignAckInput = {
  phase: "low" | "high";
  occurrences: Array<{
    occurrenceId: string;
    itemId: string;
    dueAtMs: number;
    extendedForOffHead: boolean;
    confirmedOffHead: boolean;
  }>;
};
export type ClockCampaignState = ClockCampaignAckInput["occurrences"][number] & {
  startedAtMs: number;
  phraseEndsAtMs: number;
  phase: "low" | "high";
};

function context(): android.content.Context | null {
  if (!global.isAndroid) return null;
  return Utils.android.getApplicationContext() ?? null;
}

class ClockSchedulerBridge {
  private listener: ((event: ClockNativeDueEvent) => void) | null = null;
  private timeChangeListener: ((event: ClockNativeTimeChangeEvent) => void) | null = null;
  private nativeListener: any = null;

  onDue(listener: ((event: ClockNativeDueEvent) => void) | null): void {
    this.listener = listener;
    if (!global.isAndroid) return;
    if (!listener) {
      com.faceclaw.app.FaceclawClockScheduler.setListener(null);
      this.nativeListener = null;
      return;
    }
    if (!this.nativeListener) {
      this.nativeListener = new com.faceclaw.app.FaceclawClockAlarmListener({
        onClockAlarm: (
          itemId: string,
          kind: string,
          dueAtMs: number,
          scheduleGeneration: number,
        ) => {
          const event = {
            itemId: String(itemId),
            kind: kind === "alarm" ? "alarm" as const : "timer" as const,
            dueAtMs: Number(dueAtMs),
            scheduleGeneration: Number(scheduleGeneration),
          };
          setTimeout(() => this.listener?.(event), 0);
        },
        onClockTimeChanged: (action: string) => {
          const event = { action: String(action) };
          setTimeout(() => this.timeChangeListener?.(event), 0);
        },
      });
    }
    com.faceclaw.app.FaceclawClockScheduler.setListener(this.nativeListener);
  }

  onTimeChanged(listener: ((event: ClockNativeTimeChangeEvent) => void) | null): void {
    this.timeChangeListener = listener;
  }

  /** Replace the complete AlarmManager mirror; ClockStore remains authoritative. */
  sync(items: readonly ClockScheduledItem[]): void {
    const appContext = context();
    if (!appContext) return;
    const records = items.slice(0, 128).map((item) => ({
      itemId: item.itemId,
      kind: item.kind,
      nextFireAtMs: item.nextFireAtMs,
      localTime: item.kind === "alarm" ? item.localTime : "",
      date: item.kind === "alarm" ? (item.date ?? "") : "",
      repeatDays: item.kind === "alarm" ? item.repeatDays : [],
      durationSeconds: item.kind === "timer" ? item.durationSeconds : 0,
      scheduleGeneration: item.scheduleGeneration,
    }));
    com.faceclaw.app.FaceclawClockScheduler.replaceAll(appContext, JSON.stringify(records));
  }

  pendingFires(): ClockNativeFire[] {
    const appContext = context();
    if (!appContext) return [];
    const parsed: unknown = JSON.parse(String(
      com.faceclaw.app.FaceclawClockScheduler.pendingFiresJson(appContext),
    ));
    if (!Array.isArray(parsed) || parsed.length > 128) throw new Error("invalid native Clock fire inbox");
    return parsed.map((value) => {
      if (!value || typeof value !== "object") throw new Error("invalid native Clock fire");
      const itemId = String((value as { itemId?: unknown }).itemId ?? "");
      const kind = (value as { kind?: unknown }).kind;
      const dueAtMs = Number((value as { dueAtMs?: unknown }).dueAtMs);
      const scheduleGeneration = Number((value as { scheduleGeneration?: unknown }).scheduleGeneration);
      if (!/^clk_[a-f0-9]{32}$/.test(itemId) || (kind !== "timer" && kind !== "alarm") ||
          !Number.isSafeInteger(dueAtMs) || dueAtMs < 0 ||
          !Number.isSafeInteger(scheduleGeneration) || scheduleGeneration < 1) {
        throw new Error("invalid native Clock fire");
      }
      return { itemId, kind, dueAtMs, scheduleGeneration };
    });
  }

  acknowledgeFire(fire: ClockNativeFire): boolean {
    const appContext = context();
    if (!appContext) return true;
    return Boolean(com.faceclaw.app.FaceclawClockScheduler.acknowledgePendingFire(
      appContext, fire.itemId, Math.round(fire.dueAtMs),
    ));
  }

  isFireCurrent(fire: ClockNativeFire): boolean {
    const appContext = context();
    if (!appContext) return true;
    return Boolean(com.faceclaw.app.FaceclawClockScheduler.isPendingFireCurrent(
      appContext,
      fire.itemId,
      fire.kind,
      Math.round(fire.dueAtMs),
      Math.round(fire.scheduleGeneration),
    ));
  }

  timerDeadlines(): ClockElapsedTimerDeadline[] | null {
    const appContext = context();
    if (!appContext) return null;
    const parsed: unknown = JSON.parse(String(
      com.faceclaw.app.FaceclawClockScheduler.timerDeadlinesJson(appContext),
    ));
    if (!Array.isArray(parsed) || parsed.length > 64) throw new Error("invalid native timer deadlines");
    return parsed.map((value) => {
      if (!value || typeof value !== "object") throw new Error("invalid native timer deadline");
      const itemId = String((value as { itemId?: unknown }).itemId ?? "");
      const nextFireAtMs = Number((value as { nextFireAtMs?: unknown }).nextFireAtMs);
      const scheduleGeneration = Number((value as { scheduleGeneration?: unknown }).scheduleGeneration);
      if (!/^clk_[a-f0-9]{32}$/.test(itemId) || !Number.isSafeInteger(nextFireAtMs) || nextFireAtMs < 0 ||
          !Number.isSafeInteger(scheduleGeneration) || scheduleGeneration < 1) {
        throw new Error("invalid native timer deadline");
      }
      return { itemId, nextFireAtMs, scheduleGeneration };
    });
  }

  setRecoveryLease(active: boolean): void {
    const appContext = context();
    if (!appContext) return;
    com.faceclaw.app.FaceclawClockScheduler.setRecoveryLease(appContext, Boolean(active));
  }

  campaigns(): ClockCampaignState[] {
    const appContext = context();
    if (!appContext) return [];
    const parsed: unknown = JSON.parse(String(
      com.faceclaw.app.FaceclawClockScheduler.campaignsJson(appContext),
    ));
    if (!Array.isArray(parsed) || parsed.length > 128) throw new Error("invalid native Clock campaigns");
    return parsed.map((value) => {
      if (!value || typeof value !== "object") throw new Error("invalid native Clock campaign");
      const item = value as Record<string, unknown>;
      const occurrenceId = String(item.occurrenceId ?? "");
      const itemId = String(item.itemId ?? "");
      const dueAtMs = Number(item.dueAtMs);
      const startedAtMs = Number(item.startedAtMs);
      const phraseEndsAtMs = Number(item.phraseEndsAtMs);
      const phase = item.phase;
      if (!/^occ_[a-f0-9]{32}$/.test(occurrenceId) || !/^clk_[a-f0-9]{32}$/.test(itemId) ||
          !Number.isSafeInteger(dueAtMs) || dueAtMs < 0 ||
          !Number.isSafeInteger(startedAtMs) || startedAtMs < 0 ||
          !Number.isSafeInteger(phraseEndsAtMs) || phraseEndsAtMs < startedAtMs ||
          (phase !== "low" && phase !== "high") ||
          typeof item.extendedForOffHead !== "boolean" || typeof item.confirmedOffHead !== "boolean") {
        throw new Error("invalid native Clock campaign");
      }
      return {
        occurrenceId, itemId, dueAtMs, startedAtMs, phraseEndsAtMs, phase,
        extendedForOffHead: item.extendedForOffHead,
        confirmedOffHead: item.confirmedOffHead,
      };
    });
  }

  clearCampaigns(occurrenceIds: readonly string[]): boolean {
    if (!occurrenceIds.length) return true;
    const appContext = context();
    if (!appContext) return true;
    return Boolean(com.faceclaw.app.FaceclawClockScheduler.clearCampaigns(
      appContext, JSON.stringify([...occurrenceIds]),
    ));
  }

  /**
   * Persist a confirmed wear-route change without waiting for the next phrase.
   * This closes the process-death window between an OFF_HEAD event and the
   * following firmware buzzer acknowledgement.
   */
  updateCampaignRouting(entries: readonly {
    id: string;
    extendedForOffHead: boolean;
    confirmedOffHead: boolean;
  }[]): boolean {
    if (!entries.length) return true;
    const appContext = context();
    if (!appContext) return true;
    const encoded = entries.slice(0, 128).map((entry) => ({
      occurrenceId: entry.id,
      extendedForOffHead: entry.extendedForOffHead,
      confirmedOffHead: entry.confirmedOffHead,
    }));
    return Boolean(com.faceclaw.app.FaceclawClockScheduler.updateCampaignRouting(
      appContext,
      JSON.stringify(encoded),
    ));
  }

  dismissNotification(itemId: string, dueAtMs: number): void {
    const appContext = context();
    if (!appContext) return;
    com.faceclaw.app.FaceclawClockScheduler.dismissNotification(
      appContext,
      String(itemId),
      Math.round(dueAtMs),
    );
  }

  canScheduleExactAlarms(): boolean {
    const appContext = context();
    if (!appContext) return true;
    return Boolean(com.faceclaw.app.FaceclawClockScheduler.canScheduleExactAlarms(appContext));
  }
}

export const clockSchedulerBridge = new ClockSchedulerBridge();
