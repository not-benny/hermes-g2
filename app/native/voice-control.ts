import { Utils } from "@nativescript/core";

import { CloudSttClient } from "./cloud-stt";
import { DeepgramSttClient } from "./deepgram-stt";
import { ElevenLabsSttClient } from "./elevenlabs-stt";
import { OpenAiRealtimeSttClient } from "./openai-stt";
import { SonioxSttClient } from "./soniox-stt";
import { VoiceTurnGate } from "./voice-turn-gate";
import { toUint8Array } from "../util/array-util";

declare const com: any;

export type VoiceControlState = {
  generation: number | null;
  status: string;
  terminalError?: boolean;
};

export type VoiceProviderKind = "onboard" | "deepgram" | "elevenlabs" | "whisper" | "soniox";

export type VoiceTranscriptEvent = {
  generation: number;
  receivedAtMs: number;
  /**
   * Complete best transcript of the current utterance. REPLACE semantics —
   * render as-is, replacing any previous partial. Not a delta.
   */
  text: string;
  isFinal: boolean;
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

type CaptureHolder = "ptt" | "continuous";

type ActiveCapture = {
  generation: number;
  holder: CaptureHolder;
  cloudClient: CloudSttClient | null;
  started: boolean;
  commitSent: boolean;
  finishPromise: Promise<void> | null;
  resolveFinish: (() => void) | null;
  finishTimer: ReturnType<typeof setTimeout> | null;
};

const PROVIDER_FINISH_TIMEOUT_MS = 5_000;

export class FaceclawVoiceControlBridge {
  private readonly statusListeners = new Set<(state: VoiceControlState) => void>();
  private readonly wakeWordListeners = new Set<(keyword: string) => void>();
  private readonly transcriptListeners = new Set<(event: VoiceTranscriptEvent) => void>();
  private readonly speechEndListeners = new Set<(generation: number) => void>();
  private controller: any | null = null;
  private listenerProxy: any | null = null;
  private status = "Voice control stopped.";
  private readonly turnGate = new VoiceTurnGate();
  private activeCapture: ActiveCapture | null = null;

  onStatus(listener: (state: VoiceControlState) => void): () => void {
    this.statusListeners.add(listener);
    listener({ generation: this.activeCapture?.generation ?? null, status: this.status });
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
  onSpeechEnd(listener: (generation: number) => void): () => void {
    this.speechEndListeners.add(listener);
    return () => this.speechEndListeners.delete(listener);
  }

  /** Allocate identity before permission work begins. */
  reservePushToTalk(): number {
    if (this.activeCapture?.holder === "continuous") {
      this.setStatus(null, "Pause or end Conversate before starting a voice turn.");
      return 0;
    }
    if (this.activeCapture) this.cancelCapture(this.activeCapture.generation);
    const generation = this.turnGate.reserve();
    this.activeCapture = {
      generation, holder: "ptt", cloudClient: null, started: false, commitSent: false,
      finishPromise: null, resolveFinish: null, finishTimer: null,
    };
    this.setStatus(generation, "Waiting for microphone permission...");
    return generation;
  }

  /** Start a reserved turn after its asynchronous permission check succeeds. */
  startPushToTalk(generation: number, options: PushToTalkOptions): void {
    this.startReservedCapture(generation, "ptt", options);
  }

  finishPushToTalk(generation: number): void {
    const capture = this.activeCapture;
    if (!capture || capture.holder !== "ptt" || capture.generation !== generation) return;
    if (!this.turnGate.finish(generation)) return;
    if (capture.started && global.isAndroid) {
      this.controller?.stop(generation);
    } else {
      this.completeCapture(generation);
    }
    capture.started = false;
  }

  cancelPushToTalk(generation: number): void {
    this.cancelCapture(generation);
  }

  claimSubmit(generation: number): boolean {
    return this.turnGate.claimSubmit(generation);
  }

  reserveContinuousCapture(): number {
    if (this.activeCapture) {
      this.setStatus(null, "Finish the active voice turn before starting Conversate.");
      return 0;
    }
    const generation = this.turnGate.reserve();
    this.activeCapture = {
      generation, holder: "continuous", cloudClient: null, started: false, commitSent: false,
      finishPromise: null, resolveFinish: null, finishTimer: null,
    };
    this.setStatus(generation, "Waiting for microphone permission...");
    return generation;
  }

  /** Begin continuous capture (Conversate) as an isolated mic generation. */
  startContinuousCapture(generation: number, options: PushToTalkOptions): void {
    this.startReservedCapture(generation, "continuous", options);
  }

  /**
   * Stop accepting audio but keep this exact generation alive long enough for
   * the native/on-provider final transcript. Resolves after that final event or
   * a bounded provider timeout; cancellation remains a separate immediate path.
   */
  finishContinuousCapture(generation: number): Promise<void> {
    const capture = this.activeCapture;
    if (!capture || capture.holder !== "continuous" || capture.generation !== generation) {
      return Promise.resolve();
    }
    if (!capture.finishPromise) {
      capture.finishPromise = new Promise<void>((resolve) => {
        capture.resolveFinish = resolve;
      });
    }
    if (this.turnGate.finish(generation)) {
      if (capture.started && global.isAndroid) this.controller?.stop(generation);
      else this.completeCapture(generation);
      capture.started = false;
    }
    return capture.finishPromise;
  }

  stopContinuousCapture(generation: number): void {
    const capture = this.activeCapture;
    if (capture?.holder === "continuous" && capture.generation === generation) this.cancelCapture(generation);
  }

  failCaptureRequest(generation: number, message: string): void {
    this.failCapture(generation, message);
  }

  failActiveCapture(message: string): void {
    const generation = this.activeCapture?.generation;
    if (generation) this.failCapture(generation, message);
  }

  isContinuousCaptureActive(): boolean {
    const capture = this.activeCapture;
    return Boolean(capture?.holder === "continuous" && this.turnGate.accepts(capture.generation));
  }

  reportStatus(status: string): void {
    this.setStatus(this.activeCapture?.generation ?? null, String(status).slice(0, 160));
  }

  private startReservedCapture(
    generation: number,
    holder: CaptureHolder,
    options: PushToTalkOptions,
  ): void {
    const capture = this.activeCapture;
    if (!capture || capture.generation !== generation || capture.holder !== holder) return;
    if (!this.turnGate.activate(generation)) return;
    if (!global.isAndroid) {
      this.failCapture(generation, "Voice capture is only available on Android.");
      return;
    }
    this.ensureController();
    this.controller?.setCommunicator(options.communicator);
    this.controller?.setSaveRecordings(options.saveRecording);
    this.controller?.setEndpointing(Boolean(options.endpointing));

    const cloudClient = this.createCloudClient(generation, options);
    capture.cloudClient = cloudClient;
    cloudClient?.start();
    if (!this.turnGate.accepts(generation)) return;
    const nativeStarted = Boolean(this.controller?.start(cloudClient ? "cloud" : "onboard", generation));
    if (!nativeStarted) this.failCapture(generation, "Could not start voice capture.");
    capture.started = nativeStarted;
  }

  /**
   * The cloud provider for this session, or null to transcribe on-device.
   * A cloud provider whose API key is missing falls back to on-device rather
   * than failing the capture outright.
   */
  private createCloudClient(generation: number, options: PushToTalkOptions): CloudSttClient | null {
    if (options.provider === "onboard") return null;
    let exactClient: CloudSttClient | null = null;
    const sttOptions = {
      apiKey: "",
      sourceLanguage: options.sourceLanguage,
      targetLanguage: options.targetLanguage,
      speakerLabels: options.speakerLabels,
      onTranscript: (event: Omit<VoiceTranscriptEvent, "generation" | "receivedAtMs">) => {
        const capture = this.activeCapture;
        if (capture?.generation !== generation || capture.cloudClient !== exactClient || !this.turnGate.accepts(generation)) return;
        this.emitTranscript({ ...event, generation, receivedAtMs: Date.now() });
        if (event.isFinal && capture.commitSent) this.releaseCompletedCapture(capture, false);
      },
      onStatus: (status: string) => {
        const capture = this.activeCapture;
        if (capture?.generation === generation && capture.cloudClient === exactClient && this.turnGate.accepts(generation)) {
          this.setStatus(generation, status);
        }
      },
      onError: (message: string) => {
        const capture = this.activeCapture;
        if (capture?.generation === generation && capture.cloudClient === exactClient) this.failCapture(generation, message);
      },
    };
    if (options.provider === "deepgram") {
      const apiKey = options.deepgramApiKey.trim();
      if (!apiKey) {
        this.setStatus(generation, "No Deepgram key set; using on-device voice.");
        return null;
      }
      exactClient = new DeepgramSttClient({ ...sttOptions, apiKey });
      return exactClient;
    }
    if (options.provider === "elevenlabs") {
      const apiKey = options.elevenLabsApiKey.trim();
      if (!apiKey) {
        this.setStatus(generation, "No ElevenLabs key set; using on-device voice.");
        return null;
      }
      exactClient = new ElevenLabsSttClient({ ...sttOptions, apiKey });
      return exactClient;
    }
    if (options.provider === "soniox") {
      const apiKey = options.sonioxApiKey.trim();
      if (!apiKey) {
        this.setStatus(generation, "No Soniox key set; using on-device voice.");
        return null;
      }
      exactClient = new SonioxSttClient({ ...sttOptions, apiKey });
      return exactClient;
    }
    const apiKey = options.openAiApiKey.trim();
    if (!apiKey) {
      this.setStatus(generation, "No OpenAI key set; using on-device voice.");
      return null;
    }
    exactClient = new OpenAiRealtimeSttClient({ ...sttOptions, apiKey });
    return exactClient;
  }

  private cancelCapture(generation: number): void {
    const capture = this.activeCapture;
    if (!capture || capture.generation !== generation) return;
    const cancelled = this.turnGate.cancel(generation);
    if (!cancelled && this.turnGate.accepts(generation) && !capture.commitSent) return;
    if (capture.started && global.isAndroid) this.controller?.stop(generation);
    capture.started = false;
    capture.cloudClient?.stop();
    capture.cloudClient = null;
    this.releaseCompletedCapture(capture, false);
  }

  private failCapture(generation: number, message: string): void {
    const capture = this.activeCapture;
    if (!capture || capture.generation !== generation || !this.turnGate.fail(generation)) return;
    if (capture.started && global.isAndroid) this.controller?.stop(generation);
    capture.started = false;
    capture.cloudClient?.stop();
    capture.cloudClient = null;
    this.releaseCompletedCapture(capture, false);
    this.setStatus(generation, message, true);
  }

  private completeCapture(generation: number): void {
    const capture = this.activeCapture;
    if (!capture || capture.generation !== generation || capture.commitSent) return;
    if (!this.turnGate.complete(generation)) {
      if (this.turnGate.acceptsAudio(generation)) {
        this.failCapture(generation, "Voice capture stopped unexpectedly.");
      }
      return;
    }
    capture.commitSent = true;
    if (!capture.cloudClient) {
      // Android posts its final on-device transcript before onCaptureStopped,
      // so reaching this callback proves that listener already ran.
      this.releaseCompletedCapture(capture, false);
      return;
    }
    try {
      capture.cloudClient.finish();
    } catch {
      this.releaseCompletedCapture(capture, true);
      return;
    }
    if (this.activeCapture === capture && capture.finishTimer === null) {
      capture.finishTimer = setTimeout(() => {
        if (this.activeCapture === capture) this.releaseCompletedCapture(capture, true);
      }, PROVIDER_FINISH_TIMEOUT_MS);
    }
  }

  private releaseCompletedCapture(capture: ActiveCapture, stopClient: boolean): void {
    if (capture.finishTimer !== null) clearTimeout(capture.finishTimer);
    capture.finishTimer = null;
    if (stopClient) {
      try { capture.cloudClient?.stop(); } catch { /* provider is already terminal */ }
    }
    capture.cloudClient = null;
    if (this.activeCapture === capture) this.activeCapture = null;
    const resolve = capture.resolveFinish;
    capture.resolveFinish = null;
    resolve?.();
  }

  stop(): void {
    if (this.activeCapture) this.cancelCapture(this.activeCapture.generation);
    this.setStatus(null, "Voice control stopped.");
  }

  private ensureController(): void {
    if (!global.isAndroid || this.controller) return;
    const context = Utils.android.getApplicationContext();
    if (!context) {
      throw new Error("Android application context unavailable");
    }
    this.controller = new com.faceclaw.app.FaceclawVoiceController(context);
    this.listenerProxy = new com.faceclaw.app.FaceclawVoiceControllerListener({
      onStatus: (generation: number, status: string) => {
        if (this.turnGate.accepts(generation)) this.setStatus(generation, String(status));
      },
      onWakeWord: (keyword: string) => {
        for (const listener of this.wakeWordListeners) {
          listener(String(keyword));
        }
      },
      onTranscript: (generation: number, text: string, isFinal: boolean) => {
        this.emitTranscript({
          generation,
          text: String(text),
          isFinal: Boolean(isFinal),
          receivedAtMs: Date.now(),
        });
      },
      onPcm: (generation: number, pcm: any) => {
        const capture = this.activeCapture;
        if (capture?.generation === generation && this.turnGate.acceptsAudio(generation)) {
          capture.cloudClient?.acceptPcm(toUint8Array(pcm));
        }
      },
      onSpeechEnd: (generation: number) => {
        if (!this.turnGate.acceptsAudio(generation)) return;
        for (const listener of this.speechEndListeners) {
          listener(generation);
        }
      },
      onCaptureStopped: (generation: number) => {
        this.completeCapture(generation);
      },
    });
    this.controller.setListener(this.listenerProxy);
  }

  private emitTranscript(event: VoiceTranscriptEvent): void {
    if (!this.turnGate.accepts(event.generation)) return;
    for (const listener of this.transcriptListeners) {
      listener(event);
    }
  }

  private setStatus(generation: number | null, status: string, terminalError = false): void {
    this.status = status;
    for (const listener of this.statusListeners) {
      listener({ generation, status, terminalError });
    }
  }
}

export const voiceControlBridge = new FaceclawVoiceControlBridge();
