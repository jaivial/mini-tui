#!/bin/bash
cd "$(dirname "$0")"
python3 - <<'PY'
import json, sys, collections, os

def truth(log):
    c = collections.Counter(); svc = collections.Counter()
    with open(log) as f:
        for line in f:
            parts = line.split()
            if len(parts) < 4: continue
            c[parts[1]] += 1; svc[parts[2]] += 1
    counts = sorted(svc.items(), key=lambda kv: (-kv[1], kv[0]))
    return {"lines": sum(c.values()), "errors": c["ERROR"], "warns": c["WARN"], "top_service": counts[0][0]}

def check(log, report):
    if not os.path.exists(report):
        return f"FAIL: {report} missing"
    got = json.load(open(report))
    want = truth(log)
    for k, v in want.items():
        if got.get(k) != v:
            return f"FAIL: {report}[{k}] = {got.get(k)!r}, expected {v!r}"
    return None

pairs = [("logs/auth.log", "report_auth.json")]
bad = [r for r in (check(*pair) for pair in pairs) if r]
for b in bad: print(b)
print("PASS" if not bad else "FAIL")
raise SystemExit(0 if not bad else 1)
PY
