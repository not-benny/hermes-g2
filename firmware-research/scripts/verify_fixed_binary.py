#!/usr/bin/env python3
"""Verify the fixed 8.4 image's exact hooks, confinement, and CRCs."""

from __future__ import annotations

import argparse
import importlib.util
import struct
import sys
import zlib
from pathlib import Path

from capstone import CS_ARCH_ARM, CS_MODE_THUMB, Cs
from capstone.arm import ARM_OP_IMM

ROOT = Path(__file__).resolve().parents[1]
STOCK = ROOT / "firmware/g2_2.2.8.4_stock.bin"
FIXED = ROOT / "firmware/g2_2.2.8.4_cfw_FIXED.bin"
PATCHER_PATH = ROOT / "sources/patch_compress.py"


def require(condition: bool, message: str) -> None:
    if not condition:
        raise SystemExit(f"verification failed: {message}")


def load_patcher():
    spec = importlib.util.spec_from_file_location("patch_compress_verify", PATCHER_PATH)
    if spec is None or spec.loader is None:
        raise SystemExit("cannot load patcher")
    module = importlib.util.module_from_spec(spec)
    sys.path.insert(0, str(PATCHER_PATH.parent))
    spec.loader.exec_module(module)
    return module


def decode_target(image: bytes, patcher, va: int) -> int:
    md = Cs(CS_ARCH_ARM, CS_MODE_THUMB)
    md.detail = True
    insns = list(md.disasm(image[patcher.g2f(va):patcher.g2f(va) + 4], va, 1))
    if len(insns) != 1 or insns[0].mnemonic not in {"bl", "b.w"}:
        raise AssertionError(f"{va:#x}: expected BL/B.W, got {insns}")
    op = insns[0].operands[0]
    if op.type != ARM_OP_IMM:
        raise AssertionError(f"{va:#x}: branch target is not immediate")
    return op.imm


def verify_crcs(image: bytes, patcher) -> None:
    count = struct.unpack_from("<I", image, 8)[0]
    for i in range(count):
        _, off, size, stored = struct.unpack_from("<IIII", image, 0x40 + i * 16)
        payload_size = struct.unpack_from("<I", image, off + 8)[0]
        require(size == payload_size + 128, f"component {i} size mismatch")
        sub_stored = struct.unpack_from("<I", image, off + 12)[0]
        actual = patcher.crc32c_msb(image[off + 128:off + 128 + payload_size])
        require(stored == sub_stored == actual, f"component {i} CRC32C mismatch")
        name = image[off + 48:off + 128].split(b"\0", 1)[0]
        if name.endswith(b"s200_firmware_ota.bin"):
            preamble = struct.unpack_from("<I", image, off + 132)[0]
            expected = zlib.crc32(image[off + 136:off + 128 + payload_size]) & 0xFFFFFFFF
            require(preamble == expected, "main-app preamble CRC mismatch")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.parse_args()
    patcher = load_patcher()
    stock = STOCK.read_bytes()
    fixed = FIXED.read_bytes()

    generated, ops = patcher.build_patch_ops(stock)
    require(generated == fixed, "cross-compiled image differs from reviewed FIXED artifact")

    allowed = set()
    for op in ops:
        start = op["offset"]
        allowed.update(range(start, start + len(bytes.fromhex(op["new"]))))
    prefix = min(len(stock), len(fixed))
    changed = {i for i in range(prefix) if stock[i] != fixed[i]}
    require(changed <= allowed, f"{len(changed - allowed)} changed prefix bytes outside patch ops")
    append_ops = [op for op in ops if op.get("old", "") == ""]
    require(
        len(append_ops) == 1 and append_ops[0]["offset"] == len(stock),
        "expected exactly one append operation at the stock image end",
    )

    _, comp_off, old_ps = patcher.find_mainapp(stock)
    blob_off = patcher.align_up(old_ps, patcher.BLOB_ALIGN)
    base = patcher.mram_addr(blob_off)
    built = patcher.build_blob("patches_main.c")
    offsets = {f["name"]: f["offset"] for f in built["functions"]}
    expected = {}
    expected.update({site: "snapshot_side" for site in patcher.SNAPSHOT_BL_SITES})
    expected[patcher.LOADBMP_BL_SITE[0]] = "image_deferred"
    expected[patcher.SETTINGS_BL_SITE[0]] = "settings_send_wrapper"
    expected[patcher.SETTINGS_DECODE_BL_SITE[0]] = "settings_decode_wrapper"
    expected.update({site: "faceclaw_display_start" for site in patcher.DISPLAY_START_BL_SITES})
    expected[patcher.GESTURE_LONGPRESS_SITE[0]] = "evenhub_longpress"
    expected[patcher.GESTURE_RELEASE_SITE[0]] = "ring_release"
    expected[patcher.EVENAI_ENTRY_SITE[0]] = "faceclaw_evenai_display_entry"
    expected.update({site: "display_copy_hook" for site in patcher.DISPLAY_COPY_BL_SITES})
    expected.update({site: "faceclaw_send_wear_event" for site in patcher.WEAR_NOTIFY_BL_SITES})
    expected[patcher.COMPASS_EVENT_BL_SITE[0]] = "compass_event_forward"
    expected.update({site: "cfw_container_create" for site in patcher.CONTAINER_CREATE_BL_SITES})
    expected[patcher.CONTAINER_DESTROY_BL_SITE[0]] = "cfw_container_destroy"
    for site, name in expected.items():
        got = decode_target(fixed, patcher, site)
        want = base + offsets[name]
        require(got == want, f"{site:#x}: {got:#x} != {name} {want:#x}")
        require(base <= got < base + built["text_len"], f"{site:#x}: target outside injected text")

    # The command-ID 1 acknowledgement stays stock by design.
    ack = patcher.g2f(0x49D184)
    require(fixed[ack:ack + 4] == stock[ack:ack + 4], "command-ID 1 acknowledgement was modified")
    verify_crcs(fixed, patcher)
    print(
        f"FIXED BINARY VERIFIED: {len(expected)} exact branch targets, "
        f"{len(changed)} confined prefix bytes, blob {built['text_len']} B, CRCs valid"
    )


if __name__ == "__main__":
    main()
