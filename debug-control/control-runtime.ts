import { Application, Utils } from "@nativescript/core";
import type { DashboardSnapshot } from "../app/g2/dashboard-controller";
import { directNotificationInbox } from "../app/assistant/direct-notification-inbox";
import { directNotificationStore } from "../app/assistant/direct-notification-store";
import { assistantBridge } from "../app/assistant/bridge-client";
import { shell } from "../app/ui/shell/shell";
import { DebugControlHarness, type DebugFixtureResult } from "./control-protocol";

const DEBUG_CONTROL_BUNDLE_MARKER = "HERMES_DEBUG_CONTROL_RUNTIME_V1";
void DEBUG_CONTROL_BUNDLE_MARKER;

declare const com: any;
declare const android: any;

type Controller = {
  snapshot(): DashboardSnapshot;
  subscribe(listener: (snapshot: DashboardSnapshot) => void): () => void;
  launchDebugAllowlistedApp(appId: string): Promise<void>;
};

let installed = false;
let handlerProxy: any = null;
let fixtureController: any = null;
let harness: DebugControlHarness | null = null;
let unsubscribe: (() => void) | null = null;
let exitHandler: (() => void) | null = null;

// Keep the debug-only Android receiver type name out of release bundles/metadata.
// The receiver itself exists only in the Android debug source set.
const debugReceiver = (): any => com.faceclaw.app[["Faceclaw", "DebugControl", "Receiver"].join("")];

export function registerDebugControl(controller: Controller): void {
  if (!global.isAndroid || installed || !com.faceclaw.app.BuildConfig.DEBUG) return;
  installed = true;

  const processGeneration = `p-${android.os.Process.myPid()}-${android.os.SystemClock.elapsedRealtime()}`;
  let sessionGeneration = 1;
  let windowGeneration = 1;
  let captureGeneration = 0;
  let voiceTest = false;
  let previousPhase = controller.snapshot().phase;
  let previousWindowId = shell.foregroundWindow()?.windowId ?? "none";

  const refreshWindowGeneration = (): string => {
    const current = shell.foregroundWindow()?.windowId ?? "none";
    if (current !== previousWindowId) {
      previousWindowId = current;
      windowGeneration++;
    }
    return current;
  };

  const stopFixture = async (): Promise<void> => {
    const owned = fixtureController;
    fixtureController = null;
    if (voiceTest) captureGeneration++;
    voiceTest = false;
    if (owned) owned.stopDebugFixtureTest();
  };

  harness = new DebugControlHarness({
    state: () => {
      const notificationSnapshot = directNotificationStore.snapshot();
      const inboxDiagnostics = directNotificationInbox.getDiagnostics();
      return {
        online: controller.snapshot().phase === "connected",
        cockpitOnline: assistantBridge.cockpit.snapshot().synchronized,
        screenOn: shell.isScreenOn(),
        windowId: refreshWindowGeneration(),
        directNotifications: {
          available: notificationSnapshot.available,
          pendingCount: notificationSnapshot.pending.length,
          wearState: directNotificationInbox.getWearState(),
          presentationSlotAvailable: shell.canStartDirectAssistantResultPresentation(),
          ...inboxDiagnostics,
        },
        processGeneration,
        sessionGeneration,
        windowGeneration,
        captureGeneration,
        voiceTest,
      };
    },
    wake: async () => { shell.wake("sidebar"); },
    blank: async () => { shell.sleep(); },
    open: async (appId) => { await controller.launchDebugAllowlistedApp(appId); refreshWindowGeneration(); },
    voiceStart: async (endpointing) => {
      const context = Utils.android.getApplicationContext();
      if (!context) throw new Error("unavailable");
      fixtureController = new com.faceclaw.app.FaceclawVoiceController(context);
      fixtureController.startDebugFixtureTest(endpointing);
      voiceTest = true;
      captureGeneration++;
    },
    voiceStop: stopFixture,
    fixture: async (fixture): Promise<DebugFixtureResult> => {
      if (!fixtureController || !voiceTest) throw new Error("unavailable");
      const result = String(fixtureController.injectDebugFixture(fixture));
      if (!/^endpoint=(true|false);transcript=(empty|nonempty)$/.test(result)) throw new Error("invalid result");
      return {
        endpoint: result.includes("endpoint=true"),
        transcript: result.endsWith("nonempty") ? "nonempty" : "empty",
      };
    },
  });

  unsubscribe = controller.subscribe((snapshot) => {
    if (snapshot.phase !== previousPhase) {
      previousPhase = snapshot.phase;
      sessionGeneration++;
      if (snapshot.phase !== "connected") void harness?.cleanup();
    }
  });

  const receiver = debugReceiver();
  handlerProxy = new receiver.Handler({
    dispatch: (request: string, callback: any) => {
      void harness!.dispatch(String(request)).then(
        (receipt) => callback.complete(JSON.stringify(receipt)),
        () => callback.complete('{"ok":false,"code":"failed"}'),
      );
    },
  });
  receiver.register(handlerProxy);

  exitHandler = () => {
    void harness?.cleanup();
    unsubscribe?.();
    unsubscribe = null;
    receiver.unregister();
    handlerProxy = null;
    installed = false;
  };
  Application.on(Application.exitEvent, exitHandler);
}
