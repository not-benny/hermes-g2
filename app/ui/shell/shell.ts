import { G2_LENS_HEIGHT, G2_LENS_WIDTH, GrayImage } from "../../graphics/image";
import { getDefaultMediumFont, getDefaultSmallFont } from "../../graphics/bdffont";
import { truncateText, wrapText } from "../../graphics/textwrap";
import { EvenAIStatus, EventSourceType, OsEventTypeList } from "../../g2/events";
import type { RawInputEvent } from "../../native/faceclaw-communicator";
import type { AndroidNotification } from "../../native/notification-icons";
import { DashboardInputEvent, Layer, LayerActions, LayerContext, LayerStack, noopLayerActions } from "../layers";
import { MenuLayer, type MenuItem } from "../menu";
import { VoiceInputLayer, type VoiceSendTarget } from "./voice-input";
import { AssistantLayer } from "./assistant";
import { assistantReplyNeedsOverlay } from "./assistant-routing";
import { AssistantSession, type AssistantBackendConfig } from "../../assistant/session";
import { resolveAssistantModel } from "../../assistant/models";
import type { AssistantContext } from "../../assistant/types";
import { NotificationDigestLayer, SingleNotificationLayer } from "../notifications";
import { assistantBridge, type AssistantBridgePhase } from "../../assistant/bridge-client";
import {
  anthropicApiKeySetting,
  assistantBackendSetting,
  assistantBridgeHostSetting,
  assistantBridgeTokenSetting,
  resolveAssistantBridgePort,
  assistantModelSetting,
  assistantSkipConfirmationSetting,
  batteryDisplayModeSetting,
  brightnessSetting,
  onAnySettingChanged,
  openAiApiKeySetting,
  ringScrollMinIntervalMs,
  ringSensitivitySetting,
  timeFormatSetting,
  wakeWordActionSetting,
  voiceControlEnabledSetting,
} from "../dashboard-settings";
import { ShellChromeLayer, sidebarLeftColumnUsed, type ShellChromeState, type ShellChromeWindow } from "./chrome-layer";
import { EdgeBounce, EdgeWrapScroller } from "../edge-scroll";
import { GESTURE_CLICK, GESTURE_DOUBLE_CLICK } from "../gestures";
import { ShellModalLayer } from "./modal-layer";
import { ToolDebugMenuLayer } from "./tool-debug-layer";
import { playEventBeep } from "../event-beeps";
import {
  isReadinessFrameEvidenceOutcome,
  isSuccessfulFrameOutcome,
} from "../../g2/display-frame-outcomes";
import {
  AssistantResultWakeOwnership,
  prepareAtomicAssistantResultLayer,
  type AssistantResultWakeLease,
} from "./assistant-result-wake";
import { awaitWithAbortSignal, isStrictLayerOwner, startDetachedCleanup } from "./strict-layer-owner";
import { MusicCardLayer } from "./music-card";
import { NotificationCardLayer } from "./notification-card";
import { ClockAlertLayer, type ClockAlertVisualState } from "./clock-alert-layer";
import {
  nextWindowManagementIndex,
  selectionIndexAfterManagementRemoval,
} from "./window-management-selection";
import { toolRegistry } from "../../assistant/tool-registry";
import type { RenderViewState } from "../../assistant/render-view";
import type { DynamicAppState } from "../../assistant/dynamic-app";
import { ShellRemoteViewLayer } from "./render-view-layer";
import { ShellDynamicAppLayer } from "./dynamic-app-layer";
import { shouldRestoreDisplacedAssistant } from "./dynamic-app-rollback";
import { deferAssistantOnlyAnswerClose } from "./assistant-only-close";
import { formatDirectNotificationHeaderParts } from "../../assistant/direct-notification-format";
import {
  assistantCardRect,
  MIN_WINDOW_HEIGHT,
  minWindowTop,
  SIDEBAR_COLUMN_WIDTH,
  SIDEBAR_WIDTH,
  TOP_BAR_HEIGHT,
  windowTop,
  type WindowHeightMode,
} from "./geometry";

/**
 * The shell: owns the window registry, focus, screen on/off, and the shell
 * surface (sidebar + top bar + shell overlays such as the escape menu and
 * the voice dialog). Runs on the main thread; windows are hosted in-process
 * or in per-app worker threads.
 *
 * Input flow: every event enters via receiveInput. The shell consumes
 * everything while the sidebar or a shell overlay has focus and forwards the
 * rest to the focused window. Long-press goes to the foreground window (from
 * the sidebar it focuses the window first); by convention apps answer it with
 * a window menu that ends in Voice input / Close window. Holding the press
 * past the escape threshold opens the shell's own escape menu, so the shell
 * keeps working when a window's handler hangs.
 */

export type ShellWindow = {
  appId: string;
  windowId: string;
  title: string;
  /** Compositor surface this window renders to; configured at connect / launch. */
  surfaceId: string;
  /** Whether close menu entries (app menu default, shell escape menu) apply (the launcher is pinned). */
  closeable: boolean;
  /**
   * Window height: the standard 288px band ("min") or the full screen
   * ("max", terminal views). Decides the surface rect and where the shell
   * draws this window's top bar.
   */
  heightMode: WindowHeightMode;
  /** App-side cleanup when the shell closes the window (worker notification, surface removal). */
  close?: () => void;
  drawIcon: ShellChromeWindow["drawIcon"];
  /**
   * Handle an input event the shell forwarded. Ownership of frameId (latency
   * tracking) passes to the window: it must eventually reach a frame submit
   * or a finishFrame call.
   */
  handleInput: (event: DashboardInputEvent, frameId: number) => Promise<void> | void;
  /** Repaint and resubmit this window's surface. */
  requestRender: () => void;
  /**
   * The controller configured this window's compositor surface; deferred
   * first renders may flush now. Optional: windows created through
   * launchInProcessApp are marked by the controller directly, but
   * boot-registered windows (the launcher) are only reachable through the
   * shell's window list, so the connect-time surface pass uses this hook.
   */
  markSurfaceReady?: () => void;
  /**
   * Deliver a text string to the window (e.g. finalized voice input). Optional:
   * only windows that consume typed text (the terminal) implement it.
   */
  receiveTextInput?: (text: string) => void;
  /** Foreground state changed: this window's surface is (not) the visible one. */
  setForeground?: (foreground: boolean) => void;
  /** Screen turned on/off; hidden or screen-off windows should stop painting. */
  setScreenOn?: (on: boolean) => void;
  /** Shell voice capture preempts app-owned continuous microphone capture. */
  setVoiceInputActive?: (active: boolean) => void;
};

export type ShellConfig = {
  /** Actions handed to shell overlay layers; requestRender must re-render the shell surface. */
  actions: LayerActions;
  getScreenTimeoutMs: () => number | null;
  requestShellRender: () => void | Promise<void>;
  /** Awaited delivery path for operations that must prove lens transport success. */
  requestShellDelivery?: (
    isAllowed?: () => boolean,
    requireSent?: boolean,
  ) => Promise<{ frameId: number; outcome: string }>;
  /** Drain ordinary/coalesced shell work before a strict layer becomes visible. */
  waitForShellRenderIdle?: () => Promise<void>;
  /** True only while a real glasses transport/session can accept frames. */
  isDisplayAvailable?: () => boolean;
  /** True only when no opaque device-owned surface hides assistant output. */
  isAssistantResultPresentationAllowed?: () => boolean;
  /** Retire Clock feedback only after its timeline/audio campaign is terminal. */
  releaseTerminalClockAlertVisual?: () => boolean;
  /** Direct Hermes notifications additionally require a confirmed current wear snapshot. */
  isDirectAssistantResultPresentationAllowed?: () => boolean;
  /** Wake and await the real display lifecycle before presenting a completed assistant turn. */
  prepareAssistantResultDisplay?: (isAllowed?: () => boolean) => Promise<boolean>;
  /** Sleep-origin in-turn results keep their wake provisional through strict frame ACK. */
  prepareIsolatedAssistantResultDisplay?: (
    isAllowed: () => boolean,
  ) => Promise<AssistantResultDisplayPreparation>;
  /** Direct results retain provisional wake ownership until their own frame ACK. */
  prepareDirectAssistantResultDisplay?: (
    isAllowed: () => boolean,
  ) => Promise<AssistantResultDisplayPreparation>;
  /** Acquire a physically blank display and hide retained app surfaces before a music wake. */
  prepareMusicCardDisplay?: (isAllowed: () => boolean) => Promise<boolean>;
  /** Reveal only the already-primed retained Now Playing composite. */
  revealMusicCardDisplay?: (isAllowed: () => boolean) => Promise<boolean>;
  /** Screen on/off changed: the controller blanks/unblanks the compositor. */
  onScreenStateChanged: (on: boolean) => void;
  /** Hide retained app surfaces while a sleeping long-press is assistant-only. */
  setAssistantOnlyPresentation?: (active: boolean) => void;
  /** Release the dedicated Now Playing surface lease after commit or rollback. */
  releaseMusicCardPresentationIsolation?: () => Promise<void>;
  /** Notification cards share the same owner-neutral blanked compositor lease. */
  isNotificationPresentationAllowed?: () => boolean;
  prepareNotificationCardDisplay?: (isAllowed: () => boolean) => Promise<boolean>;
  revealNotificationCardDisplay?: (isAllowed: () => boolean) => Promise<boolean>;
  releaseNotificationCardPresentationIsolation?: () => Promise<void>;
  /** A foreground shell blocker closed; retry the phone-owned direct inbox. */
  onDirectNotificationOpportunity?: () => void;
  /** Window registered/removed or foreground changed (persists the open-app list). */
  onWindowsChanged?: () => void;
  /** The Health side card was hidden/shown (persists the choice). */
  onHealthHiddenChanged?: (hidden: boolean) => void;
};

export type AssistantResultDisplayPreparation = {
  ready: boolean;
  commit: () => void;
  rollback: () => void;
};

export type DirectAssistantResultDeliveryReceipt = {
  acknowledged: true;
  /** False when authorization ended only after the physical frame ACK. */
  successAllowed: boolean;
};

export type DirectAssistantResultCloseReason = "dismissed" | "sleep" | "preempted";

export type DirectAssistantResultPresentation = {
  receivedAtMs: number;
  position: number;
  total: number;
  /** Securely tombstone the FIFO record before the provisional wake commits. */
  onStrictFrameAcknowledged: () => void;
  onClosed: (reason: DirectAssistantResultCloseReason) => void;
};

/** Which surfaces need re-rendering after an input event. */
export type ShellInputOutcome = { shell: boolean; window: boolean };

type FocusKind = "sidebar" | "window";

export type WindowFocusClaim = {
  windowId: string;
  epoch: number;
  selectionRevision: number;
};

const noopActions: LayerActions = noopLayerActions;

/**
 * Hold a long-press this much past the long-press event (which the firmware
 * itself only fires after a shorter hold) and the shell opens its own escape
 * menu — the recovery path when an app ignores or mishandles the gesture.
 */
const LONG_PRESS_ESCAPE_MENU_MS = 4000;

/** Shell-surface overlay menu (the escape menu); closing it returns focus to the sidebar. */
class ShellOverlayMenuLayer extends MenuLayer {
  constructor(items: MenuItem[], private readonly onClosed: () => void) {
    // Aligned to the min-height window band (like the sidebar), wherever the
    // vertical position setting currently puts it.
    super(null, items, {
      x: SIDEBAR_WIDTH + 8,
      y: minWindowTop() + TOP_BAR_HEIGHT + 8,
      width: 272,
      minHeight: 0,
    });
  }

  onRemoved(): void {
    this.onClosed();
  }
}

/** How long an ordinary show_alert popup stays before auto-dismissing. */
const ALERT_DISMISS_MS = 6000;
const ALERT_PADDING = 16;
const ALERT_LINE_HEIGHT = 16;
const ALERT_MAX_BODY_LINES = 4;
const ALERT_BASE_HEIGHT = 64;
type ShellAlertLifetime = "transient" | "until-dismiss-or-sleep";
type ShellAlertOptions = {
  header?: string;
  /** Drawn at the right edge so FIFO position survives leading truncation. */
  headerTrailing?: string;
  /** Completed Hermes replies may start reviewed voice follow-up on one click. */
  onReply?: () => void;
  onRemoved?: (reason: DirectAssistantResultCloseReason) => void;
};

/**
 * A compact text popup on the shell surface. Ordinary show_alert notices are
 * transient; completed assistant results opt into persistence so they remain
 * readable until the user dismisses them or the global screen timeout sleeps
 * the display.
 */
class ShellAlertLayer implements Layer {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private removed = false;
  private closeReason: DirectAssistantResultCloseReason = "preempted";

  constructor(
    private readonly text: string,
    private readonly onDismiss: () => void,
    private readonly lifetime: ShellAlertLifetime = "transient",
    private readonly options: ShellAlertOptions = {},
  ) {}

  /** Arm an ordinary notice only after its candidate frame is acknowledged. */
  armTransientDismissTimer(): void {
    if (this.lifetime !== "transient" || this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.onDismiss();
    }, ALERT_DISMISS_MS);
  }

  markCloseReason(reason: DirectAssistantResultCloseReason): void {
    this.closeReason = reason;
  }

  paint(ctx: LayerContext, paintBelow: () => GrayImage): GrayImage {
    const image = paintBelow();
    const small = getDefaultSmallFont();
    const medium = getDefaultMediumFont();
    const sizing = assistantCardRect(ctx.stack.getBaseSize(), ALERT_BASE_HEIGHT + ALERT_LINE_HEIGHT);
    const contentWidth = sizing.width - ALERT_PADDING * 2;
    const wrapped = wrapText(small, this.text, contentWidth);
    const lines = wrapped.slice(0, ALERT_MAX_BODY_LINES);
    if (wrapped.length > ALERT_MAX_BODY_LINES && lines.length) {
      lines[lines.length - 1] = truncateText(small, `${lines[lines.length - 1]}...`, contentWidth);
    }
    const rect = assistantCardRect(
      ctx.stack.getBaseSize(),
      ALERT_BASE_HEIGHT + Math.max(1, lines.length) * ALERT_LINE_HEIGHT,
    );
    const left = rect.x + ALERT_PADDING;
    image.fillRoundedRect(rect.x, rect.y, rect.width, rect.height, 1, 12);
    image.drawRoundedRect(rect.x, rect.y, rect.width, rect.height, 100, 12);
    const headerTrailing = this.options.headerTrailing ?? "";
    const trailingWidth = headerTrailing ? medium.measureText(headerTrailing) : 0;
    const leadingWidth = Math.max(1, contentWidth - trailingWidth - (headerTrailing ? 12 : 0));
    image.drawText(medium, left, rect.y + 12,
      truncateText(medium, this.options.header ?? "Hermes", leadingWidth), 240);
    if (headerTrailing) {
      image.drawText(medium, left + contentWidth - trailingWidth, rect.y + 12, headerTrailing, 190);
    }
    for (let index = 0; index < lines.length; index++) {
      image.drawText(small, left, rect.y + 36 + index * ALERT_LINE_HEIGHT, lines[index]!, 235);
    }
    const footer = this.options.onReply
      ? `${GESTURE_CLICK} reply   ${GESTURE_DOUBLE_CLICK} dismiss`
      : this.lifetime === "until-dismiss-or-sleep"
      ? `${GESTURE_CLICK} dismiss   ${GESTURE_DOUBLE_CLICK} back`
      : `${GESTURE_CLICK} dismiss`;
    image.drawText(small, left, rect.y + rect.height - 16, footer, 110);
    return image;
  }

  handleInput(event: DashboardInputEvent, _ctx: LayerContext): void {
    if (event.type === "click" && this.options.onReply) {
      this.options.onReply();
      return;
    }
    if (event.type === "click" || event.type === "double-click") {
      this.clearTimer();
      this.onDismiss();
    }
  }

  onRemoved(): void {
    this.clearTimer();
    if (this.removed) return;
    this.removed = true;
    this.options.onRemoved?.(this.closeReason);
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

/** Exact wake ownership for a shell notification modal. */
export class NotificationModalWakeOwnership<T extends object> {
  private owner: T | null = null;

  claim(modal: T): void {
    this.owner = modal;
  }

  clear(): void {
    this.owner = null;
  }

  /** Retire this identity and report whether it may return the display to sleep. */
  release(
    modal: T,
    removedWhileTop: boolean,
  ): boolean {
    const owner = this.owner;
    if (owner !== modal) return false;
    this.owner = null;
    return removedWhileTop;
  }
}

class Shell {
  private windows: ShellWindow[] = [];
  private selectedIndex = 0;
  // Edge-detent + bounce for the sidebar tab list (the "app cards").
  private readonly sidebarScroller = new EdgeWrapScroller(undefined, "sidebar");
  private readonly sidebarBounce = new EdgeBounce();
  /** Window ids in most-recently-visible-first order; closing the visible window returns to the next entry. */
  private mruWindowIds: string[] = [];
  private focus: FocusKind = "sidebar";
  // Window Management move substate: the id of the tab "picked up" by a
  // second long-press, moved with scroll and dropped with a tap. The moved
  // order is the window array order, which onWindowsChanged persists.
  private reorderingWindowId: string | null = null;
  // Unified Window Management mode: the first long-press arms select/close;
  // another long-press picks the selected movable tab for reorder. Click
  // closes in select mode or drops in move mode; double-click always exits.
  private closingActive = false;
  /** ID-owned management selection; never infer it from MRU after a removal. */
  private managementSelectedWindowId: string | null = null;
  /** Monotonic user-selection token used to reject stale focus requests. */
  private selectionRevision = 0;
  /** Only the newest async launch may claim focus after surface setup. */
  private focusClaimEpoch = 0;
  // Ring-sensitivity throttle: timestamp of the last honored scroll. A physical
  // swipe fires a burst of scroll events; at lower sensitivity we drop the ones
  // that arrive within the configured interval so one swipe steps once or twice.
  private lastScrollHonoredAtMs = 0;
  private screenOn = true;
  private lastInputAtMs = Date.now();
  /** Named foreground work that must not be interrupted by the idle display timeout. */
  private readonly screenTimeoutHolds = new Set<string>();
  private activityRevision = 0;
  private screenWakeActivityRevision = -1;
  private battery: ShellChromeState["battery"] = {
    headset: null,
    headsetCharging: null,
    ring: null,
    ringCharging: null,
  };
  /** A configured R1 stays visible in the HUD even while its battery is unknown. */
  private ringConfigured = false;
  private attention = new Map<string, boolean>();
  // App-provided top-bar tray icons, keyed by owner id; drawn between the
  // notification icons and the battery indicators.
  private readonly trayIcons = new Map<string, GrayImage>();
  private activeVoiceLayer: VoiceInputLayer | null = null;
  private assistantTurnBackgrounded = false;
  private assistantOverlayRestorePending = false;
  private assistantOverlayDelivery = false;
  private pendingAssistantResult: string | null = null;
  private pendingAssistantResultDelivery = false;
  private assistantSession: AssistantSession | null = null;
  private musicCard: MusicCardLayer | null = null;
  private musicCardWokeScreen = false;
  /** User-activity revision of this card's own provisional wake, or -1 if another owner woke it. */
  private musicCardWakeActivityRevision = -1;
  /** Exact unacknowledged card whose blank-first wake hides retained app surfaces. */
  private musicCardPresentationPending: MusicCardLayer | null = null;
  private notificationCard: NotificationCardLayer | null = null;
  private notificationCardWokeScreen = false;
  private notificationCardPresentationPending: NotificationCardLayer | null = null;
  /** Full-screen, opaque Clock alert; controller owns ring/wear dismissal. */
  private clockAlertLayer: ClockAlertLayer | null = null;
  private assistantLayer: AssistantLayer | null = null;
  /** True from a sleeping long-press until its voice result is dismissed. */
  private assistantOnlyPresentation = false;
  /** Exact sleeping PTT turn whose final answer must return in isolation. */
  private isolatedAssistantTurn: AssistantLayer | null = null;
  /** Isolation ownership moved from a completed turn to its compact result. */
  private pendingAssistantResultIsolated = false;
  /** Keeps the isolated surface leased while a result card opens follow-up capture. */
  private assistantOnlyReplyStarting = false;
  /** Assistant displaced by a context dashboard but still owning an active turn. */
  private detachedAssistantLayer: AssistantLayer | null = null;
  private alertLayer: ShellAlertLayer | null = null;
  /** Dedicated FIFO result card; ordinary show_alert never replaces it. */
  private directNotificationLayer: ShellAlertLayer | null = null;
  /** Exact direct result that woke a sleeping lens and must restore sleep. */
  private directNotificationReturnToSleep: ShellAlertLayer | null = null;
  private alertRevision = 0;
  private notifyResultRevision = 0;
  private suppressDirectNotificationOpportunity = false;
  private readonly assistantResultWakeOwnership = new AssistantResultWakeOwnership();
  private readonly notificationModalWakeOwnership =
    new NotificationModalWakeOwnership<ShellModalLayer>();
  /** Exact notification modal still awaiting its first strict physical receipt. */
  private notificationModalPresentationPending: ShellModalLayer | null = null;
  private remoteViewLayer: ShellRemoteViewLayer | null = null;
  private dynamicAppLayer: ShellDynamicAppLayer | null = null;
  /** Sleep-origin atomic answer that must return to darkness when it closes. */
  private assistantOnlyDynamicAppLayer: ShellDynamicAppLayer | null = null;
  private contextDashboardVoicePrefix: string | null = null;
  private escapeMenuTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly actions: LayerActions = { ...noopActions };
  private config: ShellConfig = {
    actions: noopActions,
    getScreenTimeoutMs: () => null,
    requestShellRender: () => {},
    onScreenStateChanged: () => {},
  };
  private readonly stack = new LayerStack(
    new ShellChromeLayer(() => this.chromeState()),
    this.actions,
    undefined,
    undefined,
    () => {
      // Covers programmatic/modal/dynamic overlay teardown paths, not only
      // voice and ordinary alert closures. Global sleep suppresses the whole
      // teardown sequence so closing an earlier overlay cannot pump FIFO.
      this.notifyDirectNotificationOpportunity();
    },
  );

  // Top-bar settings we mirror into the chrome; a change to either repaints
  // the shell surface so the top bar reflects it immediately.
  private topBarSettingsSubscribed = false;
  private lastBatteryDisplayMode: string | null = null;
  private lastTimeFormat: string | null = null;
  private lastBrightness: string | null = null;
  /** Latest ring heart rate (bpm) for the top-bar HUD, null when unknown. */
  private ringHeartRate: number | null = null;
  private lastBridgeBackend: string | null = null;
  private lastBridgeHost: string | null = null;
  /** Credential presence only; never retain the bridge secret in HUD state. */
  private lastBridgeTokenPresent: boolean | null = null;
  private bridgePhase: AssistantBridgePhase = assistantBridge.state().phase;

  configure(config: ShellConfig): void {
    this.config = config;
    this.stack.setActions(config.actions);
    this.subscribeToTopBarSettings();
  }

  private subscribeToTopBarSettings(): void {
    if (this.topBarSettingsSubscribed) return;
    this.topBarSettingsSubscribed = true;
    this.lastBatteryDisplayMode = batteryDisplayModeSetting.get();
    this.lastTimeFormat = timeFormatSetting.get();
    this.lastBrightness = brightnessSetting.get();
    this.lastBridgeBackend = assistantBackendSetting.get();
    this.lastBridgeHost = assistantBridgeHostSetting.get().trim();
    this.lastBridgeTokenPresent = assistantBridgeTokenSetting.get().length > 0;
    onAnySettingChanged(() => {
      const batteryMode = batteryDisplayModeSetting.get();
      const timeFormat = timeFormatSetting.get();
      const brightness = brightnessSetting.get();
      const bridgeBackend = assistantBackendSetting.get();
      const bridgeHost = assistantBridgeHostSetting.get().trim();
      const bridgeTokenPresent = assistantBridgeTokenSetting.get().length > 0;
      if (
        batteryMode === this.lastBatteryDisplayMode &&
        timeFormat === this.lastTimeFormat &&
        brightness === this.lastBrightness &&
        bridgeBackend === this.lastBridgeBackend &&
        bridgeHost === this.lastBridgeHost &&
        bridgeTokenPresent === this.lastBridgeTokenPresent
      ) {
        return;
      }
      this.lastBatteryDisplayMode = batteryMode;
      this.lastTimeFormat = timeFormat;
      this.lastBrightness = brightness;
      this.lastBridgeBackend = bridgeBackend;
      this.lastBridgeHost = bridgeHost;
      this.lastBridgeTokenPresent = bridgeTokenPresent;
      this.config.requestShellRender();
    });
    // The bridge glyph tracks live connection phase; repaint the bar on change.
    assistantBridge.onStateChange((state) => {
      if (state.phase === this.bridgePhase) return;
      this.bridgePhase = state.phase;
      this.config.requestShellRender();
      if (state.phase === "connected") this.retryPendingAssistantResult();
    });
    // Cockpit is a passive projection of the same authenticated G2 voice turn.
    // Its terminal row must never become a second wearer-facing result: the
    // Host MCP CallToolResult is the sole authority that completes this shell's
    // AssistantLayer. Cockpit snapshots remain available inside the app.
  }

  /** Add a window (or replace one with the same windowId, keeping its slot). */
  registerWindow(window: ShellWindow): void {
    const existing = this.windows.findIndex((w) => w.windowId === window.windowId);
    if (existing >= 0) {
      this.windows[existing] = window;
      if (existing === this.selectedIndex) this.noteWindowVisible(window.windowId);
    } else {
      this.windows.push(window);
      if (this.windows.length - 1 === this.selectedIndex) this.noteWindowVisible(window.windowId);
    }
    this.config.onWindowsChanged?.();
  }

  /** Move a window to the front of the most-recently-visible order. */
  private noteWindowVisible(windowId: string): void {
    this.mruWindowIds = this.mruWindowIds.filter((id) => id !== windowId);
    this.mruWindowIds.unshift(windowId);
  }

  /** Index of the most recently visible window still in the registry, or -1. */
  private mostRecentWindowIndex(): number {
    for (const id of this.mruWindowIds) {
      const index = this.windows.findIndex((w) => w.windowId === id);
      if (index >= 0) return index;
    }
    return -1;
  }

  removeWindow(windowId: string): void {
    const index = this.windows.findIndex((w) => w.windowId === windowId);
    if (index < 0) return;
    // A grabbed tab that gets closed drops out of reorder mode.
    if (this.reorderingWindowId === windowId) {
      this.reorderingWindowId = null;
    }
    const removedWindow = this.windows[index]!;
    const wasManagementSelected = this.managementSelectedWindowId === windowId;
    if (wasManagementSelected) this.selectedIndex = index;
    const wasSelected = index === this.selectedIndex;
    this.windows.splice(index, 1);
    this.selectionRevision++;
    this.focusClaimEpoch++;
    this.attention.delete(windowId);
    this.mruWindowIds = this.mruWindowIds.filter((id) => id !== windowId);
    if (wasSelected) {
      // Ordinary close restores MRU, but Window Management owns selection by
      // visual slot: after closing a selected card, keep that slot (or the
      // preceding card when the removed card was last). Consulting MRU here is
      // what caused Notifications/Music batch-close to jump to the top.
      const managementClose = this.closingActive && wasManagementSelected;
      const nextIndex = selectionIndexAfterManagementRemoval(index, this.windows.length);
      const mruIndex = this.mostRecentWindowIndex();
      this.selectedIndex = managementClose
        ? nextIndex
        : mruIndex >= 0 ? mruIndex : nextIndex;
    } else if (this.selectedIndex > index) {
      this.selectedIndex--;
    }
    if (this.focus === "window" && (wasSelected || !this.windows.length)) {
      this.focus = "sidebar";
    }
    if (wasSelected) {
      // Hand the foreground to whatever is now selected.
      removedWindow.setForeground?.(false);
      const next = this.windows[this.selectedIndex];
      if (next) {
        this.noteWindowVisible(next.windowId);
        next.setForeground?.(true);
        next.requestRender();
      }
    }
    if (wasManagementSelected) {
      this.managementSelectedWindowId = this.windows[this.selectedIndex]?.windowId ?? null;
    } else if (this.managementSelectedWindowId) {
      // Keep ID ownership stable when a different card is removed before it.
      const managementIndex = this.windows.findIndex((w) => w.windowId === this.managementSelectedWindowId);
      if (managementIndex >= 0) this.selectedIndex = managementIndex;
    }
    this.config.onWindowsChanged?.();
    this.config.requestShellRender();
  }

  // --- Health side card ------------------------------------------------------
  // A pinned, uncloseable card kept directly under the launcher. Hiding reuses
  // removeWindow (which does NOT close the window, so its surface + object
  // survive); unhiding splices the same object back at its slot.
  private healthWindow: ShellWindow | null = null;
  private healthHidden = false;

  /** Register the Health card and place it directly under the launcher. */
  registerHealthWindow(window: ShellWindow): void {
    this.healthWindow = window;
    this.insertHealthAtSlot();
  }

  /** Splice the Health card in under the launcher (idempotent). */
  private insertHealthAtSlot(): void {
    const w = this.healthWindow;
    if (!w || this.windows.some((x) => x.windowId === w.windowId)) return;
    const launcherIndex = this.windows.findIndex((x) => x.windowId === "launcher");
    const insertAt = launcherIndex >= 0 ? launcherIndex + 1 : Math.min(1, this.windows.length);
    this.windows.splice(insertAt, 0, w);
    // Keep the currently-selected window selected (inverse of removeWindow's
    // decrement) so the sidebar highlight does not jump when health reappears.
    if (insertAt <= this.selectedIndex) this.selectedIndex++;
    if (this.closingActive && this.managementSelectedWindowId) {
      const managedIndex = this.windows.findIndex((window) => window.windowId === this.managementSelectedWindowId);
      if (managedIndex >= 0) this.selectedIndex = managedIndex;
    }
    this.config.onWindowsChanged?.();
    this.config.requestShellRender();
  }

  /** Show or hide the Health side card. */
  setHealthHidden(hidden: boolean, opts?: { persist?: boolean }): void {
    if (hidden === this.healthHidden) return;
    this.healthHidden = hidden;
    if (hidden) {
      if (this.healthWindow) this.removeWindow(this.healthWindow.windowId);
    } else {
      this.insertHealthAtSlot();
    }
    if (opts?.persist !== false) this.config.onHealthHiddenChanged?.(hidden);
  }

  isHealthHidden(): boolean {
    return this.healthHidden;
  }

  /** Close a window by id, if it is closeable (menu actions route here). */
  closeWindow(windowId: string): void {
    const window = this.windows.find((w) => w.windowId === windowId);
    if (!window || !window.closeable) return;
    try {
      window.close?.();
    } catch (error) {
      console.warn(`window ${window.windowId} close failed`, error);
    }
    this.removeWindow(window.windowId);
  }

  /** Close the foreground window via the shell (escape menu action). */
  closeForegroundWindow(): void {
    const window = this.foregroundWindow();
    if (window) this.closeWindow(window.windowId);
  }

  getWindows(): readonly ShellWindow[] {
    return this.windows;
  }

  setWindowAttention(windowId: string, attention: boolean): void {
    if (Boolean(this.attention.get(windowId)) === attention) return;
    this.attention.set(windowId, attention);
    this.config.requestShellRender();
  }

  /** Latest ring heart rate for the HUD; repaints the top bar on change. */
  setRingHeartRate(bpm: number | null): void {
    const next = bpm !== null && Number.isFinite(bpm) ? Math.round(bpm) : null;
    if (next === this.ringHeartRate) return;
    this.ringHeartRate = next;
    this.config.requestShellRender();
  }

  setRingConfigured(configured: boolean): void {
    if (configured === this.ringConfigured) return;
    this.ringConfigured = configured;
    this.config.requestShellRender();
  }

  setBatteryLevels(levels: Partial<ShellChromeState["battery"]>): void {
    this.battery = { ...this.battery, ...levels };
  }

  /**
   * Set or clear an app's top-bar tray icon (a small grayscale image, drawn
   * between the notification icons and the battery indicators). Small and
   * infrequently updated by design; not a framebuffer.
   */
  setTrayIcon(ownerId: string, icon: GrayImage | null): void {
    if (icon) {
      this.trayIcons.set(ownerId, icon);
    } else if (!this.trayIcons.delete(ownerId)) {
      return;
    }
    this.config.requestShellRender();
  }

  isScreenOn(): boolean {
    return this.screenOn;
  }

  /** Physical G2 transport availability, independent of current screen power. */
  isDisplayTransportAvailable(): boolean {
    return this.config.isDisplayAvailable ? this.config.isDisplayAvailable() : this.screenOn;
  }

  /** The dedicated result slot may wake from sleep, but never steals another shell overlay. */
  canStartDirectAssistantResultPresentation(): boolean {
    return Boolean(
      this.config.requestShellDelivery &&
      !this.assistantOnlyPresentation &&
      !this.hasOpaqueCardPresentation() &&
      this.directNotificationLayer === null &&
      this.activeVoiceLayer === null &&
      this.stack.isAtBase(),
    );
  }

  private notifyDirectNotificationOpportunity(): void {
    if (this.screenOn && !this.suppressDirectNotificationOpportunity) {
      this.config.onDirectNotificationOpportunity?.();
    }
  }

  /** Retry retained assistant UI after either transport recovers. */
  retryPendingAssistantResult(): void {
    this.flushDeferredAssistantUi();
    this.notifyDirectNotificationOpportunity();
  }

  /** Current headset battery levels (for the assistant's get_state tool). */
  getBatteryLevels(): ShellChromeState["battery"] {
    return this.battery;
  }

  /**
   * The foreground app, or null when only the launcher is showing. The launcher
   * is a pinned window but counts as "no app" for the assistant's context.
   */
  getForegroundApp(): { appId: string; title: string } | null {
    const window = this.foregroundWindow();
    if (!window || window.appId === "launcher") return null;
    return { appId: window.appId, title: window.title };
  }

  noteUserActivity(nowMs = Date.now()): void {
    this.activityRevision++;
    this.restartScreenTimeout(nowMs);
    this.assistantResultWakeOwnership.invalidate();
  }

  /** Opaque cards exclusively own both pixels and input until explicitly preempted. */
  private hasOpaqueCardPresentation(): boolean {
    return this.musicCard !== null ||
      this.musicCardPresentationPending !== null ||
      this.notificationCard !== null ||
      this.notificationCardPresentationPending !== null;
  }

  /** A deferred assistant final must not claim a sleep-origin card's provisional wake. */
  private noteAssistantResultActivity(): void {
    if (this.hasOpaqueCardPresentation()) return;
    this.noteUserActivity();
  }

  /** Re-baseline idle sleep without claiming or invalidating a provisional wake. */
  private restartScreenTimeout(nowMs = Date.now()): void {
    this.lastInputAtMs = nowMs;
  }

  /**
   * Acquire or release an exact idle-timeout hold. Generation-bearing keys let
   * a late async cleanup retire only its own capture, never a newer one.
   */
  setScreenTimeoutHold(key: string, active: boolean): void {
    if (!key) return;
    if (active) {
      this.screenTimeoutHolds.add(key);
      return;
    }
    const removed = this.screenTimeoutHolds.delete(key);
    if (removed && this.screenTimeoutHolds.size === 0 && this.screenOn) {
      this.restartScreenTimeout();
    }
  }

  /** Turn the screen on (if off) and set focus. Returns whether it was off. */
  wake(focus: FocusKind, nowMs = Date.now()): boolean {
    this.noteUserActivity(nowMs);
    this.focus = focus;
    if (this.screenOn) return false;
    this.screenOn = true;
    this.screenWakeActivityRevision = this.activityRevision;
    this.config.onScreenStateChanged(true);
    for (const window of this.windows) {
      window.setScreenOn?.(true);
    }
    this.flushDeferredAssistantUi();
    this.notifyDirectNotificationOpportunity();
    // Refresh the foreground window; the compositor restored its retained
    // frame, but its content may be stale (e.g. a running stopwatch).
    this.foregroundWindow()?.requestRender();
    return true;
  }

  /** Turn the screen off, closing any shell overlays. Sidebar selection is kept. */
  sleep(): void {
    this.assistantResultWakeOwnership.invalidate();
    this.notificationModalWakeOwnership.clear();
    this.notificationModalPresentationPending = null;
    if (!this.screenOn) return;
    this.cancelEscapeMenuTimer();
    this.exitWindowManagement();
    this.suppressDirectNotificationOpportunity = true;
    try {
      // A remote MCP view is transient and must not survive a display-off
      // transition in retained manager state or reappear after wake.
      this.remoteViewLayer?.close();
      this.dynamicAppLayer?.close();
      const detachedAssistant = this.detachedAssistantLayer;
      this.detachedAssistantLayer = null;
      detachedAssistant?.onRemoved();
      this.screenOn = false;
      this.directNotificationLayer?.markCloseReason("sleep");
      this.stack.clearToBase();
      // clearToBase pops cards and fires onRemoved (timers cleared); retire exact
      // layer identities so an in-flight strict result cannot survive this sleep.
      this.alertLayer = null;
      this.directNotificationLayer = null;
      this.directNotificationReturnToSleep = null;
      this.clockAlertLayer = null;
      this.alertRevision++;
      this.musicCard = null;
      this.musicCardWokeScreen = false;
      this.musicCardWakeActivityRevision = -1;
      const musicCardPresentationWasPending = this.musicCardPresentationPending !== null;
      this.musicCardPresentationPending = null;
      this.notificationCard = null;
      this.notificationCardWokeScreen = false;
      const notificationCardPresentationWasPending =
        this.notificationCardPresentationPending !== null;
      this.notificationCardPresentationPending = null;
      for (const window of this.windows) {
        window.setScreenOn?.(false);
      }
      // Queue the physical/compositor blank before restoring any retained app
      // surface hidden by an assistant-only lease. Both operations share the
      // communicator's serialized Java-call boundary, preventing a one-frame
      // HUD flash as sleep-origin voice capture closes.
      this.config.onScreenStateChanged(false);
      if (musicCardPresentationWasPending) {
        void this.config.releaseMusicCardPresentationIsolation?.();
      }
      if (notificationCardPresentationWasPending) {
        void this.config.releaseNotificationCardPresentationIsolation?.();
      }
      this.setAssistantOnlyPresentation(false);
    } finally {
      this.suppressDirectNotificationOpportunity = false;
    }
  }

  /** Acquire rollback ownership only for an off/shared-pending result wake. */
  acquireAssistantResultWake(focus: FocusKind): AssistantResultWakeLease {
    return this.assistantResultWakeOwnership.acquire(
      this.screenOn,
      () => this.wake(focus),
      () => this.restartScreenTimeout(),
    );
  }

  /** An authorized result claims the shared wake, preventing later rollback. */
  commitAssistantResultWake(lease: AssistantResultWakeLease): void {
    this.assistantResultWakeOwnership.commit(lease);
  }

  /** Roll back only the exact still-unclaimed wake created for this result. */
  rollbackAssistantResultWake(lease: AssistantResultWakeLease): boolean {
    return this.assistantResultWakeOwnership.rollback(
      lease,
      () => this.screenOn,
      () => this.sleep(),
    );
  }

  /**
   * Reserve an async launch's right to focus its window after surface setup.
   * A later launch or any user/sidebar selection invalidates this claim.
   */
  reserveWindowFocusClaim(windowId: string): WindowFocusClaim {
    this.focusClaimEpoch++;
    return {
      windowId,
      epoch: this.focusClaimEpoch,
      selectionRevision: this.selectionRevision,
    };
  }

  /** Foreground and focus a window by id (e.g. a wake path opening content in it). */
  focusWindow(windowId: string, claim?: WindowFocusClaim): boolean {
    if (this.closingActive) return false;
    if (claim && (
      claim.windowId !== windowId ||
      claim.epoch !== this.focusClaimEpoch ||
      claim.selectionRevision !== this.selectionRevision
    )) return false;
    const index = this.windows.findIndex((w) => w.windowId === windowId);
    if (index < 0) return false;
    this.setSelectedIndex(index);
    this.focus = "window";
    return true;
  }

  /** Idle timeout: sleep if the configured timeout elapsed. Returns whether it slept. */
  applyScreenTimeout(nowMs = Date.now()): boolean {
    const timeoutMs = this.config.getScreenTimeoutMs();
    if (timeoutMs === null || !this.screenOn) return false;
    // An open voice dialog suspends the timeout: a long dictation or refine
    // has no button presses, but the screen must stay on for it. Sliding
    // lastInputAtMs forward also restarts the full timeout when it closes.
    // A visible in-flight assistant turn suspends it for the same reason. A
    // background turn is intentionally silent and must not keep a forgotten
    // display awake while the agent works.
    const visibleAssistantTurn =
      this.assistantSession?.isTurnActive() &&
      this.assistantLayer !== null &&
      !this.assistantTurnBackgrounded;
    if (
      this.activeVoiceLayer ||
      visibleAssistantTurn ||
      this.screenTimeoutHolds.size > 0 ||
      this.musicCard ||
      this.notificationCard
    ) {
      // Live capture and shell cards own their display lifetime; keep moving
      // the baseline so releasing the last owner starts a full idle interval.
      this.lastInputAtMs = nowMs;
      return false;
    }
    if (nowMs - this.lastInputAtMs < timeoutMs) return false;
    this.sleep();
    return true;
  }

  /**
   * Present a fresh Android notification as an opaque card. Screen-off delivery
   * is primed behind compositor black, so retained dashboard state never
   * appears first. Clicking transfers prior-state ownership to the full detail.
   */
  async openNotificationCard(
    notificationKey: string,
    revision: string,
    retainedNotification: AndroidNotification,
    retainedReason: string,
    digestEntries?: readonly {
      key: string;
      revision: string;
      reason: string;
      notification: AndroidNotification;
    }[],
  ): Promise<boolean> {
    // Fresh-notification cards are a sleep-origin presentation. Never replace
    // an already-visible HUD, app, dialogue, or Now Playing card just because
    // a phone notification arrived. A second notification may replace an
    // existing card only when that card itself woke the sleeping display.
    const replacingSleepOriginCard =
      this.notificationCard !== null && this.notificationCardWokeScreen;
    if (
      (this.screenOn && !replacingSleepOriginCard) ||
      this.clockAlertLayer !== null ||
      this.assistantOnlyPresentation ||
      this.activeVoiceLayer ||
      this.musicCardPresentationPending !== null ||
      (this.config.isNotificationPresentationAllowed &&
        !this.config.isNotificationPresentationAllowed()) ||
      !this.config.requestShellDelivery
    ) return false;

    const beganScreenOff = !this.screenOn;
    let returnToSleep = beganScreenOff;
    if (this.notificationCard) {
      const previous = this.notificationCard;
      returnToSleep ||= this.notificationCardWokeScreen;
      this.stack.remove(previous);
      this.notificationCard = null;
      this.notificationCardWokeScreen = false;
    }
    if (this.musicCard) {
      const music = this.musicCard;
      returnToSleep ||= this.musicCardWokeScreen &&
        this.musicCardWakeActivityRevision === this.activityRevision;
      this.stack.remove(music);
      this.musicCard = null;
      this.musicCardWokeScreen = false;
      this.musicCardWakeActivityRevision = -1;
      if (this.musicCardPresentationPending === music) {
        this.musicCardPresentationPending = null;
        await this.config.releaseMusicCardPresentationIsolation?.();
      }
    }
    if (!this.stack.isAtBase()) return false;

    this.assistantResultWakeOwnership.invalidate();
    let card: NotificationCardLayer;
    const close = () => { void this.closeNotificationCard(card); };
    const open = () => {
      void this.openNotificationCardDetail(
        card,
        notificationKey,
        revision,
        retainedNotification,
        retainedReason,
        digestEntries,
      );
    };
    card = new NotificationCardLayer({
      notification: retainedNotification,
      reason: retainedReason,
      onOpen: open,
      onDismissed: close,
    });
    this.notificationCard = card;
    // A replacement inherits an existing sleep-origin card's ownership. A
    // genuinely screen-off transaction claims wake ownership only after its
    // own wake succeeds; a manual HUD wake during preparation must win.
    this.notificationCardWokeScreen = returnToSleep && !beganScreenOff;
    this.stack.push(card);
    const isInstalledOwner = () =>
      this.notificationCard === card &&
      (!this.config.isNotificationPresentationAllowed ||
        this.config.isNotificationPresentationAllowed()) &&
      this.stack.topMatches((top) => top === card);

    if (beganScreenOff) {
      if (
        !this.config.prepareNotificationCardDisplay ||
        !this.config.revealNotificationCardDisplay ||
        !this.config.releaseNotificationCardPresentationIsolation ||
        (this.config.isDisplayAvailable && !this.config.isDisplayAvailable())
      ) {
        await this.rollbackNotificationCard(card);
        return false;
      }
      this.notificationCardPresentationPending = card;
      try {
        const ready = await this.config.prepareNotificationCardDisplay(isInstalledOwner);
        if (!ready || !isInstalledOwner() || this.screenOn) {
          throw new Error("Notification display preparation was superseded.");
        }
        card.startPresentation();
        const prime = await this.config.requestShellDelivery(isInstalledOwner, false);
        if (
          !isInstalledOwner() ||
          prime.frameId <= 0 ||
          !isReadinessFrameEvidenceOutcome(prime.outcome)
        ) throw new Error("Notification retained-frame prime was not acknowledged.");
        if (this.screenOn || !this.wake("sidebar")) {
          throw new Error("A newer wake superseded the notification card.");
        }
        this.notificationCardWokeScreen = true;
        const isOwner = () => this.screenOn && isInstalledOwner();
        if (!isOwner() || !(await this.config.revealNotificationCardDisplay(isOwner))) {
          throw new Error("Notification reveal failed.");
        }
        card.bumpDeliveryNonce();
        const receipt = await this.config.requestShellDelivery(isOwner);
        if (
          !isOwner() ||
          receipt.frameId <= 0 ||
          !isSuccessfulFrameOutcome(receipt.outcome)
        ) throw new Error("Notification card was not visibly acknowledged.");
        if (!(await this.releaseNotificationCardPresentationIsolation(card))) {
          throw new Error("Notification isolation ownership changed before acknowledgement.");
        }
        this.restartScreenTimeout();
        return true;
      } catch {
        await this.rollbackNotificationCard(card);
        return false;
      }
    }

    // An already-on lens can have an ordinary render drain that never settles
    // (for example after layout/session churn). Arm the card's own bounded
    // lifetime before entering that barrier: applyScreenTimeout deliberately
    // defers to an installed card, so waiting first would otherwise create an
    // unbounded display owner with no watchdog.
    card.startPresentation();
    try {
      if (this.config.waitForShellRenderIdle) await this.config.waitForShellRenderIdle();
      if (!isInstalledOwner() || !this.screenOn) throw new Error("Notification card was superseded.");
      card.bumpDeliveryNonce();
      const receipt = await this.config.requestShellDelivery(
        () => this.screenOn && isInstalledOwner(),
      );
      if (!isInstalledOwner() || !isSuccessfulFrameOutcome(receipt.outcome)) {
        throw new Error("Notification card was not acknowledged.");
      }
      this.restartScreenTimeout();
      return true;
    } catch {
      await this.rollbackNotificationCard(card);
      return false;
    }
  }

  private async releaseNotificationCardPresentationIsolation(
    card: NotificationCardLayer,
  ): Promise<boolean> {
    if (this.notificationCardPresentationPending !== card) return false;
    await this.config.releaseNotificationCardPresentationIsolation?.();
    if (this.notificationCardPresentationPending !== card) return false;
    this.notificationCardPresentationPending = null;
    return true;
  }

  private async openNotificationCardDetail(
    card: NotificationCardLayer,
    notificationKey: string,
    revision: string,
    retainedNotification: AndroidNotification,
    retainedReason: string,
    digestEntries?: readonly {
      key: string;
      revision: string;
      reason: string;
      notification: AndroidNotification;
    }[],
  ): Promise<void> {
    const isPresentationAllowed = () =>
      !this.config.isNotificationPresentationAllowed ||
      this.config.isNotificationPresentationAllowed();
    // Keep the opaque card installed while draining its last ordinary render.
    // Removing it before this barrier can expose the retained dashboard between
    // the click and the detail layer's strict frame.
    try {
      if (this.config.waitForShellRenderIdle) await this.config.waitForShellRenderIdle();
    } catch {
      await this.closeNotificationCard(card);
      return;
    }
    if (
      this.notificationCard !== card ||
      !this.screenOn ||
      !this.stack.topMatches((top) => top === card)
    ) return;
    if (!isPresentationAllowed()) {
      await this.closeNotificationCard(card);
      return;
    }
    const ownsPriorSleep = this.notificationCardWokeScreen;
    this.stack.remove(card);
    this.notificationCard = null;
    this.notificationCardWokeScreen = false;
    let delivered: boolean;
    try {
      if (digestEntries?.length) {
        delivered = await this.openNotificationDigest(digestEntries, ownsPriorSleep, true);
      } else {
        delivered = await this.openNotificationModal(
          notificationKey,
          revision,
          ownsPriorSleep,
          retainedNotification,
          retainedReason,
          true,
        );
      }
    } catch {
      delivered = false;
    }
    if (!delivered && ownsPriorSleep && this.screenOn && this.stack.isAtBase()) {
      this.sleep();
    }
  }

  private async rollbackNotificationCard(card: NotificationCardLayer): Promise<void> {
    if (this.notificationCard === card) {
      const exactTop = this.stack.topMatches((top) => top === card);
      this.stack.remove(card);
      this.notificationCard = null;
      const returnToSleep = this.notificationCardWokeScreen;
      this.notificationCardWokeScreen = false;
      if (returnToSleep && exactTop && this.screenOn) {
        this.sleep();
        return;
      }
    }
    await this.retireNotificationCardPresentation(card);
    this.flushDeferredAssistantUi();
    this.config.requestShellRender();
  }

  /**
   * Retire an uncommitted notification lease without ever exposing its retained
   * card frame. Keeping the pending identity through this bounded render paints
   * a compositor-safe blank after the card has left the stack. The controller's
   * ordinary render promise already has a physical-frame backpressure timeout;
   * do not add a second, potentially unbounded, render-idle drain here.
   */
  private async retireNotificationCardPresentation(card: NotificationCardLayer): Promise<void> {
    if (this.notificationCardPresentationPending !== card) return;
    try {
      await this.config.requestShellRender();
    } catch {
      // Releasing the exact blanked lease remains mandatory after render failure.
    } finally {
      if (this.notificationCardPresentationPending === card) {
        await this.releaseNotificationCardPresentationIsolation(card);
      }
    }
  }

  private async closeNotificationCard(card: NotificationCardLayer): Promise<void> {
    if (this.notificationCard !== card) return;
    const wasTop = this.stack.topMatches((top) => top === card);
    if (!wasTop && this.clockAlertLayer !== null) {
      // Clock must preempt every ordinary card, but the covered card still
      // owns the state that preceded its sleep-origin wake. Keep it retained
      // and bounded so Clock dismissal reveals the notification, not the HUD;
      // its next timeout then restores the original sleep state.
      card.deferDismissalWhileCovered();
      return;
    }
    this.stack.remove(card);
    this.notificationCard = null;
    const returnToSleep = this.notificationCardWokeScreen;
    this.notificationCardWokeScreen = false;
    if (returnToSleep && wasTop && this.screenOn) {
      this.sleep();
      return;
    }
    await this.retireNotificationCardPresentation(card);
    this.flushDeferredAssistantUi();
    this.config.requestShellRender();
  }

  /** Show the full notification dialogue, preserving a card's prior sleep state. */
  async openNotificationModal(
    notificationKey: string,
    revision: string,
    wokeScreen: boolean,
    retainedNotification: AndroidNotification,
    retainedReason: string,
    renderAlreadyDrained = false,
  ): Promise<boolean> {
    const isPresentationAllowed = () =>
      !this.config.isNotificationPresentationAllowed ||
      this.config.isNotificationPresentationAllowed();
    if (
      !this.screenOn ||
      this.clockAlertLayer !== null ||
      this.assistantOnlyPresentation ||
      this.musicCardPresentationPending !== null ||
      this.activeVoiceLayer ||
      !isPresentationAllowed() ||
      !this.config.requestShellDelivery
    ) return false;
    // Waking the shell schedules an ordinary retained-state repaint. Drain it
    // before the modal becomes stack-top; otherwise that ordinary frame can
    // send the modal first and the strict delivery immediately dedupes as "no
    // change", falsely treating a visible notification as failure and closing
    // it again.
    if (!renderAlreadyDrained && this.config.waitForShellRenderIdle) {
      await this.config.waitForShellRenderIdle();
    }
    if (
      !this.screenOn ||
      this.clockAlertLayer !== null ||
      this.assistantOnlyPresentation ||
      this.musicCardPresentationPending !== null ||
      this.activeVoiceLayer ||
      !isPresentationAllowed() ||
      !this.config.requestShellDelivery
    ) return false;
    this.assistantResultWakeOwnership.invalidate();
    // A notification preempts an active music card. Evict the card first (it is
    // always top when active) and inherit its wake ownership, so closing the
    // notification still re-sleeps if the card is what woke the screen. Without
    // this, the card's later rise would fail popIfTop and strand a zombie layer.
    let ownsWake = wokeScreen;
    if (this.musicCard) {
      const card = this.musicCard;
      this.stack.popIfTop((l) => l === card);
      if (
        this.musicCardWokeScreen &&
        this.screenWakeActivityRevision === this.activityRevision
      ) ownsWake = true;
      this.musicCard = null;
      this.musicCardWokeScreen = false;
      void this.releaseMusicCardPresentationIsolation(card);
    }
    const modal: ShellModalLayer = new ShellModalLayer(
      new SingleNotificationLayer(notificationKey, {
        origin: "new-notification-modal",
        expectedRevision: revision,
        retainedNotification,
        retainedReason,
        closeModal: () => this.closeNotificationModal(modal),
      }),
      this.config.actions,
    );
    this.stack.push(modal);
    if (ownsWake) this.notificationModalWakeOwnership.claim(modal);
    this.notificationModalPresentationPending = modal;
    this.restartScreenTimeout();
    try {
      const isOwner = () =>
        this.screenOn &&
        isPresentationAllowed() &&
        this.notificationModalPresentationPending === modal &&
        this.stack.topMatches((layer) => layer === modal);
      await this.config.requestShellDelivery(isOwner);
      if (!isOwner()) throw new Error("The notification modal was superseded before presentation.");
      this.restartScreenTimeout();
      return true;
    } catch {
      this.closeNotificationModal(modal);
      return false;
    } finally {
      if (this.notificationModalPresentationPending === modal) {
        this.notificationModalPresentationPending = null;
      }
    }
  }

  async openNotificationDigest(
    entries: readonly {
      key: string;
      revision: string;
      reason: string;
      notification: AndroidNotification;
    }[],
    wokeScreen: boolean,
    renderAlreadyDrained = false,
  ): Promise<boolean> {
    const isPresentationAllowed = () =>
      !this.config.isNotificationPresentationAllowed ||
      this.config.isNotificationPresentationAllowed();
    if (
      !this.screenOn ||
      this.clockAlertLayer !== null ||
      this.assistantOnlyPresentation ||
      this.musicCardPresentationPending !== null ||
      this.activeVoiceLayer ||
      !isPresentationAllowed() ||
      !entries.length ||
      !this.config.requestShellDelivery
    ) return false;
    if (!renderAlreadyDrained && this.config.waitForShellRenderIdle) {
      await this.config.waitForShellRenderIdle();
    }
    if (
      !this.screenOn ||
      this.clockAlertLayer !== null ||
      this.assistantOnlyPresentation ||
      this.musicCardPresentationPending !== null ||
      this.activeVoiceLayer ||
      !isPresentationAllowed() ||
      !entries.length ||
      !this.config.requestShellDelivery
    ) return false;
    this.assistantResultWakeOwnership.invalidate();
    let ownsWake = wokeScreen;
    if (this.musicCard) {
      const card = this.musicCard;
      this.stack.popIfTop((layer) => layer === card);
      if (
        this.musicCardWokeScreen &&
        this.screenWakeActivityRevision === this.activityRevision
      ) ownsWake = true;
      this.musicCard = null;
      this.musicCardWokeScreen = false;
      void this.releaseMusicCardPresentationIsolation(card);
    }
    const modal: ShellModalLayer = new ShellModalLayer(
      new NotificationDigestLayer(entries, () => this.closeNotificationModal(modal)),
      this.config.actions,
    );
    this.stack.push(modal);
    if (ownsWake) this.notificationModalWakeOwnership.claim(modal);
    this.notificationModalPresentationPending = modal;
    this.restartScreenTimeout();
    try {
      const isOwner = () =>
        this.screenOn &&
        isPresentationAllowed() &&
        this.notificationModalPresentationPending === modal &&
        this.stack.topMatches((layer) => layer === modal);
      await this.config.requestShellDelivery(isOwner);
      if (!isOwner()) throw new Error("The notification digest was superseded before presentation.");
      this.restartScreenTimeout();
      return true;
    } catch {
      this.closeNotificationModal(modal);
      return false;
    } finally {
      if (this.notificationModalPresentationPending === modal) {
        this.notificationModalPresentationPending = null;
      }
    }
  }

  /** Install/update Clock visual before waking, so retained HUD never flashes. */
  async showClockAlert(state: ClockAlertVisualState): Promise<boolean> {
    // Clock's coordinator retries failed visual projections. Never let it
    // supersede an in-flight blanked music transaction: its independent wake
    // barrier could otherwise unblank before either exact opaque layer lands.
    if (
      this.musicCardPresentationPending ||
      this.notificationCardPresentationPending ||
      this.notificationModalPresentationPending
    ) return false;
    if (this.clockAlertLayer) {
      this.clockAlertLayer.update(state);
      if (!this.stack.topMatches((top) => top === this.clockAlertLayer)) {
        this.stack.remove(this.clockAlertLayer);
        this.stack.push(this.clockAlertLayer);
      }
    } else {
      this.assistantResultWakeOwnership.invalidate();
      this.clockAlertLayer = new ClockAlertLayer(state);
      this.stack.push(this.clockAlertLayer);
    }
    if (!this.screenOn) this.wake("sidebar");
    this.restartScreenTimeout();
    const layer = this.clockAlertLayer;
    const isOwner = () =>
      this.screenOn &&
      this.clockAlertLayer === layer &&
      this.stack.topMatches((top) => top === layer);
    try {
      // Wake/session callbacks may already have queued an ordinary repaint.
      // Drain it, then alter one wire-distinct, visually imperceptible corner
      // pixel so this Clock layer receives its own non-deduped receipt.
      if (this.config.waitForShellRenderIdle) await this.config.waitForShellRenderIdle();
      if (!isOwner()) return false;
      layer.bumpDeliveryNonce();
      if (this.config.requestShellDelivery) {
        await this.config.requestShellDelivery(isOwner);
      } else {
        await this.config.requestShellRender();
      }
      if (!isOwner()) return false;
      this.restartScreenTimeout();
      return true;
    } catch {
      // Retain exact layer ownership. The coordinator retries on the next
      // phase/session opportunity rather than consuming a false presentation.
      return false;
    }
  }

  closeClockAlert(): void {
    const layer = this.clockAlertLayer;
    if (!layer) return;
    this.clockAlertLayer = null;
    this.stack.remove(layer);
    this.config.requestShellRender();
  }

  /** Replace terminal Clock feedback without briefly repainting retained HUD. */
  private releaseTerminalClockAlertLayer(): boolean {
    const layer = this.clockAlertLayer;
    if (!layer) return true;
    if (this.config.releaseTerminalClockAlertVisual?.() !== true) return false;
    // The coordinator has synchronously retired summary/silent ownership and
    // any retry. Remove only this exact layer; showDynamicApp installs its
    // replacement in the same turn and owns the subsequent strict repaint.
    if (this.clockAlertLayer !== layer) return this.clockAlertLayer === null;
    this.clockAlertLayer = null;
    this.stack.remove(layer);
    return true;
  }

  isClockAlertVisible(): boolean {
    return this.clockAlertLayer !== null && this.screenOn;
  }

  /** Whether the screen-off now-playing card is currently up. */
  isMusicCardActive(): boolean {
    return this.musicCard !== null;
  }

  /** True only during the blanked, pre-ACK Now Playing transaction. */
  isMusicCardPresentationPending(): boolean {
    return this.musicCardPresentationPending !== null;
  }

  /**
   * Present, or (if one is already up) refresh, the song-change card. A fresh
   * screen-off card is installed under an exact isolated-surface lease before
   * wake; only its strictly acknowledged frame releases retained app surfaces.
   */
  async openMusicCard(): Promise<boolean> {
    if (this.musicCard) {
      if (!this.screenOn) return false;
      this.musicCard.onTrackChanged();
      return true;
    }
    if (
      this.screenOn ||
      this.clockAlertLayer ||
      this.assistantOnlyPresentation ||
      this.activeVoiceLayer ||
      !this.stack.isAtBase() ||
      !this.config.requestShellDelivery ||
      !this.config.prepareMusicCardDisplay ||
      !this.config.revealMusicCardDisplay ||
      !this.config.releaseMusicCardPresentationIsolation ||
      (this.config.isDisplayAvailable && !this.config.isDisplayAvailable())
    ) return false;
    this.assistantResultWakeOwnership.invalidate();
    const card = new MusicCardLayer({
      actions: this.config.actions,
      onDismissed: () => this.closeMusicCard(card),
    });
    this.musicCard = card;
    this.musicCardWokeScreen = false;
    this.musicCardWakeActivityRevision = -1;
    this.musicCardPresentationPending = card;
    this.stack.push(card);
    const isInstalledOwner = () =>
      this.musicCard === card &&
      this.musicCardPresentationPending === card &&
      this.stack.topMatches((top) => top === card);
    try {
      // The controller first asserts compositor blanking, resumes the page and
      // ACKs every retained app-surface hide. Construction is intentionally
      // inert, so no pre-isolation HUD render can get ahead of this barrier.
      const ready = await this.config.prepareMusicCardDisplay(isInstalledOwner);
      if (!ready || !isInstalledOwner()) throw new Error("Now Playing display preparation failed.");
      card.startPresentation();
      // While the physical compositor remains blank, submit and drain the
      // exact opaque card into retained shell state. Unblanking after this
      // point can therefore reveal only black/card pixels, never stale HUD.
      const primeReceipt = await this.config.requestShellDelivery(isInstalledOwner, false);
      if (
        !isInstalledOwner() ||
        primeReceipt.frameId <= 0 ||
        !isReadinessFrameEvidenceOutcome(primeReceipt.outcome)
      ) throw new Error("Now Playing retained-frame prime was not acknowledged.");
      if (!this.screenOn) {
        const wokeScreen = this.wake("sidebar");
        if (wokeScreen) {
          this.musicCardWokeScreen = true;
          this.musicCardWakeActivityRevision = this.activityRevision;
        }
      }
      const isOwner = () => this.screenOn && isInstalledOwner();
      if (!isOwner()) throw new Error("Now Playing wake was superseded.");
      const revealed = await this.config.revealMusicCardDisplay(isOwner);
      if (!revealed || !isOwner()) throw new Error("Now Playing reveal failed.");
      // Force one wire-distinct frame after the retained-card unblank. The
      // dedicated surface lease remains held through its physical receipt.
      card.bumpDeliveryNonce();
      const receipt = await this.config.requestShellDelivery(isOwner);
      if (
        !isOwner() ||
        receipt.frameId <= 0 ||
        !isSuccessfulFrameOutcome(receipt.outcome)
      ) throw new Error("Now Playing did not receive an exact frame acknowledgement.");
      if (!(await this.releaseMusicCardPresentationIsolation(card))) {
        throw new Error("Now Playing isolation ownership changed before acknowledgement.");
      }
      this.restartScreenTimeout();
      this.config.requestShellRender();
      return true;
    } catch {
      await this.rollbackMusicCardPresentation(card);
      return false;
    }
  }

  private async releaseMusicCardPresentationIsolation(card: MusicCardLayer): Promise<boolean> {
    if (this.musicCardPresentationPending !== card) return false;
    await this.config.releaseMusicCardPresentationIsolation?.();
    if (this.musicCardPresentationPending !== card) return false;
    this.musicCardPresentationPending = null;
    return true;
  }

  private async rollbackMusicCardPresentation(card: MusicCardLayer): Promise<void> {
    const exactCard = this.musicCard === card;
    const exactTop = exactCard && this.stack.topMatches((top) => top === card);
    // Only the exact still-top card may return its own provisional wake to
    // sleep, and only if no later user input claimed that wake. A newer
    // Clock/notification/user owner must never be blanked by stale cleanup.
    if (
      exactTop &&
      this.musicCardWokeScreen &&
      this.musicCardWakeActivityRevision === this.activityRevision &&
      this.screenOn
    ) {
      this.sleep();
      return;
    }
    if (exactCard) {
      this.stack.remove(card);
      this.musicCard = null;
      this.musicCardWokeScreen = false;
      this.musicCardWakeActivityRevision = -1;
    }
    if (this.musicCardPresentationPending === card) {
      // A user/newer layer owns the on-state. Prime that exact replacement
      // while still compositor-blank, then surface restoration may unblank it.
      await this.config.requestShellRender();
      if (this.config.waitForShellRenderIdle) await this.config.waitForShellRenderIdle();
      await this.releaseMusicCardPresentationIsolation(card);
    }
    if (exactCard) this.config.requestShellRender();
  }

  private async closeMusicCard(card: MusicCardLayer): Promise<void> {
    if (this.musicCard !== card) return; // stale (already replaced/torn down)
    const wasTop = this.stack.topMatches((top) => top === card);
    if (!wasTop && this.clockAlertLayer !== null && card.deferDismissalWhileCovered()) {
      return;
    }
    this.stack.remove(card);
    const woke = this.musicCardWokeScreen;
    const ownsWake = woke && this.musicCardWakeActivityRevision === this.activityRevision;
    this.musicCard = null;
    this.musicCardWokeScreen = false;
    this.musicCardWakeActivityRevision = -1;
    if (ownsWake && wasTop && this.screenOn) {
      this.sleep();
      return;
    }
    if (this.musicCardPresentationPending === card) {
      await this.config.requestShellRender();
      if (this.config.waitForShellRenderIdle) await this.config.waitForShellRenderIdle();
      await this.releaseMusicCardPresentationIsolation(card);
    }
    this.config.requestShellRender();
  }

  private closeNotificationModal(modal: ShellModalLayer): void {
    const wasTop = this.stack.topMatches((layer) => layer === modal);
    const removed = this.stack.remove(modal);
    if (this.notificationModalWakeOwnership.release(
      modal,
      wasTop && removed,
    )) {
      this.sleep();
      return;
    }
    this.flushDeferredAssistantUi();
    this.config.requestShellRender();
  }

  /** Called by a window when the user backs out of its root (double-tap). */
  yieldFocusToSidebar(): void {
    if (this.focus === "sidebar") return;
    this.focus = "sidebar";
    // Repaint the window so its selection highlight dims to the unfocused
    // style this frame.
    this.foregroundWindow()?.requestRender();
    this.config.requestShellRender();
  }

  /** Paint the shell surface: transparent chrome, or all-transparent when asleep. */
  paintSurface(): GrayImage {
    if (
      !this.screenOn &&
      !this.musicCardPresentationPending &&
      !this.notificationCardPresentationPending
    ) {
      return new GrayImage(G2_LENS_WIDTH, G2_LENS_HEIGHT, 0);
    }
    if (
      this.assistantOnlyPresentation ||
      this.musicCardPresentationPending ||
      this.notificationCardPresentationPending
    ) {
      // The app surfaces are separately composited and are hidden by the
      // controller for this lease. Paint only its exact top layer over blank;
      // otherwise a wake transition could flash retained HUD/sidebar pixels
      // before the assistant or Now Playing frame is acknowledged.
      return this.stack.paintTopOverBlank();
    }
    return this.stack.paint();
  }

  /** Apply the shared ring sensitivity gate without changing display ownership. */
  private shouldDiscardThrottledScroll(event: DashboardInputEvent): boolean {
    if (
      (event.type !== "scroll-up" && event.type !== "scroll-down") ||
      this.reorderingWindowId !== null
    ) return false;
    const interval = ringScrollMinIntervalMs(ringSensitivitySetting.get());
    if (interval <= 0) return false;
    const now = Date.now();
    if (now - this.lastScrollHonoredAtMs < interval) return true;
    this.lastScrollHonoredAtMs = now;
    return false;
  }

  /**
   * A card that woke a sleeping display owns ordinary ring/arm input. Route it
   * before global activity or deferred UI bookkeeping so play/pause, skip and
   * their companion release events cannot turn the provisional wake into HUD.
   */
  private async receiveTopMusicCardInput(
    event: DashboardInputEvent,
  ): Promise<ShellInputOutcome | null> {
    const card = this.musicCard;
    if (!this.screenOn || !card || !this.stack.topMatches((top) => top === card)) return null;
    this.cancelEscapeMenuTimer();
    if (this.shouldDiscardThrottledScroll(event)) {
      return { shell: false, window: false };
    }
    await this.stack.handleInput(event);
    return { shell: true, window: false };
  }

  async receiveInput(event: DashboardInputEvent, frameId = 0): Promise<ShellInputOutcome> {
    // The stock lifecycle has already interpreted the physical double tap as
    // "wake". Keep that directionality if delivery is delayed or duplicated.
    if (event.type === "display-wake") {
      this.noteUserActivity();
      const wokeScreen = !this.screenOn && this.wake("sidebar");
      return { shell: wokeScreen, window: false };
    }

    // The wakeword is handled before the screen-off short-circuit so its
    // configured action can work from a dark screen. With the CFW the stock
    // Even AI app never launches, so the firmware does not power the display
    // for us either -- actions that need it wake the screen themselves.
    if (event.type === "wakeword") {
      // Master voice switch: off ignores the wakeword entirely.
      if (!voiceControlEnabledSetting.get()) {
        return { shell: false, window: false };
      }
      const action = wakeWordActionSetting.get();
      if (action === "off") {
        return { shell: false, window: false };
      }

      this.noteUserActivity();
      const wokeScreen = !this.screenOn && this.wake("sidebar");
      if (action === "voice-input" && this.assistantSession?.isTurnActive()) {
        // The active turn remains visually silent. Its final result will
        // present itself through the display-wake barrier.
      } else if (action === "voice-input" && !this.activeVoiceLayer) {
        if (this.assistantLayer) {
          // The assistant overlay is up; a wakeword continues that conversation.
          this.startAssistantFollowUp(true);
        } else {
          // Wakeword defaults the highlight to Send to Assistant.
          this.openVoiceDialog({ handsFree: true, defaultTarget: "assistant" });
        }
      }
      return { shell: wokeScreen || action === "voice-input", window: false };
    }

    // A second sleeping PTT press cannot start another capture while the
    // original turn is live. Reject it before activity bookkeeping or wake so
    // an invisible background turn never produces an empty black frame.
    if (
      !this.screenOn &&
      event.type === "long-press" &&
      this.assistantSession?.isTurnActive()
    ) {
      return { shell: false, window: false };
    }

    const musicCardOutcome = await this.receiveTopMusicCardInput(event);
    if (musicCardOutcome) return musicCardOutcome;

    this.noteUserActivity();
    this.flushDeferredAssistantUi();
    this.detachStaleRunningAssistantLayer();
    this.rehideUnacknowledgedAssistantOverlayBeforeInput();

    // Anything but the long-press itself means the press ended (or the event
    // stream moved on), so the escape countdown stops.
    if (event.type !== "long-press") {
      this.cancelEscapeMenuTimer();
    }

    // A sleeping long-press is push-to-talk for the assistant. Route it before
    // the generic screen-off short circuit; the matching release below ends
    // capture. The master voice switch remains authoritative.
    if (!this.screenOn && event.type === "long-press" && voiceControlEnabledSetting.get()) {
      this.setAssistantOnlyPresentation(true);
      this.wake("sidebar");
      if (!this.activeVoiceLayer) {
        this.openVoiceDialog({ defaultTarget: "assistant", returnToSleepOnClose: true });
      }
      return { shell: true, window: false };
    }

    if (!this.screenOn) {
      if (event.type === "double-click") {
        this.wake("sidebar");
        return { shell: true, window: false };
      }
      return { shell: false, window: false };
    }

    // Long-press goes to the foreground window (from the sidebar it focuses
    // the window first); apps conventionally answer it with their window
    // menu. The escape timer runs regardless of what the app does with it:
    // holding the press long enough opens the shell's own menu.
    if (event.type === "long-press") {
      // Untrusted remote content must never trap shell input. A long press
      // closes it before the normal escape countdown continues.
      if (this.remoteViewLayer) {
        const layer = this.remoteViewLayer;
        layer.close();
        this.startEscapeMenuTimer();
        return { shell: true, window: false };
      }
      if (this.dynamicAppLayer) {
        const layer = this.dynamicAppLayer;
        if (this.contextDashboardVoicePrefix) {
          // A contextual overlay must not steal the shell's established
          // sidebar long-press. Dismiss the temporary presentation and enter
          // Window Management mode; window focus retains contextual voice follow-up.
          if (
            this.focus === "sidebar" &&
            this.windows[this.selectedIndex]?.appId !== "launcher" &&
            !this.closingActive &&
            !this.activeVoiceLayer &&
            this.hasManageableWindow() &&
            this.stack.topMatches((candidate) => candidate === layer)
          ) {
            layer.close();
            this.enterWindowManagement();
            this.startEscapeMenuTimer();
            this.config.requestShellRender();
            return { shell: true, window: false };
          }
          const contextState = layer.state as DynamicAppState & {
            contextIntent?: string;
            presentationMode?: "single" | "deck";
            pageId?: string;
          };
          const focusContext = contextState.presentationMode === "deck"
            ? `Current page: ${contextState.title} (${contextState.pageId ?? "cover"})`
            : `Focused item: ${contextState.components[contextState.scrollOffset]?.id ?? "summary"}`;
          this.contextDashboardVoicePrefix = `Context dashboard intent: ${contextState.contextIntent}. ${focusContext}.`;
          this.startEscapeMenuTimer();
          this.openVoiceDialog({ defaultTarget: "assistant" });
          return { shell: true, window: false };
        }
        layer.close();
        this.startEscapeMenuTimer();
        return { shell: true, window: false };
      }
      // While moving a tab, swallow long-presses so the window menu can't open
      // over the grab; a tap (handled in the sidebar management branch) drops it.
      if (this.reorderingWindowId !== null) {
        return { shell: true, window: false };
      }
      // The pinned Apps/Dashboard tab is the shell's voice entry point, not a
      // close target. Other sidebar tabs retain Window Management on hold.
      if (
        this.focus === "sidebar" &&
        this.stack.isAtBase() &&
        !this.activeVoiceLayer &&
        this.windows[this.selectedIndex]?.appId === "launcher"
      ) {
        if (this.closingActive) this.exitWindowManagement();
        this.startEscapeMenuTimer();
        if (!this.assistantSession?.isTurnActive()) {
          this.openVoiceDialog({ defaultTarget: "assistant" });
        }
        this.config.requestShellRender();
        return { shell: true, window: false };
      }
      // The first sidebar long-press enters Window Management. A subsequent
      // long-press on a movable selected card picks it up for reorder.
      if (
        this.focus === "sidebar" &&
        this.stack.isAtBase() &&
        !this.activeVoiceLayer &&
        this.hasManageableWindow()
      ) {
        if (!this.closingActive) {
          this.enterWindowManagement();
        } else {
          const selected = this.windows[this.selectedIndex];
          if (selected && this.isReorderable(selected)) this.beginWindowMove(selected.windowId);
        }
        // Keep the escape-menu timer so a longer hold still opens it (which
        // supersedes Window Management); a quick release stays in management.
        this.startEscapeMenuTimer();
        this.config.requestShellRender();
        return { shell: true, window: false };
      }
      this.startEscapeMenuTimer();
      if (this.activeVoiceLayer || !this.stack.isAtBase()) {
        return { shell: true, window: false };
      }
      const window = this.foregroundWindow();
      if (!window) {
        return { shell: true, window: false };
      }
      if (this.focus === "sidebar") {
        this.focus = "window";
      }
      // The window owns frameId from here (render or explicit finish).
      await window.handleInput(event, frameId);
      return { shell: true, window: true };
    }
    if (event.type === "long-press-release") {
      // The finger lifting after a grab does not drop the tab; the user then
      // scrolls to move it and taps to drop. Stay in reorder mode.
      if (this.reorderingWindowId !== null) {
        return { shell: true, window: false };
      }
      this.activeVoiceLayer?.endCapture();
      if (this.activeVoiceLayer || !this.stack.isAtBase() || this.focus !== "window") {
        return { shell: true, window: false };
      }
      const window = this.foregroundWindow();
      if (!window) {
        return { shell: true, window: false };
      }
      await window.handleInput(event, frameId);
      return { shell: false, window: true };
    }

    // Ring-sensitivity throttle: below max, drop scroll events that arrive too
    // soon after the last honored one, so a fast swipe doesn't race. Applied
    // before any consumer (list, text, sidebar) so every scroll obeys it.
    // Reorder scrolls are exempt: those are deliberate one-at-a-time steps.
    if (this.shouldDiscardThrottledScroll(event)) return { shell: false, window: false };

    if (!this.stack.isAtBase()) {
      await this.stack.handleInput(event);
      return { shell: true, window: false };
    }

    if (this.focus === "sidebar") {
      return this.handleSidebarInput(event);
    }

    const window = this.foregroundWindow();
    if (window) {
      // The window owns frameId from here (render or explicit finish).
      await window.handleInput(event, frameId);
      return { shell: false, window: true };
    }
    return { shell: false, window: false };
  }

  foregroundWindow(): ShellWindow | undefined {
    return this.windows[this.selectedIndex] ?? this.windows[0];
  }

  /**
   * Screen rect actually occupied by content, for cropping screenshots: the
   * foreground window's band (full screen for a max-height window, the
   * vertical-position-dependent 288px band otherwise), starting at the only
   * optically useful sidebar column. The hidden left reserve is never used.
   */
  screenshotCropRect(): { x: number; y: number; width: number; height: number } {
    const heightMode = this.foregroundWindow()?.heightMode ?? "min";
    const x = sidebarLeftColumnUsed(this.windows.length) ? 0 : SIDEBAR_COLUMN_WIDTH;
    return {
      x,
      y: windowTop(heightMode),
      width: G2_LENS_WIDTH - x,
      height: heightMode === "max" ? G2_LENS_HEIGHT : MIN_WINDOW_HEIGHT,
    };
  }

  /** Whether a window is the current input target (foreground + focus in-window). */
  isWindowFocused(windowId: string): boolean {
    return this.screenOn && this.focus === "window" && this.foregroundWindow()?.windowId === windowId;
  }

  /**
   * Whether a window's content is on screen: it's the foreground window and the
   * screen is on. Focus-independent — the app viewport stays visible while the
   * sidebar is focused (the sidebar is just the left strip).
   */
  isWindowVisible(windowId: string): boolean {
    return this.screenOn && this.foregroundWindow()?.windowId === windowId;
  }

  /** Any card Window Management can act on: closeable, or visible Health. */
  private hasManageableWindow(): boolean {
    return this.windows.some((window) => window.closeable !== false || window === this.healthWindow);
  }

  private enterWindowManagement(): void {
    this.closingActive = true;
    this.managementSelectedWindowId = this.windows[this.selectedIndex]?.windowId ?? null;
    this.selectionRevision++;
    // A new management session is a user claim over selection; pending async
    // launch focus must not steal it when surface setup eventually resolves.
    this.focusClaimEpoch++;
  }

  private exitWindowManagement(): void {
    this.closingActive = false;
    this.reorderingWindowId = null;
    this.managementSelectedWindowId = null;
    this.focusClaimEpoch++;
  }

  private beginWindowMove(windowId: string): boolean {
    const index = this.windows.findIndex((window) => window.windowId === windowId);
    if (index < 0 || !this.canReorder(windowId) || !this.closingActive) return false;
    this.setSelectedIndex(index);
    this.managementSelectedWindowId = windowId;
    this.reorderingWindowId = windowId;
    this.focusClaimEpoch++;
    const window = this.windows[index]!;
    window.setForeground?.(true);
    window.requestRender();
    this.config.requestShellRender();
    return true;
  }

  private handleSidebarInput(event: DashboardInputEvent): ShellInputOutcome {
    // Unified Window Management: select/close when idle within the mode;
    // scroll/move and tap/drop while a tab is picked up.
    if (this.closingActive) {
      if (this.reorderingWindowId !== null) {
        switch (event.type) {
          case "scroll-up":
            this.moveReorder(-1);
            return { shell: true, window: false };
          case "scroll-down":
            this.moveReorder(1);
            return { shell: true, window: false };
          case "click":
            this.endReorder();
            return { shell: true, window: false };
          case "double-click":
            this.exitWindowManagement();
            return { shell: true, window: false };
          default:
            return { shell: false, window: false };
        }
      }
      switch (event.type) {
        case "scroll-up":
          this.moveSelection(-1);
          return { shell: true, window: false };
        case "scroll-down":
          this.moveSelection(1);
          return { shell: true, window: false };
        case "click": {
          const window = this.managementSelectedWindowId
            ? this.windows.find((candidate) => candidate.windowId === this.managementSelectedWindowId)
            : this.windows[this.selectedIndex];
          if (window === this.healthWindow) {
            this.setHealthHidden(true);
          } else if (window && window.closeable !== false) {
            this.closeWindow(window.windowId);
          }
          // Stay armed while there is still something to close; else exit.
          if (!this.hasManageableWindow()) this.exitWindowManagement();
          this.config.requestShellRender();
          return { shell: true, window: false };
        }
        case "double-click":
          this.exitWindowManagement();
          this.config.requestShellRender();
          return { shell: true, window: false };
        default:
          return { shell: false, window: false };
      }
    }
    switch (event.type) {
      case "double-click":
        this.sleep();
        return { shell: true, window: false };
      case "scroll-up":
        this.moveSelection(-1);
        return { shell: true, window: false };
      case "scroll-down":
        this.moveSelection(1);
        return { shell: true, window: false };
      case "click":
        if (this.windows.length) {
          // A user click is an explicit selection/focus claim even when the
          // highlighted index was already current; revoke deferred launches.
          this.selectionRevision++;
          this.focusClaimEpoch++;
          this.focus = "window";
          // Repaint the window now so its selection highlight reflects focus
          // this frame, not one frame late.
          this.foregroundWindow()?.requestRender();
        }
        return { shell: true, window: false };
      default:
        return { shell: false, window: false };
    }
  }

  private moveSelection(delta: number): void {
    if (!this.windows.length) return;
    if (this.closingActive && this.reorderingWindowId === null) {
      this.moveManagementSelection(delta);
      return;
    }
    const count = this.windows.length;
    const dir = delta > 0 ? 1 : -1;
    const ownedIndex = this.closingActive && this.managementSelectedWindowId
      ? this.windows.findIndex((window) => window.windowId === this.managementSelectedWindowId)
      : this.selectedIndex;
    const currentIndex = ownedIndex >= 0 ? ownedIndex : this.selectedIndex;
    const step = this.sidebarScroller.step(currentIndex, count, dir, Date.now());
    if (step.atEdge) {
      // Stopped hard against an end: bounce, don't move or wrap yet.
      this.sidebarBounce.trigger(dir, () => this.config.requestShellRender());
      return;
    }
    this.setSelectedIndex(step.index);
    if (this.closingActive) this.managementSelectedWindowId = this.windows[step.index]?.windowId ?? null;
  }

  /** Management selection is deliberately bounded: one burst cannot wrap to the top. */
  private moveManagementSelection(delta: number): void {
    const ownedIndex = this.managementSelectedWindowId
      ? this.windows.findIndex((window) => window.windowId === this.managementSelectedWindowId)
      : -1;
    const currentIndex = ownedIndex >= 0 ? ownedIndex : this.selectedIndex;
    const nextIndex = nextWindowManagementIndex(currentIndex, delta < 0 ? -1 : 1, this.windows.length);
    if (nextIndex === currentIndex) {
      this.sidebarBounce.trigger(delta < 0 ? -1 : 1, () => this.config.requestShellRender());
      return;
    }
    this.setSelectedIndex(nextIndex);
    this.managementSelectedWindowId = this.windows[nextIndex]?.windowId ?? null;
  }

  /** A tab is reorderable unless it is pinned (the uncloseable launcher). */
  private isReorderable(window: ShellWindow): boolean {
    return window.closeable !== false;
  }

  /**
   * Whether a window's tab can be picked up right now: it must be movable (not
   * the pinned launcher) and there must be another movable tab to swap with.
   * Window Management uses this to advertise and arm HOLD move only when it works.
   */
  canReorder(windowId: string): boolean {
    const window = this.windows.find((w) => w.windowId === windowId);
    if (!window || !this.isReorderable(window)) return false;
    return this.windows.filter((w) => this.isReorderable(w)).length >= 2;
  }

  /** Enter Window Management for a menu-selected window; HOLD starts moving. */
  beginWindowManagementFromMenu(windowId: string): boolean {
    const index = this.windows.findIndex((w) => w.windowId === windowId);
    const target = this.windows[index];
    if (index < 0 || (!target?.closeable && target !== this.healthWindow)) return false;
    this.setSelectedIndex(index);
    this.focus = "sidebar";
    this.enterWindowManagement();
    this.managementSelectedWindowId = windowId;
    this.config.requestShellRender();
    return true;
  }

  /** @deprecated Kept as a source-compatible alias for older worker generations. */
  beginReorderFromMenu(windowId: string): boolean {
    return this.beginWindowManagementFromMenu(windowId);
  }

  /**
   * Move the picked-up tab one slot up (-1) or down (+1). Clamps at the ends
   * (no wrap, so the affordance chevrons read truthfully) and never crosses a
   * pinned tab, keeping the launcher first. The moved tab stays selected and
   * foreground, so only its sidebar position changes. Persists the new order.
   */
  private moveReorder(delta: number): void {
    const from = this.windows.findIndex((w) => w.windowId === this.reorderingWindowId);
    if (from < 0) {
      this.reorderingWindowId = null;
      return;
    }
    const to = from + delta;
    if (to < 0 || to >= this.windows.length) return;
    if (!this.isReorderable(this.windows[to]!)) return;
    const [moved] = this.windows.splice(from, 1);
    this.windows.splice(to, 0, moved!);
    this.selectedIndex = to;
    this.config.onWindowsChanged?.();
  }

  /** Drop the picked-up tab, leaving the order as arranged. */
  private endReorder(): void {
    if (this.reorderingWindowId === null) return;
    this.reorderingWindowId = null;
    this.config.onWindowsChanged?.();
  }

  /** Reorder-related chrome flags; the move bounds mirror moveReorder's clamp. */
  private reorderChromeState(): Pick<
    ShellChromeState,
    "reordering" | "reorderCanMoveUp" | "reorderCanMoveDown"
  > {
    if (this.reorderingWindowId === null) {
      return { reordering: false, reorderCanMoveUp: false, reorderCanMoveDown: false };
    }
    const from = this.windows.findIndex((w) => w.windowId === this.reorderingWindowId);
    const up = from > 0 && this.isReorderable(this.windows[from - 1]!);
    const down = from >= 0 && from < this.windows.length - 1 && this.isReorderable(this.windows[from + 1]!);
    return { reordering: true, reorderCanMoveUp: up, reorderCanMoveDown: down };
  }

  /** Change selection; the selected window is the foreground window. */
  private setSelectedIndex(index: number): void {
    if (index === this.selectedIndex) return;
    const previous = this.windows[this.selectedIndex];
    this.selectedIndex = index;
    this.selectionRevision++;
    if (this.closingActive) {
      this.managementSelectedWindowId = this.windows[index]?.windowId ?? null;
    }
    const next = this.windows[index];
    if (next) this.noteWindowVisible(next.windowId);
    previous?.setForeground?.(false);
    next?.setForeground?.(true);
    next?.requestRender();
    this.config.onWindowsChanged?.();
  }

  private openVoiceDialog(options: {
    finishOnClick?: boolean;
    handsFree?: boolean;
    defaultTarget: "assistant" | "app";
    /** Sleep-origin capture must not reveal the retained HUD when it closes. */
    returnToSleepOnClose?: boolean;
  }): void {
    // Master voice switch: off suppresses all voice input (manual or wakeword).
    if (!voiceControlEnabledSetting.get()) return;
    const targets = this.buildVoiceSendTargets();
    let defaultIndex = targets.findIndex((target) => target.id === options.defaultTarget);
    if (defaultIndex < 0) defaultIndex = 0;
    // The opt-in follows the destination, not the gesture: wakeword,
    // sleeping push-to-talk, contextual voice, and result replies all target
    // the assistant. App dictation retains its review step.
    const autoSend =
      options.defaultTarget === "assistant" &&
      targets[defaultIndex]?.id === "assistant" &&
      assistantSkipConfirmationSetting.get();

    const voiceOwner = this.foregroundWindow();
    voiceOwner?.setVoiceInputActive?.(true);
    const layer = new VoiceInputLayer({
      actions: this.config.actions,
      onClosed: () => {
        if (this.activeVoiceLayer === layer) {
          this.activeVoiceLayer = null;
          voiceOwner?.setVoiceInputActive?.(false);
          this.flushDeferredAssistantUi();
          // The idle countdown restarts in full once voice input ends.
          this.noteUserActivity();
          // Auto-send calls onSend immediately after dismissing the voice
          // layer. Defer this check one turn so that assistantOnlyPresentation
          // survives into the assistant turn/result rather than revealing the
          // retained HUD between the two callbacks.
          queueMicrotask(() => {
            if (this.finishSleepingAssistantVoiceHandoff()) return;
            if (this.finishSleepingAssistantVoiceDismissal(options.returnToSleepOnClose === true)) return;
            this.endAssistantOnlyPresentationIfIdle();
          });
        }
      },
      dismiss: () => {
        this.stack.popIfTop((top) => top === layer);
      },
      sendTargets: targets,
      defaultTargetIndex: defaultIndex,
      finishOnClick: options.finishOnClick ?? false,
      handsFree: options.handsFree ?? false,
      autoSend,
    });
    this.activeVoiceLayer = layer;
    this.stack.push(layer);
    layer.startCapture();
  }

  /**
   * The send destinations offered by the voice dialog: the assistant (when an
   * API key is configured) and/or typing into the foreground window (when it
   * accepts text). Order fixes the menu row order.
   */
  private buildVoiceSendTargets(): VoiceSendTarget[] {
    const targets: VoiceSendTarget[] = [];
    if (this.isAssistantAvailable() && !this.assistantSession?.isTurnActive()) {
      targets.push({
        id: "assistant",
        label: "Send to Assistant",
        onSend: (text) => this.sendToAssistant(this.contextDashboardVoicePrefix
          ? `${this.contextDashboardVoicePrefix}\nWearer follow-up: ${text}`
          : text),
      });
    }
    if (this.foregroundWindow()?.receiveTextInput) {
      targets.push({
        id: "app",
        label: "Type Into App",
        onSend: (text) => this.sendTextToForegroundWindow(text),
      });
    }
    // Guarantee at least one destination so the dialog is never a dead end.
    if (targets.length === 0) {
      targets.push({
        id: "app",
        label: "Type Into App",
        onSend: (text) => this.sendTextToForegroundWindow(text),
      });
    }
    return targets;
  }

  /** Deliver a text string to the foreground window (e.g. finalized voice input). */
  sendTextToForegroundWindow(text: string): void {
    this.foregroundWindow()?.receiveTextInput?.(text);
  }

  /**
   * Open the voice dialog aimed at the foreground window. Called when the
   * user picks Voice input from a window's menu (in-process directly, worker
   * apps via a start-voice-input message). The menu click already ended the
   * press, so the dialog finishes on click instead of long-press-release.
   */
  startVoiceInput(): void {
    if (!this.screenOn || this.activeVoiceLayer || !this.stack.isAtBase()) return;
    if (this.assistantSession?.isTurnActive()) return;
    // The transcript is aimed at the window whose menu requested it; the menu
    // entry point defaults the highlight to Type Into App.
    this.focus = "window";
    this.openVoiceDialog({ finishOnClick: true, defaultTarget: "app" });
    this.config.requestShellRender();
  }

  private isAssistantAvailable(): boolean {
    return this.resolveAssistantConfiguration() !== null;
  }

  private ensureAssistantSession(): AssistantSession | null {
    const config = this.resolveAssistantConfiguration();
    if (!config) return null;
    if (
      !this.assistantSession ||
      this.assistantSession.isExpired() ||
      !this.assistantSession.matchesConfiguration(config)
    ) {
      this.assistantSession?.cancel();
      this.assistantSession = new AssistantSession(config);
    }
    return this.assistantSession;
  }

  private resolveAssistantConfiguration(): AssistantBackendConfig | null {
    if (assistantBackendSetting.get() === "external") {
      const host = assistantBridgeHostSetting.get().trim();
      const token = assistantBridgeTokenSetting.get();
      if (!host || !token) return null;
      const port = resolveAssistantBridgePort();
      return { kind: "external", bridge: { host, port, token } };
    }
    const llm = resolveAssistantModel(assistantModelSetting.get(), {
      anthropic: anthropicApiKeySetting.get(),
      openai: openAiApiKeySetting.get(),
    });
    return llm ? { kind: "direct", llm } : null;
  }

  private buildAssistantContext(): AssistantContext {
    const foreground = this.getForegroundApp();
    return {
      foregroundApp: foreground?.appId ?? null,
      foregroundTitle: foreground?.title ?? null,
      screenOn: this.screenOn,
      localTime: formatAssistantTime(new Date()),
      headsetBattery: this.battery.headset,
    };
  }

  /**
   * Start (or continue) an assistant conversation from a finalized utterance.
   * Opens the assistant overlay if it isn't already up; a follow-up reuses the
   * existing session and overlay.
   */
  sendToAssistant(text: string): void {
    const session = this.ensureAssistantSession();
    if (!session) {
      void this.showAlert(
        assistantBackendSetting.get() === "external"
          ? "Configure the Hermes Agent bridge host and token in Settings."
          : "Set an API key or download the on-phone model in Settings.",
      ).catch(() => { /* configuration notice is best-effort while disconnected */ });
      return;
    }
    if (session.isTurnActive()) return;
    if (!this.screenOn) this.wake("sidebar");
    let layer = this.assistantLayer;
    if (!layer) {
      const detached = this.detachedAssistantLayer;
      this.detachedAssistantLayer = null;
      detached?.onRemoved();
      const created = new AssistantLayer(this.config.actions, {
        onFollowUp: () => this.startAssistantFollowUp(),
        onCancel: () => this.assistantSession?.cancel(),
        onClose: () => this.closeAssistantLayer(),
        onRemoved: () => {
          // Removed by any path (Done, or the screen sleeping mid-conversation):
          // stop the turn and drop the reference so a later query starts clean.
          this.assistantSession?.cancel();
          if (this.assistantLayer === created) {
            this.assistantLayer = null;
            this.assistantTurnBackgrounded = false;
            this.assistantOverlayRestorePending = false;
          }
          if (this.isolatedAssistantTurn === created) this.isolatedAssistantTurn = null;
        },
      });
      layer = created;
      this.assistantLayer = created;
      this.stack.push(created);
    }
    this.runAssistantTurn(session, layer, text);
    this.config.requestShellRender();
  }

  private runAssistantTurn(session: AssistantSession, layer: AssistantLayer, text: string): void {
    if (session.isTurnActive() || this.assistantTurnBackgrounded) return;
    // Detach before startTurn requests its first paint. Thinking, streamed
    // text, and tool activity never become a glasses frame.
    this.backgroundAssistantLayer(layer);
    layer.startTurn();
    session.sendUtterance(text, this.buildAssistantContext(), {
      onTextDelta: () => {},
      onToolActivity: () => {},
      onTurnDone: (result) => {
        void playEventBeep("assistantReply", this.config.actions.playBuzzerSequence);
        layer.onTurnDone(result.text);
        if (this.detachedAssistantLayer === layer) this.detachedAssistantLayer = null;
        this.finishBackgroundAssistantTurn(layer);
      },
      onError: (message) => {
        void playEventBeep("assistantError", this.config.actions.playBuzzerSequence);
        layer.onError(message);
        if (this.detachedAssistantLayer === layer) this.detachedAssistantLayer = null;
        this.queueAssistantOverlayResult(layer);
      },
    });
  }

  private backgroundAssistantLayer(layer: AssistantLayer): void {
    if (this.assistantLayer !== layer || this.assistantTurnBackgrounded) return;
    this.assistantTurnBackgrounded = true;
    // The turn still owns this layer while it is hidden. Detach without firing
    // onRemoved so cancellation remains reserved for real teardown.
    this.stack.detach(layer);
    this.config.requestShellRender();
  }

  /** Repair a stale attached thinking layer before routing the same input. */
  private detachStaleRunningAssistantLayer(): void {
    const layer = this.assistantLayer;
    if (
      !layer ||
      this.assistantTurnBackgrounded ||
      !layer.isRunning() ||
      !this.stack.topMatches((top) => top === layer)
    ) return;
    this.backgroundAssistantLayer(layer);
  }

  /** User input belongs to the prior screen until the final card is physically acknowledged. */
  private rehideUnacknowledgedAssistantOverlayBeforeInput(): boolean {
    const layer = this.assistantLayer;
    if (
      !this.assistantOverlayDelivery ||
      !this.assistantOverlayRestorePending ||
      !layer ||
      this.assistantTurnBackgrounded ||
      !this.stack.topMatches((top) => top === layer)
    ) return false;
    this.rehideAssistantOverlayForRetry(layer);
    startDetachedCleanup(() => this.config.requestShellRender());
    return true;
  }

  private restoreBackgroundAssistantLayer(layer: AssistantLayer): boolean {
    if (this.assistantLayer !== layer || !this.assistantTurnBackgrounded) return false;
    if (this.activeVoiceLayer) {
      this.assistantOverlayRestorePending = true;
      return false;
    }
    this.assistantTurnBackgrounded = false;
    this.stack.push(layer);
    // Do not request an ordinary render here. The strict delivery immediately
    // following installation must own the first frame containing this card.
    return true;
  }

  private finishBackgroundAssistantTurn(layer: AssistantLayer): void {
    if (this.assistantLayer !== layer || !this.assistantTurnBackgrounded) return;
    const reply = layer.getReplyText().trim();
    if (!reply || assistantReplyNeedsOverlay(reply)) {
      this.queueAssistantOverlayResult(layer);
      return;
    }
    const isolated = this.isolatedAssistantTurn === layer;
    this.assistantTurnBackgrounded = false;
    this.assistantLayer = null;
    if (isolated) this.isolatedAssistantTurn = null;
    // Baseline/invalidate any older wake before flush synchronously acquires
    // the exact provisional wake for this completed result.
    this.noteAssistantResultActivity();
    if (reply) {
      this.pendingAssistantResult = reply;
      this.pendingAssistantResultIsolated = isolated;
      this.flushPendingAssistantResult();
    }
    this.config.requestShellRender();
  }

  private flushDeferredAssistantUi(): void {
    if (this.activeVoiceLayer || this.hasOpaqueCardPresentation()) return;
    if (this.assistantOverlayRestorePending && this.assistantLayer) {
      this.flushPendingAssistantOverlay();
    }
    this.flushPendingAssistantResult();
    this.notifyDirectNotificationOpportunity();
  }

  private queueAssistantOverlayResult(layer: AssistantLayer): void {
    if (this.assistantLayer !== layer || !this.assistantTurnBackgrounded) return;
    this.assistantOverlayRestorePending = true;
    this.noteAssistantResultActivity();
    this.flushPendingAssistantOverlay();
  }

  private flushPendingAssistantOverlay(): void {
    if (
      this.assistantOverlayDelivery ||
      !this.assistantOverlayRestorePending ||
      !this.assistantLayer ||
      !this.config.requestShellDelivery ||
      this.activeVoiceLayer ||
      this.hasOpaqueCardPresentation() ||
      (this.config.isDisplayAvailable && !this.config.isDisplayAvailable())
    ) return;
    const layer = this.assistantLayer;
    const isolated = this.isolatedAssistantTurn === layer;
    const isPending = () =>
      this.isolatedAssistantTurn === layer &&
      this.assistantLayer === layer &&
      this.assistantTurnBackgrounded &&
      this.assistantOverlayRestorePending &&
      !this.activeVoiceLayer &&
      !this.hasOpaqueCardPresentation();
    this.assistantOverlayDelivery = true;
    let preparation: AssistantResultDisplayPreparation | null = null;
    let strictAcknowledged = false;
    void (async () => {
      if (isolated) this.setAssistantOnlyPresentation(true);
      try {
        let ready: boolean;
        if (isolated) {
          preparation = this.config.prepareIsolatedAssistantResultDisplay
            ? await this.config.prepareIsolatedAssistantResultDisplay(isPending)
            : null;
          ready = preparation?.ready === true;
        } else {
          ready = this.config.prepareAssistantResultDisplay
            ? await this.config.prepareAssistantResultDisplay()
            : this.screenOn;
        }
        // Wake/readiness can leave an ordinary base render in flight. Drain it
        // before installing the unique final card so it cannot consume or
        // supersede the fingerprint that the strict transaction must prove.
        if (ready && this.config.waitForShellRenderIdle) {
          await this.config.waitForShellRenderIdle();
        }
        if (
          !ready ||
          !this.screenOn ||
          this.activeVoiceLayer ||
          this.hasOpaqueCardPresentation() ||
          !this.assistantOverlayRestorePending ||
          this.assistantLayer !== layer ||
          !this.assistantTurnBackgrounded
        ) return;
        if (!this.restoreBackgroundAssistantLayer(layer)) return;
        this.restartScreenTimeout();
        // Keep retry ownership until the completed card itself receives a
        // transport ACK; the wake barrier alone only proves lifecycle state.
        const isOwner = () =>
          this.assistantLayer === layer &&
          !this.assistantTurnBackgrounded &&
          this.screenOn &&
          !this.activeVoiceLayer &&
          !this.hasOpaqueCardPresentation() &&
          this.stack.topMatches((top) => top === layer);
        const receipt = await this.config.requestShellDelivery(isOwner);
        if (!isOwner() || receipt.frameId <= 0 || !isSuccessfulFrameOutcome(receipt.outcome)) {
          throw new Error("The assistant overlay did not receive a current transport acknowledgement.");
        }
        this.restartScreenTimeout();
        this.assistantOverlayRestorePending = false;
        preparation?.commit();
        strictAcknowledged = true;
        if (isolated && this.isolatedAssistantTurn === layer) {
          this.isolatedAssistantTurn = null;
        }
      } catch {
        // Keep the completed overlay queued for the next wake or reconnect.
      } finally {
        const retainedForRetry = !strictAcknowledged && this.assistantLayer === layer;
        if (retainedForRetry) {
          // A card without its own physical send must not remain a logical
          // stack/input owner. Preserve the exact completed layer for retry,
          // then repaint the now-detached base without retaining delivery.
          this.rehideAssistantOverlayForRetry(layer);
        }
        if (isolated && !strictAcknowledged) {
          // Blank/sleep before releasing the assistant-only app surfaces;
          // reversing these operations can flash the retained HUD.
          preparation?.rollback();
          this.setAssistantOnlyPresentation(false);
        }
        if (retainedForRetry) {
          startDetachedCleanup(() => this.config.requestShellRender());
        }
        this.assistantOverlayDelivery = false;
      }
    })();
  }

  private flushPendingAssistantResult(): void {
    if (
      this.pendingAssistantResultDelivery ||
      !this.pendingAssistantResult ||
      this.activeVoiceLayer ||
      this.hasOpaqueCardPresentation() ||
      (this.config.isDisplayAvailable && !this.config.isDisplayAvailable())
    ) return;
    const pending = this.pendingAssistantResult;
    const isolated = this.pendingAssistantResultIsolated;
    const isPending = () =>
      this.pendingAssistantResult === pending &&
      this.pendingAssistantResultIsolated === isolated &&
      !this.activeVoiceLayer &&
      !this.hasOpaqueCardPresentation();
    this.pendingAssistantResultDelivery = true;
    let delivered = false;
    let preparation: AssistantResultDisplayPreparation | null = null;
    void (async () => {
      if (isolated) this.setAssistantOnlyPresentation(true);
      try {
        let ready: boolean;
        if (isolated) {
          preparation = this.config.prepareIsolatedAssistantResultDisplay
            ? await this.config.prepareIsolatedAssistantResultDisplay(isPending)
            : null;
          ready = preparation?.ready === true;
        } else {
          ready = this.config.prepareAssistantResultDisplay
            ? await this.config.prepareAssistantResultDisplay()
            : this.screenOn;
        }
        if (
          !ready ||
          !this.screenOn ||
          this.activeVoiceLayer ||
          this.hasOpaqueCardPresentation() ||
          this.pendingAssistantResult !== pending
        ) return;
        await this.showAlert(
          pending,
          undefined,
          isPending,
          isolated ? () => preparation?.commit() : undefined,
          "until-dismiss-or-sleep",
          "assistant-reply",
        );
        if (isPending()) {
          this.pendingAssistantResult = null;
          this.pendingAssistantResultIsolated = false;
          delivered = true;
        }
      } catch {
        // Keep the result for the next wake, reconnect, or completed voice input.
      } finally {
        if (isolated && !delivered) {
          preparation?.rollback();
          this.setAssistantOnlyPresentation(false);
        }
        const queuedNext = this.pendingAssistantResult !== null && this.pendingAssistantResult !== pending;
        this.pendingAssistantResultDelivery = false;
        if (queuedNext) this.flushPendingAssistantResult();
      }
    })();
  }

  /**
   * Record another utterance in the current assistant conversation. handsFree
   * (from a wakeword over the overlay) starts the mic immediately; otherwise
   * (the Follow-up menu button) a click ends the utterance.
   */
  private startAssistantFollowUp(handsFree = false): void {
    const layer = this.assistantLayer;
    const session = this.assistantSession;
    if (!layer || !session || this.activeVoiceLayer) return;
    if (session.isTurnActive()) return;
    const voiceOwner = this.foregroundWindow();
    voiceOwner?.setVoiceInputActive?.(true);
    const voice = new VoiceInputLayer({
      actions: this.config.actions,
      onClosed: () => {
        if (this.activeVoiceLayer === voice) {
          this.activeVoiceLayer = null;
          voiceOwner?.setVoiceInputActive?.(false);
          this.flushDeferredAssistantUi();
          this.noteUserActivity();
          // An isolated completed answer can start another hidden turn. Once
          // its reviewed utterance is handed off, blank the display exactly as
          // the original sleep-origin PTT flow does.
          queueMicrotask(() => {
            if (this.finishSleepingAssistantVoiceHandoff()) return;
            this.endAssistantOnlyPresentationIfIdle();
          });
        }
      },
      dismiss: () => {
        this.stack.popIfTop((top) => top === voice);
      },
      sendTargets: [
        { id: "assistant", label: "Send", onSend: (text) => this.runAssistantTurn(session, layer, text) },
      ],
      finishOnClick: !handsFree,
      handsFree,
      autoSend: assistantSkipConfirmationSetting.get(),
    });
    this.activeVoiceLayer = voice;
    this.stack.push(voice);
    voice.startCapture();
    this.config.requestShellRender();
  }

  private closeAssistantLayer(): void {
    // Popping fires the layer's onRemoved, which cancels the turn and clears
    // this.assistantLayer.
    const layer = this.assistantLayer;
    const returnToSleep = this.assistantOnlyPresentation;
    if (this.isolatedAssistantTurn === layer) this.isolatedAssistantTurn = null;
    this.assistantTurnBackgrounded = false;
    if (layer) this.stack.popIfTop((top) => top === layer);
    if (returnToSleep && this.screenOn && !this.activeVoiceLayer) {
      this.sleep();
      return;
    }
    this.noteUserActivity();
    this.endAssistantOnlyPresentationIfIdle();
    this.config.requestShellRender();
  }

  /** Replace a completed result card with the existing reviewed voice flow. */
  private startAssistantResultReply(
    dismissResult: () => void,
    returnToSleepOnClose = this.assistantOnlyPresentation,
  ): void {
    if (
      !this.screenOn ||
      this.activeVoiceLayer ||
      this.assistantSession?.isTurnActive() ||
      !voiceControlEnabledSetting.get() ||
      !this.isAssistantAvailable()
    ) return;
    if (returnToSleepOnClose && !this.assistantOnlyPresentation) {
      this.setAssistantOnlyPresentation(true);
    }
    this.assistantOnlyReplyStarting = returnToSleepOnClose;
    dismissResult();
    this.openVoiceDialog({
      finishOnClick: true,
      defaultTarget: "assistant",
      returnToSleepOnClose,
    });
    this.assistantOnlyReplyStarting = false;
    this.config.requestShellRender();
  }

  /** Enter/leave the isolated assistant surface and its app-surface lease. */
  private setAssistantOnlyPresentation(active: boolean): void {
    if (this.assistantOnlyPresentation === active) return;
    this.assistantOnlyPresentation = active;
    this.config.setAssistantOnlyPresentation?.(active);
    this.config.requestShellRender();
  }

  private endAssistantOnlyPresentationIfIdle(): void {
    if (!this.assistantOnlyPresentation) return;
    if (
      this.activeVoiceLayer ||
      this.assistantOnlyReplyStarting ||
      this.assistantTurnBackgrounded ||
      this.assistantLayer ||
      this.alertLayer ||
      this.directNotificationLayer ||
      this.dynamicAppLayer ||
      this.pendingAssistantResult ||
      this.assistantSession?.isTurnActive()
    ) return;
    this.setAssistantOnlyPresentation(false);
  }

  /** Dismissing a sleep-origin final restores darkness before app surfaces. */
  private finishAssistantOnlyResultDismissal(): boolean {
    if (
      !this.assistantOnlyPresentation ||
      this.assistantOnlyReplyStarting ||
      this.activeVoiceLayer ||
      this.assistantTurnBackgrounded ||
      this.assistantLayer ||
      this.alertLayer ||
      this.directNotificationLayer ||
      this.pendingAssistantResult ||
      this.assistantSession?.isTurnActive()
    ) return false;
    if (this.screenOn) this.sleep();
    else this.setAssistantOnlyPresentation(false);
    return true;
  }

  /**
   * A sleeping PTT capture has handed its utterance to a hidden live turn.
   * Release the isolated surface immediately, remember the exact final owner,
   * and return the display to sleep while backend work continues detached.
   */
  private finishSleepingAssistantVoiceHandoff(): boolean {
    const layer = this.assistantLayer;
    if (
      !this.assistantOnlyPresentation ||
      this.activeVoiceLayer ||
      !layer ||
      !this.assistantTurnBackgrounded ||
      !this.assistantSession?.isTurnActive()
    ) return false;
    this.isolatedAssistantTurn = layer;
    if (this.screenOn) this.sleep();
    else this.setAssistantOnlyPresentation(false);
    return true;
  }

  /** A discarded/empty sleep-origin capture returns to darkness, never HUD. */
  private finishSleepingAssistantVoiceDismissal(returnToSleepOnClose: boolean): boolean {
    if (
      !returnToSleepOnClose ||
      !this.assistantOnlyPresentation ||
      this.activeVoiceLayer ||
      this.assistantTurnBackgrounded ||
      this.assistantLayer ||
      this.alertLayer ||
      this.directNotificationLayer ||
      this.pendingAssistantResult ||
      this.assistantSession?.isTurnActive()
    ) return false;
    if (this.screenOn) this.sleep();
    else this.setAssistantOnlyPresentation(false);
    return true;
  }

  /** Detach any unacknowledged final without firing teardown; retain it for retry. */
  private rehideAssistantOverlayForRetry(layer: AssistantLayer): boolean {
    if (this.assistantLayer !== layer) return false;
    const detached = this.stack.detach(layer);
    this.assistantTurnBackgrounded = true;
    this.assistantOverlayRestorePending = true;
    return detached;
  }

  /** Wake and strictly deliver one completed direct Hermes result. */
  async notifyAssistantResult(
    text: string,
    signal?: AbortSignal,
    isSideEffectAllowed?: () => boolean,
    presentation?: DirectAssistantResultPresentation,
  ): Promise<DirectAssistantResultDeliveryReceipt> {
    if (
      !presentation ||
      !Number.isSafeInteger(presentation.receivedAtMs) || presentation.receivedAtMs < 0 ||
      !Number.isSafeInteger(presentation.position) || presentation.position < 1 ||
      !Number.isSafeInteger(presentation.total) || presentation.total < presentation.position ||
      presentation.total > 32
    ) throw new Error("Direct notification presentation metadata is invalid.");

    // Install ownership before waking: shell.wake synchronously re-enters other
    // deferred UI flushing, and the dedicated direct slot must remain unclaimed.
    const revision = ++this.notifyResultRevision;
    const isCallAuthorized = () =>
      !signal?.aborted &&
      (!isSideEffectAllowed || isSideEffectAllowed());
    const isDeviceAllowed = () =>
      (!this.config.isDirectAssistantResultPresentationAllowed ||
        this.config.isDirectAssistantResultPresentationAllowed());
    const canAcquireSlot = () =>
      this.activeVoiceLayer === null &&
      this.directNotificationLayer === null &&
      this.stack.isAtBase() &&
      isDeviceAllowed();
    const isWakeOwner = () =>
      this.notifyResultRevision === revision &&
      isCallAuthorized() &&
      canAcquireSlot();
    if (!isWakeOwner()) throw new Error("The direct notification is not currently presentable.");
    if (!this.config.requestShellDelivery) {
      throw new Error("Strict glasses frame acknowledgement is unavailable.");
    }
    const returnToSleepOnClose = !this.screenOn;

    let preparation: { ready: boolean; commit: () => void; rollback: () => void } | null = null;
    let acknowledged = false;
    let layer: ShellAlertLayer | null = null;
    try {
      if (this.config.prepareDirectAssistantResultDisplay) {
        preparation = await awaitWithAbortSignal(
          this.config.prepareDirectAssistantResultDisplay(isWakeOwner),
          signal,
          "The direct notification was cancelled during display preparation.",
        );
      } else {
        const ready = this.config.prepareAssistantResultDisplay
          ? await awaitWithAbortSignal(
            this.config.prepareAssistantResultDisplay(isWakeOwner),
            signal,
            "The direct notification was cancelled during display preparation.",
          )
          : this.screenOn;
        preparation = { ready, commit: () => {}, rollback: () => {} };
      }
      if (!preparation.ready || !this.screenOn || !isWakeOwner()) {
        throw new Error("The glasses display could not be prepared for the direct notification.");
      }

      if (this.config.waitForShellRenderIdle) {
        await awaitWithAbortSignal(
          this.config.waitForShellRenderIdle(),
          signal,
          "The direct notification was cancelled while waiting for the shell renderer.",
        );
      }
      if (!isWakeOwner()) throw new Error("The direct notification presentation slot was superseded.");
      const directHeader = formatDirectNotificationHeaderParts(
        presentation.receivedAtMs,
        presentation.position,
        presentation.total,
        timeFormatSetting.get(),
      );
      const directLayer = new ShellAlertLayer(
        text,
        () => {
          directLayer.markCloseReason("dismissed");
          const wasTop = this.stack.topMatches((top) => top === directLayer);
          const ownsPriorSleep = this.directNotificationReturnToSleep === directLayer;
          this.stack.remove(directLayer);
          if (this.directNotificationLayer === directLayer) this.directNotificationLayer = null;
          if (ownsPriorSleep) this.directNotificationReturnToSleep = null;
          if (ownsPriorSleep && wasTop && this.screenOn) this.sleep();
          else this.config.requestShellRender();
        },
        "until-dismiss-or-sleep",
        {
          header: directHeader.leading,
          headerTrailing: directHeader.trailing,
          onReply: () => this.startAssistantResultReply(() => {
            directLayer.markCloseReason("dismissed");
            this.stack.remove(directLayer);
            if (this.directNotificationLayer === directLayer) this.directNotificationLayer = null;
            if (this.directNotificationReturnToSleep === directLayer) {
              this.directNotificationReturnToSleep = null;
            }
          }, returnToSleepOnClose),
          onRemoved: (reason) => {
            if (this.directNotificationLayer === directLayer) this.directNotificationLayer = null;
            if (this.directNotificationReturnToSleep === directLayer) {
              this.directNotificationReturnToSleep = null;
            }
            presentation.onClosed(reason);
          },
        },
      );
      layer = directLayer;
      this.directNotificationLayer = directLayer;
      if (returnToSleepOnClose) this.directNotificationReturnToSleep = directLayer;
      this.stack.push(directLayer);
      this.restartScreenTimeout();
      const isLayerOwner = () =>
        this.notifyResultRevision === revision &&
        this.directNotificationLayer === directLayer &&
        this.stack.topMatches((top) => top === directLayer) &&
        isCallAuthorized() &&
        this.activeVoiceLayer === null &&
        isDeviceAllowed();
      const delivery = this.config.requestShellDelivery(isLayerOwner);
      await awaitWithAbortSignal(delivery, signal, "The direct notification was cancelled during delivery.");
      if (isLayerOwner()) {
        // The encrypted FIFO tombstone must commit before the provisional wake.
        // If this throws, catch removes the card and rolls the exact wake back.
        presentation.onStrictFrameAcknowledged();
        acknowledged = true;
        preparation!.commit();
        this.restartScreenTimeout();
        // No cue occurs while off-head/unknown or while merely queued.
        void playEventBeep("assistantReply", this.config.actions.playBuzzerSequence);
      }
      if (!acknowledged) throw new Error("The direct notification was not visibly acknowledged.");
      return { acknowledged: true, successAllowed: isLayerOwner() };
    } catch (error) {
      if (!acknowledged) {
        if (layer) {
          layer.markCloseReason("preempted");
          this.stack.remove(layer);
          if (this.directNotificationLayer === layer) this.directNotificationLayer = null;
          if (this.directNotificationReturnToSleep === layer) {
            this.directNotificationReturnToSleep = null;
          }
          // Do not retain durable-inbox ownership while a best-effort base
          // repaint drains. Layout/session churn can keep the ordinary render
          // coalescer alive indefinitely; the next explicit lifecycle edge
          // must remain able to retry this still-pending notification.
          startDetachedCleanup(() => this.config.requestShellRender());
        }
        preparation?.rollback();
        throw error;
      }
      return { acknowledged: true, successAllowed: false };
    }
  }

  /** Show a compact text popup; ordinary assistant show_alert notices remain transient by default. */
  async showAlert(
    text: string,
    signal?: AbortSignal,
    isSideEffectAllowed?: () => boolean,
    onStrictFrameAcknowledged?: () => void,
    lifetime: ShellAlertLifetime = "transient",
    interaction: "dismiss-only" | "assistant-reply" = "dismiss-only",
  ): Promise<void> {
    if (!this.screenOn) throw new Error("The glasses display is off; no alert was sent.");
    if (this.clockAlertLayer) throw new Error("A Clock alert owns the glasses display.");
    if (this.activeVoiceLayer) throw new Error("Voice capture owns the glasses display.");
    if (this.hasOpaqueCardPresentation()) {
      throw new Error("An opaque card owns the display; no unrelated alert was sent.");
    }
    // Assistant result cards explicitly use the persistent lifetime; every
    // ordinary alert is unrelated shell chrome and must not preempt isolated
    // voice capture/result presentation.
    if (this.assistantOnlyPresentation && lifetime !== "until-dismiss-or-sleep") {
      throw new Error("The assistant voice presentation owns the display; no unrelated alert was sent.");
    }
    if (signal?.aborted || (isSideEffectAllowed && !isSideEffectAllowed())) throw new Error("The alert operation was cancelled; no alert was sent.");
    if (this.config.isDisplayAvailable && !this.config.isDisplayAvailable()) {
      throw new Error("The glasses are disconnected; no alert was sent.");
    }
    const revision = ++this.alertRevision;
    if (this.config.waitForShellRenderIdle) await this.config.waitForShellRenderIdle();
    if (
      this.alertRevision !== revision ||
      !this.screenOn ||
      this.clockAlertLayer !== null ||
      this.activeVoiceLayer !== null ||
      signal?.aborted ||
      (isSideEffectAllowed && !isSideEffectAllowed()) ||
      this.hasOpaqueCardPresentation() ||
      (this.assistantOnlyPresentation && lifetime !== "until-dismiss-or-sleep")
    ) {
      throw new Error("The alert operation was superseded or cancelled; no alert was sent.");
    }
    if (this.alertLayer) this.stack.remove(this.alertLayer);
    let layer: ShellAlertLayer;
    const isOwner = () => isStrictLayerOwner(
      revision,
      this.alertRevision,
      layer,
      this.alertLayer,
      this.stack.topMatches((top) => top === layer),
    ) &&
      this.screenOn &&
      this.clockAlertLayer === null &&
      this.activeVoiceLayer === null &&
      !this.hasOpaqueCardPresentation() &&
      (!this.assistantOnlyPresentation || lifetime === "until-dismiss-or-sleep");
    const dismiss = () => {
      layer.markCloseReason("dismissed");
      this.stack.remove(layer);
      if (this.alertLayer === layer) this.alertLayer = null;
      if (!this.finishAssistantOnlyResultDismissal()) {
        this.endAssistantOnlyPresentationIfIdle();
        this.config.requestShellRender();
      }
    };
    layer = new ShellAlertLayer(text, dismiss, lifetime, {
      onReply: interaction === "assistant-reply"
        ? () => this.startAssistantResultReply(dismiss)
        : undefined,
      onRemoved: () => this.notifyDirectNotificationOpportunity(),
    });
    this.alertLayer = layer;
    this.stack.push(layer);
    // Prevent a stale pre-presentation idle deadline from sleeping the display
    // while this exact frame is still passing through strict delivery.
    this.restartScreenTimeout();
    let abortReject: ((reason?: unknown) => void) | null = null;
    const abortPromise = signal
      ? new Promise<void>((_resolve, reject) => { abortReject = reject; })
      : null;
    const onAbort = () => abortReject?.(new Error("The alert operation was cancelled; no alert was sent."));
    try {
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
      if (signal?.aborted || (isSideEffectAllowed && !isSideEffectAllowed())) throw new Error("The alert operation was cancelled; no alert was sent.");
      const delivery = this.config.requestShellDelivery
        ? this.config.requestShellDelivery(() => isOwner() && !signal?.aborted && (!isSideEffectAllowed || isSideEffectAllowed()))
        : Promise.resolve(this.config.requestShellRender());
      await (abortPromise ? Promise.race([delivery, abortPromise]) : delivery);
      if (isOwner()) {
        // Start the full global reading interval at the accepted presentation,
        // without invalidating a direct result's provisional wake lease.
        this.restartScreenTimeout();
        layer.armTransientDismissTimer();
        onStrictFrameAcknowledged?.();
      }
      if (!isOwner() || signal?.aborted || (isSideEffectAllowed && !isSideEffectAllowed())) {
        throw new Error("The alert operation was superseded or cancelled; no alert was sent.");
      }
    } catch (error) {
      this.stack.remove(layer);
      if (this.alertLayer === layer) this.alertLayer = null;
      if (lifetime === "until-dismiss-or-sleep") {
        // A retained assistant result may still own a provisional wake. Do not
        // delay its caller's rollback behind a best-effort cleanup repaint.
        startDetachedCleanup(() => this.config.requestShellRender());
      } else {
        try { await this.config.requestShellRender(); } catch { /* preserve transport error */ }
      }
      throw error;
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }

  /** Replace the one shell-owned MCP view without waking or changing focus. */
  async showRemoteView(
    state: RenderViewState,
    signal: AbortSignal | undefined,
    isSideEffectAllowed: (() => boolean) | undefined,
    onGesture: (type: "scroll-up" | "scroll-down" | "click", foreground: boolean) => boolean,
    onClose: () => void,
  ): Promise<void> {
    if (this.clockAlertLayer) {
      throw new Error("A Clock alert owns the glasses display; no remote view was sent.");
    }
    if (this.notificationModalPresentationPending !== null) {
      throw new Error("A notification modal is awaiting delivery; no remote view was sent.");
    }
    if (this.hasOpaqueCardPresentation()) {
      throw new Error("An opaque card owns the display; no remote view was sent.");
    }
    if (this.assistantOnlyPresentation) {
      throw new Error("The assistant voice presentation owns the display; no remote view was sent.");
    }
    if (!this.screenOn) throw new Error("The glasses display is off; no view was sent.");
    if (this.config.isDisplayAvailable && !this.config.isDisplayAvailable()) {
      throw new Error("The glasses are disconnected; no view was sent.");
    }
    if (signal?.aborted || (isSideEffectAllowed && !isSideEffectAllowed())) {
      throw new Error("The view operation is no longer current.");
    }
    const prior = this.remoteViewLayer;
    const layer = new ShellRemoteViewLayer(state, onGesture, onClose);
    if (prior) this.stack.remove(prior);
    this.remoteViewLayer = layer;
    this.stack.push(layer);
    this.assistantResultWakeOwnership.invalidate();
    const isOwner = () =>
      this.remoteViewLayer === layer &&
      this.clockAlertLayer === null &&
      !this.hasOpaqueCardPresentation() &&
      this.stack.topMatches((top) => top === layer) &&
      !signal?.aborted &&
      (!isSideEffectAllowed || isSideEffectAllowed());
    try {
      const delivery = this.config.requestShellDelivery
        ? this.config.requestShellDelivery(isOwner)
        : Promise.resolve(this.config.requestShellRender());
      await delivery;
      if (!isOwner()) throw new Error("The view operation was superseded before delivery completed.");
    } catch (error) {
      this.stack.remove(layer);
      if (this.remoteViewLayer === layer) {
        this.remoteViewLayer = prior;
        if (prior) {
          const clock = this.clockAlertLayer;
          if (!clock || !this.stack.insertBefore(prior, clock)) this.stack.push(prior);
        }
      }
      try { await this.config.requestShellRender(); } catch { /* preserve delivery error */ }
      throw error;
    }
  }

  clearRemoteView(identity: { viewId: string; revision: number }): void {
    const layer = this.remoteViewLayer;
    if (!layer || layer.state.viewId !== identity.viewId || layer.state.revision !== identity.revision) return;
    this.stack.remove(layer);
    this.remoteViewLayer = null;
    this.config.requestShellRender();
  }

  /** Deliver a provider-neutral dynamic app without waking or changing focus. */
  async showDynamicApp(
    state: DynamicAppState,
    signal: AbortSignal | undefined,
    isSideEffectAllowed: (() => boolean) | undefined,
    onInput: (type: "scroll-up" | "scroll-down" | "click", foreground: boolean) => boolean,
    onClose: () => void,
    options: Readonly<{ assistantTurnResult?: boolean }> = {},
  ): Promise<{ status: "acknowledged"; frameId: number }> {
    const contextState = state as DynamicAppState & {
      contextIntent?: string;
      dashboardId?: string;
      dashboardState?: string;
      answerPresentation?: string;
      presentationMode?: "single" | "deck";
      pageId?: string;
    };
    const finalContextAnswer = Boolean(
      options.assistantTurnResult === true &&
      contextState.answerPresentation === "atomic-final-only" &&
      contextState.dashboardId &&
      contextState.contextIntent &&
      ["ready", "empty", "error", "offline"].includes(contextState.dashboardState ?? "") &&
      isSideEffectAllowed,
    );
    const answerAssistant = finalContextAnswer ? this.assistantLayer : null;
    const answerStillCurrent = () => Boolean(
      finalContextAnswer &&
      answerAssistant &&
      this.assistantLayer === answerAssistant &&
      this.assistantTurnBackgrounded &&
      this.assistantSession?.isTurnActive() &&
      !this.activeVoiceLayer &&
      !signal?.aborted &&
      isSideEffectAllowed?.(),
    );
    const mayPresentAssistantAnswer = answerStillCurrent() && (
      this.screenOn
        ? (!this.assistantOnlyPresentation || this.isolatedAssistantTurn === answerAssistant)
        : this.isolatedAssistantTurn === answerAssistant
    );
    if (this.assistantOnlyPresentation && !mayPresentAssistantAnswer) {
      throw new Error("The assistant voice presentation owns the display; no dynamic app was sent.");
    }
    if (!this.screenOn && !mayPresentAssistantAnswer) {
      throw new Error("The glasses display is off; no dynamic app was sent.");
    }
    if (this.config.isDisplayAvailable && !this.config.isDisplayAvailable()) {
      throw new Error("The glasses are disconnected; no dynamic app was sent.");
    }
    if (signal?.aborted || (isSideEffectAllowed && !isSideEffectAllowed())) {
      throw new Error("The dynamic app operation is stale.");
    }
    if (this.notificationModalPresentationPending !== null) {
      throw new Error("A notification modal is awaiting delivery; no dynamic app was sent.");
    }
    const terminalClockWasPresent = this.clockAlertLayer !== null;
    if (this.clockAlertLayer && !this.releaseTerminalClockAlertLayer()) {
      throw new Error("An active Clock alert owns the glasses display; no dynamic app was sent.");
    }
    if (this.hasOpaqueCardPresentation()) {
      // A terminal Clock can cover a sleep-origin opaque card. Retire the Clock
      // atomically first, then reveal that exact retained owner instead of
      // letting an unrelated dynamic result steal its return-to-sleep state.
      if (terminalClockWasPresent) this.config.requestShellRender();
      throw new Error("An opaque card owns the display; no dynamic app was sent.");
    }
    const isolatedAnswer = mayPresentAssistantAnswer && !this.screenOn;
    let prior = this.dynamicAppLayer;
    const priorWasAssistantOnly = prior !== null && this.assistantOnlyDynamicAppLayer === prior;
    const priorContextPrefix = prior ? this.contextDashboardVoicePrefix : null;
    const layer = new ShellDynamicAppLayer(
      state,
      onInput,
      onClose,
      () => this.focus === "sidebar" && this.hasManageableWindow() ? "window management" : "ask",
    );
    let preparation: AssistantResultDisplayPreparation | null = null;
    let displacedAssistant: AssistantLayer | null = null;
    const installFinalLayer = () => {
      if (prior && prior.state.viewId !== state.viewId) {
        // A different manager/view is claiming the one remote-app surface. Tell
        // the displaced owner first so its timers/events cannot remain live.
        prior.close();
        prior = null;
      }
      // A dashboard opened by the current assistant turn must become visible
      // before that turn can continue. Detach the assistant overlay without its
      // onRemoved cancellation hook; callbacks may finish the still-live turn in
      // the background while the dashboard owns the lenses.
      displacedAssistant = contextState.dashboardId && !finalContextAnswer ? this.assistantLayer : null;
      if (displacedAssistant) {
        this.stack.detach(displacedAssistant);
        this.assistantLayer = null;
        this.detachedAssistantLayer = displacedAssistant;
        // Tool activity may already have removed this overlay through the
        // background-task path. Once a context dashboard owns the same turn,
        // detachedAssistantLayer is the sole retained owner; stale background
        // bookkeeping would otherwise duplicate the next assistant layer.
        this.assistantTurnBackgrounded = false;
        this.assistantOverlayRestorePending = false;
      }
      if (prior) this.stack.remove(prior);
      this.dynamicAppLayer = layer;
      if (isolatedAnswer || priorWasAssistantOnly) this.assistantOnlyDynamicAppLayer = layer;
      this.contextDashboardVoicePrefix = contextState.dashboardId && contextState.contextIntent
        ? `Context dashboard intent: ${contextState.contextIntent}. ${contextState.presentationMode === "deck"
            ? `Current page: ${state.title} (${contextState.pageId ?? "cover"})`
            : `Focused item: ${state.components[state.scrollOffset]?.id ?? "summary"}`}.`
        : null;
      this.stack.push(layer);
    };
    if (isolatedAnswer) {
      // Wake over a deliberately blank isolated shell first. Installing the
      // result layer before this barrier lets the wake-triggered ordinary
      // render race the strict send and turn it into a no-change receipt.
      const wakeOwner = () =>
        this.dynamicAppLayer === prior &&
        this.clockAlertLayer === null &&
        !this.hasOpaqueCardPresentation() &&
        answerStillCurrent();
      preparation = await prepareAtomicAssistantResultLayer({
        enterIsolation: () => this.setAssistantOnlyPresentation(true),
        prepare: async () => this.config.prepareIsolatedAssistantResultDisplay
          ? this.config.prepareIsolatedAssistantResultDisplay(wakeOwner)
          : null,
        isReadyCurrent: () => this.screenOn && wakeOwner(),
        // Drain the blank wake render before making the unique final frame
        // paintable. The provisional wake remains owned throughout this wait.
        drainBlankRender: async () => {
          if (this.config.waitForShellRenderIdle) await this.config.waitForShellRenderIdle();
        },
        installFinalLayer,
        releaseIsolationIfAsleep: () => {
          if (!this.screenOn) this.setAssistantOnlyPresentation(false);
        },
      });
    } else {
      installFinalLayer();
    }
    // The isolated result's acquired wake stays provisional until its own
    // unique frame is strictly acknowledged. Ordinary dynamic apps still
    // claim any older assistant-result wake immediately.
    if (!isolatedAnswer) this.assistantResultWakeOwnership.invalidate();
    const isOwner = () =>
      this.dynamicAppLayer === layer &&
      this.clockAlertLayer === null &&
      !this.hasOpaqueCardPresentation() &&
      this.stack.topMatches((top) => top === layer) &&
      !signal?.aborted &&
      (!isSideEffectAllowed || isSideEffectAllowed()) &&
      (!finalContextAnswer || answerStillCurrent());
    let acknowledged = false;
    try {
      // The pre-send and accepted-result deadlines are both based on the full
      // global reading timeout. Re-baselining does not invalidate a provisional
      // assistant-result wake lease (noteUserActivity would).
      this.restartScreenTimeout();
      const receipt = this.config.requestShellDelivery
        ? await this.config.requestShellDelivery(isOwner)
        : (() => { this.config.requestShellRender(); return { frameId: 0, outcome: "unverified" }; })();
      if (!isOwner() || receipt.frameId <= 0 || !isSuccessfulFrameOutcome(receipt.outcome)) {
        throw new Error("The dynamic app did not receive a current transport acknowledgement.");
      }
      this.restartScreenTimeout();
      // Only the exact strictly acknowledged final card may replace the hidden
      // assistant. Until this point, a failed wake leaves the live turn intact
      // so Hermes can return a compact fallback result instead.
      if (finalContextAnswer && answerAssistant && this.assistantLayer === answerAssistant) {
        this.stack.detach(answerAssistant);
        this.assistantLayer = null;
        this.detachedAssistantLayer = answerAssistant;
        this.assistantTurnBackgrounded = false;
        this.assistantOverlayRestorePending = false;
        if (this.isolatedAssistantTurn === answerAssistant) this.isolatedAssistantTurn = null;
      }
      preparation?.commit();
      acknowledged = true;
      return { status: "acknowledged", frameId: receipt.frameId };
    } catch (error) {
      const ownsLayer = this.dynamicAppLayer === layer;
      this.stack.remove(layer);
      if (ownsLayer) {
        this.dynamicAppLayer = prior;
        if (this.assistantOnlyDynamicAppLayer === layer) {
          this.assistantOnlyDynamicAppLayer = priorWasAssistantOnly ? prior : null;
        }
        this.contextDashboardVoicePrefix = priorContextPrefix;
        if (prior) {
          const clock = this.clockAlertLayer;
          if (!clock || !this.stack.insertBefore(prior, clock)) this.stack.push(prior);
        }
        if (displacedAssistant && shouldRestoreDisplacedAssistant({
          ownsLayer,
          screenOn: this.screenOn,
          displayAvailable: !this.config.isDisplayAvailable || this.config.isDisplayAvailable(),
          operationCurrent: !signal?.aborted && (!isSideEffectAllowed || isSideEffectAllowed()),
          assistantSlotEmpty: !this.assistantLayer,
          assistantRetained: this.detachedAssistantLayer === displacedAssistant,
        })) {
          this.detachedAssistantLayer = null;
          this.assistantLayer = displacedAssistant;
          const clock = this.clockAlertLayer;
          if (!clock || !this.stack.insertBefore(displacedAssistant, clock)) {
            this.stack.push(displacedAssistant);
          }
        }
      }
      if (isolatedAnswer) {
        // Roll back the provisional wake before releasing hidden app surfaces;
        // a best-effort repaint here could otherwise expose the retained HUD.
        preparation?.rollback();
        if (!this.screenOn) this.setAssistantOnlyPresentation(false);
      } else {
        try { await this.config.requestShellRender(); } catch { /* preserve delivery error */ }
      }
      throw error;
    } finally {
      if (isolatedAnswer && !acknowledged && preparation?.ready === true && !this.screenOn) {
        this.setAssistantOnlyPresentation(false);
      }
    }
  }

  clearDynamicApp(identity: { viewId: string; revision: number }): void {
    const layer = this.dynamicAppLayer;
    if (!layer || layer.state.viewId !== identity.viewId || layer.state.revision !== identity.revision) return;
    this.stack.remove(layer);
    this.dynamicAppLayer = null;
    const closedAssistantOnlyAnswer = this.assistantOnlyDynamicAppLayer === layer;
    if (closedAssistantOnlyAnswer) this.assistantOnlyDynamicAppLayer = null;
    this.contextDashboardVoicePrefix = null;
    this.config.requestShellRender();
    if (closedAssistantOnlyAnswer) {
      // clearDynamicApp can run from inside sleep(). Defer the return-to-sleep
      // decision until that outer transition has either completed or yielded.
      // A contextual follow-up may already own the same isolated lease while
      // its replacement final is waiting for the wake barrier; that live turn
      // must win over this stale close.
      deferAssistantOnlyAnswerClose({
        isIsolated: () => this.assistantOnlyPresentation,
        hasReplacement: () => this.dynamicAppLayer !== null,
        hasAssistantContinuation: () => Boolean(
          this.activeVoiceLayer ||
          this.assistantOnlyReplyStarting ||
          this.assistantTurnBackgrounded ||
          this.assistantLayer ||
          this.alertLayer ||
          this.directNotificationLayer ||
          this.pendingAssistantResult ||
          this.assistantSession?.isTurnActive()
        ),
        isScreenOn: () => this.screenOn,
        sleep: () => this.sleep(),
        releaseIsolation: () => this.setAssistantOnlyPresentation(false),
      });
    }
  }

  /** Physical transport loss tombstones remote authority before any reconnect. */
  closeDynamicApp(): void {
    this.dynamicAppLayer?.close();
  }

  private startEscapeMenuTimer(): void {
    this.cancelEscapeMenuTimer();
    this.escapeMenuTimer = setTimeout(() => {
      this.escapeMenuTimer = null;
      this.openEscapeMenu();
    }, LONG_PRESS_ESCAPE_MENU_MS);
  }

  private cancelEscapeMenuTimer(): void {
    if (this.escapeMenuTimer !== null) {
      clearTimeout(this.escapeMenuTimer);
      this.escapeMenuTimer = null;
    }
  }

  /**
   * The held-long-press safeguard menu. Shell-owned and shell-drawn (never
   * the app's), so an unresponsive app can always be closed. It opens over
   * whatever the app did with the long-press, including its own menu.
   */
  private openEscapeMenu(): void {
    if (!this.screenOn || this.activeVoiceLayer || !this.stack.isAtBase()) return;
    // A longer hold opening the escape menu supersedes Window Management.
    this.exitWindowManagement();
    const foreground = this.foregroundWindow();
    if (!foreground) return;
    const items: MenuItem[] = [];
    if (foreground.closeable) {
      items.push({
        label: "Close window",
        onSelect: (ctx) => {
          // Pop the menu first (its onRemoved returns focus to the sidebar),
          // then close the window the menu was opened over.
          ctx.stack.pop();
          this.closeForegroundWindow();
        },
      });
    }
    items.push({
      label: "Debug",
      onSelect: (ctx) => {
        ctx.stack.pop();
        this.openToolDebugDialog();
      },
    });
    this.stack.push(new ShellOverlayMenuLayer(items, () => this.yieldFocusToSidebar()));
    this.config.requestShellRender();
  }

  /**
   * Escape menu > Debug: list the assistant tools registered for the
   * foreground window's app (live or gated). System-wide "always" tools are
   * constant and omitted.
   */
  private openToolDebugDialog(): void {
    const foreground = this.foregroundWindow();
    const appId = foreground?.appId ?? null;
    const entries = appId
      ? toolRegistry
          .listToolsForDebug()
          .filter(
            (entry) =>
              entry.spec.name.startsWith(`app.${appId}.`) || entry.windowId === foreground!.windowId,
          )
      : [];
    this.stack.push(new ToolDebugMenuLayer(appId, entries, () => this.yieldFocusToSidebar()));
    this.config.requestShellRender();
  }

  private chromeState(): ShellChromeState {
    return {
      windows: this.windows.map((window) => ({
        windowId: window.windowId,
        title: window.title,
        attention: Boolean(this.attention.get(window.windowId)),
        drawIcon: window.drawIcon,
      })),
      selectedIndex: this.selectedIndex,
      focus: this.focus,
      sidebarBounceY: this.sidebarBounce.offsetPx(),
      closing: this.closingActive,
      closingAction:
        this.windows[this.selectedIndex] === this.healthWindow
          ? "hide"
          : this.windows[this.selectedIndex]?.closeable === false
            ? "pinned"
            : "close",
      managementCanMove: this.canReorder(this.windows[this.selectedIndex]?.windowId ?? ""),
      ringConfigured: this.ringConfigured,
      ...this.reorderChromeState(),
      foregroundHeightMode: this.foregroundWindow()?.heightMode ?? "min",
      battery: this.battery,
      ringHeartRate: this.ringHeartRate,
      trayIcons: Array.from(this.trayIcons.keys())
        .sort()
        .map((key) => this.trayIcons.get(key)!),
      bridge: {
        // External mode always identifies the gateway, including a SETUP
        // state when the host is blank; on-phone/direct backends omit it.
        show: assistantBackendSetting.get() === "external",
        configured:
          assistantBridgeHostSetting.get().trim().length > 0 &&
          assistantBridgeTokenSetting.get().length > 0,
        phase: this.bridgePhase,
      },
    };
  }
}

export const shell = new Shell();

const ASSISTANT_WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const ASSISTANT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Human-readable local time for the assistant's per-turn context. */
function formatAssistantTime(date: Date): string {
  let hours = date.getHours();
  const minutes = date.getMinutes().toString().padStart(2, "0");
  const meridiem = hours >= 12 ? "PM" : "AM";
  hours = hours % 12;
  if (hours === 0) hours = 12;
  const day = `${ASSISTANT_WEEKDAYS[date.getDay()]} ${ASSISTANT_MONTHS[date.getMonth()]} ${date.getDate()}`;
  return `${day}, ${hours}:${minutes} ${meridiem}`;
}

export function rawInputEventToInputEvent(event: RawInputEvent): DashboardInputEvent {
  if (event.kind === "sys-event") {
    if (event.eventType === OsEventTypeList.CLICK_EVENT) {
      return {
        type: "click",
        source: eventSourceToString(event.eventSource),
      };
    } else if (event.eventType === OsEventTypeList.DOUBLE_CLICK_EVENT) {
      return {
        type: "double-click",
        source: eventSourceToString(event.eventSource),
      };
    } else if (event.eventType === OsEventTypeList.SCROLL_BOTTOM_EVENT) {
      return { type: "scroll-down" };
    } else if (event.eventType === OsEventTypeList.SCROLL_TOP_EVENT) {
      return { type: "scroll-up" };
    } else if (event.eventType === OsEventTypeList.RING_LONG_PRESS_EVENT) {
      // CFW-forwarded long-press (replaces the firmware's force-quit dialog).
      // The CFW gates this to the ring, so eventSource may be 0 (unknown);
      // eventSourceToString falls back to "ring".
      return { type: "long-press", source: eventSourceToString(event.eventSource) };
    } else if (event.eventType === OsEventTypeList.RING_LONG_PRESS_RELEASE_EVENT) {
      return { type: "long-press-release", source: eventSourceToString(event.eventSource) };
    }
  } else if (event.kind === "even-ai") {
    // sid 0x07 EvenAIDataPackage; eventType carries eEvenAIStatus. Only the
    // wakeword interests us -- ENTER means the user manually opened the stock
    // assistant, and EXIT is it tearing down.
    if (event.eventType === EvenAIStatus.EVEN_AI_WAKE_UP) {
      return { type: "wakeword" };
    }
  } else if (event.kind === "display-wake") {
    // Outside an EvenHub page the firmware consumes the physical double tap
    // itself and reports only that the stock display lifecycle woke.
    return { type: "display-wake" };
  } else if (event.kind === "text-click") {
    if (event.eventType === OsEventTypeList.SCROLL_BOTTOM_EVENT) {
      return { type: "scroll-down" };
    } else if (event.eventType === OsEventTypeList.SCROLL_TOP_EVENT) {
      return { type: "scroll-up" };
    }
  }
  return {
    type: "unknown",
    kind: event.kind,
    eventSource: event.eventSource,
    eventType: event.eventType,
  };
}

function eventSourceToString(eventSource: number): "ring" | "left-arm" | "right-arm" {
  if (eventSource === EventSourceType.TOUCH_EVENT_FROM_RING) {
    return "ring";
  } else if (eventSource === EventSourceType.TOUCH_EVENT_FROM_GLASSES_L) {
    return "left-arm";
  } else if (eventSource === EventSourceType.TOUCH_EVENT_FROM_GLASSES_R) {
    return "right-arm";
  }
  return "ring";
}

export function inputEventToString(event: DashboardInputEvent): string {
  switch (event.type) {
    case "click":
      return `Click from ${event.source}`;
    case "double-click":
      return `Double click from ${event.source}`;
    case "scroll-up":
      return `Scroll up`;
    case "scroll-down":
      return `Scroll down`;
    case "long-press":
      return `Long press from ${event.source}`;
    case "long-press-release":
      return `Long press release from ${event.source}`;
    case "display-wake":
      return `Display wake`;
    case "wakeword":
      return `Wakeword`;
    default:
    case "unknown":
      return `Unknown event: ${event.kind} ${event.eventSource} ${event.eventType}`;
  }
}
