import { G2_LENS_HEIGHT, G2_LENS_WIDTH, GrayImage } from "../graphics/image";
import { BdfFont } from "../graphics/bdffont";
import { spanCurrent } from "../native/frame-timings";
import { type ConfigSettingString, type VoiceProvider } from "./dashboard-settings";

export type DashboardInputEvent =
  | { type: "click"; source: "ring" | "left-arm" | "right-arm" }
  | { type: "double-click"; source: "ring" | "left-arm" | "right-arm" }
  | { type: "scroll-up" }
  | { type: "scroll-down" }
  | { type: "long-press"; source: "ring" | "left-arm" | "right-arm" }
  | { type: "long-press-release"; source: "ring" | "left-arm" | "right-arm" }
  /**
   * The stock display lifecycle woke while no EvenHub page was running. This
   * is wake-only, unlike a normal double-click (which turns an on screen off).
   */
  | { type: "display-wake" }
  /**
   * The on-glasses "Hey Even" wakeword fired. Delivered on sid 0x07 by the
   * stock firmware regardless of CFW; the CFW additionally suppresses the stock
   * Even AI app so this is ours to handle. Its configured action may be applied
   * while the screen is off, unlike ordinary input events.
   */
  | { type: "wakeword" }
  | { type: "unknown"; kind: string; eventSource: number; eventType: number };

export type LayerActions = {
  /** Ask for a dashboard repaint+transmit, e.g. when async data arrives. */
  requestRender: () => void;
  disconnect: () => Promise<void> | void;
  startTextSettingEdit: (setting: ConfigSettingString) => Promise<void> | void;
  endTextSettingEdit: () => Promise<void> | void;
  /**
   * Start push-to-talk voice capture with the provider chosen in settings.
   * With `endpointing`, the capture also ends itself when the speaker stops
   * (hands-free); otherwise it runs until stopVoiceCapture.
   */
  startVoiceCapture: (endpointing?: boolean) => number;
  /** Finish (commit=true) or cancel the exact capture generation. */
  stopVoiceCapture: (generation: number, commit: boolean) => Promise<void> | void;
  /** Start isolated continuous capture with an app-owned provider choice. */
  startContinuousVoiceCapture: (provider?: VoiceProvider) => number;
  /** Stop audio and await the exact capture's bounded final transcript flush. */
  finishContinuousVoiceCapture: (generation: number) => Promise<void>;
  /** Cancel immediately without asking the provider to finalize. */
  stopContinuousVoiceCapture: (generation: number) => Promise<void> | void;
  /** Play a CFW tone-sequencer payload (see sound-effects.ts). */
  playBuzzerSequence: (payload: Uint8Array) => Promise<void> | void;
};

/** Do-nothing actions, for stacks whose layers never use them (or as a base to spread over). */
export const noopLayerActions: LayerActions = {
  requestRender: () => {},
  disconnect: () => {},
  startTextSettingEdit: () => {},
  endTextSettingEdit: () => {},
  startVoiceCapture: () => 0,
  stopVoiceCapture: () => {},
  startContinuousVoiceCapture: () => 0,
  finishContinuousVoiceCapture: async () => {},
  stopContinuousVoiceCapture: () => {},
  playBuzzerSequence: () => {},
};

export type PaintBelow = () => GrayImage;

function notifyRemoved(layer: Layer | undefined): void {
  try {
    layer?.onRemoved?.();
  } catch (error) {
    console.warn("layer onRemoved failed", error);
  }
}

export interface LayerContext {
  readonly stack: LayerStack;
  readonly actions: LayerActions;
}

export interface Layer {
  readonly paintOverBase?: boolean;
  paint(ctx: LayerContext, paintBelow: PaintBelow): GrayImage;
  handleInput(event: DashboardInputEvent, ctx: LayerContext): Promise<void> | void;
  /** Called when the layer leaves the stack by any path (pop or clearToBase). */
  onRemoved?(): void;
  /** Called for the base layer when its shell window gains or loses focus. */
  onForegroundChanged?(foreground: boolean): void;
  /** Called for the base layer when the G2 display wakes or sleeps. */
  onScreenChanged?(screenOn: boolean): void;
}

export class LayerStack {
  private readonly layers: Layer[];
  private readonly ctx: LayerContext;
  private readonly baseWidth: number;
  private readonly baseHeight: number;
  private readonly focusedFn: () => boolean;

  constructor(
    baseLayer: Layer,
    actions: LayerActions,
    baseSize?: { width: number; height: number },
    // Whether this stack is the current input target; drives the strength of
    // selection highlights (a visible-but-unfocused window dims its selection).
    // Defaults to always-focused for shell overlays and standalone stacks.
    isFocused: () => boolean = () => true,
    /** Shell stacks use this to retry retained work after any blocker leaves. */
    private readonly onLayerRemoved?: () => void,
  ) {
    this.layers = [baseLayer];
    this.ctx = {
      stack: this,
      actions,
    };
    this.baseWidth = baseSize?.width ?? G2_LENS_WIDTH;
    this.baseHeight = baseSize?.height ?? G2_LENS_HEIGHT;
    this.focusedFn = isFocused;
  }

  isFocused(): boolean {
    return this.focusedFn();
  }

  push(layer: Layer): void {
    this.layers.push(layer);
  }

  pop(): void {
    if (this.layers.length > 1) {
      notifyRemoved(this.layers.pop());
      this.notifyLayerRemoved();
    }
  }

  /** Whether the top layer matches (without popping it). */
  topMatches(predicate: (layer: Layer) => boolean): boolean {
    return this.layers.length > 1 && predicate(this.layers[this.layers.length - 1]!);
  }

  /** Whether this exact overlay is still installed anywhere above the base. */
  contains(target: Layer): boolean {
    return this.layers.indexOf(target) > 0;
  }

  /** Reinstall a detached layer immediately below one exact covering overlay. */
  insertBefore(target: Layer, cover: Layer): boolean {
    if (this.layers.includes(target)) return false;
    const coverIndex = this.layers.indexOf(cover);
    if (coverIndex <= 0) return false;
    this.layers.splice(coverIndex, 0, target);
    return true;
  }

  /** Pop the top layer only if it matches; returns whether a layer was popped. */
  popIfTop(predicate: (layer: Layer) => boolean): boolean {
    if (this.layers.length > 1 && predicate(this.layers[this.layers.length - 1]!)) {
      notifyRemoved(this.layers.pop());
      this.notifyLayerRemoved();
      return true;
    }
    return false;
  }

  /** Remove an owned layer even when another overlay is above it. */
  remove(target: Layer): boolean {
    const index = this.layers.indexOf(target);
    if (index <= 0) return false;
    const [removed] = this.layers.splice(index, 1);
    notifyRemoved(removed);
    this.notifyLayerRemoved();
    return true;
  }

  /** Detach a layer without firing teardown while ownership continues elsewhere. */
  detach(target: Layer): boolean {
    const index = this.layers.indexOf(target);
    if (index <= 0) return false;
    this.layers.splice(index, 1);
    this.notifyLayerRemoved();
    return true;
  }

  clearToBase(): void {
    const removed = this.layers.splice(1);
    for (const layer of removed) {
      notifyRemoved(layer);
    }
    if (removed.length) this.notifyLayerRemoved();
  }

  notifyBaseRemoved(): void {
    notifyRemoved(this.layers[0]);
  }

  notifyForegroundChanged(foreground: boolean): void {
    this.layers[0]?.onForegroundChanged?.(foreground);
  }

  notifyScreenChanged(screenOn: boolean): void {
    this.layers[0]?.onScreenChanged?.(screenOn);
  }

  isAtBase(): boolean {
    return this.layers.length === 1;
  }

  getBaseSize(): { width: number; height: number } {
    return { width: this.baseWidth, height: this.baseHeight };
  }

  setActions(actions: Partial<LayerActions>): void {
    Object.assign(this.ctx.actions, actions);
  }

  paint(): GrayImage {
    return this.paintLayer(this.layers.length - 1);
  }

  /**
   * Paint only the top overlay over an empty surface. Shell-owned dialogs use
   * this while the display is awake solely for assistant voice interaction:
   * retained app windows and chrome must not leak into that presentation.
   */
  paintTopOverBlank(): GrayImage {
    if (this.layers.length <= 1) {
      return new GrayImage(this.baseWidth, this.baseHeight, 0);
    }
    const top = this.layers.length - 1;
    return this.layers[top]!.paint(this.ctx, () =>
      new GrayImage(this.baseWidth, this.baseHeight, 0),
    );
  }

  async handleInput(event: DashboardInputEvent): Promise<void> {
    await this.layers[this.layers.length - 1]!.handleInput(event, this.ctx);
  }

  private paintLayer(index: number): GrayImage {
    const layer = this.layers[index]!;
    let cachedBelow: GrayImage | null = null;
    return spanCurrent(`paint[${index}]:${layer.constructor.name}`, () =>
      layer.paint(this.ctx, () => {
        if (cachedBelow) {
          return cachedBelow;
        }
        if (index <= 0) {
          cachedBelow = new GrayImage(this.baseWidth, this.baseHeight, 0);
        } else if (layer.paintOverBase) {
          cachedBelow = this.paintLayer(0);
        } else {
          cachedBelow = this.paintLayer(index - 1);
        }
        return cachedBelow;
      }),
    );
  }

  private notifyLayerRemoved(): void {
    try { this.onLayerRemoved?.(); }
    catch (error) { console.warn("layer removal listener failed", error); }
  }
}
