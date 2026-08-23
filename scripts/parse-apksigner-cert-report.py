#!/usr/bin/env python3
"""Return the sole APK signer digest and subject from apksigner output."""

import re
import sys


DIGEST = re.compile(
    r"^Signer #(\d+) certificate SHA-256 digest: ([0-9a-fA-F]{64})$"
)
SUBJECT = re.compile(r"^Signer #(\d+) certificate DN: (.+)$")
SIGNER_COUNT = re.compile(r"^Number of signers: (\d+)$")
SOURCE_STAMP = re.compile(r"^Verified for SourceStamp: (true|false)$")

digests: list[tuple[int, str]] = []
subjects: list[tuple[int, str]] = []
signer_counts: list[int] = []
source_stamps: list[bool] = []
for raw_line in sys.stdin:
    line = raw_line.rstrip("\r\n")
    digest_match = DIGEST.fullmatch(line)
    if digest_match:
        digests.append((int(digest_match.group(1)), digest_match.group(2).lower()))
        continue
    subject_match = SUBJECT.fullmatch(line)
    if subject_match:
        subjects.append((int(subject_match.group(1)), subject_match.group(2)))
        continue
    signer_count_match = SIGNER_COUNT.fullmatch(line)
    if signer_count_match:
        signer_counts.append(int(signer_count_match.group(1)))
        continue
    source_stamp_match = SOURCE_STAMP.fullmatch(line)
    if source_stamp_match:
        source_stamps.append(source_stamp_match.group(1) == "true")

if (
    len(digests) != 1
    or len(subjects) != 1
    or signer_counts != [1]
    or source_stamps != [False]
    or digests[0][0] != 1
    or subjects[0][0] != 1
):
    raise SystemExit("APK must contain exactly one signing identity")

print(digests[0][1])
print(subjects[0][1])
