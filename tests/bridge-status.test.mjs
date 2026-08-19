import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const dataUrl = (js) => "data:text/javascript;base64," + Buffer.from(js).toString("base64");

// device-icons.ts pulls the font machinery (and thus NativeScript) in through
// ./image, which won't load under node. The bridge glyph only needs
// imageFromAsciiArt + a pixel-holding GrayImage, so stub ./image with a faithful
// re-implementation of just those two and load the real device-icons against it.
// (The ./bdffont and ./bridge-client imports are type-only and get elided.)
const imageStub = dataUrl(`
export function imageFromAsciiArt(lines, value = 255) {
  const width = Math.max(0, ...lines.map((l) => l.length));
  const image = new GrayImage(width, lines.length, 0);
  const fill = Math.max(0, Math.min(255, value | 0));
  for (let y = 0; y < lines.length; y++) {
    const line = lines[y];
    for (let x = 0; x < line.length; x++) {
      const p = line[x];
      if (p && p !== " " && p !== ".") image.pixels[y * width + x] = fill;
    }
  }
  return image;
}
export class GrayImage {
  constructor(w, h, fill = 0) {
    this.width = w; this.height = h;
    this.pixels = new Uint8Array(w * h).fill(fill);
  }
  setPixel(x, y, v) {
    if (x >= 0 && y >= 0 && x < this.width && y < this.height) this.pixels[y * this.width + x] = v;
  }
}
`);

const src = read("app/graphics/device-icons.ts");
const js = ts
  .transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 } })
  .outputText.replace('"./image"', JSON.stringify(imageStub));
const { bridgeStatusIcon } = await import(dataUrl(js));

const fingerprint = (icon) => `${icon.width}x${icon.height}:${Array.from(icon.pixels).join(",")}`;

test("bridgeStatusIcon renders a distinct glyph per phase", () => {
  const phases = ["idle", "connecting", "connected", "failed"];
  const icons = phases.map((phase) => bridgeStatusIcon(phase));
  for (const icon of icons) {
    assert.ok(icon.height >= 10 && icon.height <= 12, "glyph is HUD-scale (~12px tall)");
    assert.ok(icon.pixels.some((p) => p > 0), "glyph draws ink");
  }
  // connected is brighter (emphasis) than the muted connecting state.
  const peak = (icon) => Math.max(...icon.pixels);
  assert.ok(peak(icons[2]) > peak(icons[1]), "connected reads brighter than connecting");
  // connected / connecting / failed are all visually different.
  const fps = new Set([icons[1], icons[2], icons[3]].map(fingerprint));
  assert.equal(fps.size, 3, "connecting, connected and failed differ pixel-for-pixel");
});

test("the top bar draws the bridge glyph only when configured, gated by state.bridge.show", () => {
  const chrome = read("app/ui/shell/chrome-layer.ts");
  const shell = read("app/ui/shell/shell.ts");

  // chrome-layer draws the glyph left of the brightness badge, gated on show.
  assert.match(chrome, /if \(state\.bridge\.show\) \{\s*const bridge = bridgeStatusIcon\(state\.bridge\.phase\)/);

  // The show predicate: external backend AND a non-empty bridge host.
  assert.match(
    shell,
    /assistantBackendSetting\.get\(\) === "external" &&\s*assistantBridgeHostSetting\.get\(\)\.trim\(\)\.length > 0/,
  );

  // The glyph tracks live phase changes and repaints the bar.
  assert.match(shell, /assistantBridge\.onStateChange\(\(state\) => \{/);
  assert.match(shell, /this\.bridgePhase = state\.phase;\s*this\.config\.requestShellRender\(\);/);
});
