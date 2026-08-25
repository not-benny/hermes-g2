import { GrayImage } from "../../graphics/image";
import { wrapText, truncateText } from "../../graphics/textwrap";
import {
  getDefaultMediumFont,
  getDefaultSmallFont,
} from "../../graphics/bdffont";
import {
  voiceControlBridge,
  type VoiceTranscriptEvent,
} from "../../native/voice-control";
import {
  refineDictation,
  type AnthropicStreamHandle,
} from "../../native/anthropic";
import { anthropicApiKeySetting } from "../dashboard-settings";
import {
  GESTURE_CLICK,
  GESTURE_DOUBLE_CLICK,
  GESTURE_SCROLL,
  gestureHints,
} from "../gestures";
import { drawSelectionHighlight } from "../menu";
import { EdgeBounce, EdgeWrapScroller } from "../edge-scroll";
import {
  Layer,
  type DashboardInputEvent,
  type LayerActions,
  type LayerContext,
} from "../layers";
import { drawGlassPanel, GLASS_TONE } from "../glass-design";
import {
  ASSISTANT_CAPTURE_CARD_HEIGHT,
  ASSISTANT_REVIEW_CARD_HEIGHT,
  ASSISTANT_STATUS_CARD_HEIGHT,
  ASSISTANT_STATUS_CARD_WIDTH,
  assistantCardRect,
} from "./geometry";
import { applyTranscriptText } from "../../captions/transcript-accumulator";

const CARD_PADDING = 16;
const BODY_LINE_HEIGHT = 16;
const LIVE_BODY_LINES = 3;
// After the mic stops, the provider's final transcript can trail in (cloud
// commit round-trip); wait this long for it before refining with what we have.
const FOLLOWUP_FINALIZE_TIMEOUT_MS = 1200;

/**
 * The dialog's lifecycle. "capturing" is the first utterance (push-to-talk or
 * click-to-finish); "menu" is the send / Continue / Discard menu; "continuing"
 * records a follow-up utterance (always click-to-finish); "refining" streams
 * the LLM-merged text, then returns to "menu".
 */
type VoicePhase = "capturing" | "menu" | "continuing" | "refining";

/**
 * A destination the captured text can be sent to. The shell supplies these per
 * entry point: "Send to Assistant" (hand off to the voice assistant) and/or
 * "Type Into App" (deliver to the foreground window's text input).
 */
export type VoiceSendTarget = {
  id: string;
  label: string;
  onSend: (text: string) => void;
};

export type VoiceInputLayerOptions = {
  actions: LayerActions;
  /** Post-removal cleanup (also fires when the screen turns off). */
  onClosed: () => void;
  /** Pop this layer off the shell stack. */
  dismiss: () => void;
  /** Ordered send destinations shown as the first menu rows. */
  sendTargets: VoiceSendTarget[];
  /** Which send target is highlighted by default (entry-point dependent). */
  defaultTargetIndex?: number;
  /** A single click ends the utterance (opened from a menu, no held button). */
  finishOnClick?: boolean;
  /** Wakeword flow: mic starts immediately and ends on detected silence. */
  handsFree?: boolean;
  /** Skip the menu: on capture end, send straight to the default target. */
  autoSend?: boolean;
};

/**
 * Push-to-talk voice dialog, drawn on top of whatever is already on screen.
 * The mic runs while the button is held (long-press); releasing it stops the
 * mic and shows a Send / Continue / Discard menu. Send delivers the transcript
 * to the foreground window (e.g. the terminal); Discard (or double-click)
 * closes. Continue records another utterance — extra content or a spoken edit
 * ("change X to Y", "insert ... after ...") — and merges it into the message
 * with an LLM, landing back on the same menu.
 *
 * When opened from a menu instead of a held button (finishOnClick), there is
 * no release event to end the capture, so a single click stops the mic.
 *
 * When opened by the "Hey Even" wakeword (handsFree), there is likewise no
 * button involved: the mic starts immediately and stops when the speaker does,
 * via endpoint detection on the decoded PCM. A click still ends it early.
 */
export class VoiceInputLayer implements Layer {
  private phase: VoicePhase = "capturing";
  private status = "Listening...";
  // The active utterance. displayText() is what the dialog shows and what
  // Send delivers; the refine flow also writes the merged result here.
  private finalizedText = "";
  private liveText = "";
  // Snapshot of the message when Continue starts, so a failed or cancelled
  // continuation can fall back to it.
  private baseText = "";
  /** Whether the mic is running (capture bookkeeping, not UI state). */
  private capturing = false;
  /** Exact bridge generation; every callback and stop carries this identity. */
  private captureGeneration = 0;
  /** Continuation stopped; waiting for the trailing final transcript. */
  private followupFinalizeTimer: ReturnType<typeof setTimeout> | null = null;
  private refineHandle: AnthropicStreamHandle | null = null;
  private menuIndex = 0;
  private readonly wrapScroller = new EdgeWrapScroller(
    undefined,
    "voice-targets",
  );
  private readonly edgeBounce = new EdgeBounce();
  /** Auto-send for an assistant-targeted capture is waiting to fire. */
  private pendingAutoSend = false;
  private autoSendTimer: ReturnType<typeof setTimeout> | null = null;
  /** Exact generation whose final transcript has arrived, if any. */
  private finalizedTranscriptGeneration: number | null = null;
  private unsubscribeTranscript: (() => void) | null = null;
  private unsubscribeStatus: (() => void) | null = null;
  private unsubscribeSpeechEnd: (() => void) | null = null;

  private readonly actions: LayerActions;
  private readonly onClosed: () => void;
  private readonly dismiss: () => void;
  private readonly sendTargets: VoiceSendTarget[];
  private readonly defaultTargetIndex: number;
  private readonly finishOnClick: boolean;
  private readonly handsFree: boolean;
  private readonly autoSend: boolean;

  constructor(options: VoiceInputLayerOptions) {
    this.actions = options.actions;
    this.onClosed = options.onClosed;
    this.dismiss = options.dismiss;
    this.sendTargets = options.sendTargets;
    this.finishOnClick = options.finishOnClick ?? false;
    this.handsFree = options.handsFree ?? false;
    this.autoSend = options.autoSend ?? false;
    const defaultIndex = options.defaultTargetIndex ?? 0;
    this.defaultTargetIndex = Math.min(
      Math.max(0, defaultIndex),
      Math.max(0, this.sendTargets.length - 1),
    );
    this.menuIndex = this.defaultTargetIndex;
  }

  startCapture(): void {
    if (this.capturing) return;
    this.captureGeneration = this.actions.startVoiceCapture(this.handsFree);
    if (this.captureGeneration <= 0) {
      this.phase = "menu";
      this.status = "Voice capture is busy.";
      this.actions.requestRender();
      return;
    }
    this.finalizedTranscriptGeneration = null;
    this.unsubscribeTranscript = voiceControlBridge.onTranscript((event) =>
      this.onTranscript(event),
    );
    this.unsubscribeStatus = voiceControlBridge.onStatus((state) => {
      if (state.generation !== this.captureGeneration) return;
      // The refine stage owns the status line ("Refining...", error text).
      if (this.phase === "refining") return;
      this.status = state.status;
      if (state.terminalError) {
        this.capturing = false;
        this.pendingAutoSend = false;
        if (this.autoSendTimer !== null) clearTimeout(this.autoSendTimer);
        this.autoSendTimer = null;
        this.phase = "menu";
      }
      this.actions.requestRender();
    });
    if (this.handsFree) {
      // No button is held, so the mic has to stop itself. endCapture() is
      // idempotent, and a click still ends the utterance early.
      this.unsubscribeSpeechEnd = voiceControlBridge.onSpeechEnd(
        (generation) => {
          if (
            generation === this.captureGeneration &&
            this.phase === "capturing"
          ) {
            this.endCapture();
          }
        },
      );
    }
    this.capturing = true;
    this.actions.requestRender();
  }

  /**
   * Whether a single click ends the utterance. True when there is no held
   * button to release: opened from the overlay menu (finishOnClick), or
   * hands-free from the wakeword — where it also lets the user cut the
   * silence-detection wait short.
   */
  private get clickEndsCapture(): boolean {
    return this.finishOnClick || this.handsFree;
  }

  /** Button released (or click when clickEndsCapture): stop the mic. */
  endCapture(): void {
    if (!this.capturing) return;
    if (this.phase === "continuing") {
      this.endContinuationCapture();
      return;
    }
    const generation = this.captureGeneration;
    this.capturing = false;
    this.phase = "menu";
    if (this.autoSend && this.sendTargets.length) {
      // Arm before stopping: an on-device provider may synchronously deliver
      // its final callback from stopVoiceCapture. The exact generation is
      // snapshotted above because a synchronous send dismisses this layer and
      // onRemoved clears captureGeneration.
      this.pendingAutoSend = true;
      this.status = "Transcribing...";
    } else if (this.status.startsWith("Listening")) {
      this.status = "Send, continue, or discard?";
    }
    void this.actions.stopVoiceCapture(generation, true);
    if (this.pendingAutoSend) {
      if (this.finalizedTranscriptGeneration === generation) {
        this.performAutoSend();
      } else {
        // Cloud finalization can trail capture stop. Keep a bounded fallback so
        // silence or a failed final callback never strands an undismissable UI.
        this.autoSendTimer = setTimeout(
          () => this.performAutoSend(),
          FOLLOWUP_FINALIZE_TIMEOUT_MS,
        );
      }
    }
    this.actions.requestRender();
  }

  /** Fire the queued assistant auto-send (or fall back to the menu). */
  private performAutoSend(): void {
    if (this.autoSendTimer !== null) {
      clearTimeout(this.autoSendTimer);
      this.autoSendTimer = null;
    }
    if (!this.pendingAutoSend) return;
    this.pendingAutoSend = false;
    const text = this.displayText().trim();
    const target = this.sendTargets[this.defaultTargetIndex];
    if (text && target) {
      if (!voiceControlBridge.claimSubmit(this.captureGeneration)) {
        // A cancelled, failed, stale, or already-submitted generation must not
        // send. If the layer is still present, leave it in the ordinary review
        // state instead of displaying a permanent "Transcribing" card.
        this.status = "Send, continue, or discard?";
        this.actions.requestRender();
        return;
      }
      this.dismiss();
      target.onSend(text);
    } else {
      // Nothing heard; fall back to the menu so the user can retry or discard.
      this.status = "Send, continue, or discard?";
      this.actions.requestRender();
    }
  }

  /** The menu rows: one per send target, then Continue, then Discard. */
  private menuRows(): Array<{
    label: string;
    dim: boolean;
    onSelect: () => void;
  }> {
    const text = this.displayText().trim();
    const hasText = text.length > 0;
    const rows: Array<{ label: string; dim: boolean; onSelect: () => void }> =
      [];
    for (const target of this.sendTargets) {
      rows.push({
        label: target.label,
        dim: !hasText,
        onSelect: () => {
          if (
            hasText &&
            !voiceControlBridge.claimSubmit(this.captureGeneration)
          )
            return;
          this.dismiss();
          if (hasText) target.onSend(text);
        },
      });
    }
    rows.push({
      label: "Continue",
      dim: false,
      onSelect: () => this.startContinuation(),
    });
    rows.push({ label: "Discard", dim: false, onSelect: () => this.dismiss() });
    return rows;
  }

  paint(ctx: LayerContext, paintBelow: () => GrayImage): GrayImage {
    const small = getDefaultSmallFont();
    const medium = getDefaultMediumFont();
    const image = paintBelow();
    const showingReview = this.phase === "menu" && !this.pendingAutoSend;
    const showingStatus = this.pendingAutoSend;
    const rect = assistantCardRect(
      ctx.stack.getBaseSize(),
      showingStatus
        ? ASSISTANT_STATUS_CARD_HEIGHT
        : showingReview
          ? ASSISTANT_REVIEW_CARD_HEIGHT
          : ASSISTANT_CAPTURE_CARD_HEIGHT,
      showingStatus ? ASSISTANT_STATUS_CARD_WIDTH : undefined,
    );
    const left = rect.x + CARD_PADDING;
    const contentWidth = rect.width - CARD_PADDING * 2;

    drawGlassPanel(image, rect.x, rect.y, rect.width, rect.height);
    image.drawText(
      medium,
      left,
      rect.y + 12,
      this.cardTitle(),
      GLASS_TONE.primary,
    );
    const meta = this.cardMeta();
    if (meta) {
      const renderedMeta = truncateText(
        small,
        meta,
        Math.floor(contentWidth * 0.48),
      );
      image.drawText(
        small,
        rect.x + rect.width - CARD_PADDING - small.measureText(renderedMeta),
        rect.y + 15,
        renderedMeta,
        GLASS_TONE.muted,
      );
    }

    if (showingStatus) {
      image.drawText(
        small,
        left,
        rect.y + rect.height - 17,
        `${GESTURE_DOUBLE_CLICK} close`,
        GLASS_TONE.hint,
      );
      return image;
    }

    const text = this.displayText() || this.placeholderText();
    const visibleLines = tailPreviewLines(
      small,
      text,
      contentWidth,
      LIVE_BODY_LINES,
    );
    for (let index = 0; index < visibleLines.length; index++) {
      image.drawText(
        small,
        left,
        rect.y + 38 + index * BODY_LINE_HEIGHT,
        visibleLines[index]!,
        GLASS_TONE.primary,
      );
    }

    if (showingReview) {
      const rows = this.menuRows();
      const row = rows[this.menuIndex];
      const actionY = rect.y + 92 + this.edgeBounce.offsetPx();
      drawSelectionHighlight(
        image,
        left - 4,
        actionY,
        contentWidth + 8,
        24,
        true,
        7,
      );
      if (row) {
        const position = `${this.menuIndex + 1}/${rows.length}`;
        const labelWidth = contentWidth - small.measureText(position) - 20;
        image.drawText(
          small,
          left + 4,
          actionY + 6,
          truncateText(small, row.label, labelWidth),
          row.dim ? GLASS_TONE.border : GLASS_TONE.focus,
        );
        image.drawText(
          small,
          left + contentWidth - small.measureText(position),
          actionY + 6,
          position,
          GLASS_TONE.muted,
        );
      }
      image.drawText(
        small,
        left,
        rect.y + rect.height - 16,
        truncateText(
          small,
          gestureHints([
            [GESTURE_SCROLL, "choose"],
            [GESTURE_CLICK, "select"],
            [GESTURE_DOUBLE_CLICK, "close"],
          ]),
          contentWidth,
        ),
        GLASS_TONE.hint,
      );
    } else {
      image.drawText(
        small,
        left,
        rect.y + rect.height - 16,
        truncateText(small, this.hintText(), contentWidth),
        GLASS_TONE.hint,
      );
    }
    return image;
  }

  handleInput(event: DashboardInputEvent, _ctx: LayerContext): void {
    switch (this.phase) {
      case "capturing":
        if (event.type === "double-click") {
          this.dismiss();
        } else if (this.clickEndsCapture && event.type === "click") {
          this.endCapture();
        }
        return;
      case "continuing":
        if (event.type === "click") {
          this.endContinuationCapture();
        } else if (event.type === "double-click") {
          this.cancelContinuation("Continuation cancelled");
        }
        return;
      case "refining":
        if (event.type === "double-click") {
          this.cancelContinuation("Refinement cancelled");
        }
        return;
      case "menu":
        this.handleMenuInput(event);
        return;
    }
  }

  private handleMenuInput(event: DashboardInputEvent): void {
    if (this.pendingAutoSend) {
      if (event.type === "double-click") this.dismiss();
      return;
    }
    const rowCount = this.menuRows().length;
    switch (event.type) {
      case "scroll-up": {
        const step = this.wrapScroller.step(
          this.menuIndex,
          rowCount,
          -1,
          Date.now(),
        );
        this.menuIndex = step.index;
        if (step.atEdge)
          this.edgeBounce.trigger(-1, () => this.actions.requestRender());
        this.actions.requestRender();
        return;
      }
      case "scroll-down": {
        const step = this.wrapScroller.step(
          this.menuIndex,
          rowCount,
          1,
          Date.now(),
        );
        this.menuIndex = step.index;
        if (step.atEdge)
          this.edgeBounce.trigger(1, () => this.actions.requestRender());
        this.actions.requestRender();
        return;
      }
      case "click": {
        this.wrapScroller.reset();
        const row = this.menuRows()[this.menuIndex];
        row?.onSelect();
        return;
      }
      case "double-click":
        this.wrapScroller.reset();
        this.dismiss();
        return;
      default:
        return;
    }
  }

  /** Continue selected: keep the message aside and record a follow-up. */
  private startContinuation(): void {
    this.baseText = this.displayText().trim();
    this.finalizedText = "";
    this.liveText = "";
    this.phase = "continuing";
    this.status = "Listening...";
    this.captureGeneration = this.actions.startVoiceCapture();
    this.finalizedTranscriptGeneration = null;
    this.capturing = this.captureGeneration > 0;
    if (!this.capturing)
      this.backToMenu(this.baseText, "Voice capture is busy.");
    this.actions.requestRender();
  }

  /** Follow-up tap: stop the mic, then refine once the transcript finalizes. */
  private endContinuationCapture(): void {
    if (!this.capturing) return;
    this.capturing = false;
    void this.actions.stopVoiceCapture(this.captureGeneration, true);
    this.status = "Refining...";
    this.actions.requestRender();
    // The provider's committed transcript arrives shortly after stop; refine
    // when it does, or after a timeout with whatever partials we have.
    this.followupFinalizeTimer = setTimeout(
      () => this.beginRefine(),
      FOLLOWUP_FINALIZE_TIMEOUT_MS,
    );
  }

  private beginRefine(): void {
    if (this.followupFinalizeTimer !== null) {
      clearTimeout(this.followupFinalizeTimer);
      this.followupFinalizeTimer = null;
    }
    if (this.phase !== "continuing") return;
    const followup = this.displayText().trim();
    if (!followup) {
      this.backToMenu(this.baseText, "No follow-up heard");
      return;
    }
    const apiKey = anthropicApiKeySetting.get().trim();
    if (!apiKey) {
      // Continue is useful without cloud setup: append the reviewed follow-up
      // verbatim. With a configured key the existing refiner can still apply
      // spoken edits such as "replace Tuesday with Wednesday".
      this.backToMenu(
        [this.baseText, followup].filter(Boolean).join(" "),
        "Added follow-up",
      );
      return;
    }
    this.phase = "refining";
    this.finalizedText = "";
    this.liveText = "";
    this.status = "Refining...";
    this.actions.requestRender();
    this.refineHandle = refineDictation({
      apiKey,
      original: this.baseText,
      followup,
      onTextDelta: (_delta, textSoFar) => {
        this.finalizedText = textSoFar;
        this.actions.requestRender();
      },
      onDone: (text) => {
        this.refineHandle = null;
        this.backToMenu(text, "Send, continue, or discard?");
      },
      onError: (message) => {
        this.refineHandle = null;
        this.backToMenu(this.baseText, message);
      },
    });
  }

  /** Abort a continuation (mic or LLM stage) and restore the prior message. */
  private cancelContinuation(status: string): void {
    if (this.capturing) {
      this.capturing = false;
      void this.actions.stopVoiceCapture(this.captureGeneration, false);
    }
    this.refineHandle?.cancel();
    this.refineHandle = null;
    this.backToMenu(this.baseText, status);
  }

  private backToMenu(text: string, status: string): void {
    if (this.followupFinalizeTimer !== null) {
      clearTimeout(this.followupFinalizeTimer);
      this.followupFinalizeTimer = null;
    }
    this.finalizedText = text;
    this.liveText = "";
    this.phase = "menu";
    this.menuIndex = 0;
    this.status = status;
    this.actions.requestRender();
  }

  onRemoved(): void {
    this.unsubscribeTranscript?.();
    this.unsubscribeTranscript = null;
    this.unsubscribeStatus?.();
    this.unsubscribeStatus = null;
    this.unsubscribeSpeechEnd?.();
    this.unsubscribeSpeechEnd = null;
    if (this.followupFinalizeTimer !== null) {
      clearTimeout(this.followupFinalizeTimer);
      this.followupFinalizeTimer = null;
    }
    if (this.autoSendTimer !== null) {
      clearTimeout(this.autoSendTimer);
      this.autoSendTimer = null;
    }
    this.pendingAutoSend = false;
    this.finalizedTranscriptGeneration = null;
    this.refineHandle?.cancel();
    this.refineHandle = null;
    if (this.captureGeneration > 0) {
      this.capturing = false;
      void this.actions.stopVoiceCapture(this.captureGeneration, false);
      this.captureGeneration = 0;
    }
    this.onClosed();
  }

  private cardTitle(): string {
    if (this.pendingAutoSend) return "Transcribing";
    if (this.phase === "refining") return "Refining";
    if (this.phase === "menu")
      return voiceStatusIsProblem(this.status) ? "Voice issue" : "Review";
    if (/permission|connect|start/i.test(this.status)) return "Starting voice";
    return "Listening";
  }

  private cardMeta(): string {
    const normalized = this.status.replace(/\.{3}$/, "").trim();
    if (
      !normalized ||
      /^(?:Listening|Refining|Transcribing)$/i.test(normalized)
    )
      return "";
    if (/^Send, continue, or discard\??$/i.test(normalized)) return "";
    if (normalized === "Added follow-up") return "Added";
    if (normalized === "No follow-up heard") return "No speech";
    return normalized;
  }

  private displayText(): string {
    if (!this.finalizedText) return this.liveText;
    if (!this.liveText) return this.finalizedText;
    return `${this.finalizedText} ${this.liveText}`;
  }

  private placeholderText(): string {
    switch (this.phase) {
      case "capturing":
        return "Listening...";
      case "continuing":
        return "Say more, or describe an edit...";
      case "refining":
        return "Refining...";
      case "menu":
        return "(no speech detected)";
    }
  }

  private hintText(): string {
    switch (this.phase) {
      case "capturing":
        return this.clickEndsCapture
          ? gestureHints([
              [GESTURE_CLICK, "done"],
              [GESTURE_DOUBLE_CLICK, "close"],
            ])
          : `${GESTURE_DOUBLE_CLICK} close`;
      case "continuing":
        return gestureHints([
          [GESTURE_CLICK, "done"],
          [GESTURE_DOUBLE_CLICK, "cancel"],
        ]);
      case "refining":
      default:
        return `${GESTURE_DOUBLE_CLICK} cancel`;
    }
  }

  private onTranscript(event: VoiceTranscriptEvent): void {
    if (event.generation !== this.captureGeneration) return;
    // The refine stream owns the text buffers once it starts; a transcript
    // that trails in after that point is stale.
    if (this.phase === "refining") return;
    const textState = applyTranscriptText(
      { finalizedText: this.finalizedText, liveText: this.liveText },
      event,
    );
    this.finalizedText = textState.finalizedText;
    this.liveText = textState.liveText;
    if (event.isFinal) {
      this.finalizedTranscriptGeneration = event.generation;
      if (this.phase === "continuing" && this.followupFinalizeTimer !== null) {
        // The follow-up finalized; no need to keep waiting.
        this.beginRefine();
        return;
      }
      if (this.pendingAutoSend) {
        // The utterance finalized; assistant auto-send can fire without
        // waiting out the fallback timer.
        this.performAutoSend();
        return;
      }
    }
    this.actions.requestRender();
  }
}

function voiceStatusIsProblem(status: string): boolean {
  return /busy|cancel|could not|disconnect|error|failed|no .*heard|stopped|unavailable/i.test(
    status,
  );
}

/** Latest words matter during capture; keep the full transcript in state but paint only its tail. */
function tailPreviewLines(
  font: ReturnType<typeof getDefaultSmallFont>,
  text: string,
  width: number,
  maximum: number,
): string[] {
  const wrapped = wrapText(font, text, width);
  const first = Math.max(0, wrapped.length - maximum);
  const lines = wrapped.slice(first);
  if (first > 0 && lines.length)
    lines[0] = truncateText(font, `... ${lines[0]}`, width);
  return lines;
}
