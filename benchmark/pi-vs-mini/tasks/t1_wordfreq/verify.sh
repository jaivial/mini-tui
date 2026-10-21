#!/bin/bash
# Expected top-5 by word frequency in logs/app.log (INFO excluded? no: all lines count).
# Computed independently with awk from the original corpus.
cd "$(dirname "$0")"
f=logs/app.log
[ -f answer.json ] || { echo "FAIL: answer.json missing"; exit 1; }
python3 - <<'PY'
import json, re, collections
expected = collections.Counter()
with open("logs/app.log") as fh:
    for line in fh:
        parts = line.split()
        # tokens: ts date time LEVEL worker-<n> word id=.. value=..
        expected[parts[4]] += 1
top = expected.most_common(5)
ans = json.load(open("answer.json"))
got = ans["top_words"] if isinstance(ans, dict) and "top_words" in ans else ans
if not isinstance(got, list) or len(got) != 5:
    print("FAIL: top_words must be a list of 5 [word,count] pairs"); raise SystemExit(1)
norm = [(str(w).strip().lower(), int(c)) for w, c in got]
exp = [(w, c) for w, c in top]
if norm != exp:
    print("FAIL:", norm, "!=", exp); raise SystemExit(1)
print("PASS")
PY
