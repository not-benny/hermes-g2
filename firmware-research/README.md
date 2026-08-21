# G2 custom firmware research: 2.2.8.4 port

This directory preserves the source-only research used to port the
[g2flash](https://github.com/jimrandomh/g2flash) custom firmware from its
2.2.6.10 target to Even Realities G2 firmware 2.2.8.4.

It includes relocation evidence, patch sources, build and verification scripts,
manifest hashes, upstream attribution, and historical independent reviews. It
does **not** include proprietary stock or derived firmware images.

## Current status

The owner has reported flashing the 2.2.8.4 candidate on one G2 unit and observing
it boot and run. That is useful owner-unit evidence, but it is not a broad safety
or compatibility result.

Still unproven:

- recovery after an interrupted or failed write
- behaviour on other hardware units or firmware revisions
- reproducibility across toolchains and stock-image sources
- long-term stability and complete feature compatibility
- warranty or vendor-support implications

The historical `REPORT.md` records the static review state at the time it was
written. Read it as an evidence snapshot, not as a current blanket GO or NO-GO.
Where it conflicts with this README, the current position is:

> One owner-unit boot has been observed; flashing remains high risk, unsupported,
> recovery-unvalidated, and entirely at the operator's risk.

## Firmware images are not included

Even Realities firmware binaries are proprietary and are not redistributed.
Like upstream g2flash, this repository contains source patches and verification
material only. A local operator must obtain the exact compatible stock image
lawfully and verify every expected hash before any build or comparison.

Do not commit or publish stock images, derived images, device identifiers, private
captures, or local build outputs.

## Directory contents

- `UPSTREAM-G2FLASH-COMMIT` — exact upstream revision used for the port
- `sources/` — vendored upstream source, licences, and 2.2.8.4 patch source
- `relocation/` — address mapping and relocation evidence
- `scripts/` — offline build, relocation, and verification helpers
- `peer-review/` — historical independent review material and citation ledger
- `MANIFEST-SHA256SUMS` — expected source/research artefact hashes
- `requirements-verification.txt` — pinned verification-tool requirements
- `REPORT.md` — historical static assessment and open risks

## Safe use boundary

Before considering a flash:

1. Confirm the exact G2 model and stock firmware revision.
2. Verify the lawful stock image and every pinned hash.
3. Build in an isolated environment and run all offline verification scripts.
4. Read the current app warning, this README, and the historical report in full.
5. Ensure both lenses are powered, nearby, and released by the official Even app.
6. Accept that the recovery path is not independently validated and permanent
   device loss is possible.

Do not extrapolate this research to the R1 ring. The R1 uses a different secure
DFU model and Hermes deliberately does not implement standalone R1 firmware
updates.

## Licence and credit

The port builds directly on GPL-3.0 g2flash by James Babcock. The exact upstream
commit and licence are retained in this directory. Additional relocation and
protocol context draws on evenRealities-openCFW and the broader G2 community.
Hermes G2 and these source modifications remain GPL-3.0.