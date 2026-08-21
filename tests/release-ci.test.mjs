import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("durable PR and main CI enforce the release safety matrix", () => {
  assert.ok(existsSync(new URL("../.github/workflows/ci.yml", import.meta.url)));
  assert.ok(existsSync(new URL("../.github/workflows/codeql.yml", import.meta.url)));
  assert.ok(existsSync(new URL("../.github/dependabot.yml", import.meta.url)));
  const ci = read(".github/workflows/ci.yml");
  for (const gate of [
    "npm ci",
    "npm test",
    "npm run typecheck",
    "git diff --check",
    "npm audit",
    "npm sbom",
    "npm run build",
    "verify-release-artifacts.sh",
  ]) assert.match(ci, new RegExp(gate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(ci, /pull_request:/);
  assert.match(ci, /branches: \[main\]/);
  assert.match(ci, /java-version: ["']21["']/);
  assert.doesNotMatch(ci, /uses: [^\n]+@(v\d+|main|master)\b/);
  const verifier = read("scripts/verify-release-artifacts.sh");
  assert.match(verifier, /unzip -t/);
  assert.match(verifier, /"\$ZIPALIGN"[^\n]*-P 16/);
  assert.match(verifier, /llvm-readelf/);
  assert.match(verifier, /ground-truth-private/);
  assert.match(verifier, /"\$APKSIGNER" verify/);
  assert.match(verifier, /versionCode='1000001'/);
  assert.match(verifier, /private content in APK/);
  assert.doesNotMatch(verifier, /WAIVED \(feature disabled\)/);
  assert.match(ci, /pull_request\.base\.sha/);
  assert.match(ci, /npm --prefix App_Resources\/Android\/whatsapp-node audit/);
  assert.match(ci, /whatsapp-sbom\.cdx\.json/);
});

test("Android native inputs and release metadata are pinned", () => {
  const gradle = read("App_Resources/Android/app.gradle");
  const packageJson = JSON.parse(read("package.json"));
  assert.match(gradle, /ndkVersion "27\.2\.12479018"/);
  assert.match(gradle, /faceclawCmakeVersion = "3\.22\.1"/);
  assert.match(gradle, /MessageDigest\.getInstance\("SHA-256"\)/);
  assert.match(gradle, /\.part/);
  assert.match(gradle, /versionCode 1000001/);
  assert.match(gradle, /versionName "1\.0\.0-preview\.1"/);
  for (const abi of ["armeabi-v7a", "x86", "x86_64"]) {
    assert.ok(gradle.includes(`exclude "lib/${abi}/**"`));
  }
  assert.equal(packageJson.private, true);
  assert.equal(packageJson.devDependencies.nativescript, "9.0.7");
  assert.equal(packageJson.scripts.build, "npx --no-install ns build android");
});
