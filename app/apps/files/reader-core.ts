/** Pure bounded reader pagination and lifecycle primitives. */

export const MAX_READER_CHARS = 200_000;
export const MAX_READER_LINES = 20_000;
export const MAX_READER_PAGES = 10_000;

export type ReaderPage = {
  lines: readonly string[];
  startOffset: number;
  endOffset: number;
};

export type ReaderPagination = {
  normalizedText: string;
  pages: readonly ReaderPage[];
  truncated: boolean;
};

export type ReaderLayoutOptions = {
  columns: number;
  linesPerPage: number;
  maxChars?: number;
};

function replaceUnpairedSurrogates(text: string): string {
  let result = "";
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        result += text[index]! + text[index + 1]!;
        index++;
      } else {
        result += "\ufffd";
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      result += "\ufffd";
    } else {
      result += text[index]!;
    }
  }
  return result;
}

function takeCodePoints(text: string, limit: number): { text: string; truncated: boolean } {
  const points: string[] = [];
  let truncated = false;
  for (const point of text) {
    if (points.length >= limit) {
      truncated = true;
      break;
    }
    points.push(point);
  }
  return {
    text: points.join(""),
    truncated,
  };
}

export type ReaderWidthWrapOptions = {
  maxWidth: number;
  maxLines: number;
  maxChars?: number;
  measureCodePoint: (codePoint: string) => number;
};

/** Linear, bounded production wrapper; markup remains ordinary text. */
export function wrapReaderTextByWidth(input: string, options: ReaderWidthWrapOptions): {
  lines: readonly string[];
  normalizedText: string;
  truncated: boolean;
} {
  const maxWidth = Math.max(1, Math.floor(options.maxWidth));
  const maxLines = Math.max(1, Math.min(MAX_READER_LINES, Math.floor(options.maxLines)));
  const maxChars = Math.max(1, Math.min(MAX_READER_CHARS, Math.floor(options.maxChars ?? MAX_READER_CHARS)));
  const repaired = replaceUnpairedSurrogates(input.replace(/^\ufeff/, "").replace(/\r\n?/g, "\n"));
  const bounded = takeCodePoints(repaired, maxChars);
  const lines: string[] = [];
  let current = "";
  let width = 0;
  let truncated = bounded.truncated;
  for (const point of bounded.text) {
    const pointWidth = point === "\n" ? 0 : Math.max(0, options.measureCodePoint(point));
    if (point !== "\n" && current && width + pointWidth > maxWidth) {
      lines.push(current);
      current = "";
      width = 0;
      if (lines.length >= maxLines) {
        truncated = true;
        break;
      }
    }
    current += point;
    width += pointWidth;
    if (point === "\n") {
      lines.push(current);
      current = "";
      width = 0;
      if (lines.length >= maxLines) {
        truncated = true;
        break;
      }
    }
  }
  if ((current || lines.length === 0) && lines.length < maxLines) lines.push(current);
  return { lines, normalizedText: lines.join(""), truncated };
}

/**
 * Paginate local text without interpreting markup. Newlines are retained at the
 * end of a visual line so concatenating every page reconstructs the bounded
 * normalized input exactly. The result is capped independently by input, line,
 * and page counts to keep hostile files from multiplying memory use.
 */
export function paginateReaderText(input: string, options: ReaderLayoutOptions): ReaderPagination {
  const columns = Math.max(1, Math.min(240, Math.floor(options.columns)));
  const linesPerPage = Math.max(1, Math.min(80, Math.floor(options.linesPerPage)));
  const maxChars = Math.max(1, Math.min(MAX_READER_CHARS, Math.floor(options.maxChars ?? MAX_READER_CHARS)));
  const repaired = replaceUnpairedSurrogates(input.replace(/^\ufeff/, "").replace(/\r\n?/g, "\n"));
  const bounded = takeCodePoints(repaired, maxChars);
  const visualLines: string[] = [];
  let current = "";
  let currentWidth = 0;
  let truncated = bounded.truncated;

  for (const point of Array.from(bounded.text)) {
    current += point;
    if (point === "\n") {
      visualLines.push(current);
      current = "";
      currentWidth = 0;
    } else {
      currentWidth++;
      if (currentWidth >= columns) {
        visualLines.push(current);
        current = "";
        currentWidth = 0;
      }
    }
    if (visualLines.length >= MAX_READER_LINES) {
      truncated = true;
      current = "";
      break;
    }
  }
  if (current || visualLines.length === 0) visualLines.push(current);

  const pages: ReaderPage[] = [];
  let offset = 0;
  for (let index = 0; index < visualLines.length && pages.length < MAX_READER_PAGES; index += linesPerPage) {
    const lines = visualLines.slice(index, index + linesPerPage);
    const pageText = lines.join("");
    pages.push({ lines, startOffset: offset, endOffset: offset + pageText.length });
    offset += pageText.length;
  }
  if (pages.length * linesPerPage < visualLines.length) truncated = true;
  const normalizedText = pages.flatMap((page) => page.lines).join("");
  return { normalizedText, pages, truncated };
}

export type ReaderScheduler = {
  set: (delayMs: number, callback: () => void) => unknown;
  clear: (handle: unknown) => void;
};

export type ReaderSessionSnapshot = {
  open: boolean;
  documentId: string | null;
  pageCount: number;
  pageIndex: number;
  playing: boolean;
  speedMs: number;
  bookmarkPage: number | null;
};

export class ReaderSession {
  private generation = 0;
  private timer: unknown = null;
  private openState = false;
  private documentId: string | null = null;
  private pageCount = 1;
  private pageIndex = 0;
  private playing = false;
  private foreground = false;
  private screenOn = false;
  private speedMs = 1_200;
  private bookmarkPage: number | null = null;

  constructor(
    private readonly scheduler: ReaderScheduler,
    private readonly onChanged: (snapshot: ReaderSessionSnapshot) => void = () => {},
  ) {}

  open(state: { documentId: string; pageCount: number; pageIndex?: number; bookmarkPage?: number | null }): void {
    this.invalidateTimer();
    this.openState = true;
    this.documentId = state.documentId;
    this.pageCount = Math.max(1, Math.floor(state.pageCount));
    this.pageIndex = this.clampPage(state.pageIndex ?? 0);
    this.bookmarkPage = state.bookmarkPage == null ? null : this.clampPage(state.bookmarkPage);
    this.playing = false;
    this.emit();
  }

  close(): void {
    if (!this.openState) return;
    this.invalidateTimer();
    this.openState = false;
    this.documentId = null;
    this.playing = false;
    this.bookmarkPage = null;
    this.emit();
  }

  play(): void {
    if (!this.openState || this.pageIndex >= this.pageCount - 1) return;
    this.playing = true;
    this.reconcileTimer();
    this.emit();
  }

  pause(): void {
    if (!this.playing && this.timer === null) return;
    this.playing = false;
    this.invalidateTimer();
    this.emit();
  }

  togglePlaying(): void {
    if (this.playing) this.pause();
    else this.play();
  }

  setOwnership(foreground: boolean, screenOn: boolean): void {
    this.foreground = foreground;
    this.screenOn = screenOn;
    if (!foreground || !screenOn) {
      this.invalidateTimer();
      return;
    }
    this.reconcileTimer();
  }

  movePages(delta: number): void {
    if (!this.openState) return;
    const next = this.clampPage(this.pageIndex + Math.trunc(delta));
    if (next === this.pageIndex) return;
    this.pageIndex = next;
    if (this.pageIndex >= this.pageCount - 1) {
      this.playing = false;
      this.invalidateTimer();
    }
    this.emit();
  }

  setSpeedMs(speedMs: number): void {
    this.speedMs = Math.max(250, Math.min(10_000, Math.floor(speedMs)));
    this.invalidateTimer();
    this.reconcileTimer();
    this.emit();
  }

  setBookmark(): void {
    if (!this.openState) return;
    this.bookmarkPage = this.pageIndex;
    this.emit();
  }

  jumpToBookmark(): void {
    if (this.bookmarkPage === null) return;
    this.pageIndex = this.clampPage(this.bookmarkPage);
    this.emit();
  }

  snapshot(): ReaderSessionSnapshot {
    return {
      open: this.openState,
      documentId: this.documentId,
      pageCount: this.pageCount,
      pageIndex: this.pageIndex,
      playing: this.playing,
      speedMs: this.speedMs,
      bookmarkPage: this.bookmarkPage,
    };
  }

  private clampPage(page: number): number {
    return Math.max(0, Math.min(this.pageCount - 1, Math.floor(page)));
  }

  private reconcileTimer(): void {
    if (!this.openState || !this.playing || !this.foreground || !this.screenOn || this.timer !== null) return;
    const expectedGeneration = this.generation;
    const handle = this.scheduler.set(this.speedMs, () => {
      if (
        expectedGeneration !== this.generation ||
        this.timer !== handle ||
        !this.foreground ||
        !this.screenOn
      ) return;
      this.scheduler.clear(handle);
      this.timer = null;
      this.movePages(1);
      this.reconcileTimer();
    });
    this.timer = handle;
  }

  private invalidateTimer(): void {
    this.generation++;
    if (this.timer !== null) {
      this.scheduler.clear(this.timer);
      this.timer = null;
    }
  }

  private emit(): void {
    this.onChanged(this.snapshot());
  }
}

export type ReaderFontSize = "small" | "medium" | "large";
export type ReaderLineSpacing = "compact" | "normal" | "wide";
export type ReaderProgress = {
  uri: string;
  pageIndex: number;
  bookmarkPage: number | null;
  fontSize: ReaderFontSize;
  lineSpacing: ReaderLineSpacing;
  speedMs: number;
};

const READER_PROGRESS_VERSION = 1;
const MAX_PROGRESS_BYTES = 2_048;

export function encodeReaderProgress(progress: ReaderProgress): string {
  return JSON.stringify({ version: READER_PROGRESS_VERSION, ...progress });
}

export function decodeReaderProgress(value: string): ReaderProgress | null {
  if (!value || value.length > MAX_PROGRESS_BYTES) return null;
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (parsed.version !== READER_PROGRESS_VERSION) return null;
    if (typeof parsed.uri !== "string" || !parsed.uri.startsWith("content://") || parsed.uri.length > 1_024) return null;
    if (!Number.isInteger(parsed.pageIndex) || (parsed.pageIndex as number) < 0 || (parsed.pageIndex as number) > MAX_READER_PAGES) return null;
    if (parsed.bookmarkPage !== null && (!Number.isInteger(parsed.bookmarkPage) || (parsed.bookmarkPage as number) < 0 || (parsed.bookmarkPage as number) > MAX_READER_PAGES)) return null;
    if (parsed.fontSize !== "small" && parsed.fontSize !== "medium" && parsed.fontSize !== "large") return null;
    if (parsed.lineSpacing !== "compact" && parsed.lineSpacing !== "normal" && parsed.lineSpacing !== "wide") return null;
    if (!Number.isInteger(parsed.speedMs) || (parsed.speedMs as number) < 250 || (parsed.speedMs as number) > 10_000) return null;
    return {
      uri: parsed.uri,
      pageIndex: parsed.pageIndex as number,
      bookmarkPage: parsed.bookmarkPage as number | null,
      fontSize: parsed.fontSize,
      lineSpacing: parsed.lineSpacing,
      speedMs: parsed.speedMs as number,
    };
  } catch {
    return null;
  }
}
