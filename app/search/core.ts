export const SEARCH_SOURCE_IDS = [
  "apps",
  "calendar",
  "files",
  "hermes_sessions",
  "notifications",
  "media",
  "health",
  "roam",
  "terminal",
] as const;

export type SearchSourceId = (typeof SEARCH_SOURCE_IDS)[number];
export type SearchPrivacyClass = "public_metadata" | "private_content" | "restricted_health" | "terminal_content";

export type SearchActionDescriptor =
  | { kind: "open_app"; appId: string }
  | { kind: "open_calendar_event"; eventId: number; startMs: number }
  | { kind: "open_notification"; notificationKey: string; postTime: number }
  | { kind: "open_file"; path: string; rootPath: string; modifiedMs: number }
  | { kind: "open_hermes_session"; sessionId: string; generation: number };

export type SearchResult = {
  sourceId: SearchSourceId;
  resultId: string;
  title: string;
  snippet: string;
  freshnessMs: number;
  privacyClass?: SearchPrivacyClass;
  action?: SearchActionDescriptor;
  actionHandle?: string;
};

export type SearchProviderState = "searching" | "ready" | "offline" | "permission_denied" | "unavailable" | "error" | "timeout";

export class SearchProviderFailure extends Error {
  constructor(readonly state: Extract<SearchProviderState, "offline" | "permission_denied" | "unavailable" | "error">) {
    super("search provider unavailable");
    this.name = "SearchProviderFailure";
  }
}

export type SearchProviderStatus = {
  sourceId: SearchSourceId;
  label: string;
  state: SearchProviderState;
};

export type SearchState = {
  generation: number;
  query: string;
  results: readonly SearchResult[];
  sources: readonly SearchProviderStatus[];
};

export type SearchProvider = {
  sourceId: SearchSourceId;
  label: string;
  privacyClass: SearchPrivacyClass;
  search: (query: string, signal: AbortSignal) => Promise<readonly SearchResult[]>;
  execute?: (action: SearchActionDescriptor, signal: AbortSignal) => Promise<SearchActionOutcome>;
};

type SearchControllerOptions = {
  providerTimeoutMs: number;
  resultLimit: number;
  tokenFactory?: () => string;
};

export type SearchActionOutcome = "executed" | "stale" | "denied" | "failed";

function normalized(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim().toLocaleLowerCase();
}

function score(query: string, result: SearchResult): number | null {
  const title = normalized(result.title);
  const snippet = normalized(result.snippet);
  const tokens = query.split(" ").filter(Boolean);
  if (!tokens.every((token) => title.includes(token) || snippet.includes(token))) return null;
  if (title === query) return 400;
  if (title.startsWith(query)) return 300;
  if (title.includes(query)) return 250;
  const titleMatches = tokens.filter((token) => title.includes(token)).length;
  return 100 + titleMatches * 10;
}

export function rankSearchResults(queryText: string, input: readonly SearchResult[], limit: number): SearchResult[] {
  const query = normalized(queryText);
  if (!query || !Number.isInteger(limit) || limit <= 0) return [];
  const seen = new Set<string>();
  const candidates: Array<{ result: SearchResult; score: number; order: number }> = [];
  input.forEach((result, order) => {
    const identity = `${result.sourceId}\u0000${result.resultId}`;
    if (seen.has(identity)) return;
    seen.add(identity);
    const relevance = score(query, result);
    if (relevance === null) return;
    candidates.push({ result, score: relevance, order });
  });
  candidates.sort((left, right) =>
    right.score - left.score ||
    right.result.freshnessMs - left.result.freshnessMs ||
    left.result.sourceId.localeCompare(right.result.sourceId) ||
    left.result.resultId.localeCompare(right.result.resultId) ||
    left.order - right.order,
  );
  return candidates.slice(0, limit).map(({ result }) => result);
}

function cloneState(state: SearchState): SearchState {
  return {
    generation: state.generation,
    query: state.query,
    results: state.results.map(({ action: _action, ...result }) => ({ ...result })),
    sources: state.sources.map((source) => ({ ...source })),
  };
}

function parseResult(provider: SearchProvider, value: unknown): SearchResult | null {
  try {
    if (!value || typeof value !== "object") return null;
    const result = value as Partial<SearchResult>;
    const sourceId = result.sourceId;
    const resultId = result.resultId;
    const title = result.title;
    const snippet = result.snippet;
    const freshnessMs = result.freshnessMs;
    if (sourceId !== provider.sourceId ||
      typeof resultId !== "string" || resultId.length === 0 || resultId.length > 160 ||
      typeof title !== "string" || title.length === 0 || title.length > 240 ||
      typeof snippet !== "string" || snippet.length > 500 ||
      typeof freshnessMs !== "number" || !Number.isFinite(freshnessMs)) return null;
    const actionValue = result.action;
    const action = parseAction(actionValue);
    if (actionValue !== undefined && action === null) return null;
    return { sourceId, resultId, title, snippet, freshnessMs, ...(action ? { action } : {}) };
  } catch {
    return null;
  }
}

function parseAction(value: SearchActionDescriptor | undefined): SearchActionDescriptor | null {
  try {
    if (value === undefined || !value || typeof value !== "object") return null;
    const kind = value.kind;
    if (kind === "open_app") {
      const appId = value.appId;
      return typeof appId === "string" && appId.length > 0 && appId.length <= 80 ? { kind, appId } : null;
    }
    if (kind === "open_calendar_event") {
      const eventId = value.eventId;
      const startMs = value.startMs;
      return Number.isFinite(eventId) && Number.isFinite(startMs) ? { kind, eventId, startMs } : null;
    }
    if (kind === "open_notification") {
      const notificationKey = value.notificationKey;
      const postTime = value.postTime;
      return typeof notificationKey === "string" && notificationKey.length > 0 && notificationKey.length <= 240 && Number.isFinite(postTime)
        ? { kind, notificationKey, postTime } : null;
    }
    if (kind === "open_file") {
      const path = value.path;
      const rootPath = value.rootPath;
      const modifiedMs = value.modifiedMs;
      return typeof path === "string" && path.length > 0 && path.length <= 1000 &&
        typeof rootPath === "string" && rootPath.length > 0 && rootPath.length <= 1000 && Number.isFinite(modifiedMs)
        ? { kind, path, rootPath, modifiedMs } : null;
    }
    if (kind === "open_hermes_session") {
      const sessionId = value.sessionId;
      const generation = value.generation;
      return typeof sessionId === "string" && sessionId.length > 0 && sessionId.length <= 160 && Number.isInteger(generation) && generation > 0
        ? { kind, sessionId, generation } : null;
    }
  } catch {
    return null;
  }
  return null;
}

export class SearchController {
  private generation = 0;
  private activeAbort: AbortController | null = null;
  private cancelActive: (() => void) | null = null;
  private readonly actions = new Map<string, { generation: number; provider: SearchProvider; action: SearchActionDescriptor; consumed: boolean }>();
  private readonly identityHandles = new Map<string, string>();
  private readonly activeActionControllers = new Set<AbortController>();

  constructor(
    private readonly providers: readonly SearchProvider[],
    private readonly options: SearchControllerOptions,
  ) {}

  dispose(): void {
    this.activeAbort?.abort();
    this.cancelActive?.();
    for (const controller of this.activeActionControllers) controller.abort();
    this.activeActionControllers.clear();
    this.generation++;
    this.activeAbort = null;
    this.cancelActive = null;
    this.actions.clear();
    this.identityHandles.clear();
  }

  async executeAction(handle: string | undefined): Promise<SearchActionOutcome | "consumed"> {
    if (!handle) return "stale";
    const record = this.actions.get(handle);
    if (!record || record.generation !== this.generation) return "stale";
    if (record.consumed) return "consumed";
    record.consumed = true;
    if (!record.provider.execute) return "denied";
    const actionGeneration = this.generation;
    const controller = new AbortController();
    this.activeActionControllers.add(controller);
    try {
      const outcome = await record.provider.execute(record.action, controller.signal);
      return controller.signal.aborted || actionGeneration !== this.generation ? "stale" : outcome;
    } catch {
      return "failed";
    } finally {
      this.activeActionControllers.delete(controller);
    }
  }

  async search(
    queryText: string,
    enabledSources: ReadonlySet<SearchSourceId>,
    onUpdate: (state: SearchState) => void = () => {},
  ): Promise<SearchState> {
    this.activeAbort?.abort();
    this.cancelActive?.();
    for (const controller of this.activeActionControllers) controller.abort();
    this.activeActionControllers.clear();
    const generation = ++this.generation;
    this.actions.clear();
    this.identityHandles.clear();
    const query = queryText.normalize("NFKC").replace(/\s+/g, " ").trim().slice(0, 160);
    const abort = new AbortController();
    this.activeAbort = abort;
    let cancel!: () => void;
    const cancelled = new Promise<"cancelled">((resolve) => { cancel = () => resolve("cancelled"); });
    this.cancelActive = cancel;
    const selected = query ? this.providers.filter((provider) => enabledSources.has(provider.sourceId)) : [];
    const state: SearchState = {
      generation,
      query,
      results: [],
      sources: selected.map((provider) => ({ sourceId: provider.sourceId, label: provider.label, state: "searching" })),
    };
    onUpdate(cloneState(state));
    const collected: SearchResult[] = [];

    const runs = selected.map(async (provider, providerIndex) => {
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      const providerAbort = new AbortController();
      const abortProvider = () => providerAbort.abort();
      abort.signal.addEventListener("abort", abortProvider, { once: true });
      const timeout = new Promise<"timeout">((resolve) => {
        timeoutId = setTimeout(() => {
          providerAbort.abort();
          resolve("timeout");
        }, this.options.providerTimeoutMs);
      });
      let outcome: readonly SearchResult[] | "timeout" | "cancelled" | "offline" | "permission_denied" | "unavailable" | "error";
      try {
        outcome = await Promise.race([
          Promise.resolve().then(() => provider.search(query, providerAbort.signal)).catch((error) =>
            error instanceof SearchProviderFailure ? error.state : "error" as const,
          ),
          timeout,
          cancelled,
        ]);
      } finally {
        if (timeoutId !== undefined) clearTimeout(timeoutId);
        abort.signal.removeEventListener("abort", abortProvider);
      }
      if (generation !== this.generation || outcome === "cancelled") return;
      const source = state.sources[providerIndex]!;
      if (typeof outcome === "string") {
        source.state = outcome;
      } else {
        let parsed: (SearchResult | null)[];
        try {
          if (!Array.isArray(outcome) || outcome.length > 100) throw new Error("invalid provider result list");
          // Build a plain host-owned array. Array#map honors a provider-owned
          // constructor/@@species and could return another hostile proxy.
          parsed = [];
          for (let index = 0; index < outcome.length; index++) {
            parsed.push(parseResult(provider, outcome[index]));
          }
        } catch {
          // Provider-owned arrays can be proxies. Contain every trap to this
          // source so one malformed adapter cannot reject the whole search.
          if (generation !== this.generation) return;
          source.state = "error";
          onUpdate(cloneState(state));
          return;
        }
        if (parsed.some((result) => result === null)) {
          if (generation !== this.generation) return;
          source.state = "error";
          onUpdate(cloneState(state));
          return;
        }
        const privacyClass = provider.privacyClass;
        if (generation !== this.generation) return;
        source.state = "ready";
        collected.push(...(parsed as SearchResult[]).map((result) => ({ ...result, privacyClass })));
        state.results = rankSearchResults(query, collected, this.options.resultLimit).map((result) => {
          if (!result.action) return result;
          const identity = `${result.sourceId}\u0000${result.resultId}`;
          let handle = this.identityHandles.get(identity);
          if (!handle) {
            handle = this.options.tokenFactory?.() ?? `${generation}-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
            if (!handle || this.actions.has(handle)) {
              source.state = "error";
              return { ...result, action: undefined, actionHandle: undefined };
            }
            this.identityHandles.set(identity, handle);
            this.actions.set(handle, { generation, provider, action: result.action, consumed: false });
          }
          return { ...result, actionHandle: handle };
        });
      }
      if (generation !== this.generation) return;
      onUpdate(cloneState(state));
    });
    await Promise.all(runs);
    if (generation === this.generation) {
      this.activeAbort = null;
      this.cancelActive = null;
    }
    return cloneState(state);
  }
}
