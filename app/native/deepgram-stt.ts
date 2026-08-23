import { CLOUD_STT_SAMPLE_RATE, CloudSttClient, CloudSttOptions, toJavaBytes } from "./cloud-stt";

declare const com: any;

/**
 * Deepgram live streaming transcription. The G2 supplies 16 kHz PCM16LE,
 * which Deepgram accepts directly as binary WebSocket frames.
 */
const WS_URL =
  "wss://api.deepgram.com/v1/listen?model=nova-3&language=en-US&smart_format=true&interim_results=true&encoding=linear16&sample_rate=16000&channels=1";
const MAX_PENDING_PCM_CHUNKS = 50;

export type DeepgramSttOptions = CloudSttOptions;

export class DeepgramSttClient implements CloudSttClient {
  private ws: any = null;
  private listenerProxy: any = null;
  private open = false;
  private closed = false;
  private finishRequested = false;
  private finalEmitted = false;
  private readonly pendingPcm: Uint8Array[] = [];
  private droppedAudioFrames = 0;
  private finalText = "";
  private partialText = "";

  constructor(private readonly options: DeepgramSttOptions) {}

  start(): void {
    if (this.ws) return;
    this.listenerProxy = new com.faceclaw.app.FaceclawWebSocketListener({
      onOpen: () => {
        this.open = true;
        for (const chunk of this.pendingPcm.splice(0)) {
          this.sendPcm(chunk);
        }
        if (this.finishRequested) {
          this.sendCloseStream();
        }
        this.options.onStatus("Listening (Deepgram)...");
      },
      onTextMessage: (message: string) => this.handleMessage(String(message)),
      onClosed: () => {
        this.open = false;
        if (this.finishRequested) this.emitFinal();
      },
      onFailure: (message: string) => {
        if (this.closed) return;
        this.options.onError(`Deepgram connection failed: ${String(message)}`);
      },
    });
    try {
      this.ws = new com.faceclaw.app.FaceclawWebSocket(
        WS_URL,
        this.listenerProxy,
        "Authorization",
        `Token ${this.options.apiKey}`,
      );
      this.options.onStatus("Connecting to Deepgram...");
    } catch (error) {
      this.options.onError(`Deepgram connection failed: ${String((error as Error)?.message ?? error)}`);
    }
  }

  acceptPcm(pcm: Uint8Array): void {
    if (this.closed || this.finishRequested || pcm.length === 0) return;
    if (this.open) {
      this.sendPcm(pcm);
    } else {
      if (this.pendingPcm.length >= MAX_PENDING_PCM_CHUNKS) {
        this.pendingPcm.shift();
        this.droppedAudioFrames++;
      }
      this.pendingPcm.push(pcm.slice());
    }
  }

  /** End the user-owned utterance and ask Deepgram to flush its final result. */
  finish(): void {
    if (this.closed || this.finishRequested) return;
    this.finishRequested = true;
    if (this.open) this.sendCloseStream();
  }

  stop(): void {
    this.closed = true;
    this.pendingPcm.length = 0;
    if (this.ws) {
      try {
        this.ws.close(1000, "bye");
      } catch {
        // Ignore a concurrently closed socket.
      }
      this.ws = null;
    }
    this.listenerProxy = null;
  }

  private sendPcm(pcm: Uint8Array): void {
    try {
      this.ws?.sendBinary(toJavaBytes(pcm));
    } catch (error) {
      console.warn("deepgram send failed", error);
    }
  }

  private sendCloseStream(): void {
    try {
      this.ws?.sendText(JSON.stringify({ type: "CloseStream" }));
    } catch (error) {
      console.warn("deepgram close failed", error);
    }
  }

  private handleMessage(text: string): void {
    let message: any;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    if (message?.type === "Error" || message?.error) {
      this.options.onError(`Deepgram: ${String(message?.description ?? message?.error ?? "unknown error")}`);
      return;
    }
    const transcript = String(message?.channel?.alternatives?.[0]?.transcript ?? "").trim();
    if (message?.is_final && transcript) {
      this.finalText = joinTranscript(this.finalText, transcript);
      this.partialText = "";
      this.options.onTranscript({ text: this.finalText, isFinal: false, droppedAudioFrames: this.droppedAudioFrames });
    } else if (transcript) {
      this.partialText = transcript;
      this.options.onTranscript({ text: joinTranscript(this.finalText, transcript), isFinal: false, droppedAudioFrames: this.droppedAudioFrames });
    }
    if (message?.speech_final && this.finishRequested) {
      this.emitFinal();
      this.stop();
    }
    if (message?.type === "Metadata" && this.finishRequested) {
      this.emitFinal();
      this.stop();
    }
  }

  private emitFinal(): void {
    if (this.finalEmitted) return;
    this.finalEmitted = true;
    this.options.onTranscript({ text: joinTranscript(this.finalText, this.partialText), isFinal: true, droppedAudioFrames: this.droppedAudioFrames });
  }
}

function joinTranscript(left: string, right: string): string {
  return [left.trim(), right.trim()].filter(Boolean).join(" ");
}
