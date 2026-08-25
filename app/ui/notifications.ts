import { clamp } from "~/util/numeric-util";
import { formatRelativeTime } from "~/util/date-util";
import {
  BdfFont,
  getDefaultSmallFont,
  getDefaultMediumFont,
  getDefaultLargeFont,
} from "../graphics/bdffont";
import { truncateText } from "../graphics/textwrap";
import { GrayImage } from "../graphics/image";
import { wrapText } from "../graphics/textwrap";
import { GESTURE_DOUBLE_CLICK } from "./gestures";
import { EdgeBounce, EdgeWrapScroller } from "./edge-scroll";
import {
  dismissNotification,
  invokeNotificationAction,
  readActiveNotifications,
  readNotificationIconByKey,
  type AndroidNotification,
  type AndroidNotificationAction,
} from "../native/notification-icons";
import { isNotificationListenerEnabled } from "../native/notification-access";
import {
  noteStaleDataUsed,
  renderPassAllowsStaleData,
} from "../util/render-freshness";
import {
  type DashboardInputEvent,
  type Layer,
  type LayerContext,
  type PaintBelow,
} from "./layers";
import { VoiceInputLayer } from "./shell/voice-input";
import { notificationFontSizeSetting } from "./dashboard-settings";
import {
  notificationTriageController,
  notificationTriageReason,
} from "../notifications/triage-controller";
import {
  notificationDetailMenuLayout,
  notificationDigestLayout,
} from "./notification-pagination";
import {
  drawGlassPanel,
  drawGlassSelection,
  GLASS_RADIUS,
  GLASS_TONE,
} from "./glass-design";

const PAGE_X = 12;
const PAGE_Y = 12;
const LIST_TOP = 38;
const CARD_X = 20;
const ICON_SIZE = 24;
const ICON_TEXT_GAP = 8;
const CARD_TEXT_X = 10 + ICON_SIZE + ICON_TEXT_GAP;
/**
 * The on-glass notification font, per the user's size setting. Small routes
 * through getDefaultSmallFont so it still honors the uiFont (Terminus vs
 * proportional) choice; medium/large are Terminus-only (no larger proportional
 * face is bundled).
 */
function notificationFont(): BdfFont {
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

/** Per-line vertical advance for a font: preserves the historic 14px for the
 *  12px small font (12 + 2 leading), scaling to 18 (medium) / 26 (large). */
function lineHeightFor(font: BdfFont): number {
  return font.lineHeight + 2;
}
const CARD_GAP = 6;
const MAX_NOTIFICATIONS = 50;
// Right-hand action menu of the detail view.
const DETAIL_MENU_WIDTH = 148;
const DETAIL_CONTENT_X = 24;

/** Icon for a paint pass: allow-stale, reporting staleness to the render loop. */
function iconForNotification(key: string): GrayImage | null {
  const { icon, stale } = readNotificationIconByKey(
    key,
    renderPassAllowsStaleData(),
  );
  if (stale) {
    noteStaleDataUsed();
  }
  return icon;
}

type CardLayout = {
  notification: AndroidNotification;
  height: number;
  lines: string[];
};

type DetailMenuItem =
  | { kind: "back"; label: string }
  | { kind: "action"; label: string; action: AndroidNotificationAction }
  | { kind: "dismiss"; label: string };

export type SingleNotificationLayerOrigin =
  | "notifications-list"
  | "new-notification-modal";

/**
 * Keep the user-visible notification card independent from Android's live
 * StatusBarNotification object. Many apps replace or remove that object while
 * G2 is still waking; retaining this bounded, in-memory projection prevents a
 * successfully selected notification from erasing itself before it can be
 * read. Nothing here is persisted.
 */
export function retainAndroidNotification(
  notification: AndroidNotification,
): AndroidNotification {
  return {
    ...notification,
    lines: [...notification.lines],
    actions: notification.actions.map((action) => ({ ...action })),
  };
}

export class NotificationDigestLayer implements Layer {
  private selectedIndex = 0;
  private readonly retainedEntries: Array<{
    entry: { key: string; revision: string; reason: string };
    notification: AndroidNotification;
  }>;

  constructor(
    entries: readonly {
      key: string;
      revision: string;
      reason: string;
      notification?: AndroidNotification;
    }[],
    private readonly closeModal: (ctx: LayerContext) => void,
  ) {
    const active = readActiveNotifications(MAX_NOTIFICATIONS);
    this.retainedEntries = entries.flatMap((entry) => {
      const notification =
        entry.notification ?? active.find((item) => item.key === entry.key);
      return notification
        ? [
            {
              entry: {
                key: entry.key,
                revision: entry.revision,
                reason: entry.reason,
              },
              notification: retainAndroidNotification(notification),
            },
          ]
        : [];
    });
  }

  paint(ctx: LayerContext): GrayImage {
    const font = notificationFont();
    const { width, height } = ctx.stack.getBaseSize();
    const image = new GrayImage(width, height, 0);
    const retained = this.retainedEntries;
    if (!retained.length) {
      this.closeModal(ctx);
      return image;
    }
    this.selectedIndex = clamp(this.selectedIndex, 0, retained.length - 1);
    const layout = notificationDigestLayout(
      height,
      font.lineHeight,
      retained.length,
      this.selectedIndex,
    );
    const range =
      layout.start > 0 || layout.end < retained.length
        ? ` · ${layout.start + 1}-${layout.end}`
        : "";
    image.drawText(
      font,
      18,
      14,
      `Notifications ${this.selectedIndex + 1}/${retained.length}${range}`,
      GLASS_TONE.primary,
    );
    image.drawLine(
      18,
      layout.listTop - 5,
      width - 18,
      layout.listTop - 5,
      GLASS_TONE.divider,
    );
    let y = layout.listTop;
    for (let index = layout.start; index < layout.end; index++) {
      const item = retained[index]!;
      const selected = index === this.selectedIndex;
      if (selected) {
        drawGlassSelection(
          image,
          12,
          y - 3,
          width - 24,
          layout.lineAdvance * 2,
          ctx.stack.isFocused(),
          GLASS_RADIUS.selection,
        );
      }
      image.drawText(
        font,
        24,
        y,
        `${item.notification.appName}: ${notificationTitle(item.notification)}`,
        selected ? GLASS_TONE.primary : GLASS_TONE.muted,
      );
      y += layout.lineAdvance;
      if (selected) {
        image.drawText(
          font,
          34,
          y,
          `Why: ${item.entry.reason}`,
          GLASS_TONE.secondary,
        );
        y += layout.lineAdvance;
      }
    }
    image.drawText(
      font,
      18,
      height - font.lineHeight - 4,
      `Click review · ${GESTURE_DOUBLE_CLICK} close`,
      GLASS_TONE.hint,
    );
    return image;
  }

  handleInput(event: DashboardInputEvent, ctx: LayerContext): void {
    const retained = this.retainedEntries;
    if (event.type === "double-click") {
      this.closeModal(ctx);
      return;
    }
    if (!retained.length) return;
    this.selectedIndex = clamp(this.selectedIndex, 0, retained.length - 1);
    if (event.type === "scroll-up" || event.type === "scroll-down") {
      const direction = event.type === "scroll-down" ? 1 : -1;
      this.selectedIndex =
        (this.selectedIndex + direction + retained.length) % retained.length;
    } else if (event.type === "click") {
      const selected = retained[this.selectedIndex]!;
      ctx.stack.push(
        new SingleNotificationLayer(selected.entry.key, {
          origin: "notifications-list",
          retainedNotification: selected.notification,
          retainedReason: selected.entry.reason,
        }),
      );
    }
  }
}

type SingleNotificationLayerOptions = {
  origin: SingleNotificationLayerOrigin;
  expectedRevision?: string;
  /** Frozen presentation data used only by a shell modal/digest. */
  retainedNotification?: AndroidNotification;
  retainedReason?: string;
  /** Close hook for the modal origin (the layer is the modal stack's base, so pop() cannot close it). */
  closeModal?: (ctx: LayerContext) => void;
};

/**
 * Scrollable list of active Android notifications. Sized to its hosting
 * stack (the Notifications app viewport). Selecting one pushes the detail
 * view.
 */
export class NotificationsListLayer implements Layer {
  private selectedKey = "";
  private readonly scroller = new EdgeWrapScroller(
    undefined,
    "notifications-list",
  );
  private readonly bounce = new EdgeBounce();

  paint(ctx: LayerContext): GrayImage {
    const font = notificationFont();
    const lineHeight = lineHeightFor(font);
    const { width, height } = ctx.stack.getBaseSize();
    const image = new GrayImage(width, height, 0);
    const cardWidth = width - 2 * CARD_X;
    const cardTextWidth = cardWidth - CARD_TEXT_X - 14;
    const notifications = readActiveNotifications(MAX_NOTIFICATIONS);
    const selectedIndex = this.resolveSelectedIndex(notifications);
    const layouts = notifications.map((notification, index) =>
      buildNotificationCardLayout(
        font,
        notification,
        index === selectedIndex,
        cardTextWidth,
      ),
    );

    image.drawText(
      font,
      PAGE_X + 12,
      PAGE_Y + 9,
      "Notifications",
      GLASS_TONE.primary,
    );
    image.drawText(
      font,
      width - 96,
      PAGE_Y + 9,
      `${selectedIndex + 1}/${notifications.length}`,
      GLASS_TONE.muted,
    );

    if (!notifications.length) {
      const message = isNotificationListenerEnabled()
        ? "No current Android notifications."
        : "Grant permission on your phone to view notifications on the glasses.";
      const messageLines = wrapText(font, message, width - 48);
      for (let index = 0; index < messageLines.length; index++) {
        image.drawText(
          font,
          24,
          72 + index * lineHeight,
          messageLines[index]!,
          GLASS_TONE.body,
        );
      }
      image.drawText(
        font,
        24,
        height - 36,
        `${GESTURE_DOUBLE_CLICK} back`,
        GLASS_TONE.hint,
      );
      return image;
    }

    const focused = ctx.stack.isFocused();
    const listBottom = height;
    const scrollY = scrollForSelected(
      layouts,
      selectedIndex,
      listBottom - LIST_TOP,
    );
    let cursorY = LIST_TOP - scrollY + this.bounce.offsetPx();
    for (let index = 0; index < layouts.length; index++) {
      const layout = layouts[index]!;
      if (cursorY + layout.height >= LIST_TOP && cursorY <= listBottom) {
        // Icons are only resolved for cards actually drawn, so a long list
        // does not fetch icons for everything below the fold.
        const icon = iconForNotification(layout.notification.key);
        drawNotificationCard(
          image,
          font,
          layout,
          CARD_X,
          cursorY,
          cardWidth,
          index === selectedIndex,
          focused,
          icon,
        );
      }
      cursorY += layout.height + CARD_GAP;
      if (cursorY > listBottom + 80) break;
    }

    return image;
  }

  handleInput(event: DashboardInputEvent, ctx: LayerContext): void {
    const notifications = readActiveNotifications(MAX_NOTIFICATIONS);
    const selectedIndex = this.resolveSelectedIndex(notifications);
    if (event.type === "double-click") {
      // At the app's root this is intercepted by the yield wrapper; reached
      // only if hosted somewhere deeper, where popping is right.
      ctx.stack.pop();
      return;
    }
    if (!notifications.length) return;

    if (event.type === "scroll-up" || event.type === "scroll-down") {
      const dir = event.type === "scroll-down" ? 1 : -1;
      const step = this.scroller.step(
        selectedIndex,
        notifications.length,
        dir,
        Date.now(),
      );
      if (step.atEdge) {
        this.bounce.trigger(dir, () => ctx.actions.requestRender());
        return;
      }
      this.selectedKey = notifications[step.index]!.key;
      return;
    }
    if (event.type === "click") {
      ctx.stack.push(
        new SingleNotificationLayer(notifications[selectedIndex]!.key, {
          origin: "notifications-list",
        }),
      );
    }
  }

  private resolveSelectedIndex(notifications: AndroidNotification[]): number {
    if (!notifications.length) {
      this.selectedKey = "";
      return -1;
    }
    let index = notifications.findIndex(
      (notification) => notification.key === this.selectedKey,
    );
    if (index < 0) {
      index = 0;
      this.selectedKey = notifications[0]!.key;
    }
    return index;
  }
}

/**
 * One notification's full content plus its action menu. Sized to its hosting
 * stack: the Notifications app viewport, or the interior of the shell's
 * new-notification modal.
 */
export class SingleNotificationLayer implements Layer {
  private selectedMenuIndex = 0;
  private readonly retainedNotification: AndroidNotification | null;
  // Deliberately NO edge-detent here: this tiny action menu (Back / Reply /
  // Dismiss) wraps instantly so a swipe-up jumps straight to Dismiss to dismiss
  // fast. The detent stays on the scrollable notifications LIST above.

  constructor(
    private readonly notificationKey: string,
    private readonly options: SingleNotificationLayerOptions,
  ) {
    const captured =
      options.retainedNotification ??
      (options.origin === "new-notification-modal"
        ? readActiveNotifications(MAX_NOTIFICATIONS).find(
            (item) => item.key === notificationKey,
          )
        : undefined);
    this.retainedNotification = captured
      ? retainAndroidNotification(captured)
      : null;
  }

  paint(ctx: LayerContext, paintBelow: PaintBelow): GrayImage {
    const font = notificationFont();
    const { width, height } = ctx.stack.getBaseSize();
    const image = new GrayImage(width, height, 0);
    const notification =
      this.retainedNotification ??
      readActiveNotifications(MAX_NOTIFICATIONS).find(
        (item) => item.key === this.notificationKey,
      );

    if (
      !notification ||
      (!this.retainedNotification &&
        this.options.expectedRevision &&
        !notificationTriageController.isCurrent(
          this.notificationKey,
          this.options.expectedRevision,
        ))
    ) {
      return this.closeUnavailableNotification(ctx, paintBelow);
    }

    const menu = buildDetailMenu(notification);
    this.selectedMenuIndex = clamp(
      this.selectedMenuIndex,
      0,
      Math.max(0, menu.length - 1),
    );
    drawDetailContent(
      image,
      font,
      notification,
      iconForNotification(notification.key),
      width,
      height,
      this.options.retainedReason,
    );
    drawDetailMenu(image, font, menu, this.selectedMenuIndex, width, height);
    return image;
  }

  handleInput(event: DashboardInputEvent, ctx: LayerContext): void {
    const notification =
      this.retainedNotification ??
      readActiveNotifications(MAX_NOTIFICATIONS).find(
        (item) => item.key === this.notificationKey,
      );
    if (
      !notification ||
      (!this.retainedNotification &&
        this.options.expectedRevision &&
        !notificationTriageController.isCurrent(
          this.notificationKey,
          this.options.expectedRevision,
        ))
    ) {
      this.closeUnavailableNotification(ctx);
      return;
    }
    const menu = buildDetailMenu(notification);

    if (event.type === "double-click") {
      this.dismissAndClose(ctx);
      return;
    }
    if (event.type === "scroll-up") {
      this.selectedMenuIndex =
        (this.selectedMenuIndex - 1 + menu.length) % menu.length;
      return;
    }
    if (event.type === "scroll-down") {
      this.selectedMenuIndex = (this.selectedMenuIndex + 1) % menu.length;
      return;
    }
    if (event.type !== "click") return;

    const item = menu[this.selectedMenuIndex]!;
    if (item.kind === "back") {
      this.close(ctx);
    } else if (item.kind === "action") {
      if (item.action.hasRemoteInput) {
        // A reply/direct-input action: capture a spoken reply first, then fire
        // the action with the transcript filled into its RemoteInput.
        this.startReply(ctx, item.action);
      } else {
        invokeNotificationAction(this.notificationKey, item.action.index);
        if (
          !readActiveNotifications(MAX_NOTIFICATIONS).some(
            (item) => item.key === this.notificationKey,
          )
        ) {
          this.closeUnavailableNotification(ctx);
        }
      }
    } else if (item.kind === "dismiss") {
      this.dismissAndClose(ctx);
    }
  }

  /** Dismiss the Android notification from any detail-menu selection. */
  private dismissAndClose(ctx: LayerContext): void {
    notificationTriageController.dismiss(this.notificationKey);
    dismissNotification(this.notificationKey);
    this.closeUnavailableNotification(ctx);
  }

  /**
   * Capture a spoken reply and fire a direct-reply action with it. Reuses the
   * shell voice dialog (mic + transcription + Send/Discard menu); Send fills
   * the transcript into the action's RemoteInput on the Java side.
   */
  private startReply(
    ctx: LayerContext,
    action: AndroidNotificationAction,
  ): void {
    const key = this.notificationKey;
    const voice = new VoiceInputLayer({
      actions: ctx.actions,
      onClosed: () => {},
      dismiss: () => ctx.stack.popIfTop((top) => top === voice),
      sendTargets: [
        {
          id: "notification-reply",
          label: `Reply: ${action.title}`,
          onSend: (text: string) => {
            const reply = text.trim();
            if (!reply) return;
            invokeNotificationAction(key, action.index, reply);
            if (
              !readActiveNotifications(MAX_NOTIFICATIONS).some(
                (item) => item.key === key,
              )
            ) {
              this.closeUnavailableNotification(ctx);
            }
          },
        },
      ],
      finishOnClick: true,
    });
    ctx.stack.push(voice);
    voice.startCapture();
  }

  /** Leave the detail view, whatever hosts it. */
  private close(ctx: LayerContext): void {
    if (this.options.origin === "new-notification-modal") {
      this.options.closeModal?.(ctx);
    } else {
      ctx.stack.pop();
    }
  }

  private closeUnavailableNotification(
    ctx: LayerContext,
    paintBelow?: PaintBelow,
  ): GrayImage {
    this.close(ctx);
    const { width, height } = ctx.stack.getBaseSize();
    return paintBelow ? paintBelow() : new GrayImage(width, height, 0);
  }
}

function buildNotificationCardLayout(
  font: BdfFont,
  notification: AndroidNotification,
  selected: boolean,
  cardTextWidth: number,
): CardLayout {
  const lines: string[] = [];
  const time = formatRelativeTime(notification.postTime);
  const title = notificationTitle(notification);
  const timeSuffix = time ? `  ${time}` : "";
  lines.push(truncateText(font, `${title}${timeSuffix}`, cardTextWidth));

  const appName = notification.appName || notification.packageName;
  const body = primaryNotificationBody(notification);

  if (selected) {
    if (appName && appName !== title) {
      lines.push(truncateText(font, appName, cardTextWidth));
    }
    if (body) {
      lines.push(...wrapText(font, body, cardTextWidth).slice(0, 4));
    }
  } else if (body) {
    lines.push(
      truncateText(
        font,
        wrapText(font, body, cardTextWidth)[0]!,
        cardTextWidth,
      ),
    );
  }
  if (notification.actions.length) {
    lines.push(
      `${notification.actions.length} quick action${notification.actions.length === 1 ? "" : "s"}`,
    );
  }
  return {
    notification,
    lines,
    height: Math.max(ICON_SIZE + 18, 12 + lines.length * lineHeightFor(font)),
  };
}

function drawNotificationCard(
  image: GrayImage,
  font: BdfFont,
  layout: CardLayout,
  x: number,
  y: number,
  width: number,
  selected: boolean,
  focused: boolean,
  icon: GrayImage | null,
): void {
  // Match the shared menu highlight: faint border + black fill when
  // unselected; bright border when selected; the non-black fill only appears
  // when the app also has focus (selected-but-unfocused stays black-filled).
  if (selected) {
    drawGlassSelection(
      image,
      x,
      y,
      width,
      layout.height,
      focused,
      GLASS_RADIUS.control,
    );
  } else {
    drawGlassPanel(image, x, y, width, layout.height, {
      border: GLASS_TONE.track,
      radius: GLASS_RADIUS.control,
    });
  }
  if (icon) {
    image.bitBlt(icon, x + 10, y + 8, { transparentZero: true });
  }
  const lineHeight = lineHeightFor(font);
  for (let index = 0; index < layout.lines.length; index++) {
    const value =
      index === 0
        ? GLASS_TONE.muted
        : selected
          ? GLASS_TONE.primary
          : GLASS_TONE.secondary;
    image.drawText(
      font,
      x + CARD_TEXT_X,
      y + 7 + index * lineHeight,
      layout.lines[index]!,
      value,
    );
  }
}

function scrollForSelected(
  layouts: CardLayout[],
  selectedIndex: number,
  viewportHeight: number,
): number {
  if (selectedIndex < 0) return 0;
  let selectedTop = 0;
  for (let index = 0; index < selectedIndex; index++) {
    selectedTop += layouts[index]!.height + CARD_GAP;
  }
  const selectedBottom = selectedTop + layouts[selectedIndex]!.height;
  const contentHeight = layouts.reduce(
    (sum, layout) => sum + layout.height + CARD_GAP,
    0,
  );
  const maxScroll = Math.max(0, contentHeight - viewportHeight);
  const centered =
    selectedTop -
    Math.max(0, (viewportHeight - (selectedBottom - selectedTop)) / 2);
  return clamp(centered | 0, 0, maxScroll);
}

function drawDetailContent(
  image: GrayImage,
  font: BdfFont,
  notification: AndroidNotification,
  icon: GrayImage | null,
  width: number,
  height: number,
  retainedReason?: string,
): void {
  const contentX = DETAIL_CONTENT_X;
  const menuX = width - DETAIL_MENU_WIDTH - 24;
  const contentWidth = menuX - contentX - 20;
  image.drawText(
    font,
    PAGE_X + 12,
    PAGE_Y + 9,
    truncateText(
      font,
      `Notification · ${GESTURE_DOUBLE_CLICK} dismiss`,
      contentWidth,
    ),
    GLASS_TONE.primary,
  );
  let appLineX = contentX;
  if (icon) {
    image.bitBlt(icon, contentX, 36, { transparentZero: true });
    appLineX = contentX + ICON_SIZE + ICON_TEXT_GAP;
  }
  image.drawText(
    font,
    appLineX,
    42,
    `${notification.appName || notification.packageName}  ${formatRelativeTime(notification.postTime)}`,
    GLASS_TONE.muted,
  );

  const lines: string[] = [];
  lines.push(
    ...wrapText(font, notification.title || "(untitled)", contentWidth),
  );
  const body = detailNotificationBody(notification);
  if (body) {
    lines.push("");
    lines.push(...wrapText(font, body, contentWidth));
  }
  const meta = [
    notification.subText,
    notification.infoText,
    notification.summaryText,
  ]
    .filter(Boolean)
    .join("  ");
  if (meta) {
    lines.push("");
    lines.push(...wrapText(font, meta, contentWidth));
  }
  lines.push("");
  lines.push(
    ...wrapText(
      font,
      `Why: ${retainedReason ?? notificationTriageReason(notification.key)}`,
      contentWidth,
    ),
  );

  const lineHeight = lineHeightFor(font);
  const maxLines = Math.max(1, ((height - 64 - lineHeight) / lineHeight) | 0);
  for (let index = 0; index < Math.min(lines.length, maxLines); index++) {
    const line = lines[index]!;
    image.drawText(
      font,
      contentX,
      64 + index * lineHeight,
      line,
      index === 0 ? GLASS_TONE.primary : GLASS_TONE.body,
    );
  }
  if (lines.length > maxLines) {
    image.drawText(font, contentX, height - 24, "...", GLASS_TONE.muted);
  }
}

function drawDetailMenu(
  image: GrayImage,
  font: BdfFont,
  menu: DetailMenuItem[],
  selectedIndex: number,
  width: number,
  height: number,
  bounceY = 0,
): void {
  const menuX = width - DETAIL_MENU_WIDTH - 24;
  const layout = notificationDetailMenuLayout(
    height,
    font.lineHeight,
    menu.length,
    selectedIndex,
  );
  for (let index = layout.start; index < layout.end; index++) {
    const y = layout.menuY + bounceY + (index - layout.start) * layout.rowPitch;
    const selected = index === selectedIndex;
    if (selected) {
      drawGlassSelection(
        image,
        menuX - 8,
        y - 2,
        DETAIL_MENU_WIDTH,
        layout.highlightHeight,
        true,
        GLASS_RADIUS.selection,
      );
    }
    const leading = index === layout.start && layout.start > 0 ? "↑ " : "";
    const trailing =
      index === layout.end - 1 && layout.end < menu.length ? " ↓" : "";
    const label = truncateText(
      font,
      `${leading}${menu[index]!.label}${trailing}`,
      DETAIL_MENU_WIDTH - 12,
    );
    image.drawText(
      font,
      menuX,
      y + 2,
      label,
      selected ? GLASS_TONE.focus : GLASS_TONE.secondary,
    );
  }
}

function buildDetailMenu(notification: AndroidNotification): DetailMenuItem[] {
  return [
    { kind: "back", label: "Back" },
    ...notification.actions.map(
      (action): DetailMenuItem => ({
        kind: "action",
        label: action.enabled ? action.title : `${action.title} (unavailable)`,
        action,
      }),
    ),
    { kind: "dismiss", label: "Dismiss" },
  ];
}

function primaryNotificationBody(notification: AndroidNotification): string {
  const title = notificationTitle(notification);
  const body =
    notification.bigText ||
    notification.text ||
    notification.lines.join(" / ") ||
    notification.summaryText ||
    "";
  return body === title ? "" : body;
}

function detailNotificationBody(notification: AndroidNotification): string {
  const lines = notification.lines.length ? notification.lines.join("\n") : "";
  return [notification.bigText || notification.text, lines]
    .filter(Boolean)
    .join("\n");
}

function notificationTitle(notification: AndroidNotification): string {
  return (
    notification.title ||
    notification.text ||
    notification.summaryText ||
    notification.appName ||
    notification.packageName ||
    "(untitled)"
  );
}
