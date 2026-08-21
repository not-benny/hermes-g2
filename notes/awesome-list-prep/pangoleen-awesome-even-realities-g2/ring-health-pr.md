# Add Hermes G2 Ring Health to Protocol and Reverse Engineering

## Summary

Add **Hermes G2 Ring Health** to the **Protocol and Reverse Engineering** category.

## Entry

- [Hermes G2 Ring Health](https://github.com/not-benny/hermes-g2/tree/main/docs/ring-health) - Reverse-engineered R1 ring-health BLE protocol documentation with capture methods and a self-testing frame decoder.

## Checks and release gate

- The entry is not submitted yet because the canonical source URL is currently unavailable to unauthenticated readers; revalidate it after the public release is live.
- Apply this one-entry patch fail-closed to the recorded base with `git apply --index --unidiff-zero --check < ring-health.patch`, then `git apply --index --unidiff-zero < ring-health.patch`; abort on any non-zero exit (plain `git apply` is not a fallback). Run `git diff --check --cached` and `npx awesome-lint` before opening the PR.
- Confirm the entry is still absent and no competing PR exists immediately before submission.
