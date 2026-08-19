from capstone import *
from capstone.arm import ARM_OP_MEM, ARM_REG_PC
import argparse, re, collections, sys, json
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
parser=argparse.ArgumentParser(description="Relocate remaining special CFW inputs")
parser.add_argument('--old',default=str(ROOT/'firmware/ota_s200_firmware_ota_2.2.6.10.bin'))
parser.add_argument('--new',default=str(ROOT/'firmware/ota_s200_firmware_ota_2.2.8.4.bin'))
parser.add_argument('--output',default=str(ROOT/'relocation/reloc_strag2_result.json'))
args=parser.parse_args()
BASE=0x438000; PRE=0x20
def V(va): return va-BASE+PRE
old=Path(args.old).read_bytes(); new=Path(args.new).read_bytes()
md=Cs(CS_ARCH_ARM, CS_MODE_THUMB|CS_MODE_LITTLE_ENDIAN); md.detail=True; md.skipdata=True
def norm(ins):
    ops=re.sub(r'#-?0x[0-9a-f]+','#I',ins.op_str); ops=re.sub(r'0x[0-9a-f]+','A',ops)
    ops=re.sub(r'\[pc, #[^\]]*\]','[pc,I]',ops); return ins.mnemonic+' '+ops
def stream(buf):
    a=[];s=[];idx={}
    for ins in md.disasm(buf,BASE-PRE):
        idx[ins.address]=len(a);a.append(ins.address);s.append(norm(ins))
    return a,s,idx
print("disasm...",file=sys.stderr); o_addr,o_sh,o_idx=stream(old); n_addr,n_sh,n_idx=stream(new)
K=5; ng=collections.defaultdict(list)
for i in range(len(n_sh)-K+1): ng[tuple(n_sh[i:i+K])].append(i)
def reloc(va, exp=None):
    if va not in o_idx: return None
    ai=o_idx[va]
    for kind,w in [('c',10),('c',8),('c',6),('c',14),('c',20),('c',30),('c',45),('f',8),('f',14),('f',24),('b',8),('b',14)]:
        if kind=='c': lo=max(0,ai-w);hi=min(len(o_sh),ai+w+1)
        elif kind=='f': lo=ai;hi=min(len(o_sh),ai+w+1)
        else: lo=max(0,ai-w);hi=ai+1
        win=o_sh[lo:hi];ap=ai-lo
        if len(win)<K: continue
        cand=set()
        for st in range(len(win)-K+1):
            for j in ng.get(tuple(win[st:st+K]),()): cand.add(j-st)
        hits=[n_addr[c+ap] for c in cand if c>=0 and c+len(win)<=len(n_sh) and n_sh[c:c+len(win)]==win]
        if len(set(hits))==1: return hits[0]
        if exp and hits:
            hits=sorted(set(hits),key=lambda x:abs(x-exp))
            if len(hits)==1 or abs(hits[0]-exp)<abs(hits[1]-exp)-4: return hits[0]
    return None
res={}
# 1) 0x474066 function, expected ~+1924 (neighbor 0x47386a)
r=reloc(0x474066, exp=0x474066+1924); res['0x474066']=hex(r) if r else None
# 2) 0x443750 pool holds 0x200744d0 -> reloc value 0x200750f8; find that word near expected
def find_pool_by_value(P, newval, span=0x400):
    tb=newval.to_bytes(4,'little'); hits=[]
    for delta in range(-span,span,4):
        off=V(P+delta)
        if 0<=off<=len(new)-4 and new[off:off+4]==tb: hits.append(P+delta)
    return hits
h=find_pool_by_value(0x443750, 0x200750f8); res['0x443750 (holds RAM ptr)']=[hex(x) for x in h]
# 3) 0x4444a4 pool holds 0x2034dc30 (unknown reloc). Relocate the referencing fn FUN_00442d86, then read.
#    Simpler: the pool is loaded by an ldr; widen scan to 3500 bytes back.
def reloc_pool_wide(P, back=3600):
    lo=max(BASE-PRE,P-back); outs=set()
    for ins in md.disasm(old[V(lo):V(P)+4], lo):
        if ins.mnemonic.startswith('ldr') and '[pc' in ins.op_str:
            for op in ins.operands:
                if op.type==ARM_OP_MEM and op.mem.base==ARM_REG_PC:
                    if (ins.address+4 & ~3)+op.mem.disp==P:
                        nva=reloc(ins.address)
                        if nva:
                            for nins in md.disasm(new[V(nva):V(nva)+4],nva):
                                for nop in nins.operands:
                                    if nop.type==ARM_OP_MEM and nop.mem.base==ARM_REG_PC:
                                        nt=(nins.address+4 & ~3)+nop.mem.disp
                                        outs.add((nt,int.from_bytes(new[V(nt):V(nt)+4],'little')))
                                break
    return outs
h2=reloc_pool_wide(0x4444a4); res['0x4444a4 (holds EVT_SRC 0x2034dc30)']=[(hex(a),hex(v)) for a,v in sorted(h2)]
print(json.dumps(res,indent=1))
output_path=Path(args.output); output_path.parent.mkdir(parents=True,exist_ok=True)
output_path.write_text(json.dumps(res,indent=1)+'\n')
