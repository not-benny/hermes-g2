import argparse, json, re, os, shutil
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
parser=argparse.ArgumentParser(description="Generate the address-only 8.4 port from pinned 6.10 sources")
parser.add_argument('--map',default=str(ROOT/'relocation/PORT-MAP-8.4.json'))
parser.add_argument('--source-dir',default=str(ROOT/'sources/original-6.10'))
parser.add_argument('--output-dir',default=str(ROOT/'generated/ported-8.4'))
args=parser.parse_args()

source_dir=Path(args.source_dir)
G=Path(args.output_dir)
G.mkdir(parents=True,exist_ok=True)
P=G/'patches'
P.mkdir(parents=True,exist_ok=True)
for filename in ('settings_ext.c','zlib_glue.c','gesture_fwd.c','patch_compress.py'):
    shutil.copy2(source_dir/filename,P/filename)
shutil.copy2(ROOT/'sources/patches_main.c',P/'patches_main.c')
full=json.loads(Path(args.map).read_text())
# consolidated CODE map (value->value), all even (thumb bit stripped)
code={int(k,16):int(v,16) for k,v in full['code'].items() if v}
code[0x474066]=0x4748a2
ram={0x200007b8:0x200007b8,0x20003ffc:0x200043b8,0x200706ec:0x20071080,0x20074254:0x20074e60,
     0x200744d0:0x200750f8,0x20074504:0x20075130,0x200745ac:0x200751d8,0x20074a34:0x2007568c,
     0x2034dc30:0x2034dd90,0x20000000:0x20000000}
pool={0x443750:0x443768,0x4444a4:0x4444bc,0x4a069c:0x4a1f74}
CONST={0x438000,0x7f0000,0x7fe000,0x794324,0x800000,0x20000000}

def remap(v):
    if v in ram: return ram[v]
    if v in pool: return pool[v]
    base=v & ~1
    if base in code: return code[base] | (v & 1)
    if v in code: return code[v]
    return None

# ---------- 1. C files: value-based hex-literal replacement ----------
def fix_c(path, extra=None):
    s=open(path).read(); n=0; miss=set()
    def sub(m):
        nonlocal n
        v=int(m.group(0),16)
        if v in CONST: return m.group(0)
        r=remap(v)
        if r is None:
            if 0x00400000<=v<0x00800000 or 0x20000000<=v<0x21000000: miss.add(hex(v))
            return m.group(0)
        n+=1
        w=len(m.group(0))-2  # hex digit count
        return f"0x{r:0{w}x}"
    s=re.sub(r'0x00[0-9a-fA-F]{6}|0x20[0-9a-fA-F]{6}|0x004[0-9a-fA-F]{4}|0x005[0-9a-fA-F]{5}', sub, s)
    if extra: 
        for a,b in extra: 
            if a in s: s=s.replace(a,b); n+=1
    open(path,'w').write(s)
    print(f"  {os.path.basename(path)}: {n} addr replacements; UNMAPPED code/ram literals: {sorted(miss) if miss else 'none'}")

print("C files:")
fix_c(P/'settings_ext.c', extra=[("movw r12, #0x1fd7","movw r12, #0x6a93")])
fix_c(P/'zlib_glue.c')
fix_c(P/'gesture_fwd.c')
fix_c(P/'patches_main.c')

# ---------- 2. patch_compress.py: DELTA + SITE tables (explicit) + geometry ----------
p=P/'patch_compress.py'; s=open(p).read()
reps=[
 ("DELTA = 0x37A179","DELTA = 0x37A1AD"),
 # SNAPSHOT
 ('0x4db968: "7e f7 fe fd",   # single-fragment complete','0x4e0424: "7a f7 34 fa",   # single-fragment complete'),
 ('0x4dbd5c: "7e f7 04 fc",   # multi-fragment last-fragment complete','0x4e0818: "7a f7 3a f8",   # multi-fragment last-fragment complete'),
 ('LOADBMP_BL_SITE        = (0x496a0e, "45 f0 ce fd")','LOADBMP_BL_SITE        = (0x498182, "48 f0 72 ff")'),
 ('SETTINGS_BL_SITE       = (0x49bb68, "d9 f7 d4 ff")','SETTINGS_BL_SITE       = (0x49d2dc, "d9 f7 fc fa")'),
 ('SETTINGS_DECODE_BL_SITE = (0x49b268, "f4 f7 5a ff")','SETTINGS_DECODE_BL_SITE = (0x49c9dc, "f4 f7 5a ff")'),
 ('0x45c65a: "08 f0 68 fa",','0x45c9fa: "08 f0 88 fa",'),
 ('0x45c71a: "08 f0 08 fa",','0x45caba: "08 f0 28 fa",'),
 ('GESTURE_LONGPRESS_SITE = (0x442e92, "28 f0 03 f8")','GESTURE_LONGPRESS_SITE = (0x442e92, "28 f0 0f fb")'),
 ('GESTURE_RELEASE_SITE   = (0x4431c2, "1c f0 9b fb")','GESTURE_RELEASE_SITE   = (0x4431c2, "1c f0 6b fd")'),
 ('EVENAI_ENTRY_SITE      = (0x4e1fd2, "7f b5 06 00")','EVENAI_ENTRY_SITE      = (0x4e6a8e, "7f b5 06 00")'),
 ('0x473c8e: "f8 f7 c1 fe",   # queue message type 3 -> bl FUN_0046ca14','0x474412: "f8 f7 0b fe",   # queue message type 3 -> bl (reloc 0x46d02c)'),
 ('0x473d68: "f8 f7 54 fe",   # queue message type 6 -> bl FUN_0046ca14','0x47454e: "f8 f7 6d fd",   # queue message type 6 -> bl (reloc 0x46d02c)'),
 ('0x49ec3c: "df f7 70 fb",  # ON_HEAD:  bl 0x47e320','0x4a03b0: "df f7 c2 fd",  # ON_HEAD:  bl 0x47ff38'),
 ('0x49ec9a: "df f7 41 fb",  # OFF_HEAD: bl 0x47e320','0x4a040e: "df f7 93 fd",  # OFF_HEAD: bl 0x47ff38'),
 ('COMPASS_EVENT_BL_SITE = (0x443288, "1c f0 38 fb")','COMPASS_EVENT_BL_SITE = (0x443288, "1c f0 08 fd")'),
 # geometry g2f() site addresses (orig/new bytes unchanged - load-independent)
 ('(g2f(0x4dbfc6), "bd f8 2c 10", "40 f2 41 20", "container width  <= 576")','(g2f(0x4e0a82), "bd f8 2c 10", "40 f2 41 20", "container width  <= 576")'),
 ('(g2f(0x4dc08e), "bd f8 2e 00", "40 f2 21 11", "container height movw #0x121")','(g2f(0x4e0b4a), "bd f8 2e 00", "40 f2 21 11", "container height movw #0x121")'),
 ('(g2f(0x4dc092), "91 28",       "88 42",       "container height cmp r0,r1")','(g2f(0x4e0b4e), "91 28",       "88 42",       "container height cmp r0,r1")'),
]
miss=[a for a,_ in reps if a not in s]
for a,b in reps: s=s.replace(a,b)
open(p,'w').write(s)
print(f"patch_compress.py: {len(reps)-len(miss)}/{len(reps)} replacements applied")
if miss: print("  !! NOT FOUND (need manual):"); [print("    ",repr(m)) for m in miss]
