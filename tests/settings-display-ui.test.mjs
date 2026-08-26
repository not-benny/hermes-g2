import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

async function loadDependencyFreeTypeScript(path) {
  const js = ts.transpileModule(read(path), {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`);
}

test("controls connection presentation enables only valid actions and exposes truthful tone", async () => {
  const { controlsConnectionPresentation } = await loadDependencyFreeTypeScript(
    "app/phone-ui/controls-presentation.ts",
  );

  const disconnected = controlsConnectionPresentation("disconnected", "Disconnected.");
  assert.deepEqual(disconnected, {
    title: "Glasses disconnected",
    detail: "Disconnected.",
    bannerClass: "status-banner status-warning",
    controlsEnabled: false,
    reconnectEnabled: true,
  });
  assert.equal(
    controlsConnectionPresentation("disconnected", "Failed: Bluetooth unavailable").bannerClass,
    "status-banner status-danger",
  );
  const connected = controlsConnectionPresentation("connected", "Connected.");
  assert.equal(connected.controlsEnabled, true);
  assert.equal(connected.reconnectEnabled, true, "a live-but-stuck session must retain its recovery action");
  for (const phase of ["connecting", "charging", "disconnecting"]) {
    const state = controlsConnectionPresentation(phase, "");
    assert.equal(state.controlsEnabled, false, phase);
    assert.equal(state.reconnectEnabled, false, phase);
    assert.ok(state.detail.length > 0, phase);
  }
});

test("screen action follows the current display state", async () => {
  const { screenActionPresentation } = await loadDependencyFreeTypeScript(
    "app/phone-ui/controls-presentation.ts",
  );
  assert.equal(screenActionPresentation(true).actionLabel, "Blank screen");
  assert.equal(screenActionPresentation(false).actionLabel, "Wake screen");
  assert.equal(screenActionPresentation(true, false).stateLabel, "Display state unavailable");
  assert.equal(screenActionPresentation(true, false).actionLabel, "Screen unavailable");
  assert.match(screenActionPresentation(true).actionHint, /without disconnecting Bluetooth/);
});

test("settings surfaces current device/display summaries and switches to the existing Controls tab", () => {
  const page = read("app/phone-ui/settings-page.xml");
  const model = read("app/phone-ui/settings-view-model.ts");
  assert.match(page, /\{\{ displaySummary \}\}/);
  assert.match(page, /\{\{ deviceSummary \}\}/);
  assert.match(page, /text="Open display controls" tap="\{\{ onControlsTap \}\}"/);
  assert.match(page, /loaded="loaded"/);
  assert.match(model, /getViewById<TabView>\("shellTabs"\)/);
  assert.match(model, /tabs\.selectedIndex = CONTROLS_TAB_INDEX/);
  assert.match(model, /Brightness \$\{brightnessSetting\.displayValue\(\)\}/);
  assert.match(model, /Glasses setup incomplete/);
  assert.doesNotMatch(page, /(?:rightAddress|leftAddress|ringAddress)/,
    "Settings summaries must not render saved Bluetooth identifiers");
});

test("controls use grouped single-column actions, live status, and semantic accessibility values", () => {
  const page = read("app/phone-ui/glasses-controls-page.xml");
  const model = read("app/phone-ui/glasses-controls-view-model.ts");
  for (const binding of [
    "connectionBannerClass",
    "connectionTitle",
    "connectionDetail",
    "screenStateLabel",
    "screenActionLabel",
    "canReconnectGlasses",
  ]) assert.match(page, new RegExp(binding));
  assert.match(page, /accessibilityLiveRegion="polite"/);
  assert.match(page, /accessibilityValue="\{\{ brightnessValueLabel \}\}"/);
  assert.match(page, /accessibilityValue="\{\{ ringSensitivityValueLabel \}\}"/);
  assert.doesNotMatch(page, /columns="\*,\*"/,
    "long translated actions must not share fixed half-width columns on the cover screen");
  assert.match(model, /controlsConnectionPresentation/);
  assert.match(model, /screenActionPresentation/);
  assert.match(model, /private async runBooleanAction/);
  assert.match(model, /catch \(error\)[\s\S]*this\.setStatus\(`\$\{errorPrefix\}:/);
});

test("bottom tabs remove NativeScript's clipping padding while retaining full TalkBack labels", () => {
  const page = read("app/phone-ui/shell-page.xml");
  const code = read("app/phone-ui/shell-page.ts");
  assert.equal((page.match(/accessibilityLabel="[^"]+ tab"/g) ?? []).length, 5);
  assert.match(code, /const TAB_LABEL_HORIZONTAL_PADDING = 4/);
  assert.match(code, /getTextViewForItemAt/);
  assert.match(code, /label\.setPadding/);
  assert.match(code, /label\.setSingleLine\(true\)/);
  assert.match(code, /itemView\.setContentDescription\(`\$\{title\} tab`\)/);
});

test("Glasses page stacks compact landscape and bounds preview height and unfolded width", async () => {
  const {
    classifyPhoneWindow,
    stackedGlassesPreviewHeight,
    usesWideGlassesLayout,
  } = await loadDependencyFreeTypeScript("app/phone-ui/window-layout.ts");
  assert.equal(usesWideGlassesLayout(classifyPhoneWindow(500, 360)), false);
  assert.equal(usesWideGlassesLayout(classifyPhoneWindow(720, 430)), true);
  assert.equal(stackedGlassesPreviewHeight(500, 360, 4 / 3), 129);
  assert.equal(stackedGlassesPreviewHeight(360, 800, 4 / 3), 270);

  const page = read("app/phone-ui/main-page.xml");
  const model = read("app/phone-ui/main-view-model.ts");
  assert.match(page, /<ScrollView id="logScrollView" row="1">/);
  assert.match(page, /<ScrollView id="logScrollViewLandscape" visibility=/);
  assert.match(page, /width="\{\{ displayPreviewWidth \}\}" height="\{\{ displayPreviewHeight \}\}"/);
  assert.match(model, /Math\.min\(this\._windowWidth, PHONE_CONTENT_MAX_WIDTH\)/);
  assert.match(model, /Math\.floor\(this\.displayPreviewHeight \* LENS_ASPECT_RATIO\)/,
    "a height-capped compact preview keeps the lens aspect instead of stretching");
  assert.match(model, /usesWideGlassesLayout\(layout\)/);
});
