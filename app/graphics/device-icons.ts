import type { AssistantBridgePhase } from "../assistant/bridge-client";
import { BdfFont } from "./bdffont";
import { GrayImage, imageFromAsciiArt } from "./image";

// Small monochrome glyphs for the top-bar status area: device labels for the
// battery indicators (phone / glasses / ring) and the auto-brightness sun.
// Drawn at roughly the battery icon's scale so they line up in either 28px HUD row.
// In imageFromAsciiArt, '#' is filled and ' '/'.' is transparent.

// Match the muted brightness the text labels used, so the icons read as labels
// rather than out-shouting the battery gauge beside them.
const LABEL_VALUE = 150;
// The brightness badge is a filled sun; a high value keeps the knocked-out
// digits high-contrast against the bright disc.
const BRIGHTNESS_VALUE = 200;
// A live bridge link reads brightest (emphasis); dialling / failed states are
// muted so a healthy connection is the one that stands out on the bar.
const BRIDGE_LIVE_VALUE = 210;
// 12 is even, so the 8px glyph ink centres exactly (2px disc margin each side).
const SUN_DISC_HEIGHT = 12;
const SUN_RAY_LENGTH = 2;
const SUN_RAY_GAP = 1;
// Glyph ink spans rows 2..9 of the 12px cell — its centre is 5.5px below the
// text's top-left, which is what we align to the disc centre.
const SUN_GLYPH_INK_CENTER = 5.5;

/** Portrait smartphone outline with a home dot. */
export const PHONE_ICON = imageFromAsciiArt(
  [
    "#######",
    "#.....#",
    "#.....#",
    "#.....#",
    "#.....#",
    "#.....#",
    "#.....#",
    "#.....#",
    "#.....#",
    "#.....#",
    "#..#..#",
    "#######",
  ],
  LABEL_VALUE,
);

/** Spectacles: two lenses joined by a bridge. */
export const GLASSES_ICON = imageFromAsciiArt(
  [
    ".##...##.",
    "#..#.#..#",
    "#..#.#..#",
    "#..###..#",
    "#..#.#..#",
    "#..#.#..#",
    ".##...##.",
  ],
  LABEL_VALUE,
);

/** Finger ring: a plain circular band. */
export const RING_ICON = imageFromAsciiArt(
  [
    "..###..",
    ".#...#.",
    "#.....#",
    "#.....#",
    "#.....#",
    ".#...#.",
    "..###..",
  ],
  LABEL_VALUE,
);

/** Heart-rate label: a small filled heart, drawn beside the live bpm value. */
export const HEART_ICON = imageFromAsciiArt(
  [
    ".##.##.",
    "#######",
    "#######",
    ".#####.",
    "..###..",
    "...#...",
  ],
  LABEL_VALUE,
);

/**
 * Brightness badge: a small sun (a rounded body with eight rays) with text in
 * the middle — the level percentage when a fixed brightness is set, or "A"
 * when the ambient sensor drives it. The body grows to fit the content, so 1–3
 * digits ("0".."100") and the "A" all read cleanly. The firmware never reports
 * the ambient-selected level back, which is why auto shows "A" rather than a
 * live number.
 */
export function drawBrightnessBadge(font: BdfFont, content: string): GrayImage {
  const textW = font.measureText(content);
  const discH = SUN_DISC_HEIGHT;
  const discW = Math.max(discH, textW + 4);
  const margin = SUN_RAY_LENGTH + SUN_RAY_GAP + 1;

  const image = new GrayImage(discW + margin * 2, discH + margin * 2, 0);
  const discX = margin;
  const discY = margin;
  // A solid sun disc (a hollow ring reads as a target, per testing).
  image.fillRoundedRect(discX, discY, discW, discH, BRIGHTNESS_VALUE, (discH / 2) | 0);

  // Eight rays hugging the disc edge (its bounding ellipse), so they radiate
  // evenly whether the body is a circle ("A", one digit) or a pill ("100").
  const cx = discX + discW / 2 - 0.5;
  const cy = discY + discH / 2 - 0.5;
  const halfW = discW / 2;
  const halfH = discH / 2;
  const s = Math.SQRT1_2;
  const dirs = [
    [0, -1], [0, 1], [1, 0], [-1, 0],
    [s, -s], [-s, -s], [s, s], [-s, s],
  ];
  for (const [ux, uy] of dirs) {
    const edgeX = cx + ux * halfW;
    const edgeY = cy + uy * halfH;
    for (let i = 1; i <= SUN_RAY_LENGTH; i++) {
      image.setPixel(Math.round(edgeX + ux * (SUN_RAY_GAP + i)), Math.round(edgeY + uy * (SUN_RAY_GAP + i)), BRIGHTNESS_VALUE);
    }
  }

  // Knock the text out of the disc (value 0 → transparent when blitted), so it
  // reads as a dark number/letter on the bright sun. Vertically centre the
  // glyph ink (rows 2..9 of the 12px cell), not the full line box.
  const textX = discX + Math.round((discW - textW) / 2);
  const textY = Math.round(discY + (discH - 1) / 2 - SUN_GLYPH_INK_CENTER);
  image.drawText(font, textX, textY, content, 0);
  return image;
}

/**
 * Hermes Agent bridge status: a small broadcast tower whose signal is encoded
 * by fill rather than motion (the HUD frame is static). Connected shows both
 * uplink arcs at full brightness; connecting drops the outer arc and dims, so
 * it reads as a weaker/pending link; idle and failed drop both arcs and cut a
 * diagonal slash through the tower — a plainly broken/off link.
 */
export function bridgeStatusIcon(phase: AssistantBridgePhase): GrayImage {
  switch (phase) {
    case "connected":
      return imageFromAsciiArt(
        [
          "#.......#",
          ".#.....#.",
          "..#...#..",
          "...#.#...",
          "....#....",
          "....#....",
          "....#....",
          "....#....",
          "...#.#...",
          "..#...#..",
          ".#.....#.",
        ],
        BRIDGE_LIVE_VALUE,
      );
    case "connecting":
      return imageFromAsciiArt(
        [
          ".........",
          ".........",
          "..#...#..",
          "...#.#...",
          "....#....",
          "....#....",
          "....#....",
          "....#....",
          "...#.#...",
          "..#...#..",
          ".#.....#.",
        ],
        LABEL_VALUE,
      );
    case "idle":
    case "failed":
      return imageFromAsciiArt(
        [
          "........#",
          ".......#.",
          "......#..",
          "......#..",
          "....##...",
          "....#....",
          "...##....",
          "..#.#....",
          "..##.#...",
          ".##...#..",
          "##.....#.",
        ],
        LABEL_VALUE,
      );
  }
}

export function batteryLabelIcon(kind: "phone" | "glasses" | "ring"): GrayImage {
  switch (kind) {
    case "phone":
      return PHONE_ICON;
    case "glasses":
      return GLASSES_ICON;
    case "ring":
      return RING_ICON;
  }
}
