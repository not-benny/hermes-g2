import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("calendar preserves empty success separately from permission and provider failures", () => {
  const native = read("app/native/calendar.ts");
  const java = read("App_Resources/Android/src/main/java/com/faceclaw/app/FaceclawCalendarProvider.java");
  const tools = read("app/assistant/system-tools.ts");
  const ui = read("app/apps/calendar/calendar.ts");

  for (const status of ["success", "permission_denied", "provider_unavailable", "query_failed"]) {
    assert.match(native, new RegExp(`status: \\\"${status}\\\"`));
    assert.match(java, new RegExp(status));
  }
  assert.match(native, /lastPermissionState/);
  assert.match(native, /events: \[\.\.\.cache\.events\]/);
  assert.match(tools, /calendar permission is not granted/i);
  assert.match(tools, /calendar provider is unavailable/i);
  assert.match(ui, /Calendar unavailable/);
});
