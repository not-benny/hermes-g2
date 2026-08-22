import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("untrusted pull requests cannot publish an APK as release evidence", () => {
  const ci = read(".github/workflows/ci.yml");
  assert.doesNotMatch(ci, /\$\{\{ secrets\./);
  assert.doesNotMatch(ci, /Upload protected release evidence/);
  assert.match(ci, /HERMES_SIGNING_MODE: untrusted/);
  assert.match(ci, /ANDROID_USER_HOME=%s[^\n]*RUNNER_TEMP[^\n]*hermes-untrusted-android/);
  assert.match(ci, /name: release-gate/);
  const untrustedUpload = ci.match(
    /name: Upload untrusted validation evidence([\s\S]*?)(?=\n\s+- name:|$)/,
  )?.[1] ?? "";
  assert.match(untrustedUpload, /sbom\.cdx\.json/);
  assert.doesNotMatch(untrustedUpload, /\.apk/);
  assert.doesNotMatch(ci, /pull_request_target:/);

  const release = read(".github/workflows/release.yml");
  assert.doesNotMatch(release, /pull_request:/);
  assert.match(release, /push:\n\s+branches: \[main\]/);
  assert.match(release, /ANDROID_USER_HOME=%s[^\n]*RUNNER_TEMP[^\n]*hermes-untrusted-android/);
  const signingJob = release.match(/\n  sign:\n([\s\S]*)/)?.[1] ?? "";
  assert.match(signingJob, /needs: build/);
  assert.match(signingJob, /name: protected-release/);
  assert.match(signingJob, /actions\/download-artifact@/);
  assert.match(signingJob, /\/usr\/local\/lib\/android\/sdk\/build-tools\/35\.0\.1\/apksigner/);
  assert.match(signingJob, /ANDROID_SIGNING_KEYSTORE_BASE64/);
  assert.doesNotMatch(signingJob, /actions\/checkout@|npm |gradlew|scripts\//);
  assert.match(release, /name: Upload protected release evidence[\s\S]*app-debug\.apk/);

  const verifier = read("scripts/verify-release-artifacts.sh");
  assert.match(verifier, /HERMES_SIGNING_MODE/);
  assert.match(verifier, /untrusted/);
  assert.match(verifier, /must not use the protected signing certificate/);
});

test("durable PR and main CI enforce the release safety matrix", () => {
  assert.ok(existsSync(new URL("../.github/workflows/ci.yml", import.meta.url)));
  assert.ok(existsSync(new URL("../.github/workflows/release.yml", import.meta.url)));
  assert.ok(existsSync(new URL("../.github/workflows/codeql.yml", import.meta.url)));
  assert.ok(existsSync(new URL("../.github/dependabot.yml", import.meta.url)));
  const ci = read(".github/workflows/ci.yml");
  const release = read(".github/workflows/release.yml");
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
  assert.match(verifier, /EXPECTED_CERT_SHA256/);
  assert.match(verifier, /unexpected native or WhatsApp artifact inventory/);
  assert.doesNotMatch(verifier, /WAIVED \(feature disabled\)/);
  assert.match(ci, /pull_request\.base\.sha/);
  assert.match(ci, /npm --prefix App_Resources\/Android\/whatsapp-node audit/);
  assert.match(ci, /whatsapp-sbom\.cdx\.json/);
  assert.match(release, /ANDROID_SIGNING_KEYSTORE_BASE64/);
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
