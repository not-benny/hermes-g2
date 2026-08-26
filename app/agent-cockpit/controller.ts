import {
  AgentCockpitStore,
  type CockpitClientCommand,
  type CockpitCommandOutcome,
  type CockpitServerFrame,
  type CockpitSnapshot,
  validateCockpitFrame,
} from "./protocol";

export type AgentCockpitControllerOptions = {
  now?: () => number;
  createCommandId?: () => string;
  /** Requests one authoritative Host MCP status/snapshot refresh. */
  requestResync?: () => boolean | void;
};

export type CockpitMcpStatus = {
  connectionGeneration: string;
  voiceTurnState: "idle" | "running" | "cancelling";
  commandsAvailable: boolean;
};

/**
 * Main-isolate authority boundary for the glasses cockpit. It accepts only the
 * protocol store's validated projection and sends only commands constructed by
 * that store. It never queues a mutating intent while disconnected.
 */
export class AgentCockpitController {
  private readonly store: AgentCockpitStore;
  private readonly listeners = new Set<(snapshot: CockpitSnapshot) => void>();
  private expectedConnectionGeneration: string | null = null;
  private commandsAvailable = false;
  /** Coalesces repeated invalid frames until a matching snapshot repairs state. */
  private resyncRequested = false;
  private readonly requestResync: () => boolean | void;

  constructor(
    private readonly sendCommand: (command: CockpitClientCommand) => boolean | void,
    options: AgentCockpitControllerOptions = {},
  ) {
    this.store = new AgentCockpitStore(options);
    this.requestResync = options.requestResync ?? (() => false);
  }

  snapshot(): CockpitSnapshot {
    return this.store.snapshot();
  }

  onChange(listener: (snapshot: CockpitSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  handleFrame(frame: unknown, snapshotReadEpoch?: number): boolean {
    if (validateCockpitFrame(frame) !== null) return this.rejectFrame();
    const validated = frame as CockpitServerFrame;
    if (validated.type === "snapshot" &&
        (this.expectedConnectionGeneration === null ||
         validated.connection_generation !== this.expectedConnectionGeneration)) return this.rejectFrame();
    if (!this.store.apply(validated, validated.type === "snapshot" ? snapshotReadEpoch : undefined)) {
      return this.rejectFrame();
    }
    if (validated.type === "snapshot") this.resyncRequested = false;
    this.publish();
    return true;
  }

  /** Bind the projection to the opaque generation in the strict Host MCP status resource. */
  handleMcpStatus(status: CockpitMcpStatus): boolean {
    if (!/^[A-Za-z0-9._-]{12,128}$/.test(status.connectionGeneration) ||
        !["idle", "running", "cancelling"].includes(status.voiceTurnState) ||
        typeof status.commandsAvailable !== "boolean") return false;
    const changed = this.expectedConnectionGeneration !== status.connectionGeneration;
    this.expectedConnectionGeneration = status.connectionGeneration;
    this.commandsAvailable = status.commandsAvailable;
    const commandsChanged = this.store.setCommandsAvailable(status.commandsAvailable);
    const snapshot = this.store.snapshot();
    let published = false;
    if (snapshot.connectionGeneration !== null &&
        snapshot.connectionGeneration !== status.connectionGeneration) {
      this.store.markDisconnected();
      this.resyncRequested = false;
      this.scheduleResync();
      this.publish();
      published = true;
    } else if (changed && !snapshot.synchronized) {
      this.resyncRequested = false;
      this.scheduleResync();
    }
    // Before the first authoritative snapshot, status is only a capability
    // gate; publishing that intermediate state would make the UI observe a
    // phantom empty projection. Once synchronized, a capability transition
    // is meaningful and should be reflected immediately.
    if (commandsChanged && !published && snapshot.synchronized) this.publish();
    return true;
  }

  /** Resolve a sent command whose exact Host MCP response became unknowable. */
  handleCommandOutcome(
    outcome: CockpitCommandOutcome,
    minimumSnapshotReadEpoch: number | null = null,
  ): boolean {
    if (!this.store.recordCommandOutcome(outcome,
      minimumSnapshotReadEpoch === null ? {} : { minimumSnapshotReadEpoch })) return false;
    this.commandsAvailable = false;
    this.store.setCommandsAvailable(false);
    this.store.markDisconnected();
    this.resyncRequested = false;
    this.scheduleResync();
    this.publish();
    return true;
  }

  /** Fail closed without retiring the current Host MCP generation. */
  unavailable(): void {
    this.commandsAvailable = false;
    this.store.setCommandsAvailable(false);
    this.store.markDisconnected();
    this.resyncRequested = false;
    this.scheduleResync();
    this.publish();
  }

  disconnect(): void {
    this.expectedConnectionGeneration = null;
    this.commandsAvailable = false;
    this.store.setCommandsAvailable(false);
    this.resyncRequested = false;
    this.store.markDisconnected();
    this.publish();
  }

  answer(sessionId: string, generation: number, requestId: string, choiceId: string,
      reviewedNonce: string, reviewedFingerprint: string): string | null {
    if (!this.commandsAvailable) return null;
    return this.send(this.store.prepareAnswer(sessionId, generation, requestId, choiceId,
      reviewedNonce, reviewedFingerprint));
  }

  answerText(sessionId: string, generation: number, requestId: string, value: string,
      reviewedNonce: string, reviewedFingerprint: string): string | null {
    if (!this.commandsAvailable) return null;
    return this.send(this.store.prepareAnswerText(sessionId, generation, requestId, value,
      reviewedNonce, reviewedFingerprint));
  }

  decidePermission(sessionId: string, generation: number, requestId: string,
      decision: "deny" | "allow_once", reviewedNonce: string, reviewedFingerprint: string): string | null {
    if (!this.commandsAvailable) return null;
    return this.send(this.store.preparePermissionDecision(sessionId, generation, requestId, decision,
      reviewedNonce, reviewedFingerprint));
  }

  steer(sessionId: string, generation: number, text: string): string | null {
    if (!this.commandsAvailable) return null;
    return this.send(this.store.prepareSteer(sessionId, generation, text));
  }

  interrupt(sessionId: string, generation: number): string | null {
    if (!this.commandsAvailable) return null;
    return this.send(this.store.prepareInterrupt(sessionId, generation));
  }

  private send(command: CockpitClientCommand | null): string | null {
    if (!command) return null;
    // A synchronized projection can race a transport teardown by one input
    // turn. Do not enter the glasses' receipt-waiting screen unless Host MCP
    // actually accepted the request for transmission; fail closed and require
    // a fresh snapshot instead of leaving Cockpit stuck on "SENDING" forever.
    if (this.sendCommand(command) === false) {
      this.store.releaseUnsent(command);
      this.commandsAvailable = false;
      this.store.setCommandsAvailable(false);
      this.store.markDisconnected();
      this.resyncRequested = false;
      this.scheduleResync();
      this.publish();
      return null;
    }
    return command.command_id;
  }

  private publish(): void {
    const snapshot = this.store.snapshot();
    for (const listener of this.listeners) {
      try { listener(snapshot); } catch { /* listeners cannot break authority state */ }
    }
  }

  private rejectFrame(): false {
    // Validation/sequence failure invalidates both projection and the last
    // capability observation. A snapshot and status reread race independently;
    // never let a snapshot that wins that race reopen actions using stale
    // pre-failure commandsAvailable=true.
    this.commandsAvailable = false;
    this.store.setCommandsAvailable(false);
    this.store.markDisconnected();
    // A rejection can itself be the response to an already-latched recovery
    // read. Re-arm before requesting again so Host MCP coalesces a status read
    // begun after this failure and suppresses the older in-flight response.
    this.resyncRequested = false;
    this.scheduleResync();
    this.publish();
    return false;
  }

  private scheduleResync(): void {
    if (this.expectedConnectionGeneration === null || this.resyncRequested) return;
    this.resyncRequested = true;
    try {
      if (this.requestResync() === false) this.resyncRequested = false;
    } catch {
      this.resyncRequested = false;
    }
  }
}
