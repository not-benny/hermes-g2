import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

// edge-scroll.ts is self-contained (no imports); transpile it and load it as a
// module so we test the real implementation, not a copy.
const src = readFileSync(new URL("../app/ui/edge-scroll.ts", import.meta.url), "utf8");
const js = ts.transpileModule(src, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
}).outputText;
const { EdgeWrapScroller, DEFAULT_EDGE_HOLD_MS: HOLD } = await import(
  "data:text/javascript;base64," + Buffer.from(js).toString("base64")
);

test("scrolling within the list steps normally", () => {
  const s = new EdgeWrapScroller();
  assert.deepEqual(s.step(0, 5, 1, 0), { index: 1, atEdge: false });
  assert.deepEqual(s.step(1, 5, 1, 10), { index: 2, atEdge: false });
  assert.deepEqual(s.step(2, 5, -1, 20), { index: 1, atEdge: false });
});

test("first push past the bottom stops at the end, does not wrap", () => {
  const s = new EdgeWrapScroller();
  assert.deepEqual(s.step(4, 5, 1, 1000), { index: 4, atEdge: true });
  assert.deepEqual(s.step(4, 5, 1, 1000 + HOLD - 1), { index: 4, atEdge: true });
});

test("holding against the bottom past the delay wraps to the top", () => {
  const s = new EdgeWrapScroller();
  assert.deepEqual(s.step(4, 5, 1, 0), { index: 4, atEdge: true });
  assert.deepEqual(s.step(4, 5, 1, HOLD), { index: 0, atEdge: false });
});

test("top edge behaves symmetrically", () => {
  const s = new EdgeWrapScroller();
  assert.deepEqual(s.step(0, 5, -1, 0), { index: 0, atEdge: true });
  assert.deepEqual(s.step(0, 5, -1, HOLD + 5), { index: 4, atEdge: false });
});

test("reversing direction disarms the detent", () => {
  const s = new EdgeWrapScroller();
  assert.deepEqual(s.step(4, 5, 1, 0), { index: 4, atEdge: true });
  assert.deepEqual(s.step(4, 5, -1, 10), { index: 3, atEdge: false });
  assert.deepEqual(s.step(4, 5, 1, 20), { index: 4, atEdge: true });
});

test("single-item and empty lists never wrap or crash", () => {
  const s = new EdgeWrapScroller();
  assert.deepEqual(s.step(0, 1, 1, 0), { index: 0, atEdge: false });
  assert.deepEqual(s.step(0, 0, -1, 0), { index: 0, atEdge: false });
});

test("a custom hold delay is honored", () => {
  const s = new EdgeWrapScroller(1000);
  assert.deepEqual(s.step(4, 5, 1, 0), { index: 4, atEdge: true });
  assert.deepEqual(s.step(4, 5, 1, 999), { index: 4, atEdge: true });
  assert.deepEqual(s.step(4, 5, 1, 1000), { index: 0, atEdge: false });
});
