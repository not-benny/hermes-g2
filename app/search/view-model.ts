import type { SearchResult, SearchSourceId, SearchState } from "./core";

export type SearchScreenRow = {
  sourceId: SearchSourceId;
  sourceLabel: string;
  title: string;
  snippet: string;
  freshnessMs: number;
  selected: boolean;
};

export type SearchScreen = {
  query: string;
  rows: readonly SearchScreenRow[];
  page: number;
  pageCount: number;
  status: string;
};

const SOURCE_ORDER: readonly SearchSourceId[] = [
  "apps", "calendar", "notifications", "files", "media", "health",
];

export class SearchViewModel {
  private state: SearchState = { generation: 0, query: "", results: [], sources: [] };
  private readonly enabled = new Set<SearchSourceId>();
  private selectedIndex = 0;

  constructor(initiallyEnabled: readonly SearchSourceId[] = ["apps"], private readonly rowsPerPage = 4) {
    initiallyEnabled.forEach((sourceId) => this.enabled.add(sourceId));
  }

  enabledSources(): SearchSourceId[] {
    return SOURCE_ORDER.filter((sourceId) => this.enabled.has(sourceId));
  }

  toggleSource(sourceId: SearchSourceId): void {
    if (this.enabled.has(sourceId)) this.enabled.delete(sourceId);
    else this.enabled.add(sourceId);
    this.clampSelection();
  }

  setState(state: SearchState): void {
    this.state = {
      generation: state.generation,
      query: state.query,
      results: state.results.map((result) => ({ ...result })),
      sources: state.sources.map((source) => ({ ...source })),
    };
    this.clampSelection();
  }

  clear(): void {
    this.state = { generation: this.state.generation + 1, query: "", results: [], sources: [] };
    this.selectedIndex = 0;
  }

  move(delta: number): void {
    const count = this.visibleResults().length;
    if (!count || !Number.isFinite(delta)) return;
    this.selectedIndex = Math.max(0, Math.min(count - 1, this.selectedIndex + Math.sign(delta)));
  }

  selectedActionHandle(): string | undefined {
    return this.visibleResults()[this.selectedIndex]?.actionHandle;
  }

  screen(): SearchScreen {
    const results = this.visibleResults();
    const pageSize = Math.max(1, Math.floor(this.rowsPerPage));
    const pageCount = Math.max(1, Math.ceil(results.length / pageSize));
    const pageIndex = Math.min(pageCount - 1, Math.floor(this.selectedIndex / pageSize));
    const labels = new Map(this.state.sources.map((source) => [source.sourceId, source.label]));
    const rows = results.slice(pageIndex * pageSize, (pageIndex + 1) * pageSize).map((result, offset) => ({
      sourceId: result.sourceId,
      sourceLabel: labels.get(result.sourceId) ?? result.sourceId,
      title: result.title,
      snippet: result.snippet,
      freshnessMs: result.freshnessMs,
      selected: pageIndex * pageSize + offset === this.selectedIndex,
    }));
    const status = this.state.sources.map((source) =>
      this.enabled.has(source.sourceId) ? `${source.label} ${source.state}` : `${source.label} off`,
    ).join(" · ");
    return {
      query: this.state.query,
      rows,
      page: pageIndex + 1,
      pageCount,
      status,
    };
  }

  private visibleResults(): SearchResult[] {
    const grouped: SearchResult[] = [];
    for (const sourceId of SOURCE_ORDER) {
      if (!this.enabled.has(sourceId)) continue;
      grouped.push(...this.state.results.filter((result) => result.sourceId === sourceId));
    }
    return grouped;
  }

  private clampSelection(): void {
    const count = this.visibleResults().length;
    this.selectedIndex = count ? Math.max(0, Math.min(this.selectedIndex, count - 1)) : 0;
  }
}
