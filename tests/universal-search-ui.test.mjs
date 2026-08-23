import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../app/search/view-model.ts", import.meta.url), "utf8")
  .replace(/import type[\s\S]*?from "\.\/core";\n/, "");
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
}).outputText;
const { SearchViewModel } = await import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));

function searchState() {
  return {
    generation: 1,
    query: "plan",
    sources: [
      { sourceId: "apps", label: "Apps", state: "ready" },
      { sourceId: "calendar", label: "Calendar", state: "ready" },
      { sourceId: "files", label: "Files", state: "timeout" },
    ],
    results: [
      { sourceId: "calendar", resultId: "c1", title: "Planning", snippet: "Today", freshnessMs: 4, actionHandle: "hc" },
      { sourceId: "apps", resultId: "a1", title: "Planner", snippet: "App", freshnessMs: 3, actionHandle: "ha" },
      { sourceId: "calendar", resultId: "c2", title: "Plan review", snippet: "Tomorrow", freshnessMs: 2, actionHandle: "hc2" },
    ],
  };
}

test("view model groups stable source-labelled rows and paginates only selectable results", () => {
  const model = new SearchViewModel(["apps", "calendar", "files"], 2);
  model.setState(searchState());
  let screen = model.screen();
  assert.equal(screen.pageCount, 2);
  assert.deepEqual(screen.rows.map((row) => [row.sourceLabel, row.title]), [
    ["Apps", "Planner"],
    ["Calendar", "Planning"],
  ]);
  assert.equal(screen.rows[0].selected, true);
  model.move(1);
  model.move(1);
  screen = model.screen();
  assert.equal(screen.page, 2);
  assert.equal(screen.rows[0].title, "Plan review");
  assert.equal(model.selectedActionHandle(), "hc2");
});

test("filters are opt-in, preserve selection safely, and expose unavailable state", () => {
  const model = new SearchViewModel(["apps"], 4);
  assert.deepEqual(model.enabledSources(), ["apps"]);
  model.setState(searchState());
  assert.deepEqual(model.screen().rows.map((row) => row.sourceId), ["apps"]);
  model.toggleSource("calendar");
  assert.deepEqual(model.screen().rows.map((row) => row.sourceId), ["apps", "calendar", "calendar"]);
  assert.match(model.screen().status, /Files off/);
  model.toggleSource("apps");
  assert.equal(model.screen().rows[0].sourceId, "calendar");
});

test("clear removes query/results without persisting private history and keeps source choices", () => {
  const model = new SearchViewModel(["apps", "calendar"], 4);
  model.setState(searchState());
  model.move(1);
  model.clear();
  const screen = model.screen();
  assert.equal(screen.query, "");
  assert.deepEqual(screen.rows, []);
  assert.deepEqual(model.enabledSources(), ["apps", "calendar"]);
  assert.equal(model.selectedActionHandle(), undefined);
});
