import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

async function loadRouting() {
  const js = ts.transpileModule(read("app/ui/shell/assistant-routing.ts"), {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`);
}

test("short tool results stay in the background while conversational replies need the overlay", async () => {
  const { assistantReplyNeedsOverlay } = await loadRouting();
  assert.equal(assistantReplyNeedsOverlay("Bedroom light on ."), false);
  assert.equal(assistantReplyNeedsOverlay("Timer set for ten minutes."), false);
  assert.equal(assistantReplyNeedsOverlay("Which bedroom light did you mean?"), true);
  assert.equal(assistantReplyNeedsOverlay("What brightness? ."), true);
  assert.equal(assistantReplyNeedsOverlay("Say bedroom or kitchen."), true);
  assert.equal(assistantReplyNeedsOverlay("Pick bedroom or kitchen."), true);
  assert.equal(assistantReplyNeedsOverlay("Select lamp one or lamp two."), true);
  assert.equal(assistantReplyNeedsOverlay("Respond with red or blue."), true);
  assert.equal(assistantReplyNeedsOverlay("Confirmed, bedroom light is on."), false);
  assert.equal(assistantReplyNeedsOverlay("Confirmation email sent."), false);
  assert.equal(assistantReplyNeedsOverlay("Your reservation confirmation was sent."), false);
  assert.equal(assistantReplyNeedsOverlay("I need you to know the timer finished."), false);
  assert.equal(assistantReplyNeedsOverlay("Please choose one of the following options."), true);
  assert.equal(assistantReplyNeedsOverlay("x".repeat(161)), true);
});

test("first tool activity backgrounds the assistant without cancelling its live turn", () => {
  const shell = read("app/ui/shell/shell.ts");
  const run = shell.slice(shell.indexOf("private runAssistantTurn"), shell.indexOf("private startAssistantFollowUp"));
  assert.match(run, /onToolActivity:[\s\S]*this\.backgroundAssistantLayer\(layer\)/);
  assert.match(shell, /private assistantTurnBackgrounded = false/);
  assert.match(shell, /private backgroundAssistantLayer\(layer: AssistantLayer\)/);
  assert.match(shell, /this\.assistantTurnBackgrounded = true[\s\S]*this\.stack\.detach\(layer\)/);
  assert.match(shell, /this\.assistantSession\?\.isTurnActive\(\)[\s\S]*this\.restoreBackgroundAssistantLayer\(this\.assistantLayer\)/);
  assert.match(shell, /if \(!this\.assistantSession\?\.isTurnActive\(\) && !this\.activeVoiceLayer\)/);
});

test("context dashboard displacement retires background-overlay bookkeeping", () => {
  const shell = read("app/ui/shell/shell.ts");
  const showDynamicApp = shell.slice(
    shell.indexOf("async showDynamicApp("),
    shell.indexOf("clearDynamicApp(", shell.indexOf("async showDynamicApp(")),
  );
  assert.match(
    showDynamicApp,
    /if \(displacedAssistant\) \{[\s\S]*this\.detachedAssistantLayer = displacedAssistant;[\s\S]*this\.assistantTurnBackgrounded = false;[\s\S]*this\.assistantOverlayRestorePending = false;/,
  );
});

test("background completion uses a brief result unless conversation must reopen", () => {
  const shell = read("app/ui/shell/shell.ts");
  assert.match(shell, /assistantReplyNeedsOverlay/);
  assert.match(shell, /private finishBackgroundAssistantTurn\(layer: AssistantLayer\)/);
  assert.match(shell, /if \(!reply \|\| assistantReplyNeedsOverlay\(reply\)\)/);
  assert.match(shell, /assistantReplyNeedsOverlay\(reply\)[\s\S]*this\.stack\.push\(layer\)/);
  assert.match(shell, /private restoreBackgroundAssistantLayer\(layer: AssistantLayer\)/);
  const run = shell.slice(shell.indexOf("private runAssistantTurn"), shell.indexOf("private startAssistantFollowUp"));
  assert.match(run, /onTurnDone:[\s\S]*this\.finishBackgroundAssistantTurn\(layer\)/);
  assert.match(run, /onError:[\s\S]*this\.restoreBackgroundAssistantLayer\(layer\)/);
  assert.match(shell, /private pendingAssistantResult: string \| null = null/);
  assert.match(shell, /private flushPendingAssistantResult\(\): void/);
  assert.match(shell, /this\.pendingAssistantResult = reply[\s\S]*this\.flushPendingAssistantResult\(\)/);
  assert.match(shell, /await this\.showAlert\(pending\)[\s\S]*this\.pendingAssistantResult === pending/);
  assert.match(
    shell,
    /const queuedNext = this\.pendingAssistantResult !== null && this\.pendingAssistantResult !== pending;[\s\S]*if \(queuedNext\) this\.flushPendingAssistantResult\(\)/,
  );
  const bridgeState = shell.slice(shell.indexOf("assistantBridge.onStateChange"), shell.indexOf("registerWindow"));
  assert.match(bridgeState, /this\.flushPendingAssistantResult\(\)/);
});

test("a retained result retries when the real G2 display reconnects", () => {
  const shell = read("app/ui/shell/shell.ts");
  assert.match(
    shell,
    /retryPendingAssistantResult\(\): void \{[\s\S]*this\.flushPendingAssistantResult\(\)/,
  );
  const controller = read("app/g2/dashboard-controller.ts");
  const stateCallback = controller.slice(
    controller.indexOf("this.offState = communicator.onStateChange"),
    controller.indexOf("this.offRing = communicator.onRingEvent"),
  );
  assert.match(
    stateCallback,
    /this\.setPhase\(mappedPhase\);[\s\S]*if \(mappedPhase === "connected"\) \{[\s\S]*shell\.retryPendingAssistantResult\(\)/,
  );
});

test("strict result alert waits for ordinary shell rendering before becoming visible", () => {
  const shell = read("app/ui/shell/shell.ts");
  const showAlert = shell.slice(shell.indexOf("async showAlert("), shell.indexOf("/** Replace the one shell-owned MCP view"));
  const waitIndex = showAlert.indexOf("await this.config.waitForShellRenderIdle");
  const pushIndex = showAlert.indexOf("this.stack.push(layer)");
  assert.ok(waitIndex >= 0, "showAlert must wait for the ordinary render slot");
  assert.ok(pushIndex > waitIndex, "the alert must not enter the stack until the render slot is owned");

  const controller = read("app/g2/dashboard-controller.ts");
  assert.match(controller, /waitForShellRenderIdle:\s*\(\)\s*=>\s*this\.waitForShellRenderIdle\(\)/);
});

test("active turns reject new assistant capture without resetting the live layer", () => {
  const shell = read("app/ui/shell/shell.ts");
  const send = shell.slice(shell.indexOf("\n  sendToAssistant(text"), shell.indexOf("private runAssistantTurn"));
  assert.match(send, /if \(session\.isTurnActive\(\)\)[\s\S]*restoreBackgroundAssistantLayer/);
  const targets = shell.slice(shell.indexOf("private buildVoiceSendTargets"), shell.indexOf("sendTextToForegroundWindow"));
  assert.match(targets, /this\.isAssistantAvailable\(\) && !this\.assistantSession\?\.isTurnActive\(\)/);
  const followUp = shell.slice(shell.indexOf("private startAssistantFollowUp"), shell.indexOf("private closeAssistantLayer"));
  assert.match(followUp, /session\.isTurnActive\(\)[\s\S]*restoreBackgroundAssistantLayer/);
});

test("hands-free capture forwards endpointing through the dashboard action boundary", () => {
  const controller = read("app/g2/dashboard-controller.ts");
  const sharedActions = controller.slice(
    controller.indexOf("const sharedActions"),
    controller.indexOf("this.sharedActions = sharedActions"),
  );
  assert.match(
    sharedActions,
    /startVoiceCapture:\s*\(endpointing\??:\s*boolean\)\s*=>\s*this\.startVoiceCapture\(endpointing\)/,
  );
});
