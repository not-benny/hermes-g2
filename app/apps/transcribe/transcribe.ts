import { GrayImage } from "../../graphics/image";
import {
  getDefaultLargeFont,
  getDefaultMediumFont,
  getDefaultSmallFont,
  type BdfFont,
} from "../../graphics/bdffont";
import { CaptionSession, bottomAnchoredLines, wrapCaptionText } from "../../captions/caption-session";
import { captionProviderCapabilities } from "../../captions/caption-settings";
import { voiceControlBridge, type VoiceTranscriptEvent } from "../../native/voice-control";
import {
  captionFontSizeSetting,
  captionLayoutSetting,
  captionLineSpacingSetting,
  captionMaxLinesSetting,
  captionTargetLanguageSetting,
  voiceProviderSetting,
} from "../../ui/dashboard-settings";
import { GESTURE_CLICK, GESTURE_DOUBLE_CLICK } from "../../ui/gestures";
import { Layer, type DashboardInputEvent, type LayerContext } from "../../ui/layers";

export type TranscribeLayerOptions = {
  startCapture: () => void;
  stopCapture: () => void;
};

/**
 * Accessibility-first volatile live captions. Capture is active only while the
 * window is foreground and the display is on; closing/pausing clears the exact
 * capture lease and late generations fail closed in CaptionSession.
 */
export class TranscribeLayer implements Layer {
  private readonly captions = new CaptionSession();
  private foreground = false;
  private screenOn = false;
  private userPaused = false;
  private voiceInputActive = false;
  private captureRequested = false;
  private historyOffset = 0;
  private status = "[STOPPED]";
  private requestRender: () => void = () => {};
  private unsubscribeTranscript: (() => void) | null = null;
  private unsubscribeStatus: (() => void) | null = null;

  constructor(private readonly options: TranscribeLayerOptions) {}

  start(requestRender: () => void): void {
    this.requestRender = requestRender;
    this.unsubscribeTranscript = voiceControlBridge.onTranscript((event) => {
      this.onTranscript(event);
      requestRender();
    });
    this.unsubscribeStatus = voiceControlBridge.onStatus((state) => {
      if (!this.captureRequested) return;
      if (this.captions.snapshot().generation !== state.generation) {
        this.captions.begin(state.generation, Date.now());
      }
      this.status = visualStatus(state.status);
      requestRender();
    });
  }

  onForegroundChanged(foreground: boolean): void {
    this.foreground = foreground;
    this.reconcileCapture();
  }

  onScreenChanged(on: boolean): void {
    this.screenOn = on;
    this.reconcileCapture();
  }

  onVoiceInputChanged(active: boolean): void {
    this.voiceInputActive = active;
    this.reconcileCapture();
  }

  isPaused(): boolean {
    return this.userPaused;
  }

  togglePaused(): void {
    this.userPaused = !this.userPaused;
    this.reconcileCapture();
    this.requestRender();
  }

  clear(): void {
    this.captions.clear();
    this.historyOffset = 0;
    this.status = this.captureRequested ? "[LIVE] Captions cleared" : this.status;
    this.requestRender();
  }

  paint(ctx: LayerContext): GrayImage {
    const font = captionFont();
    const { width, height } = ctx.stack.getBaseSize();
    const image = new GrayImage(width, height, 0);
    const snapshot = this.captions.snapshot();
    const provider = voiceProviderSetting.get();
    const target = captionTargetLanguageSetting.get();
    const capabilities = captionProviderCapabilities(provider);
    const translationEnabled = target !== "off" && capabilities.translation;
    const layout = translationEnabled ? captionLayoutSetting.get() : "source";
    const lineGap = captionLineSpacingSetting.get() === "compact" ? 0 : captionLineSpacingSetting.get() === "relaxed" ? 4 : 2;
    const lineHeight = font.lineHeight + lineGap;
    const bodyTop = 50;
    const footerY = height - 18;
    const availableLines = Math.max(1, Math.min(Number(captionMaxLinesSetting.get()), Math.floor((footerY - bodyTop) / lineHeight)));
    const textWidth = width - 48;

    image.drawText(font, 24, 10, `Captions ${this.captureRequested ? "[LIVE]" : this.userPaused ? "[PAUSED]" : "[STOPPED]"}`, 230);
    const details = [
      this.historyOffset ? `[HISTORY +${this.historyOffset}]` : "",
      translationEnabled && snapshot.translationPending ? `[TR WAIT ${snapshot.translationLagMs ?? 0}ms]` : "",
      snapshot.droppedEvents ? `[DROP ${snapshot.droppedEvents}]` : "",
      snapshot.droppedAudioFrames ? `[AUDIO DROP ${snapshot.droppedAudioFrames}]` : "",
    ].filter(Boolean).join(" ");
    image.drawText(font, 24, 30, details || this.status, 150);

    const source = snapshot.displaySource || (this.captureRequested ? "Listening..." : "No captions");
    const translation = snapshot.displayTranslation || (translationEnabled ? "Translation waiting..." : "");

    if (layout === "split") {
      const sourceLines = Math.max(1, Math.floor(availableLines / 3));
      const translationLines = Math.max(1, availableLines - sourceLines);
      this.drawBottomAnchored(image, font, source, bodyTop, sourceLines, lineHeight, textWidth, 170);
      const translationTop = bodyTop + sourceLines * lineHeight + 4;
      image.drawLine(24, translationTop - 3, width - 24, translationTop - 3, 80);
      this.drawBottomAnchored(image, font, translation, translationTop, translationLines, lineHeight, textWidth, 240);
    } else {
      const primary = layout === "translation" && snapshot.displayTranslation ? translation : source;
      this.drawBottomAnchored(image, font, primary, bodyTop, availableLines, lineHeight, textWidth, 235);
    }

    const action = this.userPaused ? "resume" : "pause";
    image.drawText(font, 24, footerY, `${GESTURE_CLICK} ${action}   up/down history   ${GESTURE_DOUBLE_CLICK} back`, 120);
    return image;
  }

  handleInput(event: DashboardInputEvent): void {
    if (event.type === "click") {
      this.togglePaused();
      return;
    }
    if (event.type === "scroll-up") {
      this.historyOffset = Math.min(1_024, this.historyOffset + 1);
      this.requestRender();
      return;
    }
    if (event.type === "scroll-down") {
      this.historyOffset = Math.max(0, this.historyOffset - 1);
      this.requestRender();
    }
  }

  onRemoved(): void {
    this.foreground = false;
    this.screenOn = false;
    this.stopCapture();
    this.captions.clear();
    this.unsubscribeTranscript?.();
    this.unsubscribeTranscript = null;
    this.unsubscribeStatus?.();
    this.unsubscribeStatus = null;
  }

  private reconcileCapture(): void {
    const shouldCapture = this.foreground && this.screenOn && !this.userPaused && !this.voiceInputActive;
    if (shouldCapture && !this.captureRequested) {
      this.captureRequested = true;
      this.status = "[STARTING]";
      this.options.startCapture();
    } else if (!shouldCapture && this.captureRequested) {
      this.stopCapture();
    }
  }

  private stopCapture(): void {
    if (!this.captureRequested) return;
    const generation = this.captions.snapshot().generation;
    this.captureRequested = false;
    this.options.stopCapture();
    if (this.userPaused) this.captions.pause(generation);
    else this.captions.stop(generation);
    this.status = this.userPaused ? "[PAUSED]" : "[STOPPED]";
  }

  private onTranscript(event: VoiceTranscriptEvent): void {
    if (!this.captureRequested) return;
    if (this.captions.snapshot().generation !== event.generation) {
      this.captions.begin(event.generation, event.receivedAtMs);
    }
    this.captions.apply({ type: "transcript", ...event });
    if (this.historyOffset === 0) this.historyOffset = 0;
  }

  private drawBottomAnchored(
    image: GrayImage,
    font: BdfFont,
    text: string,
    top: number,
    maxLines: number,
    lineHeight: number,
    maxWidth: number,
    color: number,
  ): void {
    const wrapped = wrapCaptionText(text, maxWidth, (value) => font.measureText(value));
    const lines = bottomAnchoredLines(wrapped, maxLines, this.historyOffset);
    for (let index = 0; index < lines.length; index++) {
      image.drawText(font, 24, top + index * lineHeight, lines[index]!, color);
    }
  }
}

function captionFont(): BdfFont {
  switch (captionFontSizeSetting.get()) {
    case "large": return getDefaultLargeFont();
    case "small": return getDefaultSmallFont();
    default: return getDefaultMediumFont();
  }
}

function visualStatus(status: string): string {
  const lower = status.toLowerCase();
  if (lower.includes("permission") || lower.includes("unavailable")) return `[MIC ERROR] ${status}`;
  if (lower.includes("connect") || lower.includes("network")) return `[NETWORK] ${status}`;
  if (lower.includes("error") || lower.includes("failed")) return `[PROVIDER ERROR] ${status}`;
  if (lower.includes("listen")) return "[LIVE] Listening";
  if (lower.includes("stop")) return "[STOPPED]";
  return `[STARTING] ${status}`;
}
