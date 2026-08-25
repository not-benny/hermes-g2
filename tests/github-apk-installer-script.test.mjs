import assert from "node:assert/strict";
import { accessSync, constants, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";

const scriptPath = new URL(
  "../scripts/build-sign-install-from-github.sh",
  import.meta.url,
);
const script = readFileSync(scriptPath, "utf8");

function assertBefore(earlier, later) {
  const earlierIndex = script.indexOf(earlier);
  const laterIndex = script.indexOf(later);
  assert.notEqual(
    earlierIndex,
    -1,
    `missing expected script fragment: ${earlier}`,
  );
  assert.notEqual(laterIndex, -1, `missing expected script fragment: ${later}`);
  assert.ok(earlierIndex < laterIndex, `expected ${earlier} before ${later}`);
}

test("GitHub APK installer is executable Bash with usable help", () => {
  accessSync(scriptPath, constants.X_OK);
  const syntax = spawnSync("bash", ["-n", scriptPath.pathname], {
    encoding: "utf8",
  });
  assert.equal(syntax.status, 0, syntax.stderr);

  const help = spawnSync(scriptPath.pathname, ["--help"], { encoding: "utf8" });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /--build-only, --no-install/);
  assert.match(help.stdout, /adb install -r/);
  assert.match(help.stdout, /HERMES_KEYSTORE_PASSWORD/);
});

test("installer builds the exact fetched GitHub snapshot through the unsigned release gate", () => {
  assert.match(script, /https:\/\/github\.com\/not-benny\/hermes-g2\.git/);
  assert.match(
    script,
    /DEFAULT_REF="db6098d545ba8cd20d3cc02d3db0d975afc0fdd6"/,
  );
  assert.doesNotMatch(script, /DEFAULT_REF="(?:fix|feat)\//);
  assert.match(script, /git check-ref-format --allow-onelevel "\$ref"/);
  assert.match(script, /mktemp -d .*hermes-g2-github/);
  assert.match(script, /git -C "\$source_checkout" fetch .*"\$ref"/);
  assert.match(script, /checkout --quiet --detach FETCH_HEAD/);
  assert.match(script, /resolved_commit=.*rev-parse --verify HEAD\^\{commit\}/);
  assert.match(script, /npm ci/);
  assert.match(script, /npm run verify:release-unsigned/);
  assert.match(script, /Hermes G2 builds require JDK 21/);
  assertBefore("export JAVA_HOME ANDROID_HOME", "npm ci");
  assert.match(script, /expected exactly one unsigned release APK/);
  assert.match(script, /HERMES_SIGNING_MODE=unsigned/);
  assert.match(
    script,
    /bash scripts\/verify-release-artifacts\.sh "\$unsigned_apk"/,
  );
  assertBefore("bash scripts/verify-release-artifacts.sh", '"$apksigner" sign');
  assertBefore('"$zipalign" -f', '"$apksigner" sign');
});

test("installer signs without command-line passwords and verifies identity", () => {
  assert.match(script, /set \+x/);
  assert.match(script, /set \+a/);
  assert.match(script, /unset HERMES_KEYSTORE_PASSWORD HERMES_KEY_PASSWORD/);
  assertBefore("unset HERMES_KEYSTORE_PASSWORD", "command -v");
  assert.match(script, /--ks-pass env:HERMES_APKSIGNER_STORE_PASSWORD/);
  assert.match(script, /--key-pass env:HERMES_APKSIGNER_KEY_PASSWORD/);
  assert.match(script, /--debuggable-apk-permitted false/);
  assert.doesNotMatch(
    script,
    /--ks-pass\s+(?:pass:|"?\$HERMES_KEYSTORE_PASSWORD)/,
  );
  assert.doesNotMatch(script, /--key-pass\s+(?:pass:|"?\$HERMES_KEY_PASSWORD)/);
  assert.match(script, /apksigner.*verify --verbose --print-certs/s);
  assert.match(script, /EXPECTED_PACKAGE="com\.faceclaw\.app"/);
  assert.match(script, /signed APK version does not match the fetched source/);
  assert.match(
    script,
    /APK output path must not overwrite the signing keystore/,
  );
  assert.match(script, /APK output must be a regular file path/);
  assert.match(script, /"\$output_path" -ef "\$keystore"/);
});

test("installer protects existing data, signer, and versionCode", () => {
  assert.match(script, /shell pm list packages "\$EXPECTED_PACKAGE"/);
  assert.match(script, /shell pm path "\$EXPECTED_PACKAGE"/);
  assert.match(script, /pull "\$base_path"/);
  assert.match(
    script,
    /could not determine or read the existing app; refusing an unchecked update/,
  );
  assert.match(script, /installed_certificate.*certificate_sha256/);
  assert.match(script, /installed_certificate" != "\$new_certificate/);
  assert.match(script, /10#\$new_version_code < 10#\$installed_version_code/);
  assert.match(script, /--allow-signer-mismatch/);
  assert.match(script, /--allow-downgrade/);
  assert.match(script, /install_args=\(install -r\)/);
  assert.match(script, /install_args\+=\(-d\)/);
  assert.doesNotMatch(
    script,
    /"\$\{adb_device\[@\]\}"\s+(?:uninstall|shell pm clear)/,
  );
  assert.doesNotMatch(script, /install_args=.*(?:uninstall|pm clear)/);
});
