#!/usr/bin/env python3
"""Inspect or construct sanitized Even R1 Ring1 binary-channel frames.

This utility is intentionally limited to offline frame work. It does not scan,
connect, pair, provision, flash, reset, wipe, or send anything to a device.

Examples:
    python3 ring-frame-decoder.py self-test
    python3 ring-frame-decoder.py decode 00971953f964016401000000080d003f0101
    python3 ring-frame-decoder.py build --module 2 --cmd 1 --sub-cmd 1 --status 0 --sequence 1
"""

from __future__ import annotations

import argparse
import struct
import sys
from dataclasses import dataclass
from typing import Iterable

CRC32_POLY = 0x1EDC6F41
FRAME_MARKER = 0x64

MODULES = {1: "system", 2: "health", 3: "sport"}
STATUS = {0: "request", 1: "set", 2: "push", 3: "ack"}
HEALTH_COMMANDS = {
    1: "heartRate",
    2: "spo2",
    3: "temperature",
    4: "hrv",
    5: "activity",
    6: "sleep",
}
SYSTEM_SUBCOMMANDS = {
    0x01: "deviceStatus",
    0x02: "deviceInfo",
    0x03: "wearStatus",
    0x04: "userInfo",
    0x05: "systemTime",
    0x08: "pairAuth",
    0x09: "otaStart",
    0x0A: "advStart",
    0x0B: "getAlgoKeyStatus",
    0x0C: "setAlgoKey",
    0x0E: "healthSettingsStatus",
    0x0F: "systemSettingsStatus",
    0x11: "nvRecover",
    0x12: "powerControl",
    0x13: "pairDelete",
    0x7E: "packetAck",
    0x7F: "heartbeatPack",
}

# These command families are deliberately blocked by Hermes. Listing them here
# helps an offline decoder flag risk; this script never transmits frames.
BLOCKED_SYSTEM_SUBCOMMANDS = {
    0x09,  # otaStart
    0x0A,  # advStart / host identity
    0x0C,  # setAlgoKey
    0x11,  # nvRecover
    0x12,  # powerControl
    0x13,  # pairDelete
}


def _crc32_table() -> tuple[int, ...]:
    table: list[int] = []
    for index in range(256):
        value = index << 24
        for _ in range(8):
            value = ((value << 1) ^ CRC32_POLY) if value & 0x80000000 else value << 1
            value &= 0xFFFFFFFF
        table.append(value)
    return tuple(table)


CRC32_TABLE = _crc32_table()


def ring_crc32(data: bytes) -> int:
    """Even/R1 CRC-32C variant: MSB-first, init 0, no xorout."""
    crc = 0
    for byte in data:
        crc = ((crc << 8) & 0xFFFFFFFF) ^ CRC32_TABLE[((crc >> 24) ^ byte) & 0xFF]
    return crc & 0xFFFFFFFF


def crc16_modbus(data: bytes, *, zero_inner_crc_slot: bool = False) -> int:
    """Incoming rich-frame CRC-16/MODBUS, init 0xffff."""
    crc = 0xFFFF
    for index, byte in enumerate(data):
        if zero_inner_crc_slot and index in (10, 11):
            byte = 0
        crc ^= byte
        for _ in range(8):
            crc = (crc >> 1) ^ 0xA001 if crc & 1 else crc >> 1
    return crc & 0xFFFF


def crc16_ccitt_false(data: bytes, *, zero_inner_crc_slot: bool = False) -> int:
    """Legacy outbound CCITT-FALSE helper, init 0xffff, poly 0x1021."""
    crc = 0xFFFF
    for index, byte in enumerate(data):
        if zero_inner_crc_slot and index in (10, 11):
            byte = 0
        crc ^= byte << 8
        for _ in range(8):
            crc = ((crc << 1) ^ 0x1021) & 0xFFFF if crc & 0x8000 else (crc << 1) & 0xFFFF
    return crc


@dataclass(frozen=True)
class DecodedFrame:
    fragment_index: int
    stored_outer_crc: int
    calculated_outer_crc: int
    module: int
    marker: int
    sequence: int
    status: int
    command: int
    subcommand: int
    declared_length: int
    actual_inner_length: int
    stored_inner_crc: int
    calculated_modbus_crc: int
    calculated_ccitt_crc: int
    data: bytes

    @property
    def outer_crc_ok(self) -> bool:
        return self.stored_outer_crc == self.calculated_outer_crc

    @property
    def length_ok(self) -> bool:
        return self.declared_length == self.actual_inner_length

    @property
    def marker_ok(self) -> bool:
        return self.marker == FRAME_MARKER

    @property
    def inner_crc_kind(self) -> str:
        if self.stored_inner_crc == self.calculated_modbus_crc:
            return "MODBUS"
        if self.stored_inner_crc == self.calculated_ccitt_crc:
            return "CCITT-FALSE"
        if self.stored_inner_crc == 0:
            return "zero/unset"
        return "unrecognised"


def decode_frame(frame: bytes) -> DecodedFrame:
    """Decode one complete single-fragment envelope."""
    if len(frame) < 17:
        raise ValueError(f"frame too short: {len(frame)} bytes; need at least 17")
    fragment_index = frame[0]
    stored_outer_crc = struct.unpack_from("<I", frame, 1)[0]
    inner = frame[5:]
    if len(inner) < 12:
        raise ValueError("inner frame is shorter than its 12-byte header")

    declared_length = struct.unpack_from("<H", inner, 8)[0]
    stored_inner_crc = struct.unpack_from("<H", inner, 10)[0]
    return DecodedFrame(
        fragment_index=fragment_index,
        stored_outer_crc=stored_outer_crc,
        calculated_outer_crc=ring_crc32(inner),
        module=inner[1],
        marker=inner[2],
        sequence=struct.unpack_from("<H", inner, 3)[0],
        status=inner[5],
        command=inner[6],
        subcommand=inner[7],
        declared_length=declared_length,
        actual_inner_length=len(inner),
        stored_inner_crc=stored_inner_crc,
        calculated_modbus_crc=crc16_modbus(inner, zero_inner_crc_slot=True),
        calculated_ccitt_crc=crc16_ccitt_false(inner, zero_inner_crc_slot=True),
        data=inner[12:min(declared_length, len(inner))],
    )


def _label(mapping: dict[int, str], value: int) -> str:
    return mapping.get(value, f"0x{value:02x}")


def format_frame(decoded: DecodedFrame) -> str:
    module_label = _label(MODULES, decoded.module)
    status_label = _label(STATUS, decoded.status)
    if decoded.module == 2:
        command_label = _label(HEALTH_COMMANDS, decoded.command)
        subcommand_label = {1: "daily", 2: "point", 3: "measure"}.get(
            decoded.subcommand, f"0x{decoded.subcommand:02x}"
        )
    elif decoded.module == 1 and decoded.command == 0:
        command_label = "system"
        subcommand_label = _label(SYSTEM_SUBCOMMANDS, decoded.subcommand)
    else:
        command_label = f"0x{decoded.command:02x}"
        subcommand_label = f"0x{decoded.subcommand:02x}"

    warnings: list[str] = []
    if not decoded.outer_crc_ok:
        warnings.append("outer CRC mismatch")
    if not decoded.length_ok:
        warnings.append("declared length mismatch")
    if not decoded.marker_ok:
        warnings.append("unexpected inner marker")
    if decoded.fragment_index != 0:
        warnings.append("not a standalone final/single fragment")
    if decoded.module == 1 and decoded.command == 0 and decoded.subcommand in BLOCKED_SYSTEM_SUBCOMMANDS:
        warnings.append("Hermes-blocklisted mutating/destructive command")

    lines = [
        f"fragment_index={decoded.fragment_index}",
        (
            f"outer_crc={'OK' if decoded.outer_crc_ok else 'BAD'} "
            f"stored=0x{decoded.stored_outer_crc:08x} "
            f"calculated=0x{decoded.calculated_outer_crc:08x}"
        ),
        (
            f"module={module_label} command={command_label} "
            f"subcommand={subcommand_label} status={status_label}"
        ),
        f"sequence={decoded.sequence}",
        (
            f"inner_length={'OK' if decoded.length_ok else 'BAD'} "
            f"declared={decoded.declared_length} actual={decoded.actual_inner_length}"
        ),
        (
            f"inner_crc={decoded.inner_crc_kind} "
            f"stored=0x{decoded.stored_inner_crc:04x} "
            f"modbus=0x{decoded.calculated_modbus_crc:04x} "
            f"ccitt_false=0x{decoded.calculated_ccitt_crc:04x}"
        ),
        f"data={decoded.data.hex()}",
    ]
    if warnings:
        lines.append("warnings=" + "; ".join(warnings))
    return "\n".join(lines)


def build_frame(
    *,
    module: int,
    command: int,
    subcommand: int,
    status: int,
    sequence: int,
    data: bytes = b"",
    inner_crc: str = "zero",
) -> bytes:
    """Build one offline single-fragment frame.

    `inner_crc=modbus` is appropriate for constructing a canonical incoming-style
    fixture. `ccitt` mirrors the legacy outbound helper. `zero` is useful for
    synthetic tests where only the transport CRC is under study.
    """
    values = {
        "module": module,
        "command": command,
        "subcommand": subcommand,
        "status": status,
    }
    for name, value in values.items():
        if not 0 <= value <= 0xFF:
            raise ValueError(f"{name} must fit in one byte")
    if not 0 <= sequence <= 0xFFFF:
        raise ValueError("sequence must fit in u16")

    inner_length = 12 + len(data)
    if inner_length > 0xFFFF:
        raise ValueError("inner frame exceeds u16 length")

    inner = bytearray(inner_length)
    inner[0] = FRAME_MARKER
    inner[1] = module
    inner[2] = FRAME_MARKER
    struct.pack_into("<H", inner, 3, sequence)
    inner[5] = status
    inner[6] = command
    inner[7] = subcommand
    struct.pack_into("<H", inner, 8, inner_length)
    inner[12:] = data

    if inner_crc == "modbus":
        checksum = crc16_modbus(bytes(inner), zero_inner_crc_slot=True)
    elif inner_crc == "ccitt":
        checksum = crc16_ccitt_false(bytes(inner), zero_inner_crc_slot=True)
    elif inner_crc == "zero":
        checksum = 0
    else:
        raise ValueError("inner_crc must be one of: zero, modbus, ccitt")
    struct.pack_into("<H", inner, 10, checksum)

    outer_crc = ring_crc32(bytes(inner))
    return bytes([0]) + struct.pack("<I", outer_crc) + bytes(inner)


def parse_hex(value: str) -> bytes:
    compact = "".join(value.split())
    if len(compact) % 2:
        raise ValueError("hex input must contain a whole number of bytes")
    try:
        return bytes.fromhex(compact)
    except ValueError as error:
        raise ValueError(f"invalid hex input: {error}") from error


PUBLIC_OUTBOUND_EXAMPLES = {
    "pairAuth": "00971953f964016401000000080d003f0101",
    "healthSettingsStatus": "00d5faceaf640164280000000e0c00912f",
    "systemSettingsStatus": "0000045a68640164290000000f0c00015d",
    "userInfo": "000e8624a96401642c0000000418001ede020000000000000000000000",
}


def self_test() -> None:
    verified = 0
    for name, value in PUBLIC_OUTBOUND_EXAMPLES.items():
        decoded = decode_frame(parse_hex(value))
        if not decoded.outer_crc_ok:
            raise AssertionError(f"{name}: outer CRC mismatch")
        verified += 1

    fixture = build_frame(
        module=2,
        command=1,
        subcommand=1,
        status=2,
        sequence=7,
        data=bytes.fromhex("000000000000000000000000"),
        inner_crc="modbus",
    )
    decoded_fixture = decode_frame(fixture)
    assert decoded_fixture.outer_crc_ok
    assert decoded_fixture.length_ok
    assert decoded_fixture.inner_crc_kind == "MODBUS"
    assert decoded_fixture.command == 1
    print(f"{verified}/{len(PUBLIC_OUTBOUND_EXAMPLES)} public outer CRC examples verified")
    print("synthetic canonical incoming-style fixture verified")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="action", required=True)

    decode = subparsers.add_parser("decode", help="decode one single-fragment hex frame")
    decode.add_argument("hex_frame")

    build = subparsers.add_parser("build", help="construct an offline frame")
    build.add_argument("--module", type=lambda value: int(value, 0), required=True)
    build.add_argument("--cmd", type=lambda value: int(value, 0), required=True)
    build.add_argument("--sub-cmd", type=lambda value: int(value, 0), required=True)
    build.add_argument("--status", type=lambda value: int(value, 0), required=True)
    build.add_argument("--sequence", type=lambda value: int(value, 0), required=True)
    build.add_argument("--data", default="", help="hex payload")
    build.add_argument(
        "--inner-crc",
        choices=("zero", "modbus", "ccitt"),
        default="zero",
        help="inner checksum style for the offline fixture",
    )

    subparsers.add_parser("self-test", help="run public/synthetic checksum tests")
    return parser


def main(argv: Iterable[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(list(argv) if argv is not None else None)
    try:
        if args.action == "decode":
            print(format_frame(decode_frame(parse_hex(args.hex_frame))))
        elif args.action == "build":
            frame = build_frame(
                module=args.module,
                command=args.cmd,
                subcommand=args.sub_cmd,
                status=args.status,
                sequence=args.sequence,
                data=parse_hex(args.data),
                inner_crc=args.inner_crc,
            )
            print(frame.hex())
        elif args.action == "self-test":
            self_test()
        else:
            parser.error("unknown action")
    except (ValueError, AssertionError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())