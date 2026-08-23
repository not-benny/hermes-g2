import {
  HermesCompanionStore,
  type HermesCompanionClientCommand,
  type HermesCompanionProjection,
} from "./protocol";

export class HermesCompanionController {
  private readonly store: HermesCompanionStore;
  private readonly listeners = new Set<(snapshot: HermesCompanionProjection) => void>();

  constructor(
    private readonly sendCommand: (command: HermesCompanionClientCommand) => void,
    options: { createOperationId?: () => string; now?: () => number } = {},
  ) {
    this.store = new HermesCompanionStore(options);
  }

  snapshot(): HermesCompanionProjection { return this.store.snapshot(); }

  onChange(listener: (snapshot: HermesCompanionProjection) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  handleFrame(frame: unknown): boolean {
    if (!this.store.apply(frame)) return false;
    this.publish();
    return true;
  }

  disconnect(): void {
    this.store.markDisconnected();
    this.publish();
  }

  setSupported(supported: boolean): void {
    if (!this.store.setSupported(supported)) return;
    this.publish();
  }

  refresh(): string | null { return this.send(this.store.prepareRefresh()); }
  newVoiceSession(): string | null { return this.send(this.store.prepareNewVoiceSession()); }
  open(sessionId: string, generation: number): string | null { return this.send(this.store.prepareOpen(sessionId, generation)); }
  resume(sessionId: string, generation: number): string | null { return this.send(this.store.prepareResume(sessionId, generation)); }
  cancel(sessionId: string, generation: number): string | null { return this.send(this.store.prepareCancel(sessionId, generation)); }

  private send(command: HermesCompanionClientCommand | null): string | null {
    if (!command) return null;
    this.sendCommand(command);
    this.publish();
    return command.operation_id;
  }

  private publish(): void {
    for (const listener of this.listeners) listener(this.store.snapshot());
  }
}
