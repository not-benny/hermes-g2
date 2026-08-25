import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const source = readFileSync(
  new URL("../app/g2/display-frame-outcomes.ts", import.meta.url),
  "utf8",
);
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
}).outputText;
const {
  isReadinessFrameEvidenceOutcome,
  isSuccessfulFrameOutcome,
} = await import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`);

test("current-epoch no-change is readiness evidence but never a strict card delivery", () => {
  for (const outcome of ["sent", "sent directfb", "sent in 42ms"]) {
    assert.equal(isReadinessFrameEvidenceOutcome(outcome), true);
    assert.equal(isSuccessfulFrameOutcome(outcome), true);
  }

  const noChange = "discarded: no change from displayed image";
  assert.equal(isReadinessFrameEvidenceOutcome(noChange), true);
  assert.equal(isSuccessfulFrameOutcome(noChange), false,
    "a result card must still change pixels and receive its own physical send");
});

test("other discarded or approximate outcomes cannot unlock readiness", () => {
  for (const outcome of [
    null,
    "",
    "discarded: superseded by frame#9 before send",
    "discarded: glasses charging",
    "discarded: no change from displayed image later",
    "discarded: composite superseded before store",
    "receipt timeout",
  ]) {
    assert.equal(isReadinessFrameEvidenceOutcome(outcome), false, String(outcome));
    assert.equal(isSuccessfulFrameOutcome(outcome), false, String(outcome));
  }
});
