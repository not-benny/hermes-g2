import { Frame, Observable } from "@nativescript/core";

import { assistantBridge, type AssistantBridgeState } from "../assistant/bridge-client";
import type { CockpitSnapshot } from "../agent-cockpit/protocol";
import { tryClassifyPhoneWindow } from "./window-layout";
import {
  projectHermesSessions,
  projectHermesStatus,
  type HermesPhoneSessionRow,
} from "./hermes-phone-projection";

type Visibility = "visible" | "collapse";
const visible = (value: boolean): Visibility => value ? "visible" : "collapse";

/**
 * Read-only phone projection of the same validated Host MCP Cockpit state used
 * by the glasses. The retired Companion WSS channel is intentionally not used:
 * it has no authority or command path in the current MCP-only architecture.
 */
export class HermesViewModel extends Observable {
  private cockpit: CockpitSnapshot = assistantBridge.cockpit.snapshot();
  private bridge: AssistantBridgeState = assistantBridge.state();
  private now = Date.now();
  private wide = false;
  private offCockpit: (() => void) | null = null;
  private offBridge: (() => void) | null = null;
  private clock: ReturnType<typeof setInterval> | null = null;

  readonly onOpenBridgeSettingsTap = () => { Frame.topmost()?.navigate("phone-ui/api-keys-page"); };

  activate(): void {
    if (!this.offCockpit) {
      this.offCockpit = assistantBridge.cockpit.onChange((snapshot) => {
        this.cockpit = snapshot;
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
    this.cockpit = assistantBridge.cockpit.snapshot();
    this.now = Date.now();
    this.publish();
  }

  deactivate(): void {
    this.offCockpit?.(); this.offCockpit = null;
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

  private get status() { return projectHermesStatus(this.bridge, this.cockpit); }
  private get pendingCount(): number {
    if (!this.cockpit.synchronized) return 0;
    return this.cockpit.sessions.reduce((sum, session) => sum + session.pending.length, 0);
  }
  private get activeCount(): number {
    if (!this.cockpit.synchronized) return 0;
    return this.cockpit.sessions.filter((session) =>
      ["queued", "running", "waiting_human", "interrupting"].includes(session.state)).length;
  }

  get statusDotClass(): string { return this.status.ready ? "dot-on" : "dot-off"; }
  get statusLabel(): string { return this.status.label; }
  get statusDetail(): string { return this.status.detail; }
  get offlineVisibility(): Visibility { return visible(!this.status.ready); }
  get connectionLabel(): string {
    if (this.bridge.phase === "connected") return "Secure bridge online";
    if (this.bridge.phase === "connecting") return "Connecting";
    return "Offline";
  }
  get cockpitLabel(): string {
    if (!this.cockpit.synchronized) return "Waiting";
    return this.cockpit.commandsAvailable ? "Synchronized" : "Read only";
  }
  get activeLabel(): string { return `${this.activeCount} active`; }
  get attentionLabel(): string { return `${this.pendingCount} need review`; }
  get sessions(): HermesPhoneSessionRow[] { return projectHermesSessions(this.cockpit, this.now); }
  get sessionsEmptyVisibility(): Visibility { return visible(this.sessions.length === 0); }
  get sessionsVisibility(): Visibility { return visible(this.sessions.length > 0); }
  get lastReceiptVisibility(): Visibility {
    return visible(this.cockpit.synchronized && Boolean(this.cockpit.lastReceipt));
  }
  get lastReceiptLabel(): string {
    if (!this.cockpit.synchronized) return "";
    const receipt = this.cockpit.lastReceipt;
    if (!receipt) return "";
    return `Last glasses action: ${receipt.outcome.replaceAll("_", " ")}${receipt.code ? ` (${receipt.code})` : ""}`;
  }

  private publish(): void {
    const names = [
      "statusDotClass", "statusLabel", "statusDetail", "offlineVisibility", "connectionLabel", "cockpitLabel",
      "activeLabel", "attentionLabel", "sessions", "sessionsEmptyVisibility", "sessionsVisibility",
      "lastReceiptVisibility", "lastReceiptLabel",
    ];
    for (const name of names) this.notifyPropertyChange(name, (this as any)[name]);
  }
}
