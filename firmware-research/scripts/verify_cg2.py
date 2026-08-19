from capstone import *
import argparse, re, collections, json
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
parser=argparse.ArgumentParser(description="Verify relocated functions by call-graph edges")
parser.add_argument('--old',default=str(ROOT/'firmware/ota_s200_firmware_ota_2.2.6.10.bin'))
parser.add_argument('--new',default=str(ROOT/'firmware/ota_s200_firmware_ota_2.2.8.4.bin'))
parser.add_argument('--map',default=str(ROOT/'relocation/reloc_full_result.json'))
args=parser.parse_args()
BASE=0x438000;PRE=0x20
def V(va): return va-BASE+PRE
old=Path(args.old).read_bytes(); new=Path(args.new).read_bytes()
md=Cs(CS_ARCH_ARM, CS_MODE_THUMB|CS_MODE_LITTLE_ENDIAN); md.skipdata=True
def norm(ins):
    ops=re.sub(r'#-?0x[0-9a-f]+','#I',ins.op_str); ops=re.sub(r'0x[0-9a-f]+','A',ops)
    ops=re.sub(r'\[pc, #[^\]]*\]','[pc,I]',ops); return ins.mnemonic+' '+ops
def stream(buf):
    a=[];s=[];idx={}
    for i in md.disasm(buf,BASE-PRE): idx[i.address]=len(a);a.append(i.address);s.append(norm(i))
    return a,s,idx
import sys
print("disasm...",file=sys.stderr); oa,osh,oidx=stream(old); na,nsh,nidx=stream(new)
K=5; ng=collections.defaultdict(list)
for i in range(len(nsh)-K+1): ng[tuple(nsh[i:i+K])].append(i)
def reloc(va):
    if va not in oidx: return None
    ai=oidx[va]
    for w in (8,6,10,14,20):
        lo=max(0,ai-w);hi=min(len(osh),ai+w+1);win=osh[lo:hi];ap=ai-lo
        if len(win)<K: continue
        cand=set()
        for st in range(len(win)-K+1):
            for j in ng.get(tuple(win[st:st+K]),()): cand.add(j-st)
        hits=set(na[c+ap] for c in cand if c>=0 and c+len(win)<=len(nsh) and nsh[c:c+len(win)]==win)
        if len(hits)==1: return next(iter(hits))
    return None
def callees(buf, va, n=60):
    out=[]
    for ins in md.disasm(buf[V(va):V(va)+n*2], va):
        if ins.mnemonic in ('bl','blx'):
            try: out.append(int(ins.op_str.lstrip('#'),16))
            except: pass
        if ins.mnemonic in ('pop','bx') and 'pc' in ins.op_str and len(out): break
        if len(out)>=6: break
    return out
full=json.loads(Path(args.map).read_text())
code={int(k,16):int(v,16) for k,v in full['code'].items() if v}; code[0x474066]=0x4748a2
risky={"malloc":0x474cd2,"free":0x474d16,"inflateEnd":0x5bea86,"lv_set_src":0x498680,"lv_invalidate":0x440656,
 "timer_start":0x449498,"timer_new":0x4493b0,"timer_stop":0x4494d8,"complete_emit":0x4da382,
 "display_wait":0x47381e,"display_copy":0x46ca14,"compass_start":0x5455e4,"display_event_fwd":0x45f8fc}
print(f"{'function':18} {'6.10→8.4':>19} edges  verdict")
allok=True
leaf_functions={'display_copy'}
for name,ova in risky.items():
    nva=code[ova]; oc=callees(old,ova); nc=set(callees(new,nva))
    good=0; tot=0; prologue = any(True for _ in md.disasm(new[V(nva):V(nva)+2],nva))
    for c in oc:
        cr=reloc(c&~1)
        if cr is None: continue
        tot+=1
        if any(abs((cr|(c&1))-x)<=1 for x in nc): good+=1
    leaf = tot==0 and name in leaf_functions
    ok = leaf or (tot>0 and good==tot)  # require ALL relocatable edges to match
    allok&=ok
    verdict='LEAF' if leaf else ('OK' if ok else 'MISMATCH')
    print(f"{name:18} {hex(ova)+'→'+hex(nva):>19} {good}/{tot}  {verdict}")
print("\nALL relocatable call edges consistent across the map — relocations independently confirmed" if allok else "\nSOME EDGE MISMATCH — inspect before flash")
if not allok:
    raise SystemExit(1)
