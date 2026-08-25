import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("the repository has one current-state authority and one active milestone", () => {
  const readme = read("README.md");
  const status = read("STATUS.md");
  const roadmap = read("ROADMAP.md");

  assert.equal(existsSync(new URL("../HANDOVER.md", import.meta.url)), false);
  assert.match(readme, /\[`STATUS\.md`\]\(STATUS\.md\)/);
  assert.match(status, /only document that defines the project's current product and\s+operational state/i);
  assert.match(status, /owner-only internal preview/i);
  assert.match(status, /reviewed owner custom firmware/i);
  assert.match(status, /Issue #59/i);
  assert.match(status, /PROTECTED_RELEASE_ENABLED.*false/s);

  assert.equal((roadmap.match(/^### /gm) ?? []).length, 1);
  assert.match(roadmap, /^### v1\.0\.0-preview\.3 - Owner Hermes Loop$/m);
  assert.match(roadmap, /Issue #59.*sole tracker/s);
  assert.match(roadmap, /two-stage\s+authorization gate/i);
  assert.match(roadmap, /explicit owner approval for microphone, optional R1\s+health, and evidence capture/i);
  assert.doesNotMatch(roadmap, /Ultra completion|candidate verification|508\/508/);
});

test("Preview 3 Android identity is consistent across source and verification", () => {
  const gradle = read("App_Resources/Android/app.gradle");
  const verifier = read("scripts/verify-release-artifacts.sh");
  const releaseContract = read("docs/release-security.md");

  for (const source of [gradle, verifier, releaseContract]) {
    assert.match(source, /1000003/);
    assert.match(source, /1\.0\.0-preview\.3/);
    assert.doesNotMatch(source, /1000002|1\.0\.0-preview\.2/);
  }
});
