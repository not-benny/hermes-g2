import { CaptionSession, bottomAnchoredLines, wrapCaptionText } from "../../captions/caption-session";
import { assistantBridge } from "../../assistant/bridge-client";
import type { HostConversateCuesCall } from "../../assistant/host-session-mcp-client";
import { captionProviderCapabilities } from "../../captions/caption-settings";
import { getDefaultMediumFont, getDefaultSmallFont, type BdfFont } from "../../graphics/bdffont";
import { GrayImage } from "../../graphics/image";
import { truncateText } from "../../graphics/textwrap";
import { voiceControlBridge, type VoiceTranscriptEvent } from "../../native/voice-control";
import {
  captionFontSizeSetting,
  conversateHermesCuesSetting,
  captionLayoutSetting,
  captionSourceLanguageSetting,
  captionTargetLanguageSetting,
  onAnySettingChanged,
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

const HERMES_CUE_PARTIAL_DEBOUNCE_MS = 500;
const HERMES_CUE_PARTIAL_MAX_WAIT_MS = 1_000;
const HERMES_CUE_PARTIAL_MIN_SCALARS = 8;
const HERMES_CUE_PARTIAL_MIN_WORDS = 2;
const HERMES_CUE_TRANSCRIPT_SCALARS = 4_096;

/**
 * Local-first conversation assistance over the existing generation-gated mic
 * bridge. Audio remains owned by FaceclawVoiceController; this layer consumes
 * provider-neutral text events only and never persists audio or text. With
 * explicit opt-in, bounded recent text may use the isolated Hermes cue lane.
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
  private hermesCues: readonly ConversationCue[] = [];
  private hermesCueCall: HostConversateCuesCall | null = null;
  private hermesCueSessionId: string | null = null;
  private hermesCueRevision = 0;
  private hermesCueActiveKey: string | null = null;
  private hermesCueLatestKey: string | null = null;
  private hermesCueResultKey: string | null = null;
  private hermesCuePendingTranscript: string | null = null;
  private hermesCueDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private hermesCueMaxWaitTimer: ReturnType<typeof setTimeout> | null = null;
  private finishing: "pause" | "end" | null = null;
  private transitionEpoch = 0;
  private status = "Ready";
  private lastTranscriptEvent: VoiceTranscriptEvent | null = null;
  private requestRender: () => void = () => {};
  private unsubscribeTranscript: (() => void) | null = null;
  private unsubscribeStatus: (() => void) | null = null;
  private unsubscribeSettings: (() => void) | null = null;
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
    this.unsubscribeSettings = onAnySettingChanged(() => {
      if (!conversateHermesCuesSetting.get()) this.resetHermesCues(this.hermesCueSessionId);
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
    this.resetHermesCues(`cv-${captureGeneration}-${Date.now().toString(36)}`);
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
    this.resetHermesCues(null);
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
    this.resetHermesCues(null);
    this.conversation.clear();
    this.captions.clear();
    this.unsubscribeTranscript?.();
    this.unsubscribeTranscript = null;
    this.unsubscribeStatus?.();
    this.unsubscribeStatus = null;
    this.unsubscribeSettings?.();
    this.unsubscribeSettings = null;
    if (this.clockTimer !== null) clearInterval(this.clockTimer);
    this.clockTimer = null;
  }

  private onTranscript(event: VoiceTranscriptEvent): void {
    if (event.generation !== this.captureGeneration || this.sessionGeneration === null) return;
    this.lastTranscriptEvent = { ...event };
    this.captions.apply({ type: "transcript", ...event });
    this.conversation.apply({ ...event, generation: this.sessionGeneration });
    this.requestHermesCues(event.isFinal ? "final" : "partial");
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
    this.requestHermesCues("final");
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
    this.clearHermesCueTimers();
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
    if (conversateHermesCuesSetting.get() && this.hermesCues.length) return this.hermesCues;
    return this.conversation.snapshot().cues;
  }

  private requestHermesCues(kind: "partial" | "final"): void {
    if (!conversateHermesCuesSetting.get() || this.hermesCueSessionId === null) {
      this.resetHermesCues(this.hermesCueSessionId);
      return;
    }
    const snapshot = this.conversation.snapshot();
    const transcript = Array.from(
      [snapshot.fullTranscript, snapshot.liveText].filter(Boolean).join(" ").replace(/\s+/gu, " ").trim(),
    ).slice(-HERMES_CUE_TRANSCRIPT_SCALARS).join("").trim();

    const key = transcript.toLocaleLowerCase();
    const meaningfulPartial = Array.from(transcript).length >= HERMES_CUE_PARTIAL_MIN_SCALARS &&
      transcript.split(/\s+/u).length >= HERMES_CUE_PARTIAL_MIN_WORDS;

    if (key !== this.hermesCueLatestKey) {
      this.hermesCueLatestKey = key;
      this.hermesCuePendingTranscript = transcript;
      this.hermesCues = [];
      this.hermesCueResultKey = null;
    } else if (kind === "partial") {
      return;
    }

    if (!transcript || (kind === "partial" && !meaningfulPartial)) {
      this.clearHermesCueTimers();
      this.hermesCuePendingTranscript = null;
      if (this.hermesCueCall && this.hermesCueActiveKey !== key) {
        const staleCall = this.hermesCueCall;
        this.hermesCueCall = null;
        this.hermesCueActiveKey = null;
        staleCall.cancel("Superseded by newer transcript");
      }
      return;
    }

    if (kind === "final") {
      this.clearHermesCueTimers();
      if (this.hermesCueActiveKey === key || this.hermesCueResultKey === key) {
        this.hermesCuePendingTranscript = null;
        return;
      }
      this.hermesCuePendingTranscript = transcript;
      this.flushHermesCues();
      return;
    }

    if (this.finishing) return;
    if (this.hermesCueDebounceTimer !== null) clearTimeout(this.hermesCueDebounceTimer);
    this.hermesCueDebounceTimer = setTimeout(() => this.flushHermesCues(), HERMES_CUE_PARTIAL_DEBOUNCE_MS);
    if (this.hermesCueMaxWaitTimer === null) {
      this.hermesCueMaxWaitTimer = setTimeout(() => this.flushHermesCues(), HERMES_CUE_PARTIAL_MAX_WAIT_MS);
    }
  }

  private flushHermesCues(): void {
    this.clearHermesCueTimers();
    const transcript = this.hermesCuePendingTranscript;
    this.hermesCuePendingTranscript = null;
    if (!transcript || !conversateHermesCuesSetting.get() || this.hermesCueSessionId === null) return;
    const key = transcript.toLocaleLowerCase();
    if (key !== this.hermesCueLatestKey || this.hermesCueActiveKey === key || this.hermesCueResultKey === key) return;
    this.hermesCues = [];
    this.hermesCueCall?.cancel("Superseded by newer transcript");
    this.hermesCueCall = null;
    this.hermesCueActiveKey = null;
    const revision = ++this.hermesCueRevision;
    const sessionId = this.hermesCueSessionId;
    const call = assistantBridge.requestConversateCues({ sessionId, revision, transcript });
    if (!call) {
      if (this.hermesCueLatestKey === key) this.hermesCueLatestKey = null;
      return;
    }
    this.hermesCueCall = call;
    this.hermesCueActiveKey = key;
    void call.result.then((result) => {
      if (this.hermesCueCall !== call) return;
      this.hermesCueCall = null;
      this.hermesCueActiveKey = null;
      if (this.hermesCueSessionId !== sessionId || this.hermesCueLatestKey !== key ||
          result.sessionId !== sessionId || result.revision !== revision ||
          !conversateHermesCuesSetting.get()) return;
      this.hermesCueResultKey = key;
      this.hermesCues = result.cues.map((cue) => ({ kind: cue.kind, text: cue.text }));
      const cues = this.currentCues();
      this.selectedCue = cues.length ? Math.min(this.selectedCue, cues.length - 1) : 0;
      this.requestRender();
    }).catch(() => {
      if (this.hermesCueCall === call) {
        this.hermesCueCall = null;
        this.hermesCueActiveKey = null;
        if (this.hermesCueLatestKey === key) this.hermesCueLatestKey = null;
      }
      // Silent local fallback: no shell alert, Working state, or AssistantLayer.
    });
  }

  private resetHermesCues(sessionId: string | null): void {
    this.clearHermesCueTimers();
    this.hermesCueCall?.cancel("Conversate session changed");
    this.hermesCueCall = null;
    this.hermesCues = [];
    this.hermesCueRevision = 0;
    this.hermesCueSessionId = sessionId;
    this.hermesCueActiveKey = null;
    this.hermesCueLatestKey = null;
    this.hermesCueResultKey = null;
    this.hermesCuePendingTranscript = null;
  }

  private clearHermesCueTimers(): void {
    if (this.hermesCueDebounceTimer !== null) clearTimeout(this.hermesCueDebounceTimer);
    if (this.hermesCueMaxWaitTimer !== null) clearTimeout(this.hermesCueMaxWaitTimer);
    this.hermesCueDebounceTimer = null;
    this.hermesCueMaxWaitTimer = null;
  }

  private cueSource(): "HERMES" | "LOCAL" {
    return conversateHermesCuesSetting.get() && this.hermesCues.length ? "HERMES" : "LOCAL";
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
    image.drawText(
      small,
      20,
      120,
      conversateHermesCuesSetting.get()
        ? "Hermes cues on · recent transcript text is sent"
        : "Live transcript + local conversation cues",
      190,
    );
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
    const processing = conversateHermesCuesSetting.get()
      ? `${conversatePrivacyStatus(this.provider)} · TEXT→HERMES`
      : conversatePrivacyStatus(this.provider);
    image.drawText(small, 18, 27, truncateText(small, processing, width - 36), this.provider.locality === "local" ? 200 : 150);
    const cues = this.currentCues();
    let transcriptTop = 55;
    if (cues.length) {
      const cue = cues[this.selectedCue % cues.length]!;
      image.drawRoundedRect(18, 49, width - 36, 54, 45, 8);
      image.drawText(small, 30, 58, `${this.cueSource()} ${cue.kind.toUpperCase()}  ${this.selectedCue + 1}/${cues.length}`, 210);
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
    const source = this.cueSource();
    image.drawText(small, 20, 10, `${source} CUE · ${cue?.kind.toUpperCase() ?? "NOTE"}`, 180);
    image.drawLine(20, 31, width - 20, 31, 80);
    const lines = wrapCaptionText(cue?.text ?? "Cue is no longer available.", width - 48, (text) => medium.measureText(text));
    for (let index = 0; index < Math.min(7, lines.length); index++) {
      image.drawText(medium, 24, 48 + index * medium.lineHeight, lines[index]!, 235);
    }
    image.drawText(
      small,
      24,
      height - 42,
      source === "HERMES" ? "AI suggestion · verify before relying" : "Heuristic note · not an external fact",
      130,
    );
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
    const cues = this.currentCues();
    const actions = cues.filter((cue) => cue.kind === "action");
    const questions = cues.filter((cue) => cue.kind === "question");
    image.drawText(small, 20, 80, `${this.cueSource()} CUES  ${actions.length} action · ${questions.length} question`, 150);
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
