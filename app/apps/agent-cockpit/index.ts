import { type AppDefinition } from "../app-definition";
import {
  AGENT_COCKPIT_SURFACE_ID,
  AGENT_COCKPIT_WINDOW_ID,
  createAgentCockpitWindow,
} from "./agent-cockpit-app";

const agentCockpitApp: AppDefinition = {
  appId: "agent-cockpit",
  title: "Hermes",
  icon: "terminal",
  launch: (ctx) => ctx.launchInProcessApp(
    AGENT_COCKPIT_WINDOW_ID,
    AGENT_COCKPIT_SURFACE_ID,
    createAgentCockpitWindow,
  ),
};

export default agentCockpitApp;