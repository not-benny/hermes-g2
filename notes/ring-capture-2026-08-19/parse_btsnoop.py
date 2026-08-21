#!/usr/bin/env python3
"""Parse a btsnoop_hci.log, reassemble ATT traffic on the Even R1 ring's LE link,
and decode ring command frames per the verified wire format (ring-health-handover.md).

Usage: parse_btsnoop.py btsnoop_hci.log [RING_MAC]
Default RING_MAC = DC:BE:DA:94:20:B8

Prints a timeline of ring TX (host->ring, ATT Write) and RX (ring->host, Notify/Indicate/Read-rsp),
decoding the 0x00-typed 17+ byte command envelope and verifying its CRC-32.
"""
import sys, struct

RING_MAC = (sys.argv[2] if len(sys.argv) > 2 else "DC:BE:DA:94:20:B8").upper()

# ---- CRC-32 (poly 0x1EDC6F41, MSB-first, init 0, no xorout) — from the handover ----
def _mk_table():
    poly = 0x1EDC6F41
    tbl = []
    for i in range(256):
        c = i << 24
        for _ in range(8):
            c = ((c << 1) ^ poly) & 0xFFFFFFFF if (c & 0x80000000) else (c << 1) & 0xFFFFFFFF
        tbl.append(c)
    return tbl
_CRC_T = _mk_table()
def ring_crc32(data: bytes) -> int:
    c = 0
    for b in data:
        c = ((c << 8) & 0xFFFFFFFF) ^ _CRC_T[((c >> 24) ^ b) & 0xFF]
    return c & 0xFFFFFFFF

MODULES = {1: "system", 2: "health", 3: "sport"}
CMDS = {0: "system", 1: "heartRate", 2: "spo2", 3: "temperature", 4: "hrv",
        5: "activity", 6: "sleep", 7: "sportRunCtrl", 8: "sportRunData", 0x7f: "healthSetting"}
STATUS = {0: "req", 1: "set", 2: "push", 3: "ack"}
SYS_SUB = {0x01: "deviceStatus", 0x02: "deviceInfo", 0x03: "wearStatus", 0x04: "userInfo",
           0x05: "systemTime", 0x08: "pairAuth", 0x09: "otaStart", 0x0a: "advStart",
           0x0b: "getAlgoKeyStatus", 0x0c: "setAlgoKey", 0x0e: "healthSettingsStatus",
           0x0f: "systemSettingsStatus", 0x10: "deviceSn", 0x11: "nvRecover",
           0x12: "powerControl", 0x13: "pairDelete", 0x7e: "packetAck", 0x7f: "heartbeatPack"}

def decode_ring_frame(buf: bytes) -> str:
    if len(buf) < 17 or buf[0] != 0x00:
        return f"(non-envelope {buf.hex()})"
    crc_stored = struct.unpack_from("<I", buf, 1)[0]
    inner = buf[5:]
    crc_calc = ring_crc32(inner)
    crc_ok = "OK" if crc_stored == crc_calc else f"BAD(calc={crc_calc:08x})"
    ver, module, modver = buf[5], buf[6], buf[7]
    serial = struct.unpack_from("<H", buf, 8)[0]
    status, cmd, sub = buf[10], buf[11], buf[12]
    length = struct.unpack_from("<H", buf, 13)[0]
    data = buf[17:]
    mod_s = MODULES.get(module, f"0x{module:02x}")
    cmd_s = CMDS.get(cmd, f"0x{cmd:02x}")
    sub_s = SYS_SUB.get(sub, f"0x{sub:02x}") if module == 1 else f"0x{sub:02x}"
    return (f"crc32={crc_ok} mod={mod_s} cmd={cmd_s} sub={sub_s} "
            f"status={STATUS.get(status,status)} serial={serial} len={length} data={data.hex()}")

# ---- btsnoop reader ----
def read_btsnoop(path):
    with open(path, "rb") as f:
        blob = f.read()
    assert blob[:8] == b"btsnoop\x00", "not a btsnoop file"
    ver, dtype = struct.unpack_from(">II", blob, 8)
    off = 16
    recs = []
    while off + 24 <= len(blob):
        olen, ilen, flags, drops, ts = struct.unpack_from(">IIIIq", blob, off)
        off += 24
        pkt = blob[off:off + ilen]
        off += ilen
        recs.append((flags, ts, pkt))
    return recs

# HCI packet types from H4 (btsnoop for BR/EDR+LE stores HCI H4 with type byte in flags/direction)
# In btsnoop hci format, each record payload is an HCI packet WITHOUT the H4 type prefix;
# packet type is derived from flags bit0 (direction) + bit1 (command/data). We handle ACL + events.
# flags: bit0 = direction (0=sent/host->ctrl, 1=received/ctrl->host); bit1 = 0 data / 1 cmd/evt

handle_to_mac = {}   # conn handle -> bd_addr string
acl_reasm = {}       # handle -> (remaining_len, bytes) for L2CAP reassembly

def mac_str(b6):
    return ":".join(f"{x:02X}" for x in b6[::-1])

def handle_att(direction, handle, att):
    if not att:
        return
    op = att[0]
    mac = handle_to_mac.get(handle, f"h{handle}")
    if mac.upper() != RING_MAC and not mac.startswith("h"):
        return  # not the ring
    # only surface ring (or unknown-handle) traffic
    if handle_to_mac and mac.upper() != RING_MAC:
        return
    dir_s = "TX host->ring" if direction == 0 else "RX ring->host"
    if op in (0x12, 0x52):      # Write Request / Write Command
        h = struct.unpack_from("<H", att, 1)[0]
        val = att[3:]
        print(f"[{dir_s}] ATT Write handle=0x{h:04x} :: {decode_ring_frame(val)}")
    elif op in (0x1b, 0x1d):    # Handle Value Notification / Indication
        h = struct.unpack_from("<H", att, 1)[0]
        val = att[3:]
        print(f"[{dir_s}] ATT Notify handle=0x{h:04x} :: {decode_ring_frame(val)}")
    elif op == 0x0b:            # Read Response
        print(f"[{dir_s}] ATT ReadRsp :: {decode_ring_frame(att[1:])}")

def process(recs):
    for flags, ts, pkt in recs:
        direction = flags & 0x1          # 0 sent, 1 received
        is_cmd_evt = flags & 0x2
        if is_cmd_evt:
            # HCI event or command
            if direction == 1 and len(pkt) >= 2 and pkt[0] == 0x3e:
                # LE Meta event
                sub = pkt[2]
                if sub in (0x01, 0x0a):  # LE Connection Complete / enhanced
                    # status, handle(2), role, peer_addr_type, peer_addr(6)...
                    status = pkt[3]
                    handle = struct.unpack_from("<H", pkt, 4)[0]
                    if sub == 0x01:
                        addr = pkt[9:15]
                    else:
                        addr = pkt[9:15]
                    if status == 0:
                        handle_to_mac[handle] = mac_str(addr)
                        print(f"# LE conn handle=0x{handle:04x} -> {mac_str(addr)}")
            continue
        # ACL data
        if len(pkt) < 4:
            continue
        hf = struct.unpack_from("<H", pkt, 0)[0]
        handle = hf & 0x0FFF
        pb = (hf >> 12) & 0x3
        dlen = struct.unpack_from("<H", pkt, 2)[0]
        payload = pkt[4:4 + dlen]
        if pb == 0x2 or pb == 0x0:  # first fragment (start of L2CAP)
            if len(payload) < 4:
                acl_reasm[handle] = (0, payload); continue
            l2len, cid = struct.unpack_from("<HH", payload, 0)
            body = payload[4:]
            if len(body) < l2len:
                acl_reasm[handle] = (l2len - len(body), cid, body)
                continue
            full = body[:l2len]; cid_final = cid
        else:  # continuation
            if handle not in acl_reasm:
                continue
            rem = acl_reasm[handle]
            if len(rem) == 3:
                need, cid, sofar = rem
                sofar = sofar + payload
                if len(sofar) < (len(sofar) + need - len(payload)):
                    pass
                # recompute
                total_need = need - len(payload)
                if total_need > 0:
                    acl_reasm[handle] = (total_need, cid, sofar)
                    continue
                full = sofar; cid_final = cid
                del acl_reasm[handle]
            else:
                continue
        # ATT is CID 0x0004
        if cid_final == 0x0004:
            handle_att(direction, handle, full)

if __name__ == "__main__":
    recs = read_btsnoop(sys.argv[1])
    print(f"# {len(recs)} btsnoop records; filtering ring {RING_MAC}")
    process(recs)
