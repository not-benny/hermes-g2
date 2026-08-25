import { CaptionSession, bottomAnchoredLines, wrapCaptionText } from "../../captions/caption-session";
import { captionProviderCapabilities } from "../../captions/caption-settings";
import { getDefaultMediumFont, getDefaultSmallFont, type BdfFont } from "../../graphics/bdffont";
import { GrayImage } from "../../graphics/image";
import { truncateText } from "../../graphics/textwrap";
import { voiceControlBridge, type VoiceTranscriptEvent } from "../../native/voice-control";
import {
  captionFontSizeSetting,
  captionLayoutSetting,
  captionSourceLanguageSetting,
  captionTargetLanguageSetting,
  type VoiceProvider,
} from "../../ui/dashboard-settings";
import { GESTURE_CLICK, GESTURE_DOUBLE_CLICK } from "../../ui/gestures";
import { type DashboardInputEvent, type Layer, type LayerContext } from "../../ui/layers";
import {
  ConversationSession,
  type ConversationCue,
  type ConversationSessionSnapshot,
} from "./conversation-session";
import {
  conversatePrivacyStatus,
  currentConversateProvider,
  cycleConversateProvider,
  type ConversateProviderState,
} from "./conversate-provider";

export type ConversateLayerOptions = {
  startCapture: (provider: VoiceProvider) => number;
  finishCapture: (generation: number) => Promise<void>;
  stopCapture: (generation: number) => void;
};

type ConversateView = "preflight" | "live" | "cue" | "review";

/**
 * Local-first conversation assistance over the existing generation-gated mic
 * bridge. Audio remains owned by FaceclawVoiceController; this layer consumes
 * provider-neutral text events only and never writes either audio or text.
 */
export class ConversateLayer implements Layer {
  private readonly conversation = new ConversationSession();
  private readonly captions = new CaptionSession();
  private foreground = false;
  private screenOn = false;
  private voiceInputActive = false;
  private captureGeneration: number | null = null;
  private sessionGeneration: number | null = null;
  private provider: ConversateProviderState = currentConversateProvider();
  private view: ConversateView = "preflight";
  private selectedCue = 0;
  private finishing: "pause" | "end" | null = null;
  private transitionEpoch = 0;
  private status = "Ready";
  private lastTranscriptEvent: VoiceTranscriptEvent | null = null;
  private requestRender: () => void = () => {};
  private unsubscribeTranscript: (() => void) | null = null;
  private unsubscribeStatus: (() => void) | null = null;
  private clockTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly options: ConversateLayerOptions) {}

  start(requestRender: () => void): void {
    this.requestRender = requestRender;
    this.unsubscribeTranscript = voiceControlBridge.onTranscript((event) => {
      this.onTranscript(event);
    });
    this.unsubscribeStatus = voiceControlBridge.onStatus((state) => {
      if (state.generation !== this.captureGeneration) return;
      const status = visualStatus(state.status);
      if (state.terminalError && this.isSessionOpen()) {
        this.endImmediately(status);
        return;
      }
      this.status = status;
      requestRender();
    });
    this.clockTimer = setInterval(() => {
      if (this.conversation.snapshot().phase === "active") requestRender();
    }, 1_000);
  }

  phase(): ConversationSessionSnapshot["phase"] {
    return this.conversation.snapshot().phase;
  }

  isSessionOpen(): boolean {
    const phase = this.phase();
    return phase === "active" || phase === "paused";
  }

  providerLabel(): string {
    return currentConversateProvider().label;
  }

  startConversation(): void {
    if (this.isSessionOpen() || this.finishing) return;
    if (!this.foreground || !this.screenOn || this.voiceInputActive) {
      this.status = "Display and microphone must be available";
      this.requestRender();
      return;
    }
    this.conversation.clear();
    this.captions.clear();
    this.provider = currentConversateProvider();
    const captureGeneration = this.options.startCapture(this.provider.effective);
    if (captureGeneration <= 0) {
      this.status = "Microphone unavailable";
      this.view = "preflight";
      this.requestRender();
      return;
    }
    this.captureGeneration = captureGeneration;
    this.sessionGeneration = captureGeneration;
    this.conversation.begin(captureGeneration, Date.now());
    this.captions.begin(captureGeneration, Date.now());
    this.lastTranscriptEvent = null;
    this.selectedCue = 0;
    this.view = "live";
    this.status = "Starting microphone";
    this.requestRender();
  }

  togglePaused(): void {
    const phase = this.phase();
    if (phase === "active") {
      this.finishSessionCapture("pause");
      return;
    }
    if (phase !== "paused" || this.sessionGeneration === null || this.finishing) return;
    if (!this.foreground || !this.screenOn || this.voiceInputActive) {
      this.status = "Microphone unavailable";
      this.requestRender();
      return;
    }
    const generation = this.options.startCapture(this.provider.effective);
    if (generation <= 0) {
      this.status = "Microphone unavailable";
      this.requestRender();
      return;
    }
    this.captureGeneration = generation;
    this.captions.begin(generation, Date.now());
    this.conversation.resume(this.sessionGeneration, Date.now());
    this.lastTranscriptEvent = null;
    this.status = "Starting microphone";
    this.requestRender();
  }

  endConversation(): void {
    if (!this.isSessionOpen() || this.sessionGeneration === null) return;
    this.finishSessionCapture("end");
  }

  newConversation(): void {
    if (this.finishing) return;
    this.stopCapture();
    this.conversation.clear();
    this.captions.clear();
    this.sessionGeneration = null;
    this.lastTranscriptEvent = null;
    this.selectedCue = 0;
    this.provider = currentConversateProvider();
    this.status = "Ready";
    this.view = "preflight";
    this.requestRender();
  }

  cycleProvider(direction: 1 | -1): void {
    if (this.isSessionOpen()) return;
    this.provider = cycleConversateProvider(direction);
    this.status = this.provider.locality === "local" ? "On-device preferred" : "Cloud provider selected";
    this.requestRender();
  }

  handleDoubleClick(): boolean {
    if (this.view === "cue") {
      this.view = "live";
      this.requestRender();
      return true;
    }
    if (this.isSessionOpen()) {
      this.endConversation();
      return true;
    }
    return false;
  }

  onForegroundChanged(foreground: boolean): void {
    this.foreground = foreground;
    if (!foreground && this.isSessionOpen()) this.endImmediately();
  }

  onScreenChanged(on: boolean): void {
    this.screenOn = on;
    if (!on && this.isSessionOpen()) this.endImmediately();
  }

  onVoiceInputChanged(active: boolean): void {
    this.voiceInputActive = active;
    if (active && this.phase() === "active") this.pauseImmediately();
  }

  paint(ctx: LayerContext): GrayImage {
    const { width, height } = ctx.stack.getBaseSize();
    const image = new GrayImage(width, height, 0);
    if (this.view === "preflight") return this.paintPreflight(image, width, height);
    if (this.view === "review") return this.paintReview(image, width, height);
    if (this.view === "cue") return this.paintCue(image, width, height);
    return this.paintLive(image, width, height);
  }

  handleInput(event: DashboardInputEvent): void {
    if (this.finishing) return;
    if (event.type === "click") {
      if (this.view === "preflight") this.startConversation();
      else if (this.view === "review") this.newConversation();
      else if (this.view === "cue") {
        this.view = "live";
        this.requestRender();
      } else if (this.phase() === "paused") this.togglePaused();
      else if (this.currentCues().length) {
        this.view = "cue";
        this.requestRender();
      } else this.togglePaused();
      return;
    }
    if (event.type !== "scroll-up" && event.type !== "scroll-down") return;
    const direction = event.type === "scroll-up" ? -1 : 1;
    if (this.view === "preflight") {
      this.cycleProvider(direction as 1 | -1);
      return;
    }
    const cues = this.currentCues();
    if (!cues.length || this.view === "review") return;
    this.selectedCue = (this.selectedCue + direction + cues.length) % cues.length;
    this.requestRender();
  }

  onRemoved(): void {
    this.foreground = false;
    this.screenOn = false;
    this.transitionEpoch++;
    this.finishing = null;
    this.stopCapture();
    this.conversation.clear();
    this.captions.clear();
    this.unsubscribeTranscript?.();
    this.unsubscribeTranscript = null;
    this.unsubscribeStatus?.();
    this.unsubscribeStatus = null;
    if (this.clockTimer !== null) clearInterval(this.clockTimer);
    this.clockTimer = null;
  }

  private onTranscript(event: VoiceTranscriptEvent): void {
    if (event.generation !== this.captureGeneration || this.sessionGeneration === null) return;
    this.lastTranscriptEvent = { ...event };
    this.captions.apply({ type: "transcript", ...event });
    this.conversation.apply({ ...event, generation: this.sessionGeneration });
    const cues = this.currentCues();
    if (cues.length) this.selectedCue = Math.min(this.selectedCue, cues.length - 1);
    else this.selectedCue = 0;
    this.requestRender();
  }

  private finalizeLiveText(): void {
    if (this.sessionGeneration === null) return;
    const snapshot = this.conversation.snapshot();
    if (!snapshot.liveText) return;
    const previous = this.lastTranscriptEvent;
    this.conversation.apply({
      generation: this.sessionGeneration,
      text: snapshot.liveText,
      isFinal: true,
      speaker: previous?.speaker,
      speakerEvidence: previous?.speakerEvidence,
      receivedAtMs: Date.now(),
    });
  }

  private finishSessionCapture(target: "pause" | "end"): void {
    if (this.finishing) {
      if (target === "end") this.finishing = "end";
      return;
    }
    const generation = this.captureGeneration;
    const sessionGeneration = this.sessionGeneration;
    if (generation === null || sessionGeneration === null) {
      if (target === "end") this.completeEnd(sessionGeneration);
      return;
    }
    this.finishing = target;
    this.status = target === "end" ? "Finishing transcript" : "Pausing after final words";
    const epoch = ++this.transitionEpoch;
    this.requestRender();
    void this.options.finishCapture(generation)
      .catch(() => undefined)
      .then(() => {
        if (
          epoch !== this.transitionEpoch ||
          this.captureGeneration !== generation ||
          this.sessionGeneration !== sessionGeneration
        ) return;
        const finalTarget = this.finishing;
        this.finalizeLiveText();
        if (finalTarget === "pause") this.captions.pause(generation);
        else this.captions.stop(generation);
        this.captureGeneration = null;
        this.finishing = null;
        if (finalTarget === "pause") {
          this.conversation.pause(sessionGeneration, Date.now());
          this.status = "Paused";
          this.view = "live";
        } else {
          this.completeEnd(sessionGeneration);
        }
        this.requestRender();
      });
  }

  /** Privacy/lifecycle exits cancel immediately instead of waiting on a provider. */
  private endImmediately(finalStatus = "Audio deleted from memory"): void {
    if (!this.isSessionOpen()) return;
    this.transitionEpoch++;
    this.finishing = null;
    this.finalizeLiveText();
    const generation = this.captureGeneration;
    if (generation !== null) this.captions.stop(generation);
    this.stopCapture();
    this.completeEnd(this.sessionGeneration, finalStatus);
    this.requestRender();
  }

  /** Voice UI needs the mic now; preserve known text but never delay its handoff. */
  private pauseImmediately(): void {
    if (this.phase() !== "active" || this.sessionGeneration === null) return;
    this.transitionEpoch++;
    this.finishing = null;
    this.finalizeLiveText();
    const generation = this.captureGeneration;
    if (generation !== null) this.captions.pause(generation);
    this.stopCapture();
    this.conversation.pause(this.sessionGeneration, Date.now());
    this.status = "Paused for voice input";
    this.view = "live";
    this.requestRender();
  }

  private completeEnd(
    sessionGeneration: number | null,
    finalStatus = "Audio deleted from memory",
  ): void {
    if (sessionGeneration !== null) this.conversation.end(sessionGeneration, Date.now());
    this.status = finalStatus;
    this.view = "review";
  }

  private stopCapture(): void {
    const generation = this.captureGeneration;
    this.captureGeneration = null;
    if (generation !== null && generation > 0) this.options.stopCapture(generation);
  }

  private currentCues(): readonly ConversationCue[] {
    return this.conversation.snapshot().cues;
  }

  private paintPreflight(image: GrayImage, width: number, height: number): GrayImage {
    const small = getDefaultSmallFont();
    const medium = getDefaultMediumFont();
    this.provider = currentConversateProvider();
    image.drawText(medium, 20, 10, "CONVERSATE", 240);
    image.drawLine(20, 34, width - 20, 34, 80);
    const local = this.provider.locality === "local";
    image.drawText(small, 20, 48, truncateText(small, `PROVIDER  ${this.provider.label}`, width - 40), 225);
    image.drawText(small, 20, 68, truncateText(small, conversatePrivacyStatus(this.provider), width - 40), local ? 220 : 180);
    image.drawText(
      small,
      20,
      94,
      truncateText(small, `GLASSES MIC · ${captionSourceLanguageSetting.get().toUpperCase()}`, width - 40),
      150,
    );
    image.drawText(small, 20, 120, "Live transcript + local conversation cues", 190);
    image.drawText(small, 20, 140, "Please inform participants before listening.", 150);
    image.drawText(small, 20, 164, truncateText(small, this.status, width - 40), 170);
    this.drawFooter(image, small, height, "scroll provider  · start  ·· back");
    return image;
  }

  private paintLive(image: GrayImage, width: number, height: number): GrayImage {
    const small = getDefaultSmallFont();
    const snapshot = this.conversation.snapshot();
    const phase = this.finishing ? "FINISHING" : snapshot.phase === "paused" ? "PAUSED" : "LISTENING";
    image.drawText(small, 18, 8, truncateText(small, `CONVERSATE · ${formatElapsed(snapshot.elapsedMs)} · ${phase}`, width - 36), 230);
    image.drawText(small, 18, 27, truncateText(small, conversatePrivacyStatus(this.provider), width - 36), this.provider.locality === "local" ? 200 : 150);
    const cues = snapshot.cues;
    let transcriptTop = 55;
    if (cues.length) {
      const cue = cues[this.selectedCue % cues.length]!;
      image.drawRoundedRect(18, 49, width - 36, 54, 45, 8);
      image.drawText(small, 30, 58, `${cue.kind.toUpperCase()}  ${this.selectedCue + 1}/${cues.length}`, 210);
      image.drawText(small, 30, 78, truncateText(small, cue.text, width - 60), 235);
      transcriptTop = 113;
    }
    image.drawText(small, 18, transcriptTop, "TRANSCRIPT", 120);
    const font = conversationFont();
    const footerY = height - 18;
    const bodyTop = transcriptTop + 18;
    const maxLines = Math.max(1, Math.floor((footerY - bodyTop - 2) / font.lineHeight));
    const caption = this.captions.snapshot();
    const source = caption.displaySource || [snapshot.fullTranscript, snapshot.liveText].filter(Boolean).join(" ") ||
      (snapshot.phase === "paused" ? "Paused" : "Listening...");
    const targetLanguage = captionTargetLanguageSetting.get();
    const translationEnabled = targetLanguage !== "off" && captionProviderCapabilities(this.provider.effective).translation;
    const translation = caption.displayTranslation || (translationEnabled ? "Translation waiting..." : "");
    const layout = translationEnabled ? captionLayoutSetting.get() : "source";
    if (layout === "split") {
      const sourceLines = Math.max(1, Math.floor(maxLines / 3));
      const translationLines = Math.max(1, maxLines - sourceLines);
      this.drawBottomAnchored(image, font, source, bodyTop, sourceLines, width - 36, 180);
      const dividerY = bodyTop + sourceLines * font.lineHeight + 1;
      image.drawLine(18, dividerY, width - 18, dividerY, 65);
      this.drawBottomAnchored(image, font, translation, dividerY + 4, translationLines, width - 36, 235);
    } else {
      const primary = layout === "translation" && caption.translationCurrent ? translation : source;
      this.drawBottomAnchored(image, font, primary, bodyTop, maxLines, width - 36, 235);
    }
    const footer = this.finishing
      ? "Finalizing provider transcript..."
      : snapshot.phase === "paused"
      ? `${GESTURE_CLICK} resume  ${GESTURE_DOUBLE_CLICK} end`
      : cues.length
        ? `scroll cues  ${GESTURE_CLICK} details  ${GESTURE_DOUBLE_CLICK} end`
        : `${GESTURE_CLICK} pause  ${GESTURE_DOUBLE_CLICK} end`;
    this.drawFooter(image, small, height, footer);
    return image;
  }

  private paintCue(image: GrayImage, width: number, height: number): GrayImage {
    const small = getDefaultSmallFont();
    const medium = getDefaultMediumFont();
    const cues = this.currentCues();
    const cue = cues[this.selectedCue % Math.max(1, cues.length)];
    image.drawText(small, 20, 10, `LOCAL CUE · ${cue?.kind.toUpperCase() ?? "NOTE"}`, 180);
    image.drawLine(20, 31, width - 20, 31, 80);
    const lines = wrapCaptionText(cue?.text ?? "Cue is no longer available.", width - 48, (text) => medium.measureText(text));
    for (let index = 0; index < Math.min(7, lines.length); index++) {
      image.drawText(medium, 24, 48 + index * medium.lineHeight, lines[index]!, 235);
    }
    image.drawText(small, 24, height - 42, "Heuristic note · not an external fact", 130);
    this.drawFooter(image, small, height, `${GESTURE_CLICK} back  ${GESTURE_DOUBLE_CLICK} back`);
    return image;
  }

  private paintReview(image: GrayImage, width: number, height: number): GrayImage {
    const small = getDefaultSmallFont();
    const medium = getDefaultMediumFont();
    const snapshot = this.conversation.snapshot();
    image.drawText(medium, 20, 9, "SESSION COMPLETE", 235);
    image.drawText(small, 20, 34, `${formatElapsed(snapshot.elapsedMs)} · ${snapshot.wordCount} words · ${snapshot.utteranceCount} turns`, 170);
    image.drawText(small, 20, 55, "AUDIO RELEASED · TEXT NOT SAVED", 200);
    const actions = snapshot.cues.filter((cue) => cue.kind === "action");
    const questions = snapshot.cues.filter((cue) => cue.kind === "question");
    image.drawText(small, 20, 80, `LOCAL CUES  ${actions.length} action · ${questions.length} question`, 150);
    const latest = snapshot.utterances[snapshot.utterances.length - 1]?.text ?? "No transcript captured.";
    const lines = wrapCaptionText(latest, width - 40, (text) => small.measureText(text));
    for (let index = 0; index < Math.min(5, lines.length); index++) {
      image.drawText(small, 20, 106 + index * small.lineHeight, lines[index]!, 220);
    }
    image.drawText(small, 20, height - 41, truncateText(small, this.status, width - 40), 140);
    this.drawFooter(image, small, height, `${GESTURE_CLICK} new session  ${GESTURE_DOUBLE_CLICK} back`);
    return image;
  }

  private drawBottomAnchored(
    image: GrayImage,
    font: BdfFont,
    text: string,
    top: number,
    maxLines: number,
    maxWidth: number,
    color: number,
  ): void {
    const wrapped = wrapCaptionText(text, maxWidth, (value) => font.measureText(value));
    const lines = bottomAnchoredLines(wrapped, maxLines, 0);
    for (let index = 0; index < lines.length; index++) {
      image.drawText(font, 18, top + index * font.lineHeight, lines[index]!, color);
    }
  }

  private drawFooter(image: GrayImage, font: BdfFont, height: number, text: string): void {
    image.drawLine(16, height - 25, image.width - 16, height - 25, 55);
    image.drawText(font, 18, height - 18, truncateText(font, text, image.width - 36), 125);
  }
}

function conversationFont(): BdfFont {
  return captionFontSizeSetting.get() === "large" ? getDefaultMediumFont() : getDefaultSmallFont();
}

function formatElapsed(elapsedMs: number): string {
  const seconds = Math.max(0, Math.floor(elapsedMs / 1_000));
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function visualStatus(status: string): string {
  const value = String(status).slice(0, 120);
  if (/error|failed|unavailable|permission/i.test(value)) return `ERROR · ${value}`;
  if (/connect|network/i.test(value)) return `NETWORK · ${value}`;
  if (/listen/i.test(value)) return "Listening";
  return value;
}
