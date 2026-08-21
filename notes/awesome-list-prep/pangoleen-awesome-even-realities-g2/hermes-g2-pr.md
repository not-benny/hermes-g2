# Add Hermes G2 to AI and Agent Integrations

## Summary

Add **Hermes G2** to the **AI and Agent Integrations** category.

## Entry

- [Hermes G2](https://github.com/not-benny/hermes-g2) - Unofficial Android companion for Even Realities G2 glasses, built around Hermes Agent, with voice interaction, notifications, media, navigation, terminal mirroring, and R1/glasses controls.

## Checks and release gate

- The entry is not submitted yet because the canonical source URL is currently unavailable to unauthenticated readers; revalidate it after the public release is live.
- Apply this one-entry patch fail-closed to the recorded base with `git apply --index --unidiff-zero --check < hermes-g2.patch`, then `git apply --index --unidiff-zero < hermes-g2.patch`; abort on any non-zero exit (plain `git apply` is not a fallback). Run `git diff --check --cached` and `npx awesome-lint` before opening the PR.
- Confirm the entry is still absent and no competing PR exists immediately before submission.
