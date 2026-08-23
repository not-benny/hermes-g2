import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("privacy policy names the bounded companion flow and excluded private material", () => {
  const privacy = readFileSync(new URL("../PRIVACY", import.meta.url), "utf8");
  assert.match(privacy, /Hermes mobile companion[\s\S]*same authenticated WSS connection/);
  assert.match(privacy, /exclude credentials, prompts, transcripts, raw tool/);
  assert.match(privacy, /does not[\s\S]*add a second phone-facing administration service/);
});
