import {
  AgentCockpitStore,
  type CockpitClientCommand,
  type CockpitServerFrame,
  type CockpitSnapshot,
} from "./protocol";

export type AgentCockpitControllerOptions = {
  now?: () => number;
  createCommandId?: () => string;
};

export type CockpitAssistantResult = {
  sessionId: string;
  generation: number;
  revision: number;
  text: string;
};

export type CockpitMcpStatus = {
  connectionGeneration: string;
  voiceTurnState: "idle" | "running" | "cancelling";
};

/**
 * Main-isolate authority boundary for the glasses cockpit. It accepts only the
 * protocol store's validated projection and sends only commands constructed by
 * that store. It never queues a mutating intent while disconnected.
 */
export class AgentCockpitController {
  private readonly store: AgentCockpitStore;
  private readonly listeners = new Set<(snapshot: CockpitSnapshot) => void>();
  private readonly resultListeners = new Set<(result: CockpitAssistantResult) => void>();

  constructor(
    private readonly sendCommand: (command: CockpitClientCommand) => void,
    options: AgentCockpitControllerOptions = {},
  ) {
    this.store = new AgentCockpitStore(options);
  }

  snapshot(): CockpitSnapshot {
    return this.store.snapshot();
  }

  onChange(listener: (snapshot: CockpitSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Fresh final assistant rows only; snapshots, tools and reconnects never fire this. */
  onAssistantResult(listener: (result: CockpitAssistantResult) => void): () => void {
    this.resultListeners.add(listener);
    return () => this.resultListeners.delete(listener);
  }

  handleFrame(frame: unknown): boolean {
    const before = this.store.snapshot();
    if (!this.store.apply(frame)) return false;
    const accepted = frame as CockpitServerFrame;
    this.publish();
    if (
      accepted.type === "timeline_append" &&
      accepted.row.kind === "assistant" &&
      accepted.row.status === "done" &&
      !before.sessions.some((session) =>
        session.session_id === accepted.session_id &&
        session.generation === accepted.generation &&
        session.timeline.some((row) => row.id === accepted.row.id))
    ) {
      const result: CockpitAssistantResult = {
        sessionId: accepted.session_id,
        generation: accepted.generation,
        revision: accepted.revision,
        text: accepted.row.text,
      };
      for (const listener of this.resultListeners) listener(result);
    }
    return true;
  }

  /** Apply the status-only Host MCP resource without inventing command authority. */
  handleMcpStatus(status: CockpitMcpStatus): boolean {
    if (!/^[A-Za-z0-9._-]{12,128}$/.test(status.connectionGeneration) ||
        !["idle", "running", "cancelling"].includes(status.voiceTurnState)) return false;
    const applied = this.store.apply({
      v: 1,
      chan: "cockpit",
      type: "snapshot",
      connection_generation: status.connectionGeneration,
      sequence: 0,
      sessions: [],
    });
    if (applied) this.publish();
    return applied;
  }

  disconnect(): void {
    this.store.markDisconnected();
    this.publish();
  }

  answer(sessionId: string, generation: number, requestId: string, choiceId: string): string | null {
    return this.send(this.store.prepareAnswer(sessionId, generation, requestId, choiceId));
  }

  decidePermission(sessionId: string, generation: number, requestId: string,
      decision: "deny" | "allow_once"): string | null {
    return this.send(this.store.preparePermissionDecision(sessionId, generation, requestId, decision));
  }

  steer(sessionId: string, generation: number, text: string): string | null {
    return this.send(this.store.prepareSteer(sessionId, generation, text));
  }

  interrupt(sessionId: string, generation: number): string | null {
    return this.send(this.store.prepareInterrupt(sessionId, generation));
  }

  private send(command: CockpitClientCommand | null): string | null {
    if (!command) return null;
    this.sendCommand(command);
    return command.command_id;
  }

  private publish(): void {
    for (const listener of this.listeners) listener(this.store.snapshot());
  }
}
