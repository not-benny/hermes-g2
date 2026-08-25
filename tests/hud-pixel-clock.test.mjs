import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../app/ui/shell/hud-pixel-clock.ts", import.meta.url), "utf8");
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
}).outputText;
const dataUrl = "data:text/javascript;base64," + Buffer.from(js).toString("base64");
const { measureHudPixelText, paintHudPixelClock } = await import(dataUrl);

test("the 8-bit time/date renderer fills both HUD rows without leaving its block", () => {
  const fills = [];
  const surface = { fillRect: (x, y, width, height, value) => fills.push({ x, y, width, height, value }) };
  const right = paintHudPixelClock(surface, {
    left: 82,
    width: 150,
    barTop: 20,
    time: "12:35 PM",
    date: "MON 24 AUG",
  });
  assert.equal(right, 232);
  assert.ok(fills.some((fill) => fill.width === 5 && fill.height === 5 && fill.value === 235),
    "time uses large square pixels");
  assert.ok(fills.some((fill) => fill.width === 2 && fill.height === 2 && fill.value === 150),
    "date uses a distinct small-pixel row");
  assert.ok(fills.every((fill) => fill.x >= 82 && fill.x + fill.width <= 232));
  assert.ok(fills.filter((fill) => fill.value === 235).every((fill) => fill.y >= 26 && fill.y + fill.height <= 51));
  assert.ok(fills.filter((fill) => fill.value === 150).every((fill) => fill.y >= 59 && fill.y + fill.height <= 69));
  assert.ok(Math.max(...fills.map((fill) => fill.y + fill.height)) <= 20 + 56);
});

test("long 12-hour labels scale down only when required by the clock block", () => {
  assert.equal(measureHudPixelText("12:35 PM", 5), 150);
  assert.ok(measureHudPixelText("12:35 PM", 5) <= 150);
  assert.ok(measureHudPixelText("12:35 PM", 6) > 150);
});

test("every English HUD date and 12-hour clock label fits the optical clock block", () => {
  const weekdays = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
  const months = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
  for (const weekday of weekdays) {
    for (const month of months) {
      assert.ok(measureHudPixelText(`${weekday} 28 ${month}`, 2) <= 150);
    }
  }
  for (let hour = 1; hour <= 12; hour++) {
    for (const meridiem of ["AM", "PM"]) {
      assert.ok(measureHudPixelText(`${hour}:59 ${meridiem}`, 5) <= 150);
    }
  }
});
