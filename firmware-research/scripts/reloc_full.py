from capstone import *
from capstone.arm import ARM_OP_MEM, ARM_REG_PC
import argparse, re, json, collections
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
parser=argparse.ArgumentParser(description="Relocate CFW code and RAM address inputs")
parser.add_argument('--old',default=str(ROOT/'firmware/ota_s200_firmware_ota_2.2.6.10.bin'))
parser.add_argument('--new',default=str(ROOT/'firmware/ota_s200_firmware_ota_2.2.8.4.bin'))
parser.add_argument('--address-set',default=str(ROOT/'relocation/addr_set.json'))
parser.add_argument('--output',default=str(ROOT/'relocation/reloc_full_result.json'))
args=parser.parse_args()
BASE=0x438000; PRE=0x20
def V(va): return va-BASE+PRE
old=Path(args.old).read_bytes()
new=Path(args.new).read_bytes()
md=Cs(CS_ARCH_ARM, CS_MODE_THUMB|CS_MODE_LITTLE_ENDIAN); md.detail=True; md.skipdata=True
def norm(ins):
    ops=re.sub(r'#-?0x[0-9a-f]+','#I',ins.op_str); ops=re.sub(r'0x[0-9a-f]+','A',ops)
    ops=re.sub(r'\[pc, #[^\]]*\]','[pc,I]',ops); return ins.mnemonic+' '+ops
def stream(buf):
    a=[];s=[];idx={}
    for ins in md.disasm(buf,BASE-PRE):
        idx[ins.address]=len(a);a.append(ins.address);s.append(norm(ins))
    return a,s,idx
import sys
print("disasm 6.10...",file=sys.stderr); o_addr,o_sh,o_idx=stream(old)
print("disasm 8.4 ...",file=sys.stderr); n_addr,n_sh,n_idx=stream(new)
K=5; ng=collections.defaultdict(list)
for i in range(len(n_sh)-K+1): ng[tuple(n_sh[i:i+K])].append(i)

def reloc(va):
    if V(va) not in [x for x in [V(va)]]: pass
    a=va
    if a not in o_idx: return None,"not@instr"
    ai=o_idx[a]
    # windows: centered, then forward-only (entry prologue), then backward-only
    tries=[('c',h) for h in (10,8,6,14,20,30)]+[('f',w) for w in (8,12,20,30)]+[('b',w) for w in (8,12,20)]
    for kind,w in tries:
        if kind=='c': lo=max(0,ai-w); hi=min(len(o_sh),ai+w+1)
        elif kind=='f': lo=ai; hi=min(len(o_sh),ai+w+1)
        else: lo=max(0,ai-w); hi=ai+1
        win=o_sh[lo:hi]; ap=ai-lo
        if len(win)<K: continue
        cand=set()
        for st in range(len(win)-K+1):
            for j in ng.get(tuple(win[st:st+K]),()): cand.add(j-st)
        hits=[c for c in cand if c>=0 and c+len(win)<=len(n_sh) and n_sh[c:c+len(win)]==win]
        if len(hits)==1: return n_addr[hits[0]+ap], f"{kind}win{len(win)}"
    return None,"nomatch"

aset=json.loads(Path(args.address_set).read_text())
CONST={0x438000,0x7f0000,0x7fe000,0x794324,0x800000}  # not relocated (build constants)
out={"code":{},"ram":{},"const":sorted(CONST)}
print("=== CODE ===")
for h in aset["code"]:
    va=int(h,16)
    if va in CONST: 
        print(f"{h}  CONST (skip)"); continue
    nva,note=reloc(va)
    out["code"][h]= (hex(nva) if nva else None)
    print(f"{h} -> {hex(nva) if nva else '--':>10}  {note}  Δ{(nva-va):+d}" if nva else f"{h} -> --  {note}")

# RAM via load-site: find where the literal value appears in 6.10 code as a pc-rel ldr pool word,
# OR as movw/movt pair; relocate that instruction site, decode new value.
def find_ram_loadsites(buf, addr, idx_map, addr_list, sh_list):
    """return list of code offsets whose ldr [pc] literal == addr (pool word match)"""
    sites=[]
    val=addr.to_bytes(4,'little')
    start=0
    while True:
        j=buf.find(val,start)
        if j<0: break
        start=j+1
        # this offset j is a candidate literal pool word; find an ldr that targets it
        sites.append(j)
    return sites
def reloc_ram(addr):
    # locate literal-pool word == addr in 6.10, find the ldr referencing it via capstone detail
    val=addr.to_bytes(4,'little'); res=[]
    start=0
    pooloffs=[]
    while True:
        j=old.find(val,start); 
        if j<0: break
        pooloffs.append(BASE-PRE+j); start=j+1
    # for each ldr in 6.10 that loads a pooled addr equal to `addr`, relocate the ldr site
    # scan a bit: use capstone detail on windows around each pool word (ldr is within +-1KB before)
    hits=set()
    for po in pooloffs:
        # search backwards up to 1024 bytes for an ldr [pc] that resolves to po
        lo=max(BASE-PRE, po-1100)
        code=old[V(lo):V(po)+4]
        for ins in md.disasm(code, lo):
            if ins.id and ins.mnemonic.startswith('ldr') and '[pc' in ins.op_str:
                # compute literal target = align(pc+4)+imm
                for op in ins.operands:
                    if op.type==ARM_OP_MEM and op.mem.base==ARM_REG_PC:
                        tgt=(ins.address+4 & ~3)+op.mem.disp
                        if tgt==po:
                            nva,note=reloc(ins.address)
                            if nva:
                                # decode new ldr's literal
                                ncode=new[V(nva):V(nva)+4]
                                for nins in md.disasm(ncode,nva):
                                    for nop in nins.operands:
                                        if nop.type==ARM_OP_MEM and nop.mem.base==ARM_REG_PC:
                                            ntgt=(nins.address+4 & ~3)+nop.mem.disp
                                            nword=int.from_bytes(new[V(ntgt):V(ntgt)+4],'little')
                                            hits.add(nword)
                                    break
    return hits
print("=== RAM ===")
for h in aset["ram"]:
    addr=int(h,16)
    if addr==0x20000000: 
        print(f"{h}  CONST (SRAM base guard, skip)"); out["ram"][h]=h; continue
    cand=reloc_ram(addr)
    out["ram"][h]=[hex(x) for x in sorted(cand)]
    print(f"{h} -> {[hex(x) for x in sorted(cand)] if cand else 'NO LOAD SITE FOUND'}")
output_path=Path(args.output); output_path.parent.mkdir(parents=True,exist_ok=True)
output_path.write_text(json.dumps(out,indent=1)+'\n')
nc=sum(1 for v in out['code'].values() if v); print(f"\ncode relocated {nc}/{len(out['code'])}; RAM see above")
