import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

function loadTypeScriptModule(path) {
  const source = readFileSync(new URL(path, import.meta.url), "utf8");
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  return import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));
}

const { SearchController, SearchProviderFailure, rankSearchResults } = await loadTypeScriptModule("../app/search/core.ts");

test("ranking is Unicode-aware, deterministic, bounded, and deduplicates exact source identities", () => {
  const ranked = rankSearchResults(" café  plan ", [
    { sourceId: "calendar", resultId: "later", title: "Café planning", snippet: "Tomorrow", freshnessMs: 20 },
    { sourceId: "calendar", resultId: "exact", title: "CAFÉ PLAN", snippet: "Exact", freshnessMs: 10 },
    { sourceId: "calendar", resultId: "later", title: "Changed duplicate", snippet: "Must not win", freshnessMs: 99 },
    { sourceId: "files", resultId: "file", title: "Plan for café", snippet: "Notes", freshnessMs: 30 },
    { sourceId: "files", resultId: "miss", title: "Unrelated", snippet: "No match", freshnessMs: 40 },
  ], 2);

  assert.deepEqual(ranked.map((result) => `${result.sourceId}:${result.resultId}`), [
    "calendar:exact",
    "calendar:later",
  ]);
  assert.equal(ranked[1].title, "Café planning");
  assert.equal(ranked.length, 2);
});

test("providers publish independently while timeout and replacement generations fail closed", async () => {
  let releaseOld;
  const oldResult = new Promise((resolve) => { releaseOld = resolve; });
  const updates = [];
  const controller = new SearchController([
    {
      sourceId: "apps", label: "Apps", privacyClass: "public_metadata",
      search: async (query) => query === "old" ? oldResult : [
        { sourceId: "apps", resultId: "new", title: "New plan", snippet: "", freshnessMs: 1 },
      ],
    },
    {
      sourceId: "calendar", label: "Calendar", privacyClass: "private_content",
      search: async () => new Promise(() => {}),
    },
  ], { providerTimeoutMs: 15, resultLimit: 10 });

  const oldSearch = controller.search("old", new Set(["apps"]), (state) => updates.push(state));
  const current = await controller.search("new plan", new Set(["apps", "calendar"]), (state) => updates.push(state));
  releaseOld([{ sourceId: "apps", resultId: "old", title: "Old plan", snippet: "", freshnessMs: 2 }]);
  await oldSearch;

  assert.equal(current.query, "new plan");
  assert.deepEqual(current.results.map((result) => result.resultId), ["new"]);
  assert.equal(current.sources.find((source) => source.sourceId === "apps").state, "ready");
  assert.equal(current.sources.find((source) => source.sourceId === "calendar").state, "timeout");
  assert.equal(updates.some((state) => state.results.some((result) => result.resultId === "old")), false);
});

test("action handles are exact-generation one-shot capabilities revalidated by their provider", async () => {
  const calls = [];
  let available = true;
  let nextHandle = 0;
  const provider = {
    sourceId: "apps", label: "Apps", privacyClass: "public_metadata",
    search: async () => [{
      sourceId: "apps", resultId: "calendar", title: "Calendar", snippet: "App", freshnessMs: 1,
      action: { kind: "open_app", appId: "calendar" },
    }],
    execute: async (action) => {
      if (!available) return "stale";
      calls.push(action);
      return "executed";
    },
  };
  const controller = new SearchController([provider], {
    providerTimeoutMs: 20,
    resultLimit: 10,
    tokenFactory: () => `handle-${++nextHandle}`,
  });

  const first = await controller.search("calendar", new Set(["apps"]));
  const firstHandle = first.results[0].actionHandle;
  assert.equal(await controller.executeAction(firstHandle), "executed");
  assert.equal(await controller.executeAction(firstHandle), "consumed");
  assert.equal(calls.length, 1);

  const second = await controller.search("calendar", new Set(["apps"]));
  available = false;
  assert.equal(await controller.executeAction(second.results[0].actionHandle), "stale");
  assert.equal(await controller.executeAction(firstHandle), "stale");
  assert.equal(calls.length, 1);
});

test("provider permission and offline failures remain honest and isolated", async () => {
  const controller = new SearchController([
    {
      sourceId: "calendar", label: "Calendar", privacyClass: "private_content",
      search: async () => { throw new SearchProviderFailure("permission_denied"); },
    },
    {
      sourceId: "hermes_sessions", label: "Hermes", privacyClass: "private_content",
      search: async () => { throw new SearchProviderFailure("offline"); },
    },
  ], { providerTimeoutMs: 20, resultLimit: 10 });
  const state = await controller.search("plan", new Set(["calendar", "hermes_sessions"]));
  assert.deepEqual(state.sources.map(({ sourceId, state: sourceState }) => [sourceId, sourceState]), [
    ["calendar", "permission_denied"],
    ["hermes_sessions", "offline"],
  ]);
});

test("malformed provider objects fail only their source without evaluating executable payloads", async () => {
  const hostile = { sourceId: "files", resultId: "hostile", snippet: "", freshnessMs: 1 };
  Object.defineProperty(hostile, "title", { get() { throw new Error("private-sentinel"); } });
  const controller = new SearchController([
    { sourceId: "files", label: "Files", privacyClass: "private_content", search: async () => [hostile] },
    {
      sourceId: "apps", label: "Apps", privacyClass: "public_metadata",
      search: async () => [{ sourceId: "apps", resultId: "planner", title: "Planner", snippet: "", freshnessMs: 1 }],
    },
  ], { providerTimeoutMs: 20, resultLimit: 10 });

  const state = await controller.search("plan", new Set(["files", "apps"]));
  assert.deepEqual(state.results.map((result) => result.resultId), ["planner"]);
  assert.equal(state.sources.find((source) => source.sourceId === "files").state, "error");
  assert.equal(state.sources.find((source) => source.sourceId === "apps").state, "ready");
});
