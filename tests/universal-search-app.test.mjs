import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const apps = readFileSync(new URL("../app/apps/all-apps.ts", import.meta.url), "utf8");
const index = readFileSync(new URL("../app/apps/universal-search/index.ts", import.meta.url), "utf8");
const windowSource = readFileSync(new URL("../app/apps/universal-search/universal-search-app.ts", import.meta.url), "utf8");
const fileAccess = readFileSync(new URL("../app/native/file-access.ts", import.meta.url), "utf8");

test("universal search is launcher registered and accepts only reviewed shell text", () => {
  assert.match(apps, /import universalSearchApp from "\.\/universal-search"/);
  assert.match(apps, /agentCockpitApp,\s*\n\s*universalSearchApp,/);
  assert.match(index, /appId: "universal-search"/);
  assert.match(index, /launchInProcessApp/);
  assert.match(windowSource, /receiveTextInput: \(text\) => layer\.receiveReviewedQuery\(text\)/);
});

test("search filters and clear are local window actions and query content is never logged or persisted", () => {
  assert.match(windowSource, /menuItems: \(\) => layer\.menuItems\(\)/);
  assert.match(windowSource, /Clear query/);
  assert.match(windowSource, /toggleSource/);
  assert.doesNotMatch(windowSource, /setStringSetting|ApplicationSettings|appendLog|console\.(?:log|warn|error)/);
});

test("safe opens use exact notification, file, calendar-event, and Hermes-session revalidation", () => {
  assert.match(windowSource, /readNotificationByKey\(key\)/);
  assert.match(windowSource, /notification\.postTime !== postTime/);
  assert.doesNotMatch(windowSource, /SingleNotificationLayer/);
  assert.match(windowSource, /entry\.modifiedMs !== modifiedMs/);
  assert.match(windowSource, /canonicalPath\(rootPath\)/);
  assert.match(windowSource, /entry\.isSymbolicLink/);
  assert.match(windowSource, /event\.id === eventId && event\.startMs === startMs/);
  assert.match(windowSource, /session\.session_id === sessionId && session\.generation === generation/);
  assert.doesNotMatch(windowSource, /invokeNotificationAction|dismissNotification|steer\(|interrupt\(|updateBlock|sendCommand/);
});

test("filesystem failures do not place private paths or exception bodies in logs", () => {
  assert.doesNotMatch(fileAccess, /failed for \$\{path\}|failed for \$\{filename\}|\$\{error\}/);
});
