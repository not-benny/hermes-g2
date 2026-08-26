import type { CockpitSession, CockpitSnapshot, CockpitSessionState } from "../agent-cockpit/protocol";
import type { AssistantBridgeState } from "../assistant/bridge-client";

export type HermesPhoneStatus = {
  ready: boolean;
  label: string;
  detail: string;
};

export type HermesPhoneSessionRow = {
  title: string;
  stateLabel: string;
  stateClass: string;
  detail: string;
  summary: string;
  summaryVisibility: "visible" | "collapse";
  attentionLabel: string;
  attentionVisibility: "visible" | "collapse";
};

const STATE_LABELS: Record<CockpitSessionState, string> = {
  queued: "Queued",
  running: "Running",
  waiting_human: "Needs you",
  interrupting: "Stopping",
  completed: "Completed",
  failed: "Failed",
  interrupted: "Stopped",
};

const STATE_ORDER: Record<CockpitSessionState, number> = {
  waiting_human: 0,
  running: 1,
  queued: 2,
  interrupting: 3,
  failed: 4,
  completed: 5,
  interrupted: 6,
};

const visible = (value: boolean): "visible" | "collapse" => value ? "visible" : "collapse";

export function relativeAge(timestamp: number | null | undefined, now: number): string {
  if (timestamp === null || timestamp === undefined || !Number.isFinite(timestamp)) return "Never";
  const delta = Math.max(0, now - timestamp);
  if (delta < 60_000) return "Just now";
  if (delta < 60 * 60_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 24 * 60 * 60_000) return `${Math.floor(delta / (60 * 60_000))}h ago`;
  return `${Math.floor(delta / (24 * 60 * 60_000))}d ago`;
}

export function projectHermesStatus(bridge: AssistantBridgeState, cockpit: CockpitSnapshot): HermesPhoneStatus {
  if (bridge.phase === "connecting") {
    return { ready: false, label: "Connecting to Hermes", detail: bridge.status };
  }
  if (bridge.phase === "failed") {
    return { ready: false, label: "Hermes unavailable", detail: bridge.status };
  }
  if (bridge.phase !== "connected") {
    return {
      ready: false,
      label: "Hermes not connected",
      detail: "Configure the private bridge, then return here. No actions are queued while offline.",
    };
  }
  if (!cockpit.synchronized) {
    return {
      ready: false,
      label: "Hermes is synchronizing",
      detail: "The secure bridge is connected. Waiting for an authoritative Host MCP session snapshot.",
    };
  }
  if (!cockpit.commandsAvailable) {
    return {
      ready: true,
      label: "Hermes read-only",
      detail: "The live Cockpit projection is synchronized, but Host MCP is not accepting actions.",
    };
  }
  return {
    ready: true,
    label: "Hermes online",
    detail: "Secure Host MCP and the live Cockpit projection are synchronized.",
  };
}

function latestSummary(session: CockpitSession): string {
  if (session.summary?.trim()) return session.summary.trim();
  const row = [...session.timeline].reverse().find((item) => item.kind !== "tool");
  return row?.text.trim() ?? "";
}

function stateClass(state: CockpitSessionState): string {
  if (state === "waiting_human" || state === "failed") return "hermes-state-chip hermes-state-attention";
  if (state === "running" || state === "completed") return "hermes-state-chip hermes-state-positive";
  return "hermes-state-chip";
}

export function projectHermesSessions(snapshot: CockpitSnapshot, now: number): HermesPhoneSessionRow[] {
  // AgentCockpitStore deliberately retains its last bounded projection across
  // a transient disconnect so a matching snapshot can be reconciled safely.
  // The phone must not present that retained copy as current authority.
  if (!snapshot.synchronized) return [];
  return [...snapshot.sessions]
    .sort((left, right) => STATE_ORDER[left.state] - STATE_ORDER[right.state] || right.updated_at_ms - left.updated_at_ms)
    .map((session) => {
      const summary = latestSummary(session);
      const pending = session.pending.length;
      return {
        title: session.title,
        stateLabel: STATE_LABELS[session.state],
        stateClass: stateClass(session.state),
        detail: `Updated ${relativeAge(session.updated_at_ms, now)}`,
        summary,
        summaryVisibility: visible(Boolean(summary)),
        attentionLabel: pending === 1 ? "1 item needs review on the glasses" : `${pending} items need review on the glasses`,
        attentionVisibility: visible(pending > 0),
      };
    });
}
