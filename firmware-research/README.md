# G2 custom firmware research: porting g2flash to 2.2.8.4

This folder documents porting the [g2flash](https://github.com/jimrandomh/g2flash)
custom firmware for the Even Realities G2 from the 2.2.6.10 base it targets to the
newer 2.2.8.4 firmware, plus the static verification of the resulting candidate.

It builds directly on g2flash by James Babcock. The exact upstream commit that was
reviewed and vendored is recorded in `UPSTREAM-G2FLASH-COMMIT`, and the g2flash
license is preserved at `sources/G2FLASH-LICENSE`. This work is GPL-3.0, the same
as g2flash.

## Do not flash

The 2.2.8.4 candidate is reproducible and passes the static checks in `REPORT.md`,
but it has **never booted on hardware**. Thread and ISR legality, RTOS behavior,
display handoff, OTA acceptance, both-lens behavior, and the recovery path are all
unverified. Custom firmware can void the warranty and brick the glasses. Treat this
as research, not a release. Read `REPORT.md` in full before doing anything.

## Firmware images are not included

The actual firmware `.bin` files (stock and derived) are Even Realities'
proprietary firmware and are not redistributed here. Like g2flash, this ships the
patch sources and the build and verification scripts, not firmware images. To
reproduce, download the stock image yourself and apply the patches. The report
records the SHA-256 of each artifact so a local build can be checked against it.

## Contents

- `REPORT.md` is the verification report: artifact status, what changed, the static
  checks, and the open risks.
- `relocation/` is the heart of the port: the address mapping from 2.2.6.10 to
  2.2.8.4 (`RELOC-6.10-to-8.4.md`, `PORT-MAP-8.4.json`) and the match results.
- `sources/` is the CFW patch source vendored from g2flash plus the 2.2.8.4 ports
  (`patches_main.c`, `gesture_fwd.c`, `settings_ext.c`, `zlib_glue.c`, the build and
  apply scripts, and the `original-6.10/` reference).
- `scripts/` are the relocation and verification helpers used to build and check the
  candidate.
- `peer-review/` holds independent reviews of the build and their citation ledger.
- `MANIFEST-SHA256SUMS` and `requirements-verification.txt` pin the expected hashes
  and the toolchain.

## Sources and credit

- g2flash: https://github.com/jimrandomh/g2flash (upstream, GPL-3.0)
- evenRealities-openCFW: https://github.com/kalanihelekunihi/evenRealities-openCFW
  and the broader G2 firmware community for protocol and firmware documentation.
