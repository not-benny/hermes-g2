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
  /**
   * Complete best transcript of the current utterance. REPLACE semantics —
   * render as-is, replacing any previous partial. Not a delta.
   */
  text: string;
  isFinal: boolean;
};

export type PushToTalkOptions = {
  communicator: any;
  provider: VoiceProviderKind;
  deepgramApiKey: string;
  elevenLabsApiKey: string;
  openAiApiKey: string;
  sonioxApiKey: string;
  saveRecording: boolean;
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
};

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
      this.setStatus(null, "Stop Transcribe before starting a voice turn.");
      return 0;
    }
    if (this.activeCapture) this.cancelCapture(this.activeCapture.generation);
    const generation = this.turnGate.reserve();
    this.activeCapture = { generation, holder: "ptt", cloudClient: null, started: false, commitSent: false };
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
      this.setStatus(null, "Finish the active voice turn before opening Transcribe.");
      return 0;
    }
    const generation = this.turnGate.reserve();
    this.activeCapture = { generation, holder: "continuous", cloudClient: null, started: false, commitSent: false };
    this.setStatus(generation, "Waiting for microphone permission...");
    return generation;
  }

  /** Begin continuous capture (Transcribe) as an isolated mic generation. */
  startContinuousCapture(generation: number, options: PushToTalkOptions): void {
    this.startReservedCapture(generation, "continuous", options);
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
    const sttOptions = {
      apiKey: "",
      onTranscript: (event: { text: string; isFinal: boolean }) =>
        this.emitTranscript(generation, event.text, event.isFinal),
      onStatus: (status: string) => {
        if (this.turnGate.accepts(generation)) this.setStatus(generation, status);
      },
      onError: (message: string) => this.failCapture(generation, message),
    };
    if (options.provider === "deepgram") {
      const apiKey = options.deepgramApiKey.trim();
      if (!apiKey) {
        this.setStatus(generation, "No Deepgram key set; using on-device voice.");
        return null;
      }
      return new DeepgramSttClient({ ...sttOptions, apiKey });
    }
    if (options.provider === "elevenlabs") {
      const apiKey = options.elevenLabsApiKey.trim();
      if (!apiKey) {
        this.setStatus(generation, "No ElevenLabs key set; using on-device voice.");
        return null;
      }
      return new ElevenLabsSttClient({ ...sttOptions, apiKey });
    }
    if (options.provider === "soniox") {
      const apiKey = options.sonioxApiKey.trim();
      if (!apiKey) {
        this.setStatus(generation, "No Soniox key set; using on-device voice.");
        return null;
      }
      return new SonioxSttClient({ ...sttOptions, apiKey });
    }
    const apiKey = options.openAiApiKey.trim();
    if (!apiKey) {
      this.setStatus(generation, "No OpenAI key set; using on-device voice.");
      return null;
    }
    return new OpenAiRealtimeSttClient({ ...sttOptions, apiKey });
  }

  private cancelCapture(generation: number): void {
    const capture = this.activeCapture;
    if (!capture || capture.generation !== generation) return;
    const cancelled = this.turnGate.cancel(generation);
    if (!cancelled && this.turnGate.accepts(generation)) return;
    if (capture.started && global.isAndroid) this.controller?.stop(generation);
    capture.started = false;
    capture.cloudClient?.stop();
    capture.cloudClient = null;
    this.activeCapture = null;
  }

  private failCapture(generation: number, message: string): void {
    const capture = this.activeCapture;
    if (!capture || capture.generation !== generation || !this.turnGate.fail(generation)) return;
    if (capture.started && global.isAndroid) this.controller?.stop(generation);
    capture.started = false;
    capture.cloudClient?.stop();
    capture.cloudClient = null;
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
    capture.cloudClient?.finish();
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
        this.emitTranscript(generation, String(text), Boolean(isFinal));
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

  private emitTranscript(generation: number, text: string, isFinal: boolean): void {
    if (!this.turnGate.accepts(generation)) return;
    const event = { generation, text, isFinal };
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
