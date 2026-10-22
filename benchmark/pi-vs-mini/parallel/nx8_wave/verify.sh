#!/bin/bash
# Eight parts, one objective check each, each run inside its own directory.
cd "$(dirname "$0")"
bad=0
check() { # $1 label, $2 part dir, rest: command
  local label=$1 part=$2; shift 2
  if ! (cd "$part" && "$@") >/tmp/nx8-out.txt 2>&1; then
    echo "FAIL: $label"; tail -3 /tmp/nx8-out.txt; bad=1
  fi
}
check "part1 tokenizer"  part1_tokenizer node test_tokenizer.js
check "part2 tinydb"     part2_tinydb python3 test_tinydb.py
check "part3 router"     part3_router node test_router.js
check "part4 expr"       part4_expr python3 test_parser.py
check "part5 insights"   part5_insights python3 verify_part5.py
check "part6 logtool"    part6_logtool python3 test_logtool.py
check "part7 scheduler"  part7_scheduler python3 test_scheduler.py
check "part8 behavior"   part8_refactor node test_messy.js
if ! python3 - <<'PY'
import os, re, sys
doc = "part8_refactor/REFACTOR.md"
if not os.path.exists(doc):
    print("FAIL: part8 REFACTOR.md missing"); sys.exit(1)
text = open(doc).read().lower()
missing = [m for m in ("clamp", "scale", "offset", "normalize", "min", "dead") if m not in text]
src = open("part8_refactor/messy.js").read()
exported = re.findall(r"export function (\w+)", src)
renamed = all(n in exported for n in ("scale", "offset", "normalize"))
if missing:
    print(f"FAIL: part8 REFACTOR.md missing markers {missing}"); sys.exit(1)
if not renamed:
    print(f"FAIL: part8 messy.js does not export scale/offset/normalize (has {exported})"); sys.exit(1)
sys.exit(0)
PY
then bad=1; fi
if [ $bad -eq 0 ]; then echo "PASS"; else echo "FAIL"; exit 1; fi
