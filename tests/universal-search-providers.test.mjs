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
    openFile: async (path, rootPath, modifiedMs) => {
      calls.push(["file", path, rootPath, modifiedMs]);
      return rootPath === "/safe" && files.get(path)?.modifiedMs === modifiedMs;
    },
  };
}

test("four local adapters return bounded inert labelled results without broadening source authority", async () => {
  const calls = [];
  const dependencies = fixtureDependencies(calls);
  const providers = createSearchProviders(dependencies);
  const controller = new SearchController(providers, { providerTimeoutMs: 50, resultLimit: 20, tokenFactory: (() => { let id = 0; return () => `h-${++id}`; })() });
  const enabled = new Set(["apps", "calendar", "notifications", "files"]);
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
  const enabled = new Set(["files"]);
  const state = await controller.search("plan", enabled);
  const file = state.results.find((result) => result.sourceId === "files");

  assert.equal(await controller.executeAction(file.actionHandle), "executed");
  assert.deepEqual(calls, [["file", "/safe/plan.md", "/safe", 11]]);
});

test("permission states are explicit and providers do not prompt", async () => {
  const calls = [];
  const dependencies = fixtureDependencies(calls);
  dependencies.notificationAccess = () => false;
  dependencies.hasFileAccess = () => false;
  dependencies.readCalendar = () => ({ status: "permission_denied" });
  const controller = new SearchController(createSearchProviders(dependencies), { providerTimeoutMs: 50, resultLimit: 20 });
  const state = await controller.search("plan", new Set(["calendar", "notifications", "files"]));
  assert.deepEqual(state.sources.map(({ sourceId, state: status }) => [sourceId, status]), [
    ["calendar", "permission_denied"],
    ["notifications", "permission_denied"],
    ["files", "permission_denied"],
  ]);
  assert.deepEqual(calls, []);
});

test("sources without an exact safe adapter report unavailable instead of overclaiming coverage", async () => {
  const calls = [];
  const controller = new SearchController(createSearchProviders(fixtureDependencies(calls)), { providerTimeoutMs: 50, resultLimit: 20 });
  const state = await controller.search("plan", new Set(["media", "health"]));
  assert.deepEqual(state.sources.map(({ sourceId, state: status }) => [sourceId, status]), [
    ["media", "unavailable"],
    ["health", "unavailable"],
  ]);
  assert.deepEqual(state.results, []);
  assert.deepEqual(calls, []);
});

test("notification open binds the exact observed post time and rejects same-key replacement", async () => {
  const calls = [];
  const dependencies = fixtureDependencies(calls);
  let postTime = 15;
  dependencies.readNotifications = () => [{
    key: "notif-1", appName: "Messages", title: "Release plan", text: "Review",
    bigText: "", sender: "Alex", lines: [], postTime, when: postTime,
  }];
  dependencies.openNotification = async (key, expectedPostTime) => {
    calls.push(["notification", key, expectedPostTime]);
    return key === "notif-1" && postTime === expectedPostTime;
  };
  const controller = new SearchController(createSearchProviders(dependencies), { providerTimeoutMs: 50, resultLimit: 20 });
  const state = await controller.search("plan", new Set(["notifications"]));
  postTime = 16;
  assert.equal(await controller.executeAction(state.results[0].actionHandle), "stale");
  assert.deepEqual(calls, [["notification", "notif-1", 15]]);
});

test("symbolic-link bookmark roots and entries never publish file results", async () => {
  const calls = [];
  const dependencies = fixtureDependencies(calls);
  dependencies.statPath = () => ({
    name: "link", path: "/safe", isDirectory: true, isSymbolicLink: true,
    sizeBytes: 0, modifiedMs: 10,
  });
  dependencies.listDirectory = () => [{
    name: "plan.md", path: "/safe/plan.md", isDirectory: false,
    isSymbolicLink: false, sizeBytes: 20, modifiedMs: 11,
  }];
  const controller = new SearchController(createSearchProviders(dependencies), { providerTimeoutMs: 50, resultLimit: 20 });
  const state = await controller.search("plan", new Set(["files"]));
  assert.deepEqual(state.results, []);
  assert.equal(state.sources[0].state, "ready");
  assert.deepEqual(calls, []);
});
