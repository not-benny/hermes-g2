import { G2_LENS_HEIGHT, G2_LENS_WIDTH, GrayImage } from "../../graphics/image";
import { getDefaultMediumFont, getDefaultSmallFont } from "../../graphics/bdffont";
import { BATTERY_ICON_WIDTH, drawBattery } from "../../graphics/battery";
import { batteryLabelIcon, bridgeStatusIcon, drawBrightnessBadge, HEART_ICON } from "../../graphics/device-icons";
import type { AssistantBridgePhase } from "../../assistant/bridge-client";
import { readActiveNotificationIcons } from "../../native/notification-icons";
import { readPhoneBatteryState } from "../../native/phone-battery";
import { noteStaleDataUsed, renderPassAllowsStaleData } from "../../util/render-freshness";
import { renderIcon, renderIconWithGlyph, type IconName } from "../../graphics/icons";
import { batteryDisplayModeSetting, brightnessSetting, timeFormatSetting } from "../dashboard-settings";
import { Layer } from "../layers";
import { scrollToKeepSelectionVisible } from "../menu";
import {
  MIN_WINDOW_HEIGHT,
  minWindowTop,
  SHELL_OPAQUE_BLACK,
  SIDEBAR_COLUMN_WIDTH,
  SIDEBAR_COLUMNS,
  SIDEBAR_WIDTH,
  TOP_BAR_HEIGHT,
  windowTop,
  type WindowHeightMode,
} from "./geometry";

const ICON_SIZE = 32;
const ICON_MARGIN_X = ((SIDEBAR_COLUMN_WIDTH - ICON_SIZE) / 2) | 0;
/** Column index of the rightmost sidebar column (the one that fills first). */
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

/**
 * Whether the sidebar's left (overflow) column holds any icons. Icons fill
 * the right column first; scrolling never shows fewer than a full right
 * column, so the left column is populated exactly when there are more
 * windows than one column holds.
 */
export function sidebarLeftColumnUsed(windowCount: number): boolean {
  return windowCount > ROWS_PER_COLUMN;
}
const NOTIFICATION_ICON_SIZE = 24;
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
  /** The selected tab is picked up for reordering (scroll moves it, tap drops). */
  reordering: boolean;
  /** Quick-close mode: the selected card shows a close marker; a tap closes it. */
  closing: boolean;
  /** While reordering, whether the picked-up tab can still move up / down. */
  reorderCanMoveUp: boolean;
  reorderCanMoveDown: boolean;
  /** Height mode of the foreground window; decides where its top bar sits. */
  foregroundHeightMode: WindowHeightMode;
  /** Vertical bounce offset for the sidebar tab list when stopped at an end. */
  sidebarBounceY: number;
  /** Ring heart rate (bpm) for the HUD, null hides the readout entirely. */
  ringHeartRate: number | null;
  battery: {
    headset: number | null;
    headsetCharging: boolean | null;
    ring: number | null;
    ringCharging: boolean | null;
  };
  /** App-provided tray images, drawn between notification icons and batteries. */
  trayIcons: GrayImage[];
  /**
   * Hermes Agent bridge status glyph, just left of the brightness badge. Only
   * meaningful (and only drawn) when the external backend is selected and a
   * bridge host is configured; `show` gates the glyph and its spacing.
   */
  bridge: {
    show: boolean;
    phase: AssistantBridgePhase;
  };
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

    // Scroll the icon list to keep the selection visible; chevrons mark
    // windows off-screen above/below. Icons fill the right column top to
    // bottom, then overflow into the left one, so a visible slot's column is
    // decided by its position within the scrolled window.
    const listTop = bandTop + TOP_BAR_HEIGHT + LIST_MARGIN + state.sidebarBounceY;
    const itemStride = ICON_STRIDE;
    const rowsPerColumn = ROWS_PER_COLUMN;
    const visibleCount = rowsPerColumn * SIDEBAR_COLUMNS;
    const count = state.windows.length;
    this.scrollRow = scrollToKeepSelectionVisible(this.scrollRow, state.selectedIndex, visibleCount, count);
    const lastVisible = Math.min(count, this.scrollRow + visibleCount);
    const slotOf = (index: number) => {
      const position = index - this.scrollRow;
      const columnsFromRight = (position / rowsPerColumn) | 0;
      return {
        column: FIRST_COLUMN - columnsFromRight,
        y: listTop + (position % rowsPerColumn) * itemStride,
      };
    };

    // The selection is a "diversion" of the sidebar/main separator line: the
    // line bulges right around the selected icon (rounded on the left, open
    // to the main area on the right), so the separator is drawn with a gap
    // there. When the sidebar has focus, the diversion is filled white and
    // the icon drawn inverted. Only the right column touches the separator;
    // a selected overflow icon gets a self-contained box instead.
    const sep = SIDEBAR_WIDTH - 1;
    const selVisible = state.selectedIndex >= this.scrollRow && state.selectedIndex < lastVisible;
    const selSlot = selVisible ? slotOf(state.selectedIndex) : null;
    const selTabTop = selSlot && selSlot.column === FIRST_COLUMN ? selSlot.y - 2 : null;
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
      if (selected && column === FIRST_COLUMN) {
        drawSelectionTab(image, columnLeft, y - 2, y + ICON_SIZE + 2, focused);
      } else if (selected) {
        // Spans the full column: only 2px of margin flanks a 32px icon in a
        // 36px column, so anything wider would clip at the screen edge.
        drawSelectionBox(image, columnLeft, y - 2, SIDEBAR_COLUMN_WIDTH, ICON_SIZE + 4, focused);
      }
      window.drawIcon(image, x, y, ICON_SIZE, focused);
      if (window.attention) {
        // Black dot on the white focused tab, white dot otherwise.
        image.fillRoundedRect(x + ICON_SIZE - 7, y - 1, 8, 8, focused ? SHELL_OPAQUE_BLACK : 255, 4);
      }
    }

    if (this.scrollRow > 0) {
      drawChevron(image, SIDEBAR_WIDTH / 2, bandTop + TOP_BAR_HEIGHT + 6, -1);
    }
    if (lastVisible < count) {
      drawChevron(image, SIDEBAR_WIDTH / 2, bandBottom - 6, 1);
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

    // Quick-close mode: a bold X over the selected card signals a tap closes it.
    if (state.closing && selSlot) {
      const cx = selSlot.column * SIDEBAR_COLUMN_WIDTH + ICON_MARGIN_X + (ICON_SIZE >> 1);
      const cy = selSlot.y + (ICON_SIZE >> 1);
      const r = (ICON_SIZE >> 1) - 1;
      for (const dx of [0, 1]) {
        image.drawLine(cx - r + dx, cy - r, cx + r + dx, cy + r, 255);
        image.drawLine(cx - r + dx, cy + r, cx + r + dx, cy - r, 255);
      }
    }
  }

  private drawTopBar(image: GrayImage, state: ShellChromeState): void {
    const font = getDefaultMediumFont();
    // The bar sits at the top edge of the foreground window: the screen top
    // for a max-height window, the min-height band otherwise. It moves when
    // the foreground switches to a window of a different height.
    const barTop = windowTop(state.foregroundHeightMode);
    image.fillRect(SIDEBAR_WIDTH, barTop, G2_LENS_WIDTH - SIDEBAR_WIDTH, TOP_BAR_HEIGHT, SHELL_OPAQUE_BLACK);
    image.drawLine(SIDEBAR_WIDTH, barTop + TOP_BAR_HEIGHT - 1, G2_LENS_WIDTH - 1, barTop + TOP_BAR_HEIGHT - 1, BORDER_VALUE);

    const now = new Date();
    const clock = `${WEEKDAYS[now.getDay()]} ${now.getDate()} ${MONTHS[now.getMonth()]} ` +
      formatClockTime(now);
    const clockX = SIDEBAR_WIDTH + 10;
    const textY = barTop + Math.max(0, ((TOP_BAR_HEIGHT - font.lineHeight) / 2) | 0);
    image.drawText(font, clockX, textY, clock, 210);

    const batteryLeft = this.drawTopBarBatteries(image, state, barTop);
    const trayLeft = drawTrayIcons(image, state.trayIcons, batteryLeft, barTop);

    const iconsX = clockX + font.measureText(clock) + 16;
    const maxIcons = Math.max(0, ((trayLeft - 8 - iconsX) / (NOTIFICATION_ICON_SIZE + 4)) | 0);
    if (maxIcons > 0) {
      const { icons, stale } = readActiveNotificationIcons(maxIcons, renderPassAllowsStaleData());
      if (stale) {
        noteStaleDataUsed();
      }
      const iconY = barTop + (((TOP_BAR_HEIGHT - NOTIFICATION_ICON_SIZE) / 2) | 0);
      for (let index = 0; index < icons.length; index++) {
        image.bitBlt(icons[index]!, iconsX + index * (NOTIFICATION_ICON_SIZE + 4), iconY, {
          transparentZero: true,
        });
      }
    }
  }

  /**
   * Battery indicators for the phone, the G2 and the ring, right-aligned in
   * the top bar, following the dashboard card's icon/percentage setting. Each
   * gauge is labelled with a small device glyph (phone / glasses / ring). A
   * brightness sun sits just left of the block: it holds the level percentage
   * when a fixed brightness is set, or "A" when the ambient sensor drives it.
   * Returns the left edge of the block.
   */
  private drawTopBarBatteries(image: GrayImage, state: ShellChromeState, barTop: number): number {
    const font = getDefaultSmallFont();
    const percentageMode = batteryDisplayModeSetting.get() === "percentage";
    type BatteryKind = "phone" | "glasses" | "ring";
    type BatteryItem = { kind: BatteryKind; percent: number; charging: boolean };
    const items: BatteryItem[] = [];
    const phone = readPhoneBatteryState();
    if (phone.battery !== null && Number.isFinite(phone.battery)) {
      items.push({ kind: "phone", percent: phone.battery, charging: Boolean(phone.charging) });
    }
    if (state.battery.headset !== null && Number.isFinite(state.battery.headset)) {
      items.push({ kind: "glasses", percent: state.battery.headset, charging: Boolean(state.battery.headsetCharging) });
    }
    if (state.battery.ring !== null && Number.isFinite(state.battery.ring)) {
      items.push({ kind: "ring", percent: state.battery.ring, charging: Boolean(state.battery.ringCharging) });
    }

    const centerY = (height: number) => barTop + Math.max(0, ((TOP_BAR_HEIGHT - height) / 2) | 0);
    const labelGap = 5;
    const itemGap = 12;
    const textY = barTop + Math.max(0, ((TOP_BAR_HEIGHT - font.lineHeight) / 2) | 0);
    let x = G2_LENS_WIDTH - 8;
    for (let index = items.length - 1; index >= 0; index--) {
      const item = items[index]!;
      const percentText = `${Math.max(0, Math.min(100, Math.round(item.percent)))}%`;
      const valueWidth = percentageMode ? font.measureText(percentText) : BATTERY_ICON_WIDTH;
      const labelIcon = batteryLabelIcon(item.kind);
      x -= labelIcon.width + labelGap + valueWidth;
      image.bitBlt(labelIcon, x, centerY(labelIcon.height), { transparentZero: true });
      const valueX = x + labelIcon.width + labelGap;
      if (percentageMode) {
        if (item.charging) {
          // Inverted text marks charging, matching the dashboard card.
          image.fillRect(valueX - 2, textY - 1, valueWidth + 4, font.lineHeight + 2, 255);
          image.drawText(font, valueX, textY, percentText, 1);
        } else {
          image.drawText(font, valueX, textY, percentText, 200);
        }
      } else {
        const icon = drawBattery(item.percent, item.charging);
        image.bitBlt(icon, valueX, centerY(icon.height), { transparentZero: true });
      }
      x -= itemGap;
    }
    let leftEdge = items.length ? x + itemGap : G2_LENS_WIDTH;

    // Brightness sun, just left of the battery block: the level percentage for
    // a fixed brightness, or "A" when the ambient sensor is driving it.
    const brightness = brightnessSetting.get();
    const badge = drawBrightnessBadge(font, brightness === "auto" ? "A" : brightness);
    const badgeGap = items.length ? 10 : 8;
    leftEdge -= badgeGap + badge.width;
    image.bitBlt(badge, leftEdge, centerY(badge.height), { transparentZero: true });

    // Hermes Agent bridge status, just left of the brightness sun, matching its
    // spacing. Drawn only when the external backend is configured; otherwise no
    // glyph and no reserved gap.
    if (state.bridge.show) {
      const bridge = bridgeStatusIcon(state.bridge.phase);
      leftEdge -= 10 + bridge.width;
      image.bitBlt(bridge, leftEdge, centerY(bridge.height), { transparentZero: true });
    }

    // Ring heart rate, leftmost in the block: a small heart plus the live bpm,
    // shown only once the ring has synced a reading.
    if (state.ringHeartRate !== null && Number.isFinite(state.ringHeartRate)) {
      const bpmText = String(Math.max(0, Math.min(255, Math.round(state.ringHeartRate))));
      leftEdge -= 10 + HEART_ICON.width + labelGap + font.measureText(bpmText);
      image.bitBlt(HEART_ICON, leftEdge, centerY(HEART_ICON.height), { transparentZero: true });
      image.drawText(font, leftEdge + HEART_ICON.width + labelGap, textY, bpmText, 200);
    }
    return leftEdge;
  }
}

/**
 * Draw app tray icons right-to-left, ending just left of the battery block;
 * returns the left edge of the tray region.
 */
function drawTrayIcons(image: GrayImage, trayIcons: GrayImage[], rightEdge: number, barTop: number): number {
  let x = rightEdge;
  for (let index = trayIcons.length - 1; index >= 0; index--) {
    const icon = trayIcons[index]!;
    x -= icon.width + 10;
    image.bitBlt(icon, x, barTop + Math.max(0, ((TOP_BAR_HEIGHT - icon.height) / 2) | 0), {
      transparentZero: true,
    });
  }
  return x;
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

/**
 * Selection marker for an overflow-column icon, which has no separator to
 * divert: a self-contained rounded box, filled white when the sidebar has
 * focus and outlined otherwise (matching the tab's two states).
 */
function drawSelectionBox(image: GrayImage, x: number, y: number, width: number, height: number, focused: boolean): void {
  if (focused) {
    image.fillRoundedRect(x, y, width, height, 255, TAB_RADIUS);
  } else {
    image.drawRoundedRect(x, y, width, height, TAB_STROKE, TAB_RADIUS);
  }
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
function drawChevron(image: GrayImage, centerX: number, y: number, direction: -1 | 1): void {
  const half = 5;
  const tipY = direction < 0 ? y - 3 : y + 3;
  image.drawLine(centerX - half, y, centerX, tipY, 140);
  image.drawLine(centerX, tipY, centerX + half, y, 140);
}
