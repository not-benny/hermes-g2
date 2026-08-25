import { GrayImage } from "../../graphics/image";
import { getDefaultMediumFont, getDefaultSmallFont } from "../../graphics/bdffont";
import {
  GESTURE_CLICK,
  GESTURE_DOUBLE_CLICK,
  GESTURE_SCROLL,
  gestureHints,
} from "../gestures";
import { Layer, type DashboardInputEvent, type LayerActions, type LayerContext } from "../layers";
import { wrapText, truncateText } from "../../graphics/textwrap";
import {
  ASSISTANT_CARD_WIDTH,
  ASSISTANT_ERROR_CARD_HEIGHT,
  assistantCardRect,
} from "./geometry";

const CARD_RADIUS = 12;
const CARD_PADDING = 16;
const BODY_LINE_HEIGHT = 16;
const RESULT_LINES_PER_PAGE = 5;
const MAX_RESULT_PAGES = 3;
const RESULT_BASE_HEIGHT = 64;
const RESULT_MAX_HEIGHT = RESULT_BASE_HEIGHT + RESULT_LINES_PER_PAGE * BODY_LINE_HEIGHT;

/** thinking: hidden turn running; done/error: finished result card. */
type AssistantPhase = "thinking" | "done" | "error";

export type AssistantLayerCallbacks = {
  /** Record another utterance and continue this conversation. */
  onFollowUp: () => void;
  /** Abort the in-flight turn (double-click while thinking). */
  onCancel: () => void;
  /** The user dismissed the completed overlay. */
  onClose: () => void;
  /** The layer left the stack by any path (Done, or the screen sleeping). */
  onRemoved?: () => void;
};

/**
 * The assistant overlay renders only a bounded, paginated final result.
 * Thinking, streamed partials, and tool activity are deliberately transparent
 * even if a stale render observes the layer before the shell detaches it. The
 * shell owns the AssistantSession and drives this layer through the on* methods.
 */
export class AssistantLayer implements Layer {
  private phase: AssistantPhase = "thinking";
  private replyText = "";
  private status = "Thinking...";
  private pageIndex = 0;

  constructor(
    private readonly actions: LayerActions,
    private readonly callbacks: AssistantLayerCallbacks,
  ) {}

  /** Shell: a new turn (initial utterance or follow-up) is starting. */
  startTurn(): void {
    this.phase = "thinking";
    this.replyText = "";
    this.status = "Thinking...";
    this.pageIndex = 0;
    this.actions.requestRender();
  }

  onTextDelta(_delta: string, textSoFar: string): void {
    this.replyText = textSoFar;
    // Streamed text is retained but intentionally not painted. External
    // backends may report commentary/reasoning through a generic partial-text
    // callback; only the completed assistant turn becomes wearer-visible.
  }

  onToolActivity(_label: string): void {
    // Tool identity and step-by-step activity are private execution detail.
  }

  onTurnDone(text: string): void {
    this.replyText = text;
    this.phase = "done";
    this.status = this.replyText.trim() ? "" : "(no reply)";
    this.pageIndex = 0;
    this.actions.requestRender();
  }

  onError(message: string): void {
    this.phase = "error";
    this.status = message;
    this.pageIndex = 0;
    this.actions.requestRender();
  }

  getReplyText(): string {
    return this.replyText;
  }

  /** Shell fail-closed guard: a running layer must never own visible input. */
  isRunning(): boolean {
    return this.phase === "thinking";
  }

  paint(ctx: LayerContext, paintBelow: () => GrayImage): GrayImage {
    const image = paintBelow();
    if (this.phase === "thinking") {
      // Defense in depth: backgroundAssistantLayer normally detaches this
      // before startTurn(), but an already-queued/stale paint must still be a
      // true no-op. Never put generic progress or cancellation chrome on G2.
      return image;
    }

    const small = getDefaultSmallFont();
    const medium = getDefaultMediumFont();
    const baseSize = ctx.stack.getBaseSize();
    const displayText = this.phase === "error"
      ? this.status || "The assistant could not finish this turn."
      : this.replyText.trim() || this.status || "(no reply)";
    const textWidth = ASSISTANT_CARD_WIDTH - CARD_PADDING * 2;
    const allLines = boundedResultLines(small, displayText, textWidth);
    const pageCount = Math.max(1, Math.ceil(allLines.length / RESULT_LINES_PER_PAGE));
    this.pageIndex = Math.max(0, Math.min(this.pageIndex, pageCount - 1));
    const first = this.pageIndex * RESULT_LINES_PER_PAGE;
    const pageLines = allLines.slice(first, first + RESULT_LINES_PER_PAGE);
    const resultHeight = pageCount > 1
      ? RESULT_MAX_HEIGHT
      : Math.max(
          this.phase === "error" ? ASSISTANT_ERROR_CARD_HEIGHT : RESULT_BASE_HEIGHT + BODY_LINE_HEIGHT,
          RESULT_BASE_HEIGHT + pageLines.length * BODY_LINE_HEIGHT,
        );
    const rect = assistantCardRect(baseSize, resultHeight);
    const left = rect.x + CARD_PADDING;
    const contentWidth = rect.width - CARD_PADDING * 2;

    image.fillRoundedRect(rect.x, rect.y, rect.width, rect.height, 1, CARD_RADIUS);
    image.drawRoundedRect(rect.x, rect.y, rect.width, rect.height, this.phase === "error" ? 150 : 100, CARD_RADIUS);
    image.drawText(medium, left, rect.y + 12, this.phase === "error" ? "Couldn't finish" : "Hermes", 240);
    if (pageCount > 1) {
      const pageLabel = `${this.pageIndex + 1}/${pageCount}`;
      image.drawText(small, rect.x + rect.width - CARD_PADDING - small.measureText(pageLabel), rect.y + 15, pageLabel, 145);
    }
    for (let index = 0; index < pageLines.length; index++) {
      image.drawText(small, left, rect.y + 38 + index * BODY_LINE_HEIGHT, pageLines[index]!, this.phase === "error" ? 210 : 235);
    }
    const followUpLabel = this.phase === "error" ? "retry" : "follow-up";
    const hints: Array<[string, string]> = [];
    if (pageCount > 1) hints.push([GESTURE_SCROLL, "page"]);
    hints.push([GESTURE_CLICK, followUpLabel], [GESTURE_DOUBLE_CLICK, "dismiss"]);
    image.drawText(small, left, rect.y + rect.height - 16, truncateText(small, gestureHints(hints), contentWidth), 110);
    return image;
  }

  handleInput(event: DashboardInputEvent, _ctx: LayerContext): void {
    if (this.phase === "thinking") {
      if (event.type === "double-click") {
        this.callbacks.onCancel();
        this.phase = "done";
        this.replyText = "";
        this.status = "Cancelled";
        this.pageIndex = 0;
        this.actions.requestRender();
      }
      return;
    }
    // Completed answers use direct gestures, leaving the card body available
    // for paginated result text instead of a large two-row menu.
    switch (event.type) {
      case "scroll-up":
        if (this.pageIndex > 0) {
          this.pageIndex--;
          this.actions.requestRender();
        }
        return;
      case "scroll-down":
        this.pageIndex++;
        this.actions.requestRender();
        return;
      case "click":
        this.callbacks.onFollowUp();
        return;
      case "double-click":
        this.callbacks.onClose();
        return;
      default:
        return;
    }
  }

  onRemoved(): void {
    this.callbacks.onRemoved?.();
  }
}

/** Bound plain result rendering to three five-line pages. */
function boundedResultLines(
  font: ReturnType<typeof getDefaultSmallFont>,
  text: string,
  width: number,
): string[] {
  const maximumLines = RESULT_LINES_PER_PAGE * MAX_RESULT_PAGES;
  const wrapped = wrapText(font, text, width);
  if (wrapped.length <= maximumLines) return wrapped;
  const lines = wrapped.slice(0, maximumLines);
  lines[lines.length - 1] = truncateText(font, `${lines[lines.length - 1]}...`, width);
  return lines;
}
