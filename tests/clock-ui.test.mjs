import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("Clock replaces the Timer launcher identity while retaining dormant rollback source", () => {
  const registry = read("app/apps/all-apps.ts");
  const entry = read("app/apps/clock/index.ts");
  const legacy = read("app/apps/timer/index.ts");
  const icons = read("app/graphics/icons.ts");
  assert.match(registry, /import clockApp from "\.\/clock"/);
  assert.match(registry, /\bclockApp\b/);
  assert.doesNotMatch(registry, /timerApp/);
  assert.match(entry, /appId: "clock"/);
  assert.match(entry, /title: "Clock"/);
  assert.match(entry, /icon: "clock"/);
  assert.match(entry, /CLOCK_WINDOW_ID/);
  assert.match(legacy, /appId: "timer"/, "legacy source remains available for rollback but is not registered");
  assert.match(icons, /clock:\s*\n\s*'<svg[\s\S]*?<circle cx="12" cy="12" r="9"\/><path d="M12 7v5l3 2"\/>/);
});

test("Clock is a visual-first four-tab surface with ring-native creation editors", () => {
  const ui = read("app/apps/clock/clock-app.ts");
  assert.match(ui, /CLOCK_TABS = \["alarms", "timers", "world", "stopwatch"\]/);
  assert.match(ui, /"CLOCK"/);
  for (const label of ["ALARMS", "TIMERS", "WORLD", "STOPWATCH"]) assert.match(ui, new RegExp(`"${label}"`));
  assert.match(ui, /class TimerEditorLayer implements Layer/);
  assert.match(ui, /class AlarmEditorLayer implements Layer/);
  assert.match(ui, /class WorldClockPickerLayer implements Layer/);
  assert.match(ui, /Scroll: adjust\s+Click: next\s+Double-click: cancel/);
  assert.match(ui, /store\.setTimer\(\{ operationId: guiOperationId\("timer"\), durationSeconds \}\)/);
  assert.match(ui, /store\.setAlarm\(\{[\s\S]*operationId: guiOperationId\("alarm"\)[\s\S]*localTime[\s\S]*repeatDays/);
  assert.match(ui, /clockSchedulerBridge\.sync\(this\.store\.scheduledItems\(\)\)/);
  assert.match(ui, /Timer saved · scheduling unconfirmed/);
  assert.match(ui, /Alarm saved · scheduling unconfirmed/);
  assert.match(ui, /runScheduledMutation\(\(\) => this\.store\.(?:pauseTimer|resumeTimer|restartTimer|deleteTimer|setAlarmEnabled|deleteAlarm)/);
  assert.match(ui, /EXACT ALARMS OFF/);
  assert.match(ui, /store\.addWorldClock\(preset\)/);
  assert.match(ui, /stopwatchAccumulatedMs/);
  assert.match(ui, /Stopwatch stays active across tabs/);
});

test("Clock cards expose durable schedule and missed-alert state", () => {
  const ui = read("app/apps/clock/clock-app.ts");
  assert.match(ui, /occurrence\.status === "silent" \? "MISSED" : "RINGING"/);
  assert.match(ui, /alarm\.enabled \? "ON" : "OFF"/);
  assert.match(ui, /timer\.state === "running" \? "RUNNING"/);
  assert.match(ui, /formatWorldTime\(worldClock, now\)/);
  assert.match(ui, /Intl\.DateTimeFormat\("en-GB", \{[\s\S]*timeZone: worldClock\.timeZone/);
});

test("Clock state is secret-classified and legacy window/folder identity migrates", () => {
  const settings = read("app/native/settings-store.ts");
  const persistence = read("app/ui/shell/open-apps-persistence.ts");
  const folders = read("app/apps/launcher/launcher-folders.ts");
  const debug = read("debug-control/control-protocol.ts");
  assert.match(settings, /"clock\.store\.v1"/);
  assert.match(persistence, /migratedAppId === "timer" \? "clock" : migratedAppId/);
  assert.match(persistence, /parsed\.foreground === "timer" \? "clock" : parsed\.foreground/);
  assert.match(folders, /appId === "timer" \? "clock" : appId/);
  assert.match(debug, /"launcher", "health", "clock", "files"/);
});
