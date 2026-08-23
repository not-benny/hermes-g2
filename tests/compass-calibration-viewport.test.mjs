import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const dataUrl = (source) => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const fontStub = dataUrl(`
const font = { lineHeight: 12, measureText: (text) => String(text).length * 6 };
export const getDefaultLargeFont = () => font;
export const getDefaultMediumFont = () => font;
export const getDefaultSmallFont = () => font;
`);
const imageStub = dataUrl(`
export class GrayImage {
  constructor(width, height) { this.width = width; this.height = height; this.text = []; }
  drawText(_font, x, y, text) { this.text.push({ x, y, text: String(text) }); }
  drawLine() {}
  fillRect() {}
  setPixel() {}
}
`);
const motionStub = dataUrl(`export const glassesMotionService = {};`);
const layerStub = dataUrl(`
export class YieldAtRootLayer { constructor(layer) { this.layer = layer; } }
export const createInProcessWindow = () => ({ requestRender() {} });
`);
const shellStub = dataUrl(`export const shell = { isWindowVisible: () => true };`);

const source = readFileSync(new URL("../app/apps/compass/compass-app.ts", import.meta.url), "utf8");
let js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
}).outputText;
for (const [from, to] of [
  ["../../graphics/bdffont", fontStub],
  ["../../graphics/image", imageStub],
  ["../../native/glasses-motion-service", motionStub],
  ["../../ui/layers", dataUrl("export {};\n")],
  ["../../ui/shell/in-process-window", layerStub],
  ["../../ui/shell/shell", shellStub],
]) js = js.replaceAll(`"${from}"`, JSON.stringify(to));
const { CompassLayer } = await import(dataUrl(js));

const collectingSnapshot = {
  state: "live",
  headingDegrees: 188,
  compassQuality: "calibrating",
  calibrationQuality: "uncalibrated",
  acceptedSamples: 54,
  rejectedSamples: 0,
  localCalibration: {
    status: "collecting", headingSamples: 18, neutralSamples: 8, headingSectors: 5, reason: null,
  },
};

test("compass local-calibration action and progress fit the real 576x288 G2 viewport", () => {
  const calls = [];
  const service = {
    acquire() { throw new Error("not used by viewport test"); },
    snapshot: () => collectingSnapshot,
    startLocalCalibration() { calls.push("start"); return true; },
    cancelLocalCalibration() { calls.push("cancel"); return true; },
  };
  const layer = new CompassLayer(() => {}, service);
  layer.onMotion(collectingSnapshot);
  const image = layer.paint({ stack: { getBaseSize: () => ({ width: 576, height: 288 }) } });
  const labels = image.text.map((entry) => entry.text);

  assert.ok(labels.some((text) => /slowly turn full circle/i.test(text)));
  assert.ok(labels.some((text) => /18\/24 headings.*8\/8 level.*5\/6 sectors/i.test(text)));
  assert.ok(labels.some((text) => /click: cancel local calibration/i.test(text)));
  assert.ok(image.text.every(({ x, y }) => x >= 0 && x < 576 && y >= 0 && y < 288));
  assert.ok(image.text.every(({ x, text }) => x + text.length * 6 <= 576), "all UI text fits the lens width");

  layer.handleInput({ type: "click", source: "right-arm" }, {});
  assert.deepEqual(calls, ["cancel"]);
});
