import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
  "#46B88C",
  "#4C9DF5",
  "#57D8A6",
  "#9BB0A5",
  "#E5484D",
  "#EAF2EC",
  "#F5C542",
]);

test("phone theme uses only the documented quiet technical companion palette", () => {
  const css = stripComments(read("app/app.css"));
  const used = new Set(css.match(/#[0-9A-Fa-f]{6}\b/g) ?? []);
  assert.deepEqual([...used].sort(), [...palette].sort());
  assert.match(css, /Page\s*\{[^}]*background-color:\s*#0F1411;[^}]*font-family:\s*sans-serif;[^}]*font-size:\s*15;/s);
  assert.match(css, /TabView\s*\{[^}]*selected-tab-text-color:\s*#57D8A6;/s);
});

test("theme foundation defines semantic type, surface, status, list, and action patterns", () => {
  const css = stripComments(read("app/app.css"));
  for (const selector of [
    ".screen-content",
    ".surface-card",
    ".feature-card",
    ".section-heading",
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
  assert.match(css, /Button\s*\{[^}]*min-height:\s*48;/s);
  assert.match(css, /\.list-row\s*\{[^}]*min-height:\s*56;/s);
  assert.match(css, /\.control-row\s*\{[^}]*min-height:\s*56;/s);
  assert.match(css, /Button\.-danger\s*\{[^}]*background-color:\s*#E5484D;[^}]*color:\s*#08120D;/s);
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

test("representative phone screens adopt semantic patterns without losing behavior", () => {
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
    "uiFontItems",
  ]) {
    assert.ok(settings.includes(value), `Settings lost ${value}`);
  }
  assert.doesNotMatch(settings, /\b(?:color|backgroundColor|borderColor|fontSize|fontWeight)="/);

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
    assert.match(
      credentials,
      new RegExp(`<TextField hint="${hint}[^>]+textChange="{{ ${binding} }}"[^>]+secure="true"`),
    );
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

  for (const path of [
    "app/phone-ui/notification-apps-page.xml",
    "app/phone-ui/media-apps-page.xml",
  ]) {
    const list = read(path);
    assert.match(list, /class="list-row"/);
    assert.match(list, /class="list-row-title"/);
    assert.match(list, /class="supporting-text"/);
    assert.doesNotMatch(list, /padding="10"/);
  }
});

test("shell and warning surfaces keep their complete navigation and actions", () => {
  const shell = read("app/phone-ui/shell-page.xml");
  const shellCode = read("app/phone-ui/shell-page.ts");
  assert.equal((shell.match(/<TabViewItem\b/g) ?? []).length, 4);
  assert.match(shell, /loaded="loaded"/);
  assert.match(shellCode, /const MIN_TAB_BAR_HEIGHT = 56;/);
  assert.match(shellCode, /const density = Utils\.layout\.getDisplayDensity\(\);/);
  assert.match(shellCode, /setMinimumHeight\(Math\.round\(MIN_TAB_BAR_HEIGHT \* density \* density\)\)/);
  for (const page of [
    "phone-ui/main-page",
    "phone-ui/even-health-page",
    "phone-ui/glasses-controls-page",
    "phone-ui/settings-page",
  ]) {
    assert.ok(shell.includes(page));
  }

  const main = read("app/phone-ui/main-page.xml");
  assert.ok((main.match(/status-banner status-warning/g) ?? []).length >= 6);
  assert.equal((main.match(/onInstallFirmwareTap/g) ?? []).length, 2);
  assert.equal((main.match(/onAllowBackgroundUsageTap/g) ?? []).length, 2);

  const health = read("app/phone-ui/even-health-page.xml");
  assert.match(health, /status-banner status-warning/);
  assert.match(health, /onOpenEvenAppSettingsTap/);
  assert.match(health, /onRetryRingTap/);
});
