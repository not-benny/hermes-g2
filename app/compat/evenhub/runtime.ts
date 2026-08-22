import {
  BUNDLED_COUNTER_PACKAGE,
  EVENHUB_MAX_STORAGE_BYTES,
  EVENHUB_MAX_STORAGE_KEYS,
  EVENHUB_MAX_TIMERS,
  LOCAL_ONLY_PERMISSIONS,
  type EvenHubCompatPackage,
  type EvenHubPermission,
  type EvenHubRequest,
  type EvenHubView,
  utf8Bytes,
  validateEvenHubRequest,
  validatePackageManifest,
} from "./protocol";

type TimerHandle = unknown;

type RuntimeDependencies = {
  render: (view: EvenHubView) => void;
  readStorage: (namespace: string) => string | null;
  writeStorage: (namespace: string, document: string) => void;
  removeStorage: (namespace: string) => void;
  onEvent?: () => void;
  setTimer?: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
};

export type EvenHubHostEvent =
  | { type: "input"; generation: number; input: "click" | "scroll-up" | "scroll-down" }
  | { type: "timer.fired"; generation: number; timerId: string };

export type EvenHubDispatchResult = { ok: true; value?: string | null } | { ok: false; error: string };

type Session = {
  readonly generation: number;
  readonly package: EvenHubCompatPackage;
  readonly grants: ReadonlySet<EvenHubPermission>;
  readonly namespace: string;
  readonly storage: Map<string, string>;
  readonly usedRequestIds: Set<string>;
  readonly timers: Map<string, TimerHandle>;
  readonly events: EvenHubHostEvent[];
  closed: boolean;
  foreground: boolean;
  screenOn: boolean;
};

let nextProcessGeneration = 0;

function cloneView(view: EvenHubView): EvenHubView {
  return {
    title: view.title,
    blocks: view.blocks.map((block) => ({ ...block })),
    actions: view.actions.map((action) => ({ ...action })),
  };
}

function parseStorageDocument(value: string | null): Map<string, string> {
  if (!value || utf8Bytes(value) > EVENHUB_MAX_STORAGE_BYTES) return new Map();
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return new Map();
    const entries = Object.entries(parsed as Record<string, unknown>);
    if (entries.length > EVENHUB_MAX_STORAGE_KEYS) return new Map();
    const result = new Map<string, string>();
    for (const [key, item] of entries) {
      if (!/^[A-Za-z0-9._-]{1,64}$/.test(key) || typeof item !== "string" || utf8Bytes(item) > 2 * 1024) return new Map();
      result.set(key, item);
    }
    return result;
  } catch {
    return new Map();
  }
}

/**
 * A one-session, local-only interpreter boundary for reviewed bundled packages.
 * It deliberately has no WebView, network, filesystem, sensor, assistant-tool,
 * or dynamic-code capability.
 */
export class EvenHubCompatRuntime {
  private active: Session | null = null;
  private readonly setTimer: (callback: () => void, delayMs: number) => TimerHandle;
  private readonly clearTimer: (handle: TimerHandle) => void;

  constructor(private readonly deps: RuntimeDependencies) {
    this.setTimer = deps.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  open(pkg: EvenHubCompatPackage, grants: ReadonlySet<EvenHubPermission>): number {
    const manifestError = validatePackageManifest(pkg.manifest);
    if (manifestError) throw new Error(`invalid bundled package: ${manifestError}`);
    if (pkg !== BUNDLED_COUNTER_PACKAGE || pkg.manifest.contentSha256 !== BUNDLED_COUNTER_PACKAGE.manifest.contentSha256 ||
        pkg.canonicalContent !== BUNDLED_COUNTER_PACKAGE.canonicalContent) throw new Error("package identity is not allowlisted");
    for (const grant of grants) {
      if (!LOCAL_ONLY_PERMISSIONS.includes(grant) || !pkg.manifest.permissions.includes(grant)) throw new Error("permission grant is not requested and allowlisted");
    }
    if (this.active) this.close(this.active.generation);
    if (nextProcessGeneration >= Number.MAX_SAFE_INTEGER) throw new Error("session generation exhausted");
    const generation = ++nextProcessGeneration;
    const namespace = `evenhub.compat.storage.v1.${pkg.manifest.packageId}.${pkg.manifest.contentSha256.slice(0, 16)}`;
    this.active = {
      generation,
      package: pkg,
      grants: new Set(grants),
      namespace,
      storage: parseStorageDocument(this.deps.readStorage(namespace)),
      usedRequestIds: new Set(),
      timers: new Map(),
      events: [],
      closed: false,
      foreground: true,
      screenOn: true,
    };
    return generation;
  }

  isLive(generation: number): boolean {
    return this.active?.generation === generation && !this.active.closed;
  }

  dispatch(value: unknown): EvenHubDispatchResult {
    const validation = validateEvenHubRequest(value);
    if (validation) return { ok: false, error: validation };
    const request = value as EvenHubRequest;
    const session = this.liveSession(request.generation);
    if (!session) return { ok: false, error: "session generation is stale" };
    if (session.usedRequestIds.has(request.requestId)) return { ok: false, error: "requestId was replayed" };
    if (session.usedRequestIds.size >= 256) return { ok: false, error: "request budget exhausted" };
    session.usedRequestIds.add(request.requestId);

    try {
      switch (request.method) {
      case "display.set":
        if (!this.allowed(session, "display") || !session.foreground || !session.screenOn) return { ok: false, error: "display is not live and permitted" };
        this.deps.render(cloneView(request.params.view as EvenHubView));
        return { ok: true };
      case "storage.get":
        if (!this.allowed(session, "storage")) return { ok: false, error: "storage permission denied" };
        return { ok: true, value: session.storage.get(request.params.key as string) ?? null };
      case "storage.set":
        if (!this.allowed(session, "storage")) return { ok: false, error: "storage permission denied" };
        return this.setStorage(session, request.params.key as string, request.params.value as string);
      case "storage.remove":
        if (!this.allowed(session, "storage")) return { ok: false, error: "storage permission denied" };
        return this.removeStorageKey(session, request.params.key as string);
      case "timer.set":
        if (!this.allowed(session, "timers") || !session.foreground || !session.screenOn) return { ok: false, error: "timers are not live and permitted" };
        return this.armTimer(session, request.params.timerId as string, request.params.delayMs as number);
      case "timer.clear":
        if (!this.allowed(session, "timers")) return { ok: false, error: "timers permission denied" };
        this.clearNamedTimer(session, request.params.timerId as string);
        return { ok: true };
      }
    } catch {
      return { ok: false, error: "host operation failed" };
    }
  }

  setForeground(generation: number, foreground: boolean): boolean {
    const session = this.liveSession(generation);
    if (!session) return false;
    session.foreground = foreground;
    if (!foreground) this.clearTimers(session);
    return true;
  }

  setScreenOn(generation: number, screenOn: boolean): boolean {
    const session = this.liveSession(generation);
    if (!session) return false;
    session.screenOn = screenOn;
    if (!screenOn) this.clearTimers(session);
    return true;
  }

  handleInput(generation: number, input: "click" | "scroll-up" | "scroll-down"): boolean {
    const session = this.liveSession(generation);
    if (!session || !session.foreground || !session.screenOn || !this.allowed(session, "input")) return false;
    this.enqueue(session, { type: "input", generation, input });
    return true;
  }

  drainEvents(generation: number): EvenHubHostEvent[] {
    const session = this.liveSession(generation);
    if (!session) return [];
    return session.events.splice(0);
  }

  clearStorage(generation: number): boolean {
    const session = this.liveSession(generation);
    if (!session || !this.allowed(session, "storage")) return false;
    try {
      this.deps.removeStorage(session.namespace);
      session.storage.clear();
      return true;
    } catch {
      return false;
    }
  }

  close(generation: number): boolean {
    const session = this.active;
    if (!session || session.generation !== generation || session.closed) return false;
    session.closed = true;
    this.active = null;
    this.clearTimers(session);
    session.events.length = 0;
    return true;
  }

  private liveSession(generation: number): Session | null {
    const session = this.active;
    return session && !session.closed && session.generation === generation ? session : null;
  }

  private allowed(session: Session, permission: EvenHubPermission): boolean {
    return session.package.manifest.permissions.includes(permission) && session.grants.has(permission);
  }

  private setStorage(session: Session, key: string, value: string): EvenHubDispatchResult {
    if (!session.storage.has(key) && session.storage.size >= EVENHUB_MAX_STORAGE_KEYS) return { ok: false, error: "storage key limit exceeded" };
    const candidate = Object.fromEntries(session.storage);
    candidate[key] = value;
    const document = JSON.stringify(candidate);
    if (utf8Bytes(document) > EVENHUB_MAX_STORAGE_BYTES) return { ok: false, error: "storage quota exceeded" };
    this.deps.writeStorage(session.namespace, document);
    session.storage.set(key, value);
    return { ok: true };
  }

  private removeStorageKey(session: Session, key: string): EvenHubDispatchResult {
    if (!session.storage.has(key)) return { ok: true };
    const candidate = new Map(session.storage);
    candidate.delete(key);
    if (candidate.size === 0) this.deps.removeStorage(session.namespace);
    else this.deps.writeStorage(session.namespace, JSON.stringify(Object.fromEntries(candidate)));
    session.storage.delete(key);
    return { ok: true };
  }

  private armTimer(session: Session, timerId: string, delayMs: number): EvenHubDispatchResult {
    if (!session.timers.has(timerId) && session.timers.size >= EVENHUB_MAX_TIMERS) return { ok: false, error: "timer limit exceeded" };
    this.clearNamedTimer(session, timerId);
    const handle = this.setTimer(() => {
      if (this.active !== session || session.closed || !session.foreground || !session.screenOn || session.timers.get(timerId) !== handle) return;
      session.timers.delete(timerId);
      this.enqueue(session, { type: "timer.fired", generation: session.generation, timerId });
    }, delayMs);
    session.timers.set(timerId, handle);
    return { ok: true };
  }

  private clearNamedTimer(session: Session, timerId: string): void {
    const handle = session.timers.get(timerId);
    if (handle === undefined) return;
    session.timers.delete(timerId);
    this.clearTimer(handle);
  }

  private clearTimers(session: Session): void {
    for (const handle of session.timers.values()) this.clearTimer(handle);
    session.timers.clear();
  }

  private enqueue(session: Session, event: EvenHubHostEvent): void {
    if (this.active !== session || session.closed) return;
    if (session.events.length >= 16) session.events.shift();
    session.events.push(event);
    this.deps.onEvent?.();
  }
}
