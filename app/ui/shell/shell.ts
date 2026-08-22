import { G2_LENS_HEIGHT, G2_LENS_WIDTH, GrayImage } from "../../graphics/image";
import { getDefaultSmallFont } from "../../graphics/bdffont";
import { EvenAIStatus, EventSourceType, OsEventTypeList } from "../../g2/events";
import type { RawInputEvent } from "../../native/faceclaw-communicator";
import { DashboardInputEvent, Layer, LayerActions, LayerContext, LayerStack, noopLayerActions } from "../layers";
import { MenuLayer, type MenuItem } from "../menu";
import { VoiceInputLayer, type VoiceSendTarget } from "./voice-input";
import { AssistantLayer } from "./assistant";
import { AssistantSession, type AssistantBackendConfig } from "../../assistant/session";
import { resolveAssistantModel } from "../../assistant/models";
import type { AssistantContext } from "../../assistant/types";
import { SingleNotificationLayer } from "../notifications";
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
import { ShellModalLayer } from "./modal-layer";
import { ToolDebugMenuLayer } from "./tool-debug-layer";
import { playEventBeep } from "../event-beeps";
import { MusicCardLayer } from "./music-card";
import { toolRegistry } from "../../assistant/tool-registry";
import type { RenderViewState } from "../../assistant/render-view";
import type { DynamicAppState } from "../../assistant/dynamic-app";
import { ShellRemoteViewLayer } from "./render-view-layer";
import { ShellDynamicAppLayer } from "./dynamic-app-layer";
import {
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
};

export type ShellConfig = {
  /** Actions handed to shell overlay layers; requestRender must re-render the shell surface. */
  actions: LayerActions;
  getScreenTimeoutMs: () => number | null;
  requestShellRender: () => void | Promise<void>;
  /** Awaited delivery path for operations that must prove lens transport success. */
  requestShellDelivery?: (isAllowed?: () => boolean) => Promise<{ frameId: number; outcome: string }>;
  /** True only while a real glasses transport/session can accept frames. */
  isDisplayAvailable?: () => boolean;
  /** Screen on/off changed: the controller blanks/unblanks the compositor. */
  onScreenStateChanged: (on: boolean) => void;
  /** Window registered/removed or foreground changed (persists the open-app list). */
  onWindowsChanged?: () => void;
  /** The Health side card was hidden/shown (persists the choice). */
  onHealthHiddenChanged?: (hidden: boolean) => void;
};

/** Which surfaces need re-rendering after an input event. */
export type ShellInputOutcome = { shell: boolean; window: boolean };

type FocusKind = "sidebar" | "window";

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

/** How long a show_alert popup stays before auto-dismissing. */
const ALERT_DISMISS_MS = 6000;
const ALERT_X = 40;
const ALERT_W = G2_LENS_WIDTH - 80;
const ALERT_Y = 96;
const ALERT_H = 96;

/**
 * A brief text popup on the shell surface (the assistant's show_alert tool and
 * other short notices). Auto-dismisses after a few seconds; a click or
 * double-click dismisses it early.
 */
class ShellAlertLayer implements Layer {
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly text: string, private readonly onDismiss: () => void) {
    this.timer = setTimeout(() => {
      this.timer = null;
      this.onDismiss();
    }, ALERT_DISMISS_MS);
  }

  paint(_ctx: LayerContext, paintBelow: () => GrayImage): GrayImage {
    const image = paintBelow();
    const font = getDefaultSmallFont();
    // Positioned within the min-height window band, like the other shell overlays.
    const alertY = minWindowTop() + ALERT_Y;
    image.fillRoundedRect(ALERT_X, alertY, ALERT_W, ALERT_H, 1, 10);
    image.drawRoundedRect(ALERT_X, alertY, ALERT_W, ALERT_H, 90, 10);
    image.drawText(font, ALERT_X + 16, alertY + 12, "Assistant", 200);
    image.drawTextWrapped({
      font,
      x: ALERT_X + 16,
      y: alertY + 34,
      width: ALERT_W - 32,
      text: this.text,
      value: 235,
    });
    return image;
  }

  handleInput(event: DashboardInputEvent, _ctx: LayerContext): void {
    if (event.type === "click" || event.type === "double-click") {
      this.clearTimer();
      this.onDismiss();
    }
  }

  onRemoved(): void {
    this.clearTimer();
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
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
  // Sidebar reorder: the id of the tab "picked up" by a long-press, moved with
  // scroll and dropped with a tap. null when not reordering. The moved order is
  // the window array order, which onWindowsChanged persists like any switch.
  private reorderingWindowId: string | null = null;
  // Quick-close mode: long-press a sidebar card to arm it, then scroll to pick a
  // card and tap to close it. Double-tap exits. Lets windows be closed fast
  // without focusing each and walking its menu.
  private closingActive = false;
  // Ring-sensitivity throttle: timestamp of the last honored scroll. A physical
  // swipe fires a burst of scroll events; at lower sensitivity we drop the ones
  // that arrive within the configured interval so one swipe steps once or twice.
  private lastScrollHonoredAtMs = 0;
  private screenOn = true;
  private lastInputAtMs = Date.now();
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
  private assistantSession: AssistantSession | null = null;
  private musicCard: MusicCardLayer | null = null;
  private musicCardWokeScreen = false;
  private assistantLayer: AssistantLayer | null = null;
  private alertLayer: ShellAlertLayer | null = null;
  private alertRevision = 0;
  private remoteViewLayer: ShellRemoteViewLayer | null = null;
  private dynamicAppLayer: ShellDynamicAppLayer | null = null;
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
    onAnySettingChanged(() => {
      const batteryMode = batteryDisplayModeSetting.get();
      const timeFormat = timeFormatSetting.get();
      const brightness = brightnessSetting.get();
      const bridgeBackend = assistantBackendSetting.get();
      const bridgeHost = assistantBridgeHostSetting.get().trim();
      if (
        batteryMode === this.lastBatteryDisplayMode &&
        timeFormat === this.lastTimeFormat &&
        brightness === this.lastBrightness &&
        bridgeBackend === this.lastBridgeBackend &&
        bridgeHost === this.lastBridgeHost
      ) {
        return;
      }
      this.lastBatteryDisplayMode = batteryMode;
      this.lastTimeFormat = timeFormat;
      this.lastBrightness = brightness;
      this.lastBridgeBackend = bridgeBackend;
      this.lastBridgeHost = bridgeHost;
      this.config.requestShellRender();
    });
    // The bridge glyph tracks live connection phase; repaint the bar on change.
    assistantBridge.onStateChange((state) => {
      if (state.phase === this.bridgePhase) return;
      this.bridgePhase = state.phase;
      this.config.requestShellRender();
    });
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
    const wasSelected = index === this.selectedIndex;
    this.windows.splice(index, 1);
    this.attention.delete(windowId);
    this.mruWindowIds = this.mruWindowIds.filter((id) => id !== windowId);
    if (wasSelected) {
      // Return to the most recently visible remaining window.
      const mruIndex = this.mostRecentWindowIndex();
      this.selectedIndex =
        mruIndex >= 0 ? mruIndex : Math.min(index, Math.max(0, this.windows.length - 1));
    } else if (this.selectedIndex > index) {
      this.selectedIndex--;
    }
    if (this.focus === "window" && (wasSelected || !this.windows.length)) {
      this.focus = "sidebar";
    }
    if (wasSelected) {
      // Hand the foreground to whatever is now selected.
      const next = this.windows[this.selectedIndex];
      if (next) {
        this.noteWindowVisible(next.windowId);
        next.setForeground?.(true);
        next.requestRender();
      }
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
    this.lastInputAtMs = nowMs;
  }

  /** Turn the screen on (if off) and set focus. Returns whether it was off. */
  wake(focus: FocusKind, nowMs = Date.now()): boolean {
    this.lastInputAtMs = nowMs;
    this.focus = focus;
    if (this.screenOn) return false;
    this.screenOn = true;
    this.config.onScreenStateChanged(true);
    for (const window of this.windows) {
      window.setScreenOn?.(true);
    }
    // Refresh the foreground window; the compositor restored its retained
    // frame, but its content may be stale (e.g. a running stopwatch).
    this.foregroundWindow()?.requestRender();
    return true;
  }

  /** Turn the screen off, closing any shell overlays. Sidebar selection is kept. */
  sleep(): void {
    if (!this.screenOn) return;
    this.cancelEscapeMenuTimer();
    this.closingActive = false;
    // A remote MCP view is transient and must not survive a display-off
    // transition in retained manager state or reappear after wake.
    this.remoteViewLayer?.close();
    this.dynamicAppLayer?.close();
    this.screenOn = false;
    this.stack.clearToBase();
    // clearToBase pops the card and fires its onRemoved (timers cleared); null
    // the refs so an idle/external sleep can't leave a dangling card.
    this.musicCard = null;
    this.musicCardWokeScreen = false;
    for (const window of this.windows) {
      window.setScreenOn?.(false);
    }
    this.config.onScreenStateChanged(false);
  }

  /** Foreground and focus a window by id (e.g. a wake path opening content in it). */
  focusWindow(windowId: string): void {
    const index = this.windows.findIndex((w) => w.windowId === windowId);
    if (index < 0) return;
    this.setSelectedIndex(index);
    this.focus = "window";
  }

  /** Idle timeout: sleep if the configured timeout elapsed. Returns whether it slept. */
  applyScreenTimeout(nowMs = Date.now()): boolean {
    const timeoutMs = this.config.getScreenTimeoutMs();
    if (timeoutMs === null || !this.screenOn) return false;
    // An open voice dialog suspends the timeout: a long dictation or refine
    // has no button presses, but the screen must stay on for it. Sliding
    // lastInputAtMs forward also restarts the full timeout when it closes.
    // An in-flight assistant turn suspends it for the same reason (a tool loop
    // can run for a while with no input); once the turn ends and the
    // Follow-up/Done menu is showing, the normal idle timeout resumes.
    if (this.activeVoiceLayer || this.assistantSession?.isTurnActive() || this.musicCard) {
      // A live music card owns the screen (drop/hold/rise + its own dismiss
      // timer); suspend the idle timeout so it can't race the card's own blank.
      this.lastInputAtMs = nowMs;
      return false;
    }
    if (nowMs - this.lastInputAtMs < timeoutMs) return false;
    this.sleep();
    return true;
  }

  /**
   * Show a new notification in a shell modal over the app viewport. If the
   * notification woke the screen, closing the modal goes back to sleep
   * (matching the old sleep-popup behavior).
   */
  openNotificationModal(notificationKey: string, wokeScreen: boolean): void {
    if (!this.screenOn) return;
    // A notification preempts an active music card. Evict the card first (it is
    // always top when active) and inherit its wake ownership, so closing the
    // notification still re-sleeps if the card is what woke the screen. Without
    // this, the card's later rise would fail popIfTop and strand a zombie layer.
    let owned = wokeScreen;
    if (this.musicCard) {
      const card = this.musicCard;
      this.stack.popIfTop((l) => l === card);
      if (this.musicCardWokeScreen) owned = true;
      this.musicCard = null;
      this.musicCardWokeScreen = false;
    }
    const modal: ShellModalLayer = new ShellModalLayer(
      new SingleNotificationLayer(notificationKey, {
        origin: "new-notification-modal",
        closeModal: () => this.closeNotificationModal(modal, owned),
      }),
      this.config.actions,
    );
    this.stack.push(modal);
    this.config.requestShellRender();
  }

  /** Whether the screen-off now-playing card is currently up. */
  isMusicCardActive(): boolean {
    return this.musicCard !== null;
  }

  /**
   * Present, or (if one is already up) refresh, the song-change card. The caller
   * wakes the screen first. Returns false if another overlay owns the screen.
   */
  openMusicCard(wokeScreen: boolean): boolean {
    if (!this.screenOn) return false;
    if (this.musicCard) {
      this.musicCard.onTrackChanged();
      return true;
    }
    if (!this.stack.isAtBase()) return false; // notification / voice / menu owns the screen
    const card = new MusicCardLayer({
      actions: this.config.actions,
      onDismissed: () => this.closeMusicCard(card),
    });
    this.musicCard = card;
    this.musicCardWokeScreen = wokeScreen;
    this.stack.push(card);
    this.config.requestShellRender();
    return true;
  }

  private closeMusicCard(card: MusicCardLayer): void {
    if (this.musicCard !== card) return; // stale (already replaced/torn down)
    this.stack.popIfTop((l) => l === card);
    const woke = this.musicCardWokeScreen;
    this.musicCard = null;
    this.musicCardWokeScreen = false;
    if (woke) this.sleep();
    else this.config.requestShellRender();
  }

  private closeNotificationModal(modal: ShellModalLayer, wokeScreen: boolean): void {
    this.stack.popIfTop((layer) => layer === modal);
    if (wokeScreen) {
      this.sleep();
    }
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
    if (!this.screenOn) {
      return new GrayImage(G2_LENS_WIDTH, G2_LENS_HEIGHT, 0);
    }
    return this.stack.paint();
  }

  async receiveInput(event: DashboardInputEvent, frameId = 0): Promise<ShellInputOutcome> {
    // The stock lifecycle has already interpreted the physical double tap as
    // "wake". Keep that directionality if delivery is delayed or duplicated.
    if (event.type === "display-wake") {
      this.lastInputAtMs = Date.now();
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

      this.lastInputAtMs = Date.now();
      const wokeScreen = !this.screenOn && this.wake("sidebar");
      if (action === "voice-input" && !this.activeVoiceLayer) {
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

    this.lastInputAtMs = Date.now();

    // Anything but the long-press itself means the press ended (or the event
    // stream moved on), so the escape countdown stops.
    if (event.type !== "long-press") {
      this.cancelEscapeMenuTimer();
    }

    // A sleeping long-press is push-to-talk for the assistant. Route it before
    // the generic screen-off short circuit; the matching release below ends
    // capture. The master voice switch remains authoritative.
    if (!this.screenOn && event.type === "long-press" && voiceControlEnabledSetting.get()) {
      this.wake("sidebar");
      if (!this.activeVoiceLayer) {
        this.openVoiceDialog({ defaultTarget: "assistant" });
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
        layer.close();
        this.startEscapeMenuTimer();
        return { shell: true, window: false };
      }
      // While reordering, swallow long-presses so the window menu can't open
      // over the grab; a tap (handled in the sidebar reorder branch) ends it.
      if (this.reorderingWindowId !== null) {
        return { shell: true, window: false };
      }
      // A long-press on the sidebar arms quick-close mode (scroll to pick, tap
      // to close, double-tap to exit). The window menu stays reachable by first
      // clicking a card to focus its window, then long-pressing.
      if (
        this.focus === "sidebar" &&
        !this.closingActive &&
        this.stack.isAtBase() &&
        !this.activeVoiceLayer &&
        this.hasCloseableWindow()
      ) {
        this.closingActive = true;
        // Keep the escape-menu timer so a longer hold still opens it (which
        // supersedes close mode); a quick long-press-and-release stays in close.
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
    if ((event.type === "scroll-up" || event.type === "scroll-down") && this.reorderingWindowId === null) {
      const interval = ringScrollMinIntervalMs(ringSensitivitySetting.get());
      if (interval > 0) {
        const now = Date.now();
        if (now - this.lastScrollHonoredAtMs < interval) {
          return { shell: false, window: false };
        }
        this.lastScrollHonoredAtMs = now;
      }
    }

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
   * vertical-position-dependent 288px band otherwise), minus the sidebar's
   * left column when no icons have overflowed into it.
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

  /** Any window the user can close (i.e. not the pinned launcher). */
  private hasCloseableWindow(): boolean {
    return this.windows.some((w) => w.closeable !== false);
  }

  private handleSidebarInput(event: DashboardInputEvent): ShellInputOutcome {
    // Quick-close mode: scroll picks a card, tap closes it, double-tap exits.
    if (this.closingActive) {
      switch (event.type) {
        case "scroll-up":
          this.moveSelection(-1);
          return { shell: true, window: false };
        case "scroll-down":
          this.moveSelection(1);
          return { shell: true, window: false };
        case "click": {
          const window = this.windows[this.selectedIndex];
          if (window && window.closeable !== false) {
            this.closeWindow(window.windowId);
            // Stay armed while there is still something to close; else exit.
            if (!this.hasCloseableWindow()) this.closingActive = false;
          }
          this.config.requestShellRender();
          return { shell: true, window: false };
        }
        case "double-click":
          this.closingActive = false;
          this.config.requestShellRender();
          return { shell: true, window: false };
        default:
          return { shell: false, window: false };
      }
    }
    // While a tab is picked up, scroll moves it and a tap (or double-tap) drops
    // it; the screen-sleep double-tap is suspended so a drop can't sleep.
    if (this.reorderingWindowId !== null) {
      switch (event.type) {
        case "scroll-up":
          this.moveReorder(-1);
          return { shell: true, window: false };
        case "scroll-down":
          this.moveReorder(1);
          return { shell: true, window: false };
        case "click":
        case "double-click":
          this.endReorder();
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
    const count = this.windows.length;
    const dir = delta > 0 ? 1 : -1;
    const step = this.sidebarScroller.step(this.selectedIndex, count, dir, Date.now());
    if (step.atEdge) {
      // Stopped hard against an end: bounce, don't move or wrap yet.
      this.sidebarBounce.trigger(dir, () => this.config.requestShellRender());
      return;
    }
    this.setSelectedIndex(step.index);
  }

  /** A tab is reorderable unless it is pinned (the uncloseable launcher). */
  private isReorderable(window: ShellWindow): boolean {
    return window.closeable !== false;
  }

  /**
   * Whether a window's tab can be picked up right now: it must be movable (not
   * the pinned launcher) and there must be another movable tab to swap with.
   * The window menus use this to show the "Reorder" entry only when it works.
   */
  canReorder(windowId: string): boolean {
    const window = this.windows.find((w) => w.windowId === windowId);
    if (!window || !this.isReorderable(window)) return false;
    return this.windows.filter((w) => this.isReorderable(w)).length >= 2;
  }

  /**
   * Enter reorder mode for a window, chosen from its long-press menu. Focuses
   * the sidebar and picks up that tab, so scroll then moves it and a tap drops
   * it. No-op (returns false) if the window can no longer be reordered.
   */
  beginReorderFromMenu(windowId: string): boolean {
    const index = this.windows.findIndex((w) => w.windowId === windowId);
    if (index < 0 || !this.canReorder(windowId)) return false;
    this.selectedIndex = index;
    this.focus = "sidebar";
    this.reorderingWindowId = windowId;
    const window = this.windows[index]!;
    window.setForeground?.(true);
    window.requestRender();
    this.config.requestShellRender();
    return true;
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
  }): void {
    // Master voice switch: off suppresses all voice input (manual or wakeword).
    if (!voiceControlEnabledSetting.get()) return;
    const targets = this.buildVoiceSendTargets();
    let defaultIndex = targets.findIndex((target) => target.id === options.defaultTarget);
    if (defaultIndex < 0) defaultIndex = 0;
    // Skip the menu only for a hands-free (wakeword) capture aimed at the
    // assistant, when the user has opted into it.
    const autoSend =
      Boolean(options.handsFree) &&
      options.defaultTarget === "assistant" &&
      targets[defaultIndex]?.id === "assistant" &&
      assistantSkipConfirmationSetting.get();

    const layer = new VoiceInputLayer({
      actions: this.config.actions,
      onClosed: () => {
        if (this.activeVoiceLayer === layer) {
          this.activeVoiceLayer = null;
          // The idle countdown restarts in full once voice input ends.
          this.noteUserActivity();
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
    if (this.isAssistantAvailable()) {
      targets.push({
        id: "assistant",
        label: "Send to Assistant",
        onSend: (text) => this.sendToAssistant(text),
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
    if (!this.screenOn) this.wake("sidebar");
    let layer = this.assistantLayer;
    if (!layer) {
      const created = new AssistantLayer(this.config.actions, {
        onFollowUp: () => this.startAssistantFollowUp(),
        onCancel: () => this.assistantSession?.cancel(),
        onClose: () => this.closeAssistantLayer(),
        onRemoved: () => {
          // Removed by any path (Done, or the screen sleeping mid-conversation):
          // stop the turn and drop the reference so a later query starts clean.
          this.assistantSession?.cancel();
          if (this.assistantLayer === created) this.assistantLayer = null;
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
    layer.startTurn();
    session.sendUtterance(text, this.buildAssistantContext(), {
      onTextDelta: (delta, textSoFar) => layer.onTextDelta(delta, textSoFar),
      onToolActivity: (label) => {
        void playEventBeep("assistantTool", this.config.actions.playBuzzerSequence);
        layer.onToolActivity(label);
      },
      onTurnDone: () => {
        void playEventBeep("assistantReply", this.config.actions.playBuzzerSequence);
        layer.onTurnDone();
      },
      onError: (message) => {
        void playEventBeep("assistantError", this.config.actions.playBuzzerSequence);
        layer.onError(message);
      },
    });
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
    const voice = new VoiceInputLayer({
      actions: this.config.actions,
      onClosed: () => {
        if (this.activeVoiceLayer === voice) {
          this.activeVoiceLayer = null;
          this.noteUserActivity();
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
      autoSend: handsFree && assistantSkipConfirmationSetting.get(),
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
    if (layer) this.stack.popIfTop((top) => top === layer);
    this.noteUserActivity();
    this.config.requestShellRender();
  }

  /** Show a brief text popup on the lenses (assistant show_alert / notices). */
  async showAlert(text: string, signal?: AbortSignal, isSideEffectAllowed?: () => boolean): Promise<void> {
    if (!this.screenOn) throw new Error("The glasses display is off; no alert was sent.");
    if (signal?.aborted || (isSideEffectAllowed && !isSideEffectAllowed())) throw new Error("The alert operation was cancelled; no alert was sent.");
    if (this.config.isDisplayAvailable && !this.config.isDisplayAvailable()) {
      throw new Error("The glasses are disconnected; no alert was sent.");
    }
    const revision = ++this.alertRevision;
    if (this.alertLayer) this.stack.remove(this.alertLayer);
    let layer: ShellAlertLayer;
    const isOwner = () => this.alertRevision === revision && this.alertLayer === layer;
    layer = new ShellAlertLayer(text, () => {
      this.stack.remove(layer);
      if (this.alertLayer === layer) this.alertLayer = null;
      this.config.requestShellRender();
    });
    this.alertLayer = layer;
    this.stack.push(layer);
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
      if (!isOwner() || signal?.aborted || (isSideEffectAllowed && !isSideEffectAllowed())) {
        throw new Error("The alert operation was superseded or cancelled; no alert was sent.");
      }
    } catch (error) {
      this.stack.remove(layer);
      if (this.alertLayer === layer) this.alertLayer = null;
      try { await this.config.requestShellRender(); } catch { /* preserve transport error */ }
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
    const isOwner = () =>
      this.remoteViewLayer === layer &&
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
        if (prior) this.stack.push(prior);
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
  ): Promise<{ status: "acknowledged"; frameId: number }> {
    if (!this.screenOn) throw new Error("The glasses display is off; no dynamic app was sent.");
    if (this.config.isDisplayAvailable && !this.config.isDisplayAvailable()) {
      throw new Error("The glasses are disconnected; no dynamic app was sent.");
    }
    if (signal?.aborted || (isSideEffectAllowed && !isSideEffectAllowed())) {
      throw new Error("The dynamic app operation is stale.");
    }
    const prior = this.dynamicAppLayer;
    const layer = new ShellDynamicAppLayer(state, onInput, onClose);
    if (prior) this.stack.remove(prior);
    this.dynamicAppLayer = layer;
    this.stack.push(layer);
    const isOwner = () =>
      this.dynamicAppLayer === layer &&
      !signal?.aborted &&
      (!isSideEffectAllowed || isSideEffectAllowed());
    try {
      const receipt = this.config.requestShellDelivery
        ? await this.config.requestShellDelivery(isOwner)
        : (() => { this.config.requestShellRender(); return { frameId: 0, outcome: "unverified" }; })();
      if (!isOwner() || receipt.frameId <= 0 || receipt.outcome !== "sent") {
        throw new Error("The dynamic app did not receive a current transport acknowledgement.");
      }
      return { status: "acknowledged", frameId: receipt.frameId };
    } catch (error) {
      this.stack.remove(layer);
      if (this.dynamicAppLayer === layer) {
        this.dynamicAppLayer = prior;
        if (prior) this.stack.push(prior);
      }
      try { await this.config.requestShellRender(); } catch { /* preserve delivery error */ }
      throw error;
    }
  }

  clearDynamicApp(identity: { viewId: string; revision: number }): void {
    const layer = this.dynamicAppLayer;
    if (!layer || layer.state.viewId !== identity.viewId || layer.state.revision !== identity.revision) return;
    this.stack.remove(layer);
    this.dynamicAppLayer = null;
    this.config.requestShellRender();
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
    // A longer hold opening the escape menu supersedes quick-close mode.
    this.closingActive = false;
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
      ringConfigured: this.ringConfigured,
      ...this.reorderChromeState(),
      foregroundHeightMode: this.foregroundWindow()?.heightMode ?? "min",
      battery: this.battery,
      ringHeartRate: this.ringHeartRate,
      trayIcons: Array.from(this.trayIcons.keys())
        .sort()
        .map((key) => this.trayIcons.get(key)!),
      bridge: {
        // Only meaningful with the external backend and a configured host.
        show:
          assistantBackendSetting.get() === "external" &&
          assistantBridgeHostSetting.get().trim().length > 0,
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
