import {
  AgentCockpitStore,
  type CockpitClientCommand,
  type CockpitSnapshot,
} from "./protocol";

export type AgentCockpitControllerOptions = {
  now?: () => number;
  createCommandId?: () => string;
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

  handleFrame(frame: unknown): boolean {
    if (!this.store.apply(frame)) return false;
    this.publish();
    return true;
  }

  /** Validate Host MCP health without replacing the separately validated projection. */
  handleMcpStatus(status: CockpitMcpStatus): boolean {
    if (!/^[A-Za-z0-9._-]{12,128}$/.test(status.connectionGeneration) ||
        !["idle", "running", "cancelling"].includes(status.voiceTurnState)) return false;
    return true;
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
