import { CLOUD_STT_SAMPLE_RATE, CloudSttClient, CloudSttOptions, toJavaBytes } from "./cloud-stt";

declare const com: any;

/**
 * Soniox realtime speech-to-text over WebSocket.
 * https://soniox.com/docs/stt/rt/real-time-transcription
 *
 * Unlike the other cloud providers, Soniox authenticates with an api_key field
 * in the first (JSON) message rather than an HTTP header, and audio is sent as
 * raw binary frames rather than base64-in-JSON. Push-to-talk defines the
 * utterance boundary: an empty text frame is the end-of-audio signal, after
 * which the server finalizes all tokens and replies with finished=true.
 *
 * Transcripts arrive as TOKENS: final tokens are delivered exactly once and
 * are accumulated here; non-final tokens repeat (revised) in every message and
 * are appended for display only. Listeners get full replace-semantics text.
 */

const WS_URL = "wss://stt-rt.soniox.com/transcribe-websocket";
const MODEL_ID = "stt-rt-v5";
const MAX_PENDING_PCM_CHUNKS = 50;
const MAX_RECONNECT_DELAY_MS = 8_000;

export type SonioxSttOptions = CloudSttOptions;

export class SonioxSttClient implements CloudSttClient {
  private ws: any = null;
  private listenerProxy: any = null;
  private open = false;
  private closed = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private droppedAudioFrames = 0;
  // PCM queued until the socket opens and the config message is sent.
  private readonly pendingPcm: Uint8Array[] = [];
  private pendingFinish = false;
  // Concatenation of all final tokens so far.
  private finalText = "";
  private finalTranslation = "";
  private lastSourceSpeaker = "";
  private lastTranslationSpeaker = "";
  private readonly speakerLabels = new Map<string, string>();

  constructor(private readonly options: SonioxSttOptions) {}

  start(): void {
    if (this.ws || this.closed) return;
    this.connect();
  }

  private connect(): void {
    if (this.ws || this.closed) return;
    let exactSocket: any = null;
    this.listenerProxy = new com.faceclaw.app.FaceclawWebSocketListener({
      onOpen: () => {
        if (this.closed || this.ws !== exactSocket) return;
        this.reconnectAttempt = 0;
        // The API key rides in the config message; there is no auth header.
        this.trySendText(
          JSON.stringify({
            api_key: this.options.apiKey,
            model: MODEL_ID,
            audio_format: "pcm_s16le",
            sample_rate: CLOUD_STT_SAMPLE_RATE,
            num_channels: 1,
            ...(this.options.sourceLanguage && this.options.sourceLanguage !== "auto"
              ? { language_hints: [this.options.sourceLanguage] }
              : {}),
            ...(this.options.targetLanguage
              ? {
                  translation: { type: "one_way", target_language: this.options.targetLanguage },
                  enable_language_identification: true,
                }
              : {}),
            ...(this.options.speakerLabels ? { enable_speaker_diarization: true } : {}),
          }),
        );
        this.open = true;
        for (const chunk of this.pendingPcm.splice(0)) {
          this.sendPcm(chunk);
        }
        if (this.pendingFinish) {
          this.pendingFinish = false;
          this.finish();
        }
        this.options.onStatus("Listening (Soniox)...");
      },
      onTextMessage: (message: string) => {
        if (this.ws === exactSocket) this.handleMessage(String(message));
      },
      onClosed: () => {
        if (this.ws !== exactSocket) return;
        this.open = false;
        this.ws = null;
        this.scheduleReconnect();
      },
      onFailure: (message: string) => {
        if (this.closed || this.ws !== exactSocket) return;
        const safe = String(message).slice(0, 120);
        this.open = false;
        this.ws = null;
        if (/\b(?:400|401|403)\b|unauth|invalid.request/i.test(safe)) {
          this.options.onError("Soniox authentication or configuration failed.");
          this.closed = true;
          return;
        }
        this.options.onError("Soniox connection failed; reconnecting.");
        this.scheduleReconnect();
      },
    });
    try {
      exactSocket = new com.faceclaw.app.FaceclawWebSocket(WS_URL, this.listenerProxy, null, null);
      this.ws = exactSocket;
      this.options.onStatus("Connecting to Soniox...");
    } catch {
      this.options.onError("Soniox connection failed; reconnecting.");
      this.ws = null;
      this.scheduleReconnect();
    }
  }

  /** Feed PCM (16 kHz signed-16-bit LE), as raw binary frames. */
  acceptPcm(pcm: Uint8Array): void {
    if (this.closed || pcm.length === 0) return;
    if (this.open) {
      this.sendPcm(pcm);
    } else {
      if (this.pendingPcm.length >= MAX_PENDING_PCM_CHUNKS) {
        this.pendingPcm.shift();
        this.droppedAudioFrames++;
      }
      this.pendingPcm.push(pcm);
    }
  }

  /** End of utterance: an empty text frame tells Soniox the audio is done. */
  finish(): void {
    if (this.closed) return;
    if (this.open) {
      this.trySendText("");
    } else {
      this.pendingFinish = true;
    }
  }

  stop(): void {
    this.closed = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.pendingPcm.length = 0;
    if (this.ws) {
      try {
        this.ws.close(1000, "bye");
      } catch {
        // ignore
      }
      this.ws = null;
    }
    this.listenerProxy = null;
  }

  private sendPcm(pcm: Uint8Array): void {
    try {
      this.ws?.sendBinary(toJavaBytes(pcm));
    } catch {
      this.droppedAudioFrames++;
      this.options.onError("Soniox audio send failed; reconnecting.");
    }
  }

  private trySendText(message: string): void {
    try {
      this.ws?.sendText(message);
    } catch {
      this.options.onError("Soniox control send failed; reconnecting.");
    }
  }

  private handleMessage(text: string): void {
    let message: any;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    if (message?.error_code != null) {
      this.options.onError(`Soniox: ${String(message.error_message ?? message.error_code)}`);
      return;
    }
    const tokens = Array.isArray(message?.tokens) ? message.tokens : [];
    let nonFinal = "";
    let nonFinalTranslation = "";
    let language = "";
    let speaker = "";
    for (const token of tokens) {
      const tokenText = String(token?.text ?? "");
      // Markers emitted by endpoint detection / manual finalize; not speech.
      if (tokenText === "<end>" || tokenText === "<fin>") continue;
      const isTranslation = token?.translation_status === "translation";
      language = String(token?.source_language ?? token?.language ?? language);
      speaker = String(token?.speaker ?? speaker);
      const rendered = this.withSpeaker(tokenText, speaker, isTranslation);
      if (isTranslation && token?.is_final) {
        this.finalTranslation += rendered;
      } else if (isTranslation) {
        nonFinalTranslation += rendered;
      } else if (token?.is_final) {
        this.finalText += rendered;
      } else {
        nonFinal += rendered;
      }
    }
    const event = {
      text: this.finalText + nonFinal,
      isFinal: Boolean(message?.finished),
      ...(language ? { language } : {}),
      ...(speaker ? { speaker, speakerEvidence: true } : {}),
      ...(this.options.targetLanguage
        ? {
            translationText: this.finalTranslation + nonFinalTranslation,
            translationIsFinal: Boolean(message?.finished),
            targetLanguage: this.options.targetLanguage,
          }
        : {}),
      droppedAudioFrames: this.droppedAudioFrames,
    };
    if (message?.finished) {
      this.options.onTranscript(event);
      this.stop();
      return;
    }
    if (tokens.length > 0) {
      this.options.onTranscript(event);
    }
  }

  private withSpeaker(text: string, providerSpeaker: string, translation: boolean): string {
    if (!this.options.speakerLabels || !providerSpeaker) return text;
    let label = this.speakerLabels.get(providerSpeaker);
    if (!label) {
      label = `Speaker ${this.speakerLabels.size + 1}`;
      this.speakerLabels.set(providerSpeaker, label);
    }
    const last = translation ? this.lastTranslationSpeaker : this.lastSourceSpeaker;
    if (last === providerSpeaker) return text;
    if (translation) this.lastTranslationSpeaker = providerSpeaker;
    else this.lastSourceSpeaker = providerSpeaker;
    const existing = translation ? this.finalTranslation : this.finalText;
    return `${existing ? "\n" : ""}${label}: ${text}`;
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer !== null) return;
    const delay = Math.min(MAX_RECONNECT_DELAY_MS, 500 * 2 ** this.reconnectAttempt++);
    this.options.onStatus(`Reconnecting to Soniox in ${delay} ms...`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }
}
