import { getDefaultMediumFont, getDefaultSmallFont } from "../../graphics/bdffont";
import { GrayImage } from "../../graphics/image";
import { truncateText, wrapText } from "../../graphics/textwrap";
import { type DashboardInputEvent, type Layer, type LayerContext } from "../../ui/layers";
import { type MenuItem, drawSelectionHighlight, openModalMenu } from "../../ui/menu";
import {
  createInProcessWindow,
  type InProcessAppOptions,
  type InProcessWindow,
} from "../../ui/shell/in-process-window";
import { shell } from "../../ui/shell/shell";
import {
  WORK_TASK_LANES,
  WorkTasksError,
  type WorkTask,
  type WorkTaskLane,
  type WorkTasksStore,
  workTasksStore,
} from "../../work-tasks/store";
import { WorkTasksViewModel } from "../../work-tasks/view-model";

export const WORK_TASKS_WINDOW_ID = "work-tasks";
export const WORK_TASKS_SURFACE_ID = "window:work-tasks";

const LANE_LABEL: Record<WorkTaskLane, string> = {
  inbox: "INBOX",
  today: "TODAY",
  doing: "DOING",
  done: "DONE",
};
const LANE_TILE_GAP = 8;
const SIDE_INSET = 16;
const HEADER_DIVIDER_Y = 37;
const LANE_TILE_TOP = 51;
const LANE_TILE_HEIGHT = 116;
const LIST_TOP = 45;
const TASK_ROW_HEIGHT = 48;
const FOOTER_HEIGHT = 23;

/** Full-title reading step between a lane card and its action menu. */
class WorkTaskDetailLayer implements Layer {
  private titleScrollLine = 0;

  constructor(
    private readonly store: WorkTasksStore,
    private readonly taskId: string,
    private readonly openActions: (ctx: LayerContext, task: WorkTask) => void,
  ) {}

  paint(ctx: LayerContext): GrayImage {
    const { width, height } = ctx.stack.getBaseSize();
    const visibleWidth = Math.min(width, 536);
    const image = new GrayImage(width, height, 0);
    const small = getDefaultSmallFont();
    const medium = getDefaultMediumFont();
    const task = this.store.snapshot().tasks.find((candidate) => candidate.id === this.taskId);
    image.drawText(medium, SIDE_INSET, 7, "TASK", 245);
    image.drawLine(SIDE_INSET, HEADER_DIVIDER_Y, visibleWidth - SIDE_INSET, HEADER_DIVIDER_Y, 70);
    if (!task) {
      image.drawText(small, SIDE_INSET, 57, "This task is no longer on the board.", 170);
      image.drawText(small, SIDE_INSET, height - 17, "Double-click: back", 110);
      return image;
    }
    const state = task.blocked ? `${LANE_LABEL[task.lane]}  ·  BLOCKED` : LANE_LABEL[task.lane];
    image.drawText(small, SIDE_INSET, 48, state, task.blocked ? 225 : 135);
    const lines = wrapText(small, task.title, visibleWidth - SIDE_INSET * 2, { breakLongWords: true });
    const titleLineHeight = small.lineHeight + 4;
    const visibleLineCount = Math.max(1, Math.floor((height - 128) / titleLineHeight));
    this.titleScrollLine = Math.min(this.titleScrollLine, Math.max(0, lines.length - visibleLineCount));
    let y = 70;
    for (const line of lines.slice(this.titleScrollLine, this.titleScrollLine + visibleLineCount)) {
      image.drawText(small, SIDE_INSET, y, line, 235);
      y += titleLineHeight;
    }
    if (lines.length > visibleLineCount) {
      const position = `${this.titleScrollLine + 1}-${Math.min(lines.length, this.titleScrollLine + visibleLineCount)}/${lines.length}`;
      image.drawText(small, visibleWidth - SIDE_INSET - small.measureText(position), height - 62, position, 125);
    }
    const actionY = height - 48;
    image.drawLine(SIDE_INSET, actionY - 7, visibleWidth - SIDE_INSET, actionY - 7, 45);
    image.drawText(small, SIDE_INSET, actionY, "Click: actions", 190);
    image.drawText(small, SIDE_INSET, height - 17, "Double-click: back to lane", 110);
    return image;
  }

  handleInput(event: DashboardInputEvent, ctx: LayerContext): void {
    if (event.type === "double-click") {
      ctx.stack.pop();
      return;
    }
    if (event.type === "scroll-up" || event.type === "scroll-down") {
      const task = this.store.snapshot().tasks.find((candidate) => candidate.id === this.taskId);
      if (!task) return;
      const small = getDefaultSmallFont();
      const { width, height } = ctx.stack.getBaseSize();
      const lines = wrapText(small, task.title, Math.min(width, 536) - SIDE_INSET * 2, { breakLongWords: true });
      const visibleLineCount = Math.max(1, Math.floor((height - 128) / (small.lineHeight + 4)));
      const direction = event.type === "scroll-down" ? 1 : -1;
      this.titleScrollLine = Math.max(0, Math.min(this.titleScrollLine + direction, Math.max(0, lines.length - visibleLineCount)));
      return;
    }
    if (event.type !== "click") return;
    const task = this.store.snapshot().tasks.find((candidate) => candidate.id === this.taskId);
    if (task) this.openActions(ctx, task);
  }
}

/** Glasses-native, visual-first work board. Creation is deliberately Hermes-only. */
export class WorkTasksLayer implements Layer {
  private readonly model = new WorkTasksViewModel();
  private unsubscribe: (() => void) | null = null;
  private status = "";

  constructor(
    private readonly store: WorkTasksStore,
    private readonly requestRender: () => void,
  ) {
    this.model.update(store.snapshot());
    this.unsubscribe = store.onChange((snapshot) => {
      this.model.update(snapshot);
      this.requestRender();
    });
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  onRemoved(): void {
    this.stop();
  }

  menuItems(): MenuItem[] {
    if (!this.model.snapshot().available) {
      return [{
        label: "Reset unreadable task data...",
        onSelect: (ctx) => {
          ctx.stack.pop();
          this.openResetConfirmation(ctx);
        },
      }];
    }
    const doneCount = this.model.snapshot().tasks.filter((task) => task.lane === "done").length;
    return [{
      label: doneCount ? `Clear completed (${doneCount})` : "Clear completed",
      disabled: doneCount === 0,
      onSelect: (ctx) => {
        ctx.stack.pop();
        this.openClearDoneConfirmation(ctx);
      },
    }];
  }

  paint(ctx: LayerContext): GrayImage {
    const { width, height } = ctx.stack.getBaseSize();
    const image = new GrayImage(width, height, 0);
    const visibleWidth = Math.min(width, 536);
    const small = getDefaultSmallFont();
    const medium = getDefaultMediumFont();
    image.drawText(medium, SIDE_INSET, 7, "WORK TASKS", 245);
    const snapshot = this.model.snapshot();
    const meta = snapshot.available ? `REV ${snapshot.revision}` : "STORE UNAVAILABLE";
    image.drawText(small, visibleWidth - SIDE_INSET - small.measureText(meta), 12, meta, snapshot.available ? 105 : 220);
    image.drawLine(SIDE_INSET, HEADER_DIVIDER_Y, visibleWidth - SIDE_INSET, HEADER_DIVIDER_Y, 70);

    if (!snapshot.available) {
      image.drawText(medium, SIDE_INSET, 62, "Encrypted task store unavailable", 230);
      image.drawText(small, SIDE_INSET, 91, "No changes will be made until it can be read.", 145);
      image.drawText(small, SIDE_INSET, height - 18, "Double-click: back", 105);
      return image;
    }

    if (this.model.view() === "lanes") this.paintLanes(image, visibleWidth, height, ctx.stack.isFocused());
    else this.paintTasks(image, visibleWidth, height, ctx.stack.isFocused());
    return image;
  }

  handleInput(event: DashboardInputEvent, ctx: LayerContext): void {
    if (event.type === "scroll-up" || event.type === "scroll-down") {
      this.status = "";
      this.model.scroll(event.type === "scroll-down" ? 1 : -1);
      return;
    }
    if (event.type === "click") {
      this.status = "";
      if (this.model.view() === "lanes") this.model.openSelectedLane();
      else {
        const task = this.model.selectedTask();
        if (task) ctx.stack.push(new WorkTaskDetailLayer(this.store, task.id, (detailCtx, current) => {
          this.openTaskActions(detailCtx, current);
        }));
      }
      return;
    }
    if (event.type === "double-click") {
      this.status = "";
      if (this.model.view() === "tasks") this.model.backToLanes();
      else shell.yieldFocusToSidebar();
    }
  }

  private paintLanes(image: GrayImage, visibleWidth: number, height: number, focused: boolean): void {
    const small = getDefaultSmallFont();
    const medium = getDefaultMediumFont();
    const summaries = this.model.summaries();
    const tileWidth = Math.floor((visibleWidth - 2 * SIDE_INSET - 3 * LANE_TILE_GAP) / 4);
    for (let index = 0; index < summaries.length; index++) {
      const summary = summaries[index]!;
      const x = SIDE_INSET + index * (tileWidth + LANE_TILE_GAP);
      const selected = index === this.model.selectedLaneIndex();
      if (selected) drawSelectionHighlight(image, x, LANE_TILE_TOP, tileWidth, LANE_TILE_HEIGHT, focused, 9);
      else image.drawRoundedRect(x, LANE_TILE_TOP, tileWidth, LANE_TILE_HEIGHT, 42, 9);
      image.drawText(small, x + 10, LANE_TILE_TOP + 10, LANE_LABEL[summary.lane], selected ? 245 : 150);
      const count = String(summary.count);
      image.drawText(medium, x + Math.round((tileWidth - medium.measureText(count)) / 2), LANE_TILE_TOP + 39, count, 245);
      if (summary.blocked) {
        const blocked = `${summary.blocked} BLOCKED`;
        image.drawText(small, x + Math.round((tileWidth - small.measureText(blocked)) / 2), LANE_TILE_TOP + 88, blocked, 205);
      } else {
        image.drawText(small, x + Math.round((tileWidth - small.measureText("CLEAR")) / 2), LANE_TILE_TOP + 88, "CLEAR", 85);
      }
    }
    const total = summaries.reduce((sum, lane) => sum + lane.count, 0);
    const footer = this.status || `${total} tasks   Scroll: lane   Click: open   Double-click: apps`;
    image.drawText(small, SIDE_INSET, height - 17, truncateText(small, footer, visibleWidth - SIDE_INSET * 2), 110);
  }

  private paintTasks(image: GrayImage, visibleWidth: number, height: number, focused: boolean): void {
    const small = getDefaultSmallFont();
    const lane = this.model.selectedLane();
    const tasks = this.model.tasks();
    const laneMeta = `${LANE_LABEL[lane]}  ${tasks.length}`;
    image.drawText(small, SIDE_INSET, HEADER_DIVIDER_Y + 5, laneMeta, 190);
    const position = tasks.length ? `${this.model.selectedTaskIndex() + 1}/${tasks.length}` : "0/0";
    image.drawText(small, visibleWidth - SIDE_INSET - small.measureText(position), HEADER_DIVIDER_Y + 5, position, 135);
    const visibleRows = Math.max(1, Math.floor((height - LIST_TOP - FOOTER_HEIGHT) / TASK_ROW_HEIGHT));
    const selectedIndex = this.model.selectedTaskIndex();
    const first = Math.max(0, Math.min(selectedIndex - visibleRows + 1, Math.max(0, tasks.length - visibleRows)));
    if (!tasks.length) {
      image.drawText(small, SIDE_INSET, LIST_TOP + 24, lane === "inbox" ? "No tasks. Ask Hermes to add one." : "No tasks in this lane.", 135);
    }
    for (let index = first; index < Math.min(tasks.length, first + visibleRows); index++) {
      const task = tasks[index]!;
      const y = LIST_TOP + (index - first) * TASK_ROW_HEIGHT;
      const selected = index === selectedIndex;
      if (selected) drawSelectionHighlight(image, SIDE_INSET, y + 2, visibleWidth - SIDE_INSET * 2, TASK_ROW_HEIGHT - 5, focused, 7);
      else image.drawLine(SIDE_INSET + 9, y + TASK_ROW_HEIGHT - 2, visibleWidth - SIDE_INSET, y + TASK_ROW_HEIGHT - 2, 32);
      const marker = task.blocked ? "!" : selected ? ">" : "·";
      image.drawText(small, SIDE_INSET + 8, y + 9, marker, task.blocked ? 255 : selected ? 225 : 90);
      const textX = SIDE_INSET + 28;
      const textWidth = visibleWidth - textX - SIDE_INSET - (task.blocked ? 68 : 8);
      const lines = wrapText(small, task.title, textWidth).slice(0, 2);
      lines.forEach((line, lineIndex) => image.drawText(small, textX, y + 7 + lineIndex * 15, truncateText(small, line, textWidth), selected ? 245 : 185));
      if (task.blocked) image.drawText(small, visibleWidth - SIDE_INSET - small.measureText("BLOCKED") - 7, y + 9, "BLOCKED", 210);
    }
    const footer = this.status || "Scroll: task   Click: actions   Double-click: lanes";
    image.drawText(small, SIDE_INSET, height - 17, truncateText(small, footer, visibleWidth - SIDE_INSET * 2), 110);
  }

  private openTaskActions(ctx: LayerContext, task: WorkTask): void {
    const nextLaneIndex = WORK_TASK_LANES.indexOf(task.lane) + 1;
    const nextLane = WORK_TASK_LANES[nextLaneIndex];
    openModalMenu(ctx, "TASK ACTIONS", [
      {
        label: nextLane ? `Advance to ${LANE_LABEL[nextLane]}` : "Already completed",
        disabled: !nextLane,
        onSelect: (menuCtx) => {
          menuCtx.stack.pop();
          this.runMutation(() => this.store.advanceTask(task.id), `Moved to ${nextLane ? LANE_LABEL[nextLane] : "DONE"}`);
        },
      },
      {
        label: "Move to...",
        onSelect: (menuCtx) => {
          menuCtx.stack.pop();
          this.openMoveMenu(menuCtx, task);
        },
      },
      {
        label: task.blocked ? "Clear blocked" : "Mark blocked",
        onSelect: (menuCtx) => {
          menuCtx.stack.pop();
          this.runMutation(() => this.store.setBlocked(task.id, !task.blocked), task.blocked ? "Block cleared" : "Marked BLOCKED");
        },
      },
      {
        label: "Delete...",
        onSelect: (menuCtx) => {
          menuCtx.stack.pop();
          this.openDeleteConfirmation(menuCtx, task);
        },
      },
    ]);
  }

  private openMoveMenu(ctx: LayerContext, task: WorkTask): void {
    openModalMenu(ctx, "MOVE TO", WORK_TASK_LANES.map((lane) => ({
      label: lane === task.lane ? `${LANE_LABEL[lane]}  ✓` : LANE_LABEL[lane],
      disabled: lane === task.lane,
      onSelect: (menuCtx) => {
        menuCtx.stack.pop();
        this.runMutation(() => this.store.moveTask(task.id, lane), `Moved to ${LANE_LABEL[lane]}`);
      },
    })), WORK_TASK_LANES.indexOf(task.lane));
  }

  private openDeleteConfirmation(ctx: LayerContext, task: WorkTask): void {
    openModalMenu(ctx, "DELETE TASK?", [
      { label: "Cancel", onSelect: (menuCtx) => menuCtx.stack.pop() },
      {
        label: "Delete",
        onSelect: (menuCtx) => {
          menuCtx.stack.pop();
          this.runMutation(() => this.store.deleteTask(task.id), "Task deleted");
        },
      },
    ]);
  }

  private openClearDoneConfirmation(ctx: LayerContext): void {
    openModalMenu(ctx, "CLEAR COMPLETED?", [
      { label: "Cancel", onSelect: (menuCtx) => menuCtx.stack.pop() },
      {
        label: "Clear completed",
        onSelect: (menuCtx) => {
          menuCtx.stack.pop();
          let removed = 0;
          this.runMutation(() => { removed = this.store.clearDone(); }, () => `${removed} completed cleared`);
        },
      },
    ]);
  }

  private openResetConfirmation(ctx: LayerContext): void {
    openModalMenu(ctx, "RESET TASK DATA?", [
      { label: "Cancel", onSelect: (menuCtx) => menuCtx.stack.pop() },
      {
        label: "Reset unreadable data",
        onSelect: (menuCtx) => {
          menuCtx.stack.pop();
          this.runMutation(() => this.store.discardUnreadableData(), "Task data reset");
        },
      },
    ]);
  }

  private runMutation(action: () => unknown, message: string | (() => string)): void {
    try {
      action();
      this.status = typeof message === "function" ? message() : message;
    } catch (error) {
      this.status = error instanceof WorkTasksError && error.code === "persistence_failed"
        ? "Save failed — nothing changed"
        : "Task change failed";
    }
    this.requestRender();
  }
}

export function createWorkTasksWindow(options: InProcessAppOptions): InProcessWindow {
  let requestRender = () => {};
  const layer = new WorkTasksLayer(workTasksStore, () => requestRender());
  const created = createInProcessWindow({
    appId: "work-tasks",
    windowId: WORK_TASKS_WINDOW_ID,
    title: "Tasks",
    iconLetter: "T",
    icon: "list-checks",
    closeable: true,
    actions: options.actions,
    baseLayer: layer,
    menuItems: () => layer.menuItems(),
    // Intentionally no receiveTextInput; task creation must travel through the authenticated
    // Hermes profile/tool, never an unscoped app text box.
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
