#!/bin/bash
cd "$(dirname "$0")"
printf 'The quick brown fox. The FOX jumps; the dog sleeps...\nfox fox FOX\n' > /tmp/_t7_in.txt
python3 - <<'PY'
import re, subprocess, sys
from collections import Counter
text = open("/tmp/_t7_in.txt").read()
exp = sorted(Counter(t for t in re.split(r"[^a-z0-9]+", text.lower()) if t).items(),
             key=lambda kv: (-kv[1], kv[0]))
def run(args):
    p = subprocess.run([sys.executable, "wordcount.py", *args], capture_output=True, text=True)
    if p.returncode != 0:
        print("FAIL: exit", p.returncode, p.stderr[:200]); raise SystemExit(1)
    lines = [l for l in p.stdout.strip().splitlines() if l.strip()]
    out = []
    for l in lines:
        parts = l.split()
        if len(parts) != 2 or not parts[1].isdigit():
            print("FAIL: output line is not '<word> <count>':", repr(l)); raise SystemExit(1)
        out.append((parts[0], int(parts[1])))
    return out
got = run(["--top", "3", "/tmp/_t7_in.txt"])
if got != exp[:3]:
    print("FAIL: --top 3 ->", got, "want", exp[:3]); raise SystemExit(1)
got = run(["/tmp/_t7_in.txt"])
if got != exp[:10]:
    print("FAIL: default ->", got, "want", exp[:10]); raise SystemExit(1)
got = run(["--top", "1", "/tmp/_t7_in.txt"])
if got != exp[:1]:
    print("FAIL: --top 1 ->", got); raise SystemExit(1)
print("PASS")
PY
