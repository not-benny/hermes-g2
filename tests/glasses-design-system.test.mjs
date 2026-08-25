import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const read = (path) =>
  readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const moduleUrl = (source) =>
  `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const withoutImports = (source) =>
  source.replace(/^import[\s\S]*?from "[^"]+";\s*/gm, "");
const transpile = (source) =>
  ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;

async function loadDesignSystem() {
  const source = withoutImports(read("app/ui/glass-design.ts"));
  const harness = `
    class GrayImage {}
    ${source}
  `;
  return import(moduleUrl(transpile(harness)));
}

async function loadNotificationCard() {
  const source = withoutImports(read("app/ui/shell/notification-card.ts"));
  const harness = `
    const small = { name: "small", lineHeight: 12, measureText: (text) => [...String(text)].length * 6 };
    const medium = { name: "medium", lineHeight: 16, measureText: (text) => [...String(text)].length * 8 };
    const large = { name: "large", lineHeight: 24, measureText: (text) => [...String(text)].length * 12 };
    const getDefaultSmallFont = () => small;
    const getDefaultMediumFont = () => medium;
    const getDefaultLargeFont = () => large;
    const truncateText = (font, text, width) => {
      const value = String(text);
      if (font.measureText(value) <= width) return value;
      const ellipsis = "...";
      const chars = Math.max(1, Math.floor((width - font.measureText(ellipsis)) /
        font.measureText("M")));
      return value.slice(0, chars) + ellipsis;
    };
    const wrapText = (font, text, width) => {
      const chars = Math.max(1, Math.floor(width / font.measureText("M")));
      return String(text).split("\\n").flatMap((line) => {
        const rows = [];
        for (let offset = 0; offset < line.length; offset += chars) rows.push(line.slice(offset, offset + chars));
        return rows.length ? rows : [""];
      });
    };
    const GESTURE_CLICK = "CLICK";
    const GESTURE_DOUBLE_CLICK = "DOUBLE";
    const notificationFontSizeSetting = { get: () => globalThis.__notificationFontSize ?? "small" };
    const GLASS_RADIUS = { selection: 6, control: 8, card: 12 };
    const GLASS_SPACE = { micro: 2, xs: 4, sm: 8, md: 12, lg: 16, xl: 24 };
    const GLASS_TONE = { opaqueBlack: 1, selectedFill: 16, track: 48, divider: 64,
      border: 96, hint: 112, muted: 144, secondary: 176, body: 208, primary: 224, focus: 255 };
    const drawGlassPanel = (image, x, y, width, height) => {
      image.fillRoundedRect(x, y, width, height, 1, 12);
      image.drawRoundedRect(x, y, width, height, 96, 12);
    };
    const G2_VISIBLE_WIDTH = 576;
    const SHELL_OPAQUE_BLACK = 1;
    const strictDeliveryMarkerGray = () => 1;
    const iconReads = [];
    let staleNotes = 0;
    const readNotificationIconByKey = (key, allowStale) => {
      iconReads.push({ key, allowStale });
      return globalThis.__notificationIconResult ?? { icon: null, stale: false };
    };
    const renderPassAllowsStaleData = () => true;
    const noteStaleDataUsed = () => { staleNotes++; };
    class GrayImage {
      constructor(width, height, fill) { this.width = width; this.height = height; this.fill = fill; this.operations = []; }
      fillRoundedRect(x, y, width, height, value, radius) { this.operations.push({ type: "fill", x, y, width, height, value, radius }); }
      drawRoundedRect(x, y, width, height, value, radius) { this.operations.push({ type: "border", x, y, width, height, value, radius }); }
      drawLine(x1, y1, x2, y2, value) { this.operations.push({ type: "line", x1, y1, x2, y2, value }); }
      drawText(font, x, y, text, value) { this.operations.push({ type: "text", font: font.name,
        lineHeight: font.lineHeight, measuredWidth: font.measureText(String(text)), x, y, text: String(text), value }); }
      bitBlt(icon, x, y, options) { this.operations.push({ type: "icon", icon, x, y, options }); }
      setPixel(x, y, value) { this.operations.push({ type: "pixel", x, y, value }); }
    }
    ${source}
    export const testEvidence = { iconReads, staleNotes: () => staleNotes };
  `;
  return import(moduleUrl(transpile(harness)));
}

function notification() {
  return {
    key: "notification-1",
    packageName: "com.whatsapp",
    appName: "WhatsApp",
    title: "Victoria",
    text: "The updated document is ready",
    bigText: "",
    subText: "",
    infoText: "",
    summaryText: "",
    category: "msg",
    channelId: "messages",
    sender: "Victoria",
    groupKey: "",
    groupSummary: false,
    importance: 4,
    clearable: true,
    lines: [],
    postTime: 1,
    when: 1,
    actions: [],
  };
}

function context() {
  return { stack: { getBaseSize: () => ({ width: 640, height: 480 }) } };
}

test("4-bit design roles remain distinct and primitives have bounded paint cost", async () => {
  const design = await loadDesignSystem();
  const toWireNibble = (value) =>
    value === 0 ? 0 : Math.min(15, (value + 8) >> 4);
  const shades = Object.values(design.GLASS_TONE).map(toWireNibble);
  assert.equal(
    new Set(shades).size,
    shades.length,
    "semantic roles must survive wire quantization",
  );
  assert.deepEqual(design.GLASS_SPACE, {
    micro: 2,
    xs: 4,
    sm: 8,
    md: 12,
    lg: 16,
    xl: 24,
  });
  assert.deepEqual(design.GLASS_RADIUS, { selection: 6, control: 8, card: 12 });

  const operations = [];
  const image = {
    fillRoundedRect: (...args) => operations.push(["fill", ...args]),
    drawRoundedRect: (...args) => operations.push(["border", ...args]),
  };
  design.drawGlassPanel(image, 1, 2, 100, 40);
  assert.equal(operations.length, 2, "a card stays at two raster operations");
  operations.length = 0;
  design.drawGlassSelection(image, 1, 2, 100, 40, true);
  assert.equal(
    operations.length,
    3,
    "focus adds only one bounded rail operation",
  );
  assert.deepEqual(operations[2].slice(0, 5), ["fill", 5, 6, 2, 32]);
  operations.length = 0;
  design.drawGlassProgress(image, 2, 3, 100, 5, 2);
  assert.equal(operations.length, 2);
  assert.equal(
    operations[1][3],
    98,
    "progress clamps at the track's inner width",
  );
});

test("heads-up notification identity stays optical while message geometry and font setting are retained", async () => {
  const module = await loadNotificationCard();
  const geometry = module.notificationCardGeometry(640);
  assert.deepEqual(geometry, {
    identityX: 36,
    identityY: 6,
    identitySize: 28,
    appTextX: 72,
    appTextWidth: 536,
    messageX: 32,
    messageWidth: 576,
    dividerY: 35,
  });
  assert.ok(
    geometry.identityX >= 32 &&
      geometry.identityX + geometry.identitySize <= 608,
    "the complete source badge reaches the wearer",
  );
  const oldVisibleWidth = Math.min(16 + (640 - 2 * 16), 608) - Math.max(16, 32);
  assert.equal(
    geometry.messageWidth,
    oldVisibleWidth,
    "adding source identity must not reduce the existing wearer-visible title/body budget",
  );
  assert.equal(
    module.notificationIdentityGlyph("WhatsApp", "com.whatsapp"),
    "W",
  );
  assert.equal(module.notificationIdentityGlyph("", "com.signal"), "S");

  globalThis.__notificationFontSize = "large";
  globalThis.__notificationIconResult = {
    icon: { width: 24, height: 24 },
    stale: false,
  };
  const payload = notification();
  payload.appName =
    "A very long notification source name that must stay within the optical band";
  payload.title =
    "A deliberately long title that proves truncation keeps every title pixel visible on the glasses";
  payload.text =
    "A deliberately long message body that wraps but never paints outside the wearer-visible band";
  const layer = new module.NotificationCardLayer({
    notification: payload,
    reason: "message",
    onOpen() {},
    onDismissed() {},
  });
  const image = layer.paint(context(), () => {
    throw new Error("opaque card must not paint below");
  });
  const icon = image.operations.find((operation) => operation.type === "icon");
  assert.deepEqual({ x: icon.x, y: icon.y }, { x: 38, y: 8 });
  const title = image.operations.find(
    (operation) => operation.type === "text" && operation.font === "large",
  );
  assert.deepEqual(
    { font: title.font, x: title.x, y: title.y },
    { font: "large", x: 32, y: 40 },
  );
  for (const text of image.operations.filter(
    (operation) => operation.type === "text",
  )) {
    assert.ok(text.x >= 32, `${text.text} starts inside the optical band`);
    assert.ok(
      text.x + text.measuredWidth <= 608,
      `${text.text} ends inside the optical band`,
    );
    assert.ok(
      text.y >= 0 && text.y + text.lineHeight <= 120,
      `${text.text} stays inside the card height`,
    );
  }
  for (const line of image.operations.filter(
    (operation) => operation.type === "line",
  )) {
    assert.ok(
      line.x1 >= 32 && line.x2 <= 607,
      "divider pixels stay inside the optical band",
    );
    assert.ok(
      line.y1 >= 0 && line.y2 < 120,
      "divider pixels stay inside the card height",
    );
  }
  assert.deepEqual(
    module.testEvidence.iconReads,
    [{ key: "notification-1", allowStale: true }],
    "first paint uses the nonblocking stale-cache path exactly once",
  );
  assert.equal(
    image.operations.length,
    9,
    "a cached source icon adds only one blit and one divider to the old seven-operation card",
  );
});

test("missing or stale Android art falls back to deterministic source identity and schedules freshness", async () => {
  const module = await loadNotificationCard();
  globalThis.__notificationFontSize = "small";
  globalThis.__notificationIconResult = { icon: null, stale: true };
  const layer = new module.NotificationCardLayer({
    notification: notification(),
    reason: "message",
    onOpen() {},
    onDismissed() {},
  });
  const image = layer.paint(context(), () => {
    throw new Error("opaque card must not paint below");
  });
  const fallback = image.operations.find(
    (operation) => operation.type === "text" && operation.text === "W",
  );
  assert.ok(
    fallback,
    "the app initial remains visible before icon cache refresh",
  );
  assert.equal(
    module.testEvidence.staleNotes(),
    1,
    "the render loop is asked for one fresh repaint",
  );
});

test("Now Playing art and all three transport controls remain in the optical raster", () => {
  const source = read("app/ui/shell/music-card.ts");
  const numberConstant = (name) => {
    const match = source.match(new RegExp(`const ${name} = (\\d+);`));
    assert.ok(match, `${name} is a literal geometry constant`);
    return Number(match[1]);
  };
  const opticalLeft = 32;
  const opticalRight = 608;
  const artX = numberConstant("ART_X");
  const art = numberConstant("ART");
  const glyph = numberConstant("GLYPH");
  assert.ok(artX >= opticalLeft && artX + art <= opticalRight);
  for (const name of ["PREV_X", "MIDDLE_X", "NEXT_X"]) {
    const x = numberConstant(name);
    assert.ok(
      x >= opticalLeft && x + glyph <= opticalRight,
      `${name} is completely wearer-visible`,
    );
  }
  assert.match(source, /const DROP_MS = GLASS_MOTION\.cardEnterMs;/);
  assert.match(source, /const RISE_MS = GLASS_MOTION\.cardExitMs;/);
});
