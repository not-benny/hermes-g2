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
import type { AndroidNotification } from "../../native/notification-icons";
import type { DashboardInputEvent, Layer, LayerContext, PaintBelow } from "../layers";
import { GESTURE_CLICK, GESTURE_DOUBLE_CLICK } from "../gestures";
import { notificationFontSizeSetting } from "../dashboard-settings";
import { SHELL_OPAQUE_BLACK } from "./geometry";
import { strictDeliveryMarkerGray } from "./strict-delivery-marker";

const CARD_HEIGHT = 120;
const CARD_RADIUS = 12;
const PADDING = 16;
const AUTO_DISMISS_MS = 8_000;

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
    const app = notification.appName || notification.packageName || "Notification";
    const title = notification.title || notification.text || notification.summaryText || "New notification";
    const body = notification.bigText || notification.text || notification.lines.join(" / ") || notification.summaryText;
    const contentWidth = width - PADDING * 2;

    image.fillRoundedRect(0, 0, width, CARD_HEIGHT, SHELL_OPAQUE_BLACK, CARD_RADIUS);
    image.drawRoundedRect(0, 0, width, CARD_HEIGHT, 110, CARD_RADIUS);
    image.drawText(medium, PADDING, 14, truncateText(medium, app, contentWidth), 220);
    const titleY = 35;
    image.drawText(textFont, PADDING, titleY, truncateText(textFont, title, contentWidth), 245);
    const bodyY = titleY + textFont.lineHeight + 5;
    const bodyLineHeight = textFont.lineHeight + 2;
    const footerY = CARD_HEIGHT - 17;
    const maxBodyLines = Math.min(
      2,
      Math.max(0, Math.floor((footerY - bodyY - 3) / bodyLineHeight)),
    );
    const lines = body === title
      ? []
      : wrapText(textFont, body, contentWidth).slice(0, maxBodyLines);
    for (let index = 0; index < lines.length; index++) {
      image.drawText(textFont, PADDING, bodyY + index * bodyLineHeight, lines[index]!, 175);
    }
    const footer = `${GESTURE_CLICK} open   ${GESTURE_DOUBLE_CLICK} dismiss`;
    image.drawText(small, PADDING, footerY, footer, 115);
    image.setPixel(width - 1, height - 1, strictDeliveryMarkerGray(this.deliveryNonce));
    return image;
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
