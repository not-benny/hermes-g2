# Clean-checkout release validation — 21 August 2026

Hermes G2 `main` was validated from a clean, isolated GitHub-hosted Ubuntu
runner. The run checked out the exact source commit without reusing a repository
worktree, installed locked dependencies, ran the complete host suite and
TypeScript compiler, and produced an Android debug APK with the documented
Android toolchain.

## Validated source

- Repository: `not-benny/hermes-g2`
- Ref: `main`
- Commit: `24274cfa5a076618afdb2306b880623aa4a94abe`
- GitHub Actions run: <https://github.com/not-benny/hermes-g2/actions/runs/32527230737>
- Source cleanliness: `git reset --hard`, `git clean -ffdx`, and an empty
  porcelain status before dependency installation
- Moving-target guard: `origin/main` still matched the validated commit at the
  end of the run

The first clean Node 20 attempt exposed genuine portability regressions. Those
were fixed separately in PR #17; this record covers the final post-fix `main`
commit above.

## Results

| Gate | Result |
| --- | --- |
| `npm ci` | PASS |
| `npm test` | PASS — 247 tests, 247 passed, 0 failed, 0 skipped |
| `npm run typecheck` | PASS |
| `npm run build` | PASS |
| APK ZIP integrity | PASS |
| APK private-path scan | PASS |
| `git diff --check` | PASS |

Host-test duration reported by Node's test runner was 22,072.666501 ms.

## Toolchain

- Runner image: Ubuntu 24 (`20260816.277.1`), Linux x64
- Node.js: `v20.20.2`
- npm: `10.8.2`
- Java: OpenJDK `21.0.12` LTS
- javac: `21.0.12`
- Android compile/target SDK: `35`
- Android build tools: `35.0.0`
- Android NDK: `27.2.12479018`
- CMake: `3.22.1-g37088a8`
- Ninja: `1.10.2`

## Android artefact

- Build path: `platforms/android/app/build/outputs/apk/debug/app-debug.apk`
- Size: `335,831,435` bytes
- SHA-256: `03143d502175e0f0cfce5b0022ee3263aa85bc8d48bc4cdc710133de621908f2`
- Package: `com.faceclaw.app`
- App label: `Hermes G2`
- Version: `1.0.0` (`versionCode=1`)
- Minimum SDK: `24`
- Target/compile SDK: `35`

The APK archive passed `zip -T`. Its entry names were checked for
`secrets.local`, `ground-truth-private`, `.even-jwt`, live settings XML files,
and the other prohibited private paths used by the repository's development
workflow; none were present.

The complete validation logs and APK were retained as GitHub Actions artifact
`fresh-checkout-release-gate-24274cfa5a076618afdb2306b880623aa4a94abe`
for 14 days from the run.

## Boundary of this result

This closes the roadmap's fresh-checkout release-validation item. The APK is a
debug development artefact, not a published release. This run adds no new G2 or
R1 hardware evidence and does not authorise public MCP/skill publication,
first-time provisioning, destructive ring commands, firmware recovery claims,
or standalone R1 DFU/OTA.