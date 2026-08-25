import { G2_LENS_HEIGHT, G2_LENS_WIDTH, GrayImage } from "../../graphics/image";
import { getDefaultMediumFont, getDefaultSmallFont } from "../../graphics/bdffont";
import { BATTERY_ICON_WIDTH, drawBattery } from "../../graphics/battery";
import { batteryLabelIcon, bridgeStatusIcon, drawBrightnessBadge, HEART_ICON } from "../../graphics/device-icons";
import type { AssistantBridgePhase } from "../../assistant/bridge-client";
import { readActiveNotificationIcons } from "../../native/notification-icons";
import { readPhoneBatteryState } from "../../native/phone-battery";
import { readPhoneSignalLevel } from "../../native/phone-signal";
import { noteStaleDataUsed, renderPassAllowsStaleData } from "../../util/render-freshness";
import { renderIcon, renderIconWithGlyph, type IconName } from "../../graphics/icons";
import { truncateText } from "../../graphics/textwrap";
import { batteryDisplayModeSetting, brightnessSetting, timeFormatSetting } from "../dashboard-settings";
import { Layer } from "../layers";
import { scrollToKeepSelectionVisible } from "../menu";
import { fitHudRowItemWidths, hudNotificationIconPosition, layoutHudNotifications } from "./hud-layout";
import { paintHudPixelClock } from "./hud-pixel-clock";
import {
  MIN_WINDOW_HEIGHT,
  minWindowTop,
  SHELL_OPAQUE_BLACK,
  SIDEBAR_COLUMN_WIDTH,
  SIDEBAR_COLUMNS,
  SIDEBAR_VISIBLE_COLUMNS,
  SIDEBAR_WIDTH,
  G2_VISIBLE_WIDTH,
  TOP_BAR_HEIGHT,
  windowTop,
  type WindowHeightMode,
} from "./geometry";

const ICON_SIZE = 32;
const ICON_MARGIN_X = ((SIDEBAR_COLUMN_WIDTH - ICON_SIZE) / 2) | 0;
/** The only rendered tab column, anchored against app content at x=36..71. */
const FIRST_COLUMN = SIDEBAR_COLUMNS - 1;
const ICON_SPACING = 8;
const ICON_STRIDE = ICON_SIZE + ICON_SPACING;
/** Icon list top/bottom margins within the sidebar band, below the top bar. */
const LIST_MARGIN = 10;
/** Icon rows that fit in one sidebar column. */
const ROWS_PER_COLUMN = Math.max(
  1,
  ((MIN_WINDOW_HEIGHT - TOP_BAR_HEIGHT - 2 * LIST_MARGIN + ICON_SPACING) / ICON_STRIDE) | 0,
);

/** The optically hidden x=0..35 column is never populated; tabs scroll instead. */
export function sidebarLeftColumnUsed(_windowCount: number): boolean {
  return false;
}
const NOTIFICATION_ICON_SIZE = 24;
const NOTIFICATION_ICON_GAP = 4;
const HUD_VISIBLE_GUTTER = Math.round((G2_LENS_WIDTH - G2_VISIBLE_WIDTH) / 2);
/** Right edge (exclusive) of pixels that actually reach the wearer. */
export const HUD_VISIBLE_RIGHT = G2_LENS_WIDTH - HUD_VISIBLE_GUTTER;
const HUD_CONTENT_RIGHT = HUD_VISIBLE_RIGHT - 8;
const HUD_ROW_HEIGHT = TOP_BAR_HEIGHT / 2;
const HUD_ITEM_GAP = 10;
const CLOCK_BLOCK_LEFT = SIDEBAR_WIDTH + 10;
const CLOCK_BLOCK_WIDTH = 150;
/** First x available to mirrored phone-notification icons. */
export const HUD_NOTIFICATION_LEFT = CLOCK_BLOCK_LEFT + CLOCK_BLOCK_WIDTH + 10;
const BORDER_VALUE = 40;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export type ShellChromeWindow = {
  windowId: string;
  title: string;
  attention: boolean;
  /** Draw the window's indicator icon. inverted = black-on-white (focused tab). */
  drawIcon: (image: GrayImage, x: number, y: number, size: number, inverted?: boolean) => void;
};

export type ShellChromeState = {
  windows: ShellChromeWindow[];
  selectedIndex: number;
  focus: "sidebar" | "window";
  /** The selected tab is picked up for moving (scroll moves it, tap drops). */
  reordering: boolean;
  /** Unified Window Management mode: select/close or pick/move the tab. */
  closing: boolean;
  /** Action a Window Management tap performs for the selected sidebar item. */
  closingAction: "close" | "hide" | "pinned";
  /** Whether a second hold can pick the selected card up for moving. */
  managementCanMove: boolean;
  /** A configured R1 remains represented even before a battery reply arrives. */
  ringConfigured: boolean;
  /** While reordering, whether the picked-up tab can still move up / down. */
  reorderCanMoveUp: boolean;
  reorderCanMoveDown: boolean;
  /** Height mode of the foreground window; decides where its top bar sits. */
  foregroundHeightMode: WindowHeightMode;
  /** Vertical bounce offset for the sidebar tab list when stopped at an end. */
  sidebarBounceY: number;
  /** Ring heart rate (bpm) for the HUD; null renders the heart with "--". */
  ringHeartRate: number | null;
  battery: {
    headset: number | null;
    headsetCharging: boolean | null;
    ring: number | null;
    ringCharging: boolean | null;
  };
  /** App-provided persistent tray state, packed after essential top-row data. */
  trayIcons: GrayImage[];
  /**
   * Explicit Hermes gateway identity/state badge. External mode shows it even
   * before a host is configured, so a missing setup is visible rather than
   * silently indistinguishable from the on-phone backend.
   */
  bridge: {
    show: boolean;
    /** An external backend was selected but may still need a host configured. */
    configured: boolean;
    phase: AssistantBridgePhase;
  };
};

type HudItem = {
  image: GrayImage;
};

type BatteryKind = "phone" | "glasses" | "ring";
type BatteryHudState = {
  kind: BatteryKind;
  percent: number | null;
  charging: boolean;
};

/** Placeholder window icon: rounded outline with a single letter. */
export function makeLetterWindowIcon(letter: string): ShellChromeWindow["drawIcon"] {
  return (image, x, y, size, inverted) => {
    const font = getDefaultMediumFont();
    if (!inverted) {
      image.drawRoundedRect(x, y, size, size, 120, 6);
    }
    const textX = x + Math.max(0, ((size - font.measureText(letter)) / 2) | 0);
    const textY = y + Math.max(0, ((size - font.lineHeight) / 2) | 0);
    image.drawText(font, textX, textY, letter, inverted ? SHELL_OPAQUE_BLACK : 210);
  };
}

/** Window icon rendered from an SVG (Lucide), rendered once per size and cached. */
export function makeSvgWindowIcon(name: IconName, glyph?: string): ShellChromeWindow["drawIcon"] {
  return (image, x, y, size, inverted) => {
    const icon = glyph ? renderIconWithGlyph(name, glyph, size) : renderIcon(name, size);
    if (!icon) return;
    const dx = x + Math.max(0, ((size - icon.width) / 2) | 0);
    const dy = y + Math.max(0, ((size - icon.height) / 2) | 0);
    if (!inverted) {
      image.bitBlt(icon, dx, dy, { transparentZero: true });
      return;
    }
    // Invert onto a white background: coverage becomes darkness. Full coverage
    // maps to SHELL_OPAQUE_BLACK (1) rather than 0, since 0 is the surface's
    // transparent color key.
    for (let row = 0; row < icon.height; row++) {
      for (let col = 0; col < icon.width; col++) {
        const coverage = icon.pixels[row * icon.width + col] ?? 0;
        if (coverage > 0) {
          image.setPixel(dx + col, dy + row, Math.max(SHELL_OPAQUE_BLACK, 255 - coverage));
        }
      }
    }
  };
}

/** SVG icon when a name is given, else the letter placeholder. */
export function windowIcon(icon: IconName | undefined, letter: string, glyph?: string): ShellChromeWindow["drawIcon"] {
  return icon ? makeSvgWindowIcon(icon, glyph) : makeLetterWindowIcon(letter);
}

/**
 * Base layer of the shell surface: the window sidebar on the left and the
 * status top bar. Everything not explicitly painted stays 0 (transparent on
 * the color-key shell surface), so the app viewport shows through.
 */
export class ShellChromeLayer implements Layer {
  // First sidebar row shown; adjusted each paint to keep the selection visible.
  private scrollRow = 0;

  constructor(private readonly getState: () => ShellChromeState) {}

  paint(): GrayImage {
    const image = new GrayImage(G2_LENS_WIDTH, G2_LENS_HEIGHT, 0);
    const state = this.getState();
    this.drawSidebar(image, state);
    this.drawTopBar(image, state);
    return image;
  }

  handleInput(): void {
    // Shell input is handled by the shell state machine before it reaches the
    // layer stack; the chrome itself never consumes events.
  }

  private drawSidebar(image: GrayImage, state: ShellChromeState): void {
    // The sidebar always occupies the min-height window band at the preferred
    // vertical position: it never moves when the foreground window's height
    // changes, and it lines up exactly with a min-height window's chrome.
    const bandTop = minWindowTop();
    const bandBottom = bandTop + MIN_WINDOW_HEIGHT;
    image.fillRect(0, bandTop, SIDEBAR_WIDTH, MIN_WINDOW_HEIGHT, SHELL_OPAQUE_BLACK);

    // Scroll a single optically visible icon column. The logical left column
    // is almost entirely outside x=32..607, so it must never receive tabs.
    // Chevrons mark windows off-screen above/below.
    const listTop = bandTop + TOP_BAR_HEIGHT + LIST_MARGIN + state.sidebarBounceY;
    const itemStride = ICON_STRIDE;
    const rowsPerColumn = ROWS_PER_COLUMN;
    const visibleCount = rowsPerColumn * SIDEBAR_VISIBLE_COLUMNS;
    const count = state.windows.length;
    this.scrollRow = scrollToKeepSelectionVisible(this.scrollRow, state.selectedIndex, visibleCount, count);
    const lastVisible = Math.min(count, this.scrollRow + visibleCount);
    const slotOf = (index: number) => {
      const position = index - this.scrollRow;
      return {
        column: FIRST_COLUMN,
        y: listTop + position * itemStride,
      };
    };

    // The selection is a "diversion" of the sidebar/main separator line: the
    // line bulges right around the selected icon (rounded on the left, open
    // to the main area on the right), so the separator is drawn with a gap
    // there. When the sidebar has focus, the diversion is filled white and
    // the icon drawn inverted.
    const sep = SIDEBAR_WIDTH - 1;
    const selVisible = state.selectedIndex >= this.scrollRow && state.selectedIndex < lastVisible;
    const selSlot = selVisible ? slotOf(state.selectedIndex) : null;
    const selTabTop = selSlot ? selSlot.y - 2 : null;
    if (selTabTop !== null) {
      image.drawLine(sep, bandTop, sep, selTabTop, BORDER_VALUE);
      image.drawLine(sep, selTabTop + ICON_SIZE + 4, sep, bandBottom - 1, BORDER_VALUE);
    } else {
      image.drawLine(sep, bandTop, sep, bandBottom - 1, BORDER_VALUE);
    }

    for (let index = this.scrollRow; index < lastVisible; index++) {
      const window = state.windows[index]!;
      const { column, y } = slotOf(index);
      const columnLeft = column * SIDEBAR_COLUMN_WIDTH;
      const x = columnLeft + ICON_MARGIN_X;
      const selected = index === state.selectedIndex;
      const focused = selected && state.focus === "sidebar";
      if (selected) {
        drawSelectionTab(image, columnLeft, y - 2, y + ICON_SIZE + 2, focused);
      }
      window.drawIcon(image, x, y, ICON_SIZE, focused);
      if (window.attention) {
        // Black dot on the white focused tab, white dot otherwise.
        image.fillRoundedRect(x + ICON_SIZE - 7, y - 1, 8, 8, focused ? SHELL_OPAQUE_BLACK : 255, 4);
      }
    }

    if (this.scrollRow > 0) {
      drawChevron(image, SIDEBAR_WIDTH - SIDEBAR_COLUMN_WIDTH / 2, bandTop + TOP_BAR_HEIGHT + 6, -1);
    }
    if (lastVisible < count) {
      drawChevron(image, SIDEBAR_WIDTH - SIDEBAR_COLUMN_WIDTH / 2, bandBottom - 6, 1);
    }

    // Reorder affordance: the picked-up tab (always the selected one) shows
    // movement chevrons hugging the separator gap above/below it, so grab mode
    // reads distinctly from normal selection and points where a scroll moves it.
    if (state.reordering && selTabTop !== null) {
      const markX = sep - 3;
      if (state.reorderCanMoveUp) {
        drawChevron(image, markX, selTabTop - 1, -1);
      }
      if (state.reorderCanMoveDown) {
        drawChevron(image, markX, selTabTop + ICON_SIZE + 5, 1);
      }
    }

    // Window Management marker: high-contrast action graphics make the mode
    // legible even when the 56px top-bar copy is outside the optical sweet
    // spot. X=close, a down-chevron=hide, a lock=protected/pinned, and the
    // existing paired chevrons=move.
    if (state.closing && selSlot) {
      const cx = selSlot.column * SIDEBAR_COLUMN_WIDTH + ICON_MARGIN_X + (ICON_SIZE >> 1);
      const cy = selSlot.y + (ICON_SIZE >> 1);
      const glyphRadius = 8;
      // Focused management tabs are white, so reserve a black badge before
      // drawing the white glyph; otherwise the close marker disappears into
      // the selected card fill.
      image.fillRoundedRect(cx - 12, cy - 12, 24, 24, SHELL_OPAQUE_BLACK, 4);
      if (state.reordering) {
        // Keep a redundant move glyph inside the badge. The outer chevrons
        // communicate available direction; this double arrow identifies the
        // selected card as picked up even when it cannot move farther.
        drawChevron(image, cx, cy - 4, -1, 255);
        drawChevron(image, cx, cy + 4, 1, 255);
        drawChevron(image, cx, selSlot.y - 2, -1, 255);
        drawChevron(image, cx, selSlot.y + ICON_SIZE + 3, 1, 255);
      } else if (state.closingAction === "close") {
        for (const dx of [0, 1, 2]) {
          image.drawLine(cx - glyphRadius + dx, cy - glyphRadius, cx + glyphRadius + dx, cy + glyphRadius, 255);
          image.drawLine(cx - glyphRadius + dx, cy + glyphRadius, cx + glyphRadius + dx, cy - glyphRadius, 255);
        }
      } else if (state.closingAction === "hide") {
        image.drawLine(cx - glyphRadius + 2, cy, cx + glyphRadius - 2, cy, 255);
        drawChevron(image, cx, cy + 3, 1, 255);
      } else {
        image.drawRect(cx - 6, cy - 4, 12, 10, 255);
        image.drawLine(cx - 3, cy - 4, cx - 3, cy - 8, 255);
        image.drawLine(cx + 3, cy - 4, cx + 3, cy - 8, 255);
      }
    }
  }

  private drawTopBar(image: GrayImage, state: ShellChromeState): void {
    // The bar sits at the top edge of the foreground window: the screen top
    // for a max-height window, the min-height band otherwise. It moves when
    // the foreground switches to a window of a different height.
    const barTop = windowTop(state.foregroundHeightMode);
    image.fillRect(SIDEBAR_WIDTH, barTop, G2_LENS_WIDTH - SIDEBAR_WIDTH, TOP_BAR_HEIGHT, SHELL_OPAQUE_BLACK);
    image.drawLine(SIDEBAR_WIDTH, barTop + TOP_BAR_HEIGHT - 1, G2_LENS_WIDTH - 1, barTop + TOP_BAR_HEIGHT - 1, BORDER_VALUE);

    if (state.closing) {
      const titleFont = getDefaultMediumFont();
      const hintFont = getDefaultSmallFont();
      const selectedTitle = state.windows[state.selectedIndex]?.title ?? "window";
      const action = state.reordering
        ? "UP/DN move   TAP drop"
        : state.closingAction === "hide"
          ? "HIDE   UP/DN choose   TAP hide"
          : state.closingAction === "pinned"
            ? "PINNED   UP/DN choose"
            : state.managementCanMove
              ? "UP/DN choose   TAP close   HOLD move"
              : "UP/DN choose   TAP close";
      // Two-line high-contrast banner: the mode is always explicit, while the
      // selected title/action explains what the next ring gesture will do.
      image.drawText(titleFont, SIDEBAR_WIDTH + 10, barTop + 5, "WINDOW MANAGEMENT", 255);
      image.drawText(
        hintFont,
        SIDEBAR_WIDTH + 10,
        barTop + 5 + titleFont.lineHeight + 2,
        truncateText(
          hintFont,
          `${selectedTitle} · ${action} · DBL exit`,
          HUD_CONTENT_RIGHT - (SIDEBAR_WIDTH + 10),
        ),
        235,
      );
      return;
    }

    const now = new Date();
    const clockRight = drawPixelClock(image, now, barTop);
    const persistentLeft = this.drawPersistentHud(image, state, barTop);

    // A full-height rule gives phone notifications their own bounded region;
    // they can no longer drift under heart-rate, radio, brightness, Hermes, or
    // battery indicators when either side grows.
    const notificationLayout = layoutHudNotifications({
      clockRight,
      preferredNotificationLeft: HUD_NOTIFICATION_LEFT,
      persistentLeft,
      visibleRight: HUD_VISIBLE_RIGHT,
      iconSize: NOTIFICATION_ICON_SIZE,
      iconGap: NOTIFICATION_ICON_GAP,
    });
    const { separatorX } = notificationLayout;
    image.drawLine(separatorX, barTop + 5, separatorX, barTop + TOP_BAR_HEIGHT - 7, 95);
    image.drawLine(separatorX + 1, barTop + 9, separatorX + 1, barTop + TOP_BAR_HEIGHT - 11, 35);

    const maxIcons = notificationLayout.maxIcons;
    if (maxIcons > 0) {
      const { icons, stale } = readActiveNotificationIcons(maxIcons, renderPassAllowsStaleData());
      if (stale) {
        noteStaleDataUsed();
      }
      for (let index = 0; index < icons.length; index++) {
        const position = hudNotificationIconPosition(notificationLayout, index, {
          barTop,
          rowHeight: HUD_ROW_HEIGHT,
          iconSize: NOTIFICATION_ICON_SIZE,
          iconGap: NOTIFICATION_ICON_GAP,
        });
        if (!position) break;
        image.bitBlt(icons[index]!, position.x, position.y, {
          transparentZero: true,
        });
      }
    }
  }

  /**
   * Persistent HUD data, packed into two independent right-aligned rows. The
   * top row carries environment/link state; the bottom row carries live body
   * and battery state. Returns the leftmost painted x so the caller can place
   * the hard phone-notification divider without either region overlapping.
   */
  private drawPersistentHud(image: GrayImage, state: ShellChromeState, barTop: number): number {
    const font = getDefaultSmallFont();
    const percentageMode = batteryDisplayModeSetting.get() === "percentage";
    const items: BatteryHudState[] = [];
    const phone = readPhoneBatteryState();
    if (phone.battery !== null && Number.isFinite(phone.battery)) {
      items.push({ kind: "phone", percent: phone.battery, charging: Boolean(phone.charging) });
    }
    if (state.battery.headset !== null && Number.isFinite(state.battery.headset)) {
      items.push({ kind: "glasses", percent: state.battery.headset, charging: Boolean(state.battery.headsetCharging) });
    }
    if (state.ringConfigured) {
      const ringPercent = state.battery.ring !== null && Number.isFinite(state.battery.ring)
        ? state.battery.ring
        : null;
      items.push({ kind: "ring", percent: ringPercent, charging: Boolean(state.battery.ringCharging) });
    }

    const topRow: HudItem[] = [];
    if (state.bridge.show) {
      topRow.push({ image: makeBridgeHudItem(font, state.bridge) });
    }
    const signalLevel = readPhoneSignalLevel();
    if (signalLevel !== null) {
      const signal = new GrayImage(22, 14, 0);
      drawPhoneSignalBars(signal, signalLevel, 0, 0);
      topRow.push({ image: signal });
    }
    const brightness = brightnessSetting.get();
    const badge = drawBrightnessBadge(font, brightness === "auto" ? "A" : brightness);
    topRow.push({ image: badge });
    // App-owned tray state belongs with persistent data, never in the mirrored
    // phone-notification region. It is lowest priority if the row is saturated.
    for (let index = state.trayIcons.length - 1; index >= 0; index--) {
      topRow.push({ image: state.trayIcons[index]! });
    }

    const hr = state.ringHeartRate;
    const bpmText = hr !== null && Number.isFinite(hr) ? String(Math.max(0, Math.min(255, Math.round(hr)))) : "--";
    const bottomRow: HudItem[] = [{ image: makeHeartRateHudItem(font, bpmText) }];
    // Glasses state is the most relevant battery datum on the glasses, then
    // ring and phone. Heart rate remains first so overflow never drops it.
    for (const kind of ["glasses", "ring", "phone"] as const) {
      const item = items.find((candidate) => candidate.kind === kind);
      if (item) bottomRow.push({ image: makeBatteryHudItem(font, item, percentageMode) });
    }

    // Leave at least one phone-icon column between the clock and persistent
    // data. Essential items are ordered first; only surplus tray icons can be
    // omitted if an app attempts to overfill the optical raster.
    const rowMinLeft = HUD_NOTIFICATION_LEFT + NOTIFICATION_ICON_SIZE + 16;
    const topLeft = drawHudRow(image, topRow, HUD_CONTENT_RIGHT, barTop, rowMinLeft);
    const bottomLeft = drawHudRow(image, bottomRow, HUD_CONTENT_RIGHT, barTop + HUD_ROW_HEIGHT, rowMinLeft);
    return Math.min(topLeft, bottomLeft);
  }
}

/** Four ascending cellular bars; inactive bars remain faint so zero is visible. */
function drawPhoneSignalBars(image: GrayImage, level: number, x: number, y: number): void {
  const bounded = Math.max(0, Math.min(4, Math.round(level)));
  for (let index = 0; index < 4; index++) {
    const height = 4 + index * 3;
    const value = index < bounded ? 210 : 45;
    image.fillRect(x + index * 6, y + 14 - height, 4, height, value);
  }
}

/** Make one self-contained battery datum so row packing is overlap-proof. */
function makeBatteryHudItem(font: ReturnType<typeof getDefaultSmallFont>, item: BatteryHudState,
  percentageMode: boolean): GrayImage {
  const percentText = item.percent === null ? "--" : `${Math.max(0, Math.min(100, Math.round(item.percent)))}%`;
  const valueWidth = percentageMode || item.percent === null ? font.measureText(percentText) : BATTERY_ICON_WIDTH;
  const labelIcon = batteryLabelIcon(item.kind);
  const labelGap = 5;
  const height = Math.max(font.lineHeight + 2, labelIcon.height, 16);
  const image = new GrayImage(labelIcon.width + labelGap + valueWidth, height, 0);
  image.bitBlt(labelIcon, 0, Math.max(0, ((height - labelIcon.height) / 2) | 0), { transparentZero: true });
  const valueX = labelIcon.width + labelGap;
  if (percentageMode || item.percent === null) {
    const textY = Math.max(0, ((height - font.lineHeight) / 2) | 0);
    if (item.charging) {
      image.fillRect(valueX - 2, textY - 1, valueWidth + 4, font.lineHeight + 2, 255);
      image.drawText(font, valueX, textY, percentText, SHELL_OPAQUE_BLACK);
    } else {
      image.drawText(font, valueX, textY, percentText, 200);
    }
  } else {
    const gauge = drawBattery(item.percent, item.charging);
    image.bitBlt(gauge, valueX, Math.max(0, ((height - gauge.height) / 2) | 0), { transparentZero: true });
  }
  return image;
}

function makeHeartRateHudItem(font: ReturnType<typeof getDefaultSmallFont>, bpmText: string): GrayImage {
  const gap = 5;
  const height = Math.max(font.lineHeight, HEART_ICON.height);
  const image = new GrayImage(HEART_ICON.width + gap + font.measureText(bpmText), height, 0);
  image.bitBlt(HEART_ICON, 0, Math.max(0, ((height - HEART_ICON.height) / 2) | 0), { transparentZero: true });
  image.drawText(font, HEART_ICON.width + gap, Math.max(0, ((height - font.lineHeight) / 2) | 0), bpmText, 200);
  return image;
}

/** Explicit copy makes both identity and link state readable without decoding a glyph. */
function bridgeHudLabel(bridge: ShellChromeState["bridge"]): string {
  if (!bridge.configured) return "HERMES GATEWAY SETUP";
  switch (bridge.phase) {
    case "connected": return "HERMES GATEWAY ONLINE";
    case "connecting": return "HERMES GATEWAY CONNECTING";
    case "failed": return "HERMES GATEWAY ERROR";
    case "idle": return "HERMES GATEWAY OFFLINE";
  }
}

function makeBridgeHudItem(font: ReturnType<typeof getDefaultSmallFont>, bridge: ShellChromeState["bridge"]): GrayImage {
  const label = bridgeHudLabel(bridge);
  const glyph = bridgeStatusIcon(bridge.configured ? bridge.phase : "idle");
  const padX = 4;
  const gap = 4;
  const height = Math.max(18, font.lineHeight + 4, glyph.height + 4);
  const width = padX * 2 + glyph.width + gap + font.measureText(label);
  const image = new GrayImage(width, height, 0);
  const stroke = !bridge.configured ? 90 : bridge.phase === "connected" ? 210 : bridge.phase === "failed" ? 170 : 90;
  image.drawRoundedRect(0, 0, width, height, stroke, 4);
  image.bitBlt(glyph, padX, Math.max(0, ((height - glyph.height) / 2) | 0), { transparentZero: true });
  image.drawText(font, padX + glyph.width + gap, Math.max(0, ((height - font.lineHeight) / 2) | 0), label, 205);
  return image;
}

/** Draw priority-ordered items from right to left inside one optical HUD row. */
function drawHudRow(image: GrayImage, items: readonly HudItem[], rightEdge: number, rowTop: number,
  minLeft: number): number {
  const fitted = fitHudRowItemWidths(items.map((item) => item.image.width), rightEdge, minLeft, HUD_ITEM_GAP);
  let leftmost = rightEdge;
  for (const { index, x } of fitted) {
    const item = items[index]!;
    const y = rowTop + Math.max(0, ((HUD_ROW_HEIGHT - item.image.height) / 2) | 0);
    image.bitBlt(item.image, x, y, { transparentZero: true });
    leftmost = x;
  }
  return leftmost;
}

const TAB_RADIUS = 6;
// How far the diversion pokes past the separator into the main area.
const TAB_EXTEND = 1;
const TAB_STROKE = 150;

/**
 * Draw the selection "diversion" of the separator line around a sidebar icon
 * in the rightmost column: rounded on the left, square and open on the right,
 * extending a few px past the separator into the main area. Focused = filled
 * white; otherwise an outline. `left` is the column's left edge, which the
 * rounded corners curve in from.
 */
function drawSelectionTab(image: GrayImage, left: number, top: number, bottom: number, focused: boolean): void {
  const right = SIDEBAR_WIDTH - 1 + TAB_EXTEND;
  if (focused) {
    for (let yy = top; yy < bottom; yy++) {
      const x = left + tabLeftInset(yy, top, bottom, TAB_RADIUS);
      image.fillRect(x, yy, right - x + 1, 1, 255);
    }
    return;
  }
  // Outline: curved left edge (per-row) plus straight top and bottom edges.
  for (let yy = top; yy < bottom; yy++) {
    image.setPixel(left + tabLeftInset(yy, top, bottom, TAB_RADIUS), yy, TAB_STROKE);
  }
  image.drawLine(left + tabLeftInset(top, top, bottom-1, TAB_RADIUS), top, right, top, TAB_STROKE);
  image.drawLine(left + tabLeftInset(bottom-1, top, bottom-1, TAB_RADIUS), bottom-1, right, bottom-1, TAB_STROKE);
}

/** Left boundary x of the tab at row yy: 0 in the middle, curving to the rounded left corners. */
function tabLeftInset(yy: number, top: number, bottom: number, radius: number): number {
  const cy = yy + 0.5;
  let dy = 0;
  if (cy < top + radius) {
    dy = top + radius - cy;
  } else if (cy > bottom - radius) {
    dy = cy - (bottom - radius);
  } else {
    return 0;
  }
  return Math.max(0, Math.round(radius - Math.sqrt(Math.max(0, radius * radius - dy * dy))));
}

/** Large time over a small date: one visual block spanning both HUD rows. */
function drawPixelClock(image: GrayImage, now: Date, barTop: number): number {
  const time = formatClockTime(now).toUpperCase();
  const date = `${WEEKDAYS[now.getDay()]} ${now.getDate()} ${MONTHS[now.getMonth()]}`.toUpperCase();
  return paintHudPixelClock(image, {
    left: CLOCK_BLOCK_LEFT,
    width: CLOCK_BLOCK_WIDTH,
    barTop,
    time,
    date,
  });
}

/** Format the top-bar clock time, honoring the 12/24-hour setting. */
function formatClockTime(now: Date): string {
  const minutes = String(now.getMinutes()).padStart(2, "0");
  const hour24 = now.getHours();
  if (timeFormatSetting.get() === "12h") {
    const hour12 = ((hour24 + 11) % 12) + 1;
    return `${hour12}:${minutes} ${hour24 < 12 ? "AM" : "PM"}`;
  }
  return `${hour24}:${minutes}`;
}

/** Small triangle marker for sidebar overflow; direction -1 = up, 1 = down. */
function drawChevron(
  image: GrayImage,
  centerX: number,
  y: number,
  direction: -1 | 1,
  value = 140,
): void {
  const half = 5;
  const tipY = direction < 0 ? y - 3 : y + 3;
  image.drawLine(centerX - half, y, centerX, tipY, value);
  image.drawLine(centerX, tipY, centerX + half, y, value);
}
