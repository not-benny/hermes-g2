import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../app/phone-ui/main-page.ts", import.meta.url), "utf8");

test("restores persisted glasses apps only after the initial connection has prepared compositor surfaces", () => {
  assert.match(source, /autoConnect\(\)\.then\(\(\) => dashboardController\.restoreOpenApps\(\)\)/);
  assert.doesNotMatch(source, /void model\?\.autoConnect\(\)\s*\n\s*\/\/ Reopen[\s\S]*?void dashboardController\.restoreOpenApps\(\)/);
});
