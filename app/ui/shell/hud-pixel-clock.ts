export type PixelFillSurface = {
  fillRect: (x: number, y: number, width: number, height: number, value: number) => void;
};

/** Compact, deliberately blocky alphabet for the two-storey clock. */
const PIXEL_GLYPHS: Readonly<Record<string, string>> = {
  " ": "00/00/00/00/00",
  ":": "0/1/0/1/0",
  "?": "110/001/010/000/010",
  "0": "111/101/101/101/111",
  "1": "010/110/010/010/111",
  "2": "110/001/111/100/111",
  "3": "110/001/111/001/110",
  "4": "101/101/111/001/001",
  "5": "111/100/110/001/110",
  "6": "011/100/111/101/111",
  "7": "111/001/010/010/010",
  "8": "111/101/111/101/111",
  "9": "111/101/111/001/110",
  "A": "010/101/111/101/101",
  "B": "110/101/110/101/110",
  "C": "011/100/100/100/011",
  "D": "110/101/101/101/110",
  "E": "111/100/110/100/111",
  "F": "111/100/110/100/100",
  "G": "011/100/101/101/011",
  "H": "101/101/111/101/101",
  "I": "111/010/010/010/111",
  "J": "001/001/001/101/010",
  "K": "101/101/110/101/101",
  "L": "100/100/100/100/111",
  "M": "10001/11011/10101/10101/10101",
  "N": "1001/1101/1011/1001/1001",
  "O": "010/101/101/101/010",
  "P": "110/101/110/100/100",
  "Q": "010/101/101/011/001",
  "R": "110/101/110/101/101",
  "S": "011/100/010/001/110",
  "T": "111/010/010/010/010",
  "U": "101/101/101/101/111",
  "V": "101/101/101/101/010",
  "W": "10101/10101/10101/11011/10001",
  "X": "101/101/010/101/101",
  "Y": "101/101/010/010/010",
  "Z": "111/001/010/100/111",
};

function pixelGlyphRows(char: string): string[] {
  return (PIXEL_GLYPHS[char] ?? PIXEL_GLYPHS["?"]!).split("/");
}

export function measureHudPixelText(text: string, scale: number): number {
  let width = 0;
  for (const char of text.toUpperCase()) {
    width += pixelGlyphRows(char)[0]!.length * scale + scale;
  }
  return Math.max(0, width - scale);
}

function drawPixelText(surface: PixelFillSurface, x: number, y: number, text: string, scale: number,
  value: number): void {
  let cursor = x;
  for (const char of text.toUpperCase()) {
    const rows = pixelGlyphRows(char);
    for (let row = 0; row < rows.length; row++) {
      const pattern = rows[row]!;
      for (let column = 0; column < pattern.length; column++) {
        if (pattern[column] === "1") {
          surface.fillRect(cursor + column * scale, y + row * scale, scale, scale, value);
        }
      }
    }
    cursor += (rows[0]!.length + 1) * scale;
  }
}

/** Paint large time over small date as one block spanning both 28px HUD rows. */
export function paintHudPixelClock(surface: PixelFillSurface, args: {
  left: number;
  width: number;
  barTop: number;
  time: string;
  date: string;
}): number {
  let timeScale = 5;
  while (timeScale > 3 && measureHudPixelText(args.time, timeScale) > args.width) timeScale--;
  const timeWidth = measureHudPixelText(args.time, timeScale);
  const dateScale = 2;
  const dateWidth = measureHudPixelText(args.date, dateScale);
  drawPixelText(surface, args.left + Math.max(0, ((args.width - timeWidth) / 2) | 0),
    args.barTop + 6, args.time, timeScale, 235);
  drawPixelText(surface, args.left + Math.max(0, ((args.width - dateWidth) / 2) | 0),
    args.barTop + 39, args.date, dateScale, 150);
  return args.left + args.width;
}
