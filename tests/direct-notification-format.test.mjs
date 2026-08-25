import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../app/assistant/direct-notification-format.ts", import.meta.url), "utf8");
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
}).outputText;
const moduleUrl = `data:text/javascript;base64,${Buffer.from(js).toString("base64")}`;
const {
  formatDirectNotificationHeader,
  formatDirectNotificationHeaderParts,
} = await import(moduleUrl);

const local = (year, month, day, hour, minute) => new Date(year, month, day, hour, minute).getTime();

test("today's phone-owned receipt time is explicit and supports 24-hour and 12-hour clocks", () => {
  const now = local(2026, 7, 24, 18, 0);
  assert.equal(
    formatDirectNotificationHeader(local(2026, 7, 24, 14, 30), 1, 1, "24h", now),
    "Hermes · received 14:30",
  );
  assert.equal(
    formatDirectNotificationHeader(local(2026, 7, 24, 14, 30), 1, 1, "12h", now),
    "Hermes · received 2:30 PM",
  );
  assert.equal(
    formatDirectNotificationHeader(local(2026, 7, 24, 0, 5), 1, 1, "12h", now),
    "Hermes · received 12:05 AM",
  );
});

test("older receipt times include date and add the year only across years", () => {
  const now = local(2026, 7, 24, 18, 0);
  assert.equal(
    formatDirectNotificationHeader(local(2026, 6, 3, 9, 7), 1, 1, "24h", now),
    "Hermes · received 3 Jul 09:07",
  );
  assert.equal(
    formatDirectNotificationHeader(local(2025, 7, 24, 14, 30), 1, 1, "24h", now),
    "Hermes · received 24 Aug 2025 14:30",
  );
});

test("multi-card position is a separately reservable suffix and remains in the full label", () => {
  const received = local(2025, 7, 24, 14, 30);
  const now = local(2026, 7, 24, 18, 0);
  assert.deepEqual(
    formatDirectNotificationHeaderParts(received, 1, 32, "24h", now),
    { leading: "Hermes · received 24 Aug 2025 14:30", trailing: "1/32" },
  );
  assert.equal(
    formatDirectNotificationHeader(received, 1, 32, "24h", now),
    "Hermes · received 24 Aug 2025 14:30 · 1/32",
  );
});

test("invalid timestamps and queue positions fail closed", () => {
  const now = local(2026, 7, 24, 18, 0);
  for (const args of [
    [Number.NaN, 1, 1, "24h", now],
    [now, 0, 1, "24h", now],
    [now, 2, 1, "24h", now],
    [now, 1, 1, "24h", Number.NaN],
  ]) {
    assert.throws(() => formatDirectNotificationHeader(...args));
  }
});
