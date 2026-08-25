import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const moduleUrl = (source) => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;

async function loadHarness() {
  const shell = read("app/ui/shell/shell.ts");
  const start = shell.indexOf("async openNotificationCard(");
  const end = shell.indexOf("\n  /** Show the full notification dialogue", start);
  assert.ok(start >= 0 && end > start);
  const source = `
    const isSuccessfulFrameOutcome = (outcome) => typeof outcome === "string" && outcome.startsWith("sent");
    const isReadinessFrameEvidenceOutcome = (outcome) =>
      isSuccessfulFrameOutcome(outcome) || outcome === "discarded: no change from displayed image";
    class NotificationCardLayer {
      constructor(options) { this.options = options; options.notification.events.push("construct"); }
      startPresentation() { this.timerArmed = true; this.options.notification.events.push("start"); }
      deferDismissalWhileCovered() { this.timerArmed = true; }
      bumpDeliveryNonce() { this.options.notification.events.push("nonce"); }
      handleInput(event) {
        if (event.type === "click") this.options.onOpen();
        else if (event.type === "double-click") { this.timerArmed = false; this.options.onDismissed(); }
      }
      expire() { if (this.timerArmed) { this.timerArmed = false; this.options.onDismissed(); } }
    }
    class NotificationShellHarness {
      screenOn = false;
      clockAlertLayer = null;
      assistantOnlyPresentation = false;
      activeVoiceLayer = null;
      musicCard = null;
      musicCardWokeScreen = false;
      musicCardWakeActivityRevision = -1;
      musicCardPresentationPending = null;
      notificationCard = null;
      notificationCardWokeScreen = false;
      notificationCardPresentationPending = null;
      activityRevision = 0;
      sleeps = 0;
      assistantResultWakeOwnership = { invalidate: () => {} };
      constructor(config) {
        this.config = config;
        this.stack = {
          layers: [],
          isAtBase: () => this.stack.layers.length === 0,
          push: (layer) => this.stack.layers.push(layer),
          remove: (layer) => {
            const index = this.stack.layers.indexOf(layer);
            if (index < 0) return false;
            this.stack.layers.splice(index, 1);
            return true;
          },
          topMatches: (predicate) => {
            const top = this.stack.layers.at(-1);
            return Boolean(top && predicate(top));
          },
        };
      }
      wake() { this.config.events.push("wake"); this.activityRevision++; this.screenOn = true; return true; }
      sleep() { this.config.events.push("sleep"); this.sleeps++; this.screenOn = false; this.stack.layers = []; }
      restartScreenTimeout() {}
      flushDeferredAssistantUi() {}
      async openNotificationModal(...args) { this.config.modalArgs = args; this.config.events.push("modal"); return true; }
      async openNotificationDigest(...args) { this.config.digestArgs = args; this.config.events.push("digest"); return true; }
      releaseMusicCardPresentationIsolation() { return Promise.resolve(false); }
      ${shell.slice(start, end)}
    }
    export { NotificationShellHarness };
  `;
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return import(moduleUrl(js));
}

function retained(events) {
  return {
    events,
    key: "n1", packageName: "app.pkg", appName: "Messages", title: "Hello",
    text: "Are you free?", bigText: "", subText: "", infoText: "", summaryText: "",
    category: "msg", channelId: "messages", sender: "A", groupKey: "", groupSummary: false,
    importance: 4, clearable: true, lines: [], postTime: 1, when: 1, actions: [],
  };
}

function config(events, overrides = {}) {
  let deliveries = 0;
  return {
    events,
    actions: {},
    requestShellRender: () => events.push("render"),
    requestShellDelivery: async (isOwner, requireSent = true) => {
      assert.equal(isOwner(), true);
      events.push(requireSent ? "strict" : "prime");
      deliveries++;
      return { frameId: deliveries, outcome: "sent" };
    },
    prepareNotificationCardDisplay: async (isOwner) => {
      assert.equal(isOwner(), true); events.push("prepare"); return true;
    },
    revealNotificationCardDisplay: async (isOwner) => {
      assert.equal(isOwner(), true); events.push("reveal"); return true;
    },
    releaseNotificationCardPresentationIsolation: async () => events.push("release"),
    isDisplayAvailable: () => true,
    ...overrides,
  };
}

test("screen-off notification is primed behind black and dismissal restores sleep", async () => {
  const { NotificationShellHarness } = await loadHarness();
  const events = [];
  const subject = new NotificationShellHarness(config(events));
  assert.equal(await subject.openNotificationCard("n1", "r1", retained(events), "new"), true);
  assert.deepEqual(events.slice(0, 8), [
    "construct", "prepare", "start", "prime", "wake", "reveal", "nonce", "strict",
  ]);
  assert.equal(events[8], "release");
  subject.activityRevision += 10; // ring interaction must not surrender prior sleep
  subject.notificationCard.options.onDismissed();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(subject.sleeps, 1);
});

test("a manual HUD wake during retained-card prime wins without later sleep", async () => {
  const { NotificationShellHarness } = await loadHarness();
  const events = [];
  let resolvePrime;
  const prime = new Promise((resolve) => { resolvePrime = resolve; });
  let deliveries = 0;
  const subject = new NotificationShellHarness(config(events, {
    waitForShellRenderIdle: () => new Promise(() => {}),
    requestShellDelivery: async (isOwner, requireSent = true) => {
      assert.equal(isOwner(), true);
      deliveries++;
      events.push(requireSent ? "strict" : "prime");
      if (!requireSent) return prime;
      return { frameId: deliveries, outcome: "sent" };
    },
  }));
  const pending = subject.openNotificationCard("n1", "r1", retained(events), "new");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(events.includes("prime"), true);

  subject.screenOn = true; // a user-owned wake supersedes the sleeping transaction
  resolvePrime({ frameId: deliveries, outcome: "sent" });
  assert.equal(await pending, false);
  assert.equal(subject.notificationCard, null);
  assert.equal(subject.notificationCardWokeScreen, false);
  assert.equal(subject.screenOn, true);
  assert.equal(subject.sleeps, 0);
  assert.equal(events.includes("wake"), false);
  assert.equal(events.includes("reveal"), false);
  assert.equal(events.includes("strict"), false);
  assert.equal(events.includes("render"), true, "a safe retained frame is queued before release");
  assert.ok(events.indexOf("render") < events.indexOf("release"));
});

test("card expiry during a manual-wake prime cannot reveal or revive the notification", async () => {
  const { NotificationShellHarness } = await loadHarness();
  const events = [];
  let resolvePrime;
  const prime = new Promise((resolve) => { resolvePrime = resolve; });
  let deliveries = 0;
  const subject = new NotificationShellHarness(config(events, {
    waitForShellRenderIdle: () => new Promise(() => {}),
    requestShellDelivery: async (isOwner, requireSent = true) => {
      assert.equal(isOwner(), true);
      deliveries++;
      events.push(requireSent ? "strict" : "prime");
      if (!requireSent) return prime;
      return { frameId: deliveries, outcome: "sent" };
    },
  }));
  const pending = subject.openNotificationCard("n1", "r1", retained(events), "new");
  await new Promise((resolve) => setTimeout(resolve, 0));
  const card = subject.notificationCard;
  assert.equal(card.timerArmed, true);

  subject.screenOn = true;
  card.expire();
  resolvePrime({ frameId: deliveries, outcome: "sent" });
  assert.equal(await pending, false);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(subject.notificationCard, null);
  assert.equal(subject.notificationCardWokeScreen, false);
  assert.equal(subject.screenOn, true);
  assert.equal(subject.sleeps, 0);
  assert.equal(events.includes("wake"), false);
  assert.equal(events.includes("reveal"), false);
  assert.equal(events.includes("strict"), false);
  assert.ok(events.indexOf("render") < events.indexOf("release"));
});

test("click keeps the card opaque until detail is ready and transfers sleep ownership", async () => {
  const { NotificationShellHarness } = await loadHarness();
  const events = [];
  let releaseDrain;
  const drain = new Promise((resolve) => { releaseDrain = resolve; });
  const subject = new NotificationShellHarness(config(events, { waitForShellRenderIdle: () => drain }));
  assert.equal(await subject.openNotificationCard("n1", "r1", retained(events), "new"), true);
  const card = subject.notificationCard;
  card.options.onOpen();
  assert.equal(subject.stack.topMatches((top) => top === card), true,
    "the card stays installed while the last card render drains");
  releaseDrain();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(subject.config.modalArgs[2], true, "detail inherits the original sleep state");
  assert.equal(events.includes("modal"), true);
});

test("a stalled detail transition retains the bounded card timeout and returns to sleep", async () => {
  const cardSource = read("app/ui/shell/notification-card.ts");
  const clickBranch = cardSource.slice(
    cardSource.indexOf('if (event.type === "click")'),
    cardSource.indexOf('} else if (event.type === "double-click")'),
  );
  assert.doesNotMatch(clickBranch, /clearTimer\(\)/,
    "click must not disarm the only liveness timeout before detail is installed");

  const { NotificationShellHarness } = await loadHarness();
  const events = [];
  const neverDrains = new Promise(() => {});
  const subject = new NotificationShellHarness(config(events, {
    waitForShellRenderIdle: () => neverDrains,
  }));
  assert.equal(await subject.openNotificationCard("n1", "r1", retained(events), "new"), true);
  const card = subject.notificationCard;
  card.handleInput({ type: "click" });
  assert.equal(subject.stack.topMatches((top) => top === card), true);
  card.expire();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(subject.sleeps, 1);
  assert.equal(subject.screenOn, false);
});

test("assistant overlays and alerts recheck notification ownership after async barriers", () => {
  const shell = read("app/ui/shell/shell.ts");
  const opaqueCard = shell.slice(
    shell.indexOf("private hasOpaqueCardPresentation()"),
    shell.indexOf("private noteAssistantResultActivity()"),
  );
  const overlay = shell.slice(
    shell.indexOf("private flushPendingAssistantOverlay()"),
    shell.indexOf("private flushPendingAssistantResult()"),
  );
  const alert = shell.slice(
    shell.indexOf("async showAlert("),
    shell.indexOf("/** Replace the one shell-owned MCP view", shell.indexOf("async showAlert(")),
  );
  assert.match(opaqueCard, /this\.notificationCard !== null/);
  assert.match(opaqueCard, /this\.notificationCardPresentationPending !== null/);
  assert.match(overlay, /const isPending = \(\) =>[\s\S]*!this\.hasOpaqueCardPresentation\(\)/);
  assert.match(overlay, /!ready[\s\S]*this\.hasOpaqueCardPresentation\(\)/);
  assert.match(alert, /waitForShellRenderIdle\(\)[\s\S]*this\.hasOpaqueCardPresentation\(\)/);
  assert.match(alert, /const isOwner = \(\) =>[\s\S]*!this\.hasOpaqueCardPresentation\(\)/);
});

test("a notification never replaces an already-visible HUD", async () => {
  const { NotificationShellHarness } = await loadHarness();
  const events = [];
  const subject = new NotificationShellHarness(config(events));
  subject.screenOn = true;
  assert.equal(await subject.openNotificationCard("n1", "r1", retained(events), "new"), false);
  assert.equal(subject.notificationCard, null);
  assert.deepEqual(events, []);
  assert.equal(subject.sleeps, 0);
  assert.equal(subject.screenOn, true);
});

test("a newer notification may replace a card that woke the sleeping display", async () => {
  const { NotificationShellHarness } = await loadHarness();
  const events = [];
  const subject = new NotificationShellHarness(config(events));
  assert.equal(await subject.openNotificationCard("n1", "r1", retained(events), "first"), true);
  const first = subject.notificationCard;
  assert.equal(subject.notificationCardWokeScreen, true);
  const secondNotification = retained(events);
  secondNotification.key = "n2";
  assert.equal(await subject.openNotificationCard("n2", "r2", secondNotification, "second"), true);
  assert.notEqual(subject.notificationCard, first);
  assert.equal(subject.notificationCardWokeScreen, true);
  subject.notificationCard.options.onDismissed();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(subject.sleeps, 1);
});

test("a replacement sleep-origin card arms its watchdog before a stalled render drain", async () => {
  const { NotificationShellHarness } = await loadHarness();
  const events = [];
  const subject = new NotificationShellHarness(config(events));
  assert.equal(await subject.openNotificationCard("n1", "r1", retained(events), "first"), true);
  let releaseDrain;
  const drain = new Promise((resolve) => { releaseDrain = resolve; });
  subject.config.waitForShellRenderIdle = () => drain;
  const secondNotification = retained(events);
  secondNotification.key = "n2";

  const pending = subject.openNotificationCard("n2", "r2", secondNotification, "second");
  const card = subject.notificationCard;
  assert.equal(card.timerArmed, true,
    "the replacement card must be bounded before entering the ordinary render barrier");
  card.expire();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(subject.notificationCard, null);
  assert.equal(subject.screenOn, false, "expiry restores the original sleep state");

  releaseDrain();
  assert.equal(await pending, false, "the stale continuation cannot revive the expired card");
});

test("fresh notification card follows the configured notification text size", () => {
  const source = read("app/ui/shell/notification-card.ts");
  assert.match(source, /notificationFontSizeSetting\.get\(\)/);
  assert.match(source, /case "large":[\s\S]*getDefaultLargeFont\(\)/);
  assert.match(source, /case "medium":[\s\S]*getDefaultMediumFont\(\)/);
  assert.match(source, /case "small":[\s\S]*getDefaultSmallFont\(\)/);
  assert.match(source, /drawText\(textFont[\s\S]*wrapText\(textFont/);
});

test("lock revocation during card-to-detail drain restores the prior sleep state", async () => {
  const { NotificationShellHarness } = await loadHarness();
  const events = [];
  let allowed = true;
  let releaseDrain;
  const drain = new Promise((resolve) => { releaseDrain = resolve; });
  const subject = new NotificationShellHarness(config(events, {
    isNotificationPresentationAllowed: () => allowed,
    waitForShellRenderIdle: () => drain,
  }));
  assert.equal(await subject.openNotificationCard("n1", "r1", retained(events), "new"), true);

  subject.notificationCard.handleInput({ type: "click" });
  allowed = false;
  releaseDrain();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(events.includes("modal"), false, "revoked plaintext cannot become a detail modal");
  assert.equal(subject.notificationCard, null);
  assert.equal(subject.sleeps, 1, "a sleep-origin card safely restores darkness on revocation");
});

test("a pending Now Playing wake cannot be evicted through a HUD-visible isolation release", async () => {
  const { NotificationShellHarness } = await loadHarness();
  const events = [];
  const subject = new NotificationShellHarness(config(events));
  subject.screenOn = true;
  const music = { kind: "music" };
  subject.musicCard = music;
  subject.musicCardPresentationPending = music;
  subject.stack.push(music);
  assert.equal(await subject.openNotificationCard("n1", "r1", retained(events), "new"), false);
  assert.equal(subject.musicCard, music);
  assert.equal(subject.musicCardPresentationPending, music);
  assert.equal(subject.stack.topMatches((top) => top === music), true);
  assert.equal(events.includes("release"), false);
});

test("Clock preemption retains a sleep-origin notification and its prior-state ownership", async () => {
  const { NotificationShellHarness } = await loadHarness();
  const events = [];
  const subject = new NotificationShellHarness(config(events));
  assert.equal(await subject.openNotificationCard("n1", "r1", retained(events), "new"), true);
  const card = subject.notificationCard;
  const clock = { kind: "clock" };
  subject.clockAlertLayer = clock;
  subject.stack.push(clock);
  card.expire();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(subject.notificationCard, card);
  assert.equal(subject.notificationCardWokeScreen, true);
  assert.equal(subject.sleeps, 0);
  assert.equal(card.timerArmed, true);
  subject.stack.remove(clock);
  subject.clockAlertLayer = null;
  card.expire();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(subject.sleeps, 1);
});

test("stale notification rollback cannot sleep a newer top-layer owner", async () => {
  const { NotificationShellHarness } = await loadHarness();
  const events = [];
  let rejectStrict;
  let calls = 0;
  const strict = new Promise((_resolve, reject) => { rejectStrict = reject; });
  const subject = new NotificationShellHarness(config(events, {
    requestShellDelivery: async (isOwner, requireSent = true) => {
      assert.equal(isOwner(), true);
      calls++;
      if (!requireSent) return { frameId: calls, outcome: "sent" };
      return strict;
    },
  }));
  const pending = subject.openNotificationCard("n1", "r1", retained(events), "new");
  await new Promise((resolve) => setTimeout(resolve, 0));
  const newer = { kind: "newer" };
  subject.stack.push(newer);
  rejectStrict(new Error("transport failed"));
  assert.equal(await pending, false);
  assert.equal(subject.sleeps, 0);
  assert.equal(subject.stack.topMatches((top) => top === newer), true);
});
