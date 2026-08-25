import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const appRoot = new URL("../app/graphics/", import.meta.url);

function source(name) {
  return readFileSync(new URL(name, appRoot), "utf8").replace(/^import .*;\n/gm, "");
}

async function loadEmojiFallback() {
  const js = ts.transpileModule(source("emoji-fallback.ts"), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  return import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));
}

async function loadGraphicsPipeline() {
  const combined = [
    source("emoji-fallback.ts"),
    source("bdffont.ts"),
    source("textwrap.ts"),
    source("image.ts"),
  ].join("\n");
  const js = ts.transpileModule(combined, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  return import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));
}

function makeAsciiFont(BdfFont) {
  const glyphs = new Map();
  for (let codePoint = 32; codePoint <= 126; codePoint++) {
    glyphs.set(codePoint, {
      encoding: codePoint,
      dwidthX: 6,
      bbxWidth: 5,
      bbxHeight: 7,
      bbxX: 0,
      bbxY: 0,
      bitmapRows: codePoint === 32 ? [0, 0, 0, 0, 0, 0, 0] : [0xf8, 0x88, 0xa8, 0x88, 0xa8, 0x88, 0xf8],
    });
  }
  return new BdfFont({ ascent: 8, descent: 2, defaultChar: 63, glyphs });
}

test("emoji fallback collapses modifiers, ZWJ, flags, keycaps and presentation selectors", async () => {
  const { normalizeEmojiForDisplay } = await loadEmojiFallback();
  const raw = "Ready 👍🏽 ❤️ 👩🏽‍💻 🇬🇧 1️⃣ ✅";
  assert.equal(
    normalizeEmojiForDisplay(raw, (codePoint) => codePoint >= 32 && codePoint <= 126),
    "Ready +1 <3 [person] [flag GB] [key 1] [OK]",
  );
  assert.equal(normalizeEmojiForDisplay("👨‍👩‍👧‍👦 🏳️‍🌈", () => false), "[family] [pride]");
  assert.equal(normalizeEmojiForDisplay("👨‍🦰", () => false), "[person]");
  const englandFlag = String.fromCodePoint(0x1f3f4, 0xe0067, 0xe0062, 0xe0065, 0xe006e, 0xe0067, 0xe007f);
  assert.equal(normalizeEmojiForDisplay(englandFlag, () => false), "[flag]");
  assert.equal(normalizeEmojiForDisplay("🪿", () => false), "[emoji]");
  assert.equal(normalizeEmojiForDisplay("🏽\ufe0f\u200d", () => false), "[tone]");
});

test("available monochrome symbols stay glyphs while emoji presentation remains semantic ASCII", async () => {
  const { normalizeEmojiForDisplay } = await loadEmojiFallback();
  const covered = new Set([0x2665, 0x263a]);
  assert.equal(normalizeEmojiForDisplay("♥ ☺", (codePoint) => covered.has(codePoint)), "♥ ☺");
  assert.equal(normalizeEmojiForDisplay("♥️ ☺️", (codePoint) => covered.has(codePoint)), "<3 :)");
});

test("measure, wrap and draw share the exact normalized emoji text", async () => {
  const { BdfFont, GrayImage, wrapText } = await loadGraphicsPipeline();
  const font = makeAsciiFont(BdfFont);
  const raw = "Ping 👍🏽 from 🇬🇧 ❤️";
  const normalized = "Ping +1 from [flag GB] <3";

  assert.equal(font.textForDisplay(raw), normalized);
  assert.equal(font.measureText(raw), font.measureText(normalized));
  assert.deepEqual(wrapText(font, raw, 66, { breakLongWords: true }), wrapText(font, normalized, 66, { breakLongWords: true }));

  const rawImage = new GrayImage(240, 24, 0);
  const normalizedImage = new GrayImage(240, 24, 0);
  rawImage.drawText(font, 2, 2, raw, 255);
  normalizedImage.drawText(font, 2, 2, normalized, 255);
  assert.equal(rawImage.fingerprint(), normalizedImage.fingerprint());
  assert.ok(rawImage.to8bppBuffer().some((pixel) => pixel !== 0), "fixture should contain visible glyph pixels");
});

test("the shipped Terminus face can draw every glyph produced by an emoji notification", async () => {
  const { BdfFont, GrayImage } = await loadGraphicsPipeline();
  const bdf = readFileSync(new URL("../app/fonts/terminus/ter-u12n.bdf", import.meta.url), "utf8");
  const font = BdfFont.parse(bdf);
  const notification = "Doorbell 🚪 · Sam says 👍🏽 · ETA 5️⃣ min";
  const display = font.textForDisplay(notification);

  assert.equal(display, "Doorbell [door] · Sam says +1 · ETA [key 5] min");
  assert.ok([...display].every((char) => font.hasGlyph(char.codePointAt(0))), `unsupported fallback glyph in ${display}`);

  const image = new GrayImage(360, 20, 0);
  image.drawText(font, 2, 2, notification, 255);
  assert.ok(image.to8bppBuffer().some((pixel) => pixel !== 0), "real-font notification fixture should be visible");
});
