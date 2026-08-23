import { Utils } from "@nativescript/core";

import { CloudSttClient } from "./cloud-stt";
import { DeepgramSttClient } from "./deepgram-stt";
import { ElevenLabsSttClient } from "./elevenlabs-stt";
import { OpenAiRealtimeSttClient } from "./openai-stt";
import { SonioxSttClient } from "./soniox-stt";
import { toUint8Array } from "../util/array-util";

declare const com: any;

export type VoiceControlState = {
  status: string;
  generation: number;
};

export type VoiceProviderKind = "onboard" | "deepgram" | "elevenlabs" | "whisper" | "soniox";

export type VoiceTranscriptEvent = {
  /**
   * Complete best transcript of the current utterance. REPLACE semantics —
   * render as-is, replacing any previous partial. Not a delta.
   */
  text: string;
  isFinal: boolean;
  generation: number;
  receivedAtMs: number;
  language?: string;
  confidence?: number;
  speaker?: string;
  speakerEvidence?: boolean;
  translationText?: string;
  translationIsFinal?: boolean;
  targetLanguage?: string;
  droppedAudioFrames?: number;
  sourceFinalDelta?: string;
  translationFinalDelta?: string;
  sourceRevisionPresent?: boolean;
  translationRevisionPresent?: boolean;
};

export type PushToTalkOptions = {
  communicator: any;
  provider: VoiceProviderKind;
  deepgramApiKey: string;
  elevenLabsApiKey: string;
  openAiApiKey: string;
  sonioxApiKey: string;
  saveRecording: boolean;
  sourceLanguage?: string;
  targetLanguage?: string;
  speakerLabels?: boolean;
  /**
   * Watch the mic and fire onSpeechEnd when the speaker stops. For hands-free
   * ("Hey Even") capture, which has no button release to end the utterance.
   * Ignored when the mic is already running for another holder.
   */
  endpointing?: boolean;
};

/** Who currently wants the mic running. */
type CaptureHolder = "ptt" | "continuous";

export class FaceclawVoiceControlBridge {
  private readonly statusListeners = new Set<(state: VoiceControlState) => void>();
  private readonly wakeWordListeners = new Set<(keyword: string) => void>();
  private readonly transcriptListeners = new Set<(event: VoiceTranscriptEvent) => void>();
  private readonly speechEndListeners = new Set<() => void>();
  private controller: any | null = null;
  private listenerProxy: any | null = null;
  private status = "Voice control stopped.";
  private started = false;
  // The mic is a single shared stream; these are the reasons it is running.
  // The first holder starts capture (choosing the provider); the mic stops
  // when the last one releases. Transcript events broadcast to every
  // listener, so push-to-talk and the Transcribe window both receive text.
  private readonly captureHolders = new Set<CaptureHolder>();
  // Non-null while a cloud provider owns the transcript; Java only decodes PCM.
  private cloudClient: CloudSttClient | null = null;
  private activeGeneration = 0;

  onStatus(listener: (state: VoiceControlState) => void): () => void {
    this.statusListeners.add(listener);
    listener({ status: this.status, generation: this.activeGeneration });
    return () => this.statusListeners.delete(listener);
  }

  onWakeWord(listener: (keyword: string) => void): () => void {
    this.wakeWordListeners.add(listener);
    return () => this.wakeWordListeners.delete(listener);
  }

  onTranscript(listener: (event: VoiceTranscriptEvent) => void): () => void {
    this.transcriptListeners.add(listener);
    return () => this.transcriptListeners.delete(listener);
  }

  /**
   * The speaker stopped, in a hands-free session. Only fires when the capture
   * was started with `endpointing: true`.
   */
  onSpeechEnd(listener: () => void): () => void {
    this.speechEndListeners.add(listener);
    return () => this.speechEndListeners.delete(listener);
  }

  /** Begin push-to-talk capture (momentary; released with stopPushToTalk). */
  startPushToTalk(options: PushToTalkOptions): void {
    this.acquireCapture("ptt", options);
  }

  /** End push-to-talk: for cloud, commit for a final result if it was the last holder. */
  stopPushToTalk(): void {
    this.releaseCapture("ptt", true);
  }

  /** Begin continuous capture (Transcribe): the mic stays on until released. */
  startContinuousCapture(options: PushToTalkOptions): void {
    this.acquireCapture("continuous", options);
  }

  stopContinuousCapture(): void {
    this.releaseCapture("continuous", false);
  }

  isContinuousCaptureActive(): boolean {
    return this.captureHolders.has("continuous");
  }

  private acquireCapture(holder: CaptureHolder, options: PushToTalkOptions): void {
    if (!global.isAndroid) return;
    if (this.captureHolders.has(holder)) return;
    if (this.captureHolders.size > 0) {
      // Fail closed rather than sharing providers/transcripts between assistant
      // PTT and accessibility captions. The shell normally preempts captions
      // first; this guard owns races and future alternate callers.
      this.setStatus("Voice capture busy; stop the active capture first.");
      return;
    }
    const generation = ++this.activeGeneration;
    let cloudClient: CloudSttClient | null = null;
    try {
      this.ensureController();
      this.installControllerListener(generation);
      this.controller?.setCommunicator(options.communicator);
      this.controller?.setSaveRecordings(options.saveRecording);
      this.controller?.setEndpointing(Boolean(options.endpointing));

      cloudClient = this.createCloudClient(options, generation);
      this.cloudClient = cloudClient;
      cloudClient?.start();
      this.controller?.start(cloudClient ? "cloud" : "onboard");
      this.started = true;
      this.captureHolders.add(holder);
    } catch {
      this.activeGeneration++;
      this.started = false;
      this.captureHolders.delete(holder);
      try { this.controller?.stop(); } catch { /* already stopped */ }
      try { cloudClient?.stop(); } catch { /* construction/start failed */ }
      if (this.cloudClient === cloudClient) this.cloudClient = null;
      this.setStatus("Voice capture failed to start.");
    }
  }

  /**
   * The cloud provider for this session, or null to transcribe on-device.
   * A cloud provider whose API key is missing falls back to on-device rather
   * than failing the capture outright.
   */
  private createCloudClient(options: PushToTalkOptions, generation: number): CloudSttClient | null {
    if (options.provider === "onboard") return null;
    let exactClient: CloudSttClient | null = null;
    const sttOptions = {
      apiKey: "",
      sourceLanguage: options.sourceLanguage,
      targetLanguage: options.targetLanguage,
      speakerLabels: options.speakerLabels,
      onTranscript: (event: Omit<VoiceTranscriptEvent, "generation" | "receivedAtMs">) => {
        if (generation !== this.activeGeneration || this.cloudClient !== exactClient) return;
        this.emitTranscript({ ...event, generation, receivedAtMs: Date.now() });
      },
      onStatus: (status: string) => {
        if (generation === this.activeGeneration && this.cloudClient === exactClient) this.setStatus(status);
      },
      onError: (message: string) => {
        if (generation === this.activeGeneration && this.cloudClient === exactClient) this.setStatus(message);
      },
    };
    if (options.provider === "deepgram") {
      const apiKey = options.deepgramApiKey.trim();
      if (!apiKey) {
        this.setStatus("No Deepgram key set; using on-device voice.");
        return null;
      }
      exactClient = new DeepgramSttClient({ ...sttOptions, apiKey });
      return exactClient;
    }
    if (options.provider === "elevenlabs") {
      const apiKey = options.elevenLabsApiKey.trim();
      if (!apiKey) {
        this.setStatus("No ElevenLabs key set; using on-device voice.");
        return null;
      }
      exactClient = new ElevenLabsSttClient({ ...sttOptions, apiKey });
      return exactClient;
    }
    if (options.provider === "soniox") {
      const apiKey = options.sonioxApiKey.trim();
      if (!apiKey) {
        this.setStatus("No Soniox key set; using on-device voice.");
        return null;
      }
      exactClient = new SonioxSttClient({ ...sttOptions, apiKey });
      return exactClient;
    }
    const apiKey = options.openAiApiKey.trim();
    if (!apiKey) {
      this.setStatus("No OpenAI key set; using on-device voice.");
      return null;
    }
    exactClient = new OpenAiRealtimeSttClient({ ...sttOptions, apiKey });
    return exactClient;
  }

  private releaseCapture(holder: CaptureHolder, commit: boolean): void {
    if (!this.captureHolders.delete(holder)) {
      // A delayed/duplicate release must never finalize a replacement client.
      return;
    }
    if (!this.started) {
      return;
    }
    // Order matters for cloud: stopping the Java controller flushes any final
    // decode/PCM; then commit so the provider finalizes the transcript.
    this.controller?.stop();
    this.started = false;
    if (commit) {
      this.cloudClient?.finish();
    } else {
      this.activeGeneration++;
      this.cloudClient?.stop();
      this.cloudClient = null;
    }
  }

  stop(): void {
    this.activeGeneration++;
    this.captureHolders.clear();
    if (global.isAndroid) {
      this.controller?.stop();
    }
    this.started = false;
    this.cloudClient?.stop();
    this.cloudClient = null;
    this.setStatus("Voice control stopped.");
  }

  /** Surface a bounded lifecycle/permission failure to every visual voice UI. */
  reportStatus(status: string): void {
    this.setStatus(String(status).slice(0, 160));
  }

  private ensureController(): void {
    if (!global.isAndroid || this.controller) return;
    const context = Utils.android.getApplicationContext();
    if (!context) {
      throw new Error("Android application context unavailable");
    }
    this.controller = new com.faceclaw.app.FaceclawVoiceController(context);
  }

  private installControllerListener(generation: number): void {
    if (!this.controller) return;
    this.listenerProxy = new com.faceclaw.app.FaceclawVoiceControllerListener({
      onStatus: (status: string) => {
        if (generation !== this.activeGeneration) return;
        this.setStatus(String(status));
      },
      onWakeWord: (keyword: string) => {
        if (generation !== this.activeGeneration) return;
        for (const listener of this.wakeWordListeners) {
          listener(String(keyword));
        }
      },
      onTranscript: (text: string, isFinal: boolean) => {
        if (generation !== this.activeGeneration) return;
        this.emitTranscript({
          generation,
          text: String(text),
          isFinal: Boolean(isFinal),
          receivedAtMs: Date.now(),
        });
      },
      onPcm: (pcm: any) => {
        if (generation !== this.activeGeneration) return;
        this.cloudClient?.acceptPcm(toUint8Array(pcm));
      },
      onSpeechEnd: () => {
        if (generation !== this.activeGeneration) return;
        for (const listener of this.speechEndListeners) {
          listener();
        }
      },
    });
    this.controller.setListener(this.listenerProxy);
  }

  private emitTranscript(event: VoiceTranscriptEvent): void {
    for (const listener of this.transcriptListeners) {
      listener(event);
    }
  }

  private setStatus(status: string): void {
    this.status = status;
    for (const listener of this.statusListeners) {
      listener({ status, generation: this.activeGeneration });
    }
  }
}

export const voiceControlBridge = new FaceclawVoiceControlBridge();
