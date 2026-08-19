from capstone import *
from capstone.arm import ARM_OP_MEM, ARM_REG_PC
import argparse, re, json, collections, sys
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
parser=argparse.ArgumentParser(description="Relocate special CFW pool/function inputs")
parser.add_argument('--old',default=str(ROOT/'firmware/ota_s200_firmware_ota_2.2.6.10.bin'))
parser.add_argument('--new',default=str(ROOT/'firmware/ota_s200_firmware_ota_2.2.8.4.bin'))
parser.add_argument('--output',default=str(ROOT/'relocation/reloc_strag_result.json'))
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
    tries=[('c',h) for h in (10,8,6,14,20,30)]+[('f',w) for w in (8,12,20)]+[('b',w) for w in (8,12)]
    for kind,w in tries:
        if kind=='c': lo=max(0,ai-w);hi=min(len(o_sh),ai+w+1)
        elif kind=='f': lo=ai;hi=min(len(o_sh),ai+w+1)
        else: lo=max(0,ai-w);hi=ai+1
        win=o_sh[lo:hi];ap=ai-lo
        if len(win)<K: continue
        cand=set()
        for st in range(len(win)-K+1):
            for j in ng.get(tuple(win[st:st+K]),()): cand.add(j-st)
        hits=[c for c in cand if c>=0 and c+len(win)<=len(n_sh) and n_sh[c:c+len(win)]==win]
        addrs=[n_addr[h+ap] for h in hits]
        if len(addrs)==1: return addrs[0]
        if exp and addrs:
            addrs.sort(key=lambda x:abs(x-exp))
            if len(addrs)==1 or abs(addrs[0]-exp)<abs(addrs[1]-exp): return addrs[0]
    return None

# --- pool-word relocation: find ldr[pc] in 6.10 whose literal target == P; relocate ldr; decode new target ---
def reloc_pool(P):
    outs=set()
    # scan code for ldr [pc] targeting P: search a window; but simplest—brute find ldr sites near P (pool is after the ldr, within ~1KB)
    lo=max(BASE-PRE, P-1200)
    for ins in md.disasm(old[V(lo):V(P)+4], lo):
        if ins.mnemonic.startswith('ldr') and '[pc' in ins.op_str:
            for op in ins.operands:
                if op.type==ARM_OP_MEM and op.mem.base==ARM_REG_PC:
                    tgt=(ins.address+4 & ~3)+op.mem.disp
                    if tgt==P:
                        nva=reloc(ins.address)
                        if nva:
                            for nins in md.disasm(new[V(nva):V(nva)+4], nva):
                                for nop in nins.operands:
                                    if nop.type==ARM_OP_MEM and nop.mem.base==ARM_REG_PC:
                                        nt=(nins.address+4 & ~3)+nop.mem.disp
                                        nword=int.from_bytes(new[V(nt):V(nt)+4],'little')
                                        outs.add((nt,nword))
                                break
    return outs

res={}
# 0x474066 = FUN display-queue entry (function): expected between +1560 and +3524
r=reloc(0x474066, exp=0x474066+2500)
res['0x474066 (FUN display-queue)']=hex(r) if r else None
# pool words -> (new pool addr, value held)
for P,label,oldval in [(0x443750,'pool->fg ui ctx',0x200744d0),
                        (0x4444a4,'pool->EVT_SRC',0x2034dc30),
                        (0x4a069c,'pool->ble_msgrx base',None)]:
    got=reloc_pool(P)
    res[f'{hex(P)} {label}']=[(hex(a),hex(v)) for a,v in sorted(got)]
print(json.dumps(res, indent=1))
# derive relocated 0x2034dc30 (EVT_SRC) from the 0x4444a4 pool value
for k,v in res.items():
    if '0x4444a4' in k and v:
        print("\n-> relocated EVT_SRC (0x2034dc30) =", v[0][1] if v else "?")
output_path=Path(args.output); output_path.parent.mkdir(parents=True,exist_ok=True)
output_path.write_text(json.dumps(res,indent=1)+'\n')
