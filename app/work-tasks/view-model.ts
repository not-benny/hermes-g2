import {
  WORK_TASK_LANES,
  type WorkTask,
  type WorkTaskLane,
  type WorkTasksSnapshot,
} from "./store";

export type WorkTasksView = "lanes" | "tasks";

export type WorkTaskLaneSummary = {
  lane: WorkTaskLane;
  count: number;
  blocked: number;
};

/** Ring-oriented navigation state kept separate from painting. */
export class WorkTasksViewModel {
  private state: WorkTasksSnapshot = { available: true, revision: 0, tasks: [] };
  private viewState: WorkTasksView = "lanes";
  private laneIndex = 0;
  private taskIndex = 0;
  private selectedTaskId: string | null = null;

  update(snapshot: WorkTasksSnapshot): void {
    const previousIds = new Set(this.state.tasks.map((task) => task.id));
    const previousSelection = this.selectedTaskId;
    this.state = {
      available: snapshot.available,
      revision: snapshot.revision,
      tasks: snapshot.tasks.map((task) => ({ ...task })),
    };
    const tasks = this.tasks();
    if (this.viewState !== "tasks") return;
    const newlyAdded = tasks.filter((task) => !previousIds.has(task.id)).at(-1);
    if (newlyAdded) {
      this.taskIndex = tasks.findIndex((task) => task.id === newlyAdded.id);
      this.selectedTaskId = newlyAdded.id;
      return;
    }
    const preservedIndex = previousSelection ? tasks.findIndex((task) => task.id === previousSelection) : -1;
    this.taskIndex = preservedIndex >= 0 ? preservedIndex : Math.min(this.taskIndex, Math.max(0, tasks.length - 1));
    this.selectedTaskId = tasks[this.taskIndex]?.id ?? null;
  }

  snapshot(): WorkTasksSnapshot {
    return {
      available: this.state.available,
      revision: this.state.revision,
      tasks: this.state.tasks.map((task) => ({ ...task })),
    };
  }

  view(): WorkTasksView {
    return this.viewState;
  }

  selectedLane(): WorkTaskLane {
    return WORK_TASK_LANES[this.laneIndex]!;
  }

  selectedLaneIndex(): number {
    return this.laneIndex;
  }

  selectedTaskIndex(): number {
    return this.taskIndex;
  }

  selectedTask(): WorkTask | null {
    const task = this.tasks()[this.taskIndex];
    return task ? { ...task } : null;
  }

  tasks(): WorkTask[] {
    const lane = this.selectedLane();
    return this.state.tasks.filter((task) => task.lane === lane).map((task) => ({ ...task }));
  }

  summaries(): WorkTaskLaneSummary[] {
    return WORK_TASK_LANES.map((lane) => {
      const tasks = this.state.tasks.filter((task) => task.lane === lane);
      return { lane, count: tasks.length, blocked: tasks.filter((task) => task.blocked).length };
    });
  }

  scroll(direction: -1 | 1): void {
    if (this.viewState === "lanes") {
      this.laneIndex = (this.laneIndex + direction + WORK_TASK_LANES.length) % WORK_TASK_LANES.length;
      return;
    }
    const tasks = this.tasks();
    if (!tasks.length) return;
    this.taskIndex = (this.taskIndex + direction + tasks.length) % tasks.length;
    this.selectedTaskId = tasks[this.taskIndex]!.id;
  }

  openSelectedLane(): void {
    this.viewState = "tasks";
    this.taskIndex = 0;
    this.selectedTaskId = this.tasks()[0]?.id ?? null;
  }

  backToLanes(): void {
    this.viewState = "lanes";
    this.taskIndex = 0;
    this.selectedTaskId = null;
  }
}
