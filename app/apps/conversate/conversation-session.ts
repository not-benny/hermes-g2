/**
 * The smallest provider-neutral event shape needed by the local conversation
 * reducer.  Providers may add fields, but this reducer never consumes audio or
 * persists anything.
 */
export type VoiceTranscriptEvent = {
  generation: number;
  type?: "transcript";
  text?: string;
  isFinal?: boolean;
  sourceFinalDelta?: string;
  sourceRevisionPresent?: boolean;
  speaker?: string;
  speakerEvidence?: boolean;
  receivedAtMs?: number;
};

export type ConversationSpeaker = {
  label: string;
};

export type ConversationUtterance = {
  text: string;
  speaker: ConversationSpeaker | null;
};

export type ConversationCueKind = "action" | "question" | "topic";

export type ConversationCue = {
  kind: ConversationCueKind;
  text: string;
};

export type ConversationSessionSnapshot = {
  generation: number;
  phase: "idle" | "active" | "paused" | "ended";
  elapsedMs: number;
  /** Finalized source utterances joined with one space. */
  transcript: string;
  /** Alias that makes the finalized/live distinction explicit to callers. */
  fullTranscript: string;
  liveText: string;
  utterances: readonly ConversationUtterance[];
  wordCount: number;
  utteranceCount: number;
  cues: readonly ConversationCue[];
};

export type ConversationSessionOptions = {
  maxUtterances?: number;
  maxScalars?: number;
};

const DEFAULT_MAX_UTTERANCES = 128;
const DEFAULT_MAX_SCALARS = 32_768;
// The on-device recognizer reports a bounded whole-session replacement rather
// than deltas. Keep it up to the session cap so an end review does not silently
// discard the beginning of an ordinary conversation.
const MAX_EVENT_SCALARS = DEFAULT_MAX_SCALARS;
const MAX_CUE_SCALARS = 160;

const ACTION_PATTERN = /\b(?:need(?:s)?\s+to|should|must|will|follow\s+up|remind|email|call|send)\b/i;
const QUESTION_PATTERN = /\?|^(?:what|why|when|where|who|how|can|could|would|should|do|does|did|is|are|will|may|might)\b/i;

function scalarCount(value: string): number {
  return Array.from(value).length;
}

function boundedText(value: unknown, limit = MAX_EVENT_SCALARS): string {
  const clean = String(value ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ").trim();
  return Array.from(clean).slice(0, limit).join("").trim();
}

function appendText(left: string, right: string): string {
  return [left.trim(), right.trim()].filter(Boolean).join(" ");
}

function normalizeCueText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function wordCount(value: string): number {
  const text = value.trim();
  return text ? text.split(/\s+/u).length : 0;
}

function cueText(value: string): string {
  return boundedText(value, MAX_CUE_SCALARS);
}

/**
 * Pure, bounded, in-memory conversation reducer.  Lifecycle operations and
 * transcript events are accepted only for the exact current generation.
 */
export class ConversationSession {
  private readonly maxUtterances: number;
  private readonly maxScalars: number;
  private generation = 0;
  private phase: ConversationSessionSnapshot["phase"] = "idle";
  private startedAtMs = 0;
  private stoppedAtMs: number | null = null;
  private pausedAtMs: number | null = null;
  private accumulatedPauseMs = 0;
  private clockMs = 0;
  private utterances: ConversationUtterance[] = [];
  private liveText = "";
  private liveSpeaker: ConversationSpeaker | null = null;
  private finalDeltaBuffer = "";

  constructor(options: ConversationSessionOptions = {}) {
    this.maxUtterances = Math.max(1, Math.min(DEFAULT_MAX_UTTERANCES, Math.floor(options.maxUtterances ?? DEFAULT_MAX_UTTERANCES)));
    this.maxScalars = Math.max(1, Math.min(DEFAULT_MAX_SCALARS, Math.floor(options.maxScalars ?? DEFAULT_MAX_SCALARS)));
  }

  begin(generation: number, nowMs: number): boolean {
    if (!Number.isFinite(generation) || !Number.isFinite(nowMs)) return false;
    this.generation = generation;
    this.phase = "active";
    this.startedAtMs = nowMs;
    this.clockMs = nowMs;
    this.stoppedAtMs = null;
    this.pausedAtMs = null;
    this.accumulatedPauseMs = 0;
    this.utterances = [];
    this.liveText = "";
    this.liveSpeaker = null;
    this.finalDeltaBuffer = "";
    return true;
  }

  pause(generation: number, nowMs = this.clockMs): boolean {
    if (generation !== this.generation || this.phase !== "active") return false;
    if (!Number.isFinite(nowMs)) return false;
    this.clockMs = Math.max(this.clockMs, nowMs);
    this.phase = "paused";
    this.pausedAtMs = this.clockMs;
    return true;
  }

  resume(generation: number, nowMs = this.clockMs): boolean {
    if (generation !== this.generation || this.phase !== "paused") return false;
    if (!Number.isFinite(nowMs)) return false;
    this.clockMs = Math.max(this.clockMs, nowMs);
    if (this.pausedAtMs !== null) this.accumulatedPauseMs += Math.max(0, this.clockMs - this.pausedAtMs);
    this.phase = "active";
    this.pausedAtMs = null;
    return true;
  }

  end(generation: number, nowMs = this.clockMs): boolean {
    if (generation !== this.generation || (this.phase !== "active" && this.phase !== "paused")) return false;
    if (!Number.isFinite(nowMs)) return false;
    this.clockMs = Math.max(this.clockMs, nowMs);
    const wasPaused = this.phase === "paused";
    this.phase = "ended";
    this.stoppedAtMs = wasPaused && this.pausedAtMs !== null ? this.pausedAtMs : this.clockMs;
    this.pausedAtMs = null;
    this.liveText = "";
    this.liveSpeaker = null;
    this.finalDeltaBuffer = "";
    return true;
  }

  clear(): void {
    this.generation = 0;
    this.phase = "idle";
    this.startedAtMs = 0;
    this.stoppedAtMs = null;
    this.pausedAtMs = null;
    this.accumulatedPauseMs = 0;
    this.clockMs = 0;
    this.utterances = [];
    this.liveText = "";
    this.liveSpeaker = null;
    this.finalDeltaBuffer = "";
  }

  apply(event: VoiceTranscriptEvent): boolean {
    if (event.generation !== this.generation || this.phase !== "active") return false;

    const receivedAtMs = typeof event.receivedAtMs === "number" && Number.isFinite(event.receivedAtMs)
      ? event.receivedAtMs
      : this.clockMs;
    this.clockMs = Math.max(this.clockMs, receivedAtMs);

    const text = boundedText(event.text);
    const delta = boundedText(event.sourceFinalDelta);
    const speaker = event.speakerEvidence && boundedText(event.speaker)
      ? { label: boundedText(event.speaker) }
      : null;

    if (delta) this.finalDeltaBuffer = boundedText(mergeFinalDelta(this.finalDeltaBuffer, delta), this.maxScalars);
    if ((event.sourceRevisionPresent ?? true) && !event.isFinal) {
      this.liveText = text;
      this.liveSpeaker = speaker;
    }

    if (!event.isFinal) return true;

    // A provider can send the final whole text and sourceFinalDelta together.
    // The delta buffer is the authoritative final text in that case, so the
    // same utterance is never appended once for each field.
    const finalText = boundedText(
      mergeFinalDelta(this.finalDeltaBuffer, text || this.liveText),
      this.maxScalars,
    );
    for (const utterance of splitCueUnits(finalText)) {
      this.addUtterance(utterance, speaker ?? this.liveSpeaker);
    }
    this.liveText = "";
    this.liveSpeaker = null;
    this.finalDeltaBuffer = "";
    return true;
  }

  snapshot(nowMs = Date.now()): ConversationSessionSnapshot {
    const observedNow = Number.isFinite(nowMs) ? Math.max(this.clockMs, nowMs) : this.clockMs;
    const end = this.phase === "paused" && this.pausedAtMs !== null
      ? this.pausedAtMs
      : this.stoppedAtMs === null ? observedNow : this.stoppedAtMs;
    const fullTranscript = this.utterances.map((entry) => entry.text).join(" ");
    const liveText = appendText(this.finalDeltaBuffer, this.liveText);
    const visibleTranscript = appendText(fullTranscript, liveText);
    const cues = deriveCues(this.utterances, liveText);
    return {
      generation: this.generation,
      phase: this.phase,
      elapsedMs: this.phase === "idle" ? 0 : Math.max(0, end - this.startedAtMs - this.accumulatedPauseMs),
      transcript: fullTranscript,
      fullTranscript,
      liveText,
      utterances: this.utterances.map((entry) => ({
        text: entry.text,
        speaker: entry.speaker ? { ...entry.speaker } : null,
      })),
      wordCount: wordCount(visibleTranscript),
      utteranceCount: this.utterances.length,
      cues,
    };
  }

  private addUtterance(text: string, speaker: ConversationSpeaker | null): void {
    // Add the complete bounded utterance first, then evict oldest utterances.
    // This keeps recent utterances intact when the scalar budget is crossed.
    const bounded = boundedText(text, this.maxScalars);
    if (!bounded) return;
    this.utterances.push({ text: bounded, speaker: speaker ? { ...speaker } : null });
    while (this.utterances.length > this.maxUtterances || this.totalScalars() > this.maxScalars) {
      this.utterances.shift();
    }
  }

  private totalScalars(): number {
    return this.utterances.reduce((total, entry) => total + scalarCount(entry.text), 0);
  }
}

function mergeFinalDelta(previous: string, next: string): string {
  const previousKey = normalizeCueText(previous);
  const nextKey = normalizeCueText(next);
  if (!previous) return next;
  if (previousKey === nextKey || previousKey.endsWith(nextKey)) return previous;
  if (nextKey.startsWith(previousKey) || nextKey.endsWith(previousKey)) return next;
  return appendText(previous, next);
}

function deriveCues(utterances: readonly ConversationUtterance[], liveText: string): readonly ConversationCue[] {
  const texts = [...utterances.flatMap((entry) => splitCueUnits(entry.text)), ...splitCueUnits(liveText)].filter(Boolean);
  const highValue: ConversationCue[] = [];
  const seen = new Set<string>();
  for (let index = texts.length - 1; index >= 0; index--) {
    const text = cueText(texts[index]);
    if (!text) continue;
    const kind: ConversationCueKind | null = ACTION_PATTERN.test(text)
      ? "action"
      : QUESTION_PATTERN.test(text)
        ? "question"
        : null;
    if (!kind) continue;
    const key = `${kind}:${normalizeCueText(text)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    highValue.push({ kind, text });
    if (highValue.length === 4) return highValue;
  }
  if (highValue.length) return highValue;

  for (let index = texts.length - 1; index >= 0; index--) {
    const text = cueText(texts[index]);
    if (!text || /[?]/u.test(text) || QUESTION_PATTERN.test(text) || ACTION_PATTERN.test(text)) continue;
    return [{ kind: "topic", text }];
  }
  return [];
}

/** Sentence-ish units for transparent cues and long on-device final reviews. */
function splitCueUnits(value: string): string[] {
  const text = boundedText(value, DEFAULT_MAX_SCALARS);
  if (!text) return [];
  const matches = text.match(/[^.!?\n]+(?:[.!?]+|$)/gu) ?? [text];
  return matches.map((entry) => boundedText(entry)).filter(Boolean);
}

export default ConversationSession;
