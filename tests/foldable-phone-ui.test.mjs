import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

async function loadLayoutContract() {
  const source = read("app/phone-ui/window-layout.ts");
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`);
}

test("Fold7 cover, unfolded, rotated, tabletop, and split windows classify by live bounds", async () => {
  const { classifyPhoneWindow } = await loadLayoutContract();
  const fixtures = [
    ["cover portrait", 360, 800, "compact", "medium", "portrait"],
    ["unfolded portrait", 720, 850, "medium", "medium", "portrait"],
    ["unfolded landscape", 850, 720, "expanded", "medium", "landscape"],
    ["tabletop", 720, 430, "medium", "compact", "landscape"],
    ["split screen", 360, 850, "compact", "medium", "portrait"],
  ];
  for (const [name, width, height, widthClass, heightClass, orientation] of fixtures) {
    assert.deepEqual(classifyPhoneWindow(width, height), { width, height, widthClass, heightClass, orientation }, name);
  }
});

test("layout contract rejects invalid or stale zero-sized bounds", async () => {
  const { classifyPhoneWindow } = await loadLayoutContract();
  for (const [width, height] of [[0, 800], [360, 0], [-1, 800], [NaN, 800]]) {
    assert.throws(() => classifyPhoneWindow(width, height), /positive finite/);
  }
});

test("Android activity is resizable and does not depend on a portrait lock", () => {
  const manifest = read("App_Resources/Android/src/main/AndroidManifest.xml");
  assert.doesNotMatch(manifest, /android:screenOrientation=/);
  assert.match(manifest, /android:resizeableActivity="true"/);
  assert.match(manifest, /android:windowSoftInputMode="adjustResize"/);
  assert.match(manifest, /android:configChanges="[^"]*orientation[^"]*screenSize[^"]*smallestScreenSize/);
});

test("main phone UI observes live layout bounds instead of physical screen globals", () => {
  const page = read("app/phone-ui/main-page.ts");
  const model = read("app/phone-ui/main-view-model.ts");
  assert.match(page, /layoutChangedEvent/);
  assert.match(page, /getActualSize\(\)/);
  assert.doesNotMatch(model, /Screen\.mainScreen/);
});

test("live resize work is coalesced, cancelled on unload, and ignores unchanged bounds", () => {
  const page = read("app/phone-ui/main-page.ts");
  const model = read("app/phone-ui/main-view-model.ts");
  assert.match(page, /layoutTimer/);
  assert.match(page, /clearTimeout\(state\.layoutTimer\)/);
  assert.match(page, /state\.disposed/);
  assert.match(model, /if \(this\._windowWidth === layout\.width && this\._windowHeight === layout\.height\) return/);
});

test("main page releases its dashboard subscription when its view model unloads", () => {
  const page = read("app/phone-ui/main-page.ts");
  const model = read("app/phone-ui/main-view-model.ts");
  assert.match(model, /this\._unsubscribeDashboard = dashboardController\.subscribe/);
  assert.match(model, /dispose\(\): void/);
  assert.match(page, /state\.model\.dispose\(\)/);
});

test("phone UI has bounded readable content and accessible touch targets", () => {
  const css = read("app/app.css");
  assert.match(css, /\.phone-content,[\s\S]*max-width:\s*840/);
  assert.match(css, /Button\s*\{[\s\S]*min-height:\s*48/);
  assert.match(css, /Switch\s*\{[\s\S]*min-width:\s*48[\s\S]*min-height:\s*48/);
  assert.match(read("app/phone-ui/settings-page.xml"), /class="[^"]*phone-content/);
  assert.match(read("app/phone-ui/glasses-controls-page.xml"), /class="[^"]*phone-content/);
});

test("phone compatibility work does not change the existing G2 compositor contract", () => {
  const image = read("app/graphics/image.ts");
  const geometry = read("app/ui/shell/geometry.ts");
  assert.match(image, /G2_LENS_WIDTH\s*=\s*640/);
  assert.match(image, /G2_LENS_HEIGHT\s*=\s*480/);
  assert.match(geometry, /MIN_WINDOW_HEIGHT\s*=\s*288/);
});
