import { getDefaultMediumFont, getDefaultSmallFont, getFont } from "../../graphics/bdffont";
import { GrayImage } from "../../graphics/image";
import { truncateText } from "../../graphics/textwrap";
import {
  CLOCK_WEEKDAYS,
  MAX_TIMER_DURATION_SECONDS,
  ClockStoreError,
  type ClockAlarm,
  type ClockSnapshot,
  type ClockTimer,
  type ClockWeekday,
  type WorldClock,
  type ClockStore,
  clockStore,
} from "../../clock/store";
import { type DashboardInputEvent, type Layer, type LayerContext } from "../../ui/layers";
import { drawSelectionHighlight, openModalMenu, type MenuItem } from "../../ui/menu";
import {
  createInProcessWindow,
  type InProcessAppOptions,
  type InProcessWindow,
} from "../../ui/shell/in-process-window";
import { shell } from "../../ui/shell/shell";
import { clamp } from "../../util/numeric-util";
import { clockSchedulerBridge } from "../../native/clock-scheduler";

export const CLOCK_WINDOW_ID = "clock";
export const CLOCK_SURFACE_ID = "window:clock";
export const CLOCK_TABS = ["alarms", "timers", "world", "stopwatch"] as const;
export type ClockTab = (typeof CLOCK_TABS)[number];

const TAB_LABELS: Record<ClockTab, string> = {
  alarms: "ALARMS",
  timers: "TIMERS",
  world: "WORLD",
  stopwatch: "STOPWATCH",
};

const ALARM_REPEAT_PRESETS: ReadonlyArray<{ label: string; days: ClockWeekday[] }> = [
  { label: "Once", days: [] },
  { label: "Weekdays", days: ["mon", "tue", "wed", "thu", "fri"] },
  { label: "Weekends", days: ["sat", "sun"] },
  { label: "Daily", days: [...CLOCK_WEEKDAYS] },
];

export const WORLD_CLOCK_PRESETS: ReadonlyArray<{ label: string; timeZone: string }> = [
  { label: "London", timeZone: "Europe/London" },
  { label: "New York", timeZone: "America/New_York" },
  { label: "Los Angeles", timeZone: "America/Los_Angeles" },
  { label: "Paris", timeZone: "Europe/Paris" },
  { label: "Dubai", timeZone: "Asia/Dubai" },
  { label: "Mumbai", timeZone: "Asia/Kolkata" },
  { label: "Singapore", timeZone: "Asia/Singapore" },
  { label: "Tokyo", timeZone: "Asia/Tokyo" },
  { label: "Sydney", timeZone: "Australia/Sydney" },
  { label: "Auckland", timeZone: "Pacific/Auckland" },
];

const SIDE_INSET = 14;
const HEADER_DIVIDER_Y = 35;
const TAB_TOP = 42;
const TAB_HEIGHT = 30;
const CONTENT_TOP = 82;
const ROW_HEIGHT = 46;
const FOOTER_HEIGHT = 22;
const EDITOR_BOX_TOP = 66;
const EDITOR_BOX_HEIGHT = 72;
let guiOperationSerial = 0;

function guiOperationId(kind: "timer" | "alarm"): string {
  const uuid = (globalThis as any).crypto?.randomUUID?.();
  if (typeof uuid === "string" && uuid.length <= 48) return `gui.${kind}.${uuid}`;
  guiOperationSerial = (guiOperationSerial + 1) % 1_000_000;
  return `gui.${kind}.${Date.now().toString(36)}.${guiOperationSerial.toString(36)}`;
}

function wrapIndex(value: number, count: number): number {
  if (count <= 0) return 0;
  return (value % count + count) % count;
}

function timerRemainingSeconds(timer: ClockTimer, nowMs: number): number {
  if (timer.state === "running" && timer.nextFireAtMs !== null) {
    return Math.max(0, Math.ceil((timer.nextFireAtMs - nowMs) / 1000));
  }
  return timer.remainingSeconds;
}

function formatDurationSeconds(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const seconds = safe % 60;
  if (hours) return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function alarmRepeatLabel(alarm: ClockAlarm): string {
  if (!alarm.repeatDays.length) return alarm.date ?? "ONCE";
  if (alarm.repeatDays.length === 7) return "DAILY";
  if (alarm.repeatDays.join(",") === "mon,tue,wed,thu,fri") return "WEEKDAYS";
  if (alarm.repeatDays.join(",") === "sat,sun") return "WEEKENDS";
  return alarm.repeatDays.map((day) => day.slice(0, 1).toUpperCase()).join("");
}

function formatWorldTime(worldClock: WorldClock, nowMs: number): { time: string; date: string } {
  try {
    const time = new Intl.DateTimeFormat("en-GB", {
      timeZone: worldClock.timeZone,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(nowMs);
    const date = new Intl.DateTimeFormat("en-GB", {
      timeZone: worldClock.timeZone,
      weekday: "short",
      day: "2-digit",
      month: "short",
    }).format(nowMs);
    return { time, date };
  } catch {
    return { time: "--:--", date: "Time zone unavailable" };
  }
}

function errorMessage(error: unknown): string {
  if (!(error instanceof ClockStoreError)) return "Clock change failed";
  switch (error.code) {
    case "persistence_failed": return "Save failed — nothing changed";
    case "capacity": return "Clock is full";
    case "invalid_schedule": return "Choose a future time";
    case "invalid_duration": return "Choose 1 second to 7 days";
    case "invalid_time_zone": return "City is already added";
    case "unavailable": return "Encrypted Clock store unavailable";
    default: return "Clock change failed";
  }
}

class TimerEditorLayer implements Layer {
  private field = 0;
  private hours = 0;
  private minutes = 5;
  private seconds = 0;
  private message = "";

  constructor(
    private readonly store: ClockStore,
    private readonly syncSchedule: () => void,
    private readonly onSaved: (message: string) => void,
  ) {}

  paint(ctx: LayerContext): GrayImage {
    const { width, height } = ctx.stack.getBaseSize();
    const visibleWidth = Math.min(width, 536);
    const image = new GrayImage(width, height, 0);
    const small = getDefaultSmallFont();
    const medium = getDefaultMediumFont();
    const large = getFont("terminus32");
    image.drawText(medium, SIDE_INSET, 8, "NEW TIMER", 245);
    image.drawText(small, visibleWidth - SIDE_INSET - small.measureText("UP TO 7 DAYS"), 12, "UP TO 7 DAYS", 105);
    image.drawLine(SIDE_INSET, HEADER_DIVIDER_Y, visibleWidth - SIDE_INSET, HEADER_DIVIDER_Y, 65);
    const gap = 10;
    const boxWidth = Math.floor((visibleWidth - SIDE_INSET * 2 - gap * 2) / 3);
    const values = [String(this.hours).padStart(2, "0"), String(this.minutes).padStart(2, "0"), String(this.seconds).padStart(2, "0")];
    const labels = ["HOURS", "MIN", "SEC"];
    for (let index = 0; index < 3; index++) {
      const x = SIDE_INSET + index * (boxWidth + gap);
      if (this.field === index) drawSelectionHighlight(image, x, EDITOR_BOX_TOP, boxWidth, EDITOR_BOX_HEIGHT, ctx.stack.isFocused(), 8);
      else image.drawRoundedRect(x, EDITOR_BOX_TOP, boxWidth, EDITOR_BOX_HEIGHT, 42, 8);
      image.drawText(large, x + Math.floor((boxWidth - large.measureText(values[index]!)) / 2), EDITOR_BOX_TOP + 9, values[index]!, this.field === index ? 250 : 180);
      image.drawText(small, x + Math.floor((boxWidth - small.measureText(labels[index]!)) / 2), EDITOR_BOX_TOP + 51, labels[index]!, 105);
    }
    const saveY = Math.min(height - FOOTER_HEIGHT - 52, EDITOR_BOX_TOP + EDITOR_BOX_HEIGHT + 19);
    if (this.field === 3) drawSelectionHighlight(image, SIDE_INSET, saveY, visibleWidth - SIDE_INSET * 2, 37, ctx.stack.isFocused(), 8);
    else image.drawRoundedRect(SIDE_INSET, saveY, visibleWidth - SIDE_INSET * 2, 37, 42, 8);
    const save = "START TIMER";
    image.drawText(small, Math.floor((visibleWidth - small.measureText(save)) / 2), saveY + 11, save, this.field === 3 ? 245 : 155);
    if (this.message) image.drawText(small, SIDE_INSET, saveY + 43, truncateText(small, this.message, visibleWidth - SIDE_INSET * 2), 210);
    image.drawText(small, SIDE_INSET, height - 17, "Scroll: adjust   Click: next   Double-click: cancel", 105);
    return image;
  }

  handleInput(event: DashboardInputEvent, ctx: LayerContext): void {
    if (event.type === "double-click") {
      ctx.stack.pop();
      return;
    }
    if (event.type === "scroll-up" || event.type === "scroll-down") {
      const delta = event.type === "scroll-up" ? 1 : -1;
      if (this.field === 0) this.hours = clamp(this.hours + delta, 0, 168);
      else if (this.field === 1) this.minutes = wrapIndex(this.minutes + delta, 60);
      else if (this.field === 2) this.seconds = wrapIndex(this.seconds + delta, 60);
      else this.field = delta > 0 ? 0 : 2;
      this.message = "";
      return;
    }
    if (event.type !== "click") return;
    if (this.field < 3) {
      this.field++;
      return;
    }
    const durationSeconds = (this.hours * 60 + this.minutes) * 60 + this.seconds;
    if (durationSeconds < 1 || durationSeconds > MAX_TIMER_DURATION_SECONDS) {
      this.message = "Choose 1 second to 7 days";
      this.field = 0;
      return;
    }
    try {
      this.store.setTimer({ operationId: guiOperationId("timer"), durationSeconds });
      try {
        this.syncSchedule();
      } catch {
        ctx.stack.pop();
        this.onSaved("Timer saved · scheduling unconfirmed");
        return;
      }
      ctx.stack.pop();
      this.onSaved(`Timer started · ${formatDurationSeconds(durationSeconds)}`);
    } catch (error) {
      this.message = errorMessage(error);
    }
  }
}

class AlarmEditorLayer implements Layer {
  private field = 0;
  private hour: number;
  private minute: number;
  private repeatPreset = 0;
  private message = "";

  constructor(
    private readonly store: ClockStore,
    private readonly syncSchedule: () => void,
    private readonly onSaved: (message: string) => void,
    nowMs = Date.now(),
  ) {
    const initial = new Date(nowMs + 5 * 60_000);
    this.hour = initial.getHours();
    this.minute = initial.getMinutes();
  }

  paint(ctx: LayerContext): GrayImage {
    const { width, height } = ctx.stack.getBaseSize();
    const visibleWidth = Math.min(width, 536);
    const image = new GrayImage(width, height, 0);
    const small = getDefaultSmallFont();
    const medium = getDefaultMediumFont();
    const large = getFont("terminus32");
    image.drawText(medium, SIDE_INSET, 8, "NEW ALARM", 245);
    image.drawText(small, visibleWidth - SIDE_INSET - small.measureText("LOCAL TIME"), 12, "LOCAL TIME", 105);
    image.drawLine(SIDE_INSET, HEADER_DIVIDER_Y, visibleWidth - SIDE_INSET, HEADER_DIVIDER_Y, 65);
    const timeBoxWidth = 116;
    const gap = 10;
    const values = [String(this.hour).padStart(2, "0"), String(this.minute).padStart(2, "0")];
    const labels = ["HOUR", "MINUTE"];
    for (let index = 0; index < 2; index++) {
      const x = SIDE_INSET + index * (timeBoxWidth + gap);
      if (this.field === index) drawSelectionHighlight(image, x, EDITOR_BOX_TOP, timeBoxWidth, EDITOR_BOX_HEIGHT, ctx.stack.isFocused(), 8);
      else image.drawRoundedRect(x, EDITOR_BOX_TOP, timeBoxWidth, EDITOR_BOX_HEIGHT, 42, 8);
      image.drawText(large, x + Math.floor((timeBoxWidth - large.measureText(values[index]!)) / 2), EDITOR_BOX_TOP + 9, values[index]!, this.field === index ? 250 : 180);
      image.drawText(small, x + Math.floor((timeBoxWidth - small.measureText(labels[index]!)) / 2), EDITOR_BOX_TOP + 51, labels[index]!, 105);
    }
    const repeatX = SIDE_INSET + (timeBoxWidth + gap) * 2;
    const repeatWidth = visibleWidth - SIDE_INSET - repeatX;
    if (this.field === 2) drawSelectionHighlight(image, repeatX, EDITOR_BOX_TOP, repeatWidth, EDITOR_BOX_HEIGHT, ctx.stack.isFocused(), 8);
    else image.drawRoundedRect(repeatX, EDITOR_BOX_TOP, repeatWidth, EDITOR_BOX_HEIGHT, 42, 8);
    const repeat = ALARM_REPEAT_PRESETS[this.repeatPreset]!.label.toUpperCase();
    image.drawText(small, repeatX + Math.floor((repeatWidth - small.measureText(repeat)) / 2), EDITOR_BOX_TOP + 24, repeat, this.field === 2 ? 245 : 175);
    image.drawText(small, repeatX + Math.floor((repeatWidth - small.measureText("REPEAT")) / 2), EDITOR_BOX_TOP + 51, "REPEAT", 105);
    const saveY = Math.min(height - FOOTER_HEIGHT - 52, EDITOR_BOX_TOP + EDITOR_BOX_HEIGHT + 19);
    if (this.field === 3) drawSelectionHighlight(image, SIDE_INSET, saveY, visibleWidth - SIDE_INSET * 2, 37, ctx.stack.isFocused(), 8);
    else image.drawRoundedRect(SIDE_INSET, saveY, visibleWidth - SIDE_INSET * 2, 37, 42, 8);
    const save = "SAVE ALARM";
    image.drawText(small, Math.floor((visibleWidth - small.measureText(save)) / 2), saveY + 11, save, this.field === 3 ? 245 : 155);
    if (this.message) image.drawText(small, SIDE_INSET, saveY + 43, truncateText(small, this.message, visibleWidth - SIDE_INSET * 2), 210);
    image.drawText(small, SIDE_INSET, height - 17, "Scroll: adjust   Click: next   Double-click: cancel", 105);
    return image;
  }

  handleInput(event: DashboardInputEvent, ctx: LayerContext): void {
    if (event.type === "double-click") {
      ctx.stack.pop();
      return;
    }
    if (event.type === "scroll-up" || event.type === "scroll-down") {
      const delta = event.type === "scroll-up" ? 1 : -1;
      if (this.field === 0) this.hour = wrapIndex(this.hour + delta, 24);
      else if (this.field === 1) this.minute = wrapIndex(this.minute + delta, 60);
      else if (this.field === 2) this.repeatPreset = wrapIndex(this.repeatPreset + delta, ALARM_REPEAT_PRESETS.length);
      else this.field = delta > 0 ? 0 : 2;
      this.message = "";
      return;
    }
    if (event.type !== "click") return;
    if (this.field < 3) {
      this.field++;
      return;
    }
    const localTime = `${String(this.hour).padStart(2, "0")}:${String(this.minute).padStart(2, "0")}`;
    const preset = ALARM_REPEAT_PRESETS[this.repeatPreset]!;
    try {
      this.store.setAlarm({
        operationId: guiOperationId("alarm"),
        localTime,
        repeatDays: [...preset.days],
      });
      try {
        this.syncSchedule();
      } catch {
        ctx.stack.pop();
        this.onSaved("Alarm saved · scheduling unconfirmed");
        return;
      }
      ctx.stack.pop();
      this.onSaved(`Alarm saved · ${localTime} ${preset.label}`);
    } catch (error) {
      this.message = errorMessage(error);
    }
  }
}

class WorldClockPickerLayer implements Layer {
  private selected = 0;
  private status = "";

  constructor(
    private readonly store: ClockStore,
    private readonly onSaved: (message: string) => void,
  ) {}

  paint(ctx: LayerContext): GrayImage {
    const { width, height } = ctx.stack.getBaseSize();
    const visibleWidth = Math.min(width, 536);
    const image = new GrayImage(width, height, 0);
    const small = getDefaultSmallFont();
    const medium = getDefaultMediumFont();
    image.drawText(medium, SIDE_INSET, 8, "ADD WORLD CLOCK", 245);
    image.drawText(small, visibleWidth - SIDE_INSET - small.measureText(`${this.selected + 1}/${WORLD_CLOCK_PRESETS.length}`), 12, `${this.selected + 1}/${WORLD_CLOCK_PRESETS.length}`, 105);
    image.drawLine(SIDE_INSET, HEADER_DIVIDER_Y, visibleWidth - SIDE_INSET, HEADER_DIVIDER_Y, 65);
    const visibleRows = Math.max(1, Math.floor((height - CONTENT_TOP + 30 - FOOTER_HEIGHT) / 36));
    const first = Math.max(0, Math.min(this.selected - visibleRows + 1, WORLD_CLOCK_PRESETS.length - visibleRows));
    for (let index = first; index < Math.min(WORLD_CLOCK_PRESETS.length, first + visibleRows); index++) {
      const preset = WORLD_CLOCK_PRESETS[index]!;
      const y = 47 + (index - first) * 36;
      if (index === this.selected) drawSelectionHighlight(image, SIDE_INSET, y, visibleWidth - SIDE_INSET * 2, 31, ctx.stack.isFocused(), 7);
      else image.drawLine(SIDE_INSET + 8, y + 32, visibleWidth - SIDE_INSET, y + 32, 30);
      image.drawText(small, SIDE_INSET + 10, y + 8, preset.label, index === this.selected ? 245 : 175);
      image.drawText(small, visibleWidth - SIDE_INSET - small.measureText(preset.timeZone) - 8, y + 8, preset.timeZone, 100);
    }
    const footer = this.status || "Scroll: city   Click: add   Double-click: cancel";
    image.drawText(small, SIDE_INSET, height - 17, truncateText(small, footer, visibleWidth - SIDE_INSET * 2), this.status ? 210 : 105);
    return image;
  }

  handleInput(event: DashboardInputEvent, ctx: LayerContext): void {
    if (event.type === "double-click") {
      ctx.stack.pop();
      return;
    }
    if (event.type === "scroll-up" || event.type === "scroll-down") {
      this.selected = wrapIndex(this.selected + (event.type === "scroll-down" ? 1 : -1), WORLD_CLOCK_PRESETS.length);
      this.status = "";
      return;
    }
    if (event.type !== "click") return;
    const preset = WORLD_CLOCK_PRESETS[this.selected]!;
    try {
      this.store.addWorldClock(preset);
      ctx.stack.pop();
      this.onSaved(`${preset.label} added`);
    } catch (error) {
      this.status = errorMessage(error);
    }
  }
}

/** Visual-first Clock home: tabs first, then ring-navigable controls and cards. */
export class ClockLayer implements Layer {
  private snapshot: ClockSnapshot;
  private tabIndex = 0;
  private region: "tabs" | "content" = "tabs";
  private readonly selectedRows: Record<ClockTab, number> = {
    alarms: 0,
    timers: 0,
    world: 0,
    stopwatch: 0,
  };
  private status = "";
  private unsubscribe: (() => void) | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private tickIntervalMs = 0;
  private foreground = false;
  private screenOn = true;
  private stopwatchAccumulatedMs = 0;
  private stopwatchRunningSinceMs: number | null = null;

  constructor(
    private readonly store: ClockStore,
    private readonly requestRender: () => void,
  ) {
    this.snapshot = store.snapshot();
    this.unsubscribe = store.onChange((snapshot) => {
      this.snapshot = snapshot;
      this.clampSelections();
      this.requestRender();
    });
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.stopTicking();
  }

  onRemoved(): void { this.stop(); }

  onForegroundChanged(foreground: boolean): void {
    this.foreground = foreground;
    this.updateTicking();
  }

  onScreenChanged(screenOn: boolean): void {
    this.screenOn = screenOn;
    this.updateTicking();
  }

  menuItems(): MenuItem[] {
    if (this.snapshot.available) return [];
    return [{
      label: "Reset unreadable Clock data...",
      onSelect: (ctx) => {
        ctx.stack.pop();
        openModalMenu(ctx, "RESET CLOCK DATA?", [
          { label: "Cancel", onSelect: (menuCtx) => menuCtx.stack.pop() },
          {
            label: "Reset unreadable data",
            onSelect: (menuCtx) => {
              menuCtx.stack.pop();
              this.runMutation(() => this.store.discardUnreadableData(), "Clock data reset");
            },
          },
        ]);
      },
    }];
  }

  paint(ctx: LayerContext): GrayImage {
    const { width, height } = ctx.stack.getBaseSize();
    const visibleWidth = Math.min(width, 536);
    const image = new GrayImage(width, height, 0);
    const small = getDefaultSmallFont();
    const medium = getDefaultMediumFont();
    image.drawText(medium, SIDE_INSET, 7, "CLOCK", 245);
    const exactAlarms = clockSchedulerBridge.canScheduleExactAlarms();
    const meta = !this.snapshot.available
      ? "STORE UNAVAILABLE"
      : exactAlarms
        ? `REV ${this.snapshot.revision}`
        : "EXACT ALARMS OFF";
    image.drawText(
      small,
      visibleWidth - SIDE_INSET - small.measureText(meta),
      12,
      meta,
      this.snapshot.available && exactAlarms ? 100 : 220,
    );
    image.drawLine(SIDE_INSET, HEADER_DIVIDER_Y, visibleWidth - SIDE_INSET, HEADER_DIVIDER_Y, 65);
    this.paintTabs(image, visibleWidth, ctx.stack.isFocused());
    if (!this.snapshot.available) {
      image.drawText(medium, SIDE_INSET, 96, "Encrypted Clock store unavailable", 225);
      image.drawText(small, SIDE_INSET, 126, "No schedule changes will be made.", 135);
      image.drawText(small, SIDE_INSET, height - 17, "Long-press: recovery   Double-click: apps", 105);
      return image;
    }
    const tab = CLOCK_TABS[this.tabIndex]!;
    if (tab === "alarms") this.paintAlarms(image, visibleWidth, height, ctx.stack.isFocused());
    else if (tab === "timers") this.paintTimers(image, visibleWidth, height, ctx.stack.isFocused());
    else if (tab === "world") this.paintWorld(image, visibleWidth, height, ctx.stack.isFocused());
    else this.paintStopwatch(image, visibleWidth, height, ctx.stack.isFocused());
    return image;
  }

  handleInput(event: DashboardInputEvent, ctx: LayerContext): void {
    if (event.type === "scroll-up" || event.type === "scroll-down") {
      const direction = event.type === "scroll-down" ? 1 : -1;
      this.status = "";
      if (this.region === "tabs") {
        this.tabIndex = wrapIndex(this.tabIndex + direction, CLOCK_TABS.length);
      } else {
        const tab = CLOCK_TABS[this.tabIndex]!;
        this.selectedRows[tab] = wrapIndex(this.selectedRows[tab] + direction, this.contentCount(tab));
      }
      return;
    }
    if (event.type === "double-click") {
      this.status = "";
      if (this.region === "content") this.region = "tabs";
      else shell.yieldFocusToSidebar();
      return;
    }
    if (event.type !== "click") return;
    this.status = "";
    if (this.region === "tabs") {
      this.region = "content";
      return;
    }
    this.activateContent(ctx);
  }

  private paintTabs(image: GrayImage, visibleWidth: number, focused: boolean): void {
    const small = getDefaultSmallFont();
    const gap = 5;
    const width = Math.floor((visibleWidth - SIDE_INSET * 2 - gap * 3) / 4);
    for (let index = 0; index < CLOCK_TABS.length; index++) {
      const tab = CLOCK_TABS[index]!;
      const x = SIDE_INSET + index * (width + gap);
      const selected = index === this.tabIndex;
      if (selected && this.region === "tabs") drawSelectionHighlight(image, x, TAB_TOP, width, TAB_HEIGHT, focused, 7);
      else image.drawRoundedRect(x, TAB_TOP, width, TAB_HEIGHT, selected ? 85 : 32, 7);
      const label = TAB_LABELS[tab];
      image.drawText(small, x + Math.floor((width - small.measureText(label)) / 2), TAB_TOP + 9, label, selected ? 235 : 115);
    }
  }

  private paintAlarms(image: GrayImage, visibleWidth: number, height: number, focused: boolean): void {
    const small = getDefaultSmallFont();
    const alarms = this.snapshot.alarms;
    const selected = this.selectedRows.alarms;
    this.paintAddRow(image, visibleWidth, selected === 0, focused, "+  NEW ALARM");
    const visibleRows = this.visibleDataRows(height);
    const itemIndex = Math.max(0, selected - 1);
    const first = Math.max(0, Math.min(itemIndex - visibleRows + 1, Math.max(0, alarms.length - visibleRows)));
    for (let index = first; index < Math.min(alarms.length, first + visibleRows); index++) {
      const alarm = alarms[index]!;
      const rowY = CONTENT_TOP + ROW_HEIGHT + (index - first) * ROW_HEIGHT;
      const rowSelected = selected === index + 1;
      this.paintDataRowFrame(image, visibleWidth, rowY, rowSelected, focused);
      const occurrence = this.snapshot.occurrences.find((candidate) => candidate.itemId === alarm.id);
      const state = occurrence ? (occurrence.status === "silent" ? "MISSED" : "RINGING") : alarm.enabled ? "ON" : "OFF";
      image.drawText(getDefaultMediumFont(), SIDE_INSET + 10, rowY + 6, alarm.localTime, alarm.enabled ? 235 : 105);
      const textX = SIDE_INSET + 104;
      image.drawText(small, textX, rowY + 6, truncateText(small, alarm.label, visibleWidth - textX - 96), rowSelected ? 235 : 175);
      image.drawText(small, textX, rowY + 24, alarmRepeatLabel(alarm), 105);
      image.drawText(small, visibleWidth - SIDE_INSET - small.measureText(state) - 8, rowY + 15, state, occurrence ? 235 : alarm.enabled ? 150 : 75);
    }
    this.paintFooter(image, visibleWidth, height, `${alarms.length} alarms`);
  }

  private paintTimers(image: GrayImage, visibleWidth: number, height: number, focused: boolean): void {
    const small = getDefaultSmallFont();
    const timers = this.snapshot.timers;
    const selected = this.selectedRows.timers;
    const now = Date.now();
    this.paintAddRow(image, visibleWidth, selected === 0, focused, "+  NEW TIMER");
    const visibleRows = this.visibleDataRows(height);
    const itemIndex = Math.max(0, selected - 1);
    const first = Math.max(0, Math.min(itemIndex - visibleRows + 1, Math.max(0, timers.length - visibleRows)));
    for (let index = first; index < Math.min(timers.length, first + visibleRows); index++) {
      const timer = timers[index]!;
      const rowY = CONTENT_TOP + ROW_HEIGHT + (index - first) * ROW_HEIGHT;
      const rowSelected = selected === index + 1;
      this.paintDataRowFrame(image, visibleWidth, rowY, rowSelected, focused);
      const occurrence = this.snapshot.occurrences.find((candidate) => candidate.itemId === timer.id);
      const state = occurrence
        ? occurrence.status === "silent" ? "MISSED" : "RINGING"
        : timer.state === "running" ? "RUNNING" : timer.state === "paused" ? "PAUSED" : "DONE";
      image.drawText(getDefaultMediumFont(), SIDE_INSET + 10, rowY + 6, formatDurationSeconds(timerRemainingSeconds(timer, now)), timer.state === "finished" ? 115 : 235);
      const textX = SIDE_INSET + 126;
      image.drawText(small, textX, rowY + 6, truncateText(small, timer.label, visibleWidth - textX - 103), rowSelected ? 235 : 175);
      image.drawText(small, textX, rowY + 24, `SET ${formatDurationSeconds(timer.durationSeconds)}`, 95);
      image.drawText(small, visibleWidth - SIDE_INSET - small.measureText(state) - 8, rowY + 15, state, occurrence ? 235 : 120);
    }
    this.paintFooter(image, visibleWidth, height, `${timers.length} timers`);
  }

  private paintWorld(image: GrayImage, visibleWidth: number, height: number, focused: boolean): void {
    const small = getDefaultSmallFont();
    const worldClocks = this.snapshot.worldClocks;
    const selected = this.selectedRows.world;
    const now = Date.now();
    this.paintAddRow(image, visibleWidth, selected === 0, focused, "+  ADD CITY");
    const visibleRows = this.visibleDataRows(height);
    const itemIndex = Math.max(0, selected - 1);
    const first = Math.max(0, Math.min(itemIndex - visibleRows + 1, Math.max(0, worldClocks.length - visibleRows)));
    for (let index = first; index < Math.min(worldClocks.length, first + visibleRows); index++) {
      const worldClock = worldClocks[index]!;
      const rowY = CONTENT_TOP + ROW_HEIGHT + (index - first) * ROW_HEIGHT;
      const rowSelected = selected === index + 1;
      this.paintDataRowFrame(image, visibleWidth, rowY, rowSelected, focused);
      const formatted = formatWorldTime(worldClock, now);
      image.drawText(getDefaultMediumFont(), SIDE_INSET + 10, rowY + 6, formatted.time, 235);
      const textX = SIDE_INSET + 105;
      image.drawText(small, textX, rowY + 6, truncateText(small, worldClock.label, visibleWidth - textX - SIDE_INSET), rowSelected ? 235 : 175);
      image.drawText(small, textX, rowY + 24, formatted.date, 105);
    }
    this.paintFooter(image, visibleWidth, height, `${worldClocks.length} cities`);
  }

  private paintStopwatch(image: GrayImage, visibleWidth: number, height: number, focused: boolean): void {
    const small = getDefaultSmallFont();
    const large = getFont("terminus32");
    const elapsed = this.stopwatchAccumulatedMs + (this.stopwatchRunningSinceMs === null ? 0 : Date.now() - this.stopwatchRunningSinceMs);
    const totalTenths = Math.floor(elapsed / 100);
    const hours = Math.floor(totalTenths / 36_000);
    const minutes = Math.floor((totalTenths % 36_000) / 600);
    const seconds = Math.floor((totalTenths % 600) / 10);
    const tenths = totalTenths % 10;
    const display = hours
      ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${tenths}`
      : `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${tenths}`;
    image.drawText(large, Math.floor((visibleWidth - large.measureText(display)) / 2), 91, display, 245);
    image.drawText(small, Math.floor((visibleWidth - small.measureText(this.stopwatchRunningSinceMs === null ? "STOPPED" : "RUNNING")) / 2), 130, this.stopwatchRunningSinceMs === null ? "STOPPED" : "RUNNING", 105);
    const actions = [this.stopwatchRunningSinceMs === null ? "START" : "PAUSE", "RESET"];
    const selected = this.selectedRows.stopwatch;
    const buttonWidth = Math.floor((visibleWidth - SIDE_INSET * 2 - 10) / 2);
    for (let index = 0; index < actions.length; index++) {
      const x = SIDE_INSET + index * (buttonWidth + 10);
      const y = 154;
      if (selected === index) drawSelectionHighlight(image, x, y, buttonWidth, 42, focused && this.region === "content", 8);
      else image.drawRoundedRect(x, y, buttonWidth, 42, 42, 8);
      image.drawText(small, x + Math.floor((buttonWidth - small.measureText(actions[index]!)) / 2), y + 13, actions[index]!, selected === index ? 240 : 145);
    }
    this.paintFooter(image, visibleWidth, height, "Stopwatch stays active across tabs");
  }

  private paintAddRow(image: GrayImage, visibleWidth: number, selected: boolean, focused: boolean, label: string): void {
    const small = getDefaultSmallFont();
    if (selected && this.region === "content") drawSelectionHighlight(image, SIDE_INSET, CONTENT_TOP, visibleWidth - SIDE_INSET * 2, ROW_HEIGHT - 5, focused, 8);
    else image.drawRoundedRect(SIDE_INSET, CONTENT_TOP, visibleWidth - SIDE_INSET * 2, ROW_HEIGHT - 5, selected ? 80 : 35, 8);
    image.drawText(small, SIDE_INSET + 12, CONTENT_TOP + 13, label, selected ? 240 : 150);
  }

  private paintDataRowFrame(image: GrayImage, visibleWidth: number, rowY: number, selected: boolean, focused: boolean): void {
    if (selected && this.region === "content") drawSelectionHighlight(image, SIDE_INSET, rowY, visibleWidth - SIDE_INSET * 2, ROW_HEIGHT - 4, focused, 8);
    else image.drawLine(SIDE_INSET + 8, rowY + ROW_HEIGHT - 3, visibleWidth - SIDE_INSET, rowY + ROW_HEIGHT - 3, 30);
  }

  private paintFooter(image: GrayImage, visibleWidth: number, height: number, countText: string): void {
    const small = getDefaultSmallFont();
    const help = this.region === "tabs"
      ? `${countText}   Scroll: tab   Click: enter   Double-click: apps`
      : `${countText}   Scroll: item   Click: open   Double-click: tabs`;
    image.drawText(small, SIDE_INSET, height - 17, truncateText(small, this.status || help, visibleWidth - SIDE_INSET * 2), this.status ? 205 : 105);
  }

  private visibleDataRows(height: number): number {
    return Math.max(0, Math.floor((height - CONTENT_TOP - ROW_HEIGHT - FOOTER_HEIGHT) / ROW_HEIGHT));
  }

  private contentCount(tab: ClockTab): number {
    if (tab === "alarms") return this.snapshot.alarms.length + 1;
    if (tab === "timers") return this.snapshot.timers.length + 1;
    if (tab === "world") return this.snapshot.worldClocks.length + 1;
    return 2;
  }

  private clampSelections(): void {
    for (const tab of CLOCK_TABS) {
      this.selectedRows[tab] = clamp(this.selectedRows[tab], 0, Math.max(0, this.contentCount(tab) - 1));
    }
  }

  private activateContent(ctx: LayerContext): void {
    const tab = CLOCK_TABS[this.tabIndex]!;
    const selected = this.selectedRows[tab];
    if (tab === "alarms") {
      if (selected === 0) ctx.stack.push(new AlarmEditorLayer(
        this.store,
        () => this.syncNativeSchedule(),
        (message) => this.setStatus(message),
      ));
      else {
        const alarm = this.snapshot.alarms[selected - 1];
        if (alarm) this.openAlarmActions(ctx, alarm);
      }
    } else if (tab === "timers") {
      if (selected === 0) ctx.stack.push(new TimerEditorLayer(
        this.store,
        () => this.syncNativeSchedule(),
        (message) => this.setStatus(message),
      ));
      else {
        const timer = this.snapshot.timers[selected - 1];
        if (timer) this.openTimerActions(ctx, timer);
      }
    } else if (tab === "world") {
      if (selected === 0) ctx.stack.push(new WorldClockPickerLayer(this.store, (message) => this.setStatus(message)));
      else {
        const worldClock = this.snapshot.worldClocks[selected - 1];
        if (worldClock) this.openWorldActions(ctx, worldClock);
      }
    } else if (selected === 0) {
      if (this.stopwatchRunningSinceMs === null) this.stopwatchRunningSinceMs = Date.now();
      else {
        this.stopwatchAccumulatedMs += Date.now() - this.stopwatchRunningSinceMs;
        this.stopwatchRunningSinceMs = null;
      }
      this.updateTicking();
    } else {
      this.stopwatchAccumulatedMs = 0;
      this.stopwatchRunningSinceMs = null;
      this.updateTicking();
    }
  }

  private openTimerActions(ctx: LayerContext, timer: ClockTimer): void {
    const items: MenuItem[] = [];
    if (timer.state === "running") {
      items.push({ label: "Pause", onSelect: (menuCtx) => { menuCtx.stack.pop(); this.runScheduledMutation(() => this.store.pauseTimer(timer.id), "Timer paused"); } });
    } else if (timer.state === "paused") {
      items.push({ label: "Resume", onSelect: (menuCtx) => { menuCtx.stack.pop(); this.runScheduledMutation(() => this.store.resumeTimer(timer.id), "Timer resumed"); } });
    }
    items.push({ label: "Restart", onSelect: (menuCtx) => { menuCtx.stack.pop(); this.runScheduledMutation(() => this.store.restartTimer(timer.id), "Timer restarted"); } });
    items.push({
      label: timer.state === "finished" ? "Dismiss..." : "Cancel...",
      onSelect: (menuCtx) => {
        menuCtx.stack.pop();
        openModalMenu(menuCtx, timer.state === "finished" ? "DISMISS TIMER?" : "CANCEL TIMER?", [
          { label: "Keep", onSelect: (confirmCtx) => confirmCtx.stack.pop() },
          { label: timer.state === "finished" ? "Dismiss" : "Cancel timer", onSelect: (confirmCtx) => {
            confirmCtx.stack.pop();
            this.runScheduledMutation(() => this.store.deleteTimer(timer.id), timer.state === "finished" ? "Timer dismissed" : "Timer canceled");
          } },
        ]);
      },
    });
    openModalMenu(ctx, "TIMER", items);
  }

  private openAlarmActions(ctx: LayerContext, alarm: ClockAlarm): void {
    openModalMenu(ctx, "ALARM", [
      {
        label: alarm.enabled ? "Disable" : "Enable",
        onSelect: (menuCtx) => {
          menuCtx.stack.pop();
          this.runScheduledMutation(() => this.store.setAlarmEnabled(alarm.id, !alarm.enabled), alarm.enabled ? "Alarm disabled" : "Alarm enabled");
        },
      },
      {
        label: "Delete...",
        onSelect: (menuCtx) => {
          menuCtx.stack.pop();
          openModalMenu(menuCtx, "DELETE ALARM?", [
            { label: "Keep", onSelect: (confirmCtx) => confirmCtx.stack.pop() },
            { label: "Delete", onSelect: (confirmCtx) => {
              confirmCtx.stack.pop();
              this.runScheduledMutation(() => this.store.deleteAlarm(alarm.id), "Alarm deleted");
            } },
          ]);
        },
      },
    ]);
  }

  private openWorldActions(ctx: LayerContext, worldClock: WorldClock): void {
    openModalMenu(ctx, "REMOVE WORLD CLOCK?", [
      { label: "Keep", onSelect: (menuCtx) => menuCtx.stack.pop() },
      { label: `Remove ${worldClock.label}`, onSelect: (menuCtx) => {
        menuCtx.stack.pop();
        this.runMutation(() => this.store.removeWorldClock(worldClock.id), `${worldClock.label} removed`);
      } },
    ]);
  }

  private runMutation(action: () => unknown, success: string): void {
    try {
      action();
      this.setStatus(success);
    } catch (error) {
      this.setStatus(errorMessage(error));
    }
  }

  /**
   * A ring-created schedule is not presented as successful until Android has
   * synchronously accepted the complete AlarmManager mirror. The encrypted
   * Clock store commits first, so a later native failure is an honest
   * outcome-unknown state rather than a false rollback claim.
   */
  private runScheduledMutation(action: () => unknown, success: string): void {
    let committed = false;
    try {
      action();
      committed = true;
      this.syncNativeSchedule();
      this.setStatus(success);
    } catch (error) {
      this.setStatus(committed ? `${success} · scheduling unconfirmed` : errorMessage(error));
    }
  }

  private syncNativeSchedule(): void {
    clockSchedulerBridge.sync(this.store.scheduledItems());
  }

  private setStatus(message: string): void {
    this.status = message;
    this.requestRender();
  }

  private updateTicking(): void {
    const shouldTick = this.foreground && this.screenOn;
    const intervalMs = this.stopwatchRunningSinceMs === null ? 1_000 : 100;
    if (!shouldTick) {
      this.stopTicking();
      return;
    }
    if (this.tickTimer !== null && this.tickIntervalMs === intervalMs) return;
    this.stopTicking();
    this.tickIntervalMs = intervalMs;
    this.tickTimer = setInterval(() => this.requestRender(), intervalMs);
  }

  private stopTicking(): void {
    if (this.tickTimer !== null) clearInterval(this.tickTimer);
    this.tickTimer = null;
    this.tickIntervalMs = 0;
  }
}

export function createClockWindow(options: InProcessAppOptions): InProcessWindow {
  let requestRender = () => {};
  const layer = new ClockLayer(clockStore, () => requestRender());
  const created = createInProcessWindow({
    appId: "clock",
    windowId: CLOCK_WINDOW_ID,
    title: "Clock",
    iconLetter: "C",
    icon: "clock",
    closeable: true,
    actions: options.actions,
    baseLayer: layer,
    menuItems: () => layer.menuItems(),
    submitFrame: options.submitFrame,
    setSurfaceVisible: options.setSurfaceVisible,
    removeSurface: options.removeSurface,
    onClosed: () => {
      layer.stop();
      options.onClosed();
    },
  });
  requestRender = created.requestRender;
  return created;
}
