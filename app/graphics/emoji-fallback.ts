export type GlyphCoverage = (codePoint: number) => boolean;

type EmojiSequence = {
  end: number;
  codePoints: number[];
  hasPresentation: boolean;
  hasJoiner: boolean;
  hasModifier: boolean;
};

/**
 * Turn emoji that the monochrome BDF face cannot draw into short, meaningful
 * ASCII labels. This is deliberately done before measuring, wrapping and
 * painting so all three operations see exactly the same text.
 *
 * Text-presentation symbols already present in the selected font are kept.
 * Emoji presentation, supplementary pictographs and multi-code-point emoji
 * are normalized as a single grapheme, so variation selectors, skin tones and
 * ZWJ components can never leak through as one or more replacement boxes.
 */
export function normalizeEmojiForDisplay(
  text: string,
  hasGlyph: GlyphCoverage = () => false,
): string {
  let output = "";

  for (let offset = 0; offset < text.length; ) {
    const current = readCodePoint(text, offset);

    const keycap = readKeycapSequence(text, offset);
    if (keycap) {
      output += `[key ${keycap.key}]`;
      offset = keycap.end;
      continue;
    }

    if (isRegionalIndicator(current.codePoint)) {
      const next = readCodePoint(text, current.end);
      if (isRegionalIndicator(next.codePoint)) {
        output += `[flag ${regionalIndicatorLetter(current.codePoint)}${regionalIndicatorLetter(next.codePoint)}]`;
        offset = next.end;
      } else {
        output += "[flag]";
        offset = current.end;
      }
      continue;
    }

    if (isPresentationSelector(current.codePoint) || current.codePoint === ZERO_WIDTH_JOINER) {
      // These only select/compose an adjacent glyph and have no standalone
      // semantic content. A malformed isolated component must remain invisible
      // rather than becoming the font's default/tofu glyph.
      offset = current.end;
      continue;
    }
    if (isEmojiModifier(current.codePoint)) {
      output += "[tone]";
      offset = current.end;
      continue;
    }
    if (isEmojiTag(current.codePoint) || current.codePoint === COMBINING_KEYCAP) {
      offset = current.end;
      continue;
    }

    const sequence = readEmojiSequence(text, offset);
    if (!sequence) {
      output += current.char;
      offset = current.end;
      continue;
    }

    const needsFallback =
      sequence.hasPresentation ||
      sequence.hasJoiner ||
      sequence.hasModifier ||
      sequence.codePoints.some((codePoint) => !hasGlyph(codePoint));

    if (needsFallback) {
      output += labelEmoji(sequence.codePoints);
    } else {
      // A text-style BMP symbol may already have a crisp monochrome glyph in
      // Terminus. Keep the base(s), but never retain invisible composition
      // controls in the output passed to the BDF painter.
      output += sequence.codePoints.map((codePoint) => String.fromCodePoint(codePoint)).join("");
    }
    offset = sequence.end;
  }

  return output;
}

const ZERO_WIDTH_JOINER = 0x200d;
const VARIATION_SELECTOR_TEXT = 0xfe0e;
const VARIATION_SELECTOR_EMOJI = 0xfe0f;
const COMBINING_KEYCAP = 0x20e3;

const COMMON_LABELS = new Map<number, string>([
  [0x00a9, "(c)"],
  [0x00ae, "(R)"],
  [0x203c, "!!"],
  [0x2049, "?!"],
  [0x2122, "[TM]"],
  [0x2139, "[i]"],
  [0x2194, "<->"],
  [0x2195, "[up/down]"],
  [0x2196, "[up-left]"],
  [0x2197, "[up-right]"],
  [0x2198, "[down-right]"],
  [0x2199, "[down-left]"],
  [0x21a9, "[back]"],
  [0x21aa, "[forward]"],
  [0x231a, "[watch]"],
  [0x231b, "[wait]"],
  [0x23f0, "[alarm]"],
  [0x23f3, "[wait]"],
  [0x2600, "[sun]"],
  [0x2601, "[cloud]"],
  [0x2602, "[rain]"],
  [0x2603, "[snow]"],
  [0x260e, "[phone]"],
  [0x2611, "[checked]"],
  [0x2614, "[rain]"],
  [0x2615, "[coffee]"],
  [0x261d, "[point]"],
  [0x2620, "[danger]"],
  [0x2639, ":("],
  [0x263a, ":)"],
  [0x2665, "<3"],
  [0x267b, "[recycle]"],
  [0x2699, "[settings]"],
  [0x26a0, "[!]"],
  [0x26a1, "[power]"],
  [0x26bd, "[ball]"],
  [0x26c4, "[snowman]"],
  [0x26d4, "[no entry]"],
  [0x26f0, "[mountain]"],
  [0x26f3, "[golf]"],
  [0x26f5, "[boat]"],
  [0x26fd, "[fuel]"],
  [0x2705, "[OK]"],
  [0x2708, "[flight]"],
  [0x2709, "[mail]"],
  [0x270a, "[fist]"],
  [0x270b, "[hand]"],
  [0x270c, "[peace]"],
  [0x270d, "[write]"],
  [0x2714, "[OK]"],
  [0x2716, "[X]"],
  [0x2728, "[sparkle]"],
  [0x2744, "[snow]"],
  [0x274c, "[X]"],
  [0x274e, "[X]"],
  [0x2753, "[?]"],
  [0x2757, "[!]"],
  [0x2764, "<3"],
  [0x2795, "+"],
  [0x2796, "-"],
  [0x2797, "/"],
  [0x27a1, "[right]"],
  [0x2b05, "[left]"],
  [0x2b06, "[up]"],
  [0x2b07, "[down]"],
  [0x2b50, "[star]"],
  [0x1f308, "[rainbow]"],
  [0x1f319, "[moon]"],
  [0x1f31f, "[star]"],
  [0x1f321, "[temp]"],
  [0x1f37a, "[beer]"],
  [0x1f381, "[gift]"],
  [0x1f389, "[party]"],
  [0x1f3c3, "[running]"],
  [0x1f3e0, "[home]"],
  [0x1f3f3, "[flag]"],
  [0x1f3f4, "[flag]"],
  [0x1f440, "[eyes]"],
  [0x1f44d, "+1"],
  [0x1f44e, "-1"],
  [0x1f44f, "[clap]"],
  [0x1f4a1, "[idea]"],
  [0x1f4af, "[100]"],
  [0x1f4ac, "[msg]"],
  [0x1f4bb, "[computer]"],
  [0x1f4c5, "[date]"],
  [0x1f4cd, "[pin]"],
  [0x1f4e7, "[mail]"],
  [0x1f4f1, "[phone]"],
  [0x1f50b, "[battery]"],
  [0x1f512, "[locked]"],
  [0x1f513, "[unlocked]"],
  [0x1f514, "[bell]"],
  [0x1f525, "[fire]"],
  [0x1f527, "[tool]"],
  [0x1f534, "[red]"],
  [0x1f535, "[blue]"],
  [0x1f5d1, "[trash]"],
  [0x1f600, ":D"],
  [0x1f601, ":D"],
  [0x1f602, ":D"],
  [0x1f603, ":D"],
  [0x1f604, ":D"],
  [0x1f609, ";)"],
  [0x1f60a, ":)"],
  [0x1f610, ":|"],
  [0x1f614, ":("],
  [0x1f622, ":("],
  [0x1f62d, ":'("],
  [0x1f62e, ":o"],
  [0x1f634, "[sleep]"],
  [0x1f642, ":)"],
  [0x1f643, "(:"],
  [0x1f680, "[rocket]"],
  [0x1f697, "[car]"],
  [0x1f6a8, "[alert]"],
  [0x1f6aa, "[door]"],
  [0x1f6ab, "[no]"],
  [0x1f6b2, "[bike]"],
  [0x1f6e0, "[tools]"],
  [0x1f914, "[think]"],
  [0x1f917, "[hug]"],
  [0x1f923, ":D"],
  [0x1f973, "[party]"],
  [0x1f9d1, "[person]"],
  [0x1faab, "[low batt]"],
]);

function readCodePoint(text: string, offset: number): { codePoint: number; char: string; end: number } {
  if (offset >= text.length) return { codePoint: -1, char: "", end: offset };
  const codePoint = text.codePointAt(offset) ?? 0xfffd;
  const char = String.fromCodePoint(codePoint);
  return { codePoint, char, end: offset + char.length };
}

function readKeycapSequence(text: string, offset: number): { key: string; end: number } | undefined {
  const base = readCodePoint(text, offset);
  if (!/[0-9#*]/.test(base.char)) return undefined;
  let cursor = base.end;
  const selector = readCodePoint(text, cursor);
  if (isPresentationSelector(selector.codePoint)) cursor = selector.end;
  const keycap = readCodePoint(text, cursor);
  if (keycap.codePoint !== COMBINING_KEYCAP) return undefined;
  return { key: base.char, end: keycap.end };
}

function readEmojiSequence(text: string, offset: number): EmojiSequence | undefined {
  const first = readCodePoint(text, offset);
  if (!isEmojiBase(first.codePoint)) return undefined;

  const codePoints = [first.codePoint];
  let cursor = first.end;
  let hasPresentation = false;
  let hasJoiner = false;
  let hasModifier = false;

  const consumeDecorators = (): void => {
    let next = readCodePoint(text, cursor);
    if (isPresentationSelector(next.codePoint)) {
      hasPresentation ||= next.codePoint === VARIATION_SELECTOR_EMOJI;
      cursor = next.end;
      next = readCodePoint(text, cursor);
    }
    if (isEmojiModifier(next.codePoint)) {
      hasModifier = true;
      cursor = next.end;
    }
  };

  consumeDecorators();
  while (readCodePoint(text, cursor).codePoint === ZERO_WIDTH_JOINER) {
    const joined = readCodePoint(text, readCodePoint(text, cursor).end);
    if (!isEmojiBase(joined.codePoint)) break;
    hasJoiner = true;
    cursor = joined.end;
    codePoints.push(joined.codePoint);
    consumeDecorators();
  }

  while (isEmojiTag(readCodePoint(text, cursor).codePoint)) {
    cursor = readCodePoint(text, cursor).end;
  }
  if (readCodePoint(text, cursor).codePoint === 0xe007f) cursor = readCodePoint(text, cursor).end;

  return { end: cursor, codePoints, hasPresentation, hasJoiner, hasModifier };
}

function labelEmoji(codePoints: number[]): string {
  if (codePoints.includes(0x1f3f3) && codePoints.includes(0x1f308)) return "[pride]";
  if (codePoints.includes(0x1f3f4) && codePoints.includes(0x2620)) return "[pirate]";

  const people = codePoints.filter(isPersonEmoji).length;
  if (people > 1 || codePoints.includes(0x1f46a)) {
    return codePoints.some((codePoint) => codePoint === 0x2764 || codePoint === 0x1f48b)
      ? "[couple]"
      : "[family]";
  }

  const exact = COMMON_LABELS.get(codePoints[0]!);
  if (exact) return exact;

  const primary = codePoints[0]!;
  if (primary >= 0x1f600 && primary <= 0x1f64f) return "[face]";
  if (isPersonEmoji(primary)) return "[person]";
  if ((primary >= 0x1f400 && primary <= 0x1f43e) || (primary >= 0x1f980 && primary <= 0x1f9ae)) return "[animal]";
  if ((primary >= 0x1f32d && primary <= 0x1f37f) || (primary >= 0x1f950 && primary <= 0x1f96f)) return "[food]";
  if (primary >= 0x1f300 && primary <= 0x1f32c) return "[weather]";
  if (primary >= 0x1f380 && primary <= 0x1f3ff) return "[event]";
  if (primary >= 0x1f680 && primary <= 0x1f6ff) return "[travel]";
  if (primary >= 0x1f4a0 && primary <= 0x1f5ff) return "[item]";
  if (isBmpEmoji(primary)) return "[symbol]";
  return "[emoji]";
}

function isEmojiBase(codePoint: number): boolean {
  return isBmpEmoji(codePoint) || (codePoint >= 0x1f000 && codePoint <= 0x1faff);
}

function isBmpEmoji(codePoint: number): boolean {
  return (
    codePoint === 0x00a9 || codePoint === 0x00ae ||
    codePoint === 0x203c || codePoint === 0x2049 || codePoint === 0x2122 || codePoint === 0x2139 ||
    (codePoint >= 0x2194 && codePoint <= 0x21aa) ||
    (codePoint >= 0x231a && codePoint <= 0x23fa) ||
    codePoint === 0x24c2 ||
    (codePoint >= 0x25aa && codePoint <= 0x27bf) ||
    (codePoint >= 0x2934 && codePoint <= 0x2935) ||
    (codePoint >= 0x2b05 && codePoint <= 0x2b55) ||
    codePoint === 0x3030 || codePoint === 0x303d || codePoint === 0x3297 || codePoint === 0x3299
  );
}

function isPersonEmoji(codePoint: number): boolean {
  return (
    (codePoint >= 0x1f466 && codePoint <= 0x1f487) ||
    (codePoint >= 0x1f645 && codePoint <= 0x1f64f) ||
    (codePoint >= 0x1f6a3 && codePoint <= 0x1f6b6) ||
    (codePoint >= 0x1f9d1 && codePoint <= 0x1f9dd)
  );
}

function isRegionalIndicator(codePoint: number): boolean {
  return codePoint >= 0x1f1e6 && codePoint <= 0x1f1ff;
}

function regionalIndicatorLetter(codePoint: number): string {
  return String.fromCharCode(65 + codePoint - 0x1f1e6);
}

function isPresentationSelector(codePoint: number): boolean {
  return codePoint === VARIATION_SELECTOR_TEXT || codePoint === VARIATION_SELECTOR_EMOJI;
}

function isEmojiModifier(codePoint: number): boolean {
  return codePoint >= 0x1f3fb && codePoint <= 0x1f3ff;
}

function isEmojiTag(codePoint: number): boolean {
  return codePoint >= 0xe0020 && codePoint <= 0xe007e;
}
