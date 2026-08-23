import { truncateText } from "../../graphics/textwrap";
import {
  getDefaultLargeFont,
  getDefaultMediumFont,
  getDefaultSmallFont,
  type BdfFont,
} from "../../graphics/bdffont";
import { GrayImage } from "../../graphics/image";
import { getStringSetting, setStringSetting } from "../../native/settings-store";
import { Layer, type DashboardInputEvent, type LayerContext } from "../../ui/layers";
import { type MenuItem } from "../../ui/menu";
import {
  decodeReaderProgress,
  encodeReaderProgress,
  ReaderSession,
  wrapReaderTextByWidth,
  type ReaderFontSize,
  type ReaderLineSpacing,
} from "./reader-core";

const MARGIN_X = 18;
const TITLE_Y = 16;
const BODY_X = 18;
const BODY_Y = 44;
const FOOTER_MARGIN = 36;
const PROGRESS_SETTING_KEY = "reader.progress.v1";

const scheduler = {
  set: (delayMs: number, callback: () => void): ReturnType<typeof setTimeout> => setTimeout(callback, delayMs),
  clear: (handle: unknown): void => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Native offline reader/teleprompter layer for bounded inert local text. */
export class TextViewerLayer implements Layer {
  private documentText: string;
  private lines: string[] | null = null;
  private wrappedForWidth = 0;
  private bodyLineCount = 14;
  private fontSize: ReaderFontSize = "small";
  private lineSpacing: ReaderLineSpacing = "normal";
  private initialized = false;
  private foreground = false;
  private screenOn = true;
  private requestRender: (() => void) | null = null;
  private pendingProgressRatio: number | null = null;
  private pendingBookmarkRatio: number | null = null;
  private contentTruncated = false;
  private readonly session: ReaderSession;

  constructor(
    documentText: string,
    private readonly title = "Reader",
    private readonly sourceUri?: string,
  ) {
    this.documentText = documentText;
    this.session = new ReaderSession(scheduler, () => {
      this.persistProgress();
      this.requestRender?.();
    });
    if (sourceUri) {
      const restored = decodeReaderProgress(getStringSetting(PROGRESS_SETTING_KEY, ""));
      if (restored !== null && restored.uri === sourceUri) {
        this.fontSize = restored.fontSize;
        this.lineSpacing = restored.lineSpacing;
      }
    }
  }

  paint(ctx: LayerContext): GrayImage {
    this.requestRender = ctx.actions.requestRender;
    const font = this.currentFont();
    const { width, height } = ctx.stack.getBaseSize();
    const image = new GrayImage(width, height, 0);
    const footerY = height - FOOTER_MARGIN;
    const lineStep = this.lineStep();
    this.bodyLineCount = Math.max(1, Math.floor((footerY - BODY_Y) / lineStep));
    image.drawText(font, MARGIN_X + 4, TITLE_Y, truncateText(font, this.title, width - 2 * MARGIN_X - 8), 220);

    const lines = this.getLines(font, width);
    this.ensureSession(lines.length);
    const snapshot = this.session.snapshot();
    const firstLine = snapshot.pageIndex * this.pageStep();
    const visibleLines = lines.slice(firstLine, firstLine + this.bodyLineCount);
    for (let index = 0; index < visibleLines.length; index++) {
      const line = visibleLines[index]!.replace(/\n$/, "");
      image.drawText(font, BODY_X, BODY_Y + index * lineStep, line, 230);
    }

    const status = this.contentTruncated ? "LIMIT" : snapshot.playing ? "AUTO" : "PAUSED";
    const bookmark = snapshot.bookmarkPage === snapshot.pageIndex ? " •" : "";
    image.drawText(font, BODY_X, footerY, `${status}${bookmark}  ${snapshot.pageIndex + 1}/${snapshot.pageCount}`, 110);
    return image;
  }

  handleInput(event: DashboardInputEvent, ctx: LayerContext): void {
    this.requestRender = ctx.actions.requestRender;
    switch (event.type) {
      case "scroll-down":
        this.session.movePages(1);
        return;
      case "scroll-up":
        this.session.movePages(-1);
        return;
      case "click":
        this.session.togglePlaying();
        return;
      case "double-click":
        ctx.stack.pop();
        return;
      default:
        return;
    }
  }

  buildMenuItems(): MenuItem[] {
    const snapshot = this.session.snapshot();
    return [
      { label: snapshot.playing ? "Pause auto-scroll" : "Start auto-scroll", onSelect: (ctx) => { ctx.stack.pop(); this.session.togglePlaying(); } },
      { label: "Faster auto-scroll", onSelect: (ctx) => { ctx.stack.pop(); this.session.setSpeedMs(snapshot.speedMs - 250); } },
      { label: "Slower auto-scroll", onSelect: (ctx) => { ctx.stack.pop(); this.session.setSpeedMs(snapshot.speedMs + 250); } },
      { label: `Font: ${this.fontSize}`, onSelect: (ctx) => { ctx.stack.pop(); this.cycleFont(); } },
      { label: `Line spacing: ${this.lineSpacing}`, onSelect: (ctx) => { ctx.stack.pop(); this.cycleLineSpacing(); } },
      { label: "Set bookmark", onSelect: (ctx) => { ctx.stack.pop(); this.session.setBookmark(); } },
      ...(snapshot.bookmarkPage === null ? [] : [{ label: "Go to bookmark", onSelect: (ctx: LayerContext) => { ctx.stack.pop(); this.session.jumpToBookmark(); } }]),
    ];
  }

  onForegroundChanged(foreground: boolean): void {
    this.foreground = foreground;
    this.session.setOwnership(this.foreground, this.screenOn);
  }

  onScreenChanged(screenOn: boolean): void {
    this.screenOn = screenOn;
    this.session.setOwnership(this.foreground, this.screenOn);
  }

  onRemoved(): void {
    this.session.close();
    this.documentText = "";
    this.lines = [];
    this.requestRender = null;
  }

  private ensureSession(lineCount: number): void {
    if (this.initialized) return;
    const pageCount = this.totalPageCount(lineCount);
    const restored = this.sourceUri
      ? decodeReaderProgress(getStringSetting(PROGRESS_SETTING_KEY, ""))
      : null;
    const matchesRestoredSource = restored !== null && restored.uri === this.sourceUri;
    const pageIndex = this.pendingProgressRatio !== null
      ? Math.round(this.pendingProgressRatio * Math.max(0, pageCount - 1))
      : matchesRestoredSource
        ? Math.min(pageCount - 1, restored.pageIndex)
        : 0;
    const bookmarkPage = this.pendingBookmarkRatio !== null
      ? Math.round(this.pendingBookmarkRatio * Math.max(0, pageCount - 1))
      : matchesRestoredSource
        ? restored.bookmarkPage
        : null;
    this.session.open({
      documentId: this.sourceUri ?? "ephemeral",
      pageCount,
      pageIndex,
      bookmarkPage,
    });
    this.initialized = true;
    if (matchesRestoredSource) this.session.setSpeedMs(restored.speedMs);
    this.session.setOwnership(this.foreground, this.screenOn);
    this.pendingProgressRatio = null;
    this.pendingBookmarkRatio = null;
    this.persistProgress();
  }

  private persistProgress(): void {
    if (!this.sourceUri || !this.initialized || !this.session.snapshot().open) return;
    const snapshot = this.session.snapshot();
    setStringSetting(PROGRESS_SETTING_KEY, encodeReaderProgress({
      uri: this.sourceUri,
      pageIndex: snapshot.pageIndex,
      bookmarkPage: snapshot.bookmarkPage,
      fontSize: this.fontSize,
      lineSpacing: this.lineSpacing,
      speedMs: snapshot.speedMs,
    }));
  }

  private relayout(): void {
    const snapshot = this.session.snapshot();
    this.pendingProgressRatio = snapshot.pageCount <= 1
      ? 0
      : snapshot.pageIndex / (snapshot.pageCount - 1);
    this.pendingBookmarkRatio = snapshot.bookmarkPage === null
      ? null
      : snapshot.pageCount <= 1
        ? 0
        : snapshot.bookmarkPage / (snapshot.pageCount - 1);
    this.session.close();
    this.lines = null;
    this.initialized = false;
    this.requestRender?.();
  }

  private cycleFont(): void {
    this.fontSize = this.fontSize === "small" ? "medium" : this.fontSize === "medium" ? "large" : "small";
    this.relayout();
  }

  private cycleLineSpacing(): void {
    this.lineSpacing = this.lineSpacing === "compact" ? "normal" : this.lineSpacing === "normal" ? "wide" : "compact";
    this.relayout();
  }

  private currentFont(): BdfFont {
    return this.fontSize === "large" ? getDefaultLargeFont() : this.fontSize === "medium" ? getDefaultMediumFont() : getDefaultSmallFont();
  }

  private lineStep(): number {
    const base = this.fontSize === "large" ? 27 : this.fontSize === "medium" ? 19 : 14;
    return this.lineSpacing === "compact" ? base - 2 : this.lineSpacing === "wide" ? base + 4 : base;
  }

  private pageStep(): number {
    return Math.max(1, this.bodyLineCount - 1);
  }

  private getLines(font: BdfFont, width: number): string[] {
    if (this.lines === null || this.wrappedForWidth !== width) {
      const wrapped = wrapReaderTextByWidth(this.documentText.replace(/\t/g, "    "), {
        maxWidth: width - BODY_X - 12,
        maxLines: 20_000,
        measureCodePoint: (point) => font.measureText(point),
      });
      this.lines = [...wrapped.lines];
      this.contentTruncated = wrapped.truncated;
      this.wrappedForWidth = width;
    }
    return this.lines;
  }

  private totalPageCount(lineCount: number): number {
    if (lineCount <= this.bodyLineCount) return 1;
    return Math.ceil((lineCount - this.bodyLineCount) / this.pageStep()) + 1;
  }
}
