import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const source = readFileSync(
  new URL("../app/ui/shell/strict-delivery-marker.ts", import.meta.url),
  "utf8",
);
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
}).outputText;
const { strictDeliveryMarkerGray } = await import(
  `data:text/javascript;base64,${Buffer.from(js).toString("base64")}`
);

// Mirrors the canonical lookup-table initializer in Android BmpUtil. Keeping
// the assertion beside that source guard makes a packer change fail loudly.
const toWireNibble = (gray) => gray === 0 ? 0 : Math.min(15, (gray + 8) >> 4);

test("strict Clock receipt marker alternates physical 4bpp wire shades", () => {
  const gray = [0, 1, 2, 3].map(strictDeliveryMarkerGray);
  assert.deepEqual(gray, [1, 8, 1, 8]);
  assert.deepEqual(gray.map(toWireNibble), [0, 1, 0, 1],
    "successive strict attempts must not dedupe after native 4bpp packing");

  const bmpUtil = readFileSync(
    new URL(
      "../App_Resources/Android/src/main/java/com/faceclaw/app/util/BmpUtil.java",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(bmpUtil, /GRAY_TO_NIBBLE\[v\] = \(byte\) Math\.min\(15, \(v \+ 8\) >> 4\);/);
});

test("Clock layer applies the wire marker at the lens corner", () => {
  const layer = readFileSync(
    new URL("../app/ui/shell/clock-alert-layer.ts", import.meta.url),
    "utf8",
  );
  assert.match(layer, /strictDeliveryMarkerGray\(this\.deliveryNonce\)/);
  assert.doesNotMatch(layer, /1 \+ \(this\.deliveryNonce & 1\)/,
    "1 and 2 both quantize to wire black and cannot prove a new frame");
});
