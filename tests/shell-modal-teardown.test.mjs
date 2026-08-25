import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const withoutImports = (source) => source.replace(/import[\s\S]*?from\s+"[^"]+";\n/g, "");
const moduleUrl = (source) => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;

async function loadModalRuntime() {
  const harness = `
    const G2_LENS_WIDTH = 640;
    const G2_LENS_HEIGHT = 480;
    const spanCurrent = (_name, action) => action();
    class GrayImage {}
    const appViewportSize = () => ({ width: 568, height: 232 });
    const appViewportRect = () => ({ x: 72, y: 56, width: 568, height: 232 });
    const SHELL_OPAQUE_BLACK = 1;
  `;
  const source = [
    harness,
    withoutImports(read("app/ui/layers.ts")),
    withoutImports(read("app/ui/shell/modal-layer.ts")),
  ].join("\n");
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  return import(moduleUrl(js));
}

async function loadNotificationModalCloseHarness() {
  const shell = read("app/ui/shell/shell.ts");
  const ownershipStart = shell.indexOf("export class NotificationModalWakeOwnership");
  const ownershipEnd = shell.indexOf("\nclass Shell {", ownershipStart);
  const closeStart = shell.indexOf("private closeNotificationModal");
  const closeEnd = shell.indexOf("\n  /** Called by a window", closeStart);
  assert.ok(ownershipStart >= 0 && ownershipEnd > ownershipStart,
    "notification modal wake ownership source is present");
  assert.ok(closeStart >= 0 && closeEnd > closeStart,
    "notification modal close source is present");
  const source = `
    const G2_LENS_WIDTH = 640;
    const G2_LENS_HEIGHT = 480;
    const spanCurrent = (_name, action) => action();
    class GrayImage {}
    const appViewportSize = () => ({ width: 568, height: 232 });
    const appViewportRect = () => ({ x: 72, y: 56, width: 568, height: 232 });
    const SHELL_OPAQUE_BLACK = 1;
    ${withoutImports(read("app/ui/layers.ts"))}
    ${shell.slice(ownershipStart, ownershipEnd)}
    class NotificationModalCloseHarness {
      sleeps = 0;
      renders = 0;
      constructor(activityRevision) {
        this.activityRevision = activityRevision;
        this.notificationModalWakeOwnership = new NotificationModalWakeOwnership();
        this.config = { requestShellRender: () => { this.renders++; } };
        this.stack = new LayerStack({ paint: () => new GrayImage(), handleInput: () => {} }, noopLayerActions);
      }
      sleep() {
        this.sleeps++;
        this.stack.clearToBase();
      }
      flushDeferredAssistantUi() {}
      ${shell.slice(closeStart, closeEnd)}
    }
    export { NotificationModalCloseHarness };
  `;
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  return import(moduleUrl(js));
}

async function loadOpenNotificationModalHarness() {
  const shell = read("app/ui/shell/shell.ts");
  const start = shell.indexOf("async openNotificationModal(");
  const end = shell.indexOf("\n  async openNotificationDigest(", start);
  assert.ok(start >= 0 && end > start, "notification modal method source is present");
  const source = `
    class SingleNotificationLayer {
      constructor(key, options) { this.key = key; this.options = options; }
    }
    class ShellModalLayer {
      constructor(base, actions) { this.base = base; this.actions = actions; }
    }
    class OpenNotificationModalHarness {
      screenOn = true;
      clockAlertLayer = null;
      activeVoiceLayer = null;
      activityRevision = 1;
      screenWakeActivityRevision = 1;
      musicCard = null;
      musicCardWokeScreen = false;
      musicCardPresentationPending = null;
      assistantResultWakeOwnership = { invalidate: () => {} };
      notificationModalWakeOwnership = { claim: () => {} };
      timeoutRestarts = 0;
      constructor(config) {
        this.config = config;
        this.stack = {
          layers: [],
          push: (layer) => this.stack.layers.push(layer),
          remove: (layer) => {
            const index = this.stack.layers.indexOf(layer);
            if (index < 0) return false;
            this.stack.layers.splice(index, 1);
            return true;
          },
          popIfTop: (predicate) => {
            const top = this.stack.layers.at(-1);
            if (!top || !predicate(top)) return false;
            this.stack.layers.pop();
            return true;
          },
          topMatches: (predicate) => {
            const top = this.stack.layers.at(-1);
            return Boolean(top && predicate(top));
          },
        };
      }
      restartScreenTimeout() { this.timeoutRestarts++; }
      closeNotificationModal(modal) { this.stack.remove(modal); }
      releaseMusicCardPresentationIsolation() { return Promise.resolve(false); }
      ${shell.slice(start, end)}
    }
    export { OpenNotificationModalHarness };
  `;
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return import(moduleUrl(js));
}

async function loadSingleNotificationRuntime() {
  const notifications = read("app/ui/notifications.ts");
  const retainStart = notifications.indexOf("export function retainAndroidNotification");
  const retainEnd = notifications.indexOf("\nexport class NotificationDigestLayer", retainStart);
  const layerStart = notifications.indexOf("export class SingleNotificationLayer");
  const layerEnd = notifications.indexOf("\n\nfunction buildNotificationCardLayout", layerStart);
  assert.ok(retainStart >= 0 && retainEnd > retainStart && layerStart >= 0 && layerEnd > layerStart,
    "retained notification detail source is present");
  const source = `
    let liveNotifications = [];
    let currentRevision = true;
    const dismissed = [];
    let replyStarts = 0;
    const MAX_NOTIFICATIONS = 50;
    const readActiveNotifications = () => liveNotifications;
    const notificationTriageController = {
      isCurrent: () => currentRevision,
      dismiss: (key) => dismissed.push(["triage", key]),
    };
    const dismissNotification = (key) => dismissed.push(["native", key]);
    const invokeNotificationAction = () => {};
    class VoiceInputLayer {
      constructor(options) { this.options = options; }
      startCapture() { replyStarts++; }
    }
    const notificationFont = () => ({});
    class GrayImage { constructor() { this.presentedNotification = null; } }
    const buildDetailMenu = (notification) => [
      { kind: "back", label: "Back" },
      ...notification.actions.map((action) => ({ kind: "action", label: action.title, action })),
      { kind: "dismiss", label: "Dismiss" },
    ];
    const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
    const drawDetailContent = (image, _font, notification) => {
      image.presentedNotification = notification;
    };
    const iconForNotification = () => null;
    const drawDetailMenu = () => {};
    ${notifications.slice(retainStart, retainEnd)}
    ${notifications.slice(layerStart, layerEnd)}
    export const setLiveNotificationState = (notifications, current) => {
      liveNotifications = notifications;
      currentRevision = current;
    };
    export const dismissedNotificationKeys = () => dismissed.slice();
    export const replyCaptureStarts = () => replyStarts;
  `;
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return import(moduleUrl(js));
}

const inertLayer = (onRemoved = () => {}) => ({
  paint: () => ({}),
  handleInput: () => {},
  onRemoved,
});

test("outer modal teardown stops nested capture before disposing its base exactly once", async () => {
  const { LayerStack, ShellModalLayer, noopLayerActions } = await loadModalRuntime();
  const removals = [];
  let captureActive = true;
  const modal = new ShellModalLayer(
    inertLayer(() => { removals.push("base"); }),
    noopLayerActions,
  );
  // TypeScript privacy is compile-time only; exercise the real nested stack
  // lifecycle that a notification-reply VoiceInputLayer occupies at runtime.
  modal.stack.push(inertLayer(() => {
    captureActive = false;
    removals.push("voice");
  }));

  const outer = new LayerStack(inertLayer(), noopLayerActions);
  outer.push(modal);
  outer.clearToBase();
  assert.equal(captureActive, false, "global outer teardown must stop nested capture");
  assert.deepEqual(removals, ["voice", "base"], "nested overlays tear down before their base");

  modal.onRemoved();
  outer.clearToBase();
  assert.deepEqual(removals, ["voice", "base"], "modal disposal is idempotent");
});

test("notification reply is nested and VoiceInputLayer teardown owns mic and subscriptions", () => {
  const notifications = read("app/ui/notifications.ts");
  const reply = notifications.slice(notifications.indexOf("private startReply"), notifications.indexOf("/** Leave the detail view"));
  assert.match(reply, /ctx\.stack\.push\(voice\)/);
  const voice = read("app/ui/shell/voice-input.ts");
  const removed = voice.slice(voice.indexOf("onRemoved(): void"), voice.indexOf("private displayText"));
  assert.match(removed, /this\.unsubscribeTranscript\?\.\(\)/);
  assert.match(removed, /this\.unsubscribeStatus\?\.\(\)/);
  assert.match(removed, /this\.unsubscribeSpeechEnd\?\.\(\)/);
  assert.match(removed, /this\.actions\.stopVoiceCapture\(this\.captureGeneration, false\)/);
});

test("only an exact top notification modal with an unclaimed wake may sleep the display", async () => {
  const { NotificationModalCloseHarness } = await loadNotificationModalCloseHarness();
  const stale = new NotificationModalCloseHarness(1);
  const oldModal = inertLayer();
  const newModal = inertLayer();
  stale.stack.push(oldModal);
  stale.notificationModalWakeOwnership.claim(oldModal, 1);
  stale.stack.push(newModal);

  stale.closeNotificationModal(oldModal);
  assert.equal(stale.sleeps, 0, "a buried old owner cannot blank a newer modal");
  assert.equal(stale.stack.topMatches((layer) => layer === newModal), true,
    "the newer top modal survives the stale close");

  const userOwned = new NotificationModalCloseHarness(10);
  const userModal = inertLayer();
  userOwned.stack.push(userModal);
  userOwned.notificationModalWakeOwnership.claim(userModal, 10);
  userOwned.activityRevision = 11;
  userOwned.closeNotificationModal(userModal);
  assert.equal(userOwned.sleeps, 1,
    "ring interaction inside the exact notification dialogue does not expose the dashboard");

  const exact = new NotificationModalCloseHarness(20);
  const exactModal = inertLayer();
  exact.stack.push(exactModal);
  exact.notificationModalWakeOwnership.claim(exactModal, 20);
  exact.closeNotificationModal(exactModal);
  assert.equal(exact.sleeps, 1, "an untouched exact wake owner retains the old re-sleep behavior");

  const shell = read("app/ui/shell/shell.ts");
  const closeMethod = shell.slice(
    shell.indexOf("private closeNotificationModal"),
    shell.indexOf("/** Called by a window", shell.indexOf("private closeNotificationModal")),
  );
  assert.match(closeMethod, /const wasTop = this\.stack\.topMatches/);
  assert.match(closeMethod, /notificationModalWakeOwnership\.release\([\s\S]*wasTop && removed/);
  const userActivity = shell.slice(
    shell.indexOf("noteUserActivity("),
    shell.indexOf("/** Re-baseline idle sleep", shell.indexOf("noteUserActivity(")),
  );
  assert.match(userActivity, /this\.activityRevision\+\+;/);

  const digest = shell.slice(
    shell.indexOf("async openNotificationDigest"),
    shell.indexOf("isMusicCardActive", shell.indexOf("async openNotificationDigest")),
  );
  assert.match(digest, /notificationModalWakeOwnership\.claim\(modal\)/,
    "digest modals use the same exact wake ownership");
  assert.equal((digest.match(/this\.closeNotificationModal\(modal\)/g) ?? []).length, 2,
    "digest has one close callback and one failure close, without duplicate teardown");
});

test("notification modal drains the wake repaint before strict installation", async () => {
  const { OpenNotificationModalHarness } = await loadOpenNotificationModalHarness();
  let releaseDrain;
  const drain = new Promise((resolve) => { releaseDrain = resolve; });
  let strictDeliveries = 0;
  const subject = new OpenNotificationModalHarness({
    actions: {},
    waitForShellRenderIdle: () => drain,
    requestShellDelivery: async (isOwner) => {
      strictDeliveries++;
      assert.equal(isOwner(), true, "strict delivery owns the newly installed modal");
      return { frameId: 2, outcome: "sent" };
    },
  });
  const notification = {
    key: "notification-1",
    title: "Retained title",
    lines: ["Retained line"],
    actions: [],
  };
  const pending = subject.openNotificationModal(
    notification.key,
    "revision-1",
    true,
    notification,
    "default immediate",
  );
  await Promise.resolve();
  assert.equal(subject.stack.layers.length, 0,
    "the modal cannot leak into the ordinary wake frame while its render is held");
  assert.equal(strictDeliveries, 0);

  releaseDrain();
  assert.equal(await pending, true);
  assert.equal(strictDeliveries, 1);
  assert.equal(subject.stack.layers.length, 1, "the strict ACK leaves the modal installed");
  assert.equal(subject.stack.layers[0].base.options.retainedNotification, notification,
    "the pre-wake notification snapshot crosses the strict installation boundary");
});

test("notification modal strict delivery is revoked by the authoritative lock gate", async () => {
  const { OpenNotificationModalHarness } = await loadOpenNotificationModalHarness();
  let allowed = true;
  let releaseStrict;
  const strict = new Promise((resolve) => { releaseStrict = resolve; });
  let ownerDuringDelivery;
  const subject = new OpenNotificationModalHarness({
    actions: {},
    isNotificationPresentationAllowed: () => allowed,
    requestShellDelivery: async (isOwner) => {
      ownerDuringDelivery = isOwner;
      assert.equal(isOwner(), true);
      await strict;
      return { frameId: 3, outcome: "sent" };
    },
  });
  const notification = {
    key: "notification-locked",
    title: "Private detail",
    lines: [],
    actions: [],
  };

  const pending = subject.openNotificationModal(
    notification.key,
    "revision-locked",
    true,
    notification,
    "default immediate",
    true,
  );
  await Promise.resolve();
  assert.equal(subject.stack.layers.length, 1);
  allowed = false;
  assert.equal(ownerDuringDelivery(), false, "lock revocation retires the in-flight strict owner");
  releaseStrict();
  assert.equal(await pending, false);
  assert.equal(subject.stack.layers.length, 0, "revoked detail is removed instead of retained behind lock");
});

test("a presented notification snapshot survives live source replacement or removal", async () => {
  const { SingleNotificationLayer, setLiveNotificationState } = await loadSingleNotificationRuntime();
  const source = {
    key: "notification-1",
    packageName: "example.app",
    appName: "Example",
    title: "Original title",
    text: "Original body",
    bigText: "",
    subText: "",
    infoText: "",
    summaryText: "",
    category: "message",
    channelId: "messages",
    sender: "Alice",
    groupKey: "",
    groupSummary: false,
    importance: 3,
    clearable: true,
    lines: ["Original line"],
    postTime: 1,
    when: 1,
    actions: [{ index: 0, title: "Reply", enabled: true, hasRemoteInput: true }],
  };
  let closes = 0;
  const layer = new SingleNotificationLayer(source.key, {
    origin: "new-notification-modal",
    expectedRevision: "revision-1",
    retainedNotification: source,
    closeModal: () => { closes++; },
  });
  source.title = "Replacement title";
  source.lines[0] = "Replacement line";
  source.actions[0].title = "Replacement action";
  setLiveNotificationState([], false);

  const image = layer.paint({
    stack: { getBaseSize: () => ({ width: 532, height: 196 }) },
    actions: {},
  }, () => ({}));
  assert.equal(closes, 0, "live removal cannot close an already selected modal");
  assert.equal(image.presentedNotification.title, "Original title");
  assert.deepEqual(image.presentedNotification.lines, ["Original line"]);
  assert.equal(image.presentedNotification.actions[0].title, "Reply");
});

test("notification detail keeps one-tap Back and double-tap dismisses from any selected row", async () => {
  const {
    SingleNotificationLayer,
    dismissedNotificationKeys,
    replyCaptureStarts,
  } = await loadSingleNotificationRuntime();
  const notification = {
    key: "notification-gesture",
    packageName: "example.app",
    appName: "Example",
    title: "Gesture test",
    text: "Body",
    bigText: "",
    subText: "",
    infoText: "",
    summaryText: "",
    category: "message",
    channelId: "messages",
    sender: "",
    groupKey: "",
    groupSummary: false,
    importance: 3,
    clearable: true,
    lines: [],
    postTime: 1,
    when: 1,
    actions: [{ index: 0, title: "Reply", enabled: true, hasRemoteInput: true }],
  };
  const makeContext = () => {
    let pops = 0;
    return {
      ctx: {
        stack: {
          pop: () => { pops++; },
          push: () => {},
          popIfTop: () => false,
          getBaseSize: () => ({ width: 532, height: 196 }),
        },
        actions: {},
      },
      pops: () => pops,
    };
  };

  const back = new SingleNotificationLayer(notification.key, {
    origin: "notifications-list",
    retainedNotification: notification,
  });
  const backContext = makeContext();
  back.handleInput({ type: "click" }, backContext.ctx);
  assert.equal(backContext.pops(), 1, "Back is selected initially and one tap returns to the list");
  assert.deepEqual(dismissedNotificationKeys(), [], "Back never dismisses the phone notification");

  const reply = new SingleNotificationLayer(notification.key, {
    origin: "notifications-list",
    retainedNotification: notification,
  });
  const replyContext = makeContext();
  reply.handleInput({ type: "scroll-down" }, replyContext.ctx);
  reply.handleInput({ type: "click" }, replyContext.ctx);
  assert.equal(replyCaptureStarts(), 1, "the Reply row still opens voice capture");
  assert.equal(replyContext.pops(), 0, "starting Reply keeps the notification detail underneath");
  assert.deepEqual(dismissedNotificationKeys(), [], "Reply never takes the dismissal path");

  const dismiss = new SingleNotificationLayer(notification.key, {
    origin: "notifications-list",
    retainedNotification: notification,
  });
  const dismissContext = makeContext();
  dismiss.handleInput({ type: "scroll-down" }, dismissContext.ctx);
  dismiss.handleInput({ type: "double-click" }, dismissContext.ctx);
  assert.equal(dismissContext.pops(), 1, "double-tap closes the detail after dismissal");
  assert.deepEqual(dismissedNotificationKeys(), [
    ["triage", notification.key],
    ["native", notification.key],
  ], "double-tap uses the same triage and Android dismissal authority as the Dismiss row");
});
