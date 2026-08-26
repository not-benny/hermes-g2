import { getDefaultMediumFont, getDefaultSmallFont } from "../../graphics/bdffont";
import { GrayImage } from "../../graphics/image";
import { truncateText } from "../../graphics/textwrap";
import { Layer, type DashboardInputEvent, type LayerContext } from "../layers";
import {
  ReaderSession,
  wrapReaderTextByWidth,
  type LongReaderSource,
} from ".";

const scheduler = {
  set: (delayMs: number, callback: () => void): ReturnType<typeof setTimeout> => setTimeout(callback, delayMs),
  clear: (handle: unknown): void => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Owner-preserving, non-mutating reader for bounded ephemeral text. */
export class LongReaderLayer implements Layer {
  private readonly session = new ReaderSession(scheduler, () => this.requestRender?.());
  private requestRender: (() => void) | null = null;
  private lines: string[] | null = null;
  private width = 0;
  private truncated = false;
  private initialized = false;
  private stale = false;

  constructor(private readonly source: LongReaderSource) {}

  paint(ctx: LayerContext): GrayImage {
    this.requestRender = ctx.actions.requestRender;
    const { width, height } = ctx.stack.getBaseSize();
    const image = new GrayImage(width, height, 0);
    const small = getDefaultSmallFont();
    const medium = getDefaultMediumFont();
    const left = 18;
    const footer = height - 18;
    const bodyTop = 43;
    const lineStep = 15;
    const lineCount = Math.max(1, Math.floor((footer - bodyTop) / lineStep));
    image.drawText(medium, left, 8, truncateText(medium, this.source.title, width - left * 2), 245);
    image.drawLine(left, 34, width - left, 34, 70);
    if (this.stale || this.source.isCurrent?.() === false) {
      image.drawText(small, left, bodyTop, "Content is no longer current.", 220);
      image.drawText(small, left, footer, "Double-click: back", 110);
      return image;
    }
    const lines = this.getLines(small, width);
    if (!this.initialized) {
      this.session.open({ documentId: `${this.source.owner}:${this.source.documentId}:${this.source.revision}`, pageCount: this.pageCount(lines.length, lineCount) });
      this.initialized = true;
    }
    const snapshot = this.session.snapshot();
    const step = Math.max(1, lineCount - 1);
    const first = snapshot.pageIndex * step;
    for (const [index, line] of lines.slice(first, first + lineCount).entries()) {
      image.drawText(small, left, bodyTop + index * lineStep, line.replace(/\n$/, ""), 230);
    }
    const status = `${this.truncated ? "LIMIT  " : ""}${snapshot.pageIndex + 1}/${snapshot.pageCount}`;
    image.drawText(small, width - left - small.measureText(status), footer, status, 110);
    return image;
  }

  handleInput(event: DashboardInputEvent, ctx: LayerContext): void {
    if (this.source.isCurrent?.() === false) {
      this.stale = true;
      ctx.actions.requestRender();
      if (event.type === "double-click") ctx.stack.pop();
      return;
    }
    if (event.type === "double-click") {
      ctx.stack.pop();
      return;
    }
    if (event.type === "click") {
      this.session.movePages(1);
      return;
    }
    if (event.type === "scroll-down" || event.type === "scroll-up") {
      this.session.movePages(event.type === "scroll-down" ? 1 : -1);
    }
  }

  onRemoved(): void {
    this.session.close();
    this.requestRender = null;
  }

  private getLines(font: ReturnType<typeof getDefaultSmallFont>, width: number): string[] {
    if (this.lines && this.width === width) return this.lines;
    const wrapped = wrapReaderTextByWidth(this.source.text.replace(/\t/g, "    "), {
      maxWidth: Math.max(1, width - 36),
      maxLines: 20_000,
      maxChars: 200_000,
      measureCodePoint: (point) => font.measureText(point),
    });
    this.lines = [...wrapped.lines];
    this.width = width;
    this.truncated = wrapped.truncated;
    return this.lines;
  }

  private pageCount(lineCount: number, linesPerPage: number): number {
    const step = Math.max(1, linesPerPage - 1);
    return lineCount <= linesPerPage ? 1 : Math.ceil((lineCount - linesPerPage) / step) + 1;
  }
}
