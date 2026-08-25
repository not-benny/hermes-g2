/**
 * Screen-off "now playing" card. On a track change while the glasses screen is
 * off (or while a card is already up), the shell wakes and presents this as a
 * top-strip overlay: it drops in from the top, holds (6.5s playing / 15s
 * paused), then rises back out and returns the screen to off if the card is what
 * woke it. Tap toggles play/pause; a deliberate (two-flick) scroll skips
 * next/prev; double-tap dismisses. Self-timed via a setTimeout ticker (the
 * EdgeBounce pattern) - there is no global render tick.
 *
 * Lives under ui/shell (a shell overlay, not a windowed app) and never imports
 * shell.ts: it reaches the shell only through the injected onDismissed callback.
 */

import {
  getDefaultMediumFont,
  getDefaultSmallFont,
} from "../../graphics/bdffont";
import { GrayImage } from "../../graphics/image";
import { truncateText } from "../../graphics/textwrap";
import { clamp } from "../../util/numeric-util";
import {
  mediaControllerBridge,
  type MediaControllerState,
} from "../../native/media-controller";
import {
  type DashboardInputEvent,
  type Layer,
  type LayerActions,
  type LayerContext,
  type PaintBelow,
} from "../layers";
import {
  drawGlassPanel,
  drawGlassProgress,
  GLASS_MOTION,
  GLASS_TONE,
} from "../glass-design";
import { SHELL_OPAQUE_BLACK } from "./geometry";
import { strictDeliveryMarkerGray } from "./strict-delivery-marker";

const CARD_X = 0;
const CARD_W = 640;
const CARD_H = 120;
/** Every meaningful element stays inside the centered x=32..607 optical raster. */
const ART = 88;
const ART_X = 40;
const ART_Y = 16;
const TEXT_X = 144;
const TEXT_RIGHT = 496;
const META_W = TEXT_RIGHT - TEXT_X; // 352
const TITLE_Y = 22;
const TIME_Y = 64;
const BAR_Y = 84;
const GLYPH = 22;
const GLYPH_Y = (CARD_H - GLYPH) / 2; // 49
const PREV_X = 506;
const MIDDLE_X = 544;
const NEXT_X = 582;

const DROP_MS = GLASS_MOTION.cardEnterMs;
const RISE_MS = GLASS_MOTION.cardExitMs;
const TICK_MS = GLASS_MOTION.frameMs;
const PLAY_DISMISS_MS = 6500;
const PAUSE_DISMISS_MS = 15000;
const SKIP_CONFIRM_MS = 700;

type Phase = "dropping" | "holding" | "rising";

export type MusicCardOptions = {
  actions: LayerActions;
  onDismissed: () => void;
};

/**
 * Two-flick skip confirm: the ring emits discrete scroll detents, so a single
 * scroll only ARMS (flash the glyph); a second scroll in the same direction
 * within the window commits the skip. Prevents a stray scroll skipping a track.
 */
class SkipConfirm {
  private dir: -1 | 1 | null = null;
  private since = 0;
  constructor(private readonly windowMs = SKIP_CONFIRM_MS) {}
  /** true when THIS press commits the skip. */
  press(dir: -1 | 1, now: number): boolean {
    if (this.dir === dir && now - this.since <= this.windowMs) {
      this.reset();
      return true;
    }
    this.dir = dir;
    this.since = now;
    return false;
  }
  armed(dir: -1 | 1, now: number): boolean {
    return this.dir === dir && now - this.since <= this.windowMs;
  }
  reset(): void {
    this.dir = null;
    this.since = 0;
  }
}

// --- transport glyphs (drawn from primitives; crisp at any size) ------------

/** Filled triangle pointing right, occupying w x h at (x,y), tip at right-middle. */
function fillTriRight(
  img: GrayImage,
  x: number,
  y: number,
  w: number,
  h: number,
  value: number,
): void {
  const half = (h - 1) / 2;
  for (let r = 0; r < h; r++) {
    const rw = Math.max(1, Math.round(w * (1 - Math.abs(r - half) / half)));
    img.fillRect(x, y + r, rw, 1, value);
  }
}

/** Filled triangle pointing left, tip at left-middle. */
function fillTriLeft(
  img: GrayImage,
  x: number,
  y: number,
  w: number,
  h: number,
  value: number,
): void {
  const half = (h - 1) / 2;
  for (let r = 0; r < h; r++) {
    const rw = Math.max(1, Math.round(w * (1 - Math.abs(r - half) / half)));
    img.fillRect(x + w - rw, y + r, rw, 1, value);
  }
}

function drawPlayGlyph(
  img: GrayImage,
  x: number,
  y: number,
  size: number,
  v: number,
): void {
  fillTriRight(img, x + Math.round(size * 0.14), y, size, size, v);
}

function drawPauseGlyph(
  img: GrayImage,
  x: number,
  y: number,
  size: number,
  v: number,
): void {
  const bw = Math.max(3, Math.round(size * 0.28));
  const gap = Math.round(size * 0.2);
  img.fillRect(x + Math.round(size * 0.12), y, bw, size, v);
  img.fillRect(x + Math.round(size * 0.12) + bw + gap, y, bw, size, v);
}

function drawNextGlyph(
  img: GrayImage,
  x: number,
  y: number,
  size: number,
  v: number,
): void {
  const bw = Math.max(2, Math.round(size * 0.16));
  fillTriRight(img, x, y, size - bw - 2, size, v);
  img.fillRect(x + size - bw, y, bw, size, v);
}

function drawPrevGlyph(
  img: GrayImage,
  x: number,
  y: number,
  size: number,
  v: number,
): void {
  const bw = Math.max(2, Math.round(size * 0.16));
  img.fillRect(x, y, bw, size, v);
  fillTriLeft(img, x + bw + 2, y, size - bw - 2, size, v);
}

function formatMediaTime(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1_000));
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export class MusicCardLayer implements Layer {
  private deliveryNonce = 0;
  private phase: Phase = "dropping";
  private animStart = Date.now();
  private ticking = false;
  private dismissTimer: ReturnType<typeof setTimeout> | null = null;
  private ctx: LayerContext | null = null;
  private art: GrayImage | null = null;
  private artKey = "";
  private readonly skip = new SkipConfirm(SKIP_CONFIRM_MS);
  private offMedia: (() => void) | null = null;
  private presentationStarted = false;

  constructor(private readonly options: MusicCardOptions) {}

  /**
   * Begin painting only after the shell has installed this exact layer and
   * acquired its blanked compositor lease. Construction itself must be inert:
   * an eager ticker can otherwise queue the retained HUD before isolation.
   */
  startPresentation(): void {
    if (this.presentationStarted) return;
    this.presentationStarted = true;
    // Prime a complete, recognizable Now Playing card as the retained frame.
    // The old drop animation began fully off-screen, so compositor unblank
    // could expose a marker-only/black frame before the actual card.
    this.animStart = Date.now() - DROP_MS;
    // Repaint when playback state flips (play/pause) or metadata changes, so the
    // middle glyph and seek position track the live state rather than a stale
    // snapshot taken right after a tap (playPause resolves before the flip lands).
    this.offMedia = mediaControllerBridge.onStateChange(() =>
      this.options.actions.requestRender(),
    );
    this.startAnimTicker();
  }

  /** Force an imperceptible wire-frame change for one exact strict receipt. */
  bumpDeliveryNonce(): void {
    this.deliveryNonce++;
  }

  paint(ctx: LayerContext, _paintBelow: PaintBelow): GrayImage {
    this.ctx = ctx;
    // Own the whole screen: an opaque black surface so only the card shows (the
    // dashboard/UI below is hidden), not paintBelow() which would show it through.
    const { width, height } = ctx.stack.getBaseSize();
    const image = new GrayImage(width, height, SHELL_OPAQUE_BLACK);
    const media = mediaControllerBridge.snapshot();
    const top = Math.round(this.offsetY(Date.now()));

    drawGlassPanel(image, CARD_X, top, CARD_W, CARD_H);

    this.drawArt(image, media, top);

    const medium = getDefaultMediumFont();
    const small = getDefaultSmallFont();
    const label = media.artist
      ? `${media.artist} - ${media.title}`
      : media.title || "Unknown";
    image.drawText(
      medium,
      TEXT_X,
      top + TITLE_Y,
      truncateText(medium, label, META_W),
      GLASS_TONE.primary,
    );

    if (media.durationMs > 0 && media.positionMs >= 0) {
      const elapsed = formatMediaTime(media.positionMs);
      const duration = formatMediaTime(media.durationMs);
      image.drawText(small, TEXT_X, top + TIME_Y, elapsed, GLASS_TONE.muted);
      image.drawText(
        small,
        TEXT_X + META_W - small.measureText(duration),
        top + TIME_Y,
        duration,
        GLASS_TONE.muted,
      );
      const p = clamp(media.positionMs / media.durationMs, 0, 1);
      drawGlassProgress(image, TEXT_X, top + BAR_Y, META_W, 5, p);
    }

    const now = Date.now();
    drawPrevGlyph(
      image,
      PREV_X,
      top + GLYPH_Y,
      GLYPH,
      this.skip.armed(-1, now) ? GLASS_TONE.focus : GLASS_TONE.body,
    );
    if (media.playbackState === "playing") {
      drawPauseGlyph(image, MIDDLE_X, top + GLYPH_Y, GLYPH, GLASS_TONE.primary);
    } else {
      drawPlayGlyph(image, MIDDLE_X, top + GLYPH_Y, GLYPH, GLASS_TONE.primary);
    }
    drawNextGlyph(
      image,
      NEXT_X,
      top + GLYPH_Y,
      GLYPH,
      this.skip.armed(1, now) ? GLASS_TONE.focus : GLASS_TONE.body,
    );
    image.setPixel(
      width - 1,
      height - 1,
      strictDeliveryMarkerGray(this.deliveryNonce),
    );

    return image;
  }

  async handleInput(
    event: DashboardInputEvent,
    ctx: LayerContext,
  ): Promise<void> {
    this.ctx = ctx;
    const now = Date.now();
    if (event.type === "double-click") {
      this.beginRise();
      return;
    }
    if (event.type === "click") {
      await mediaControllerBridge.playPause();
      this.resetDismissTimer();
      ctx.actions.requestRender();
      return;
    }
    if (event.type === "scroll-up" || event.type === "scroll-down") {
      const dir: 1 | -1 = event.type === "scroll-up" ? 1 : -1; // up = next, down = prev
      const media = mediaControllerBridge.snapshot();
      if (this.skip.press(dir, now)) {
        if (dir === 1 && media.canSkipNext)
          await mediaControllerBridge.skipNext();
        if (dir === -1 && media.canSkipPrevious)
          await mediaControllerBridge.skipPrevious();
      }
      this.resetDismissTimer();
      ctx.actions.requestRender();
      return;
    }
    // long-press / wakeword / display-wake / unknown: ignore
  }

  onRemoved(): void {
    // A queued animation callback may still run after LayerStack teardown.
    // Mark the lifecycle inactive before clearing its resources so that callback
    // cannot mistake an absent card for a merely covered one and rearm forever.
    this.presentationStarted = false;
    this.ctx = null;
    if (this.dismissTimer !== null) {
      clearTimeout(this.dismissTimer);
      this.dismissTimer = null;
    }
    this.ticking = false;
    this.offMedia?.();
    this.offMedia = null;
  }

  /** Called by shell.openMusicCard when a new track arrives while shown. */
  onTrackChanged(): void {
    if (this.phase === "rising") {
      this.phase = "dropping";
      this.animStart = Date.now();
      this.startAnimTicker();
    }
    this.resetDismissTimer();
    this.ctx?.actions.requestRender();
  }

  /**
   * A higher-priority opaque layer (currently Clock) may cover this card. Keep
   * both the retained card and its sleep-origin wake alive until it is top
   * again; dismissing it underneath the cover would later expose the HUD.
   */
  deferDismissalWhileCovered(): boolean {
    if (
      !this.presentationStarted ||
      !this.ctx ||
      !this.ctx.stack.contains(this) ||
      this.ctx.stack.topMatches((top) => top === this)
    ) {
      return false;
    }
    if (this.dismissTimer !== null) clearTimeout(this.dismissTimer);
    this.dismissTimer = null;
    this.phase = "holding";
    this.ticking = false;
    this.armDismiss();
    return true;
  }

  private offsetY(now: number): number {
    if (this.phase === "dropping") {
      const t = clamp((now - this.animStart) / DROP_MS, 0, 1);
      return -CARD_H * (1 - Math.pow(1 - t, 3)); // easeOutCubic, -120 -> 0
    }
    if (this.phase === "rising") {
      const t = clamp((now - this.animStart) / RISE_MS, 0, 1);
      return -CARD_H * (t * t * t); // easeInCubic, 0 -> -120
    }
    return 0; // holding
  }

  private startAnimTicker(): void {
    if (this.presentationStarted && !this.ticking) {
      this.ticking = true;
      this.tick();
    }
  }

  private tick(): void {
    if (!this.presentationStarted) return;
    this.options.actions.requestRender();
    const dur = this.phase === "rising" ? RISE_MS : DROP_MS;
    if (this.ticking && Date.now() - this.animStart < dur) {
      setTimeout(() => this.tick(), TICK_MS);
      return;
    }
    if (this.phase === "dropping") {
      this.phase = "holding";
      this.ticking = false;
      this.armDismiss();
      this.options.actions.requestRender();
    } else if (this.phase === "rising") {
      if (this.deferDismissalWhileCovered()) return;
      this.ticking = false;
      this.options.onDismissed();
    }
  }

  private beginRise(): void {
    if (!this.presentationStarted || this.phase === "rising") return;
    if (this.dismissTimer !== null) {
      clearTimeout(this.dismissTimer);
      this.dismissTimer = null;
    }
    this.phase = "rising";
    this.animStart = Date.now();
    this.startAnimTicker();
  }

  private dismissMs(): number {
    return mediaControllerBridge.snapshot().playbackState === "playing"
      ? PLAY_DISMISS_MS
      : PAUSE_DISMISS_MS;
  }

  private armDismiss(): void {
    if (!this.presentationStarted) return;
    if (this.dismissTimer !== null) clearTimeout(this.dismissTimer);
    this.dismissTimer = setTimeout(() => {
      this.dismissTimer = null;
      if (!this.presentationStarted) return;
      if (this.deferDismissalWhileCovered()) return;
      this.beginRise();
    }, this.dismissMs());
  }

  private resetDismissTimer(): void {
    if (this.phase === "holding") this.armDismiss(); // else the drop completion arms it
  }

  private drawArt(
    image: GrayImage,
    media: MediaControllerState,
    top: number,
  ): void {
    const key = `${media.packageName}|${media.title}|${media.album}`;
    if (key !== this.artKey) {
      this.artKey = key;
      this.art = mediaControllerBridge.getAlbumArt(ART);
    }
    if (this.art) {
      const dx = ART_X + Math.max(0, ((ART - this.art.width) / 2) | 0);
      const dy = top + ART_Y + Math.max(0, ((ART - this.art.height) / 2) | 0);
      image.bitBlt(this.art, dx, dy); // NOT transparentZero: keep art's black pixels
      image.drawRect(
        dx - 1,
        dy - 1,
        this.art.width + 2,
        this.art.height + 2,
        60,
      );
    } else {
      image.drawRect(ART_X, top + ART_Y, ART, ART, 60);
    }
  }
}
