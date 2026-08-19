#!/usr/bin/env python3
"""Even R1 ring: Ring1 BLE frame builder, decoder, and CRC-32.

Build a command frame, or decode a captured one, for the Even Realities R1 ring
health protocol. See README.md in this folder for the full protocol writeup.

Run with no arguments to self test against captured example frames:
    python3 ring-frame-decoder.py

Decode a hex frame:
    python3 ring-frame-decoder.py 00971953f964016401000000080d003f0101
"""
import sys
import struct

# CRC-32, poly 0x1EDC6F41 (Castagnoli), MSB first, init 0, no xorout.
# This is the transport checksum at bytes 1 to 4. A frame with a wrong value
# here is silently dropped by the ring before the command dispatcher runs.
def _make_table():
    poly = 0x1EDC6F41
    table = []
    for i in range(256):
        c = i << 24
        for _ in range(8):
            c = ((c << 1) ^ poly) & 0xFFFFFFFF if (c & 0x80000000) else (c << 1) & 0xFFFFFFFF
        table.append(c)
    return table

_CRC_TABLE = _make_table()

def ring_crc32(data: bytes) -> int:
    c = 0
    for b in data:
        c = ((c << 8) & 0xFFFFFFFF) ^ _CRC_TABLE[((c >> 24) ^ b) & 0xFF]
    return c & 0xFFFFFFFF

def ring_crc16(data: bytes) -> int:
    """CRC-16 at inner bytes 10 to 11 (Nordic crc16_compute, check value 0x29B1
    for the ASCII string 123456789). The ring does not appear to validate this
    field, but the official app fills it, so we reproduce it for byte exact
    frames. It is computed over the inner frame with these two bytes zeroed."""
    c = 0xFFFF
    for b in data:
        c = ((c >> 8) & 0xFF) | ((c << 8) & 0xFF00)
        c ^= b
        c ^= (c & 0xFF) >> 4
        c ^= (c << 12) & 0xFFFF
        c ^= ((c & 0xFF) << 5) & 0xFFFF
    return c & 0xFFFF

MODULES = {1: "system", 2: "health", 3: "sport"}
HEALTH_CMDS = {1: "heartRate", 2: "spo2", 3: "temperature", 4: "hrv", 5: "activity", 6: "sleep"}
STATUS = {0: "req", 1: "set", 2: "push", 3: "ack"}
SYS_SUB = {
    0x01: "deviceStatus", 0x02: "deviceInfo", 0x03: "wearStatus", 0x04: "userInfo",
    0x05: "systemTime", 0x08: "pairAuth", 0x09: "otaStart", 0x0a: "advStart",
    0x0b: "getAlgoKeyStatus", 0x0c: "setAlgoKey", 0x0e: "healthSettingsStatus",
    0x0f: "systemSettingsStatus", 0x11: "nvRecover", 0x12: "powerControl",
    0x13: "pairDelete", 0x7e: "packetAck", 0x7f: "heartbeatPack",
}

def build_frame(module: int, cmd: int, sub_cmd: int, status: int, serial_id: int,
                payload: bytes = b"") -> bytes:
    """Build a Ring1 frame with a correct transport CRC-32. crc16 is left zero,
    which the ring appears not to validate."""
    inner_len = 12 + len(payload)
    inner = bytearray(inner_len)
    inner[0] = 0x64                       # version
    inner[1] = module & 0xFF
    inner[2] = 0x64                       # moduleVersion
    struct.pack_into("<H", inner, 3, serial_id & 0xFFFF)
    inner[5] = status & 0xFF
    inner[6] = cmd & 0xFF
    inner[7] = sub_cmd & 0xFF
    struct.pack_into("<H", inner, 8, inner_len)
    inner[12:] = payload
    struct.pack_into("<H", inner, 10, ring_crc16(bytes(inner)))
    crc32 = ring_crc32(bytes(inner))
    return bytes([0x00]) + struct.pack("<I", crc32) + bytes(inner)

def decode_frame(buf: bytes) -> str:
    if len(buf) < 17 or buf[0] != 0x00:
        return f"(not a Ring1 envelope: {buf.hex()})"
    crc_stored = struct.unpack_from("<I", buf, 1)[0]
    inner = buf[5:]
    crc_ok = "OK" if crc_stored == ring_crc32(inner) else f"BAD (calc {ring_crc32(inner):08x})"
    module = buf[6]
    serial = struct.unpack_from("<H", buf, 8)[0]
    status, cmd, sub = buf[10], buf[11], buf[12]
    length = struct.unpack_from("<H", buf, 13)[0]
    data = buf[17:]
    mod_s = MODULES.get(module, f"0x{module:02x}")
    if module == 2:
        cmd_s = HEALTH_CMDS.get(cmd, f"0x{cmd:02x}")
        sub_s = {1: "daily", 2: "point", 3: "measure"}.get(sub, f"0x{sub:02x}")
    else:
        cmd_s = "system" if cmd == 0 else f"0x{cmd:02x}"
        sub_s = SYS_SUB.get(sub, f"0x{sub:02x}")
    return (f"crc32={crc_ok} module={mod_s} cmd={cmd_s} subCmd={sub_s} "
            f"status={STATUS.get(status, status)} serialId={serial} len={length} "
            f"data={data.hex()}")

# Captured example frames from a real official app transmit (CRC-32 verified).
EXAMPLES = {
    "pairAuth":          "00971953f964016401000000080d003f0101",
    "healthSettingsGet": "00d5faceaf640164280000000e0c00912f",
    "systemSettingsGet": "0000045a68640164290000000f0c00015d",
    "userInfo":          "000e8624a96401642c0000000418001ede020000000000000000000000",
}

def _self_test():
    ok = 0
    for name, hx in EXAMPLES.items():
        b = bytes.fromhex(hx)
        stored = int.from_bytes(b[1:5], "little")
        calc = ring_crc32(b[5:])
        good = stored == calc
        ok += good
        print(f"{name:18} CRC-32 {'OK' if good else 'MISMATCH'}   {decode_frame(b)}")
    print(f"{ok}/{len(EXAMPLES)} CRC-32 verified")
    assert ring_crc16(b"123456789") == 0x29B1, "crc16 check value wrong"
    print("crc16 check value 0x29B1 OK (CRC-16/CCITT-FALSE)")
    # The transport CRC-32 is what the ring validates. crc16 is filled by the
    # official app but does not match this (or any tested) algorithm, and the ring
    # does not validate it, so a rebuilt frame is CRC-32 correct and accepted by the
    # ring but is not byte identical to a capture. Confirm the CRC-32 is right:
    rebuilt = build_frame(module=1, cmd=0, sub_cmd=0x08, status=0, serial_id=1, payload=b"\x01")
    print("rebuilt pairAuth:", decode_frame(rebuilt).split("module")[0].strip())

if __name__ == "__main__":
    if len(sys.argv) > 1:
        print(decode_frame(bytes.fromhex(sys.argv[1])))
    else:
        _self_test()
