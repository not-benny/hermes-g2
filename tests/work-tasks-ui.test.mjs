import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const transpile = (source) => ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const dataUrl = (source) => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const storeStub = dataUrl('export const WORK_TASK_LANES = ["inbox", "today", "doing", "done"];');
const viewModelSource = transpile(read("app/work-tasks/view-model.ts"))
  .replace('"./store"', JSON.stringify(storeStub));
const { WorkTasksViewModel } = await import(dataUrl(viewModelSource));

const task = (id, lane, blocked = false) => ({ id, lane, blocked, title: id, createdAtMs: 1, updatedAtMs: 1 });

test("ring model navigates four lanes, tasks, and selects a newly added task in the open lane", () => {
  const model = new WorkTasksViewModel();
  model.update({ available: true, revision: 1, tasks: [task("one", "inbox"), task("today", "today", true)] });
  assert.deepEqual(model.summaries(), [
    { lane: "inbox", count: 1, blocked: 0 },
    { lane: "today", count: 1, blocked: 1 },
    { lane: "doing", count: 0, blocked: 0 },
    { lane: "done", count: 0, blocked: 0 },
  ]);
  model.scroll(-1);
  assert.equal(model.selectedLane(), "done", "lane cover wraps for fast ring navigation");
  model.scroll(1);
  model.openSelectedLane();
  assert.equal(model.view(), "tasks");
  assert.equal(model.selectedTask().id, "one");
  model.update({ available: true, revision: 2, tasks: [task("one", "inbox"), task("new", "inbox")] });
  assert.equal(model.selectedTask().id, "new");
  model.backToLanes();
  assert.equal(model.view(), "lanes");
});

test("Tasks is a distinct launcher app with a bounded visual-first board and no generic text creation", () => {
  const registry = read("app/apps/all-apps.ts");
  const index = read("app/apps/work-tasks/index.ts");
  const ui = read("app/apps/work-tasks/work-tasks-app.ts");
  const icons = read("app/graphics/icons.ts");
  assert.match(registry, /import workTasksApp from "\.\/work-tasks"/);
  assert.match(registry, /workTasksApp/);
  assert.match(index, /appId: "work-tasks"/);
  assert.match(index, /title: "Tasks"/);
  assert.match(index, /icon: "list-checks"/);
  assert.match(icons, /"list-checks"/);
  assert.match(ui, /"WORK TASKS"/);
  assert.match(ui, /Math\.min\(width, 536\)/);
  assert.match(ui, /BLOCKED/);
  assert.match(ui, /selectedTaskIndex\(\) \+ 1/);
  assert.match(ui, /WorkTaskDetailLayer/);
  assert.match(ui, /wrapText\(small, task\.title,[\s\S]*breakLongWords: true/);
  assert.match(ui, /titleScrollLine/);
  assert.match(ui, /Click: actions/);
  assert.match(ui, /Intentionally no receiveTextInput/);
  assert.doesNotMatch(ui, /^\s*receiveTextInput\s*:/m);
});

test("destructive task actions use safe-default confirmation menus and unreadable data has an explicit reset", () => {
  const ui = read("app/apps/work-tasks/work-tasks-app.ts");
  const deleteMenu = ui.slice(ui.indexOf('openModalMenu(ctx, "DELETE TASK?"'), ui.indexOf("private openClearDoneConfirmation"));
  const clearMenu = ui.slice(ui.indexOf('openModalMenu(ctx, "CLEAR COMPLETED?"'), ui.indexOf("private openResetConfirmation"));
  const resetMenu = ui.slice(ui.indexOf('openModalMenu(ctx, "RESET TASK DATA?"'), ui.indexOf("private runMutation"));
  for (const menu of [deleteMenu, clearMenu, resetMenu]) {
    assert.ok(menu.indexOf('label: "Cancel"') >= 0);
    assert.ok(menu.indexOf('label: "Cancel"') < menu.indexOf("store."), "Cancel is the initially selected safe action");
  }
  assert.match(ui, /discardUnreadableData/);
});

test("native encrypted presence probe distinguishes absence from unreadable stored ciphertext without exposing values", () => {
  const java = read("App_Resources/Android/src/main/java/com/faceclaw/app/FaceclawSettings.java");
  const native = read("app/native/settings-store.ts");
  const store = read("app/work-tasks/store.ts");
  assert.match(java, /public synchronized boolean hasStoredSecret\(String key\)/);
  assert.match(java, /securePrefs\.contains\(key\)[\s\S]*securePrefs\.contains\(key \+ "\.__pending"\)[\s\S]*prefs\.contains\(key\)/);
  assert.match(native, /hasStoredSecretSetting/);
  assert.match(store, /storedValuePresent === true[\s\S]*this\.available = false/);
  assert.match(store, /"work\.tasks\.store\.v1"/);
  assert.match(native, /"work\.tasks\.store\.v1"/);
});
