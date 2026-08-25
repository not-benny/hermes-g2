import { GrayImage } from "./image";

declare const com: any;
declare const global: any;

/**
 * Vector icons for window indicators (and anywhere else). SVGs are rendered
 * once to a correctly sized grayscale bitmap by the Java IconRenderer (a
 * small SVG subset: path/circle/rect/line/polyline) and cached here. To add
 * an icon, drop its SVG source into ICON_SVGS — Lucide icons
 * (https://lucide.dev, stroked, 24px viewBox) work as-is; simple single-color
 * Noun Project glyphs also work.
 */

// Stroke width in viewBox units (Lucide's default is 2).
const ICON_STROKE_WIDTH = 2;

// Lucide icons (MIT/ISC licensed). Kept verbatim so they can be diffed
// against upstream if an icon needs updating.
export const ICON_SVGS = {
  search:
    '<svg viewBox="0 0 24 24" fill="none"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>',
  "layout-grid":
    '<svg viewBox="0 0 24 24" fill="none"><rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="14" y="3" rx="1"/><rect width="7" height="7" x="14" y="14" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/></svg>',
  // Not a Lucide icon: compact "+1" mark for the Local Counter sample.
  "plus-one":
    '<svg viewBox="0 0 24 24" fill="none"><path d="M3 10h8M7 6v8"/><path d="m15 8 2-2v12"/><path d="M14 18h6"/></svg>',
  timer:
    '<svg viewBox="0 0 24 24" fill="none"><line x1="10" x2="14" y1="2" y2="2"/><line x1="12" x2="15" y1="14" y2="11"/><circle cx="12" cy="14" r="8"/></svg>',
  clock:
    '<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  // Not a Lucide icon: an L-tetromino built from four squares, for Blocks.
  "l-piece":
    '<svg viewBox="0 0 24 24" fill="none"><rect width="6" height="6" x="5" y="1.5" rx="1"/><rect width="6" height="6" x="5" y="9" rx="1"/><rect width="6" height="6" x="5" y="16.5" rx="1"/><rect width="6" height="6" x="12.5" y="16.5" rx="1"/></svg>',
  bomb:
    '<svg viewBox="0 0 24 24" fill="none"><circle cx="11" cy="13" r="9"/><path d="M14.35 4.65 16.3 2.7a2.41 2.41 0 0 1 3.4 0l1.6 1.6a2.4 2.4 0 0 1 0 3.4l-1.95 1.95"/><path d="m22 2-1.5 1.5"/></svg>',
  // Not a Lucide icon: a ball above two angled flippers, for Pinball.
  pinball:
    '<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="6" r="3"/><path d="M4 14l7 5"/><path d="M20 14l-7 5"/><circle cx="4" cy="14" r="1"/><circle cx="20" cy="14" r="1"/></svg>',
  spade:
    '<svg viewBox="0 0 24 24" fill="none"><path d="M12 18v4"/><path d="M2 14.499a5.5 5.5 0 0 0 9.591 3.675.6.6 0 0 1 .818.001A5.5 5.5 0 0 0 22 14.5c0-2.29-1.5-4-3-5.5l-5.492-5.312a2 2 0 0 0-3-.02L5 8.999c-1.5 1.5-3 3.2-3 5.5"/></svg>',
  terminal:
    '<svg viewBox="0 0 24 24" fill="none"><path d="m7 11 2-2-2-2"/><path d="M11 13h4"/><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/></svg>',
  // A dedicated Hermes mark. Keep this visually distinct from the terminal
  // chevron: Cockpit is a structured agent surface, not a command shell.
  "hermes-h":
    '<svg viewBox="0 0 24 24" fill="none"><path d="M6 4v16"/><path d="M18 4v16"/><path d="M6 12h12"/></svg>',
  "file-text":
    '<svg viewBox="0 0 24 24" fill="none"><path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"/><path d="M14 2v5a1 1 0 0 0 1 1h5"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/></svg>',
  file:
    '<svg viewBox="0 0 24 24" fill="none"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/></svg>',
  folder:
    '<svg viewBox="0 0 24 24" fill="none"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>',
  // The same Lucide folder shape without fill="none", so the renderer fills
  // it: launcher folders use this to read differently from the Files app.
  "folder-filled":
    '<svg viewBox="0 0 24 24"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>',
  image:
    '<svg viewBox="0 0 24 24" fill="none"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg>',
  film:
    '<svg viewBox="0 0 24 24" fill="none"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M7 3v18"/><path d="M3 7.5h4"/><path d="M3 12h18"/><path d="M3 16.5h4"/><path d="M17 3v18"/><path d="M21 7.5h-4"/><path d="M21 16.5h-4"/></svg>',
  "hard-drive":
    '<svg viewBox="0 0 24 24" fill="none"><line x1="22" x2="2" y1="12" y2="12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/><line x1="6" x2="6.01" y1="16" y2="16"/><line x1="10" x2="10.01" y1="16" y2="16"/></svg>',
  music:
    '<svg viewBox="0 0 24 24" fill="none"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>',
  activity:
    '<svg viewBox="0 0 24 24" fill="none"><path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2"/></svg>',
  bell:
    '<svg viewBox="0 0 24 24" fill="none"><path d="M10.268 21a2 2 0 0 0 3.464 0"/><path d="M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326"/></svg>',
  calendar:
    '<svg viewBox="0 0 24 24" fill="none"><path d="M8 2v4"/><path d="M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/></svg>',
  "list-checks":
    '<svg viewBox="0 0 24 24" fill="none"><path d="m3 7 2 2 4-4"/><path d="M11 7h10"/><path d="m3 17 2 2 4-4"/><path d="M11 17h10"/></svg>',
  "cloud-sun":
    '<svg viewBox="0 0 24 24" fill="none"><path d="M12 2v2"/><path d="m4.93 4.93 1.42 1.42"/><path d="M20 12h2"/><path d="m19.07 4.93-1.42 1.42"/><path d="M15.947 12.65a4 4 0 0 0-5.925-4.128"/><path d="M13 22H7a5 5 0 1 1 4.9-6H13a3 3 0 0 1 0 6Z"/></svg>',
  "flask-conical":
    '<svg viewBox="0 0 24 24" fill="none"><path d="M14 2v6a2 2 0 0 0 .245.96l5.51 10.08A2 2 0 0 1 18 22H6a2 2 0 0 1-1.755-2.96l5.51-10.08A2 2 0 0 0 10 8V2"/><path d="M6.453 15h11.094"/><path d="M8.5 2h7"/></svg>',
  settings:
    '<svg viewBox="0 0 24 24" fill="none"><path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915"/><circle cx="12" cy="12" r="3"/></svg>',
  mic:
    '<svg viewBox="0 0 24 24" fill="none"><path d="M12 19v3"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><rect x="9" y="2" width="6" height="13" rx="3"/></svg>',
  "message-square":
    '<svg viewBox="0 0 24 24" fill="none"><path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z"/><path d="M8 9h8"/><path d="M8 13h5"/></svg>',
  map:
    '<svg viewBox="0 0 24 24" fill="none"><path d="M14.106 5.553a2 2 0 0 0 1.788 0l3.659-1.83A1 1 0 0 1 21 4.619v12.764a1 1 0 0 1-.553.894l-4.553 2.277a2 2 0 0 1-1.788 0l-4.212-2.106a2 2 0 0 0-1.788 0l-3.659 1.83A1 1 0 0 1 3 19.381V6.618a1 1 0 0 1 .553-.894l4.553-2.277a2 2 0 0 1 1.788 0z"/><path d="M15 5.764v15"/><path d="M9 3.236v15"/></svg>',
  compass:
    '<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10"/><path d="m16.24 7.76-2.12 6.36-6.36 2.12 2.12-6.36z"/></svg>',
} as const;

export type IconName = keyof typeof ICON_SVGS;

// The "_" element of the terminal icon, swapped out for a session glyph in
// renderIconWithGlyph.
const TERMINAL_UNDERSCORE = '<path d="M11 13h4"/>';

/**
 * Session-marker glyphs for per-terminal window icons: the terminal icon's
 * "_" replaced by a character, drawn in the same stroked style. Hand-fitted
 * to the box x 11.5–16.5, y 8–16 beside the ">" chevron. The zero is slashed
 * to keep it distinct from the letter O.
 */
const TERMINAL_GLYPH_SHAPES: Record<string, string> = {
  "0": '<ellipse cx="14" cy="12" rx="2.5" ry="4"/><path d="m13 13.6 2-3.2"/>',
  "1": '<path d="m12.5 9.5 1.5-1.5v8"/><path d="M12.5 16h3"/>',
  "2": '<path d="M11.8 9.8a2.3 2.3 0 0 1 4.5.6c0 2.5-4.6 3-4.6 5.6h4.8"/>',
  "3": '<path d="M12 8h2.2a2 2 0 0 1 0 4H13h1.2a2 2 0 0 1 0 4H12"/>',
  "4": '<path d="M15.5 16V8l-4 5.2h5"/>',
  "5": '<path d="M16.2 8h-4.2v3.4h2.2a2.3 2.3 0 0 1 0 4.6H12"/>',
  "6": '<path d="M15.8 8a5.6 5.6 0 0 0-3.8 5.5"/><circle cx="14" cy="13.7" r="2.3"/>',
  "7": '<path d="M11.8 8h4.7l-3.4 8"/>',
  "8": '<circle cx="14" cy="9.9" r="1.9"/><circle cx="14" cy="13.9" r="2.1"/>',
  "9": '<circle cx="14" cy="10.3" r="2.3"/><path d="M12.2 16a5.6 5.6 0 0 0 3.8-5.5"/>',
  A: '<path d="M11.5 16 14 8l2.5 8"/><path d="M12.6 13h2.8"/>',
  B: '<path d="M12 16V8h1.8a2 2 0 0 1 0 4H12h2a2 2 0 0 1 0 4z"/>',
  C: '<path d="M16.4 9.6a3.2 4.3 0 1 0 0 4.8"/>',
  D: '<path d="M12 8h1a3.4 4 0 0 1 0 8h-1z"/>',
  E: '<path d="M16.3 8H12v8h4.3"/><path d="M12 12h3.4"/>',
  F: '<path d="M16.3 8H12v8"/><path d="M12 12h3.4"/>',
  G: '<path d="M16.4 9.6a3.2 4.3 0 1 0 .1 4.9"/><path d="M16.5 14.5V12h-2.3"/>',
  H: '<path d="M12 8v8"/><path d="M16.3 8v8"/><path d="M12 12h4.3"/>',
  I: '<path d="M12.7 8h2.9"/><path d="M14.1 8v8"/><path d="M12.7 16h2.9"/>',
  J: '<path d="M16 8v5.8a2.1 2.1 0 0 1-4.2 0"/>',
  K: '<path d="M12 8v8"/><path d="m16.3 8-4.3 4 4.3 4"/>',
  L: '<path d="M12 8v8h4.3"/>',
  M: '<path d="M11.6 16V8l2.4 4.5L16.4 8v8"/>',
  N: '<path d="M12 16V8l4.3 8V8"/>',
  O: '<ellipse cx="14" cy="12" rx="2.5" ry="4"/>',
  P: '<path d="M12 16V8h2a2.2 2.2 0 0 1 0 4.4h-2"/>',
  Q: '<ellipse cx="14" cy="12" rx="2.5" ry="4"/><path d="m15 13.8 1.6 2.2"/>',
  R: '<path d="M12 16V8h2a2.2 2.2 0 0 1 0 4.4h-2"/><path d="m14.4 12.4 2 3.6"/>',
  S: '<path d="M16.2 9a2.7 2.7 0 0 0-4.3 2c.3 2.3 4.4.7 4.3 3a2.7 2.7 0 0 1-4.4 1.2"/>',
  T: '<path d="M11.7 8h4.6"/><path d="M14 8v8"/>',
  U: '<path d="M12 8v5.8a2.15 2.15 0 0 0 4.3 0V8"/>',
  V: '<path d="m11.6 8 2.4 8 2.4-8"/>',
  W: '<path d="m11.5 8 1 8 1.5-4.6L15.5 16l1-8"/>',
  X: '<path d="m11.8 8 4.4 8"/><path d="m16.2 8-4.4 8"/>',
  Y: '<path d="m11.8 8 2.2 4.2L16.2 8"/><path d="M14 12.2V16"/>',
  Z: '<path d="M11.8 8h4.4l-4.4 8h4.4"/>',
};

/** Characters usable as terminal-icon glyphs, in allocation order (1-9 first, 0 as the tenth). */
export const TERMINAL_ICON_GLYPHS = "1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ";

const cache = new Map<string, GrayImage | null>();

/** Render an icon SVG to a size×size grayscale bitmap, rendered once and cached. */
export function renderIcon(name: IconName, size: number): GrayImage | null {
  return renderSvgCached(name, ICON_SVGS[name], size);
}

/**
 * Render an icon with a glyph character substituted in — currently only the
 * terminal icon, whose "_" becomes the glyph (">3" instead of ">_"). Falls
 * back to the plain icon for other names or unsupported characters.
 */
export function renderIconWithGlyph(name: IconName, glyph: string, size: number): GrayImage | null {
  const shape = name === "terminal" ? TERMINAL_GLYPH_SHAPES[glyph] : undefined;
  if (!shape) return renderIcon(name, size);
  return renderSvgCached(`${name}[${glyph}]`, ICON_SVGS.terminal.replace(TERMINAL_UNDERSCORE, shape), size);
}

function renderSvgCached(cacheName: string, svg: string, size: number): GrayImage | null {
  const key = `${cacheName}:${size}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  let icon: GrayImage | null = null;
  if (global.isAndroid) {
    try {
      const bytes = com.faceclaw.app.IconRenderer.renderSvgGray(svg, Math.round(size), ICON_STROKE_WIDTH);
      if (bytes && bytes.length >= size * size) {
        icon = new GrayImage(size, size, 0);
        for (let i = 0; i < size * size; i++) {
          icon.pixels[i] = bytes[i] & 0xff;
        }
      }
    } catch (error) {
      console.warn(`renderIcon(${cacheName}) failed: ${error}`);
    }
  }
  cache.set(key, icon);
  return icon;
}
