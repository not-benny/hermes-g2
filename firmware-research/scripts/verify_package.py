#!/usr/bin/env python3
"""Fail-closed verifier for the Even G2 2.2.8.4 port package."""

from __future__ import annotations

import argparse
import hashlib
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
STOCK = ROOT / "firmware/g2_2.2.8.4_stock.bin"
REVIEWED = ROOT / "firmware/g2_2.2.8.4_cfw_FIXED.bin"
PATCHER = ROOT / "sources/patch_compress.py"


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def rebuild_and_compare() -> None:
    required = [STOCK, REVIEWED, PATCHER, ROOT / "sources/build.py",
                ROOT / "sources/apply_patches.py", ROOT / "sources/patches_main.c"]
    missing = [str(path.relative_to(ROOT)) for path in required if not path.is_file()]
    if missing:
        raise SystemExit(f"missing required build inputs: {', '.join(missing)}")

    with tempfile.TemporaryDirectory(prefix="even-g2-verify-") as tmp:
        output = Path(tmp) / "rebuilt.bin"
        result = subprocess.run(
            [sys.executable, str(PATCHER), str(STOCK), str(output)],
            cwd=ROOT,
            text=True,
            capture_output=True,
        )
        if result.returncode:
            sys.stdout.write(result.stdout)
            sys.stderr.write(result.stderr)
            raise SystemExit(result.returncode)
        got = sha256(output)
        expected = sha256(REVIEWED)
        if got != expected or output.read_bytes() != REVIEWED.read_bytes():
            raise SystemExit(
                "rebuild mismatch\n"
                f"expected {expected}\n"
                f"got      {got}"
            )
        print(f"REBUILD MATCH {got}")


def verify_checksum_manifest(path: Path) -> None:
    for line_number, raw in enumerate(path.read_text().splitlines(), 1):
        line = raw.strip()
        if not line:
            continue
        try:
            expected, relative = line.split(None, 1)
        except ValueError as exc:
            raise SystemExit(f"{path.name}:{line_number}: malformed checksum line") from exc
        target = ROOT / relative.strip()
        if not target.is_file():
            raise SystemExit(f"{path.name}:{line_number}: missing {relative.strip()}")
        got = sha256(target)
        if got != expected:
            raise SystemExit(
                f"{path.name}:{line_number}: checksum mismatch for {relative.strip()}\n"
                f"expected {expected}\n"
                f"got      {got}"
            )
    print(f"CHECKSUMS OK {path.relative_to(ROOT)}")


def run_fixed_binary_verifier() -> None:
    result = subprocess.run(
        [sys.executable, str(ROOT / "scripts/verify_fixed_binary.py")],
        cwd=ROOT,
        text=True,
        capture_output=True,
    )
    sys.stdout.write(result.stdout)
    sys.stderr.write(result.stderr)
    if result.returncode:
        raise SystemExit(result.returncode)


def run_source_generator() -> None:
    with tempfile.TemporaryDirectory(prefix="even-g2-source-gen-") as tmp:
        result = subprocess.run(
            [
                sys.executable,
                str(ROOT / "scripts/gen_8.4_sources.py"),
                "--map",
                str(ROOT / "relocation/PORT-MAP-8.4.json"),
                "--output-dir",
                tmp,
            ],
            cwd=ROOT,
            text=True,
            capture_output=True,
        )
        if result.returncode:
            sys.stdout.write(result.stdout)
            sys.stderr.write(result.stderr)
            raise SystemExit(result.returncode)
        expected = {
            "settings_ext.c",
            "zlib_glue.c",
            "gesture_fwd.c",
            "patch_compress.py",
            "patches_main.c",
        }
        missing = sorted(name for name in expected if not (Path(tmp) / "patches" / name).is_file())
        if missing:
            raise SystemExit(f"source generator omitted: {', '.join(missing)}")
    print("SOURCE GENERATION OK")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--rebuild-only", action="store_true",
                        help="only rebuild and byte-compare the reviewed artifact")
    args = parser.parse_args()
    rebuild_and_compare()
    if args.rebuild_only:
        return
    verify_checksum_manifest(ROOT / "firmware/SHA256SUMS")
    verify_checksum_manifest(ROOT / "MANIFEST-SHA256SUMS")
    run_fixed_binary_verifier()
    run_source_generator()
    print("PACKAGE VERIFIED")


if __name__ == "__main__":
    main()
