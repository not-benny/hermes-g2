from capstone import *
import argparse, json
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
parser=argparse.ArgumentParser(description="Verify relocated anchors preserve shared branch targets")
parser.add_argument('--old',default=str(ROOT/'firmware/ota_s200_firmware_ota_2.2.6.10.bin'))
parser.add_argument('--new',default=str(ROOT/'firmware/ota_s200_firmware_ota_2.2.8.4.bin'))
parser.add_argument('--result',default=str(ROOT/'relocation/reloc_result.json'))
args=parser.parse_args()
BASE=0x438000; PRE=0x20
def V(va): return va-BASE+PRE
old=Path(args.old).read_bytes()
new=Path(args.new).read_bytes()
md=Cs(CS_ARCH_ARM, CS_MODE_THUMB|CS_MODE_LITTLE_ENDIAN); md.detail=False
res=json.loads(Path(args.result).read_text())

def bl_target(buf, va):
    code=buf[V(va):V(va)+4]
    for ins in md.disasm(code, va):
        if ins.mnemonic in ('bl','blx','b','b.w','bne','beq','cbz','cbnz') or ins.mnemonic.startswith('b'):
            t=ins.op_str
            return ins.mnemonic, t
        return ins.mnemonic, ins.op_str
    return None,None

# bl sites that SHARE a target in 6.10 (from patch_compress comments):
groups={
 "snapshot (->0x45a568)":["snapshot single","snapshot multi"],
 "display_copy (->0x46ca14)":["display_copy A","display_copy B"],
 "wear (->0x47e320)":["wear on_head","wear off_head"],
 "ring/compass (->0x45f8fc)":["gesture release","compass bl"],
}
print(f"{'anchor':22} {'old bl':28} {'new bl':28}")
newt={}
for name,d in res.items():
    om,ot=bl_target(old,d['old']); nm,nt=bl_target(new,d['new'])
    newt[name]=(nm,nt)
    print(f"{name:22} {om+' '+str(ot):28} {nm+' '+str(nt):28}")

print("\n=== shared-target consistency (the correctness proof) ===")
allok=True
for g,members in groups.items():
    tgts=[newt[m][1] for m in members if m in newt]
    same = len(tgts)==len(members) and len(set(tgts))==1
    allok &= same
    print(f"{'OK ' if same else 'XX '} {g:28} -> new targets {tgts} {'(consistent)' if same else '(MISMATCH)'}")
print(f"\n{'ALL shared-target groups consistent' if allok else 'SOME MISMATCH - re-check'}")
if not allok:
    raise SystemExit(1)
