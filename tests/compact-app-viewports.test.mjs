import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const COMPACT_WIDTH = 568;
const COMPACT_HEIGHT = 232;

async function loadLayout(relativePath) {
  const source = readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`);
}

const blocks = await loadLayout("app/apps/blocks/blocks-layout.ts");
const minesweeper = await loadLayout("app/apps/minesweeper/minesweeper-layout.ts");
const pinball = await loadLayout("app/apps/pinball/pinball-layout.ts");
const navigate = await loadLayout("app/apps/navigate/navigate-layout.ts");

test("Blocks reflows its board and both gesture rows inside the 232px compact viewport", () => {
  const layout = blocks.blocksLayout(COMPACT_HEIGHT);
  assert.equal(layout.cell, 10);
  assert.ok(layout.boardY - 2 >= 0);
  assert.ok(layout.boardY + layout.boardHeight + 2 <= COMPACT_HEIGHT);
  assert.ok(layout.secondHintY + 16 <= COMPACT_HEIGHT);
  assert.ok(layout.firstHintY + 16 <= layout.secondHintY);
  assert.ok(layout.panelX < COMPACT_WIDTH);

  const roomy = blocks.blocksLayout(424);
  assert.equal(roomy.cell, 12, "the original board scale is retained when it fits");
});

test("Minesweeper scales every selectable row and keeps its action hints visible", () => {
  const layout = minesweeper.minesweeperLayout(COMPACT_HEIGHT);
  assert.equal(layout.cell, 24);
  assert.ok(layout.boardY - 2 >= 0);
  assert.ok(layout.boardY + layout.boardHeight + 2 <= COMPACT_HEIGHT);
  assert.equal(layout.boardHeight, 9 * layout.cell, "all nine interactive rows are in the fitted board");
  assert.ok(layout.secondHintY + 16 <= COMPACT_HEIGHT);
  assert.ok(layout.panelX < COMPACT_WIDTH);

  const roomy = minesweeper.minesweeperLayout(424);
  assert.equal(roomy.cell, 26, "the original cell scale is retained when it fits");
});

test("Pinball fits its fixed physics canvas into 232 output rows without losing the table bottom", () => {
  assert.equal(pinball.pinballPaintHeight(COMPACT_HEIGHT), pinball.PINBALL_DESIGN_HEIGHT);
  const width = 2;
  const source = {
    width,
    height: pinball.PINBALL_DESIGN_HEIGHT,
    pixels: new Uint8Array(width * pinball.PINBALL_DESIGN_HEIGHT),
  };
  source.pixels.fill(200, 256 * width, 257 * width); // playfield BOTTOM
  const fitted = pinball.fitPinballPixels(source, COMPACT_HEIGHT);
  assert.equal(fitted.length, width * COMPACT_HEIGHT);
  assert.ok(fitted.some((value) => value === 200), "the y=256 drain/plunger row survives the fit");
  assert.equal(pinball.pinballPaintHeight(424), 424, "full-height windows are not scaled");
});

test("Navigate sizes the map and all lower guidance rows from the compact viewport", () => {
  const layout = navigate.navigateLayout(COMPACT_WIDTH, COMPACT_HEIGHT);
  assert.equal(layout.mapSize, COMPACT_HEIGHT);
  assert.ok(layout.mapSize <= COMPACT_HEIGHT);
  assert.ok(layout.panelX + layout.panelWidth <= COMPACT_WIDTH);
  assert.ok(layout.etaY + 16 <= layout.statusY);
  assert.ok(layout.statusY + 16 <= layout.footerY);
  assert.ok(layout.footerY + 16 <= COMPACT_HEIGHT);
  assert.equal(navigate.visibleTextRows(84, layout.etaY - 8, 24), 3);

  const roomy = navigate.navigateLayout(COMPACT_WIDTH, 424);
  assert.equal(roomy.mapSize, 260, "the original map size remains the upper bound");
});

test("the four workers wire their compact layouts into actual rendering and map fetches", () => {
  const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
  assert.match(read("app/apps/blocks/blocks-app.worker.ts"), /blocksLayout\(window\.viewportHeight\)/);
  assert.match(read("app/apps/minesweeper/minesweeper-app.worker.ts"), /minesweeperLayout\(window\.viewportHeight\)/);
  assert.match(read("app/apps/pinball/pinball-app.worker.ts"), /fitPinballPixels\(designFrame, window\.viewportHeight\)/);
  const navigation = read("app/apps/navigate/navigate-app.worker.ts");
  assert.match(navigation, /width: mapSize,[\s\S]*height: mapSize/);
  assert.match(navigation, /drawWrappedWithin\([\s\S]*layout\.etaY - 8/);
});
