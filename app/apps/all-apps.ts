import { type AppDefinition } from "./app-definition";
import launcherApp from "./launcher";
import healthApp from "./health";
import clockApp from "./clock";
import terminalApp from "./terminal";
import agentCockpitApp from "./agent-cockpit";
import workTasksApp from "./work-tasks";
import universalSearchApp from "./universal-search";
import filesApp from "./files";
import musicApp from "./music";
import conversateApp from "./conversate";
import notificationsApp from "./notifications";
import calendarApp from "./calendar";
import weatherApp from "./weather";
import navigateApp from "./navigate";
import compassApp from "./compass";
import blocksApp from "./blocks";
import minesweeperApp from "./minesweeper";
import freecellApp from "./freecell";
import pinballApp from "./pinball";
import settingsApp from "./settings";
import evenHubSampleApp from "./evenhub-sample";
import capturesApp from "./captures";
import attentionApp from "./attention";

/**
 * Every app, in launcher-grid order (the launcher itself is first but hidden
 * from the grid). The sole registry: the controller, launcher, and assistant
 * tools all discover apps here.
 */
export const ALL_APPS: readonly AppDefinition[] = [
  launcherApp,
  healthApp,
  clockApp,
  terminalApp,
  agentCockpitApp,
  workTasksApp,
  universalSearchApp,
  filesApp,
  musicApp,
  conversateApp,
  notificationsApp,
  calendarApp,
  weatherApp,
  navigateApp,
  compassApp,
  blocksApp,
  minesweeperApp,
  freecellApp,
  pinballApp,
  evenHubSampleApp,
  capturesApp,
  attentionApp,
  settingsApp,
];
