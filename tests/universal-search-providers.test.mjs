import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const core = readFileSync(new URL("../app/search/core.ts", import.meta.url), "utf8");
const providers = readFileSync(new URL("../app/search/providers.ts", import.meta.url), "utf8")
  .replace(/import[\s\S]*?from "\.\/core";\n/, "");
const js = ts.transpileModule(`${core}\n${providers}`, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
}).outputText;
const { SearchController, createSearchProviders } = await import(
  "data:text/javascript;base64," + Buffer.from(js).toString("base64")
);

function fixtureDependencies(calls) {
  const apps = [
    { appId: "calendar", title: "Plan calendar", showInLauncher: true },
    { appId: "hidden", title: "Hidden", showInLauncher: false },
  ];
  const files = new Map([
    ["/safe", { name: "safe", path: "/safe", isDirectory: true, sizeBytes: 0, modifiedMs: 10 }],
    ["/safe/plan.md", { name: "plan.md", path: "/safe/plan.md", isDirectory: false, sizeBytes: 20, modifiedMs: 11 }],
  ]);
  let cockpit = {
    synchronized: true,
    sessions: [{ session_id: "session-1", generation: 3, revision: 1, title: "Plan release", summary: "Ready", updated_at_ms: 12 }],
  };
  return {
    apps: () => apps,
    launchApp: async (appId) => { calls.push(["app", appId]); return apps.some((app) => app.appId === appId); },
    readCalendar: () => ({ status: "success", events: [
      { id: 7, title: "Planning call", location: "Studio", calendarName: "Work", startMs: 13, endMs: 14, allDay: false },
    ] }),
    openCalendar: async (id, startMs) => { calls.push(["calendar", id, startMs]); return id === 7 && startMs === 13; },
    notificationAccess: () => true,
    readNotifications: () => [{ key: "notif-1", appName: "Messages", title: "Release plan", text: "Review", bigText: "", sender: "Alex", lines: [], postTime: 15, when: 15 }],
    openNotification: async (key) => { calls.push(["notification", key]); return key === "notif-1"; },
    hasFileAccess: () => true,
    bookmarkedPaths: () => ["/safe"],
    statPath: (path) => files.get(path) ?? null,
    listDirectory: (path) => path === "/safe" ? [files.get("/safe/plan.md")] : null,
    openFile: async (path, modifiedMs) => { calls.push(["file", path, modifiedMs]); return files.get(path)?.modifiedMs === modifiedMs; },
    cockpitSnapshot: () => cockpit,
    openHermesSession: async (sessionId, generation) => {
      calls.push(["hermes", sessionId, generation]);
      return cockpit.synchronized && cockpit.sessions.some((session) => session.session_id === sessionId && session.generation === generation);
    },
    setCockpit: (next) => { cockpit = next; },
  };
}

test("five local adapters return bounded inert labelled results without broadening source authority", async () => {
  const calls = [];
  const dependencies = fixtureDependencies(calls);
  const providers = createSearchProviders(dependencies);
  const controller = new SearchController(providers, { providerTimeoutMs: 50, resultLimit: 20, tokenFactory: (() => { let id = 0; return () => `h-${++id}`; })() });
  const enabled = new Set(["apps", "calendar", "notifications", "files", "hermes_sessions"]);
  const state = await controller.search("plan", enabled);

  assert.deepEqual(new Set(state.results.map((result) => result.sourceId)), enabled);
  assert.equal(state.results.every((result) => result.title.length <= 120 && result.snippet.length <= 240), true);
  assert.equal(state.results.every((result) => result.action === undefined && result.actionHandle), true);
  assert.equal(state.results.some((result) => result.resultId === "hidden"), false);
  assert.equal(state.results.some((result) => result.title.includes("Review")), false, "notification body stays in bounded snippet, not title");
});

test("exact adapter actions revalidate current identity and never fall back", async () => {
  const calls = [];
  const dependencies = fixtureDependencies(calls);
  const controller = new SearchController(createSearchProviders(dependencies), { providerTimeoutMs: 50, resultLimit: 20 });
  const enabled = new Set(["files", "hermes_sessions"]);
  const state = await controller.search("plan", enabled);
  const file = state.results.find((result) => result.sourceId === "files");
  const session = state.results.find((result) => result.sourceId === "hermes_sessions");

  assert.equal(await controller.executeAction(file.actionHandle), "executed");
  dependencies.setCockpit({ synchronized: true, sessions: [{ session_id: "session-1", generation: 4, revision: 1, title: "Replacement", summary: "", updated_at_ms: 20 }] });
  assert.equal(await controller.executeAction(session.actionHandle), "stale");
  assert.deepEqual(calls, [["file", "/safe/plan.md", 11], ["hermes", "session-1", 3]]);
});

test("permission and offline states are explicit and providers do not prompt", async () => {
  const calls = [];
  const dependencies = fixtureDependencies(calls);
  dependencies.notificationAccess = () => false;
  dependencies.hasFileAccess = () => false;
  dependencies.readCalendar = () => ({ status: "permission_denied" });
  dependencies.setCockpit({ synchronized: false, sessions: [] });
  const controller = new SearchController(createSearchProviders(dependencies), { providerTimeoutMs: 50, resultLimit: 20 });
  const state = await controller.search("plan", new Set(["calendar", "notifications", "files", "hermes_sessions"]));
  assert.deepEqual(state.sources.map(({ sourceId, state: status }) => [sourceId, status]), [
    ["calendar", "permission_denied"],
    ["notifications", "permission_denied"],
    ["files", "permission_denied"],
    ["hermes_sessions", "offline"],
  ]);
  assert.deepEqual(calls, []);
});

test("sources without an exact safe adapter report unavailable instead of overclaiming coverage", async () => {
  const calls = [];
  const controller = new SearchController(createSearchProviders(fixtureDependencies(calls)), { providerTimeoutMs: 50, resultLimit: 20 });
  const state = await controller.search("plan", new Set(["roam", "terminal", "media", "health"]));
  assert.deepEqual(state.sources.map(({ sourceId, state: status }) => [sourceId, status]), [
    ["roam", "unavailable"],
    ["terminal", "unavailable"],
    ["media", "unavailable"],
    ["health", "unavailable"],
  ]);
  assert.deepEqual(state.results, []);
  assert.deepEqual(calls, []);
});
