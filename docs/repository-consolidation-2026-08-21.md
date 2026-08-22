# Repository consolidation — 21 August 2026

## Why this was necessary

Hermes G2 contained two unrelated Git histories:

1. the original `main` release line, containing the public release material,
   maintained R1 entry documentation, source-only G2 firmware research, and the
   first user-facing feature batches; and
2. the later `hermes-g2`/integration line, containing the reviewed BLE lifecycle,
   R1 health, persistence, assistant/MCP, rendering, safety, and documentation
   work.

GitHub could not compare or merge those lines normally because they had no common
ancestor. Numerous task branches and two old pull requests remained open after
later successor work had already superseded them.

## Consolidation strategy

The histories were joined with an explicit multi-parent commit rather than a
force-push, branch reset, or synthetic replacement history.

The final tree deliberately uses:

- the reviewed `cleanup/main-consolidation-2026-08-21` application and test tree;
- current rewritten root documentation;
- the original line's maintained `docs/ring-health/` entry point, updated to the
  current protocol and privacy rules;
- the original source-only `firmware-research/` archive, with a current risk and
  status README; and
- no proprietary firmware, raw health data, captures, credentials, identifiers,
  generated settings, or build artefacts.

Where histories disagreed, the newer reviewed implementation was selected. Older
heads are retained as merge ancestry so their commits are not lost, but their
stale snapshots do not overwrite the final tree.

## Remaining pull requests

### PR #1 — stale-day activity regression coverage

The branch added fixed-clock activity tests and explicit stale/future-day
rejection coverage. The final integration tree already contains deterministic
current-day fixtures and fail-closed stale/future rejection. The PR head is
included as consolidation ancestry, while the newer compatible tests and current
handover documentation remain in the final tree.

### PR #10 — R1 firmware consent gate

The consent-gate file in the PR and the integration tree is byte-identical. The
integration tree also contains a newer firmware feasibility document and later
recovery/provenance analysis. The PR head is included as consolidation ancestry,
while the newer canonical documents remain in the final tree.

## Superseded divergent attempt

`fix/glasses-connect-startup-race` contained an early approach that suppressed the
first disconnected callback through a bridge-level gate. Later work fixed the
same observed race through communicator ownership and teardown-state semantics,
retained the duplicate-communicator guard, added focused lifecycle coverage, and
was hardware-verified on both G2 arms. The abandoned head is retained as ancestry;
the later implementation remains in the final tree.

## Branch classification

The following heads were already ancestors of the reviewed consolidation line
and therefore contained no unmerged work:

- `docs/t_6f8fc2b8-mcp-glasses-threat-model-r2`
- `feature/persistent-health-mcp-t_3e9c4645`
- `fix/live-glasses-session`
- `hermes-g2`
- `integration/t_30a956f8`
- `work/t_2c2d05f9-inprocess-tools-rework`
- `work/t_535a9f1f-ring-worker-rework`
- `wt/t_b1ae261c`
- `wt/t_f56ee8c2`
- `wt/t_2aa76f3a-clean`
- `wt/t_5e85b756`
- `wt/t_273bc0ae`

The following divergent heads are explicitly included as additional merge
parents:

- `test/activity-stale-day-gate` (PR #1)
- `fix/eca54400-pr5-clean-scope` (PR #10)
- `fix/glasses-connect-startup-race` (superseded attempt)

The original `main` line is the first parent, preserving normal default-branch
continuity. The reviewed consolidation line is an additional parent and supplies
the canonical application snapshot.

After the consolidation commit is merged and each branch is verified reachable
from `main`, obsolete remote branches can be deleted without losing commits.

## Validation boundary

The selected application snapshot previously reported:

- 248/248 host tests passing;
- TypeScript typechecking passing;
- Android build passing with JDK 21 and Android SDK 35; and
- real-device confirmation of two-arm G2 connection, acknowledged frame delivery,
  phone Connected state, and wearer input reaching the shell after the final
  startup-race fix.

The repository consolidation changes history, maintained documentation, and
restored source-only research. It does not replace the reviewed application
source with an untested old branch. A fresh-checkout full validation remains the
release gate for any new APK or public development-preview release.