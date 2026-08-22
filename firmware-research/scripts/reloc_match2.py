from capstone import *
import argparse, re, json, collections
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description="Relocate the 18 CFW anchor sites from 2.2.6.10 to 2.2.8.4")
parser.add_argument("--old", default=str(ROOT / "firmware/ota_s200_firmware_ota_2.2.6.10.bin"))
parser.add_argument("--new", default=str(ROOT / "firmware/ota_s200_firmware_ota_2.2.8.4.bin"))
parser.add_argument("--output", default=str(ROOT / "relocation/reloc_result.json"))
args = parser.parse_args()

BASE=0x438000; PRE=0x20
def V(va): return va-BASE+PRE
def A(off): return off+BASE-PRE
old=Path(args.old).read_bytes()
new=Path(args.new).read_bytes()
md=Cs(CS_ARCH_ARM, CS_MODE_THUMB|CS_MODE_LITTLE_ENDIAN); md.detail=False; md.skipdata=True

def norm(ins):
    ops=ins.op_str
    ops=re.sub(r'#-?0x[0-9a-f]+','#I',ops)
    ops=re.sub(r'0x[0-9a-f]+','A',ops)
    ops=re.sub(r'\[pc, #[^\]]*\]','[pc,I]',ops)
    return ins.mnemonic+' '+ops

# resilient linear disasm over the whole buffer: addr->(shape,size); skipdata emits .byte for junk
def stream(buf):
    addrs=[]; shapes=[]; idx={}
    for ins in md.disasm(buf, BASE-PRE):
        idx[ins.address]=len(addrs)
        addrs.append(ins.address); shapes.append(norm(ins))
    return addrs, shapes, idx

print("disasm 6.10..."); o_addr,o_sh,o_idx = stream(old); print(f"  {len(o_addr):,} ins")
print("disasm 8.4 ..."); n_addr,n_sh,n_idx = stream(new); print(f"  {len(n_addr):,} ins")

# index new shapes by 5-gram for fast candidate lookup
K=5
ngram=collections.defaultdict(list)
for i in range(len(n_sh)-K+1):
    ngram[tuple(n_sh[i:i+K])].append(i)

ANCHORS=[("container width",0x4dbfc6),("container height movw",0x4dc08e),("container height cmp",0x4dc092),
 ("loadbmp bl",0x496a0e),("snapshot single",0x4db968),("snapshot multi",0x4dbd5c),
 ("settings send bl",0x49bb68),("settings decode bl",0x49b268),("display_start A",0x45c65a),
 ("display_start B",0x45c71a),("gesture longpress",0x442e92),("gesture release",0x4431c2),
 ("evenai entry",0x4e1fd2),("display_copy A",0x473c8e),("display_copy B",0x473d68),
 ("wear on_head",0x49ec3c),("wear off_head",0x49ec9a),("compass bl",0x443288)]

def reloc(va):
    off=V(va); a=A(off)
    if a not in o_idx: return None,"anchor not at instr boundary"
    ai=o_idx[a]
    # widen window until the 5-gram-seeded full-window match is unique
    for half in (12,10,8,6,5,4,3):
        lo=max(0,ai-half); hi=min(len(o_sh),ai+half+1)
        win=o_sh[lo:hi]; ap=ai-lo
        # seed candidates by any K-gram inside win
        cand=set()
        for s in range(len(win)-K+1):
            for j in ngram.get(tuple(win[s:s+K]),()):
                cand.add(j-s)   # aligned start in new
        hits=[c for c in cand if c>=0 and c+len(win)<=len(n_sh) and n_sh[c:c+len(win)]==win]
        if len(hits)==1:
            return n_addr[hits[0]+ap], f"win={len(win)}"
        if len(hits)==0 and half<=4:
            return None, "no match"
    return None, f"{len(hits)} matches (ambiguous)"

print(f"\n{'anchor':22} {'6.10 VA':>9}  {'8.4 VA':>9} {'delta':>8}  note")
res={}
for name,va in ANCHORS:
    nva,note=reloc(va)
    if nva:
        res[name]={"old":va,"new":nva,"delta":nva-va}
        print(f"{name:22} {va:#09x}  {nva:#09x} {nva-va:>+8}  {note}")
    else:
        print(f"{name:22} {va:#09x}  {'--':>9} {'':>8}  {note}")
output_path = Path(args.output)
output_path.parent.mkdir(parents=True, exist_ok=True)
output_path.write_text(json.dumps(res, indent=1) + "\n")
print(f"\nrelocated {len(res)}/{len(ANCHORS)} -> {output_path}")
# delta histogram (functions moving together = sanity)
from collections import Counter
print("delta distribution:", dict(Counter(v['delta'] for v in res.values())))

# --- disambiguate the ambiguous anchors with wider windows + regional-delta tiebreak ---
print("\n=== disambiguation pass ===")
def reloc_wide(va, expect_delta=None):
    off=V(va); a=A(off); ai=o_idx[a]
    best=None
    for half in (20,28,40,60):
        lo=max(0,ai-half); hi=min(len(o_sh),ai+half+1)
        win=o_sh[lo:hi]; ap=ai-lo
        cand=set()
        for s in range(len(win)-K+1):
            for j in ngram.get(tuple(win[s:s+K]),()):
                cand.add(j-s)
        hits=[c for c in cand if c>=0 and c+len(win)<=len(n_sh) and n_sh[c:c+len(win)]==win]
        addrs=[n_addr[h+ap] for h in hits]
        if len(addrs)==1:
            return addrs[0], f"win={len(win)} unique"
        if expect_delta is not None and addrs:
            # pick closest to expected
            tgt=va+expect_delta
            addrs.sort(key=lambda x:abs(x-tgt))
            if len(addrs)>=1 and (len(addrs)==1 or abs(addrs[0]-tgt)<abs(addrs[1]-tgt)):
                best=(addrs[0], f"win={len(win)} nearest-Δ({addrs[0]-va:+d})")
    return best if best else (None,"still ambiguous")

# settings send bl: neighbor 'settings decode bl' had Δ+6004 (same function)
nva,note=reloc_wide(0x49bb68, expect_delta=6004)
print(f"settings send bl     0x49bb68  ->  {nva:#09x} {note}" if nva else f"settings send bl: {note}")
if nva: res["settings send bl"]={"old":0x49bb68,"new":nva,"delta":nva-0x49bb68}
# compass bl: neighbor 'gesture release' (same target FUN_0045f8fc, nearby) had Δ+0
nva2,note2=reloc_wide(0x443288, expect_delta=0)
print(f"compass bl           0x443288  ->  {nva2:#09x} {note2}" if nva2 else f"compass bl: {note2}")
if nva2: res["compass bl"]={"old":0x443288,"new":nva2,"delta":nva2-0x443288}

output_path.write_text(json.dumps(res, indent=1) + "\n")
print(f"\nTOTAL relocated {len(res)}/18")
if len(res) != len(ANCHORS):
    raise SystemExit("anchor relocation incomplete")
