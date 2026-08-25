import { type AppDefinition } from "../app-definition";
import {
  createWorkTasksWindow,
  WORK_TASKS_SURFACE_ID,
  WORK_TASKS_WINDOW_ID,
} from "./work-tasks-app";

const workTasksApp: AppDefinition = {
  appId: "work-tasks",
  title: "Tasks",
  icon: "list-checks",
  launch: (ctx) => ctx.launchInProcessApp(
    WORK_TASKS_WINDOW_ID,
    WORK_TASKS_SURFACE_ID,
    createWorkTasksWindow,
  ),
};

export default workTasksApp;
