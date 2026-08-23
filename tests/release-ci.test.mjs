import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("bundle analyzer server supports the patched ws 8 override", async () => {
  const analyzerRequire = createRequire(
    new URL("../node_modules/webpack-bundle-analyzer/package.json", import.meta.url),
  );
  assert.equal(analyzerRequire("ws/package.json").version, "8.21.3");
  const { startServer } = analyzerRequire("webpack-bundle-analyzer/lib/viewer");
  const bundleStats = {
    assets: [{ name: "bundle.js", size: 1, chunks: [0] }],
    chunks: [{ id: 0, names: ["main"], files: ["bundle.js"] }],
    modules: [{ id: 0, name: "./x.js", identifier: "./x.js", size: 1, chunks: [0] }],
    entrypoints: { main: { chunks: [0], assets: [{ name: "bundle.js" }] } },
  };
  const logger = { info() {}, warn() {}, error() {}, debug() {} };
  const server = await startServer(bundleStats, {
    port: 0,
    host: "127.0.0.1",
    openBrowser: false,
    logger,
    analyzerUrl: ({ boundAddress }) => `http://127.0.0.1:${boundAddress.port}`,
  });
  const port = server.http.address().port;
  assert.ok(port > 0);
  const WebSocket = analyzerRequire("ws");
  const client = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise((resolve, reject) => {
    client.once("open", resolve);
    client.once("error", reject);
  });
  client.close();
  await new Promise((resolve) => client.once("close", resolve));
  await new Promise((resolve) => server.ws.close(resolve));
  await new Promise((resolve) => server.http.close(resolve));
});

test("untrusted pull requests cannot publish an APK as release evidence", () => {
  const ci = read(".github/workflows/ci.yml");
  assert.doesNotMatch(ci, /\$\{\{ secrets\./);
  assert.doesNotMatch(ci, /Upload protected release evidence/);
  assert.match(ci, /HERMES_SIGNING_MODE: untrusted/);
  assert.match(ci, /HERMES_ARTIFACT_VARIANT: debug/);
  assert.match(ci, /npm run verify:release-unsigned/);
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
  assert.match(signingJob, /if: vars\.PROTECTED_RELEASE_ENABLED == 'true'/);
  assert.match(signingJob, /name: protected-release/);
  assert.match(signingJob, /actions\/download-artifact@/);
  assert.match(signingJob, /\/usr\/local\/lib\/android\/sdk\/build-tools\/35\.0\.1\/apksigner/);
  assert.match(signingJob, /ANDROID_SIGNING_KEYSTORE_BASE64/);
  assert.doesNotMatch(signingJob, /actions\/checkout@|npm |gradlew|scripts\//);
  assert.match(release, /HERMES_SIGNING_MODE: unsigned/);
  assert.match(release, /HERMES_ARTIFACT_VARIANT: release/);
  assert.match(release, /npm run verify:release-unsigned/);
  assert.match(release, /app-release-unsigned\.apk/);
  assert.match(release, /name: Upload protected release evidence[\s\S]*hermes-g2-release\.apk/);
  assert.doesNotMatch(signingJob, /app-debug\.apk/);
  assert.match(signingJob, /verify_release_surface/);
  assert.match(signingJob, /verify_unsigned_container/);
  assert.match(signingJob, /pre-central-directory signing material/);
  assert.match(signingJob, /META-INF\/MANIFEST\.MF/);
  assert.match(signingJob, /--debuggable-apk-permitted false/);
  assert.match(signingJob, /FaceclawDebugControlReceiver/);
  assert.match(signingJob, /DEBUG_CONTROL_V1/);
  assert.match(signingJob, /HERMES_DEBUG_CONTROL_RUNTIME_V1/);
  assert.match(signingJob, /voice\.fixture/);
  assert.match(signingJob, /capture-offline/);

  const verifier = read("scripts/verify-release-artifacts.sh");
  assert.match(verifier, /HERMES_SIGNING_MODE/);
  assert.match(verifier, /untrusted/);
  assert.match(verifier, /unsigned/);
  assert.match(verifier, /HERMES_ARTIFACT_VARIANT/);
  assert.match(verifier, /FaceclawDebugControlReceiver/);
  assert.match(verifier, /DEBUG_CONTROL_V1/);
  assert.match(verifier, /HERMES_DEBUG_CONTROL_RUNTIME_V1/);
  assert.match(verifier, /DebugControlHarness/);
  assert.match(verifier, /pre-central-directory signing material/);
  assert.match(verifier, /META-INF\/MANIFEST\.MF/);
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
    "npm run verify:release-unsigned",
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
  assert.match(verifier, /versionCode='1000002'/);
  assert.match(verifier, /private content in APK/);
  assert.match(verifier, /EXPECTED_CERT_SHA256/);
  assert.match(verifier, /unexpected native or WhatsApp artifact inventory/);
  assert.doesNotMatch(verifier, /WAIVED \(feature disabled\)/);
  assert.match(ci, /pull_request\.base\.sha/);
  assert.match(ci, /\n          npm audit --audit-level=high/);
  assert.doesNotMatch(ci, /\n          npm audit --omit=dev/);
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
  assert.match(gradle, /versionCode 1000002/);
  assert.match(gradle, /versionName "1\.0\.0-preview\.2"/);
  for (const abi of ["armeabi-v7a", "x86", "x86_64"]) {
    assert.ok(gradle.includes(`exclude "lib/${abi}/**"`));
  }
  assert.equal(packageJson.private, true);
  assert.equal(packageJson.devDependencies.nativescript, "9.0.7");
  assert.equal(packageJson.overrides["fork-ts-checker-webpack-plugin"].minimatch, "3.1.5");
  assert.equal(packageJson.overrides.replace.minimatch, "3.1.5");
  assert.equal(typeof packageJson.overrides.minimatch, "undefined");
  assert.equal(packageJson.overrides.ws, "8.21.3");
  assert.equal(packageJson.scripts.build, "npx --no-install ns build android");
});
