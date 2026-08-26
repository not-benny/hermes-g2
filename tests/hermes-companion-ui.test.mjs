import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("dedicated Hermes tab preserves the existing glasses flow", () => {
  const shell = read("app/phone-ui/shell-page.xml");
  assert.match(shell, /title="Hermes"[\s\S]*defaultPage="phone-ui\/hermes-page"/);
  for (const existing of ["Glasses", "Health", "Controls", "Settings"]) assert.match(shell, new RegExp(`title="${existing}"`));
  assert.equal((shell.match(/<TabViewItem /g) ?? []).length, 5);
});

test("Fold7 and A32 page uses live window bounds, bounded width, and touch-safe bridge recovery", () => {
  const page = read("app/phone-ui/hermes-page.ts");
  const xml = read("app/phone-ui/hermes-page.xml");
  const css = read("app/app.css");
  const viewModel = read("app/phone-ui/hermes-view-model.ts");
  assert.match(page, /getActualSize\(\)/);
  assert.match(page, /Page\.layoutChangedEvent/);
  assert.match(page, /clearTimeout\(state\.timer\)/);
  assert.match(viewModel, /tryClassifyPhoneWindow/);
  assert.match(xml, /compactVisibility/);
  assert.match(xml, /wideVisibility/);
  assert.match(xml, /class="[^"]*phone-content/);
  assert.match(css, /\.phone-content,[\s\S]*max-width:\s*840/);
  assert.match(css, /Button\s*\{[\s\S]*min-height:\s*48/);
  assert.match(css, /\.hermes-session-row,[\s\S]*min-height:\s*48/);
  assert.match(xml, /text="Open bridge settings"[^>]*tap="\{\{ onOpenBridgeSettingsTap \}\}"/);
});

test("page renders the authoritative Host MCP Cockpit projection instead of the retired Companion surface", () => {
  const xml = read("app/phone-ui/hermes-page.xml");
  const viewModel = read("app/phone-ui/hermes-view-model.ts");
  for (const label of ["BRIDGE", "HOST MCP", "RUNS", "ATTENTION", "SHARED HERMES RUNS", "ON THE GLASSES"]) {
    assert.match(xml, new RegExp(label));
  }
  assert.match(viewModel, /assistantBridge\.cockpit\.snapshot\(\)/);
  assert.match(viewModel, /assistantBridge\.cockpit\.onChange/);
  assert.match(viewModel, /projectHermesStatus/);
  assert.match(xml, /read-only view of the same validated projection/);
  assert.match(xml, /Nothing is queued/);
  assert.doesNotMatch(xml, /New voice session|Voice telemetry|Token and cost|Not reported/);
  assert.doesNotMatch(viewModel, /assistantBridge\.companion/);
  assert.doesNotMatch(xml, /password|credential|bearer|raw_payload|prompt/i);
  assert.doesNotMatch(viewModel, /tokenInput|prompt|raw_payload|tool\.args|tool\.result/i);
});

test("dynamic Hermes state is announced without exposing its decorative status dot", () => {
  const xml = read("app/phone-ui/hermes-page.xml");
  assert.match(xml, /class="hermes-status-strip" accessibilityLiveRegion="polite"/);
  assert.match(xml, /text="●"[^>]*accessibilityHidden="true"/);
  assert.match(xml, /class="status-banner status-warning m-t-12"[\s\S]*?accessibilityRole="alert" accessibilityLiveRegion="assertive"/);
  assert.match(xml, /text="\{\{ lastReceiptLabel \}\}"[^>]*accessibilityLiveRegion="polite"/);
});
