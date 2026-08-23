import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, "");

const palette = new Set([
  "#08120D",
  "#0F1411",
  "#101512",
  "#172019",
  "#1E2A22",
  "#24312A",
  "#B62328",
  "#46B88C",
  "#4C9DF5",
  "#57D8A6",
  "#9BB0A5",
  "#E5484D",
  "#EAF2EC",
  "#F5C542",
]);

function relativeLuminance(hex) {
  const channels = [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255);
  const linear = channels.map((value) => value <= 0.04045
    ? value / 12.92
    : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function contrastRatio(foreground, background) {
  const a = relativeLuminance(foreground);
  const b = relativeLuminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

test("phone theme uses only the documented quiet technical companion palette", () => {
  const css = stripComments(read("app/app.css"));
  const used = new Set(css.match(/#[0-9A-Fa-f]{6}\b/g) ?? []);
  assert.deepEqual([...used].sort(), [...palette].sort());
  assert.match(css, /Page\s*\{[^}]*background-color:\s*#0F1411;[^}]*font-family:\s*sans-serif;[^}]*font-size:\s*15;/s);
  assert.match(css, /TabView\s*\{[^}]*selected-tab-text-color:\s*#57D8A6;/s);
});

test("semantic text and action colors meet WCAG AA normal-text contrast", () => {
  for (const [name, foreground, background] of [
    ["body", "#EAF2EC", "#0F1411"],
    ["supporting", "#9BB0A5", "#0F1411"],
    ["primary action", "#08120D", "#57D8A6"],
    ["secondary action", "#4C9DF5", "#172019"],
    ["warning", "#F5C542", "#172019"],
    ["danger action", "#08120D", "#E5484D"],
    ["Hermes Cancel action", "#EAF2EC", "#B62328"],
  ]) {
    assert.ok(contrastRatio(foreground, background) >= 4.5, `${name} contrast is below 4.5:1`);
  }
});

test("theme foundation defines semantic patterns and bounded touch targets", () => {
  const css = stripComments(read("app/app.css"));
  for (const selector of [
    ".screen-content",
    ".surface-card",
    ".feature-card",
    ".section-heading",
    ".body-text",
    ".supporting-text",
    ".field-label",
    ".status-banner",
    ".status-info",
    ".status-warning",
    ".status-danger",
    ".list-row",
    ".list-row-title",
    "Button.-primary",
    "Button.-secondary",
    "Button.-danger",
  ]) {
    assert.ok(css.includes(selector), `missing semantic theme selector ${selector}`);
  }
  assert.match(css, /TextField,\s*TextView\s*\{[^}]*min-height:\s*48;/s);
  assert.match(css, /Button\s*\{[^}]*min-height:\s*48;/s);
  assert.match(css, /Switch\s*\{[^}]*min-width:\s*48;[^}]*min-height:\s*48;/s);
  assert.match(css, /Slider\s*\{[^}]*min-height:\s*48;/s);
  assert.match(css, /SegmentedBar\s*\{[^}]*min-height:\s*48;/s);
  assert.match(css, /\.list-row\s*\{[^}]*min-height:\s*56;/s);
  assert.match(css, /\.control-row\s*\{[^}]*min-height:\s*56;/s);
  assert.match(css, /\.phone-content,\s*\.screen-content,\s*\.p-20\s*\{[^}]*width:\s*100%;[^}]*max-width:\s*840;/s);
  assert.match(css, /Button\.-danger\s*\{[^}]*background-color:\s*#E5484D;[^}]*color:\s*#08120D;/s);
  assert.match(css, /\.btn-danger\s*\{[^}]*background-color:\s*#B62328;[^}]*color:\s*#EAF2EC;[^}]*font-weight:\s*bold;/s);
});

test("non-text phone controls expose explicit accessibility labels", () => {
  const phoneUi = new URL("../app/phone-ui/", import.meta.url);
  let controls = 0;
  let fields = 0;
  for (const file of readdirSync(phoneUi).filter((name) => name.endsWith(".xml"))) {
    const source = read(`app/phone-ui/${file}`);
    for (const match of source.matchAll(/<(?:Switch|Slider|SegmentedBar)\b[^>]*>/g)) {
      controls += 1;
      assert.match(match[0], /\baccessibilityLabel="[^"]+"/, `${file} has an unlabeled non-text control`);
    }
    for (const match of source.matchAll(/<TextField\b[^>]*>/g)) {
      fields += 1;
      assert.match(match[0], /\baccessibilityLabel="[^"]+"/, `${file} has an unlabeled text field`);
    }
    for (const match of source.matchAll(/<Button\b[^>]*>/g)) {
      assert.match(match[0], /\btext="[^"]+"/, `${file} has an unlabeled button`);
    }
  }
  assert.ok(controls > 0);
  assert.ok(fields > 0);
});

test("phone theme avoids unsupported or costly web CSS features", () => {
  const css = stripComments(read("app/app.css"));
  for (const forbidden of [
    /--[\w-]+\s*:/,
    /\bvar\s*\(/,
    /\bcalc\s*\(/,
    /gradient\s*\(/,
    /box-shadow\s*:/,
    /\bfilter\s*:/,
    /\btransition(?:-[\w-]+)?\s*:/,
    /\banimation(?:-[\w-]+)?\s*:/,
    /@media\b/,
    /\bgap\s*:/,
    /\bposition\s*:\s*(?:fixed|sticky)\b/,
  ]) {
    assert.doesNotMatch(css, forbidden);
  }
});

test("Settings and captions adopt semantics without losing current behavior", () => {
  const settings = read("app/phone-ui/settings-page.xml");
  for (const value of [
    "screen-content",
    "surface-card",
    "section-heading",
    "supporting-text",
    "status-banner status-info",
    "onExitPreviewTap",
    "onDevicesTap",
    "onHealthProfileTap",
    "onApiKeysTap",
    "onCaptionSettingsTap",
    "Live captions &amp; translation",
    "uiFontItems",
  ]) {
    assert.ok(settings.includes(value), `Settings lost ${value}`);
  }
  assert.doesNotMatch(settings, /\b(?:color|backgroundColor|borderColor|fontSize|fontWeight)="/);

  const captions = read("app/phone-ui/caption-settings-page.xml");
  for (const value of [
    "screen-content",
    "Privacy &amp; processing",
    "Captions remain in memory only",
    "onBackTap",
    "onSourceTap",
    "onTargetTap",
    "onLayoutTap",
    "onFontTap",
    "onSpacingTap",
    "onMaxLinesTap",
    "speakerLabels",
    "onVocabularyTextChange",
    "onSaveVocabularyTap",
  ]) {
    assert.ok(captions.includes(value), `caption settings lost ${value}`);
  }
});

test("credential surfaces remain masked, replace-only, and explicitly clearable", () => {
  const credentials = read("app/phone-ui/api-keys-page.xml");
  assert.match(credentials, /class="surface-card m-t-20"/);
  assert.equal((credentials.match(/secure="true"/g) ?? []).length, 7);
  assert.equal((credentials.match(/class="-danger m-t-8"/g) ?? []).length, 11);
  for (const [hint, binding] of [
    ["Bridge token", "onBridgeTokenTextChange"],
    ["Anthropic API key", "onAnthropicTextChange"],
    ["OpenAI API key", "onOpenAiTextChange"],
    ["Deepgram API key", "onDeepgramTextChange"],
    ["ElevenLabs API key", "onElevenLabsTextChange"],
    ["Soniox API key", "onSonioxTextChange"],
    ["Mapbox token", "onMapboxTextChange"],
  ]) {
    const field = credentials.match(new RegExp(`<TextField hint="${hint}[^>]+>`))?.[0] ?? "";
    assert.match(field, new RegExp(`textChange="{{ ${binding} }}"`));
    assert.match(field, /secure="true"/);
    assert.doesNotMatch(field, /\btext="{{/);
  }
  for (const handler of [
    "onClearBridgeTokenTap",
    "onClearAnthropicTap",
    "onClearOpenAiTap",
    "onClearDeepgramTap",
    "onClearElevenLabsTap",
    "onClearSonioxTap",
    "onClearMapboxTap",
    "onClearNightscoutTap",
    "onClearRoamTap",
    "onClearEvenTap",
    "onClearTerminalTap",
    "onSaveTap",
    "onBackTap",
  ]) {
    assert.ok(credentials.includes(handler), `credential screen lost ${handler}`);
  }
});

test("installed-app lists keep notification triage behavior and semantic rows", () => {
  const notifications = read("app/phone-ui/notification-apps-page.xml");
  for (const value of [
    "screen-content",
    "list-row",
    "list-row-title",
    "supporting-text",
    "Precedence:",
    "onRefreshTap",
    "onResetPrioritiesTap",
    "tierLabel",
    "onTierTap",
    "onNotificationAppTap",
    "onBackTap",
  ]) {
    assert.ok(notifications.includes(value), `notification list lost ${value}`);
  }
  assert.doesNotMatch(notifications, /padding="10"/);

  const media = read("app/phone-ui/media-apps-page.xml");
  for (const value of [
    "screen-content",
    "list-row",
    "list-row-title",
    "supporting-text",
    "onRefreshTap",
    "onMediaAppTap",
    "onBackTap",
  ]) {
    assert.ok(media.includes(value), `media list lost ${value}`);
  }
  assert.doesNotMatch(media, /padding="10"/);
});

test("shell touch sizing preserves every required current tab without freezing the tab count", () => {
  const shell = read("app/phone-ui/shell-page.xml");
  const shellCode = read("app/phone-ui/shell-page.ts");
  const titles = [...shell.matchAll(/<TabViewItem\s+title="([^"]+)"/g)].map((match) => match[1]);
  assert.ok(titles.length >= 4);
  assert.equal(new Set(titles).size, titles.length, "tab titles must remain unique");
  assert.match(shell, /loaded="loaded"/);
  assert.match(shellCode, /const MIN_TAB_BAR_HEIGHT = 56;/);
  assert.match(shellCode, /Utils\.layout\.toDevicePixels\(MIN_TAB_BAR_HEIGHT\)/);
  assert.match(shellCode, /setMinimumHeight\(Math\.round\(minimumHeightPixels\)\)/);
  assert.doesNotMatch(shellCode, /density\s*\*\s*density/,
    "high-density Fold windows must not multiply the 56-DIP tab height twice");
  for (const density of [2, 2.625, 3, 4]) {
    const requestedPixels = Math.round(56 * density);
    assert.ok(Math.abs(requestedPixels / density - 56) <= 0.2,
      `one DIP conversion must stay approximately 56 DIP at density ${density}`);
  }
  for (const page of [
    "phone-ui/main-page",
    "phone-ui/even-health-page",
    "phone-ui/glasses-controls-page",
    "phone-ui/settings-page",
  ]) {
    assert.equal((shell.match(new RegExp(page, "g")) ?? []).length, 1, `shell must retain ${page} exactly once`);
  }
});

test("warning surfaces retain complete actions and readable text labels", () => {
  const main = read("app/phone-ui/main-page.xml");
  assert.ok((main.match(/status-banner status-warning/g) ?? []).length >= 6);
  assert.equal((main.match(/onInstallFirmwareTap/g) ?? []).length, 2);
  assert.equal((main.match(/onAllowBackgroundUsageTap/g) ?? []).length, 2);
  assert.ok((main.match(/onOpenLocalReaderTap/g) ?? []).length >= 3);
  assert.ok((main.match(/accessibilityLabel="Open local text or Markdown document in reader"/g) ?? []).length >= 3);

  const health = read("app/phone-ui/even-health-page.xml");
  assert.match(health, /status-banner status-warning/);
  assert.match(health, /evenAppConflictMessage/);
  assert.match(health, /onOpenEvenAppSettingsTap/);
  assert.match(health, /onRetryRingTap/);
});
