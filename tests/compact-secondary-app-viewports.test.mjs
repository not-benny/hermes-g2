import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const COMPACT_HEIGHT = 232;
const SMALL_LINE_HEIGHT = 12;

function read(relativePath) {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

async function loadExportedFunction(relativePath, functionName, constantNames) {
  const source = read(relativePath);
  const start = source.indexOf(`export function ${functionName}`);
  assert.notEqual(start, -1, `${functionName} export missing`);
  const bodyStart = source.indexOf("{", start);
  let depth = 0;
  let end = -1;
  for (let index = bodyStart; index < source.length; index++) {
    if (source[index] === "{") depth++;
    else if (source[index] === "}" && --depth === 0) {
      end = index + 1;
      break;
    }
  }
  assert.notEqual(end, -1, `${functionName} body is incomplete`);
  const constants = constantNames
    .map((name) => {
      const declaration = source.match(
        new RegExp(`^const ${name} = [^\\n]+;$`, "m"),
      );
      assert.ok(declaration, `${name} declaration missing`);
      return declaration[0];
    })
    .join("\n");
  const js = ts.transpileModule(`${constants}\n${source.slice(start, end)}`, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2020,
    },
  }).outputText;
  return (
    await import(
      `data:text/javascript;base64,${Buffer.from(js).toString("base64")}`
    )
  )[functionName];
}

const timerEditorMessageY = await loadExportedFunction(
  "app/apps/timer/timer-app.worker.ts",
  "timerEditorMessageY",
  [
    "FOOTER_HEIGHT",
    "EDITOR_FIELDS_TOP",
    "EDITOR_MESSAGE_PREFERRED_Y",
    "EDITOR_MESSAGE_GAP",
  ],
);
const resourceUsageCpuChartHeight = await loadExportedFunction(
  "app/apps/debug-tests/resource-usage.ts",
  "resourceUsageCpuChartHeight",
  [
    "CPU_CHART_TOP",
    "CPU_CHART_MAX_HEIGHT",
    "FOOTER_TEXT_OFFSET",
    "CPU_CHART_FOOTER_GAP",
  ],
);
const universalSearchRowPitch = await loadExportedFunction(
  "app/apps/universal-search/universal-search-app.ts",
  "universalSearchRowPitch",
  [
    "RESULT_LIST_TOP",
    "RESULT_ROW_MAX_PITCH",
    "RESULT_ROW_MIN_PITCH",
    "FOOTER_DIVIDER_OFFSET",
  ],
);
const launcherCellIconSize = await loadExportedFunction(
  "app/apps/launcher/launcher-app.ts",
  "launcherCellIconSize",
  ["ICON_SIZE", "LABEL_GAP"],
);

test("timer editor feedback stays between the title, fields, and compact footer", () => {
  const y = timerEditorMessageY(COMPACT_HEIGHT, SMALL_LINE_HEIGHT);
  const fieldsTop = 57;
  const footerTop = COMPACT_HEIGHT - 34;
  assert.ok(y >= 28, "feedback remains below the title");
  assert.ok(
    y + SMALL_LINE_HEIGHT + 4 <= fieldsTop,
    "feedback clears the duration fields",
  );
  assert.ok(
    y + SMALL_LINE_HEIGHT + 4 <= footerTop,
    "feedback clears the footer",
  );
  assert.equal(
    timerEditorMessageY(424, SMALL_LINE_HEIGHT),
    38,
    "roomy layout keeps the preferred position",
  );
});

test("resource CPU chart shrinks before the compact footer without changing roomy layout", () => {
  const chartTop = 160;
  const footerTextY = COMPACT_HEIGHT - 16;
  const compactHeight = resourceUsageCpuChartHeight(COMPACT_HEIGHT);
  assert.equal(compactHeight, 48);
  assert.ok(chartTop + compactHeight + 8 <= footerTextY);
  assert.equal(resourceUsageCpuChartHeight(424), 60);
});

test("all four universal-search rows and selection geometry clear the compact footer", () => {
  const listTop = 57;
  const footerY = COMPACT_HEIGHT - 31;
  const pitch = universalSearchRowPitch(COMPACT_HEIGHT, 4);
  const lastRowY = listTop + pitch * 3;
  const highlightBottom = lastRowY - 3 + Math.min(35, pitch - 1);
  const snippetBottom = lastRowY + 16 + SMALL_LINE_HEIGHT;
  assert.equal(pitch, 36);
  assert.ok(highlightBottom <= footerY);
  assert.ok(snippetBottom <= footerY);
  assert.equal(universalSearchRowPitch(424, 4), 40);
});

test("launcher folder cells shrink icons just enough to keep labels in their rows", () => {
  const gridBottom = COMPACT_HEIGHT - 16;
  const folderGridTop = 6 + 16;
  const folderRowHeight = (gridBottom - folderGridTop) / 3.5;
  const folderIconSize = launcherCellIconSize(
    folderRowHeight,
    SMALL_LINE_HEIGHT,
  );
  assert.equal(folderIconSize, 41);
  assert.ok(folderIconSize + 2 + SMALL_LINE_HEIGHT <= folderRowHeight);

  const topLevelRowHeight = (gridBottom - 6) / 3.5;
  assert.equal(launcherCellIconSize(topLevelRowHeight, SMALL_LINE_HEIGHT), 44);
});

test("the four app renderers use their compact geometry functions", () => {
  assert.match(
    read("app/apps/timer/timer-app.worker.ts"),
    /timerEditorMessageY\(image\.height, smallFont\.lineHeight\)/,
  );
  assert.match(
    read("app/apps/debug-tests/resource-usage.ts"),
    /height: resourceUsageCpuChartHeight\(height\)/,
  );
  const search = read("app/apps/universal-search/universal-search-app.ts");
  assert.match(
    search,
    /const rowPitch = universalSearchRowPitch\(height, screen\.rows\.length\)/,
  );
  assert.match(search, /y \+= rowPitch/);
  const launcher = read("app/apps/launcher/launcher-app.ts");
  assert.match(
    launcher,
    /const iconSize = launcherCellIconSize\(rowH, font\.lineHeight\)/,
  );
  assert.match(launcher, /renderIcon\([\s\S]*iconSize,\s*\)/);
  assert.match(launcher, /blockTop \+ iconSize \+ LABEL_GAP/);
});
