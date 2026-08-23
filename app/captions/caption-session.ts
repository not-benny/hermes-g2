export type CaptionTranscriptEvent = {
  generation: number;
  type: "transcript";
  /** Whole current best source transcript; partials use replace semantics. */
  text: string;
  isFinal: boolean;
  language?: string;
  confidence?: number;
  speaker?: string;
  /** True only when the provider supplied a documented speaker identifier. */
  speakerEvidence?: boolean;
  translationText?: string;
  translationIsFinal?: boolean;
  targetLanguage?: string;
  droppedAudioFrames?: number;
  sourceFinalDelta?: string;
  translationFinalDelta?: string;
  sourceRevisionPresent?: boolean;
  translationRevisionPresent?: boolean;
  receivedAtMs: number;
};

export type CaptionStateEvent = {
  generation: number;
  type: "state";
  state: "starting" | "listening" | "reconnecting" | "stopped" | "error";
  /** Bounded provider-neutral message; never transcript or credential content. */
  message?: string;
  receivedAtMs: number;
};

export type CaptionEvent = CaptionTranscriptEvent | CaptionStateEvent;

export type CaptionSegment = {
  source: string;
  translation: string;
  language: string | null;
  targetLanguage: string | null;
  confidence: number | null;
  speakerLabel: string | null;
  sourceReceivedAtMs: number;
  translationReceivedAtMs: number | null;
};

export type CaptionSessionSnapshot = {
  generation: number;
  phase: "idle" | "starting" | "listening" | "paused" | "reconnecting" | "stopped" | "error";
  status: string;
  segments: readonly CaptionSegment[];
  displaySource: string;
  displayTranslation: string;
  partial: boolean;
  translationPending: boolean;
  translationCurrent: boolean;
  translationLagMs: number | null;
  language: string | null;
  confidence: number | null;
  speakerLabel: string | null;
  firstTokenLatencyMs: number | null;
  finalTokenLatencyMs: number | null;
  droppedEvents: number;
  droppedAudioFrames: number;
};

export type CaptionSessionOptions = {
  maxSegments?: number;
  maxCodePoints?: number;
};

const DEFAULT_MAX_SEGMENTS = 256;
const DEFAULT_MAX_CODE_POINTS = 32_768;
const MAX_EVENT_CODE_POINTS = 2_048;

function boundedText(value: unknown): string {
  return Array.from(String(value ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " "))
    .slice(0, MAX_EVENT_CODE_POINTS)
    .join("")
    .trim();
}

function boundedConfidence(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
}

/**
 * Pure, in-memory caption reducer. A caller owns capture and supplies its exact
 * generation on every event; stale, paused and stopped events fail closed.
 */
export class CaptionSession {
  private readonly maxSegments: number;
  private readonly maxCodePoints: number;
  private generation = 0;
  private phase: CaptionSessionSnapshot["phase"] = "idle";
  private status = "Captions stopped";
  private startedAtMs = 0;
  private firstTokenAtMs: number | null = null;
  private finalTokenAtMs: number | null = null;
  private droppedEvents = 0;
  private droppedAudioFrames = 0;
  private segments: CaptionSegment[] = [];
  private liveSource = "";
  private liveTranslation = "";
  private liveLanguage: string | null = null;
  private liveConfidence: number | null = null;
  private liveSpeakerLabel: string | null = null;
  private liveSourceAtMs: number | null = null;
  private liveTranslationAtMs: number | null = null;
  private translationIsFinal = false;
  private readonly speakers = new Map<string, string>();

  constructor(options: CaptionSessionOptions = {}) {
    this.maxSegments = Math.max(1, Math.min(1_024, options.maxSegments ?? DEFAULT_MAX_SEGMENTS));
    this.maxCodePoints = Math.max(1, Math.min(131_072, options.maxCodePoints ?? DEFAULT_MAX_CODE_POINTS));
  }

  begin(generation: number, nowMs: number): void {
    this.generation = generation;
    this.phase = "starting";
    this.status = "Starting microphone...";
    this.startedAtMs = nowMs;
    this.firstTokenAtMs = null;
    this.finalTokenAtMs = null;
    this.clearLive();
  }

  pause(generation: number): void {
    if (generation !== this.generation) return;
    this.generation++;
    this.phase = "paused";
    this.status = "Paused";
    this.clearLive();
  }

  stop(generation = this.generation): void {
    if (generation !== this.generation) return;
    this.generation++;
    this.phase = "stopped";
    this.status = "Stopped";
    this.clearLive();
  }

  clear(): void {
    this.segments = [];
    this.clearLive();
    this.speakers.clear();
  }

  apply(event: CaptionEvent): boolean {
    if (event.generation !== this.generation || ["paused", "stopped", "idle"].includes(this.phase)) {
      this.droppedEvents++;
      return false;
    }
    if (event.type === "state") {
      this.phase = event.state === "listening" ? "listening" : event.state;
      this.status = boundedText(event.message) || stateStatus(event.state);
      return true;
    }

    const source = boundedText(event.text);
    const translation = boundedText(event.translationText);
    const sourceFinalDelta = boundedText(event.sourceFinalDelta);
    const translationFinalDelta = boundedText(event.translationFinalDelta);
    const speakerLabel = event.speakerEvidence && event.speaker ? this.labelSpeaker(event.speaker) : null;
    if (!source && !translation && !sourceFinalDelta && !translationFinalDelta && !event.isFinal) return true;
    if (this.firstTokenAtMs === null && (source || translation || sourceFinalDelta || translationFinalDelta)) {
      this.firstTokenAtMs = event.receivedAtMs;
    }
    this.phase = "listening";
    this.status = "Listening";
    if (sourceFinalDelta || translationFinalDelta) {
      if (sourceFinalDelta) {
        this.segments.push({
          source: sourceFinalDelta,
          translation: translationFinalDelta,
          language: boundedText(event.language).slice(0, 32) || null,
          targetLanguage: boundedText(event.targetLanguage).slice(0, 32) || null,
          confidence: boundedConfidence(event.confidence),
          speakerLabel,
          sourceReceivedAtMs: event.receivedAtMs,
          translationReceivedAtMs: translationFinalDelta ? event.receivedAtMs : null,
        });
      } else {
        const pending = this.segments.find((entry) => entry.source && !entry.translation);
        if (pending) {
          pending.translation = translationFinalDelta;
          pending.translationReceivedAtMs = event.receivedAtMs;
        } else {
          this.segments.push({
            source: "",
            translation: translationFinalDelta,
            language: null,
            targetLanguage: boundedText(event.targetLanguage).slice(0, 32) || null,
            confidence: null,
            speakerLabel,
            sourceReceivedAtMs: event.receivedAtMs,
            translationReceivedAtMs: event.receivedAtMs,
          });
        }
      }
      this.enforceBounds();
    }
    const sourceRevisionPresent = event.sourceRevisionPresent ?? true;
    const translationRevisionPresent = event.translationRevisionPresent ?? event.translationText !== undefined;
    if (sourceRevisionPresent) this.liveSource = source;
    if (sourceRevisionPresent && !translationRevisionPresent) {
      // A translation belongs to one exact source revision. A newer source
      // invalidates the old live translation immediately so translation-first
      // rendering falls back to the current source.
      this.liveTranslation = "";
      this.liveTranslationAtMs = null;
      this.translationIsFinal = false;
    }
    if (translationRevisionPresent) this.liveTranslation = translation;
    this.liveLanguage = boundedText(event.language).slice(0, 32) || null;
    this.liveConfidence = boundedConfidence(event.confidence);
    this.liveSpeakerLabel = speakerLabel;
    if (sourceRevisionPresent && source) this.liveSourceAtMs = event.receivedAtMs;
    if (translationRevisionPresent) this.liveTranslationAtMs = translation ? event.receivedAtMs : null;
    if (translationRevisionPresent) this.translationIsFinal = Boolean(event.translationIsFinal);
    if (typeof event.droppedAudioFrames === "number" && Number.isFinite(event.droppedAudioFrames)) {
      this.droppedAudioFrames = Math.max(this.droppedAudioFrames, Math.max(0, Math.floor(event.droppedAudioFrames)));
    }

    if (event.isFinal) {
      const finalSource = source;
      if (finalSource || translation) {
        this.segments.push({
          source: finalSource,
          translation,
          language: this.liveLanguage,
          targetLanguage: boundedText(event.targetLanguage).slice(0, 32) || null,
          confidence: this.liveConfidence,
          speakerLabel,
          sourceReceivedAtMs: this.liveSourceAtMs ?? event.receivedAtMs,
          translationReceivedAtMs: translation ? event.receivedAtMs : null,
        });
        this.enforceBounds();
      }
      this.finalTokenAtMs = event.receivedAtMs;
      this.clearLive();
    }
    return true;
  }

  snapshot(nowMs = Date.now()): CaptionSessionSnapshot {
    const finalizedSource = this.segments.map((entry) => entry.source).filter(Boolean).join(" ");
    const finalizedTranslation = this.segments.map((entry) => entry.translation).filter(Boolean).join(" ");
    const displaySource = [finalizedSource, this.liveSource].filter(Boolean).join(" ");
    const displayTranslation = [finalizedTranslation, this.liveTranslation].filter(Boolean).join(" ");
    const latest = this.segments[this.segments.length - 1];
    const sourceAt = this.liveSourceAtMs ?? latest?.sourceReceivedAtMs ?? null;
    const translationAt = this.liveTranslationAtMs ?? latest?.translationReceivedAtMs ?? null;
    return {
      generation: this.generation,
      phase: this.phase,
      status: this.status,
      segments: this.segments.map((entry) => ({ ...entry })),
      displaySource,
      displayTranslation,
      partial: Boolean(this.liveSource || this.liveTranslation),
      translationPending:
        Boolean(this.liveSource && !this.liveTranslation) ||
        Boolean(this.liveTranslation && !this.translationIsFinal) ||
        Boolean(latest?.source && !latest.translation),
      translationCurrent: this.liveSource
        ? Boolean(this.liveTranslation)
        : Boolean(latest?.source ? latest.translation : displayTranslation),
      translationLagMs: sourceAt === null ? null : Math.max(0, (translationAt ?? nowMs) - sourceAt),
      language: this.liveLanguage ?? latest?.language ?? null,
      confidence: this.liveConfidence ?? latest?.confidence ?? null,
      speakerLabel: this.liveSpeakerLabel ?? latest?.speakerLabel ?? null,
      firstTokenLatencyMs: this.firstTokenAtMs === null ? null : Math.max(0, this.firstTokenAtMs - this.startedAtMs),
      finalTokenLatencyMs: this.finalTokenAtMs === null ? null : Math.max(0, this.finalTokenAtMs - this.startedAtMs),
      droppedEvents: this.droppedEvents,
      droppedAudioFrames: this.droppedAudioFrames,
    };
  }

  private labelSpeaker(providerId: string): string {
    let label = this.speakers.get(providerId);
    if (!label) {
      label = `Speaker ${this.speakers.size + 1}`;
      this.speakers.set(providerId, label);
    }
    return label;
  }

  private enforceBounds(): void {
    while (this.segments.length > this.maxSegments || this.segmentCodePoints() > this.maxCodePoints) {
      this.segments.shift();
    }
  }

  private segmentCodePoints(): number {
    return this.segments.reduce(
      (total, entry) => total + Array.from(entry.source).length + Array.from(entry.translation).length,
      0,
    );
  }

  private clearLive(): void {
    this.liveSource = "";
    this.liveTranslation = "";
    this.liveLanguage = null;
    this.liveConfidence = null;
    this.liveSpeakerLabel = null;
    this.liveSourceAtMs = null;
    this.liveTranslationAtMs = null;
    this.translationIsFinal = false;
  }
}

function stateStatus(state: CaptionStateEvent["state"]): string {
  switch (state) {
    case "starting": return "Starting microphone...";
    case "listening": return "Listening";
    case "reconnecting": return "Network reconnecting...";
    case "error": return "Caption provider error";
    case "stopped": return "Stopped";
  }
}

function graphemes(text: string): string[] {
  const Segmenter = (globalThis as any).Intl?.Segmenter;
  if (Segmenter) {
    return Array.from(new Segmenter(undefined, { granularity: "grapheme" }).segment(text), (entry: any) => entry.segment);
  }
  return Array.from(text);
}

/** Framework-free wrapping with grapheme-safe hard breaks for long words. */
export function wrapCaptionText(
  text: string,
  maxWidth: number,
  measureText: (text: string) => number,
): string[] {
  const lines: string[] = [];
  for (const paragraph of String(text ?? "").replace(/\r\n?/g, "\n").split("\n")) {
    if (!paragraph) {
      lines.push("");
      continue;
    }
    let line = "";
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const candidate = line ? `${line} ${word}` : word;
      if (measureText(candidate) <= maxWidth) {
        line = candidate;
        continue;
      }
      if (line) {
        lines.push(line);
        line = "";
      }
      let chunk = "";
      for (const grapheme of graphemes(word)) {
        if (chunk && measureText(chunk + grapheme) > maxWidth) {
          lines.push(chunk);
          chunk = grapheme;
        } else {
          chunk += grapheme;
        }
      }
      line = chunk;
    }
    lines.push(line);
  }
  return lines.length ? lines : [""];
}

/** Select a bounded tail/history window and top-pad it so content grows upward. */
export function bottomAnchoredLines(lines: readonly string[], maxLines: number, historyOffset: number): string[] {
  const count = Math.max(1, Math.floor(maxLines));
  const offset = Math.max(0, Math.min(Math.floor(historyOffset), Math.max(0, lines.length - 1)));
  const end = Math.max(0, lines.length - offset);
  const selected = lines.slice(Math.max(0, end - count), end);
  return [...new Array(Math.max(0, count - selected.length)).fill(""), ...selected];
}
