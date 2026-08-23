export type DebugControlState = {
  online: boolean;
  screenOn: boolean;
  windowId: string;
  processGeneration: string;
  sessionGeneration: number;
  windowGeneration: number;
  captureGeneration: number;
  voiceTest: boolean;
};

export type DebugFixtureResult = { endpoint: boolean; transcript: "empty" | "nonempty" };

export type DebugControlDependencies = {
  state(): DebugControlState;
  wake(): Promise<void>;
  blank(): Promise<void>;
  open(appId: string): Promise<void>;
  voiceStart(endpointing: boolean): Promise<void>;
  voiceStop(): Promise<void>;
  fixture(fixture: string): Promise<DebugFixtureResult>;
};

type RecordValue = Record<string, unknown>;

const COMMANDS = new Set([
  "state", "display.wake", "display.blank", "window.open",
  "voice.start", "voice.stop", "voice.fixture",
]);
const APPS = new Set([
  "launcher", "health", "timer", "terminal", "files", "music", "nightscout",
  "transcribe", "notifications", "calendar", "weather", "navigate", "compass",
  "roam", "blocks", "minesweeper", "freecell", "pinball", "debug-tests", "settings",
  "universal-search", "agent-cockpit",
]);
const FIXTURES = new Set(["silence-1s", "speech-envelope-then-silence"]);
const BASE_KEYS = ["v", "id", "command", "processGeneration", "sessionGeneration", "windowGeneration", "captureGeneration", "args"];
const QUERY_KEYS = ["v", "id", "command", "args"];
const MAX_ENVELOPE_CHARS = 2048;
const MAX_QUERY_REPLAY_IDS = 128;
const MAX_MUTATION_REPLAY_IDS = 1024;

function object(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: RecordValue, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function failure(code: string): RecordValue {
  return { ok: false, code };
}

export class DebugControlHarness {
  private readonly mutationSeen = new Set<string>();
  private readonly querySeen = new Set<string>();
  private readonly querySeenOrder: string[] = [];
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly deps: DebugControlDependencies) {}

  replaySize(): number {
    return this.mutationSeen.size + this.querySeen.size;
  }

  async cleanup(): Promise<void> {
    const result = this.queue.then(() => this.cleanupNow());
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async cleanupNow(): Promise<void> {
    if (this.deps.state().voiceTest) {
      try { await this.deps.voiceStop(); } catch { /* fail closed during teardown */ }
    }
    this.mutationSeen.clear();
    this.querySeen.clear();
    this.querySeenOrder.length = 0;
  }

  async dispatch(raw: string): Promise<RecordValue> {
    const result = this.queue.then(() => this.dispatchNow(raw));
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async dispatchNow(raw: string): Promise<RecordValue> {
    if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_ENVELOPE_CHARS) return failure("malformed");
    let value: unknown;
    try { value = JSON.parse(raw); } catch { return failure("malformed"); }
    if (!object(value) || value.v !== 1 || typeof value.command !== "string" || !COMMANDS.has(value.command)) {
      return failure("malformed");
    }
    const query = value.command === "state";
    if (!exactKeys(value, query ? QUERY_KEYS : BASE_KEYS) || !object(value.args)) return failure("malformed");
    if (typeof value.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value.id)) return failure("malformed");
    if (this.mutationSeen.has(value.id) || this.querySeen.has(value.id)) return failure("replay");

    const args = value.args;
    if (!this.validArgs(value.command, args)) return failure("malformed");
    if (!this.remember(value.id, query)) return failure("capacity");
    const current = this.deps.state();
    if (query) return { ok: true, command: "state", state: current };
    if (!this.boundTo(value, current)) return failure("stale");
    if (!current.online) return failure("offline");
    if (value.command === "voice.fixture" && !current.voiceTest) return failure("capture-offline");
    if (value.command === "voice.stop" && !current.voiceTest) return failure("capture-offline");
    if (value.command === "voice.start" && current.voiceTest) return failure("capture-active");

    try {
      let result: DebugFixtureResult | undefined;
      switch (value.command) {
        case "display.wake": await this.deps.wake(); break;
        case "display.blank": await this.deps.blank(); break;
        case "window.open": await this.deps.open(args.appId as string); break;
        case "voice.start": await this.deps.voiceStart(args.endpointing as boolean); break;
        case "voice.stop": await this.deps.voiceStop(); break;
        case "voice.fixture": result = await this.deps.fixture(args.fixture as string); break;
      }
      const receipt: RecordValue = { ok: true, command: value.command, state: this.deps.state() };
      if (result) receipt.result = result;
      return receipt;
    } catch {
      return failure("failed");
    }
  }

  private validArgs(command: string, args: RecordValue): boolean {
    switch (command) {
      case "state":
      case "display.wake":
      case "display.blank":
      case "voice.stop": return exactKeys(args, []);
      case "window.open": return exactKeys(args, ["appId"]) && typeof args.appId === "string" && APPS.has(args.appId);
      case "voice.start": return exactKeys(args, ["endpointing"]) && typeof args.endpointing === "boolean";
      case "voice.fixture": return exactKeys(args, ["fixture"]) && typeof args.fixture === "string" && FIXTURES.has(args.fixture);
      default: return false;
    }
  }

  private boundTo(request: RecordValue, state: DebugControlState): boolean {
    return request.processGeneration === state.processGeneration &&
      request.sessionGeneration === state.sessionGeneration &&
      request.windowGeneration === state.windowGeneration &&
      request.captureGeneration === state.captureGeneration;
  }

  private remember(id: string, query: boolean): boolean {
    if (!query) {
      if (this.mutationSeen.size >= MAX_MUTATION_REPLAY_IDS) return false;
      this.mutationSeen.add(id);
      return true;
    }
    this.querySeen.add(id);
    this.querySeenOrder.push(id);
    if (this.querySeenOrder.length > MAX_QUERY_REPLAY_IDS) {
      const oldest = this.querySeenOrder.shift();
      if (oldest) this.querySeen.delete(oldest);
    }
    return true;
  }
}
