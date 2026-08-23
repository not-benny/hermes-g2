import { Observable } from "@nativescript/core";

import { assistantBridge, type AssistantBridgeState } from "../assistant/bridge-client";
import type {
  HermesCompanionProjection,
  HermesCompanionSession,
  HermesToolActivity,
} from "../hermes-companion/protocol";
import { tryClassifyPhoneWindow } from "./window-layout";

type Visibility = "visible" | "collapse";
type SessionRow = {
  title: string;
  detail: string;
  openVisibility: Visibility;
  resumeVisibility: Visibility;
  cancelVisibility: Visibility;
  actionEnabled: boolean;
  onOpenTap: () => void;
  onResumeTap: () => void;
  onCancelTap: () => void;
};

const visible = (value: boolean): Visibility => value ? "visible" : "collapse";

function whole(value: number): string {
  const digits = String(Math.trunc(value));
  const sign = digits.startsWith("-") ? "-" : "";
  return sign + digits.slice(sign.length).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function ageLabel(timestamp: number | null | undefined, now: number): string {
  if (timestamp === null || timestamp === undefined) return "Never";
  const delta = Math.max(0, now - timestamp);
  if (delta < 60_000) return "Just now";
  if (delta < 60 * 60_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 24 * 60 * 60_000) return `${Math.floor(delta / (60 * 60_000))}h ago`;
  return `${Math.floor(delta / (24 * 60 * 60_000))}d ago`;
}

function money(costMicros: number | undefined, currency: string | undefined): string {
  if (costMicros === undefined || !currency) return "Cost unavailable";
  return `${currency} ${(costMicros / 1_000_000).toFixed(2)}`;
}

export class HermesViewModel extends Observable {
  private companion: HermesCompanionProjection = assistantBridge.companion.snapshot();
  private bridge: AssistantBridgeState = assistantBridge.state();
  private now = Date.now();
  private wide = false;
  private offCompanion: (() => void) | null = null;
  private offBridge: (() => void) | null = null;
  private clock: ReturnType<typeof setInterval> | null = null;

  readonly onRefreshTap = () => { assistantBridge.companion.refresh(); };
  readonly onNewVoiceTap = () => { assistantBridge.companion.newVoiceSession(); };

  activate(): void {
    if (!this.offCompanion) {
      this.offCompanion = assistantBridge.companion.onChange((snapshot) => {
        this.companion = snapshot;
        this.publish();
      });
    }
    if (!this.offBridge) {
      this.offBridge = assistantBridge.onStateChange((state) => {
        this.bridge = state;
        this.publish();
      });
    }
    if (!this.clock) this.clock = setInterval(() => { this.now = Date.now(); this.publish(); }, 30_000);
    this.bridge = assistantBridge.state();
    this.companion = assistantBridge.companion.snapshot();
    this.now = Date.now();
    this.publish();
  }

  deactivate(): void {
    this.offCompanion?.(); this.offCompanion = null;
    this.offBridge?.(); this.offBridge = null;
    if (this.clock) clearInterval(this.clock);
    this.clock = null;
  }

  refreshLayoutMetrics(width: number, height: number): void {
    const layout = tryClassifyPhoneWindow(width, height);
    if (!layout) return;
    const next = layout.widthClass !== "compact";
    if (next === this.wide) return;
    this.wide = next;
    this.notifyPropertyChange("compactVisibility", this.compactVisibility);
    this.notifyPropertyChange("wideVisibility", this.wideVisibility);
  }

  get compactVisibility(): Visibility { return visible(!this.wide); }
  get wideVisibility(): Visibility { return visible(this.wide); }

  private get fresh(): boolean {
    const generated = this.companion.generatedAtMs;
    return generated !== null && generated <= this.now + 5 * 60_000 && this.now <= generated + 2 * 60_000;
  }

  private get available(): boolean {
    return this.bridge.phase === "connected" && this.companion.synchronized && this.fresh &&
      this.companion.data?.status !== "unavailable";
  }

  get statusDotClass(): string { return this.available && this.companion.data?.status === "ready" ? "dot-on" : "dot-off"; }
  get statusLabel(): string {
    if (this.bridge.phase !== "connected") return "Hermes bridge offline";
    if (this.companion.support === "unsupported") return "Hermes companion unavailable";
    if (!this.companion.synchronized) return "Hermes data out of sync";
    if (!this.fresh) return "Hermes data is stale";
    return this.companion.data?.status === "ready" ? "Hermes ready"
      : this.companion.data?.status === "degraded" ? "Hermes degraded" : "Hermes backend unavailable";
  }
  get statusDetail(): string {
    if (this.bridge.phase !== "connected") return "Reconnect the configured private bridge. Actions are disabled and never queued.";
    if (this.companion.support === "unsupported") {
      return "The connected bridge does not advertise Hermes companion support. Actions are disabled.";
    }
    if (!this.companion.synchronized) return "Waiting for a fresh authoritative snapshot. Actions are disabled.";
    if (!this.fresh) return "Snapshot expired. Refresh before starting or changing a session.";
    return `Updated ${ageLabel(this.companion.generatedAtMs, this.now)}`;
  }
  get offlineVisibility(): Visibility { return visible(!this.available); }
  get refreshEnabled(): boolean {
    return this.bridge.phase === "connected" && this.companion.support === "supported" &&
      this.companion.connectionGeneration !== null && !this.pending;
  }

  get modelLabel(): string { return this.companion.data?.model ?? "Not reported"; }
  get profileLabel(): string { return this.companion.data?.profile ?? "Not reported"; }
  get lastConnectionLabel(): string { return ageLabel(this.companion.data?.last_connected_at_ms, this.now); }
  get pending(): boolean { return this.companion.pendingOperations.length > 0; }
  get operationStatusLabel(): string {
    if (this.pending) return "Operation in progress…";
    const receipt = this.companion.lastReceipt;
    if (!receipt) return "No recent operation";
    return `${receipt.operation.replaceAll("_", " ")} · ${receipt.outcome}${receipt.code ? ` (${receipt.code})` : ""}`;
  }

  get voiceVisibility(): Visibility { return visible(Boolean(this.companion.data?.capabilities.voice)); }
  get voiceUnavailableVisibility(): Visibility { return visible(!this.companion.data?.capabilities.voice); }
  get voiceSummaryLabel(): string {
    const voice = this.companion.data?.voice;
    return voice ? `${whole(voice.utterance_count)} utterances · ${Math.round(voice.audio_ms / 60_000)} min captured` : "Not reported";
  }
  get voiceProviderLabel(): string { return this.companion.data?.voice?.stt_provider ?? "Not reported"; }
  get captureStateLabel(): string { return this.companion.data?.voice?.capture_state ?? "Unavailable"; }
  get newVoiceEnabled(): boolean { return this.available && Boolean(this.companion.data?.capabilities.voice) && !this.pending; }

  get usageVisibility(): Visibility { return visible(Boolean(this.companion.data?.capabilities.usage)); }
  get usageUnavailableVisibility(): Visibility { return visible(!this.companion.data?.capabilities.usage); }
  get dayUsageLabel(): string {
    const item = this.companion.data?.usage?.day;
    return item ? `${whole(item.total_tokens)} tokens · ${money(item.cost_micros, item.currency)}` : "Unavailable";
  }
  get weekUsageLabel(): string {
    const item = this.companion.data?.usage?.seven_days;
    return item ? `${whole(item.total_tokens)} tokens · ${money(item.cost_micros, item.currency)}` : "Unavailable";
  }

  get sessions(): SessionRow[] {
    return (this.companion.data?.sessions ?? []).map((session) => this.sessionRow(session));
  }
  get sessionsEmptyVisibility(): Visibility { return visible(this.sessions.length === 0); }

  get activity(): Array<{ label: string; detail: string }> {
    return (this.companion.data?.tool_activity ?? []).map((item) => this.activityRow(item));
  }
  get activityVisibility(): Visibility { return visible(Boolean(this.companion.data?.capabilities.tool_activity)); }
  get activityUnavailableVisibility(): Visibility { return visible(!this.companion.data?.capabilities.tool_activity); }

  get errors(): Array<{ label: string; detail: string }> {
    const errors = [...(this.companion.data?.recent_errors ?? []), ...(this.companion.data?.voice?.recent_failures ?? [])];
    return errors.slice(0, 8).map((item) => ({ label: `${item.code} · ${item.summary}`, detail: ageLabel(item.at_ms, this.now) }));
  }
  get errorsVisibility(): Visibility { return visible(this.errors.length > 0); }

  private sessionRow(session: HermesCompanionSession): SessionRow {
    const actionEnabled = this.available && !this.pending;
    return {
      title: session.title,
      detail: `${session.state} · ${ageLabel(session.updated_at_ms, this.now)}`,
      openVisibility: "visible",
      resumeVisibility: visible(session.state !== "active" && session.resumable),
      cancelVisibility: visible(session.state === "active"),
      actionEnabled,
      onOpenTap: () => assistantBridge.companion.open(session.session_id, session.generation),
      onResumeTap: () => assistantBridge.companion.resume(session.session_id, session.generation),
      onCancelTap: () => assistantBridge.companion.cancel(session.session_id, session.generation),
    };
  }

  private activityRow(item: HermesToolActivity): { label: string; detail: string } {
    return { label: `${item.label} · ${item.status}${item.error_code ? ` (${item.error_code})` : ""}`,
      detail: ageLabel(item.updated_at_ms, this.now) };
  }

  private publish(): void {
    const names = ["statusDotClass", "statusLabel", "statusDetail", "offlineVisibility", "refreshEnabled", "modelLabel",
      "profileLabel", "lastConnectionLabel", "pending", "operationStatusLabel", "voiceVisibility", "voiceUnavailableVisibility",
      "voiceSummaryLabel", "voiceProviderLabel", "captureStateLabel", "newVoiceEnabled", "usageVisibility",
      "usageUnavailableVisibility", "dayUsageLabel", "weekUsageLabel", "sessions", "sessionsEmptyVisibility", "activity",
      "activityVisibility", "activityUnavailableVisibility", "errors", "errorsVisibility"];
    for (const name of names) this.notifyPropertyChange(name, (this as any)[name]);
  }
}
