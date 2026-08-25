/**
 * Opaque fresh-notification card. It is installed and primed while the lens is
 * compositor-blank, then revealed as the first visible frame. A click opens
 * the full notification dialogue; a double click or timeout dismisses only
 * this presentation and restores the display state that preceded it.
 */

import {
  getDefaultLargeFont,
  getDefaultMediumFont,
  getDefaultSmallFont,
  type BdfFont,
} from "../../graphics/bdffont";
import { GrayImage } from "../../graphics/image";
import { truncateText, wrapText } from "../../graphics/textwrap";
import {
  readNotificationIconByKey,
  type AndroidNotification,
} from "../../native/notification-icons";
import {
  noteStaleDataUsed,
  renderPassAllowsStaleData,
} from "../../util/render-freshness";
import {
  drawGlassPanel,
  GLASS_RADIUS,
  GLASS_SPACE,
  GLASS_TONE,
} from "../glass-design";
import type {
  DashboardInputEvent,
  Layer,
  LayerContext,
  PaintBelow,
} from "../layers";
import { GESTURE_CLICK, GESTURE_DOUBLE_CLICK } from "../gestures";
import { notificationFontSizeSetting } from "../dashboard-settings";
import { G2_VISIBLE_WIDTH, SHELL_OPAQUE_BLACK } from "./geometry";
import { strictDeliveryMarkerGray } from "./strict-delivery-marker";

const CARD_HEIGHT = 120;
const IDENTITY_ICON_SIZE = 24;
const IDENTITY_BADGE_SIZE = 28;
const IDENTITY_GAP = GLASS_SPACE.sm;
const AUTO_DISMISS_MS = 8_000;

export type NotificationCardGeometry = {
  identityX: number;
  identityY: number;
  identitySize: number;
  appTextX: number;
  appTextWidth: number;
  messageX: number;
  messageWidth: number;
  dividerY: number;
};

/**
 * Keep source identity and message copy wholly inside the optical raster. The
 * old logical 608px message row was clipped to 576px by the centered optics;
 * the new row retains those same 576 wearer-visible pixels without clipping
 * its first and last characters.
 */
export function notificationCardGeometry(
  width: number,
): NotificationCardGeometry {
  const opticalInset = Math.max(0, Math.floor((width - G2_VISIBLE_WIDTH) / 2));
  const opticalRight = width - opticalInset;
  const identityX = opticalInset + GLASS_SPACE.xs;
  const appTextX = identityX + IDENTITY_BADGE_SIZE + IDENTITY_GAP;
  return {
    identityX,
    identityY: 6,
    identitySize: IDENTITY_BADGE_SIZE,
    appTextX,
    appTextWidth: Math.max(1, opticalRight - appTextX),
    messageX: opticalInset,
    messageWidth: Math.max(1, opticalRight - opticalInset),
    dividerY: 35,
  };
}

/** Deterministic one-character identity when Android cannot provide an icon. */
export function notificationIdentityGlyph(
  appName: string,
  packageName: string,
): string {
  const packageLeaf = packageName.split(".").filter(Boolean).at(-1) ?? "";
  const source = appName.trim() || packageLeaf.trim();
  const glyph = Array.from(source).find((character) =>
    /[A-Za-z0-9]/u.test(character),
  );
  return glyph?.toLocaleUpperCase() ?? "?";
}

function notificationCardTextFont(): BdfFont {
  switch (notificationFontSizeSetting.get()) {
    case "large":
      return getDefaultLargeFont();
    case "medium":
      return getDefaultMediumFont();
    case "small":
    default:
      return getDefaultSmallFont();
  }
}

export type NotificationCardOptions = {
  notification: AndroidNotification;
  reason: string;
  onOpen: () => void;
  onDismissed: () => void;
};

export class NotificationCardLayer implements Layer {
  private deliveryNonce = 0;
  private dismissTimer: ReturnType<typeof setTimeout> | null = null;
  private started = false;

  constructor(private readonly options: NotificationCardOptions) {}

  /** Construction is deliberately inert until compositor isolation is held. */
  startPresentation(): void {
    if (this.started) return;
    this.started = true;
    this.armDismissTimer();
  }

  /** A higher-priority Clock card covered this one when its timer elapsed. */
  deferDismissalWhileCovered(): void {
    if (!this.started || this.dismissTimer !== null) return;
    this.armDismissTimer();
  }

  private armDismissTimer(): void {
    this.dismissTimer = setTimeout(() => {
      this.dismissTimer = null;
      this.options.onDismissed();
    }, AUTO_DISMISS_MS);
  }

  bumpDeliveryNonce(): void {
    this.deliveryNonce++;
  }

  paint(ctx: LayerContext, _paintBelow: PaintBelow): GrayImage {
    const { width, height } = ctx.stack.getBaseSize();
    const image = new GrayImage(width, height, SHELL_OPAQUE_BLACK);
    const medium = getDefaultMediumFont();
    const small = getDefaultSmallFont();
    const textFont = notificationCardTextFont();
    const notification = this.options.notification;
    const app =
      notification.appName || notification.packageName || "Notification";
    const title =
      notification.title ||
      notification.text ||
      notification.summaryText ||
      "New notification";
    const body =
      notification.bigText ||
      notification.text ||
      notification.lines.join(" / ") ||
      notification.summaryText;
    const geometry = notificationCardGeometry(width);

    drawGlassPanel(image, 0, 0, width, CARD_HEIGHT);
    this.drawIdentity(image, medium, geometry, app);
    image.drawLine(
      geometry.messageX,
      geometry.dividerY,
      geometry.messageX + geometry.messageWidth - 1,
      geometry.dividerY,
      GLASS_TONE.divider,
    );
    const titleY = 40;
    image.drawText(
      textFont,
      geometry.messageX,
      titleY,
      truncateText(textFont, title, geometry.messageWidth),
      GLASS_TONE.primary,
    );
    const bodyY = titleY + textFont.lineHeight + 5;
    const bodyLineHeight = textFont.lineHeight + 2;
    const footerY = CARD_HEIGHT - 17;
    const maxBodyLines = Math.min(
      2,
      Math.max(0, Math.floor((footerY - bodyY - 3) / bodyLineHeight)),
    );
    const lines =
      body === title
        ? []
        : wrapText(textFont, body, geometry.messageWidth).slice(
            0,
            maxBodyLines,
          );
    for (let index = 0; index < lines.length; index++) {
      image.drawText(
        textFont,
        geometry.messageX,
        bodyY + index * bodyLineHeight,
        lines[index]!,
        GLASS_TONE.secondary,
      );
    }
    const footer = `${GESTURE_CLICK} open   ${GESTURE_DOUBLE_CLICK} dismiss`;
    image.drawText(small, geometry.messageX, footerY, footer, GLASS_TONE.hint);
    image.setPixel(
      width - 1,
      height - 1,
      strictDeliveryMarkerGray(this.deliveryNonce),
    );
    return image;
  }

  private drawIdentity(
    image: GrayImage,
    medium: BdfFont,
    geometry: NotificationCardGeometry,
    app: string,
  ): void {
    const { icon, stale } = readNotificationIconByKey(
      this.options.notification.key,
      renderPassAllowsStaleData(),
    );
    if (stale) noteStaleDataUsed();
    if (icon) {
      image.bitBlt(
        icon,
        geometry.identityX +
          Math.floor((geometry.identitySize - IDENTITY_ICON_SIZE) / 2),
        geometry.identityY +
          Math.floor((geometry.identitySize - IDENTITY_ICON_SIZE) / 2),
        { transparentZero: true },
      );
    } else {
      image.fillRoundedRect(
        geometry.identityX,
        geometry.identityY,
        geometry.identitySize,
        geometry.identitySize,
        GLASS_TONE.selectedFill,
        GLASS_RADIUS.selection,
      );
      image.drawRoundedRect(
        geometry.identityX,
        geometry.identityY,
        geometry.identitySize,
        geometry.identitySize,
        GLASS_TONE.border,
        GLASS_RADIUS.selection,
      );
      const glyph = notificationIdentityGlyph(
        this.options.notification.appName,
        this.options.notification.packageName,
      );
      image.drawText(
        medium,
        geometry.identityX +
          Math.floor((geometry.identitySize - medium.measureText(glyph)) / 2),
        geometry.identityY +
          Math.floor((geometry.identitySize - medium.lineHeight) / 2),
        glyph,
        GLASS_TONE.primary,
      );
    }
    image.drawText(
      medium,
      geometry.appTextX,
      12,
      truncateText(medium, app, geometry.appTextWidth),
      GLASS_TONE.body,
    );
  }

  handleInput(event: DashboardInputEvent): void {
    if (event.type === "click") {
      // Keep the bounded presentation timeout armed until the shell has
      // atomically replaced this card with its detail layer. If the render
      // drain stalls, the card can still dismiss and return a sleep-origin
      // presentation to sleep instead of hanging the lens indefinitely.
      this.options.onOpen();
    } else if (event.type === "double-click") {
      this.clearTimer();
      this.options.onDismissed();
    }
  }

  onRemoved(): void {
    this.clearTimer();
  }

  private clearTimer(): void {
    if (this.dismissTimer === null) return;
    clearTimeout(this.dismissTimer);
    this.dismissTimer = null;
  }
}
