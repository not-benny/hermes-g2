Preparation base: `pangoleen/awesome-even-realities-g2` `main` at `9c7ae1b93fe5b201b9aa4087bb7d9e510dbb0e03` (read-only GitHub snapshot fetched 2026-08-21).

Each patch is intentionally one suggestion, matching `contributing.md` one-PR-per-suggestion guidance. The target README had neither proposed entry when prepared.

The stored hunks intentionally omit a trailing blank context line. Apply them
fail-closed to this exact base with the following workflow (do not fall back to
plain `git apply`):

```sh
git checkout --detach 9c7ae1b93fe5b201b9aa4087bb7d9e510dbb0e03
git apply --index --unidiff-zero --check <path-to-patch>
git apply --index --unidiff-zero <path-to-patch>
git diff --check --cached
```

Abort on any non-zero exit, and confirm the staged README diff contains only
the single intended entry before preparing the PR.
